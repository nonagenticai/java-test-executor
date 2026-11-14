/**
 * Tests for detectBuildSystem and detectTestingFramework.
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

const { detectBuildSystem, detectTestingFramework } = require('../../src/java_test_service');

describe('detectBuildSystem', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'java-detect-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test('returns "maven" when pom.xml exists', async () => {
        await fs.writeFile(path.join(tmpDir, 'pom.xml'), '<project/>');

        const result = await detectBuildSystem(tmpDir);

        expect(result).toBe('maven');
    });

    test('returns "gradle" when build.gradle exists', async () => {
        await fs.writeFile(path.join(tmpDir, 'build.gradle'), 'plugins {}');

        const result = await detectBuildSystem(tmpDir);

        expect(result).toBe('gradle');
    });

    test('returns "gradle" when build.gradle.kts exists', async () => {
        await fs.writeFile(path.join(tmpDir, 'build.gradle.kts'), 'plugins {}');

        const result = await detectBuildSystem(tmpDir);

        expect(result).toBe('gradle');
    });

    test('prefers maven when both pom.xml and build.gradle exist', async () => {
        await fs.writeFile(path.join(tmpDir, 'pom.xml'), '<project/>');
        await fs.writeFile(path.join(tmpDir, 'build.gradle'), 'plugins {}');

        const result = await detectBuildSystem(tmpDir);

        expect(result).toBe('maven');
    });

    test('returns null when neither exists', async () => {
        // tmpDir exists but has no build files
        const result = await detectBuildSystem(tmpDir);

        expect(result).toBeNull();
    });

    test('returns null on read error (nonexistent directory)', async () => {
        const result = await detectBuildSystem('/nonexistent/path/xyz');

        expect(result).toBeNull();
    });
});

describe('detectTestingFramework', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'java-framework-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    describe('with Maven', () => {
        test('detects junit5 from pom.xml with junit-jupiter', async () => {
            const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
    </dependency>
  </dependencies>
</project>`;
            await fs.writeFile(path.join(tmpDir, 'pom.xml'), pom);

            const result = await detectTestingFramework(tmpDir, 'maven');

            expect(result).toBe('junit5');
        });

        test('detects testng from pom.xml', async () => {
            const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>org.testng</groupId>
      <artifactId>testng</artifactId>
    </dependency>
  </dependencies>
</project>`;
            await fs.writeFile(path.join(tmpDir, 'pom.xml'), pom);

            const result = await detectTestingFramework(tmpDir, 'maven');

            expect(result).toBe('testng');
        });

        test('detects junit4 from pom.xml with junit (no jupiter)', async () => {
            const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
    </dependency>
  </dependencies>
</project>`;
            await fs.writeFile(path.join(tmpDir, 'pom.xml'), pom);

            const result = await detectTestingFramework(tmpDir, 'maven');

            expect(result).toBe('junit4');
        });

        test('defaults to junit5 when no framework detected in pom.xml', async () => {
            const pom = `<project><dependencies></dependencies></project>`;
            await fs.writeFile(path.join(tmpDir, 'pom.xml'), pom);

            const result = await detectTestingFramework(tmpDir, 'maven');

            expect(result).toBe('junit5');
        });
    });

    describe('with Gradle', () => {
        test('detects junit5 from build.gradle with junit-jupiter', async () => {
            const gradle = `
dependencies {
    testImplementation 'org.junit.jupiter:junit-jupiter:5.8.2'
}`;
            await fs.writeFile(path.join(tmpDir, 'build.gradle'), gradle);

            const result = await detectTestingFramework(tmpDir, 'gradle');

            expect(result).toBe('junit5');
        });

        test('detects testng from build.gradle', async () => {
            const gradle = `
dependencies {
    testImplementation 'org.testng:testng:7.5'
}`;
            await fs.writeFile(path.join(tmpDir, 'build.gradle'), gradle);

            const result = await detectTestingFramework(tmpDir, 'gradle');

            expect(result).toBe('testng');
        });

        test('detects junit4 from build.gradle', async () => {
            const gradle = `
dependencies {
    testImplementation 'junit:junit:4.13.2'
}`;
            await fs.writeFile(path.join(tmpDir, 'build.gradle'), gradle);

            const result = await detectTestingFramework(tmpDir, 'gradle');

            expect(result).toBe('junit4');
        });
    });

    test('returns junit5 on read error (missing file)', async () => {
        // No pom.xml or build.gradle written → readFile will fail
        const result = await detectTestingFramework(tmpDir, 'maven');

        expect(result).toBe('junit5');
    });

    test('returns junit5 for unknown build system', async () => {
        const result = await detectTestingFramework(tmpDir, 'ant');

        expect(result).toBe('junit5');
    });
});
