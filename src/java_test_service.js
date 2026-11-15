#!/usr/bin/env node

/**
 * Java Test Execution Service
 *
 * Accepts Java source and test files over HTTP, scaffolds an ephemeral
 * Maven/Gradle project, compiles, runs tests (JUnit 5/4, TestNG),
 * collects JaCoCo coverage, and runs static analysis (Checkstyle, PMD,
 * SpotBugs). Called by coding-testing to provide Java test execution
 * without requiring a JDK on the orchestrator.
 */

const {
    createLogger,
    setupExpress,
    tenantGuard,
    installGracefulShutdown,
} = require('./common');
const { spawn, exec } = require('child_process');
const { rateLimit } = require('express-rate-limit');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Configuration
const PORT = process.env.PORT || 8088;
const EXECUTION_TIMEOUT = parseInt(process.env.EXECUTION_TIMEOUT || '300') * 1000; // 5 minutes for Java builds
const TEST_WORKSPACE = process.env.TEST_WORKSPACE || '/app/test_workspace';
const REPORTS_DIR = process.env.REPORTS_DIR || '/app/reports';

// ── Rate limiting ───────────────────────────────────────────────────────────
// /execute scaffolds, writes, compiles, tests and deletes a Maven/Gradle
// project on disk; /validate writes a source file and runs javac. Each
// request is seconds to minutes of CPU and
// scratch-disk churn, and CodeQL js/missing-rate-limiting raised both routes.
// This is an in-process counter keyed on the caller's address: the
// orchestrator is the only caller (tenantGuard), so there is one meaningful
// bucket, and an external attacker cannot bypass it by rotating addresses.
// Defaults: 60 requests per 60 s, overridable with RATE_LIMIT_MAX /
// RATE_LIMIT_WINDOW_MS. Invalid overrides fall back to the default rather than
// disabling the limit.
function positiveIntFromEnv(name, fallback) {
    const parsed = Number.parseInt(process.env[name], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const RATE_LIMIT_MAX = positiveIntFromEnv('RATE_LIMIT_MAX', 60);
const RATE_LIMIT_WINDOW_MS = positiveIntFromEnv('RATE_LIMIT_WINDOW_MS', 60 * 1000);

const expensiveRouteLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX,
    standardHeaders: true, // RateLimit-Limit / -Remaining / -Reset on responses
    legacyHeaders: false,
    message: { error: 'Too many requests', detail: 'This executor is rate-limited.' },
});

// Create a queue for serializing Maven/Gradle operations
const { promisify } = require('util');
const execQueue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || execQueue.length === 0) return;
    
    isProcessing = true;
    const { command, options, resolve, reject } = execQueue.shift();
    
    try {
        const result = await executeCommandInternal(command, options);
        resolve(result);
    } catch (error) {
        // This should never happen since executeCommandInternal never rejects
        log.error('Unexpected error in processQueue', { error: error.message, command });
        resolve({
            success: false,
            error: error.message,
            stdout: '',
            stderr: '',
            exitCode: 1
        });
    } finally {
        isProcessing = false;
        processQueue(); // Process next in queue
    }
}

// Initialize Express app with shared setup + orchestrator-only tenant guard
const app = setupExpress({ jsonLimit: '50mb' });
app.use(tenantGuard());

// Logging utility
const log = createLogger();

// Supported testing frameworks
const SUPPORTED_FRAMEWORKS = {
    'junit5': {
        name: 'JUnit 5',
        dependencies: ['org.junit.jupiter:junit-jupiter'],
        testPatterns: ['**/*Test.java', '**/*Tests.java'],
        mvnGoal: 'test',
        gradleTask: 'test'
    },
    'testng': {
        name: 'TestNG',
        dependencies: ['org.testng:testng'],
        testPatterns: ['**/*Test.java', '**/*TestNG.java'],
        mvnGoal: 'test',
        gradleTask: 'test'
    },
    'junit4': {
        name: 'JUnit 4',
        dependencies: ['junit:junit'],
        testPatterns: ['**/*Test.java'],
        mvnGoal: 'test',
        gradleTask: 'test'
    }
};

