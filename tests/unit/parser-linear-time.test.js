const {
    parseJavaSource,
    stripBlockComments,
    stripLineComments,
} = require('../../src/java_test_service');

// Regression tests for alert js/polynomial-redos on parseJavaSource's comment
// stripping (src/java_test_service.js): /\/\*[\s\S]*?\*\//g re-scanned the
// suffix for a closing '*/' from every '/*' start, so the alert's named shape
// ('/*' followed by many 'a/*' repetitions) is quadratic. The explicit budget
// is deliberately loose so a loaded CI box cannot flake; the linear scanner
// finishes this input in milliseconds.
const LINEAR_TIME_BUDGET_MS = 2000;

function measure(fn) {
    const started = process.hrtime.bigint();
    const value = fn();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { value, elapsedMs };
}

describe('comment stripping is linear (js/polynomial-redos regression)', () => {
    test("unterminated '/*' followed by many 'a/*' repetitions", () => {
        const code = `/*${'a/*'.repeat(60000)}`; // ~180 KB
        const { value, elapsedMs } = measure(() => parseJavaSource(code));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toBeNull();
    });

    test('many complete block comments followed by a declaration', () => {
        const code = `${'/* x */'.repeat(20000)}public class Real {}`;
        const { value, elapsedMs } = measure(() => parseJavaSource(code));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value).toEqual({ packageName: '', className: 'Real' });
    });
});

describe('comment stripping preserves the old regex semantics', () => {
    test.each([
        ['a/*b*/c', 'a c'],
        ['a/*b*/c/*d*/e', 'a c e'],
        ['a/*b', 'a/*b'], // unterminated: the old regex left it alone
        ['a/**/b', 'a b'],
        ['a/b*c', 'a/b*c'],
    ])('stripBlockComments(%j) -> %j', (input, expected) => {
        expect(stripBlockComments(input)).toBe(expected);
    });

    test.each([
        ['a//b\nc', 'a \nc'],
        ['a//b', 'a '],
        ['a//b\r\nc', 'a \nc'], // [^\n] consumed the CR
        ['a/b/c', 'a/b/c'],
        ['//only', ' '],
    ])('stripLineComments(%j) -> %j', (input, expected) => {
        expect(stripLineComments(input)).toBe(expected);
    });

    test.each([
        // Block comments are stripped before line comments, as before.
        ['/* // class Ghost */ public class Visible {}', 'Visible'],
        ['// /* public class Ghost\npublic class Real {}', 'Real'],
        ['// CRLF comment\r\npublic class Real {}', 'Real'],
        ['/* a * / b */ public class Real {}', 'Real'],
        ['/* outer /* inner */ public class After {}', 'After'],
        ['/* class Ghost', 'Ghost'], // unterminated comment: unchanged, as before
        ['class A {} // class B {}', 'A'],
        ['class/*x*/Name {}', 'Name'],
        ['public class Real {} /* trailing', 'Real'],
    ])('parseJavaSource(%j) finds %s', (source, className) => {
        expect(parseJavaSource(source)).toEqual({ packageName: '', className });
    });

    test('a commented-out package declaration is not used', () => {
        const source = '/* package wrong; */\npackage right;\npublic class Real {}';
        expect(parseJavaSource(source)).toEqual({ packageName: 'right', className: 'Real' });
    });
});
