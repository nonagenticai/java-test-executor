/**
 * Tests for the execution queue system — unique to java-test-executor.
 * The queue serializes Maven/Gradle/javac commands to prevent conflicts.
 */

const { exec } = require('child_process');

// Mock child_process before requiring the service
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn(),
        spawn: jest.fn(),
    };
});

const service = require('../../src/java_test_service');

describe('Execution Queue', () => {
    let callCount;

    beforeEach(() => {
        // Clear the queue between tests
        service.execQueue.length = 0;
        service.isProcessing = false;
        callCount = 0;
        exec.mockReset();
    });

    describe('processQueue', () => {
        test('with empty queue does nothing and isProcessing stays false', async () => {
            service.execQueue.length = 0;
            service.isProcessing = false;

            await service.processQueue();

            expect(service.isProcessing).toBe(false);
            expect(service.execQueue.length).toBe(0);
        });

        test('with empty queue while isProcessing does nothing', async () => {
            service.isProcessing = true;

            await service.processQueue();

            // isProcessing should remain true (not flipped by empty queue path)
            expect(service.isProcessing).toBe(true);
        });

        test('with one item processes it and resolves the promise', async () => {
            // Mock exec to call callback with success
            exec.mockImplementation((cmd, opts, callback) => {
                callback(null, 'build success', '');
                return { on: jest.fn(), killed: false, kill: jest.fn() };
            });

            const resultPromise = new Promise((resolve, reject) => {
                service.execQueue.push({
                    command: 'mvn compile',
                    options: { cwd: '/tmp/test' },
                    resolve,
                    reject,
                });
            });

            // Kick off processing
            service.processQueue();

            const result = await resultPromise;

            expect(result.success).toBe(true);
            expect(result.stdout).toBe('build success');
            expect(result.exitCode).toBe(0);
        });

        test('multiple items are processed sequentially', async () => {
            const order = [];

            exec.mockImplementation((cmd, opts, callback) => {
                const idx = ++callCount;
                order.push(`start-${idx}`);
                // Simulate async work
                setImmediate(() => {
                    order.push(`end-${idx}`);
                    callback(null, `output-${idx}`, '');
                });
                return { on: jest.fn(), killed: false, kill: jest.fn() };
            });

            const promises = [];
            for (let i = 0; i < 3; i++) {
                promises.push(
                    new Promise((resolve, reject) => {
                        service.execQueue.push({
                            command: `mvn test-${i}`,
                            options: { cwd: '/tmp/test' },
                            resolve,
                            reject,
                        });
                    })
                );
            }

            service.processQueue();

            const results = await Promise.all(promises);

            // All three should have completed
            expect(results).toHaveLength(3);
            expect(results[0].stdout).toBe('output-1');
            expect(results[1].stdout).toBe('output-2');
            expect(results[2].stdout).toBe('output-3');

            // Each item started only after the previous ended
            // Pattern should be: start-1, end-1, start-2, end-2, start-3, end-3
            expect(order[0]).toBe('start-1');
            expect(order[1]).toBe('end-1');
            expect(order[2]).toBe('start-2');
        });

        test('queue error handling resolves with error result, does not reject', async () => {
            exec.mockImplementation((cmd, opts, callback) => {
                const error = new Error('Build failed');
                error.code = 1;
                callback(error, '', 'compilation error');
                return { on: jest.fn(), killed: false, kill: jest.fn() };
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

            // Should resolve (not reject) with error info
            expect(result.success).toBe(false);
            expect(result.error).toContain('Build failed');
            expect(result.stderr).toBe('compilation error');
            expect(result.exitCode).toBe(1);
        });

        test('isProcessing flag prevents concurrent processing', async () => {
            exec.mockImplementation((cmd, opts, callback) => {
                callback(null, 'ok', '');
                return { on: jest.fn(), killed: false, kill: jest.fn() };
            });

            service.isProcessing = true;

            const resultPromise = new Promise((resolve, reject) => {
                service.execQueue.push({
                    command: 'mvn compile',
                    options: { cwd: '/tmp/test' },
                    resolve,
                    reject,
                });
            });

            // processQueue should bail immediately because isProcessing is true
            await service.processQueue();

            // Item should still be in queue
            expect(service.execQueue.length).toBe(1);

            // Now unlock and process
            service.isProcessing = false;
            service.processQueue();

            const result = await resultPromise;
            expect(result.success).toBe(true);
        });
    });

    describe('executeCommand routing', () => {
        test('mvn commands go through the queue', async () => {
            exec.mockImplementation((cmd, opts, callback) => {
                callback(null, 'queued output', '');
                return { on: jest.fn(), killed: false, kill: jest.fn() };
            });

            const result = await service.executeCommand('mvn clean install', { cwd: '/tmp' });

            expect(result.success).toBe(true);
            expect(result.stdout).toBe('queued output');
        });

        test('gradle commands go through the queue', async () => {
            exec.mockImplementation((cmd, opts, callback) => {
                callback(null, 'gradle output', '');
                return { on: jest.fn(), killed: false, kill: jest.fn() };
            });

            const result = await service.executeCommand('./gradlew test', { cwd: '/tmp' });

            expect(result.success).toBe(true);
            expect(result.stdout).toBe('gradle output');
        });

        test('javac commands go through the queue', async () => {
            exec.mockImplementation((cmd, opts, callback) => {
                callback(null, 'compile output', '');
                return { on: jest.fn(), killed: false, kill: jest.fn() };
            });

            const result = await service.executeCommand('javac Test.java', { cwd: '/tmp' });

            expect(result.success).toBe(true);
        });

        test('non-build commands bypass the queue', async () => {
            exec.mockImplementation((cmd, opts, callback) => {
                callback(null, 'direct output', '');
                return { on: jest.fn(), killed: false, kill: jest.fn() };
            });

            const result = await service.executeCommand('ls -la', { cwd: '/tmp' });

            expect(result.success).toBe(true);
            expect(result.stdout).toBe('direct output');
        });
    });
});