// Build system configurations
const BUILD_SYSTEMS = {
    'maven': {
        configFile: 'pom.xml',
        testCommand: 'mvn test',
        // test-compile (not plain compile) so a test source that fails to
        // compile is caught at the gate instead of producing an empty,
        // falsely-green test run.
        compileCommand: 'mvn test-compile',
        cleanCommand: 'mvn clean',
        coverageCommand: 'mvn jacoco:report',
        staticAnalysisCommands: {
            checkstyle: 'mvn checkstyle:check',
            pmd: 'mvn pmd:check',
            spotbugs: 'mvn spotbugs:check'
        }
    },
    'gradle': {
        configFile: 'build.gradle',
        testCommand: './gradlew test',
        // testClasses compiles test sources too (compileJava is main-only).
        compileCommand: './gradlew testClasses',
        cleanCommand: './gradlew clean',
        coverageCommand: './gradlew jacocoTestReport',
        staticAnalysisCommands: {
            checkstyle: './gradlew checkstyleMain',
            pmd: './gradlew pmdMain',
            spotbugs: './gradlew spotbugsMain'
        }
    }
};

/**
 * Internal function to execute shell commands with timeout
 */
function executeCommandInternal(command, options = {}) {
    return new Promise((resolve) => {
        const timeout = options.timeout || EXECUTION_TIMEOUT;
        const cwd = options.cwd || TEST_WORKSPACE;
        let isResolved = false;
        
        log.debug(`Executing command: ${command}`, { cwd, timeout });
        
        // Ensure JAVA_HOME is set correctly for ARM64/AMD64
        const env = { ...process.env };
        if (!env.JAVA_HOME || !require('fs').existsSync(env.JAVA_HOME)) {
            // Auto-detect correct JAVA_HOME
            const fs = require('fs');
            const possiblePaths = [
                '/usr/lib/jvm/java-17-openjdk-arm64',
                '/usr/lib/jvm/java-17-openjdk-amd64',
                '/usr/lib/jvm/java-11-openjdk-arm64',
                '/usr/lib/jvm/java-11-openjdk-amd64'
            ];
            for (const path of possiblePaths) {
                if (fs.existsSync(path)) {
                    env.JAVA_HOME = path;
                    env.PATH = `${path}/bin:${env.PATH}`;
                    break;
                }
            }
        }
        
        const child = exec(command, { 
            cwd, 
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            // Don't use built-in timeout to avoid conflicts
            env
        }, (error, stdout, stderr) => {
            if (isResolved) return;
            isResolved = true;
            
            if (error) {
                // Check if this is a timeout error
                const isTimeout = error.signal === 'SIGTERM' || error.message.includes('timeout');
                
                log.error(`Command failed: ${command}`, { error: error.message, stderr, isTimeout });
                
                resolve({
                    success: false,
                    error: isTimeout ? 'Test execution timeout' : error.message,
                    stdout,
                    stderr,
                    exitCode: error.code || 1,
                    timeout: isTimeout
                });
            } else {
                log.debug(`Command completed: ${command}`);
                resolve({
                    success: true,
                    stdout,
                    stderr,
                    exitCode: 0
                });
            }
        });
        
        // Custom timeout handler
        const timeoutId = setTimeout(() => {
            if (!isResolved && !child.killed) {
                isResolved = true;
                child.kill('SIGTERM');
                resolve({
                    success: false,
                    error: 'Test execution timeout',
                    stdout: '',
                    stderr: 'Command timed out',
                    exitCode: 124,
                    timeout: true
                });
            }
        }, timeout);
        
        // Clear timeout if process completes normally
        child.on('exit', () => {
            clearTimeout(timeoutId);
        });
    });
}

const { MAVEN_POM_TEMPLATE } = require('./pom-template');

/**
 * Wrapper function that queues Maven/Gradle commands to prevent conflicts
 */
function executeCommand(command, options = {}) {
    // Check if this is a Maven or Gradle command that needs serialization
    const needsQueue = command.includes('mvn') || command.includes('gradle') || command.includes('javac');
    
    if (!needsQueue) {
        // Execute directly for non-build commands
        return executeCommandInternal(command, options);
    }
    
    // Queue build commands
    return new Promise((resolve, reject) => {
        execQueue.push({ command, options, resolve, reject });
        processQueue();
    });
}

/**
 * Detect build system in project
 */
async function detectBuildSystem(projectPath) {
    try {
        const files = await fs.readdir(projectPath);
        
        if (files.includes('pom.xml')) {
            return 'maven';
        } else if (files.includes('build.gradle') || files.includes('build.gradle.kts')) {
            return 'gradle';
        }
        
        return null;
    } catch (error) {
        log.error('Error detecting build system', { error: error.message, projectPath });
        return null;
    }
}

/**
 * Detect testing framework in project
 */
