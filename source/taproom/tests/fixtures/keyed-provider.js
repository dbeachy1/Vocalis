import fs from 'node:fs';
import path from 'node:path';

import { EUNAVAILABLE, StorageError } from '../../src/storage.js';

/**
 * 🔑 THE KEYED PROVIDER.
 *
 * The hostile provider models a BROKEN vault. The locked provider models a CLOSED one. This one models a
 * vault WITH A KEY IN IT — and it exists to make one specific catastrophe observable.
 *
 * ## What it is modelling
 *
 * A real provider stores the data key (DEK) only in WRAPPED form, on disk, in something like
 * `.vault-keys.json`. There are two wraps of the same DEK:
 *
 *     wrap_password  — openable with the user's password
 *     wrap_recovery  — openable with a recovery key they wrote down and put somewhere else
 *
 * The DEK itself lives in RAM and nowhere else. That gives the property the whole project rests on: the
 * wraps survive a restart, and the DEK does not.
 *
 * And it gives the failure mode this fixture exists to expose. **If the password changes without anyone
 * re-wrapping, `wrap_password` is left sealed under a password that no longer exists.** The DEK is not
 * leaked. It is simply gone — unreachable, forever, by anyone, including the owner. Every chat stays on
 * the disk in perfect condition and nothing in the universe can ever read it again.
 *
 * That is not a security hole. It is worse. A security hole loses you privacy; this loses you the data.
 *
 * ## What is NOT modelled — read this before you trust it
 *
 * ⛔ THERE IS NO CRYPTOGRAPHY HERE, AND THERE MUST NEVER BE. This is the fork's test suite and the fork
 * contains no crypto, by rule.
 *
 * A "wrap" here is a map entry from the literal secret to the literal DEK, written to a JSON file in the
 * clear. As confidentiality that is worth exactly nothing, and it is not pretending otherwise. What it
 * reproduces faithfully is the STATE MACHINE — which secrets can reach the DEK, which cannot, what
 * survives a restart, and what a password change does to all of it. That state machine is what the guard
 * in `storage.js` is guarding, and it is what these tests are about.
 */

/** @type {string} */
let dataRoot = '';

/** Where the wraps live between restarts. The real thing is `.vault-keys.json`. */
const statePath = process.env.ST_KEYED_STATE ?? '';

/** The DEK, once something has unwrapped it. 🔑 IN RAM ONLY. A restart loses this, exactly as intended. */
const inMemoryDeks = new Map();

/**
 * 🔑 A recovery secret that has been minted and NOT YET SHOWN TO ANYBODY.
 *
 * RAM only, like the real thing, and for the same reason: a recovery secret written to the disk beside the
 * data is just a second copy of the key. So it exists here, and — if SillyTavern does its job — on a piece
 * of paper. Nowhere else.
 *
 * Which is the whole point of the routes under test. If nobody shows it to the user, this Map is the ONLY
 * copy, the process exits, and the account silently loses its only way back in from a forgotten password.
 */
const pendingSecrets = new Map();

/**
 * Has the user said they wrote their recovery secret down?
 *
 * Persisted beside the wraps, because it has to survive a restart: a flag that resets on every boot would
 * make the provider mint a new secret every time, silently invalidating the one already in the user's safe.
 * @param {string} handle The handle
 * @returns {boolean} True if acknowledged
 */
function isAcknowledged(handle) {
    return readVaults()._acknowledged?.[handle] === true;
}

/**
 * Read the wraps off the disk.
 * @returns {Record<string, Record<string, string>>} handle -> { secret -> dek }
 */
function readVaults() {
    if (!statePath || !fs.existsSync(statePath)) {
        return {};
    }

    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

/**
 * Write the wraps back.
 * @param {Record<string, Record<string, string>>} vaults The wraps
 * @returns {void}
 */
function writeVaults(vaults) {
    fs.writeFileSync(statePath, JSON.stringify(vaults, null, 2), 'utf-8');
}

/**
 * Which user owns this path?
 * @param {string} absPath Absolute path
 * @returns {string|null} The handle, or null if this is not user data
 */
function handleOf(absPath) {
    const relative = path.relative(dataRoot, path.resolve(absPath));

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }

    const handle = relative.split(path.sep)[0];
    return handle && !handle.startsWith('_') && !handle.includes('.') ? handle : null;
}

