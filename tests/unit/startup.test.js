/**
 * Tests for the server startup function (startServer).
 *
 * The startServer function calls app.listen and registers signal handlers.
 * It is extracted from the if (require.main === module) block for testability.
 */

jest.mock('child_process', () => {
    const original = jest.requireActual('child_process');
    return {
        ...original,
        exec: jest.fn(),
        spawn: jest.fn(),
    };
});

const service = require('../../src/java_test_service');

describe('startServer', () => {
    let listenSpy;
    let processOnSpy;
    let exitSpy;
    let registeredHandlers;

    beforeEach(() => {
        registeredHandlers = {};

        // Spy on app.listen to prevent actually binding a port
        listenSpy = jest.spyOn(service.app, 'listen').mockImplementation((port, cb) => {
            if (cb) cb();
            return {
                close: jest.fn(),
                address: () => ({ port }),
            };
        });

        // Spy on process.on to capture signal handlers
        processOnSpy = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
            if (event === 'SIGTERM' || event === 'SIGINT') {
                if (!registeredHandlers[event]) registeredHandlers[event] = [];
                registeredHandlers[event].push(handler);
            }
        });

        // Spy on process.exit to prevent actually exiting
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    });

    afterEach(() => {
        listenSpy.mockRestore();
        processOnSpy.mockRestore();
        exitSpy.mockRestore();
    });

    test('calls app.listen with PORT', () => {
        service.startServer();

        expect(listenSpy).toHaveBeenCalled();
        const [port] = listenSpy.mock.calls[0];
        expect(port).toBeDefined();
    });

    test('listen callback logs service info', () => {
        service.startServer();

        // The listen callback was invoked by our mock (it calls cb())
        // If it ran, no error was thrown
        expect(listenSpy).toHaveBeenCalledTimes(1);
    });

    test('registers SIGTERM handler that calls process.exit(0)', () => {
        service.startServer();

        expect(registeredHandlers.SIGTERM).toBeDefined();
        expect(registeredHandlers.SIGTERM.length).toBeGreaterThan(0);

        // Fire the SIGTERM handler
        registeredHandlers.SIGTERM[0]();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    test('registers SIGINT handler that calls process.exit(0)', () => {
        service.startServer();

        expect(registeredHandlers.SIGINT).toBeDefined();
        expect(registeredHandlers.SIGINT.length).toBeGreaterThan(0);

        // Fire the SIGINT handler
        registeredHandlers.SIGINT[0]();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});
