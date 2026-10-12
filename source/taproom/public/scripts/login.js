import { initAccessibility } from './a11y.js';

/**
 * CRSF token for requests.
 */
let csrfToken = '';
let discreetLogin = false;

/**
 * Gets a CSRF token from the server.
 * @returns {Promise<string>} CSRF token
 */
async function getCsrfToken() {
    const response = await fetch('/csrf-token');
    const data = await response.json();
    return data.token;
}

/**
 * Gets a list of users from the server.
 * @returns {Promise<object>} List of users
 */
async function getUserList() {
    const response = await fetch('/api/users/list', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return displayError(errorData.error || 'An error occurred');
    }

    if (response.status === 204) {
        discreetLogin = true;
        return [];
    }

    const userListObj = await response.json();
    console.log(userListObj);
    return userListObj;
}

/**
 * Draw the standing storage badge, if this server has a provider and that provider had something to say.
 *
 * 🔴 EVERY WORD COMES FROM THE SERVER. There is no string here and there must never be one. SillyTavern
 * does not know whether a provider encrypts, compresses or forwards the bytes, so it has nothing of its own
 * to say about them — the same rule the recovery screens follow. A provider that returns no text gets no
 * badge, not a stock sentence.
 *
 * ⚠️ SILENT ON FAILURE, AND SILENT WHEN OFF. Four outcomes collapse to "show nothing": no provider, a
 * provider with nothing to say, an older fork with no such endpoint, and a request that failed. All four
 * are correct — the badge is a claim about the server, and a claim we could not verify must not be made.
 * That is also why it is fire-and-forget: an install that has never heard of storage providers must render
 * this page at exactly its usual speed.
 *
 * `.text()` rather than `.html()`: the provider's words are data, and a provider is not entitled to inject
 * markup into the login page.
 * @returns {Promise<void>}
 */
async function showStorageIndicator() {
    try {
        const response = await fetch('/api/storage/status');

        if (!response.ok) {
            return;
        }

        const status = await response.json();

        if (status?.enabled !== true || !status?.badge) {
            return;
        }

        $('#storageIndicatorText').text(String(status.badge));
        $('#storageIndicator').css('display', '');
    } catch {
        // An install without the endpoint is not an error worth showing somebody trying to log in.
    }
}

/**
 * 🔑 Which way back in are we offering?
 *
 * 'code' — SillyTavern's own reset: the server prints a code to its console, and that code buys a new
 *          password. This is the only mode that exists with no storage provider installed.
 *
 * 'key'  — the account's storage is held by a provider that refused the blind reset, and offered a
 *          recovery secret as the way in instead. WHY it refused is the provider's business, and it says
 *          so in its own words: everything the user reads in this mode comes from the server.
 * @type {'code'|'key'}
 */
let recoveryMode = 'code';

/**
 * SillyTavern's own console-code wording, kept so Cancel can put it back.
 *
 * Read LAZILY, not at module load: this file is a module, and reaching into the DOM before it is parsed
 * would quietly capture an empty string — after which cancelling out of recovery would blank the message
 * and nothing would look broken enough to notice.
 * @type {string}
 */
let recoveryCodeMessage = '';

/**
 * Switch the recovery block over to asking for the provider's recovery secret.
 *
 * 🔴 EVERY WORD HERE COMES FROM THE PROVIDER. SillyTavern does not know why this account cannot simply be
 * reset — it knows only that the server said so — so it does not get to explain it. If the provider offers
 * no wording, the stock message stays exactly as it is and we change nothing but the box itself.
 * @param {import('../../src/storage.js').ProviderText|null} text The provider's own account of the situation
 * @returns {void}
 */
function enterRecoveryKeyMode(text) {
    if (!recoveryCodeMessage) {
        recoveryCodeMessage = String($('#recoverMessage').text()).trim();
    }

    recoveryMode = 'key';

    if (text?.body) {
        $('#recoverMessage').text([text.body, ...(text.notes ?? [])].join(' '));
    }

    // 🔴 A recovery secret is a CREDENTIAL, and it goes in over the user's shoulder like any other. Mask
    // it. The console code is not masked upstream and stays unmasked, because it is a one-shot number the
    // server just printed to a terminal — this is the key to the account itself.
    const field = text?.fields?.find(f => f.name === 'current');
    $('#recoveryCode')
        .val('')
        .attr('type', 'password')
        .attr('autocomplete', 'one-time-code')
        .attr('placeholder', field?.placeholder ?? 'Recovery key');
}

/**
 * Put the block back to SillyTavern's own console-code reset, byte for byte.
 * @returns {void}
 */
