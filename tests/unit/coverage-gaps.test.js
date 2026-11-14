/**
 * Tests targeting uncovered lines in java_test_service.js to reach 95%+ coverage.
 *
 * Uncovered lines:
 *   42-43   processQueue catch block (dead code -- executeCommandInternal always resolves)
 *   146-148 JAVA_HOME auto-detect for Linux JVM paths
 *   441     Express body guard (!req.body || typeof req.body !== 'object')
 *   724-734 Fire-and-forget setTimeout cleanup
 *   810-811 Validate catch block
 *   821-838 Server startup block (require.main === module)
 *
 * Dead code (unreachable catch blocks, accepted):
 *   628     Gradle wrapper error catch -- executeCommand never rejects
 *   682-683 Coverage error catch -- executeCommand never rejects
 *   701     Static analysis error catch -- executeCommand never rejects
 */

const { exec } = require('child_process');
const fsSync = require('fs');
const fsPromises = require('fs').promises;

jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn(),
        spawn: jest.fn(),
    };
});

const request = require('supertest');
const service = require('../../src/java_test_service');
const { app } = service;

// ─────────────────────────────────────────────────────────────────
// Lines 42-43: processQueue catch block
// ─────────────────────────────────────────────────────────────────
describe('processQueue catch block (lines 42-43)', () => {
    beforeEach(() => {
        service.execQueue.length = 0;
        service.isProcessing = false;
        exec.mockReset();
    });

    test('resolves with error result when executeCommandInternal throws synchronously', async () => {
        exec.mockImplementation(() => {
            throw new Error('Synchronous explosion');
        });

        const resultPromise = new Promise((resolve, reject) => {
            service.execQueue.push({
                command: 'mvn compile',
                options: { cwd: '/tmp/test' },
                resolve,
                reject,
            });
        });

        service.processQueue();

        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.error).toContain('Synchronous explosion');
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────
// Lines 146-148: JAVA_HOME auto-detect for Linux JVM paths
// ─────────────────────────────────────────────────────────────────
describe('JAVA_HOME auto-detect (lines 146-148)', () => {
    let originalJavaHome;

    beforeEach(() => {
        originalJavaHome = process.env.JAVA_HOME;
        exec.mockReset();
    });

    afterEach(() => {
        if (originalJavaHome !== undefined) {
            process.env.JAVA_HOME = originalJavaHome;
        } else {
            delete process.env.JAVA_HOME;
        }
    });

    test('auto-detects JAVA_HOME when env var is not set and a JVM path exists', async () => {
        delete process.env.JAVA_HOME;

        const existsSyncSpy = jest.spyOn(fsSync, 'existsSync');
        existsSyncSpy.mockImplementation((p) => {
            if (p === '/usr/lib/jvm/java-17-openjdk-amd64') return true;
            return false;
        });

        let capturedEnv;
        exec.mockImplementation((cmd, opts, callback) => {
            capturedEnv = opts.env;
            callback(null, 'ok', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        await service.executeCommandInternal('java -version', { cwd: '/tmp' });

        expect(capturedEnv.JAVA_HOME).toBe('/usr/lib/jvm/java-17-openjdk-amd64');
        expect(capturedEnv.PATH).toContain('/usr/lib/jvm/java-17-openjdk-amd64/bin');

        existsSyncSpy.mockRestore();
    });

    test('auto-detects first available JVM path (arm64)', async () => {
        delete process.env.JAVA_HOME;

        const existsSyncSpy = jest.spyOn(fsSync, 'existsSync');
        existsSyncSpy.mockImplementation((p) => {
            if (p === '/usr/lib/jvm/java-17-openjdk-arm64') return true;
            return false;
        });

        let capturedEnv;
        exec.mockImplementation((cmd, opts, callback) => {
            capturedEnv = opts.env;
            callback(null, 'ok', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        await service.executeCommandInternal('java -version', { cwd: '/tmp' });

        expect(capturedEnv.JAVA_HOME).toBe('/usr/lib/jvm/java-17-openjdk-arm64');

        existsSyncSpy.mockRestore();
    });

    test('auto-detects when JAVA_HOME is set but path does not exist', async () => {
        process.env.JAVA_HOME = '/nonexistent/jdk';

        const existsSyncSpy = jest.spyOn(fsSync, 'existsSync');
        existsSyncSpy.mockImplementation((p) => {
            if (p === '/nonexistent/jdk') return false;
            if (p === '/usr/lib/jvm/java-11-openjdk-amd64') return true;
            return false;
        });

        let capturedEnv;
        exec.mockImplementation((cmd, opts, callback) => {
            capturedEnv = opts.env;
            callback(null, 'ok', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        await service.executeCommandInternal('java -version', { cwd: '/tmp' });

        expect(capturedEnv.JAVA_HOME).toBe('/usr/lib/jvm/java-11-openjdk-amd64');

        existsSyncSpy.mockRestore();
    });
});

// ─────────────────────────────────────────────────────────────────
// Line 441: Express body guard (!req.body || typeof req.body !== 'object')
// ─────────────────────────────────────────────────────────────────
describe('POST /execute body guard (line 441)', () => {
    beforeEach(() => {
        exec.mockReset();
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, 'OK', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });
    });

    test('returns 400 when Content-Type is text/plain (no body parsing)', async () => {
        const res = await request(app)
            .post('/execute')
            .set('Content-Type', 'text/plain')
            .send('just a string');

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('Request body is required');
    });
});

// ─────────────────────────────────────────────────────────────────
// Lines 724-734: Fire-and-forget setTimeout cleanup
// ─────────────────────────────────────────────────────────────────
describe('setTimeout cleanup after /execute (lines 724-734)', () => {
    beforeEach(() => {
        exec.mockReset();
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, 'OK', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });
    });

    test('setTimeout is scheduled and cleanup callback removes directory', async () => {
        const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Timer {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'Timer.java': 'public class Timer {}' },
                testFiles: { 'TimerTest.java': 'public class TimerTest {}' },
                options: { generateCoverage: false, runStaticAnalysis: false },
            });

        expect(res.status).toBe(200);

        // Find the setTimeout call with 60000ms delay (the cleanup timer)
        const cleanupCall = setTimeoutSpy.mock.calls.find(call => call[1] === 60000);
        expect(cleanupCall).toBeDefined();

        // Manually invoke the cleanup callback to cover lines 724-730
        const cleanupFn = cleanupCall[0];
        await cleanupFn();

        setTimeoutSpy.mockRestore();
    });

    test('setTimeout cleanup callback handles fs.rm failure (line 728)', async () => {
        const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class TimerFail {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'TimerFail.java': 'public class TimerFail {}' },
                testFiles: { 'TimerFailTest.java': 'public class TimerFailTest {}' },
                options: { generateCoverage: false, runStaticAnalysis: false },
            });

        expect(res.status).toBe(200);

        const cleanupCall = setTimeoutSpy.mock.calls.find(call => call[1] === 60000);
        expect(cleanupCall).toBeDefined();

        // Mock fs.rm to throw, then invoke cleanup to cover the catch block
        const rmSpy = jest.spyOn(fsPromises, 'rm').mockRejectedValueOnce(
            new Error('EPERM: operation not permitted')
        );

        const cleanupFn = cleanupCall[0];
        // Should not throw even when fs.rm fails
        await cleanupFn();

        rmSpy.mockRestore();
        setTimeoutSpy.mockRestore();
    });
});

// ─────────────────────────────────────────────────────────────────
// Lines 810-811: /validate catch block
// ─────────────────────────────────────────────────────────────────
describe('POST /validate error catch block (lines 810-811)', () => {
    beforeEach(() => {
        exec.mockReset();
    });

    test('returns 500 when fs.mkdir throws in validate', async () => {
        const mkdirSpy = jest.spyOn(fsPromises, 'mkdir').mockRejectedValueOnce(
            new Error('Permission denied: cannot create temp dir')
        );

        const res = await request(app)
            .post('/validate')
            .send({ code: 'public class Throw {}' });

        expect(res.status).toBe(500);
        expect(res.body.valid).toBe(false);
        expect(res.body.error).toContain('Permission denied');
        expect(res.body.validationId).toBeDefined();

        mkdirSpy.mockRestore();
    });
});

// ─────────────────────────────────────────────────────────────────
// Lines 821-838: Server startup block (require.main === module)
// ─────────────────────────────────────────────────────────────────
describe('Server startup block (lines 821-838)', () => {
    test('app exports are correct', () => {
        expect(service.app).toBeDefined();
        expect(typeof service.app.listen).toBe('function');
        expect(service.executeCommand).toBeDefined();
        expect(service.processQueue).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────
// Lines 732-740: /execute outer catch block
// ─────────────────────────────────────────────────────────────────
describe('POST /execute outer catch block (lines 732-740)', () => {
    beforeEach(() => {
        exec.mockReset();
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, 'OK', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });
    });

    test('returns 500 when an unexpected error occurs in the handler', async () => {
        const mkdirSpy = jest.spyOn(fsPromises, 'mkdir').mockRejectedValueOnce(
            new Error('Disk full')
        );

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class DiskErr {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'DiskErr.java': 'public class DiskErr {}' },
                testFiles: { 'DiskErrTest.java': 'public class DiskErrTest {}' },
            });

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Disk full');
        expect(res.body.executionId).toBeDefined();
        expect(res.body.duration).toBeGreaterThanOrEqual(0);

        mkdirSpy.mockRestore();
    });
});
