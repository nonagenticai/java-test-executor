const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { MAVEN_POM_TEMPLATE } = require('../../src/pom-template');

const repoRoot = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// The runtime namespace has ZERO internet egress. Everything Maven needs has to
// be in the image already, baked from THIS template. Anything that lets the
// baked repository and the scaffolded pom drift apart is a production outage
// that only shows up as a resolution error, so the coupling is asserted here.
// ---------------------------------------------------------------------------
describe('the baked Maven repository cannot drift from the scaffolded pom', () => {
    test('scripts/print-pom.js emits the template byte-for-byte', () => {
        const printed = execFileSync('node', [path.join(repoRoot, 'scripts', 'print-pom.js')], {
            encoding: 'utf8'
        });
        expect(printed).toBe(MAVEN_POM_TEMPLATE);
    });

    // The bake moved to Dockerfile.base when the toolchain was split out of the
    // per-commit image. These assertions FOLLOWED it rather than being deleted:
    // the invariant is "the baked repo is generated from the template module and
    // Maven is pointed at it offline", and that invariant is now the base's job.
    // Deleting them because the app Dockerfile no longer matches would have
    // removed the guard instead of relocating it.
    test('the base Dockerfile bakes from the template module, never from a copied pom', () => {
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
        const base = dockerfile.split(/^FROM toolchain AS app$/m)[0];
        expect(base).toContain('pom-template');
        // A hand-copied <project> block is the exact rot this test exists to prevent.
        expect(base).not.toContain('<project');
    });

    test('the base points Maven at the baked repository and stays offline', () => {
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
        const base = dockerfile.split(/^FROM toolchain AS app$/m)[0];
        expect(base).toMatch(/ENV MAVEN_ARGS=.*-Dmaven\.repo\.local=\/opt\/m2/);
        // -o turns a missing artifact into an immediate, legible failure instead
        // of a hang against a blocked connection.
        expect(base).toMatch(/ENV MAVEN_ARGS=.*-o/);
    });

    // Relocating the bake is only safe if the app image actually CONSUMES the
    // base. Without this, someone could point the app FROM eclipse-temurin
    // again and both assertions above would still pass while production lost
    // the baked repository entirely.
    test('the shipped stage is built FROM the toolchain stage that bakes the repository', () => {
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
        expect(dockerfile).toMatch(/^FROM toolchain AS app$/m);
        // A tag would let a rebuilt base roll into this image unreviewed.
        expect(dockerfile).not.toMatch(/^FROM .*java-test-executor-base:/m);
    });

    // The bake must not be duplicated back into the per-commit image: that is
    // what the split removed, and a stray `apk add maven` there also
    // reintroduces the openjdk25-on-PATH drift the base now asserts against.
    test('the app image does not rebuild the toolchain', () => {
        // The app stage only: the toolchain stage legitimately installs maven and
        // bakes the repository — that is its job. What must never come back is a
        // second toolchain inside the shipped stage.
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
        const appStage = dockerfile.split(/^FROM toolchain AS app$/m)[1] || '';
        const directives = appStage
            .split('\n')
            .filter((l) => !l.trim().startsWith('#'))
            .join('\n');
        expect(directives).not.toMatch(/apk add .*maven/);
        expect(directives).not.toMatch(/mvn .*-Dmaven\.repo\.local/);
    });
});

describe('every plugin the template declares is version-pinned', () => {
    // An unpinned plugin makes Maven resolve the version from remote metadata,
    // which cannot work offline — the artifact being present in /opt/m2 does not
    // help if Maven will not decide which artifact it wants without a network
    // round trip.
    const pluginBlocks = MAVEN_POM_TEMPLATE.split('<plugin>').slice(1);

    test('the template declares plugins at all (guards against a vacuous split)', () => {
        expect(pluginBlocks.length).toBeGreaterThanOrEqual(5);
    });

    test.each(pluginBlocks.map((b, i) => [i, b]))('plugin block %i pins a version', (_i, block) => {
        const artifact = (block.match(/<artifactId>([^<]+)<\/artifactId>/) || [])[1];
        expect(artifact).toBeTruthy();
        expect(block.slice(0, block.indexOf('</plugin>'))).toMatch(/<version>[^<]+<\/version>/);
    });

    test('the three static-analysis plugins the service runs by default are declared', () => {
        // options.runStaticAnalysis !== false, so `mvn checkstyle:check`,
        // `mvn pmd:check` and `mvn spotbugs:check` run on every /execute.
        // spotbugs additionally has to be DECLARED for its goal prefix to
        // resolve at all — it lives under com.github.spotbugs, not a default
        // plugin group, so `mvn spotbugs:check` failed even online.
        expect(MAVEN_POM_TEMPLATE).toContain('maven-checkstyle-plugin');
        expect(MAVEN_POM_TEMPLATE).toContain('maven-pmd-plugin');
        expect(MAVEN_POM_TEMPLATE).toContain('spotbugs-maven-plugin');
        expect(MAVEN_POM_TEMPLATE).toContain('com.github.spotbugs');
    });
});