async function detectTestingFramework(projectPath, buildSystem) {
    try {
        if (buildSystem === 'maven') {
            const pomPath = path.join(projectPath, 'pom.xml');
            const pomContent = await fs.readFile(pomPath, 'utf8');
            
            if (pomContent.includes('junit-jupiter')) {
                return 'junit5';
            } else if (pomContent.includes('testng')) {
                return 'testng';
            } else if (pomContent.includes('junit')) {
                return 'junit4';
            }
        } else if (buildSystem === 'gradle') {
            const buildPath = path.join(projectPath, 'build.gradle');
            const buildContent = await fs.readFile(buildPath, 'utf8');
            
            if (buildContent.includes('junit-jupiter')) {
                return 'junit5';
            } else if (buildContent.includes('testng')) {
                return 'testng';
            } else if (buildContent.includes('junit')) {
                return 'junit4';
            }
        }
        
        return 'junit5'; // Default to JUnit 5
    } catch (error) {
        log.warn('Error detecting testing framework, defaulting to JUnit 5', { error: error.message });
        return 'junit5';
    }
}

/**
 * Parse test results from XML files
 */
async function parseTestResults(projectPath, buildSystem) {
    const results = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        testFiles: [],
        failureDetails: [],
        // Whether a report directory was readable at all.
        //
        // `total === 0` has TWO causes here -- surefire/gradle ran and
        // collected nothing, or we never managed to read a report -- and the
        // catch below flattens both into the same all-zero object. Both are
        // legitimately "no tests were executed" for the verdict, but they are
        // not the same fact, so the distinction is carried rather than
        // silently defaulted. A caller debugging an unexpected not-run can
        // tell a MEASURED zero from an UNMEASURED one.
        //
        // Note this is NOT a precondition for no_tests_run: maven's canonical
        // zero-collection case is precisely `reportsFound === false` with a
        // clean exit, because surefire does not create target/surefire-reports
        // when there are no test classes to run.
        reportsFound: false
    };

    try {
        let testResultsPath;
        if (buildSystem === 'maven') {
            testResultsPath = path.join(projectPath, 'target', 'surefire-reports');
        } else {
            testResultsPath = path.join(projectPath, 'build', 'test-results', 'test');
        }
        
        const files = await fs.readdir(testResultsPath);
        results.reportsFound = true;
        const xmlFiles = files.filter(f => f.endsWith('.xml'));
        
        for (const xmlFile of xmlFiles) {
            const xmlContent = await fs.readFile(path.join(testResultsPath, xmlFile), 'utf8');
            
            // Simple XML parsing for test results
            const testsMatch = xmlContent.match(/tests="(\d+)"/);
            const failuresMatch = xmlContent.match(/failures="(\d+)"/);
            const errorsMatch = xmlContent.match(/errors="(\d+)"/);
            const skippedMatch = xmlContent.match(/skipped="(\d+)"/);
            
            if (testsMatch) {
                const tests = parseInt(testsMatch[1]);
                const failures = parseInt(failuresMatch ? failuresMatch[1] : '0');
                const errors = parseInt(errorsMatch ? errorsMatch[1] : '0');
                const skipped = parseInt(skippedMatch ? skippedMatch[1] : '0');
                
                results.total += tests;
                results.failed += failures + errors;
                results.skipped += skipped;
                results.passed += tests - failures - errors - skipped;
                
                results.testFiles.push({
                    file: xmlFile,
                    tests,
                    failures,
                    errors,
                    skipped
                });
            }
        }
    } catch (error) {
        log.warn('Error parsing test results', { error: error.message });
    }
    
    return results;
}

/**
 * Parse coverage results
 */
async function parseCoverageResults(projectPath, buildSystem) {
    try {
        let coveragePath;
        if (buildSystem === 'maven') {
            coveragePath = path.join(projectPath, 'target', 'site', 'jacoco', 'jacoco.xml');
        } else {
            coveragePath = path.join(projectPath, 'build', 'reports', 'jacoco', 'test', 'jacocoTestReport.xml');
        }
        
        const coverageContent = await fs.readFile(coveragePath, 'utf8');
        
        // Simple XML parsing for coverage
        const instructionMatch = coverageContent.match(/<counter type="INSTRUCTION"[^>]*covered="(\d+)"[^>]*missed="(\d+)"/);
        const branchMatch = coverageContent.match(/<counter type="BRANCH"[^>]*covered="(\d+)"[^>]*missed="(\d+)"/);
        const lineMatch = coverageContent.match(/<counter type="LINE"[^>]*covered="(\d+)"[^>]*missed="(\d+)"/);
        
        const coverage = {};
        
        if (instructionMatch) {
            const covered = parseInt(instructionMatch[1]);
            const missed = parseInt(instructionMatch[2]);
            coverage.instruction = {
                covered,
                missed,
                total: covered + missed,
                percentage: ((covered / (covered + missed)) * 100).toFixed(2)
            };
        }
        
        if (branchMatch) {
            const covered = parseInt(branchMatch[1]);
            const missed = parseInt(branchMatch[2]);
            coverage.branch = {
                covered,
                missed,
                total: covered + missed,
                percentage: ((covered / (covered + missed)) * 100).toFixed(2)
            };
        }
        
        if (lineMatch) {
            const covered = parseInt(lineMatch[1]);
            const missed = parseInt(lineMatch[2]);
            coverage.line = {
                covered,
                missed,
                total: covered + missed,
                percentage: ((covered / (covered + missed)) * 100).toFixed(2)
            };
        }
        
        return coverage;
    } catch (error) {
        log.warn('Error parsing coverage results', { error: error.message });
        return {};
    }
}

