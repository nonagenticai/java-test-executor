const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');

// ---------------------------------------------------------------------------
// The shipped image is assembled by naming source files ONE BY ONE in COPY
// instructions. Splitting the pom template into its own module and forgetting
// the COPY produced an image that built green, pushed green, and then
// CrashLooped on boot:
//
//   Error: Cannot find module './pom-template'
//     at Object.<anonymous> (/app/java_test_service.js:213:32)
//
// Nothing in the pipeline could catch it: the unit suite runs against the repo
// (where the file exists), and the build-time bake copies the module to a
// scratch dir that is deleted in the same layer. Only starting the real image
// would have shown it — so assert the invariant instead.
// ---------------------------------------------------------------------------
describe('every local module the service requires is COPYed into the image', () => {
    const entrypoint = 'java_test_service.js';
    const source = fs.readFileSync(path.join(repoRoot, 'src', entrypoint), 'utf8');

    // Relative requires only — packages come from npm install.
    const localRequires = [...source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)].map(
        (m) => m[1].replace(/^\.\//, '')
    );

    test('the scan found the requires it is supposed to guard (non-vacuity)', () => {
        // If this drops to zero the rest of the suite silently checks nothing.
        expect(localRequires.length).toBeGreaterThan(0);
        expect(localRequires).toContain('pom-template');
    });

    test.each([...new Set(localRequires)])('`require("./%s")` has a matching COPY', (mod) => {
        // The COPY may name the file directly or as part of a multi-source COPY.
        const file = mod.endsWith('.js') ? mod : `${mod}.js`;
        const copiesIntoApp = dockerfile
            .split('\n')
            .filter((l) => l.trim().startsWith('COPY '))
            // Exclude the build-time bake copy: it lands in /opt/bake-src, which is
            // rm -rf'd in the same layer, so it does NOT put the file in the image.
            .filter((l) => !l.includes('/opt/bake-src'))
            .some((l) => l.includes(`src/${file}`));

        expect(copiesIntoApp).toBe(true);
    });

    test('the entrypoint itself is copied', () => {
        expect(dockerfile).toContain(`src/${entrypoint}`);
    });
});