function exitRecoveryKeyMode() {
    recoveryMode = 'code';

    if (recoveryCodeMessage) {
        $('#recoverMessage').text(recoveryCodeMessage);
    }

    // 🔴 CLEAR IT ON THE WAY OUT, OR THE MASKING ABOVE IS UNDONE. This flips the field back to `type=text`.
    // With the account list still on screen (the non-discreet login), a user can enter key mode for user A,
    // type A's recovery key, click user B, and ask for B's recovery — at which point this runs and A's key,
    // still in the box, is displayed in clear text. A recovery secret is the key to the account.
    $('#recoveryCode')
        .val('')
        .attr('type', 'text')
        .removeAttr('autocomplete')
        .attr('placeholder', 'Recovery code');
}

/**
 * Requests a recovery code for the user.
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
async function sendRecoveryPart1(handle) {
    const response = await fetch('/api/users/recover-step1', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ handle }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        // 🔑 NOT AN ERROR — A REDIRECTION. The server is not saying "no"; it is saying "not that way, THIS
        // way." Showing this as a red error message with no way to act on it (which is what it did before)
        // strands the user in front of the one door they can actually open, telling them it is shut.
        //
        // ⚠️ The server only sets this when a way back in ACTUALLY EXISTS (it asks `canRecover()`). A
        // provider that owns the account and offers no recovery at all falls through to the error below —
        // which is the truth, and is far kinder than a box the user can never fill.
        if (errorData.recoveryKeyRequired) {
            enterRecoveryKeyMode(errorData.recovery ?? null);
            showRecoveryBlock();
            return;
        }

        return displayError(errorData.error || 'An error occurred');
    }

    exitRecoveryKeyMode();
    showRecoveryBlock();
}

/**
 * 🔑 Trade the provider's recovery secret for a new password — the second door.
 *
 * One request, both halves: the provider makes the storage available again AND the new password is set. A
 * provider that keys itself from the password cannot do one without the other, and SillyTavern does not
 * need to know that to carry the two values across.
 * @param {string} handle User handle
 * @param {string} recoveryKey The secret they saved when they first signed in
 * @param {string} newPassword The password they want now
 * @returns {Promise<void>}
 */
async function sendRecoveryWithKey(handle, recoveryKey, newPassword) {
    const response = await fetch('/api/users/recover-with-key', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ handle, recoveryKey, newPassword }),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return displayError(errorData.error || 'An error occurred');
    }

    console.log(`Successfully recovered ${handle} with their recovery key.`);
    await performLogin(handle, newPassword);
}

/**
 * Sets a new password for the user using the recovery code.
 * @param {string} handle User handle
 * @param {string} code Recovery code
 * @param {string} newPassword New password
 * @returns {Promise<void>}
 */
async function sendRecoveryPart2(handle, code, newPassword) {
    // 🔑 Same two boxes, same Send button — but a provider-held account is not being reset, it is being
    // recovered, and that goes to a different route. Both login paths (discreet and the account picker) and
    // the Enter key all funnel through here, so branching here is the whole of it.
    if (recoveryMode === 'key') {
        return await sendRecoveryWithKey(handle, code, newPassword);
    }

    const recoveryData = {
        handle,
        code,
        newPassword,
    };

    const response = await fetch('/api/users/recover-step2', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(recoveryData),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return displayError(errorData.error || 'An error occurred');
    }

    console.log(`Successfully recovered password for ${handle}!`);
    await performLogin(handle, newPassword);
}

/**
 * Attempts to log in the user.
 * @param {string} handle User's handle
 * @param {string} password User's password
 * @returns {Promise<void>}
 */
async function performLogin(handle, password) {
    const userInfo = {
        handle: handle,
        password: password,
    };

    try {
        const response = await fetch('/api/users/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify(userInfo),
        });

        if (!response.ok) {
            // A body that is not JSON means something REFUSED THIS BEFORE THE HANDLER SAW IT — an expired
            // session, a CSRF mismatch — and those refusals are plain text ('Forbidden'). Parsing one as
            // JSON throws, the catch below stringifies the SyntaxError, and the user is told
            // "Unexpected token 'F'" when what happened is that their session went stale. Say that instead.
            const errorData = await response.json().catch(() => ({}));
            return displayError(errorData.error || (response.status === 403
                ? 'Your session is no longer valid. Please refresh the page and try again.'
                : `Login failed (HTTP ${response.status}). Please refresh the page and try again.`));
        }

        const data = await response.json();

        if (data.handle) {
            console.log(`Successfully logged in as ${handle}!`);
            redirectToHome();
        }
    } catch (error) {
        console.error('Error logging in:', error);
        displayError(String(error));
    }
}

