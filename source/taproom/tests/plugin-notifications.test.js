import { describe, test, expect, beforeEach } from '@jest/globals';

import { notify, listFor, dominantFor, clearFor, clearAll } from '../src/plugin-notifications.js';

/**
 * Plugin notifications — the push half of the panel capability.
 *
 * The rules worth pinning are not "does a Map store a value". They are the four that a future change could
 * plausibly break without any test noticing: notifications must not cross USERS, must not cross CHATS, the
 * MOST RECENT one must win (because that is the only thing standing in for a priority table), and a lock must
 * take the content with it.
 */

const USER_ONE = 'user-one';
const USER_TWO = 'user-two';

beforeEach(() => {
    clearAll();
});

describe('🔔 what a plugin says happened', () => {
    test('a notification comes back for the user it was raised for', () => {
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', data: { count: 1 } });

        const rows = listFor(USER_ONE);

        expect(rows).toHaveLength(1);
        expect(rows[0].action).toBe('memory.added');
        expect(rows[0].data).toEqual({ count: 1 });
    });

    test('🔴 and NOT for anybody else', () => {
        // The whole reason the store is keyed by handle first. A notification's data is plugin-supplied and
        // may quote the user's own words; leaking it sideways is the worst thing this module can do.
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', data: { text: 'user-one-only' } });

        expect(listFor(USER_TWO)).toEqual([]);
    });

    test('the plugin id is the LOADER\'s, not the caller\'s to choose', () => {
        // `id` is the closed-over argument; nothing in the spec can override it. A plugin must not be able to
        // raise a notification wearing another plugin's name and colour.
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', id: 'somebody-else', data: {} });

        expect(listFor(USER_ONE)[0].id).toBe('mnemosyne');
    });

    test('a plugin cannot backdate itself into dominance', () => {
        // `at` decides which notification wins. If a plugin could supply it, it could pin its own colour on
        // the button permanently by claiming the future.
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', at: 9_999_999_999_999 });

        expect(listFor(USER_ONE)[0].at).toBeLessThan(9_999_999_999_999);
    });
});

describe('🎨 which notification the button wears', () => {
    test('🔴 the most recent one wins, which is what gives a plugin precedence for free', () => {
        // The rule that replaces a priority table. Mnemosyne recalls first and writes second, so the write
        // decides the colour — "purple beats green" falls out of ordering, and the fork ranks nothing.
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.recalled', color: 'green' });
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', color: 'purple' });

        expect(dominantFor(USER_ONE).mnemosyne.color).toBe('purple');
        expect(dominantFor(USER_ONE).mnemosyne.action).toBe('memory.added');
    });

    test('and the one it displaced is still readable, so the click-through can show both', () => {
        // Keyed by action, not one slot per plugin: "3 recalled, 1 added" needs both to survive.
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.recalled', data: { count: 3 } });
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', data: { count: 1 } });

        const actions = listFor(USER_ONE).map(one => one.action);

        expect(actions).toContain('memory.recalled');
        expect(actions).toContain('memory.added');
    });

    test('re-raising the same action replaces it rather than piling up', () => {
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.recalled', data: { count: 1 } });
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.recalled', data: { count: 7 } });

        const rows = listFor(USER_ONE).filter(one => one.action === 'memory.recalled');

        expect(rows).toHaveLength(1);
        expect(rows[0].data).toEqual({ count: 7 });
    });

    test('two plugins each get their own dominant notification', () => {
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', color: 'purple' });
        notify('weather', { handle: USER_ONE, action: 'forecast.ready', color: 'blue' });

        const dominant = dominantFor(USER_ONE);

        expect(dominant.mnemosyne.color).toBe('purple');
        expect(dominant.weather.color).toBe('blue');
    });
});

describe('💬 chat scoping — §14.4', () => {
    test('🔴 a notification raised in one chat does not appear in another', () => {
        // The staleness `chatId` was surfaced to fix: a memory written while talking to one character must not
        // light the button in a different conversation.
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', chatId: 'chat-a' });

        expect(listFor(USER_ONE, 'chat-a')).toHaveLength(1);
        expect(listFor(USER_ONE, 'chat-b')).toEqual([]);
    });

    test('but one raised WITHOUT a chat appears in every chat', () => {
        // Something genuinely not about a conversation — a plugin finished warming, a store went read-only —
        // would otherwise be visible in no chat at all, which is the opposite of the intent.
        notify('mnemosyne', { handle: USER_ONE, action: 'plugin.ready' });

        expect(listFor(USER_ONE, 'chat-a')).toHaveLength(1);
        expect(listFor(USER_ONE, 'chat-b')).toHaveLength(1);
    });
});

describe('🔒 locking takes the content with it', () => {
    test('🔴 clearFor drops everything for that user', () => {
        // Called synchronously from storage.lock(). A notification may quote the text of a memory the provider
        // has just made unreadable on disk; leaving it here would put a plaintext copy back within reach.
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', data: { text: 'a secret' } });
        notify('mnemosyne', { handle: USER_TWO, action: 'memory.added', data: { text: 'user-two\'s secret' } });

        clearFor(USER_ONE);

        expect(listFor(USER_ONE)).toEqual([]);
        expect(listFor(USER_TWO)).toHaveLength(1);
    });

    test('CONTROL: the secret really was findable before the lock', () => {
        // Without this, the assertion above passes just as well against a store that never recorded anything.
        notify('mnemosyne', { handle: USER_ONE, action: 'memory.added', data: { text: 'a secret' } });

        expect(JSON.stringify(listFor(USER_ONE))).toContain('a secret');
    });
});

describe('🚨 a bad call fails loudly, at the call site', () => {
    test('throws on no spec at all', () => {
        expect(() => notify('mnemosyne', undefined)).toThrow(TypeError);
    });

    test('throws on an array', () => {
        expect(() => notify('mnemosyne', [])).toThrow(TypeError);
    });

    test('throws on a string', () => {
        expect(() => notify('mnemosyne', 'memory.added')).toThrow(TypeError);
    });

    test('throws without a handle — a notification about nobody reaches nobody', () => {
        expect(() => notify('mnemosyne', { action: 'memory.added' })).toThrow(/handle/);
    });

    test('throws without an action', () => {
        expect(() => notify('mnemosyne', { handle: USER_ONE })).toThrow(/action/);
    });

    test('throws on a non-object data bag', () => {
        expect(() => notify('mnemosyne', { handle: USER_ONE, action: 'x', data: 'not-a-bag' })).toThrow(/data bag/);
    });

    test('names the offending plugin, so the error is actionable', () => {
        expect(() => notify('mnemosyne', { handle: USER_ONE })).toThrow(/mnemosyne/);
    });
});

describe('🧯 a runaway plugin cannot grow the store without bound', () => {
    test('evicts its own oldest action past the cap, and touches no other plugin', () => {
        for (let i = 0; i < 40; i++) {
            notify('noisy', { handle: USER_ONE, action: `action-${i}` });
        }
        notify('quiet', { handle: USER_ONE, action: 'still-here' });

        const noisy = listFor(USER_ONE).filter(one => one.id === 'noisy');
        const quiet = listFor(USER_ONE).filter(one => one.id === 'quiet');

        expect(noisy.length).toBeLessThanOrEqual(32);
        expect(quiet).toHaveLength(1);
    });
});
