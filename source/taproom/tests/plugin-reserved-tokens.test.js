import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';

import {
    clearPromptInterceptors,
    listPromptDeclarations,
    onPrompt,
} from '../src/generation-interceptors.js';

/**
 * 🔴 §17.6 — THE RESERVATION, AND THE MEASURED FAILURE IT REMOVES.
 *
 * A server-side interceptor runs AFTER the client has assembled, budgeted and trimmed the prompt. The client
 * fills to `max_context - amount_gen` and then hands the backend `max_context` — the same number by
 * construction — so ANY interceptor that adds tokens puts the prompt over, and KoboldCpp truncates from the
 * FRONT, which is where a prepended injection sits. Measured 2026-07-30 against GLM-Steam-106B: one prompt
 * sent twice, differing only in `max_context_length`, answered from the displaced text at 48,000 and from the
 * injected block at 49,152.
 *
 * Nothing reports it. The plugin cannot see what the backend then did, so it goes on saying it injected, and
 * the user sees a character with no memory and no error anywhere — the quiet failure §6.5 of
 * DESIGN_MEMORY_PLUGIN_API.md exists to forbid. These tests pin the two halves of the fix: the declaration
 * travelling out to the client, and the client summing it into a number it spends before the trim.
 */
describe('the reservation declaration — the plugin sizes it, the fork spends it', () => {
    beforeEach(() => clearPromptInterceptors());
    afterAll(() => clearPromptInterceptors());

    test('a reservation reaches the client-config, keyed by plugin', () => {
        onPrompt('memory', async () => undefined, { recentMessages: 50, reservesTokens: 550 });

        expect(listPromptDeclarations()).toEqual({ memory: { recentMessages: 50, reservesTokens: 550 } });
    });

    test('🔴 a plugin that declares ONLY a reservation is still reported', () => {
        // The regression this pins: the fold used to skip any interceptor with no `recentMessages`, because a
        // window was the only thing declarable. A plugin that wants room but no history would have been
        // dropped here — reserving nothing, injecting anyway, and landing back on the exact bug above with a
        // declaration that looked honoured.
        onPrompt('injector', async () => undefined, { reservesTokens: 300 });

        expect(listPromptDeclarations()).toEqual({ injector: { reservesTokens: 300 } });
    });

    test('a plugin that declares only a window carries no reservation key', () => {
        onPrompt('reader', async () => undefined, { recentMessages: 10 });

        expect(listPromptDeclarations()).toEqual({ reader: { recentMessages: 10 } });
        expect(listPromptDeclarations().reader).not.toHaveProperty('reservesTokens');
    });

    test('a plugin that declares neither still does not appear at all', () => {
        onPrompt('quiet', async () => undefined);

        expect(listPromptDeclarations()).toEqual({});
    });

    test('🔴 one plugin registering twice SUMS its reservations while MAXING its windows', () => {
        // The asymmetry is the whole design. One payload of turns serves both handlers, so the larger window
        // satisfies both; prompt space is not shared, so two handlers that both inject both need their own
        // room. Taking the max here would leave the second injection overrunning exactly as before.
        onPrompt('memory', async () => undefined, { recentMessages: 5, reservesTokens: 200 });
        onPrompt('memory', async () => undefined, { recentMessages: 40, reservesTokens: 350 });

        expect(listPromptDeclarations()).toEqual({ memory: { recentMessages: 40, reservesTokens: 550 } });
    });

    test('🔴 nonsense is REFUSED at registration, named, and never clamped', () => {
        // Same rule as the window declaration: loud in the plugin's own `init` beats a plugin quietly given a
        // different amount of room than it budgeted for. A silently shrunk reservation is a plugin whose
        // arithmetic is now wrong with no way to find out.
        for (const bad of [0, -1, 2.5, '550', null, 8193]) {
            expect(() => onPrompt('memory', async () => undefined, { reservesTokens: bad })).toThrow(/memory/);
        }

        expect(listPromptDeclarations()).toEqual({});
    });

    test('a refused reservation registers NOTHING, not a handler with the window half-applied', () => {
        // The throw has to happen before the interceptor joins the list, or a plugin whose `init` blew up is
        // still in the chain — running on every generation, holding a window it never successfully asked for.
        expect(() => onPrompt('memory', async () => 'x', { recentMessages: 20, reservesTokens: -5 })).toThrow();

        expect(listPromptDeclarations()).toEqual({});
    });

    test('the ceiling is a boundary, not an approximation', () => {
        onPrompt('greedy', async () => undefined, { reservesTokens: 8192 });

        expect(listPromptDeclarations()).toEqual({ greedy: { reservesTokens: 8192 } });
    });
});

