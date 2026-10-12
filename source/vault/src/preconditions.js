/**
 * The boot precondition check.
 *
 * 🔴 THREE ORDINARY SILLYTAVERN CONFIGURATIONS SILENTLY DESTROY THIS PLUGIN'S ENTIRE SECURITY MODEL.
 *
 * Not by breaking it loudly — by making it look like it is working. The vault gets created, the files go
 * on the disk as ciphertext, everything appears encrypted, and the key is reachable by anyone who walks
 * up to the box. Encryption theatre is worse than no encryption, because you stop worrying.
 *
 * So this runs at boot, and it REFUSES TO START rather than come up compromised.
 *
 * ## The three
 *
 * **1. `enableUserAccounts: false` — and this is SillyTavern's DEFAULT.**
 * There is no login page. `setUserDataMiddleware` short-circuits straight to a default user, and no
 * password is ever asked for or verified. There is no secret, so there is nothing to derive a key from.
 *
 * **2. A user with an EMPTY password. This is the dangerous one, because it looks fine.**
 * `enableUserAccounts` is on, there is a login page, everything seems right — but SillyTavern's
 * `tryAutoLogin` silently logs in a lone user who has no password, and every password check in the
 * codebase is guarded `if (user.password && …)`. An empty password therefore does not mean "check the
 * password against the empty string". It means **NO PASSWORD CHECK HAPPENS AT ALL.**
 *
 * A vault keyed from an empty password is a vault whose key is a published constant. Anyone who reaches
 * the box opens it instantly, and the login page they walk past on the way is decoration.
 *
 * **3. Authelia / proxy `remoteUser` / delegated auth.**
 * Authentication happens somewhere else and SillyTavern never sees a password. It cannot hand us one,
 * because it never had one.
 *
 * ## Why this fails the boot instead of warning
 *
 * Fail before writing data if the configuration cannot enforce the vault's authentication boundary. A warning
 * after startup could leave new files unprotected while the application appears usable.
 */

/**
 * Check that this SillyTavern configuration can actually support an encrypted vault.
 * @param {import('./types.js').StorageProviderContext} context The boot context from SillyTavern
 * @throws {Error} If encryption cannot be honestly provided under this configuration
 * @returns {void}
 */
export function assertUsable(context) {
    const problems = [];

    if (!context.accountsEnabled) {
        problems.push([
            'enableUserAccounts is FALSE (SillyTavern\'s default).',
            'There is no login, so no password is ever entered, so there is no secret to build a key from.',
            'Fix: set `enableUserAccounts: true` in config.yaml and give your account a password.',
        ]);
    }

    if (context.authenticationDelegated) {
        problems.push([
            'Authentication is delegated to a proxy (autheliaAuth / perUserBasicAuth).',
            'SillyTavern never sees your password, so it cannot hand one to the vault.',
            'Fix: turn off delegated authentication, or do not encrypt this install.',
        ]);
    }

    // 🔴 The quiet one. An account with no password is not "an account with a weak password" -- it is an
    // account where SillyTavern skips the password check entirely.
    const passwordless = (context.users ?? []).filter(user => user.enabled && !user.hasPassword);

    if (passwordless.length > 0) {
        problems.push([
            // 🔴 THE COUNT, NOT THE HANDLES — the rule this same file states sixty lines below, at
            // `assertPasswordCanKey`, and then broke here. That comment's reasoning applies with MORE force
            // to this one, not less: an Error's message travels, and this particular Error travels further
            // than any other in the project.
            //
            // It is thrown from `init()`, i.e. from step 2 of the fork's boot chain — and the fork's
            // `unhandledRejection` handler, the thing that would have classified this SENSITIVE, is
            // installed at step 8. The rejection is therefore unhandled, so Node's default path prints the
            // message AND the stack raw to stderr, which systemd records in the journal, in the clear,
            // permanently. No log classification, no `debugMode` gate, no seam. It is the one message in the
            // codebase guaranteed to bypass `logging.js` entirely.
            //
            // The operator does not need the names to act: the fix is "find the accounts with no password",
            // and SillyTavern's own admin UI lists them. What they need is to know HOW MANY, so they can
            // tell whether they have fixed all of them.
            `${passwordless.length} enabled account(s) have NO PASSWORD.`,
            'SillyTavern does not check an empty password -- it skips the check. `tryAutoLogin` will log a',
            'lone passwordless user straight in. A vault keyed from an empty password has a key that is a',
            'published constant, and the login page is decoration.',
            'Fix: give every enabled account a real password, or disable the accounts you are not using.',
        ]);
    }

    if (problems.length === 0) {
        return;
    }

    const report = problems.map(lines => `  * ${lines.join('\n    ')}`).join('\n\n');

    throw new Error(
        'REFUSING TO START. This SillyTavern configuration cannot support encryption at rest, and coming up\n' +
        'anyway would look encrypted while being trivially openable by anyone who reaches this machine.\n\n' +
        `${report}\n\n` +
        'Nothing has been written and nothing has been changed. Fix the above and start again.',
    );
}

/**
 * 🔴 A PASSWORD THAT WILL WRAP THE DEK MAY NOT BE EMPTY — the same rule the boot check makes, at the one
 * moment the boot check cannot cover.
 *
 * ## Why both, and why this is not belt-and-braces
 *
 * `assertUsable` above reads `context.users`, which is a SNAPSHOT taken at boot. Accounts are created and
 * passwords are changed long after that, so the boot refusal cannot be the only enforcement — it can only
 * refuse a configuration that was already broken when the process started.
 *
 * ## What it replaced, and why that mattered
 *
 * Three call sites enforced this independently, with three different sentences:
 *
 *     unlock()    "Refusing to open a vault for 'X' with an empty password."
 *     rekey()     "Refusing to re-wrap 'X' under an empty password: SillyTavern does not check empty…"
 *     recover()   "A new password is required."
 *
 * The third is the problem. The fork shows an Error's `message` to the user verbatim, so that sentence was
 * the whole of what somebody recovering a locked-out account was told — it states a requirement and not
 * one word of the reason, which is the difference between a rule that sounds arbitrary and one that
 * sounds like a warning. Three copies of a rule are three chances for one of them to say less than the
 * others, and that is exactly what had happened.
 *
 * ⚠️ **THE HANDLE IS DELIBERATELY NOT IN THE MESSAGE.** Two of the three used to interpolate it. The user
 * reading this knows their own handle, so it adds nothing to them — and an Error's message travels: into
 * the fork's logs, into a bug report, into a screenshot. `logging.js` calls a handle user-authored and
 * keeps it off the published channel; an error string should not be the way it gets out anyway.
 *
 * ⚠️ **NOT the rule `regenerateRecoveryKey` enforces.** That one demands the CURRENT password as proof of
 * identity — "an unlocked vault proves the vault is open, not who opened it" — which is a different
 * question with a different answer, and it keeps its own message.
 * @param {string|null|undefined} password The password about to be used to wrap or unwrap the DEK
 * @param {string} subject What the password IS, phrased to complete "… cannot be empty."
 * @returns {void}
 */
export function assertPasswordCanKey(password, subject) {
    if (password) {
        return;
    }

    throw new Error(
        `${subject} cannot be empty. SillyTavern does not CHECK an empty password -- every check in it is `
        + 'guarded `if (user.password && ...)`, so an empty one skips the check entirely rather than being '
        + 'compared against nothing. A vault keyed from it would have a key that is a published constant, '
        + 'and anyone who reached the file could open every chat in the account.',
    );
}