// API Routes

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'java-test-executor',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        capabilities: {
            frameworks: Object.keys(SUPPORTED_FRAMEWORKS),
            buildSystems: Object.keys(BUILD_SYSTEMS),
            features: [
                'test_execution',
                'code_coverage',
                'static_analysis',
                'build_compilation',
                'dependency_management'
            ]
        }
    });
});

/**
 * A legal Java identifier. Used to reject a caller-supplied `className` before it
 * reaches path.join() — an unguarded one is a path-traversal write.
 */
const JAVA_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Remove block comments with a single left-to-right scan.
 *
 * The regex it replaces, /\/\*[\s\S]*?\*\//g, was flagged as
 * js/polynomial-redos: on an unterminated '/*' followed by many 'a/*'
 * repetitions the lazy group retries the closing star-slash from every
 * position of the suffix, and the global flag then restarts that scan at every
 * later '/*'. Each candidate start is skipped with indexOf and a match consumes
 * its bytes, so the whole input is walked once. An unterminated '/*' is left
 * untouched, exactly as the old regex left it.
 */
function stripBlockComments(code) {
    let output = '';
    let index = 0;
    for (;;) {
        const start = code.indexOf('/*', index);
        if (start === -1) {
            return output + code.slice(index);
        }
        output += code.slice(index, start);
        const end = code.indexOf('*/', start + 2);
        if (end === -1) {
            return output + code.slice(start);
        }
        output += ' ';
        index = end + 2;
    }
}

/**
 * Remove line comments with a single left-to-right scan.
 *
 * Equivalent to the old global line-comment replace: everything from '//' up
 * to (not including) the next newline is removed, so a trailing carriage
 * return is part of the comment. Kept as a scanner for the same reason as
 * stripBlockComments — no repeated re-scanning of the suffix.
 */
function stripLineComments(code) {
    let output = '';
    let index = 0;
    for (;;) {
        const start = code.indexOf('//', index);
        if (start === -1) {
            return output + code.slice(index);
        }
        output += code.slice(index, start) + ' ';
        const newline = code.indexOf('\n', start + 2);
        if (newline === -1) {
            return output;
        }
        index = newline; // keep the newline itself
    }
}

/**
 * Pull the package and the declared type name out of a Java source string.
 *
 * `code` is materialised as a file on disk, and javac requires a public type to live in
 * <TypeName>.java. Guessing the name is therefore not cosmetic: a wrong name is a
 * compile error, so an undeclared type is rejected rather than defaulted.
 *
 * Returns { packageName, className } or null when no type declaration is present.
 */
function parseJavaSource(code) {
    const withoutComments = stripLineComments(stripBlockComments(code));

    const typeMatch = withoutComments.match(
        /\b(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
    );
    if (!typeMatch) {
        return null;
    }

    const packageMatch = withoutComments.match(
        /\bpackage\s+([A-Za-z_$][A-Za-z0-9_$.]*)\s*;/
    );

    return {
        packageName: packageMatch ? packageMatch[1] : '',
        className: typeMatch[1]
    };
}

/**
 * Reject a non-string where a string is required.
 *
 * Every one of these fields used to reach `.trim()` / `path.join()` / `fs.writeFile()`
 * untyped: an object `code` produced `code.trim is not a function` — an HTTP 500 with a
 * JS stack instead of a validation error naming the field.
 */
function nonStringFieldError(fields) {
    for (const [name, value] of Object.entries(fields)) {
        if (value === undefined || value === null) {
            continue;
        }
        if (typeof value !== 'string') {
            return `${name} must be a string, received ${Array.isArray(value) ? 'array' : typeof value}`;
        }
    }
    return null;
}

/**
 * Reject a file map that is not { "path": "source" } with string values.
 */
function fileMapError(name, value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        return `${name} must be an object mapping file paths to source strings`;
    }
    for (const [filePath, content] of Object.entries(value)) {
        if (typeof content !== 'string') {
            return `${name}["${filePath}"] must be a string, received ${typeof content}`;
        }
        if (typeof filePath !== 'string' || filePath.includes('..') || path.isAbsolute(filePath)) {
            return `${name} contains an unsafe file path: "${filePath}"`;
        }
    }
    return null;
}

