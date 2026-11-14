/**
 * Tests for parseTestResults (Surefire XML) and parseCoverageResults (JaCoCo XML).
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Mock child_process to prevent service from executing real commands
jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn(),
        spawn: jest.fn(),
    };
});

const { parseTestResults, parseCoverageResults } = require('../../src/java_test_service');

describe('parseTestResults', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'java-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('parses valid Surefire XML with correct counts', async () => {
        const reportsDir = path.join(tmpDir, 'target', 'surefire-reports');
        await fs.mkdir(reportsDir, { recursive: true });

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite tests="10" failures="2" errors="1" skipped="1" time="1.234" name="com.example.FooTest">
  <testcase name="testAdd" classname="com.example.FooTest" time="0.010"/>
  <testcase name="testSubtract" classname="com.example.FooTest" time="0.005"/>
  <testcase name="testFail" classname="com.example.FooTest" time="0.002">
    <failure message="expected 5 but was 3" type="org.junit.AssertionError">stack trace here</failure>
  </testcase>
</testsuite>`;

        await fs.writeFile(path.join(reportsDir, 'TEST-com.example.FooTest.xml'), xml);

        const results = await parseTestResults(tmpDir, 'maven');

        expect(results.total).toBe(10);
        expect(results.failed).toBe(3);  // failures(2) + errors(1)
        expect(results.skipped).toBe(1);
        expect(results.passed).toBe(6);  // 10 - 2 - 1 - 1
        expect(results.testFiles).toHaveLength(1);
        expect(results.testFiles[0].file).toBe('TEST-com.example.FooTest.xml');
        expect(results.testFiles[0].tests).toBe(10);
        expect(results.testFiles[0].failures).toBe(2);
        expect(results.testFiles[0].errors).toBe(1);
        expect(results.testFiles[0].skipped).toBe(1);
    });

    test('parses individual test cases from XML', async () => {
        const reportsDir = path.join(tmpDir, 'target', 'surefire-reports');
        await fs.mkdir(reportsDir, { recursive: true });

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite tests="3" failures="0" errors="0" skipped="0" time="0.333" name="com.example.BarTest">
  <testcase name="testFoo" classname="com.example.BarTest" time="0.123"/>
  <testcase name="testBar" classname="com.example.BarTest" time="0.100"/>
  <testcase name="testBaz" classname="com.example.BarTest" time="0.110"/>
</testsuite>`;

        await fs.writeFile(path.join(reportsDir, 'TEST-com.example.BarTest.xml'), xml);

        const results = await parseTestResults(tmpDir, 'maven');

        expect(results.total).toBe(3);
        expect(results.passed).toBe(3);
        expect(results.failed).toBe(0);
        expect(results.skipped).toBe(0);
    });

    test('aggregates results from multiple test suite files', async () => {
        const reportsDir = path.join(tmpDir, 'target', 'surefire-reports');
        await fs.mkdir(reportsDir, { recursive: true });

        const xml1 = `<testsuite tests="5" failures="1" errors="0" skipped="0"/>`;
        const xml2 = `<testsuite tests="8" failures="0" errors="2" skipped="1"/>`;

        await fs.writeFile(path.join(reportsDir, 'TEST-Suite1.xml'), xml1);
        await fs.writeFile(path.join(reportsDir, 'TEST-Suite2.xml'), xml2);

        const results = await parseTestResults(tmpDir, 'maven');

        expect(results.total).toBe(13);       // 5 + 8
        expect(results.failed).toBe(3);       // 1 + 2
        expect(results.skipped).toBe(1);      // 0 + 1
        expect(results.passed).toBe(9);       // (5-1-0-0) + (8-0-2-1)
        expect(results.testFiles).toHaveLength(2);
    });

    test('handles Gradle test results path', async () => {
        const reportsDir = path.join(tmpDir, 'build', 'test-results', 'test');
        await fs.mkdir(reportsDir, { recursive: true });

        const xml = `<testsuite tests="4" failures="1" errors="0" skipped="0"/>`;
        await fs.writeFile(path.join(reportsDir, 'TEST-GradleTest.xml'), xml);

        const results = await parseTestResults(tmpDir, 'gradle');

        expect(results.total).toBe(4);
        expect(results.failed).toBe(1);
        expect(results.passed).toBe(3);
    });

    test('returns empty results for missing directory', async () => {
        const results = await parseTestResults('/nonexistent/path', 'maven');

        expect(results.total).toBe(0);
        expect(results.passed).toBe(0);
        expect(results.failed).toBe(0);
        expect(results.skipped).toBe(0);
        expect(results.testFiles).toEqual([]);
        expect(results.failureDetails).toEqual([]);
    });

    test('handles malformed XML gracefully', async () => {
        const reportsDir = path.join(tmpDir, 'target', 'surefire-reports');
        await fs.mkdir(reportsDir, { recursive: true });

        // XML without tests attribute — regex won't match
        const xml = `<testsuite name="com.example.BadTest"><testcase/></testsuite>`;
        await fs.writeFile(path.join(reportsDir, 'TEST-Bad.xml'), xml);

        const results = await parseTestResults(tmpDir, 'maven');

        // The regex won't match tests="(\d+)" so nothing gets counted
        expect(results.total).toBe(0);
        expect(results.testFiles).toEqual([]);
    });

    test('skips non-XML files in reports directory', async () => {
        const reportsDir = path.join(tmpDir, 'target', 'surefire-reports');
        await fs.mkdir(reportsDir, { recursive: true });

        await fs.writeFile(path.join(reportsDir, 'TEST-Good.xml'), '<testsuite tests="3" failures="0" errors="0" skipped="0"/>');
        await fs.writeFile(path.join(reportsDir, 'output.txt'), 'not xml');

        const results = await parseTestResults(tmpDir, 'maven');

        expect(results.total).toBe(3);
        expect(results.testFiles).toHaveLength(1);
    });

    test('handles XML with missing optional attributes', async () => {
        const reportsDir = path.join(tmpDir, 'target', 'surefire-reports');
        await fs.mkdir(reportsDir, { recursive: true });

        // Only tests attribute present, no failures/errors/skipped
        const xml = `<testsuite tests="5"/>`;
        await fs.writeFile(path.join(reportsDir, 'TEST-Minimal.xml'), xml);

        const results = await parseTestResults(tmpDir, 'maven');

        expect(results.total).toBe(5);
        expect(results.failed).toBe(0);
        expect(results.skipped).toBe(0);
        expect(results.passed).toBe(5);
    });
});

describe('parseCoverageResults', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'java-cov-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('parses JaCoCo XML with LINE counter (Maven path)', async () => {
        const coverageDir = path.join(tmpDir, 'target', 'site', 'jacoco');
        await fs.mkdir(coverageDir, { recursive: true });

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test-project">
  <counter type="LINE" covered="90" missed="10"/>
  <counter type="BRANCH" covered="15" missed="5"/>
  <counter type="INSTRUCTION" covered="200" missed="50"/>
</report>`;

        await fs.writeFile(path.join(coverageDir, 'jacoco.xml'), xml);

        const coverage = await parseCoverageResults(tmpDir, 'maven');

        expect(coverage.line).toBeDefined();
        expect(coverage.line.covered).toBe(90);
        expect(coverage.line.missed).toBe(10);
        expect(coverage.line.total).toBe(100);
        expect(coverage.line.percentage).toBe('90.00');

        expect(coverage.branch).toBeDefined();
        expect(coverage.branch.covered).toBe(15);
        expect(coverage.branch.missed).toBe(5);
        expect(coverage.branch.total).toBe(20);
        expect(coverage.branch.percentage).toBe('75.00');

        expect(coverage.instruction).toBeDefined();
        expect(coverage.instruction.covered).toBe(200);
        expect(coverage.instruction.missed).toBe(50);
        expect(coverage.instruction.total).toBe(250);
        expect(coverage.instruction.percentage).toBe('80.00');
    });

    test('parses JaCoCo XML (Gradle path)', async () => {
        const coverageDir = path.join(tmpDir, 'build', 'reports', 'jacoco', 'test');
        await fs.mkdir(coverageDir, { recursive: true });

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="test-project">
  <counter type="LINE" covered="45" missed="5"/>
</report>`;

        await fs.writeFile(path.join(coverageDir, 'jacocoTestReport.xml'), xml);

        const coverage = await parseCoverageResults(tmpDir, 'gradle');

        expect(coverage.line).toBeDefined();
        expect(coverage.line.covered).toBe(45);
        expect(coverage.line.missed).toBe(5);
        expect(coverage.line.percentage).toBe('90.00');
    });

    test('returns empty object for missing coverage file', async () => {
        const coverage = await parseCoverageResults('/nonexistent/path', 'maven');

        expect(coverage).toEqual({});
    });

    test('returns empty object when XML has no counter elements', async () => {
        const coverageDir = path.join(tmpDir, 'target', 'site', 'jacoco');
        await fs.mkdir(coverageDir, { recursive: true });

        const xml = `<?xml version="1.0" encoding="UTF-8"?><report name="empty"/>`;

        await fs.writeFile(path.join(coverageDir, 'jacoco.xml'), xml);

        const coverage = await parseCoverageResults(tmpDir, 'maven');

        expect(coverage).toEqual({});
    });

    test('handles partial counters (only LINE, no BRANCH)', async () => {
        const coverageDir = path.join(tmpDir, 'target', 'site', 'jacoco');
        await fs.mkdir(coverageDir, { recursive: true });

        const xml = `<report><counter type="LINE" covered="80" missed="20"/></report>`;

        await fs.writeFile(path.join(coverageDir, 'jacoco.xml'), xml);

        const coverage = await parseCoverageResults(tmpDir, 'maven');

        expect(coverage.line).toBeDefined();
        expect(coverage.line.percentage).toBe('80.00');
        expect(coverage.branch).toBeUndefined();
        expect(coverage.instruction).toBeUndefined();
    });
});