/**
 * The client half: what `getReservedPromptTokens()` returns, which is the number subtracted from the fill
 * target before the history trim. Module-level state, so every case re-imports a fresh copy.
 */
describe('the client accumulator — summed across plugins, fail-safe at zero', () => {
    /**
     * Boot `plugin-client-config.js` against a given `/api/plugins/client-config` response.
     * @param {any} body What the endpoint returns, or an Error to reject the fetch with
     * @returns {Promise<any>} The freshly imported module, already initialized
     */
    async function loadWith(body) {
        jest.resetModules();

        // The module reaches into `script.js` only for request headers. Importing the real one would drag the
        // entire browser application into a node test environment for a function that returns an object.
        jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}) }));

        global.fetch = jest.fn(async () => {
            if (body instanceof Error) {
                throw body;
            }
            return { ok: true, status: 200, statusText: 'OK', json: async () => body };
        });

        const module = await import('../public/scripts/plugin-client-config.js');
        await module.initPluginPrompts();
        return module;
    }

    test('🔴 SUMMED across plugins, where the window is MAXED', () => {
        // Two plugins both injecting both need their own room. Taking the max would size the prompt for the
        // larger one and leave the smaller one's injection to overrun, which is the original bug with an
        // extra step.
        return loadWith({ prompts: { memory: { recentMessages: 50, reservesTokens: 550 }, notes: { recentMessages: 10, reservesTokens: 300 } } })
            .then(module => {
                expect(module.getReservedPromptTokens()).toBe(850);
                expect(module.getRecentMessagesWindow()).toBe(50);
            });
    });

    test('nobody asking reserves nothing', async () => {
        const module = await loadWith({ prompts: { reader: { recentMessages: 20 } } });

        expect(module.getReservedPromptTokens()).toBe(0);
    });

    test('a garbage declaration is ignored rather than coerced', async () => {
        // `Number.isInteger` is the guard, and it has to stay one: `'550'` summed as a string would make the
        // total a string, and the subtraction downstream would silently produce NaN for every plugin at once.
        const module = await loadWith({ prompts: { a: { reservesTokens: '550' }, b: { reservesTokens: -5 }, c: { reservesTokens: 2.5 }, d: { reservesTokens: null }, e: { reservesTokens: 100 } } });

        expect(module.getReservedPromptTokens()).toBe(100);
    });

    test('🔴 an unreachable config endpoint reserves ZERO, which is today behaviour rather than a broken prompt', async () => {
        // Fail-safe direction matters. Reserving on a failed fetch would shrink every prompt on an install
        // with no plugins at all; reserving nothing loses an injection that was already being lost.
        const debug = jest.spyOn(console, 'debug').mockImplementation(() => { });
        const module = await loadWith(new Error('no route'));

        expect(module.getReservedPromptTokens()).toBe(0);
        debug.mockRestore();
    });

    test('read before init, the answer is 0 — never undefined, never a promise', async () => {
        jest.resetModules();
        jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: () => ({}) }));

        const module = await import('../public/scripts/plugin-client-config.js');

        // A generation must never wait on a third party's HTTP route (§14.10), so this is read synchronously
        // and has to be a plain number the moment the module exists.
        expect(module.getReservedPromptTokens()).toBe(0);
    });

    test('a total large enough to squeeze the prompt is named in the console, with the plugins that caused it', async () => {
        // The server refuses any single declaration over 8192 but cannot see the total. Without this line the
        // symptom is a character with no history and nothing anywhere pointing at why.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
        const module = await loadWith({ prompts: { hungry: { reservesTokens: 8000 }, hungrier: { reservesTokens: 8000 } } });

        expect(module.getReservedPromptTokens()).toBe(16000);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('hungry'));
        warn.mockRestore();
    });

    test('a total under the threshold says nothing', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { });
        await loadWith({ prompts: { memory: { reservesTokens: 550 } } });

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