/**
 * Is this path's owner unlocked?
 * @param {string} p The path
 * @returns {boolean} True if it can be served
 */
function available(p) {
    const handle = handleOf(p);
    return !!handle && inMemoryDeks.has(handle);
}

/**
 * Refuse: the DEK is not in hand.
 * @param {string} p The path
 * @returns {never} Always throws
 */
function refuse(p) {
    throw new StorageError(EUNAVAILABLE, `Storage for '${p}' is locked.`, p);
}

/**
 * Build the keyed provider.
 * @returns {import('../../src/storage.js').StorageProvider} The provider
 */
export default function createKeyedProvider() {
    return {
        id: 'keyed-provider',

        owns(absPath) {
            return handleOf(absPath) !== null;
        },

        // 🔑 The question `storage.js` asks before it lets anyone reset a password: is there a key here
        // that is derived from that password? If yes, resetting it blindly destroys the data.
        ownsUser(handle) {
            return Object.hasOwn(readVaults(), handle);
        },

        // 🔒 THE IDLE-LOCK POLICY IS THE PROVIDER'S, AND THIS FIXTURE IS WHERE THE FORK'S TESTS PROVE IT.
        //
        // The fork used to own this number — thirty minutes, in its own config.yaml — which meant a stock
        // SillyTavern grew a security control nobody had asked for, and no provider could change it. Now the
        // provider states its requirement and SillyTavern obeys. Absent or 0 means NEVER idle-lock, and that
        // is the default for a fork with no provider installed.
        idleLockMs: Number(process.env.ST_KEYED_IDLE_LOCK_MS ?? 0),

        // 🔑 EVERY SENTENCE THE USER READS ABOUT WHAT THIS PROVIDER IS. The fork hard-coded these once —
        // "this account's data is encrypted", in a public, generic fork that is not supposed to know what a
        // provider does. A provider that returns null from here gets SillyTavern's own stock text, byte for
        // byte, which is exactly what a fork with no provider installed must show.
        //
        // ⚠️ ST_KEYED_SILENT models the provider that implements NOTHING optional: no `describe`, no
        // `recover`. It is not a curiosity — it is the case that proves the fork's defaults are honest.
        // A fork that only works when the provider is chatty has simply moved its hard-coded strings into
        // a fallback branch nobody tests.
        ...(process.env.ST_KEYED_SILENT ? {} : {
            describe(situation) {
                switch (situation) {
                    case 'password.change':
                        return {
                            title: 'FIXTURE change password',
                            body: 'FIXTURE: prove you know the current one.',
                            submitLabel: 'FIXTURE submit',
                            fields: [
                                { name: 'current', label: 'FIXTURE current', required: true },
                                { name: 'password', label: 'FIXTURE new', required: true },
                                { name: 'confirm', label: 'FIXTURE confirm', required: true },
                            ],
                        };
                    case 'password.recover':
                        return { title: 'FIXTURE cannot reset', body: 'FIXTURE: use the recovery key.', notes: ['FIXTURE note.'] };
                    case 'recovery.secret':
                        return { title: 'FIXTURE save this', body: 'FIXTURE: the only way back in.' };
                    case 'idle.warning':
                        return { title: 'FIXTURE locking', body: 'FIXTURE: you have been idle.' };
                    case 'recovery.regenerate':
                        return { title: 'FIXTURE new key', body: 'FIXTURE: type your password.' };
                    // The login badge. Returns a title and notes as well as a body, so the test can prove the
                    // fork drops everything except `body` before handing it to an anonymous caller.
                    case 'storage.badge':
                        return { title: 'FIXTURE title', body: 'FIXTURE storage is protected.', notes: ['FIXTURE note.'] };
                    // The header marker — deliberately DIFFERENT text from the badge, so a test can prove the
                    // fork asks the two situations separately instead of reusing one answer in both places.
                    case 'storage.marker':
                        return { body: 'FIXTURE-MARKER' };
                    default:
                        return null;
                }
            },

            // 🔑 A NEW RECOVERY SECRET ON DEMAND — AND IT DEMANDS THE PASSWORD.
            //
            // The DEK is in RAM the whole time the user is signed in, so this could simply mint from the
            // open session. That version is a one-click key-theft button: anyone who reaches a live session
            // walks away with a secret that opens the account FOR EVER, outliving the logout, the restart
            // and the idle lock. The fixture models the demand so the FORK is forced to carry the password
            // across — if it did not, no provider could ever enforce this.
            //
            // An unlocked vault proves the vault is open. It does not prove who opened it.
            async regenerateRecoverySecret(handle, secret) {
                const vaults = readVaults();
                const vault = vaults[handle];
                const dek = vault?.[`pw:${secret}`];

                if (!dek) {
                    throw new StorageError(EUNAVAILABLE, 'Enter your current password. Being signed in is not knowing it.');
                }

                // One recovery wrap, always. Minting overwrites it, so the old secret dies here.
                for (const key of Object.keys(vault)) {
                    if (key.startsWith('rk:')) {
                        delete vault[key];
                    }
                }

                const fresh = `FIXTURE-REGENERATED-${Object.keys(vault).length}-${handle}`;
                vault[`rk:${fresh}`] = dek;
                vaults._acknowledged = { ...(vaults._acknowledged ?? {}), [handle]: false };
                writeVaults(vaults);

                pendingSecrets.set(handle, fresh);
            },
        }),

        async init(ctx) {
            dataRoot = path.resolve(ctx.dataRoot);

            // First boot: create the vault. Two wraps of one DEK — one for the password, one for the
            // recovery key. The DEK is generated here and never appears anywhere else.
            const vaults = readVaults();
            const handle = process.env.ST_KEYED_HANDLE ?? 'default-user';

            if (!vaults[handle]) {
                const dek = `dek-${Math.random().toString(36).slice(2)}`;

                vaults[handle] = {
                    [`pw:${process.env.ST_KEYED_PASSWORD}`]: dek,
                    [`rk:${process.env.ST_KEYED_RECOVERY_KEY}`]: dek,
                };
                writeVaults(vaults);
            }
        },

        isReady(handle) {
            return inMemoryDeks.has(handle);
        },

        async unlock(handle, presented) {
            const dek = readVaults()[handle]?.[`pw:${presented}`];

            if (!dek) {
                throw new StorageError(EUNAVAILABLE, 'Wrong password. The vault stays shut.');
            }

            inMemoryDeks.set(handle, dek);

            // 🔑 KEEP OFFERING IT UNTIL THEY SAY THEY HAVE IT. A recovery secret that was minted and never
            // read is worse than none: the account has a recovery wrap whose secret does not exist, and
            // nothing says so. Minting needs only the DEK, and the DEK is right here — so if the user has
            // never acknowledged one, mint another and ask again.
            if (!isAcknowledged(handle)) {
                pendingSecrets.set(handle, process.env.ST_KEYED_RECOVERY_KEY ?? '');
            }
        },

        lock(handle) {
            inMemoryDeks.delete(handle);

            // An unshown secret belonging to a shut vault has no business in this process's memory.
            pendingSecrets.delete(handle);
        },

        // 🔑 PEEK, NOT TAKE. Asking must not consume it — a destructive read would mean a page refresh at
        // the wrong moment silently threw away the only copy in existence.
        pendingRecoverySecret(handle) {
            return pendingSecrets.get(handle) ?? null;
        },

        // 🔑 The user's own word, and the only thing that stops the offer. "We rendered it" is not evidence
        // that a human wrote it down.
        acknowledgeRecoverySecret(handle) {
            pendingSecrets.delete(handle);

            const vaults = readVaults();
            vaults._acknowledged = { ...(vaults._acknowledged ?? {}), [handle]: true };
            writeVaults(vaults);
        },

        // 🔑 RE-WRAP, OR REFUSE. There is no third option.
        //
        // 🔴 AND THE OLD SECRET IS ALWAYS REQUIRED -- even when the vault is standing open.
        //
        // This fixture used to accept the in-RAM key as a substitute (`inMemoryDeks.get(handle) ?? ...`),
        // exactly as the real plugin did, and that is how BOTH of them hid the same hole for weeks. A
        // provider is entitled to demand the old secret before it re-wraps its key, and this one does --
        // which is the point of modelling it here.
        //
        // What that pins down in the FORK is a CAPABILITY, not a policy: SillyTavern must always give the
        // user somewhere to type their current password and must always pass it through, or a provider that
        // demands it can never be satisfied and the password can never be changed at all. Upstream hides the
        // field from admins, so `oldSecret` arrived as '' and no provider could enforce anything. This
        // fixture is what makes that failure visible.
        async rekey(handle, oldSecret, newSecret) {
            const vaults = readVaults();
            const vault = vaults[handle];

            if (!vault) {
                return;
            }

            const dek = vault[`pw:${oldSecret}`];

            if (!dek) {
                throw new StorageError(EUNAVAILABLE, 'Enter your current password to change it. Being signed in proves the vault is open, not who opened it.');
            }

            for (const key of Object.keys(vault)) {
                if (key.startsWith('pw:')) {
                    delete vault[key];
                }
            }

            vault[`pw:${newSecret}`] = dek;
            writeVaults(vaults);
        },

        // 🔑 THE SECOND DOOR. The recovery key reaches the same DEK by the other wrap, so the data is
        // untouched: it re-wraps under the new password and opens the vault. One action, both halves.
        //
        // ⚠️ `recover` is OPTIONAL in the API, and ST_KEYED_SILENT drops it — which models the provider that
        // owns a user and has NO way back in at all. The fork must then tell the user the truth instead of
        // sending them to a recovery-key box they can never fill. `canRecover()` is the question it must
        // ask; hard-coding `recoveryKeyRequired: true` is the bug this models.
        ...(process.env.ST_KEYED_SILENT ? {} : { recover: async function recover(handle, recoverySecret, newSecret) {
            const vaults = readVaults();
            const vault = vaults[handle];
            const dek = vault?.[`rk:${recoverySecret}`];

            if (!dek) {
                throw new StorageError(EUNAVAILABLE, 'Wrong recovery key.');
            }

            for (const key of Object.keys(vault)) {
                if (key.startsWith('pw:')) {
                    delete vault[key];
                }
            }

            vault[`pw:${newSecret}`] = dek;
            writeVaults(vaults);

            // Possession of the recovery key is proof. They are in.
            inMemoryDeks.set(handle, dek);
        } }),

        // ---- reads: only with the DEK in hand ---------------------------------------------------
        async readFile(p, opts) {
            if (!available(p)) return refuse(p);
            return await fs.promises.readFile(p, opts);
        },
        readFileSync(p, opts) {
            if (!available(p)) return refuse(p);
            return fs.readFileSync(p, opts);
        },
        createReadStream(p, opts) {
            if (!available(p)) return refuse(p);
            return fs.createReadStream(p, opts);
        },
        async sendFile(res, p) {
            if (!available(p)) return refuse(p);
            return await new Promise((resolve, reject) => {
                res.sendFile(path.resolve(p), {}, (error) => error ? reject(error) : resolve());
            });
        },

        exists(p) {
            return fs.existsSync(p);
        },
        stat(p) {
            return fs.statSync(p);
        },
        readdir(p, opts) {
            if (!available(p)) return refuse(p);
            return fs.readdirSync(p, opts);
        },

        // ---- writes: only with the DEK in hand --------------------------------------------------
        async writeFile(p, data, opts) {
            if (!available(p)) return refuse(p);
            return await fs.promises.writeFile(p, data, opts);
        },
        writeFileSync(p, data, opts) {
            if (!available(p)) return refuse(p);
            return fs.writeFileSync(p, data, opts);
        },
        createWriteStream(p) {
            if (!available(p)) return refuse(p);
            return fs.createWriteStream(p);
        },
        unlink(p) {
            if (!available(p)) return refuse(p);
            return fs.unlinkSync(p);
        },
        rename(from, to) {
            if (!available(from)) return refuse(from);
            return fs.renameSync(from, to);
        },
        copyFile(from, to) {
            if (!available(from)) return refuse(from);
            return fs.copyFileSync(from, to);
        },
        cp(from, to, opts) {
            if (!available(to)) return refuse(to);
            return fs.cpSync(from, to, opts);
        },
        rm(p, opts) {
            if (!available(p)) return refuse(p);
            return fs.rmSync(p, opts);
        },
        mkdir(p, opts) {
            return fs.mkdirSync(p, opts);
        },
    };
}