/**
 * Resolve `relativePath` beneath `root` and refuse anything that escapes it.
 *
 * js/path-injection flagged the `${className}.java` write on /validate: the
 * JAVA_IDENTIFIER check above it constrains the value, but a validation regex
 * is not a path operation and the query does not treat it as one. The pattern
 * the query models is normalise-then-compare: resolve both sides and require
 * the result to be the root itself or to sit under `root + path.sep` — the
 * separator boundary is what stops a sibling `/app/test_workspace_evil` from
 * passing a bare prefix test. Every caller-influenced path that reaches fs is
 * funnelled through here, and the RESOLVED path is the one used for the file
 * operation, so a normalised-and-checked string is what reaches fs.
 *
 * Returns the normalised path, or null when it escapes the root.
 */
function resolveWithinRoot(root, relativePath) {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relativePath);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        return null;
    }
    return resolved;
}

/**
 * Execute Java tests
 */
app.post('/execute', expensiveRouteLimiter, async (req, res) => {
    const executionId = crypto.randomUUID();
    const startTime = Date.now();
    
    try {
        // Validate request body
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({
                executionId,
                success: false,
                error: 'Request body is required',
                duration: Date.now() - startTime
            });
        }
        
        const {
            code,
            framework = 'junit5',
            buildSystem = 'maven',
            dependencies = [],
            testFiles = {},
            mainFiles = {},
            buildConfig = {},
            options = {}
        } = req.body;
        
        // Type-check before anything calls .trim() / path.join() / fs.writeFile() on these.
        const typeError =
            nonStringFieldError({ code, framework, buildSystem }) ||
            fileMapError('testFiles', testFiles) ||
            fileMapError('mainFiles', mainFiles);

        if (typeError) {
            return res.status(400).json({
                executionId,
                success: false,
                error: typeError,
                duration: Date.now() - startTime
            });
        }

        // Fast-path for the literal '// test' sentinel used by endpoint-existence probes.
        //
        // This deliberately does NOT match "a small payload declaring `public class Test`".
        // That clause used to be here guarded by `!testFiles`, which is dead — `testFiles`
        // defaults to `{}` and `{}` is truthy, so it never fired. Repairing the guard would
        // have ACTIVATED it, and a real caller sending a short `public class Test` would get
        // success:true / tests:0 for a suite that never ran. Deleted instead.
        const isMinimalTest = typeof code === 'string' && code.trim() === '// test';
        
        if (isMinimalTest) {
            return res.json({
                executionId,
                success: true,
                tests: 0,
                passed: 0,
                failed: 0,
                output: 'Fast-path response for minimal test',
                duration: Date.now() - startTime,
                compilation: {
                    success: true,
                    output: 'Skipped for minimal test',
                    errors: ''
                }
            });
        }
        
        // Validate required fields
        if (!code && Object.keys(testFiles).length === 0 && Object.keys(mainFiles).length === 0) {
            return res.status(400).json({
                executionId,
                success: false,
                error: 'At least one of code, testFiles, or mainFiles is required',
                duration: Date.now() - startTime
            });
        }

        // `code` is accepted above, so it has to reach the disk. Only mainFiles/testFiles
        // were ever written, which meant a code-only request scaffolded an EMPTY project
        // and came back "0 tests" — a passing-looking answer to a suite that never existed.
        // Resolve its filename now so an undeclared type fails as a 400, not as javac noise.
        const hasExplicitFiles =
            Object.keys(testFiles).length > 0 || Object.keys(mainFiles).length > 0;

        let codeSource = null;
        if (code) {
            const parsed = parseJavaSource(code);

            if (parsed) {
                codeSource = {
                    relativePath: path.join(
                        ...parsed.packageName.split('.').filter(Boolean),
                        `${parsed.className}.java`
                    ),
                    content: code
                };
            } else if (!hasExplicitFiles) {
                // `code` is the ONLY source and cannot be placed on disk. Running anyway is
                // exactly how the empty-project "0 tests" answer used to be produced.
                return res.status(400).json({
                    executionId,
                    success: false,
                    error: 'code must declare a class, interface, enum or record — ' +
                           'Java requires a named type to compile. Use testFiles/mainFiles ' +
                           'to control file placement explicitly.',
                    duration: Date.now() - startTime
                });
            } else {
                // Mixed payload: the explicit files are the real sources, so the run is
                // legitimate. Say out loud that `code` was dropped rather than let the
                // caller believe it was compiled.
                log.warn(`code declares no type and was not materialised: ${executionId}`, {
                    testFileCount: Object.keys(testFiles).length,
                    mainFileCount: Object.keys(mainFiles).length
                });
            }
        }

        log.info(`Starting Java test execution: ${executionId}`, {
            framework,
            buildSystem,
            testFileCount: Object.keys(testFiles).length,
            mainFileCount: Object.keys(mainFiles).length
        });
        
        // Create unique project directory
        const projectPath = path.join(TEST_WORKSPACE, executionId);
        await fs.mkdir(projectPath, { recursive: true });
        
        // Create basic project structure
        await fs.mkdir(path.join(projectPath, 'src', 'main', 'java'), { recursive: true });
        await fs.mkdir(path.join(projectPath, 'src', 'test', 'java'), { recursive: true });
        
        // Write main source files. Each caller-supplied key is resolved under
        // the project's source root and refused if it escapes it; the resolved
        // path is what fs sees (see resolveWithinRoot).
        const mainSourceRoot = path.join(projectPath, 'src', 'main', 'java');
        for (const [filePath, content] of Object.entries(mainFiles)) {
            const fullPath = resolveWithinRoot(mainSourceRoot, filePath);
            if (!fullPath) {
                return res.status(400).json({
                    executionId,
                    success: false,
                    error: `mainFiles contains an unsafe file path: "${filePath}"`,
                    duration: Date.now() - startTime
                });
            }
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content);
        }

        // Write `code` as a test source. Written BEFORE testFiles so that an explicit
        // testFiles entry at the same path stays authoritative.
        const testSourceRoot = path.join(projectPath, 'src', 'test', 'java');
        if (codeSource) {
            const fullPath = resolveWithinRoot(testSourceRoot, codeSource.relativePath);
            if (!fullPath) {
                return res.status(400).json({
                    executionId,
                    success: false,
                    error: 'code declares a package or type name that is not a safe file path',
                    duration: Date.now() - startTime
                });
            }
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, codeSource.content);
        }

        // Write test files
        for (const [filePath, content] of Object.entries(testFiles)) {
            const fullPath = resolveWithinRoot(testSourceRoot, filePath);
            if (!fullPath) {
                return res.status(400).json({
                    executionId,
                    success: false,
                    error: `testFiles contains an unsafe file path: "${filePath}"`,
                    duration: Date.now() - startTime
                });
            }
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content);
        }
        
        // Create build configuration
        if (buildSystem === 'maven') {
            const pomTemplate = MAVEN_POM_TEMPLATE;
            await fs.writeFile(path.join(projectPath, 'pom.xml'), pomTemplate);
        } else if (buildSystem === 'gradle') {
            const gradleTemplate = `plugins {
    id 'java'
    id 'jacoco'
}

group = 'com.example'
version = '1.0.0'

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

repositories {
    mavenCentral()
}

dependencies {
    testImplementation 'org.junit.jupiter:junit-jupiter:5.8.2'
}

test {
    useJUnitPlatform()
}

jacoco {
    toolVersion = "0.8.7"
}

jacocoTestReport {
    reports {
        xml.enabled true
        html.enabled true
    }
}`;
            await fs.writeFile(path.join(projectPath, 'build.gradle'), gradleTemplate);
            
            // Create gradle wrapper
            try {
                await executeCommand('gradle wrapper', { cwd: projectPath, timeout: 60000 });
            } catch (wrapperError) {
                log.warn(`Failed to create gradle wrapper: ${executionId}`, { error: wrapperError.message });
            }
        }
        
        const results = {
            executionId,
            framework,
            buildSystem,
            startTime: new Date(startTime).toISOString(),
            compilation: null,
            tests: null,
            coverage: null,
            staticAnalysis: null,
            duration: 0,
            success: false,
            // Snake_case deliberately: this is the `/execute` contract spelling
            // the orchestrator reads (see python/javascript/go). Initialized
            // false so every early return below -- a compile failure, a 4xx --
            // reports a FAILURE rather than a not-run. Those are different
            // outcomes and must not collapse into one.
            no_tests_run: false
        };
        
        // Step 1: Compile the project
        log.info(`Compiling Java project: ${executionId}`);
        const systemConfig = BUILD_SYSTEMS[buildSystem];
        const compileResult = await executeCommand(systemConfig.compileCommand, { cwd: projectPath });
        
        results.compilation = {
            success: compileResult.success,
            output: compileResult.stdout,
            errors: compileResult.stderr
        };
        
        if (!compileResult.success) {
            results.duration = Date.now() - startTime;
            return res.json(results);
        }
        
        // Step 2: Run tests
        log.info(`Running tests: ${executionId}`);
        const testResult = await executeCommand(systemConfig.testCommand, { cwd: projectPath });
        
        // Parse test results (tests might fail but we still want results)
        const testResults = await parseTestResults(projectPath, buildSystem);
        
        results.tests = {
            ...testResults,
            output: testResult.stdout,
            errors: testResult.stderr,
            executionSuccess: testResult.success
        };
        
        // Step 3: Generate coverage report
        if (options.generateCoverage !== false) {
            log.info(`Generating coverage report: ${executionId}`);
            try {
                await executeCommand(systemConfig.coverageCommand, { cwd: projectPath });
                results.coverage = await parseCoverageResults(projectPath, buildSystem);
            } catch (coverageError) {
                log.warn(`Coverage generation failed: ${executionId}`, { error: coverageError.message });
                results.coverage = { error: 'Coverage generation failed' };
            }
        }
        
        // Step 4: Run static analysis
        if (options.runStaticAnalysis !== false) {
            log.info(`Running static analysis: ${executionId}`);
            results.staticAnalysis = {};
            
            for (const [tool, command] of Object.entries(systemConfig.staticAnalysisCommands)) {
                try {
                    const analysisResult = await executeCommand(command, { cwd: projectPath });
                    results.staticAnalysis[tool] = {
                        success: analysisResult.success,
                        output: analysisResult.stdout,
                        errors: analysisResult.stderr
                    };
                } catch (analysisError) {
                    results.staticAnalysis[tool] = {
                        success: false,
                        error: analysisError.message
                    };
                }
            }
        }
        
        results.duration = Date.now() - startTime;
        // A green verdict requires: compilation OK, the test command itself
        // exited 0 (executionSuccess), zero parsed failures, AND at least one
        // test actually ran. Without executionSuccess+total a crashed run, a
        // test-compile failure, or an unparsed report (all → failed===0) was
        // silently reported as success.
        results.success =
            results.compilation.success &&
            results.tests.executionSuccess === true &&
            results.tests.total > 0 &&
            results.tests.failed === 0;

        // Report zero-collection as its own outcome, not merely as "not a pass".
        //
        // JUnit/Maven signals this nothing like pytest does. There is no exit
        // 5: `mvn test` on a project with no test classes logs "No tests to
        // run." and EXITS 0, and surefire does not even create
        // target/surefire-reports. So the signal is the parsed report count,
        // not an exit code -- which is why `reportsFound` is deliberately NOT
        // a precondition below: its absence IS maven's canonical
        // zero-collection case, and requiring it would make the most common
        // zero the one we refuse to report.
        //
        // The two preconditions that ARE here are what stop this from lying.
        // `total === 0` on its own is also what a crashed maven, an offline
        // dependency-resolution error, and a test-compile failure look like,
        // and those are FAILURES. Requiring that the run actually happened
        // (compiled, and maven itself exited 0) is what makes a remaining zero
        // mean "collected nothing" rather than "never got far enough to
        // collect". Derived from the same terms as the verdict above so the
        // two cannot disagree.
        results.no_tests_run =
            results.compilation.success &&
            results.tests.executionSuccess === true &&
            results.tests.total === 0;

        log.info(`Java test execution completed: ${executionId}`, {
            duration: results.duration,
            success: results.success,
            tests: results.tests?.total || 0,
            passed: results.tests?.passed || 0,
            failed: results.tests?.failed || 0
        });
        
        res.json(results);
        
        // Clean up project directory after a delay
        setTimeout(async () => {
            try {
                await fs.rm(projectPath, { recursive: true, force: true });
                log.debug(`Cleaned up project directory: ${projectPath}`);
            } catch (cleanupError) {
                log.warn(`Failed to clean up project directory: ${projectPath}`, { error: cleanupError.message });
            }
        }, 60000); // Clean up after 1 minute
        
    } catch (error) {
        log.error(`Java test execution error: ${executionId}`, { error: error.message });
        res.status(500).json({
            executionId,
            success: false,
            error: error.message,
            duration: Date.now() - startTime
        });
    }
});

