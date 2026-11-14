/**
 * Tests for GET /health endpoint.
 */

// Mock child_process before requiring the service
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

describe('GET /health', () => {
    test('returns 200 with healthy status', async () => {
        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('healthy');
    });

    test('returns correct service name', async () => {
        const res = await request(app).get('/health');

        expect(res.body.service).toBe('java-test-executor');
    });

    test('returns valid ISO timestamp', async () => {
        const res = await request(app).get('/health');

        const timestamp = new Date(res.body.timestamp);
        expect(timestamp.toISOString()).toBe(res.body.timestamp);
        expect(isNaN(timestamp.getTime())).toBe(false);
    });

    test('returns version 1.0.0', async () => {
        const res = await request(app).get('/health');

        expect(res.body.version).toBe('1.0.0');
    });

    test('lists all supported frameworks', async () => {
        const res = await request(app).get('/health');

        expect(res.body.capabilities.frameworks).toEqual(
            expect.arrayContaining(['junit5', 'testng', 'junit4'])
        );
        expect(res.body.capabilities.frameworks).toHaveLength(3);
    });

    test('lists all build systems', async () => {
        const res = await request(app).get('/health');

        expect(res.body.capabilities.buildSystems).toEqual(
            expect.arrayContaining(['maven', 'gradle'])
        );
        expect(res.body.capabilities.buildSystems).toHaveLength(2);
    });

    test('includes all expected features', async () => {
        const res = await request(app).get('/health');

        const features = res.body.capabilities.features;
        expect(features).toContain('test_execution');
        expect(features).toContain('code_coverage');
        expect(features).toContain('static_analysis');
        expect(features).toContain('build_compilation');
        expect(features).toContain('dependency_management');
    });
});
