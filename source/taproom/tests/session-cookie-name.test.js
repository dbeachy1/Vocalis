import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';

// `users.js` pulls in a chain that reads the config at module scope and `process.exit(1)`s without one,
// so it cannot be imported statically — a static import is hoisted above `beforeAll` and the module would
// exit while Jest was still collecting this file. Same reason as storage-provider-image-metadata.test.js.
/** @type {typeof import('../src/users.js')} */
let users;

/**
 * 🔴 TWO INSTANCES ON ONE HOST MUST NOT SHARE A SESSION COOKIE.
 *
 * Cookies are scoped to a HOST, not an origin: the browser's jar does not distinguish
 * `https://test-host.invalid:8000` from `https://test-host.invalid:8001`. Every other part of the stack treats those as separate
 * servers, and each one signs its session with its own secret — `cookie-secret.txt` lives under each
 * instance's own data root.
 *
 * So while the cookie NAME was derived from the hostname alone, the two collided. Logging into the second
 * instance overwrote the first one's cookie; the first then received a cookie it could not verify and
 * answered **403 on `/api/users/login`**, with nothing in the UI to explain it. Logging back into the
 * first bounced the user out of the second — in both directions, for ever.
 *
 * Found on a live pair on 2026-07-19, after a deployment whose entire gate was "two SillyTaverns that do
 * not disturb each other". Filesystem independence had been verified six ways: separate inodes, no
 * home-derived paths, zero shared file descriptors. The browser's cookie jar is a shared namespace that
 * no amount of `dataRoot` separation reaches, and it was missed.
 */
describe('session cookie name', () => {
    beforeAll(async () => {
        const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
        setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));
        users = await import('../src/users.js');
    });

    test('two ports on the same host get different cookie names', () => {
        // The exact pair from the deployment that surfaced this.
        expect(users.getCookieSessionName(8000)).not.toBe(users.getCookieSessionName(8001));
    });

    test('the same port is stable across calls, or every restart logs everyone out', () => {
        expect(users.getCookieSessionName(8000)).toBe(users.getCookieSessionName(8000));
    });

    test('a numeric port and its string form agree, because config and CLI disagree about the type', () => {
        expect(users.getCookieSessionName(8000)).toBe(users.getCookieSessionName('8000'));
    });

    test('the name is a session- prefix and a short hex suffix, and carries no port in the clear', () => {
        const name = users.getCookieSessionName(8001);

        expect(name).toMatch(/^session-[0-9a-f]{8}$/);
        // A cookie NAME is readable by anything that can see the request. It should not advertise the
        // topology of the box back to the client.
        expect(name).not.toContain('8001');
        expect(name).not.toContain(os.hostname());
    });

    test('omitting the port still yields a valid name, for callers with no listening server', () => {
        expect(users.getCookieSessionName()).toMatch(/^session-[0-9a-f]{8}$/);
    });

    test('🔴 omitting the port is NOT a substitute for passing it — that is the collision', () => {
        // Documents the remaining sharp edge: two servers that both omit the port collide exactly as
        // before. The fix is at the call site in server-main.js, which passes cliArgs.port.
        expect(users.getCookieSessionName()).toBe(users.getCookieSessionName());
        expect(users.getCookieSessionName()).not.toBe(users.getCookieSessionName(8000));
    });
});
