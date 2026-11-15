const path = require('path');
const { resolveWithinRoot } = require('../../src/java_test_service');

// js/path-injection flagged /validate's `${className}.java` write. The gate is
// resolve-then-compare: the resolved path must be the root itself or sit under
// `root + path.sep`. These tests pin the component boundary — the case a bare
// startsWith(root) check would wrongly accept.
describe('resolveWithinRoot', () => {
    const root = path.resolve('/app/test_workspace');

    test('accepts a nested relative path and returns the normalised path', () => {
        expect(resolveWithinRoot(root, path.join('job-1', 'src', 'A.java')))
            .toBe(path.join(root, 'job-1', 'src', 'A.java'));
    });

    test('accepts the root itself', () => {
        expect(resolveWithinRoot(root, '.')).toBe(root);
    });

    test('normalises ".." that stays inside the root', () => {
        expect(resolveWithinRoot(root, 'job-1/../B.java')).toBe(path.join(root, 'B.java'));
    });

    test('refuses an escape via ".."', () => {
        expect(resolveWithinRoot(root, '../etc/passwd')).toBeNull();
    });

    test('refuses an absolute path', () => {
        expect(resolveWithinRoot(root, '/etc/passwd')).toBeNull();
    });

    test('refuses a sibling that shares the root prefix', () => {
        expect(resolveWithinRoot(root, '../test_workspace_evil/x.java')).toBeNull();
    });
});