/**
 * Get framework information
 */
app.get('/frameworks', (req, res) => {
    res.json({
        supported: SUPPORTED_FRAMEWORKS,
        buildSystems: BUILD_SYSTEMS,
        capabilities: {
            testExecution: true,
            codeCoverage: true,
            staticAnalysis: true,
            multipleFrameworks: true,
            buildSystemSupport: ['maven', 'gradle']
        }
    });
});

/**
 * Validate Java code syntax
 */
app.post('/validate', expensiveRouteLimiter, async (req, res) => {
    const validationId = crypto.randomUUID();
    
    try {
        const { code, className = 'TestClass' } = req.body || {};
        
        // Validate input
        if (code === undefined || code === null) {
            return res.status(400).json({
                validationId,
                valid: false,
                errors: ['No code provided'],
                output: ''
            });
        }
        
        // `code` reaches fs.writeFile and `className` reaches path.join + a shell command,
        // so both are typed and shaped before use. Untyped, an object `code` returned a
        // 500 with `code.trim is not a function`; an unconstrained `className` was a
        // path-traversal write and a command-injection argument.
        if (typeof code !== 'string') {
            return res.status(400).json({
                validationId,
                valid: false,
                errors: [`code must be a string, received ${Array.isArray(code) ? 'array' : typeof code}`],
                output: ''
            });
        }

        if (!JAVA_IDENTIFIER.test(className)) {
            return res.status(400).json({
                validationId,
                valid: false,
                errors: ['className must be a valid Java identifier'],
                output: ''
            });
        }

        // Empty code is not valid Java
        if (code.trim() === '') {
            return res.json({
                validationId,
                valid: false,
                errors: ['Empty code is not valid Java'],
                output: ''
            });
        }
        
        // Create temporary file for validation
        const tempPath = path.join(TEST_WORKSPACE, validationId);
        await fs.mkdir(tempPath, { recursive: true });

        // `className` is validated as a Java identifier above, but a validation
        // regex is not a path operation and CodeQL js/path-injection does not
        // follow it. Resolve the file against the workspace root and require
        // the normalised path to sit under `root + path.sep` (the component
        // boundary stops a sibling directory sharing the root's prefix) before
        // it reaches fs; the normalised path is what gets written.
        //
        // The join must happen INSIDE the resolve with the caller value as the
        // last argument: the query's RelativePathStartsWithSanitizer only
        // accepts a `startsWith` guard when the tainted suffix is the final
        // argument of a `path.join` handed to `path.resolve`. Passing
        // `validationId` as a separate resolve argument (the first attempt at
        // this fix) leaves the alert open even though the guard is correct.
        const workspaceRoot = path.resolve(TEST_WORKSPACE);
        const javaFile = path.resolve(path.join(workspaceRoot, validationId, `${className}.java`));
        if (!javaFile.startsWith(workspaceRoot + path.sep)) {
            await fs.rm(tempPath, { recursive: true, force: true });
            return res.status(400).json({
                validationId,
                valid: false,
                errors: ['className must resolve inside the validation workspace'],
                output: ''
            });
        }
        await fs.writeFile(javaFile, code);
        
        // Try to compile the file
        const compileResult = await executeCommand(`javac ${className}.java`, { cwd: tempPath });
        
        // Clean up
        await fs.rm(tempPath, { recursive: true, force: true });
        
        res.json({
            validationId,
            valid: compileResult.success,
            errors: compileResult.success ? [] : [compileResult.stderr || 'Compilation failed'],
            output: compileResult.stdout || ''
        });
        
    } catch (error) {
        log.error(`Java validation error: ${validationId}`, { error: error.message });
        res.status(500).json({
            validationId,
            valid: false,
            error: error.message
        });
    }
});

/**
 * Start the server and register signal handlers.
 * Extracted for testability.
 */
function startServer() {
    app.listen(PORT, () => {
        log.info(`Java Test Execution Service started on port ${PORT}`, {
            frameworks: Object.keys(SUPPORTED_FRAMEWORKS),
            buildSystems: Object.keys(BUILD_SYSTEMS),
            workspace: TEST_WORKSPACE,
            reportsDir: REPORTS_DIR
        });
    });

    // Graceful shutdown
    installGracefulShutdown({ log });
}

// Start server only when run directly
if (require.main === module) {
    startServer();
}

module.exports = {
    app,
    executeCommand,
    MAVEN_POM_TEMPLATE,
    executeCommandInternal,
    processQueue,
    parseTestResults,
    parseCoverageResults,
    detectBuildSystem,
    detectTestingFramework,
    parseJavaSource,
    stripBlockComments,
    stripLineComments,
    resolveWithinRoot,
    nonStringFieldError,
    fileMapError,
    startServer,
    SUPPORTED_FRAMEWORKS,
    BUILD_SYSTEMS,
    execQueue,
    get isProcessing() { return isProcessing; },
    set isProcessing(val) { isProcessing = val; }
};
