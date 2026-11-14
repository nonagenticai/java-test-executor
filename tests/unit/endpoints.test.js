/**
 * Tests for /frameworks, /info, and 404 handling.
 */

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

describe('GET /frameworks', () => {
    test('returns 200', async () => {
        const res = await request(app).get('/frameworks');

        expect(res.status).toBe(200);
    });

    test('lists all supported frameworks', async () => {
        const res = await request(app).get('/frameworks');

        expect(res.body.supported).toBeDefined();
        expect(res.body.supported.junit5).toBeDefined();
        expect(res.body.supported.testng).toBeDefined();
        expect(res.body.supported.junit4).toBeDefined();
    });

    test('lists build systems', async () => {
        const res = await request(app).get('/frameworks');

        expect(res.body.buildSystems).toBeDefined();
        expect(res.body.buildSystems.maven).toBeDefined();
        expect(res.body.buildSystems.gradle).toBeDefined();
    });

    test('lists capabilities', async () => {
        const res = await request(app).get('/frameworks');

        expect(res.body.capabilities).toBeDefined();
        expect(res.body.capabilities.testExecution).toBe(true);
        expect(res.body.capabilities.codeCoverage).toBe(true);
        expect(res.body.capabilities.staticAnalysis).toBe(true);
        expect(res.body.capabilities.multipleFrameworks).toBe(true);
        expect(res.body.capabilities.buildSystemSupport).toEqual(['maven', 'gradle']);
    });

    test('framework details include name, dependencies, test patterns', async () => {
        const res = await request(app).get('/frameworks');

        const junit5 = res.body.supported.junit5;
        expect(junit5.name).toBe('JUnit 5');
        expect(junit5.dependencies).toEqual(['org.junit.jupiter:junit-jupiter']);
        expect(junit5.testPatterns).toEqual(expect.arrayContaining(['**/*Test.java']));
        expect(junit5.mvnGoal).toBe('test');
        expect(junit5.gradleTask).toBe('test');
    });
});

describe('404 handling', () => {
    test('GET /nonexistent returns 404', async () => {
        const res = await request(app).get('/nonexistent');

        // Express 5 returns 404 for unmatched routes
        expect(res.status).toBe(404);
    });

    test('GET /info returns 404 (no /info endpoint defined)', async () => {
        const res = await request(app).get('/info');

        expect(res.status).toBe(404);
    });

    test('POST /nonexistent returns 404', async () => {
        const res = await request(app).post('/nonexistent').send({});

        expect(res.status).toBe(404);
    });
});