/**
 * Handles the user selection event.
 * @param {object} user User object
 * @returns {Promise<void>}
 */
async function onUserSelected(user) {
    // No password, just log in
    if (!user.password) {
        return await performLogin(user.handle, '');
    }

    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();

    // Changing which account is selected abandons whatever recovery was half-entered for the previous one.
    // Carrying `recoveryMode` and the field contents across is how one user's recovery key ends up on
    // screen, unmasked, under another user's name.
    exitRecoveryKeyMode();
    $('#newPassword').val('');

    $('#loginButton').off('click').on('click', async () => {
        const password = String($('#userPassword').val());
        await performLogin(user.handle, password);
    });

    $('#recoverPassword').off('click').on('click', async () => {
        await sendRecoveryPart1(user.handle);
    });

    $('#sendRecovery').off('click').on('click', async () => {
        const code = String($('#recoveryCode').val());
        const newPassword = String($('#newPassword').val());
        await sendRecoveryPart2(user.handle, code, newPassword);
    });

    displayError('');
}

/**
 * Displays an error message to the user.
 * @param {string} message Error message
 */
function displayError(message) {
    $('#errorMessage').text(message);
}

/**
 * Redirects the user to the home page.
 * Preserves the query string.
 */
function redirectToHome() {
    // Create a URL object based on the current location
    const currentUrl = new URL(window.location.href);

    // After a login there's no need to preserve the
    // noauto parameter (if present)
    currentUrl.searchParams.delete('noauto');

    // Set the pathname to root and keep the updated query string
    currentUrl.pathname = '/';

    // Redirect to the new URL
    window.location.href = currentUrl.toString();
}

/**
 * Hides the password entry block and shows the password recovery block.
 */
function showRecoveryBlock() {
    $('#passwordEntryBlock').hide();
    $('#passwordRecoveryBlock').show();
    displayError('');
}

/**
 * Hides the password recovery block and shows the password entry block.
 */
function onCancelRecoveryClick() {
    exitRecoveryKeyMode();
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    displayError('');
}

/**
 * Configures the login page for normal login.
 * @param {import('../../src/users').UserViewModel[]} userList List of users
 */
function configureNormalLogin(userList) {
    console.log('Discreet login is disabled');
    $('#handleEntryBlock').hide();
    $('#normalLoginPrompt').show();
    $('#discreetLoginPrompt').hide();
    console.log(userList);
    for (const user of userList) {
        const userBlock = $('<div></div>').addClass('userSelect');
        const avatarBlock = $('<div></div>').addClass('avatar');
        avatarBlock.append($('<img>').attr('src', user.avatar));
        userBlock.append(avatarBlock);
        userBlock.append($('<span></span>').addClass('userName').text(user.name));
        userBlock.append($('<small></small>').addClass('userHandle').text(user.handle));
        userBlock.on('click', () => onUserSelected(user));
        $('#userList').append(userBlock);
    }
}

/**
 * Configures the login page for discreet login.
 */
function configureDiscreetLogin() {
    console.log('Discreet login is enabled');
    $('#handleEntryBlock').show();
    $('#normalLoginPrompt').hide();
    $('#discreetLoginPrompt').show();
    $('#userList').hide();
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    $('#loginButton').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        const password = String($('#userPassword').val());
        await performLogin(handle, password);
    });

    $('#recoverPassword').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        await sendRecoveryPart1(handle);
    });

    $('#sendRecovery').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        const code = String($('#recoveryCode').val());
        const newPassword = String($('#newPassword').val());
        await sendRecoveryPart2(handle, code, newPassword);
    });
}

(async function () {
    initAccessibility();

    csrfToken = await getCsrfToken();

    // Not awaited: the badge is decoration on a page whose job is to log somebody in, and a slow or absent
    // endpoint must not hold that up. It reveals itself whenever it resolves.
    showStorageIndicator();

    const userList = await getUserList();

    if (discreetLogin) {
        configureDiscreetLogin();
    } else {
        configureNormalLogin(userList);
    }
    document.getElementById('shadow_popup').style.opacity = '';
    $('#cancelRecovery').on('click', onCancelRecoveryClick);
    $(document).on('keydown', (evt) => {
        if (evt.key === 'Enter' && document.activeElement.tagName === 'INPUT') {
            if ($('#passwordRecoveryBlock').is(':visible')) {
                $('#sendRecovery').trigger('click');
            } else {
                $('#loginButton').trigger('click');
            }
        }
    });
})();
