/**
 * Tests for executeCommand and executeCommandInternal.
 */

const { exec } = require('child_process');

jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn(),
        spawn: jest.fn(),
    };
});

const { executeCommand, executeCommandInternal } = require('../../src/java_test_service');

describe('executeCommandInternal', () => {
    beforeEach(() => {
        exec.mockReset();
    });

    test('returns success result on successful command', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, 'hello world', 'some warnings');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const result = await executeCommandInternal('echo hello', { cwd: '/tmp' });

        expect(result.success).toBe(true);
        expect(result.stdout).toBe('hello world');
        expect(result.stderr).toBe('some warnings');
        expect(result.exitCode).toBe(0);
        expect(result.timeout).toBeUndefined();
    });

    test('returns failure result on command error', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            const error = new Error('command not found');
            error.code = 127;
            callback(error, '', 'bash: nosuchcommand: command not found');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const result = await executeCommandInternal('nosuchcommand', { cwd: '/tmp' });

        expect(result.success).toBe(false);
        expect(result.error).toContain('command not found');
        expect(result.exitCode).toBe(127);
        expect(result.stderr).toContain('command not found');
    });

    test('detects timeout via SIGTERM signal', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            const error = new Error('process killed');
            error.signal = 'SIGTERM';
            callback(error, '', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const result = await executeCommandInternal('sleep 9999', { cwd: '/tmp' });

        expect(result.success).toBe(false);
        expect(result.timeout).toBe(true);
        expect(result.error).toBe('Test execution timeout');
    });

    test('detects timeout via error message containing "timeout"', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            const error = new Error('Command timeout exceeded');
            error.code = 1;
            callback(error, 'partial output', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const result = await executeCommandInternal('slow-command', { cwd: '/tmp' });

        expect(result.success).toBe(false);
        expect(result.timeout).toBe(true);
        expect(result.error).toBe('Test execution timeout');
    });

    test('uses default cwd and timeout when not provided', async () => {
        let capturedOpts;
        exec.mockImplementation((cmd, opts, callback) => {
            capturedOpts = opts;
            callback(null, '', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        await executeCommandInternal('echo test');

        // Default workspace is /app/test_workspace (from env or default)
        expect(capturedOpts.cwd).toBeDefined();
    });

    test('passes environment variables including JAVA_HOME detection', async () => {
        let capturedOpts;
        exec.mockImplementation((cmd, opts, callback) => {
            capturedOpts = opts;
            callback(null, '', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        await executeCommandInternal('java -version', { cwd: '/tmp' });

        // The env should be set (process.env is spread in)
        expect(capturedOpts.env).toBeDefined();
        expect(capturedOpts.maxBuffer).toBe(10 * 1024 * 1024);
    });

    test('custom timeout fires when exec callback is not called in time', async () => {
        jest.useFakeTimers();

        const killFn = jest.fn();
        exec.mockImplementation(() => {
            // Don't call callback — simulate a hanging process
            return { on: jest.fn(), killed: false, kill: killFn };
        });

        const resultPromise = executeCommandInternal('hanging-cmd', { cwd: '/tmp', timeout: 5000 });

        // Advance timers past the timeout
        jest.advanceTimersByTime(6000);

        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.timeout).toBe(true);
        expect(result.error).toBe('Test execution timeout');
        expect(result.exitCode).toBe(124);
        expect(result.stderr).toBe('Command timed out');
        expect(killFn).toHaveBeenCalledWith('SIGTERM');

        jest.useRealTimers();
    });

    test('timeout does not fire when command completes before timeout', async () => {
        jest.useFakeTimers();

        const killFn = jest.fn();
        let onExitCallback;
        exec.mockImplementation((cmd, opts, callback) => {
            // Call callback immediately (success)
            setImmediate(() => callback(null, 'done', ''));
            return {
                on: jest.fn((event, cb) => { if (event === 'exit') onExitCallback = cb; }),
                killed: false,
                kill: killFn,
            };
        });

        const resultPromise = executeCommandInternal('fast-cmd', { cwd: '/tmp', timeout: 5000 });

        // Let the immediate callback fire
        jest.advanceTimersByTime(1);
        // Simulate exit event
        if (onExitCallback) onExitCallback();

        const result = await resultPromise;

        // Now advance past timeout — kill should NOT be called
        jest.advanceTimersByTime(10000);

        expect(result.success).toBe(true);
        expect(killFn).not.toHaveBeenCalled();

        jest.useRealTimers();
    });

    test('handles error with default exit code 1 when error.code is undefined', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            const error = new Error('generic error');
            // Don't set error.code
            callback(error, '', 'generic stderr');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const result = await executeCommandInternal('bad-cmd', { cwd: '/tmp' });

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
    });
});

describe('executeCommand (queue wrapper)', () => {
    beforeEach(() => {
        exec.mockReset();
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, 'output', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });
    });

    test('queues mvn commands', async () => {
        const result = await executeCommand('mvn test', { cwd: '/tmp' });

        expect(result.success).toBe(true);
        expect(result.stdout).toBe('output');
    });

    test('queues gradle commands', async () => {
        const result = await executeCommand('./gradlew build', { cwd: '/tmp' });

        expect(result.success).toBe(true);
    });

    test('queues javac commands', async () => {
        const result = await executeCommand('javac Main.java', { cwd: '/tmp' });

        expect(result.success).toBe(true);
    });

    test('executes non-build commands directly without queue', async () => {
        const result = await executeCommand('cat file.txt', { cwd: '/tmp' });

        expect(result.success).toBe(true);
        expect(result.stdout).toBe('output');
    });

    test('executes ls commands directly', async () => {
        const result = await executeCommand('ls -la', { cwd: '/tmp' });

        expect(result.success).toBe(true);
    });
});
