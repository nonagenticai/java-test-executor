/**
 * Tests for POST /validate endpoint.
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

describe('POST /validate', () => {
    beforeEach(() => {
        exec.mockReset();
    });

    test('returns 400 when no code provided (undefined)', async () => {
        const res = await request(app)
            .post('/validate')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('No code provided');
        expect(res.body.validationId).toBeDefined();
    });

    test('returns 400 when code is null', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: null });

        expect(res.status).toBe(400);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('No code provided');
    });

    test('returns invalid for empty string code', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: '' });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('Empty code is not valid Java');
    });

    test('returns invalid for whitespace-only code', async () => {
        const res = await request(app)
            .post('/validate')
            .send({ code: '   \n\t  ' });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors).toContain('Empty code is not valid Java');
    });

    test('returns valid: true when javac succeeds', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, '', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/validate')
            .send({
                code: 'public class TestClass { public static void main(String[] args) {} }',
            });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.errors).toEqual([]);
        expect(res.body.validationId).toBeDefined();
    });

    test('returns valid: false when javac fails', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            const error = new Error('Compilation failed');
            error.code = 1;
            callback(error, '', 'TestClass.java:1: error: illegal start of expression');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/validate')
            .send({
                code: 'this is not valid java',
            });

        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors.length).toBeGreaterThan(0);
        expect(res.body.errors[0]).toContain('error');
    });

    test('uses custom className when provided', async () => {
        let commandRun = '';
        exec.mockImplementation((cmd, opts, callback) => {
            commandRun = cmd;
            callback(null, '', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        await request(app)
            .post('/validate')
            .send({
                code: 'public class MyClass {}',
                className: 'MyClass',
            });

        expect(commandRun).toContain('javac MyClass.java');
    });

    test('defaults className to TestClass', async () => {
        let commandRun = '';
        exec.mockImplementation((cmd, opts, callback) => {
            commandRun = cmd;
            callback(null, '', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        await request(app)
            .post('/validate')
            .send({
                code: 'public class TestClass {}',
            });

        expect(commandRun).toContain('javac TestClass.java');
    });

    test('returns validationId in response', async () => {
        exec.mockImplementation((cmd, opts, callback) => {
            callback(null, '', '');
            return { on: jest.fn(), killed: false, kill: jest.fn() };
        });

        const res = await request(app)
            .post('/validate')
            .send({ code: 'public class TestClass {}' });

        expect(res.body.validationId).toBeDefined();
        expect(typeof res.body.validationId).toBe('string');
        expect(res.body.validationId.length).toBeGreaterThan(0);
    });
});
