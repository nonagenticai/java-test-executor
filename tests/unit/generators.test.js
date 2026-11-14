/**
 * Tests for build configuration generation.
 *
 * The source code generates POM and Gradle build files inline in the /execute handler
 * rather than through separate functions. We test the generated content by posting
 * to /execute and reading the files created on disk.
 */

const { exec } = require('child_process');
const fsPromises = require('fs').promises;
const path = require('path');

jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn(),
        spawn: jest.fn(),
    };
});

const request = require('supertest');
const { app, SUPPORTED_FRAMEWORKS, BUILD_SYSTEMS } = require('../../src/java_test_service');

describe('Build configuration constants', () => {
    describe('SUPPORTED_FRAMEWORKS', () => {
        test('junit5 has correct dependencies', () => {
            expect(SUPPORTED_FRAMEWORKS.junit5).toBeDefined();
            expect(SUPPORTED_FRAMEWORKS.junit5.name).toBe('JUnit 5');
            expect(SUPPORTED_FRAMEWORKS.junit5.dependencies).toContain('org.junit.jupiter:junit-jupiter');
            expect(SUPPORTED_FRAMEWORKS.junit5.mvnGoal).toBe('test');
            expect(SUPPORTED_FRAMEWORKS.junit5.gradleTask).toBe('test');
        });

        test('testng has correct dependencies', () => {
            expect(SUPPORTED_FRAMEWORKS.testng).toBeDefined();
            expect(SUPPORTED_FRAMEWORKS.testng.name).toBe('TestNG');
            expect(SUPPORTED_FRAMEWORKS.testng.dependencies).toContain('org.testng:testng');
        });

        test('junit4 has correct dependencies', () => {
            expect(SUPPORTED_FRAMEWORKS.junit4).toBeDefined();
            expect(SUPPORTED_FRAMEWORKS.junit4.name).toBe('JUnit 4');
            expect(SUPPORTED_FRAMEWORKS.junit4.dependencies).toContain('junit:junit');
        });

        test('all frameworks have testPatterns', () => {
            for (const [, fw] of Object.entries(SUPPORTED_FRAMEWORKS)) {
                expect(fw.testPatterns).toBeDefined();
                expect(fw.testPatterns.length).toBeGreaterThan(0);
                expect(fw.testPatterns[0]).toContain('*Test.java');
            }
        });
    });

    describe('BUILD_SYSTEMS', () => {
        test('maven config has correct commands', () => {
            expect(BUILD_SYSTEMS.maven).toBeDefined();
            expect(BUILD_SYSTEMS.maven.configFile).toBe('pom.xml');
            expect(BUILD_SYSTEMS.maven.testCommand).toBe('mvn test');
            expect(BUILD_SYSTEMS.maven.compileCommand).toBe('mvn test-compile');
            expect(BUILD_SYSTEMS.maven.cleanCommand).toBe('mvn clean');
            expect(BUILD_SYSTEMS.maven.coverageCommand).toBe('mvn jacoco:report');
        });

        test('maven has static analysis commands for checkstyle, pmd, spotbugs', () => {
            const sa = BUILD_SYSTEMS.maven.staticAnalysisCommands;
            expect(sa.checkstyle).toBe('mvn checkstyle:check');
            expect(sa.pmd).toBe('mvn pmd:check');
            expect(sa.spotbugs).toBe('mvn spotbugs:check');
        });

        test('gradle config has correct commands', () => {
            expect(BUILD_SYSTEMS.gradle).toBeDefined();
            expect(BUILD_SYSTEMS.gradle.configFile).toBe('build.gradle');
            expect(BUILD_SYSTEMS.gradle.testCommand).toBe('./gradlew test');
            expect(BUILD_SYSTEMS.gradle.compileCommand).toBe('./gradlew testClasses');
            expect(BUILD_SYSTEMS.gradle.cleanCommand).toBe('./gradlew clean');
            expect(BUILD_SYSTEMS.gradle.coverageCommand).toBe('./gradlew jacocoTestReport');
        });

        test('gradle has static analysis commands for checkstyle, pmd, spotbugs', () => {
            const sa = BUILD_SYSTEMS.gradle.staticAnalysisCommands;
            expect(sa.checkstyle).toBe('./gradlew checkstyleMain');
            expect(sa.pmd).toBe('./gradlew pmdMain');
            expect(sa.spotbugs).toBe('./gradlew spotbugsMain');
        });
    });
});

describe('Generated build files via /execute', () => {
    beforeEach(() => {
        exec.mockReset();
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, 'OK', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });
    });

    test('Maven POM includes junit-jupiter, surefire, and jacoco', async () => {
        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calc {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'Calc.java': 'public class Calc {}' },
                testFiles: { 'CalcTest.java': 'public class CalcTest {}' },
            });

        expect(res.status).toBe(200);

        // Read the generated pom.xml from the workspace
        const executionId = res.body.executionId;
        const workspace = process.env.TEST_WORKSPACE;
        const pomPath = path.join(workspace, executionId, 'pom.xml');

        const pomContent = await fsPromises.readFile(pomPath, 'utf8');
        expect(pomContent).toContain('junit-jupiter');
        expect(pomContent).toContain('maven-surefire-plugin');
        expect(pomContent).toContain('jacoco-maven-plugin');
        expect(pomContent).toContain('<?xml version="1.0"');
        expect(pomContent).toContain('<groupId>com.example</groupId>');
        expect(pomContent).toContain('<artifactId>test-project</artifactId>');
        expect(pomContent).toContain('<version>1.0.0</version>');
        expect(pomContent).toContain('<maven.compiler.source>11</maven.compiler.source>');
        expect(pomContent).toContain('<maven.compiler.target>11</maven.compiler.target>');
    });

    test('Gradle build file includes junit-jupiter and jacoco', async () => {
        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Lib {}',
                framework: 'junit5',
                buildSystem: 'gradle',
                mainFiles: { 'Lib.java': 'public class Lib {}' },
                testFiles: { 'LibTest.java': 'public class LibTest {}' },
            });

        expect(res.status).toBe(200);

        const executionId = res.body.executionId;
        const workspace = process.env.TEST_WORKSPACE;
        const gradlePath = path.join(workspace, executionId, 'build.gradle');

        const gradleContent = await fsPromises.readFile(gradlePath, 'utf8');
        expect(gradleContent).toContain('junit-jupiter');
        expect(gradleContent).toContain('jacoco');
        expect(gradleContent).toContain('useJUnitPlatform');
        expect(gradleContent).toContain('mavenCentral');
        expect(gradleContent).toContain("id 'java'");
    });

    test('Main source files are written to correct path', async () => {
        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Main {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'Main.java': 'public class Main { int x = 1; }' },
                testFiles: { 'MainTest.java': 'public class MainTest {}' },
            });

        const executionId = res.body.executionId;
        const workspace = process.env.TEST_WORKSPACE;
        const mainPath = path.join(workspace, executionId, 'src', 'main', 'java', 'Main.java');

        const content = await fsPromises.readFile(mainPath, 'utf8');
        expect(content).toBe('public class Main { int x = 1; }');
    });

    test('Test files are written to correct path', async () => {
        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Svc {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'Svc.java': 'public class Svc {}' },
                testFiles: { 'SvcTest.java': 'import org.junit.jupiter.api.Test;' },
            });

        const executionId = res.body.executionId;
        const workspace = process.env.TEST_WORKSPACE;
        const testPath = path.join(workspace, executionId, 'src', 'test', 'java', 'SvcTest.java');

        const content = await fsPromises.readFile(testPath, 'utf8');
        expect(content).toBe('import org.junit.jupiter.api.Test;');
    });
});
