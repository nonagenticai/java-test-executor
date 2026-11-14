/**
 * The `code` field's contract on /execute and /validate.
 *
 * Two defects motivated this file, and every test here was run against the pre-fix
 * service to confirm it fails there:
 *
 *   1. /execute ACCEPTED a request carrying only `code` (the required-field check listed
 *      it), but only `mainFiles` and `testFiles` were ever written to disk. A code-only
 *      request therefore scaffolded an EMPTY Maven project and reported "0 tests" —
 *      a success-shaped answer to a suite that never existed.
 *   2. `code.trim()` was called untyped on both endpoints, so an object `code` returned
 *      HTTP 500 with `code.trim is not a function` instead of a 400 naming the field.
 *
 * The disk assertions read the project directory from inside the mocked `exec`, because
 * the handler removes it before responding.
 */

const fsSync = require('fs');
const path = require('path');
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
const { app, parseJavaSource } = require('../../src/java_test_service');

/** Every file the handler had written by the time it shelled out, path -> contents. */
let filesAtCompileTime;

function snapshot(dir, prefix = '') {
    const out = {};
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            Object.assign(out, snapshot(path.join(dir, entry.name), rel));
        } else {
            out[rel] = fsSync.readFileSync(path.join(dir, entry.name), 'utf8');
        }
    }
    return out;
}

beforeEach(() => {
    filesAtCompileTime = null;
    exec.mockReset();
    exec.mockImplementation((cmd, opts, callback) => {
        if (!filesAtCompileTime && opts && opts.cwd && fsSync.existsSync(opts.cwd)) {
            filesAtCompileTime = snapshot(opts.cwd);
        }
        callback(null, 'OK', '');
        return { on: jest.fn(), killed: false, kill: jest.fn() };
    });
});

describe('POST /execute — `code` reaches the disk', () => {
    const CALCULATOR_TEST = [
        'import org.junit.jupiter.api.Test;',
        'import static org.junit.jupiter.api.Assertions.assertEquals;',
        '',
        'public class CalculatorTest {',
        '    @Test',
        '    void addsTwoNumbers() { assertEquals(4, 2 + 2); }',
        '}',
        ''
    ].join('\n');

    test('a code-only request writes the source as a test class', async () => {
        const res = await request(app).post('/execute').send({ code: CALCULATOR_TEST });

        expect(res.status).toBe(200);
        expect(filesAtCompileTime).not.toBeNull();
        expect(filesAtCompileTime['src/test/java/CalculatorTest.java']).toBe(CALCULATOR_TEST);
    });

    test('a package declaration determines the directory', async () => {
        const packaged = `package com.example.math;\n\n${CALCULATOR_TEST}`;

        const res = await request(app).post('/execute').send({ code: packaged });

        expect(res.status).toBe(200);
        expect(Object.keys(filesAtCompileTime)).toContain(
            'src/test/java/com/example/math/CalculatorTest.java'
        );
    });

    test('an explicit testFiles entry at the same path wins over code', async () => {
        const explicit = '// the explicit one\npublic class CalculatorTest {}\n';

        await request(app).post('/execute').send({
            code: CALCULATOR_TEST,
            testFiles: { 'CalculatorTest.java': explicit }
        });

        expect(filesAtCompileTime['src/test/java/CalculatorTest.java']).toBe(explicit);
    });

    test('a typeless code alongside explicit files still runs, and is not written', async () => {
        // A decorative `code` next to real sources is a legitimate pre-existing shape.
        // It must not 400 — but it must not be silently pretended-compiled either; the
        // service logs that it was dropped.
        const res = await request(app).post('/execute').send({
            code: 'invalid java',
            mainFiles: { 'Bad.java': 'public class Bad {}' },
            testFiles: { 'BadTest.java': 'public class BadTest {}' }
        });

        expect(res.status).toBe(200);
        expect(Object.keys(filesAtCompileTime).sort()).toEqual([
            'pom.xml',
            'src/main/java/Bad.java',
            'src/test/java/BadTest.java'
        ]);
    });

    test('code that declares no type is a 400, not an empty project', async () => {
        const res = await request(app).post('/execute').send({
            code: 'int x = 1;'
        });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/declare a class/i);
    });
});

describe('POST /execute — type contract', () => {
    test('an object `code` is a 400 naming the field, not a 500', async () => {
        const res = await request(app).post('/execute').send({
            code: { source: 'public class T {}' }
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('code must be a string');
        expect(res.body.error).toContain('object');
    });

    test('an array `code` is a 400 naming the field', async () => {
        const res = await request(app).post('/execute').send({
            code: ['public class T {}']
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('code must be a string');
    });

    test('a non-string testFiles value is a 400, not a writeFile crash', async () => {
        const res = await request(app).post('/execute').send({
            testFiles: { 'T.java': { source: 'public class T {}' } }
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('testFiles["T.java"]');
    });

    test('a traversing mainFiles path is rejected', async () => {
        const res = await request(app).post('/execute').send({
            mainFiles: { '../../../etc/passwd': 'x' }
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/unsafe file path/);
    });
});

describe('POST /execute — the fast path stays a sentinel', () => {
    test("'// test' is still fast-pathed", async () => {
        const res = await request(app).post('/execute').send({ code: '// test' });

        expect(res.status).toBe(200);
        expect(res.body.output).toContain('Fast-path');
    });

    test('a small real `public class Test` payload is NOT fast-pathed', async () => {
        // The dead `!testFiles` clause would have matched this had it been "repaired"
        // rather than deleted — returning success:true / tests:0 for a suite that ran.
        const res = await request(app).post('/execute').send({
            code: 'public class Test { @org.junit.jupiter.api.Test void t() {} }'
        });

        expect(res.status).toBe(200);
        expect(String(res.body.output || '')).not.toContain('Fast-path');
        // The suite really ran: the source hit the disk and the build was shelled out.
        expect(filesAtCompileTime['src/test/java/Test.java']).toBeDefined();
        expect(exec).toHaveBeenCalled();
    });
});

describe('POST /validate — type contract', () => {
    test('an object `code` is a 400, not a 500', async () => {
        const res = await request(app).post('/validate').send({
            code: { source: 'public class T {}' }
        });

        expect(res.status).toBe(400);
        expect(res.body.valid).toBe(false);
        expect(res.body.errors[0]).toContain('code must be a string');
    });

    test('a traversing className is rejected before it reaches path.join', async () => {
        const res = await request(app).post('/validate').send({
            code: 'public class T {}',
            className: '../../../../tmp/pwned'
        });

        expect(res.status).toBe(400);
        expect(res.body.errors[0]).toContain('valid Java identifier');
        expect(exec).not.toHaveBeenCalled();
    });
});

describe('parseJavaSource', () => {
    test.each([
        ['public class Foo {}', '', 'Foo'],
        ['package a.b;\npublic final class Foo {}', 'a.b', 'Foo'],
        ['interface Bar {}', '', 'Bar'],
        ['enum Baz { A }', '', 'Baz'],
        ['public record Qux(int a) {}', '', 'Qux'],
    ])('parses %s', (src, pkg, cls) => {
        expect(parseJavaSource(src)).toEqual({ packageName: pkg, className: cls });
    });

    test('ignores a type name that only appears in a comment', () => {
        expect(parseJavaSource('// class Ghost\n/* class Phantom */\nint x;')).toBeNull();
    });

    test('returns null when nothing is declared', () => {
        expect(parseJavaSource('int x = 1;')).toBeNull();
    });
});
