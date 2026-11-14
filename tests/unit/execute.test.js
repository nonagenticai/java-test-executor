/**
 * Tests for POST /execute endpoint.
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

const request = require('supertest');
const { app } = require('../../src/java_test_service');

describe('POST /execute', () => {
    beforeEach(() => {
        exec.mockReset();
        // Default: all commands succeed
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, 'OK', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });
    });

    test('fast path for trivial code "// test"', async () => {
        const res = await request(app)
            .post('/execute')
            .send({ code: '// test' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.tests).toBe(0);
        expect(res.body.passed).toBe(0);
        expect(res.body.failed).toBe(0);
        expect(res.body.output).toContain('Fast-path');
        expect(res.body.compilation.success).toBe(true);
        expect(res.body.executionId).toBeDefined();
        expect(res.body.duration).toBeGreaterThanOrEqual(0);
    });

    test('fast path for "// test" with leading/trailing whitespace', async () => {
        const res = await request(app)
            .post('/execute')
            .send({ code: '  // test  ' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.output).toContain('Fast-path');
    });

    test('returns 400 when no code, testFiles, or mainFiles provided', async () => {
        const res = await request(app)
            .post('/execute')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('At least one of');
    });

    test('returns 400 when request body is not an object', async () => {
        const res = await request(app)
            .post('/execute')
            .send('not an object')
            .set('Content-Type', 'application/json');

        // Express will parse the string or fail
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('processes valid code with Maven build system', async () => {
        let commandsRun = [];
        exec.mockImplementation((cmd, opts, callback) => {
            commandsRun.push(cmd);
            callback(null, `output for: ${cmd}`, '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Calculator { public int add(int a, int b) { return a + b; } }',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'Calculator.java': 'public class Calculator {}' },
                testFiles: { 'CalculatorTest.java': 'public class CalculatorTest {}' },
            });

        expect(res.status).toBe(200);
        expect(res.body.executionId).toBeDefined();
        expect(res.body.framework).toBe('junit5');
        expect(res.body.buildSystem).toBe('maven');
        expect(res.body.compilation).toBeDefined();

        // Should have run mvn test-compile (compiles test sources too)
        expect(commandsRun.some(c => c.includes('mvn test-compile'))).toBe(true);
    });

    test('processes valid code with Gradle build system', async () => {
        let commandsRun = [];
        exec.mockImplementation((cmd, opts, callback) => {
            commandsRun.push(cmd);
            callback(null, `output for: ${cmd}`, '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class App {}',
                framework: 'junit5',
                buildSystem: 'gradle',
                mainFiles: { 'App.java': 'public class App {}' },
                testFiles: { 'AppTest.java': 'public class AppTest {}' },
            });

        expect(res.status).toBe(200);
        expect(res.body.buildSystem).toBe('gradle');

        // Gradle wrapper should be created, and gradlew used for compile
        expect(commandsRun.some(c => c.includes('gradle'))).toBe(true);
    });

    test('handles compilation failure', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            if (cmd.includes('compile') || cmd.includes('mvn')) {
                const error = new Error('Compilation failed');
                error.code = 1;
                callback(error, '', 'error: cannot find symbol');
            } else {
                callback(null, '', '');
            }
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'invalid java',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'Bad.java': 'public class Bad { invalid }' },
                testFiles: { 'BadTest.java': 'public class BadTest {}' },
            });

        expect(res.status).toBe(200); // The endpoint returns 200 even on compile failure
        expect(res.body.compilation.success).toBe(false);
        expect(res.body.compilation.errors).toContain('cannot find symbol');
    });

    test('handles test failure with results', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            if (cmd.includes('test') && !cmd.includes('compile')) {
                // Tests fail but still return results
                const error = new Error('Tests failed');
                error.code = 1;
                callback(error, 'test output', 'test failure stderr');
            } else {
                callback(null, 'OK', '');
            }
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Foo {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'Foo.java': 'public class Foo {}' },
                testFiles: { 'FooTest.java': 'public class FooTest {}' },
            });

        expect(res.status).toBe(200);
        expect(res.body.tests).toBeDefined();
    });

    test('returns executionId and duration in all responses', async () => {
        const res = await request(app)
            .post('/execute')
            .send({ code: '// test' });

        expect(res.body.executionId).toBeDefined();
        expect(typeof res.body.executionId).toBe('string');
        expect(res.body.duration).toBeGreaterThanOrEqual(0);
    });

    test('skips coverage when generateCoverage is false', async () => {
        let commandsRun = [];
        exec.mockImplementation((cmd, opts, callback) => {
            commandsRun.push(cmd);
            callback(null, 'OK', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class X {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'X.java': 'public class X {}' },
                testFiles: { 'XTest.java': 'public class XTest {}' },
                options: { generateCoverage: false },
            });

        expect(res.status).toBe(200);
        // Should NOT have run jacoco:report
        expect(commandsRun.filter(c => c.includes('jacoco')).length).toBe(0);
    });

    test('skips static analysis when runStaticAnalysis is false', async () => {
        let commandsRun = [];
        exec.mockImplementation((cmd, opts, callback) => {
            commandsRun.push(cmd);
            callback(null, 'OK', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/execute')
            .send({
                code: 'public class Y {}',
                framework: 'junit5',
                buildSystem: 'maven',
                mainFiles: { 'Y.java': 'public class Y {}' },
                testFiles: { 'YTest.java': 'public class YTest {}' },
                options: { runStaticAnalysis: false },
            });

        expect(res.status).toBe(200);
        // Should NOT have run checkstyle/pmd/spotbugs
        expect(commandsRun.filter(c => c.includes('checkstyle')).length).toBe(0);
        expect(commandsRun.filter(c => c.includes('pmd')).length).toBe(0);
        expect(commandsRun.filter(c => c.includes('spotbugs')).length).toBe(0);
    });
});
