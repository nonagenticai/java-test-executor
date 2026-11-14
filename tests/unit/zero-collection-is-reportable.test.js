/**
 * Zero-collection must be REPORTABLE, not merely non-passing.
 *
 * `total > 0` in the verdict already stops a zero-test run being graded green.
 * What was missing is the ability for the caller to TELL a zero-collection run
 * apart from a genuine failure: both arrived as `success:false` and nothing on
 * the wire named the difference. The orchestrator's three-valued verdict
 * (passed / failed / not_run) therefore had no signal to act on for java, so
 * the whole mechanism was inert for this language.
 *
 * Every test here asserts THREE outcomes are distinguishable, not two.
 */
const realFs = require('fs').promises;
const path = require('path');
const os = require('os');

jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return { ...original, exec: jest.fn(), spawn: jest.fn() };
});

const { exec } = require('child_process');
const request = require('supertest');
const { app, parseTestResults } = require('../../src/java_test_service');

const fs = require('fs').promises;

/** Make every shelled command succeed (exit 0) or fail (non-zero). */
function mockExec({ testStepFails = false } = {}) {
    let seen = 0;
    exec.mockImplementation((cmd, opts, callback) => {
        seen += 1;
        const isTestStep = /mvn(\s|.*\s)test(\s|$)/.test(cmd) && !cmd.includes('test-compile');
        if (isTestStep && testStepFails) {
            const err = new Error('tests failed');
            err.code = 1;
            callback(err, 'Tests run: 2, Failures: 1', '');
        } else {
            callback(null, 'OK', '');
        }
        return { on: jest.fn(), killed: false, kill: jest.fn(), pid: 1000 + seen };
    });
}

const SUITE = (tests, failures, errors, skipped) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuite tests="${tests}" failures="${failures}" errors="${errors}" ` +
    `skipped="${skipped}" time="0.1" name="com.example.FooTest"/>`;

const CODE = 'public class Calc { public int add(int a, int b) { return a + b; } }';

describe('parseTestResults reports whether it MEASURED the zero', () => {
    let tmpDir;
    beforeEach(async () => {
        tmpDir = await realFs.mkdtemp(path.join(os.tmpdir(), 'java-zero-'));
    });
    afterEach(async () => {
        await realFs.rm(tmpDir, { recursive: true, force: true });
    });

    test('a missing reports directory is an UNMEASURED zero', async () => {
        const res = await parseTestResults(tmpDir, 'maven');
        expect(res.total).toBe(0);
        // The distinction the old all-zero object flattened away.
        expect(res.reportsFound).toBe(false);
    });

    test('a readable reports directory is a MEASURED zero', async () => {
        const reportsDir = path.join(tmpDir, 'target', 'surefire-reports');
        await realFs.mkdir(reportsDir, { recursive: true });
        await realFs.writeFile(path.join(reportsDir, 'TEST-Foo.xml'), SUITE(0, 0, 0, 0));

        const res = await parseTestResults(tmpDir, 'maven');
        expect(res.total).toBe(0);
        expect(res.reportsFound).toBe(true);
    });

    test('reportsFound is true when tests really ran', async () => {
        const reportsDir = path.join(tmpDir, 'target', 'surefire-reports');
        await realFs.mkdir(reportsDir, { recursive: true });
        await realFs.writeFile(path.join(reportsDir, 'TEST-Foo.xml'), SUITE(3, 0, 0, 0));

        const res = await parseTestResults(tmpDir, 'maven');
        expect(res.total).toBe(3);
        expect(res.reportsFound).toBe(true);
    });
});

describe('no_tests_run on the /execute contract', () => {
    let spyReaddir;
    let spyReadFile;

    afterEach(() => {
        if (spyReaddir) spyReaddir.mockRestore();
        if (spyReadFile) spyReadFile.mockRestore();
        jest.clearAllMocks();
    });

    /** Pretend surefire wrote exactly one report with these counts. */
    function withReport(tests, failures, errors, skipped) {
        spyReaddir = jest.spyOn(fs, 'readdir').mockResolvedValue(['TEST-Foo.xml']);
        spyReadFile = jest
            .spyOn(fs, 'readFile')
            .mockResolvedValue(SUITE(tests, failures, errors, skipped));
    }

    /** Pretend surefire wrote nothing at all (maven's zero-test-class case). */
    function withNoReports() {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        spyReaddir = jest.spyOn(fs, 'readdir').mockRejectedValue(err);
    }

    // ---- Outcome 1 of 3: zero tests collected -------------------------------
    test('maven exiting 0 with NO surefire reports is a not-run', async () => {
        // This is maven's canonical zero-collection shape: no test classes, so
        // "No tests to run.", EXIT 0, and no target/surefire-reports at all.
        mockExec();
        withNoReports();

        const res = await request(app).post('/execute').send({ code: CODE });

        expect(res.status).toBe(200);
        expect(res.body.tests.total).toBe(0);
        expect(res.body.tests.reportsFound).toBe(false);
        expect(res.body.no_tests_run).toBe(true);
        expect(res.body.success).toBe(false);
    });

    test('a surefire report that itself says zero is also a not-run', async () => {
        mockExec();
        withReport(0, 0, 0, 0);

        const res = await request(app).post('/execute').send({ code: CODE });

        expect(res.body.tests.total).toBe(0);
        expect(res.body.tests.reportsFound).toBe(true);
        expect(res.body.no_tests_run).toBe(true);
        expect(res.body.success).toBe(false);
    });

    // ---- Outcome 2 of 3: everything passed ----------------------------------
    test('an all-passed run reports no_tests_run=false', async () => {
        mockExec();
        withReport(3, 0, 0, 0);

        const res = await request(app).post('/execute').send({ code: CODE });

        expect(res.body.tests.total).toBe(3);
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(true);
    });

    // ---- Outcome 3 of 3: genuine test failure -------------------------------
    test('a genuine test failure is a FAILURE, not a not-run', async () => {
        mockExec({ testStepFails: true });
        withReport(3, 1, 0, 0);

        const res = await request(app).post('/execute').send({ code: CODE });

        expect(res.body.tests.failed).toBe(1);
        // The distinction that matters: not a pass, and NOT a not-run either.
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
    });

    // ---- The way "total === 0" can lie --------------------------------------
    test('a maven that exits NON-ZERO with no reports is a FAILURE', async () => {
        // total===0 here too, but this is what an offline dependency-resolution
        // error or a crashed surefire looks like. Calling it "no tests were
        // collected" would hand a genuine infrastructure failure the one
        // verdict that is never a failure.
        mockExec({ testStepFails: true });
        withNoReports();

        const res = await request(app).post('/execute').send({ code: CODE });

        expect(res.body.tests.total).toBe(0);
        expect(res.body.no_tests_run).toBe(false);
        expect(res.body.success).toBe(false);
    });
});
