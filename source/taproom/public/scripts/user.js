import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { canViewSecrets } from './secrets.js';
import { renderTemplateAsync } from './templates.js';
import { copyText, download, ensureImageFormatSupported, getBase64Async, humanFileSize } from './utils.js';
import { openStorageProvenancePanel } from './storage-provenance-panel.js';

/**
 * @type {import('../../src/users.js').UserViewModel} Logged in user
 */
export let currentUser = null;
export let accountsEnabled = false;

// Extend the session every 10 minutes
const SESSION_EXTEND_INTERVAL = 10 * 60 * 1000;

/**
 * What the page says when it refuses a blank password. The server says the same thing (BLANK_PASSWORD_REFUSAL in
 * src/users.js) and is the authority; this only saves the round trip.
 */
const PASSWORD_REQUIRED_TEXT = 'A password is required. Every account on this server must have one, so a blank password cannot be used.';

/** @type {Promise<boolean>|null} */
let passwordRequiredPromise = null;

/**
 * Does this server require every account to have a password?
 *
 * Taproom (October 11, 2026): a blank password makes the container refuse to start, so the forms must not offer
 * one. The server decides and enforces it (`/api/users/create`, `/change-password`, `/enable`); this reads the same
 * fact the login page reads, `/api/storage/status` `enabled` (a storage provider is registered), so the page says
 * "a password is required" instead of offering "[ No password ]". A failed lookup answers false and the server's own
 * refusal still applies, shown as the error it sent.
 * @returns {Promise<boolean>} True if a blank password must not be offered
 */
function isPasswordRequired() {
    passwordRequiredPromise ??= (async () => {
        try {
            const response = await fetch('/api/storage/status');
            return response.ok && (await response.json())?.enabled === true;
        } catch (error) {
            console.error('Could not ask whether a password is required:', error);
            return false;
        }
    })();

    return passwordRequiredPromise;
}

/**
 * Enable or disable user account controls in the UI.
 * @param {boolean} isEnabled User account controls enabled
 * @returns {Promise<void>}
 */
export async function setUserControls(isEnabled) {
    accountsEnabled = isEnabled;

    if (!isEnabled) {
        $('#logout_button').hide();
        $('#admin_button').hide();
        return;
    }

    $('#logout_button').show();
    await getCurrentUser();
    await showPendingRecoveryKey();
}

/**
 * Show a pending recovery key until the user confirms it is saved. The provider supplies the key and any
 * explanatory text; this UI keeps the key visible and the acknowledgement explicit. Fetching does not
 * consume it, so closing or refreshing the page leaves it pending. Without a provider, the endpoint returns
 * `null`.
 * @returns {Promise<void>}
 */
async function showPendingRecoveryKey() {
    let secret = null;
    /** @type {import('../../src/storage.js').ProviderText|null} */
    let text = null;

    try {
        const response = await fetch('/api/users/recovery-secret', { headers: getRequestHeaders() });

        if (!response.ok) {
            return;
        }

        ({ secret, text } = await response.json());
    } catch (error) {
        console.error('Could not check for a pending recovery key:', error);
        return;
    }

    if (!secret) {
        return;
    }

    const content = document.createElement('div');
    content.classList.add('flex-container', 'flexFlowColumn', 'flexGap10');

    const heading = document.createElement('h3');
    heading.classList.add('marginBot5');
    heading.textContent = text?.title || t`Save your recovery key`;

    const key = document.createElement('code');
    key.classList.add('recovery_key');
    key.textContent = secret;

    const buttons = document.createElement('div');
    buttons.classList.add('flex-container', 'flexGap10');

    const copyButton = document.createElement('div');
    copyButton.classList.add('menu_button', 'menu_button_icon');
    copyButton.innerHTML = '<i class="fa-solid fa-copy"></i>';
    copyButton.append(t`Copy`);
    copyButton.addEventListener('click', async () => {
        await copyText(secret);
        toastr.success(t`Recovery key copied to the clipboard.`);
    });

    const downloadButton = document.createElement('div');
    downloadButton.classList.add('menu_button', 'menu_button_icon');
    downloadButton.innerHTML = '<i class="fa-solid fa-download"></i>';
    downloadButton.append(t`Download`);
    downloadButton.addEventListener('click', () => {
        const handle = getCurrentUserHandle();
        // Keep provider-supplied guidance intact; the UI adds only the account handle and key.
        const explanation = [text?.body, ...(text?.notes ?? [])].filter(Boolean).join('\n\n');
        const body = `SillyTavern recovery key for '${handle}'\n\n${secret}\n${explanation ? `\n${explanation}\n` : ''}`;
        download(body, `sillytavern-recovery-key-${handle}.txt`, 'text/plain');
    });

    // Keep both ways to save the key visible in the same row.
    buttons.append(copyButton, downloadButton);

    // The provider's own words, in its own order, between the heading and the key.
    const prose = [text?.body, ...(text?.notes ?? [])].filter(Boolean).map(paragraph => {
        const p = document.createElement('p');
        p.classList.add('marginBot5');
        p.textContent = paragraph;
        return p;
    });

    content.append(heading, ...prose, key, buttons);

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: text?.submitLabel || t`Done`,
        cancelButton: false,
        leftAlign: true,
        // The key remains pending until the user explicitly confirms they saved it.
        allowEscapeClose: false,
        customInputs: [{
            id: 'recovery_key_saved',
            label: t`I have written this recovery key down and stored it somewhere safe.`,
            type: 'checkbox',
            defaultState: false,
        }],
        onClosing: (p) => {
            if (!p.inputResults.get('recovery_key_saved')) {
                toastr.warning(t`Save the recovery key first.`);
                return false;
            }

            return true;
        },
    });

    const result = await popup.show();

    // Only explicit confirmation clears the pending key; other close paths leave it available for the next login.
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    try {
        const response = await fetch('/api/users/recovery-secret/acknowledge', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`Server answered ${response.status}`);
        }
    } catch (error) {
        // Nothing is lost: the key is still pending on the server, so they will simply be asked again.
        console.error('Could not acknowledge the recovery key:', error);
        toastr.error(t`Could not save that you have stored the recovery key. You will be asked again.`);
    }
}

/**
 * Check if the current user is an admin.
 * @returns {boolean} True if the current user is an admin
 */
export function isAdmin() {
    if (!accountsEnabled) {
        return true;
    }

    if (!currentUser) {
        return false;
    }

    return Boolean(currentUser.admin);
}

/**
 * Gets the handle string of the current user.
 * @returns {string} User handle
 */
export function getCurrentUserHandle() {
    return currentUser?.handle || 'default-user';
}

/**
 * Get the current user.
 * @returns {Promise<void>}
 */
async function getCurrentUser() {
    try {
        const response = await fetch('/api/users/me', {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Failed to get current user');
        }

        currentUser = await response.json();
        $('#admin_button').toggle(accountsEnabled && isAdmin());
    } catch (error) {
        console.error('Error getting current user:', error);
    }
}

/**
 * Get a list of all users.
 * @returns {Promise<import('../../src/users.js').UserViewModel[]>} Users
 */
async function getUsers() {
    try {
        const response = await fetch('/api/users/get', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error('Failed to get users');
        }

        return response.json();
    } catch (error) {
        console.error('Error getting users:', error);
    }
}

/**
 * Enable a user account.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function enableUser(handle, callback) {
    try {
        const response = await fetch('/api/users/enable', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to enable user');
            throw new Error('Failed to enable user');
        }

        callback();
    } catch (error) {
        console.error('Error enabling user:', error);
    }
}

async function disableUser(handle, callback) {
    try {
        const response = await fetch('/api/users/disable', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data?.error || 'Unknown error', 'Failed to disable user');
            throw new Error('Failed to disable user');
        }

        callback();
    } catch (error) {
        console.error('Error disabling user:', error);
    }
}

/**
 * Promote a user to admin.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function promoteUser(handle, callback) {
    try {
        const response = await fetch('/api/users/promote', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to promote user');
            throw new Error('Failed to promote user');
        }

        callback();
    } catch (error) {
        console.error('Error promoting user:', error);
    }
}

/**
 * Demote a user from admin.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function demoteUser(handle, callback) {
    try {
        const response = await fetch('/api/users/demote', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to demote user');
            throw new Error('Failed to demote user');
        }

        callback();
    } catch (error) {
        console.error('Error demoting user:', error);
    }
}

/**
 * Create a new user.
 * @param {HTMLFormElement} form Form element
 */
async function createUser(form, callback) {
    const errors = [];
    const formData = new FormData(form);

    if (!formData.get('handle')) {
        errors.push('Handle is required');
    }

    if (!formData.get('password') && await isPasswordRequired()) {
        errors.push(PASSWORD_REQUIRED_TEXT);
    }

    if (formData.get('password') !== formData.get('confirm')) {
        errors.push('Passwords do not match');
    }

    if (errors.length) {
        toastr.error(errors.join(', '), 'Failed to create user');
        return;
    }

    const body = {};
    formData.forEach(function (value, key) {
        if (key === 'confirm') {
            return;
        }
        if (key.startsWith('_')) {
            key = key.substring(1);
        }
        body[key] = value;
    });

    try {
        const response = await fetch('/api/users/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to create user');
            throw new Error('Failed to create user');
        }

        form.reset();
        callback();
    } catch (error) {
        console.error('Error creating user:', error);
    }
}

/**
 * Backup a user's data.
 * @param {string} handle Handle of the user to backup
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function backupUserData(handle, callback) {
    try {
        toastr.info('Please wait for the download to start.', 'Backup Requested');
        const response = await fetch('/api/users/backup', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to backup user data');
            throw new Error('Failed to backup user data');
        }

        const includesSecrets = await canViewSecrets();
        if (includesSecrets === false) {
            toastr.warning('The backup will not include secrets due to a server configuration.', 'Secrets Not Included');
        }

        const blob = await response.blob();
        const header = response.headers.get('Content-Disposition');
        const parts = header.split(';');
        const filename = parts[1].split('=')[1].replaceAll('"', '');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        callback();
    } catch (error) {
        console.error('Error backing up user data:', error);
    }
}

/**
 * Show the recovery-key action only when the provider supports it. Regeneration requires the current
 * password because an open session alone does not prove the caller knows the credential.
 * @param {JQuery<HTMLElement>} button The button in the settings panel
 * @returns {Promise<void>}
 */
async function setUpNewRecoveryKeyButton(button) {
    /** @type {import('../../src/storage.js').ProviderText|null} */
    let text = null;

    try {
        const response = await fetch('/api/users/recovery-secret/capability', { headers: getRequestHeaders() });

        if (!response.ok) {
            return;
        }

        const capability = await response.json();

        // No provider, or a provider that cannot issue one. Do not offer a button that can only fail.
        if (!capability?.canRegenerate) {
            return;
        }

        text = capability.text ?? null;
    } catch (error) {
        console.error('Could not check whether a new recovery key can be issued:', error);
        return;
    }

    button.show();
    button.on('click', () => askForNewRecoveryKey(text));
}

/**
 * Ask for the current password, issue a new recovery key, and show it until the user confirms saving it.
 * @param {import('../../src/storage.js').ProviderText|null} text The provider's own words for this dialog
 * @returns {Promise<void>}
 */
async function askForNewRecoveryKey(text) {
    const content = document.createElement('div');
    content.classList.add('flex-container', 'flexFlowColumn', 'flexGap10');

    const heading = document.createElement('h3');
    heading.classList.add('marginBot5');
    heading.textContent = text?.title || t`Generate a new recovery key`;
    content.append(heading);

    for (const paragraph of [text?.body, ...(text?.notes ?? [])].filter(Boolean)) {
        const p = document.createElement('p');
        p.classList.add('marginBot5');
        p.textContent = paragraph;
        content.append(p);
    }

    const label = document.createElement('label');
    label.textContent = text?.fields?.find(f => f.name === 'current')?.label || t`Current password`;

    const input = document.createElement('input');
    input.type = 'password';
    input.classList.add('text_pole');
    input.autocomplete = 'current-password';

    label.append(input);
    content.append(label);

    const errorBox = document.createElement('div');
    errorBox.classList.add('changePasswordError');
    errorBox.style.display = 'none';
    content.append(errorBox);

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: text?.submitLabel || t`Generate`,
        cancelButton: t`Cancel`,
        // The dialog stays up until the server says yes — a wrong password is corrected in place, not by
        // reopening it and starting again. Same rule as the change-password dialog, for the same reason.
        onClosing: async (p) => {
            if (p.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }

            errorBox.style.display = 'none';

            try {
                const response = await fetch('/api/users/recovery-secret/regenerate', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ password: input.value }),
                });

                if (!response.ok) {
                    // The provider's own refusal, verbatim. It knows why it said no; we do not.
                    const data = await response.json().catch(() => ({}));
                    errorBox.textContent = data.error || t`The recovery key could not be issued.`;
                    errorBox.style.display = '';
                    return false;
                }
            } catch (error) {
                console.error('Could not issue a new recovery key:', error);
                errorBox.textContent = t`The server could not be reached.`;
                errorBox.style.display = '';
                return false;
            }

            return true;
        },
    });

    if (await popup.show() !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    // Reuse the first-login prompt so the new key remains pending until explicitly acknowledged.
    await showPendingRecoveryKey();
}

/**
 * Password fields the template can render and the selectors for their blocks. Provider forms use these names.
 */
const PASSWORD_FIELD_BLOCKS = {
    current: '.currentPasswordBlock',
    password: '.newPasswordBlock',
    confirm: '.confirmPasswordBlock',
};

/**
 * Ask the storage provider how it wants the change-password dialog drawn.
 * @param {string} handle Whose password is being changed
 * @returns {Promise<import('../../src/storage.js').ProviderText|null>} The provider's dialog, or null for SillyTavern's own
 */
async function getPasswordForm(handle) {
    try {
        const response = await fetch(`/api/users/password-form?handle=${encodeURIComponent(handle)}`, { headers: getRequestHeaders() });

        if (!response.ok) {
            return null;
        }

        return (await response.json())?.text ?? null;
    } catch (error) {
        // A provider with nothing to say and a server that could not be asked are the same thing here: draw
        // the stock dialog. Never block a password change on the decoration around it.
        console.error('Could not read the password form:', error);
        return null;
    }
}

/**
 * Show the password-change form and keep it open until the server accepts the request. Handling validation
 * in `onClosing` lets the user correct errors in place and prevents password managers from saving a rejected
 * value. A provider may supply the fields and labels; otherwise the stock form is used.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function changePassword(handle, callback) {
    try {
        const isOwnAccount = handle === currentUser?.handle;
        const text = await getPasswordForm(handle);
        const template = $(await renderTemplateAsync('changePassword'));

        // Show the current-password field for an admin changing their own account; another user's password
        // is not available to the admin, so the provider may refuse that change.
        template.find('.currentPasswordBlock').toggle(!isAdmin() || isOwnAccount);

        // The new-password boxes must not offer "[ No password ]" where the server refuses a blank one. A provider's
        // own placeholder, applied below, wins over this.
        if (await isPasswordRequired()) {
            template.find('.newPasswordBlock input, .confirmPasswordBlock input').attr('placeholder', t`Required`);
        }

        /** @type {Set<string>} Boxes the provider will not accept empty. */
        const required = new Set();

        // The provider draws the form: only the boxes it asks for, under the names it gives them.
        if (Array.isArray(text?.fields)) {
            for (const [name, selector] of Object.entries(PASSWORD_FIELD_BLOCKS)) {
                const field = text.fields.find(f => f.name === name);
                template.find(selector).toggle(!!field);

                if (!field) {
                    continue;
                }

                if (field.label) {
                    template.find(`${selector} label`).text(field.label).removeAttr('data-i18n');
                }

                if (field.placeholder) {
                    template.find(`${selector} input`).attr('placeholder', field.placeholder);
                }

                if (field.required) {
                    required.add(name);
                }
            }
        }

        const content = document.createElement('div');
        content.classList.add('flex-container', 'flexFlowColumn', 'flexGap10');

        if (text?.title) {
            const heading = document.createElement('h3');
            heading.classList.add('marginBot5');
            heading.textContent = text.title;
            content.append(heading);
        }

        for (const paragraph of [text?.body, ...(text?.notes ?? [])].filter(Boolean)) {
            const p = document.createElement('p');
            p.classList.add('marginBot5');
            p.textContent = paragraph;
            content.append(p);
        }

        content.append(template[0]);

        // Where a refusal lands. In the dialog, next to the boxes that caused it — not on a page the user
        // is no longer looking at.
        const errorBox = document.createElement('div');
        errorBox.classList.add('changePasswordError');
        errorBox.style.display = 'none';
        content.append(errorBox);

        /** @param {string} message The refusal to show, or '' to clear it */
        const showError = (message) => {
            errorBox.textContent = message;
            errorBox.style.display = message ? '' : 'none';
        };

        /** @param {string} name The credential slot @returns {string} What the user typed in it */
        const valueOf = (name) => String(template.find(`input[name="${name}"]`).val() ?? '');

        const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: text?.submitLabel || t`Change`,
            cancelButton: t`Cancel`,
            onClosing: async (p) => {
                // Cancel, Escape, clicking away: the user meant it. Let it close.
                if (p.result !== POPUP_RESULT.AFFIRMATIVE) {
                    return true;
                }

                showError('');

                const oldPassword = valueOf('current');
                const newPassword = valueOf('password');
                const confirmPassword = valueOf('confirm');

                if ([...required].some(name => !valueOf(name))) {
                    showError(t`Fill in every box.`);
                    return false;
                }

                if (!newPassword && await isPasswordRequired()) {
                    showError(PASSWORD_REQUIRED_TEXT);
                    return false;
                }

                if (newPassword !== confirmPassword) {
                    showError(t`The new passwords do not match.`);
                    return false;
                }

                try {
                    const response = await fetch('/api/users/change-password', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ handle, newPassword, oldPassword }),
                    });

                    if (!response.ok) {
                        // 🔴 The provider's own words, verbatim. It is the only party that knows why it
                        // said no, and SillyTavern must not paraphrase a refusal it does not understand.
                        const data = await response.json().catch(() => ({}));
                        showError(data.error || t`The password could not be changed.`);
                        return false;
                    }
                } catch (error) {
                    console.error('Error changing password:', error);
                    showError(t`The server could not be reached.`);
                    return false;
                }

                return true;
            },
        });

        const result = await popup.show();

        // Cancelled, or closed without success. Nothing happened, and nothing needs saying.
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        toastr.success(t`Password changed successfully`, t`Password Changed`);
        callback();
    } catch (error) {
        console.error('Error changing password:', error);
    }
}

/**
 * Delete a user.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function deleteUser(handle, callback) {
    try {
        if (handle === currentUser.handle) {
            toastr.error('Cannot delete yourself', 'Failed to delete user');
            throw new Error('Cannot delete yourself');
        }

        let purge = false;
        let confirmHandle = '';

        const template = $(await renderTemplateAsync('deleteUser'));
        template.find('#deleteUserName').text(handle);
        template.find('input[name="deleteUserData"]').on('input', function () {
            purge = $(this).is(':checked');
        });
        template.find('input[name="deleteUserHandle"]').on('input', function () {
            confirmHandle = String($(this).val());
        });

        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel', wide: false, large: false });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Delete user cancelled');
        }

        if (handle !== confirmHandle) {
            toastr.error('Handles do not match', 'Failed to delete user');
            throw new Error('Handles do not match');
        }

        const response = await fetch('/api/users/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, purge }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to delete user');
            throw new Error('Failed to delete user');
        }

        toastr.success('User deleted successfully', 'User Deleted');
        callback();
    } catch (error) {
        console.error('Error deleting user:', error);
    }
}

/**
 * Reset a user's settings.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function resetSettings(handle, callback) {
    try {
        let password = '';
        const template = $(await renderTemplateAsync('resetSettings'));
        template.find('input[name="password"]').on('input', function () {
            password = String($(this).val());
        });
        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Reset', cancelButton: 'Cancel', wide: false, large: false });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Reset settings cancelled');
        }

        const response = await fetch('/api/users/reset-settings', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, password }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset settings');
            throw new Error('Failed to reset settings');
        }

        toastr.success('Settings reset successfully', 'Settings Reset');
        callback();
    } catch (error) {
        console.error('Error resetting settings:', error);
    }
}

/**
 * Change a user's display name.
 * @param {string} handle User handle
 * @param {string} name Current name
 * @param {function} callback Success callback
 */
async function changeName(handle, name, callback) {
    try {
        const template = $(await renderTemplateAsync('changeName'));
        const result = await callGenericPopup(template, POPUP_TYPE.INPUT, name, { okButton: 'Change', cancelButton: 'Cancel', wide: false, large: false });

        if (!result) {
            throw new Error('Change name cancelled');
        }

        name = String(result);

        const response = await fetch('/api/users/change-name', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change name');
            throw new Error('Failed to change name');
        }

        toastr.success('Name changed successfully', 'Name Changed');
        callback();
    } catch (error) {
        console.error('Error changing name:', error);
    }
}

/**
 * Restore a settings snapshot.
 * @param {string} name Snapshot name
 * @param {function} callback Success callback
 */
async function restoreSnapshot(name, callback) {
    try {
        const confirm = await callGenericPopup(
            `Are you sure you want to restore the settings from "${name}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Restore', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Restore snapshot cancelled');
        }

        const response = await fetch('/api/settings/restore-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to restore snapshot');
            throw new Error('Failed to restore snapshot');
        }

        callback();
    } catch (error) {
        console.error('Error restoring snapshot:', error);
    }
}

/**
 * Load the content of a settings snapshot.
 * @param {string} name Snapshot name
 * @returns {Promise<string>} Snapshot content
 */
async function loadSnapshotContent(name) {
    try {
        const response = await fetch('/api/settings/load-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to load snapshot content');
            throw new Error('Failed to load snapshot content');
        }

        return response.text();
    } catch (error) {
        console.error('Error loading snapshot content:', error);
    }
}

/**
 * Gets a list of settings snapshots.
 * @returns {Promise<Snapshot[]>} List of snapshots
 * @typedef {Object} Snapshot
 * @property {string} name Snapshot name
 * @property {number} date Date in milliseconds
 * @property {number} size File size in bytes
 */
async function getSnapshots() {
    try {
        const response = await fetch('/api/settings/get-snapshots', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to get settings snapshots');
            throw new Error('Failed to get settings snapshots');
        }

        const snapshots = await response.json();
        return snapshots;
    } catch (error) {
        console.error('Error getting settings snapshots:', error);
        return [];
    }
}

/**
 * Make a snapshot of the current settings.
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function makeSnapshot(callback) {
    try {
        const response = await fetch('/api/settings/make-snapshot', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to make snapshot');
            throw new Error('Failed to make snapshot');
        }

        toastr.success('Snapshot created successfully', 'Snapshot Created');
        callback();
    } catch (error) {
        console.error('Error making snapshot:', error);
    }
}

/**
 * Open the settings snapshots view.
 */
async function viewSettingsSnapshots() {
    const template = $(await renderTemplateAsync('snapshotsView'));
    async function renderSnapshots() {
        const snapshots = await getSnapshots();
        template.find('.snapshotList').empty();

        for (const snapshot of snapshots.sort((a, b) => b.date - a.date)) {
            const snapshotBlock = template.find('.snapshotTemplate .snapshot').clone();
            snapshotBlock.find('.snapshotName').text(snapshot.name);
            snapshotBlock.find('.snapshotDate').text(new Date(snapshot.date).toLocaleString());
            snapshotBlock.find('.snapshotSize').text(humanFileSize(snapshot.size));
            snapshotBlock.find('.snapshotRestoreButton').on('click', async (e) => {
                e.stopPropagation();
                restoreSnapshot(snapshot.name, () => location.reload());
            });
            snapshotBlock.find('.inline-drawer-toggle').on('click', async () => {
                const contentBlock = snapshotBlock.find('.snapshotContent');
                if (!contentBlock.val()) {
                    const content = await loadSnapshotContent(snapshot.name);
                    contentBlock.val(content);
                }
            });
            template.find('.snapshotList').append(snapshotBlock);
        }
    }

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false, large: false, allowVerticalScrolling: true });
    template.find('.makeSnapshotButton').on('click', () => makeSnapshot(renderSnapshots));
    renderSnapshots();
}

/**
 * Reset everything to default.
 * @param {function} callback Success callback
 */
async function resetEverything(callback) {
    try {
        const step1Response = await fetch('/api/users/reset-step1', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!step1Response.ok) {
            const data = await step1Response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset');
            throw new Error('Failed to reset everything');
        }

        let password = '';
        let code = '';

        const template = $(await renderTemplateAsync('userReset'));
        template.find('input[name="password"]').on('input', function () {
            password = String($(this).val());
        });
        template.find('input[name="code"]').on('input', function () {
            code = String($(this).val());
        });
        const confirm = await callGenericPopup(
            template,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Reset', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Reset everything cancelled');
        }

        const step2Response = await fetch('/api/users/reset-step2', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ password, code }),
        });

        if (!step2Response.ok) {
            const data = await step2Response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset');
            throw new Error('Failed to reset everything');
        }

        toastr.success('Everything reset successfully', 'Reset Everything');
        callback();
    } catch (error) {
        console.error('Error resetting everything:', error);
    }
}

/**
 * 🔒 Wire up the idle lock control in the account panel.
 *
 * The whole section stays hidden unless the server says a storage provider owns this user — with plain
 * files there is nothing to lock, and drawing the control anyway would offer a setting that does nothing.
 *
 * ⚠️ THE SELECT IS NOT THE VALUE. A saved setting that is not one of the presets — because the user typed
 * it, or because a later version drops a preset — must still come back as itself rather than being snapped
 * to the nearest option or silently reset to Never. That is what the `custom` branch is for, and it runs on
 * load as well as on change.
 * @param {JQuery<HTMLElement>} template The rendered profile panel
 * @returns {Promise<void>}
 */
async function setUpIdleLockControl(template) {
    const section = template.find('.idleLockSection');
    const select = template.find('.idleLockSelect');
    const customRow = template.find('.idleLockCustomRow');
    const custom = template.find('.idleLockCustom');
    const recommendation = template.find('.idleLockRecommendation');

    /** @type {number|null} What is on the server, so a failed save can put the control back. */
    let saved = null;

    const showCustomRow = (show) => customRow.toggle(show);

    /**
     * Put a number of minutes into the control, choosing the preset if there is one.
     * @param {number} minutes The setting to display
     */
    const render = (minutes) => {
        const preset = select.find(`option[value="${minutes}"]`);

        if (preset.length) {
            select.val(String(minutes));
            custom.val('');
            showCustomRow(false);
            return;
        }

        select.val('custom');
        custom.val(String(minutes));
        showCustomRow(true);
    };

    /**
     * Save, and put the control back where it was if the server refuses.
     * @param {number} minutes Whole minutes; 0 means never
     * @returns {Promise<void>}
     */
    const save = async (minutes) => {
        if (minutes === saved) {
            return;
        }

        try {
            const response = await fetch('/api/users/idle-lock', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ minutes }),
            });

            if (!response.ok) {
                throw new Error(await response.text());
            }

            saved = minutes;
            toastr.success(minutes ? t`Your data will lock after ${minutes} minutes of inactivity.` : t`Your data will not lock automatically.`);
        } catch (error) {
            console.error('Could not save the idle lock setting', error);
            toastr.error(t`Could not save that. The setting is unchanged.`);
            render(saved ?? 0);
        }
    };

    try {
        const response = await fetch('/api/users/idle-status', { headers: getRequestHeaders() });

        if (!response.ok) {
            return;
        }

        const status = await response.json();

        if (!status.available) {
            return;
        }

        saved = status.configuredMinutes;
        render(status.configuredMinutes);

        // The provider's suggestion, said out loud and attributed. It is not applied — the fork's default is
        // Never — so if it is never shown, a provider's security advice reaches nobody.
        if (status.recommendedMinutes > 0) {
            // Rounded for reading, and only here — the server sends it exact so that a recommendation too
            // small to round up to a minute still arrives as a recommendation rather than as silence.
            const suggested = Math.max(1, Math.round(status.recommendedMinutes));
            recommendation.text(t`Your storage provider suggests ${suggested} minutes.`).show();
        }

        section.show();
    } catch (error) {
        console.error('Could not read the idle lock setting', error);
        return;
    }

    select.on('change', function () {
        const value = String($(this).val());

        if (value === 'custom') {
            // Nothing to save yet — they have picked "type me a number" and have not typed one. Seed it with
            // what is already in force so the box is never blank, and put the cursor in it.
            showCustomRow(true);
            custom.val(String(saved ?? 0)).trigger('focus').trigger('select');
            return;
        }

        showCustomRow(false);
        custom.val('');
        void save(Number(value));
    });

    custom.on('change', function () {
        const minutes = Number($(this).val());

        // 🔴 REFUSE, DO NOT ROUND. A silently corrected number is a control that lies about what it did, and
        // this one decides when the user loses unsent text.
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) {
            toastr.warning(t`Enter a whole number of minutes, or choose Never.`);
            render(saved ?? 0);
            return;
        }

        void save(minutes);
    });
}

async function openUserProfile() {
    await getCurrentUser();
    const template = $(await renderTemplateAsync('userProfile'));
    template.find('.userName').text(currentUser.name);
    template.find('.userHandle').text(currentUser.handle);
    template.find('.avatar img').attr('src', currentUser.avatar);
    template.find('.userRole').text(currentUser.admin ? 'Admin' : 'User');
    template.find('.userCreated').text(new Date(currentUser.created).toLocaleString());
    template.find('.hasPassword').toggle(currentUser.password);
    template.find('.noPassword').toggle(!currentUser.password);
    template.find('.userSettingsSnapshotsButton').on('click', () => viewSettingsSnapshots());
    template.find('.userChangeNameButton').on('click', async () => changeName(currentUser.handle, currentUser.name, async () => {
        await getCurrentUser();
        template.find('.userName').text(currentUser.name);
    }));
    template.find('.userChangePasswordButton').on('click', () => changePassword(currentUser.handle, async () => {
        await getCurrentUser();
        template.find('.hasPassword').toggle(currentUser.password);
        template.find('.noPassword').toggle(!currentUser.password);
    }));
    // Only a storage provider can issue a recovery key. With none installed the button never appears, and
    // SillyTavern's settings panel is exactly as it always was.
    setUpNewRecoveryKeyButton(template.find('.userNewRecoveryKeyButton'));
    // Awaited nowhere: the panel opens immediately and the section appears when the server answers. Only a
    // provider-owned user sees it at all.
    void setUpIdleLockControl(template);
    template.find('.userBackupButton').on('click', function () {
        $(this).addClass('disabled');
        backupUserData(currentUser.handle, () => {
            $(this).removeClass('disabled');
        });
    });
    template.find('.userResetSettingsButton').on('click', () => resetSettings(currentUser.handle, () => location.reload()));
    template.find('.userResetAllButton').on('click', () => resetEverything(() => location.reload()));
    template.find('.userAvatarChange').on('click', () => template.find('.avatarUpload').trigger('click'));
    template.find('.avatarUpload').on('change', async function () {
        if (!(this instanceof HTMLInputElement)) {
            return;
        }

        const file = this.files[0];
        if (!file) {
            return;
        }

        await cropAndUploadAvatar(currentUser.handle, file);
        await getCurrentUser();
        template.find('.avatar img').attr('src', currentUser.avatar);
    });
    template.find('.userAvatarRemove').on('click', async function () {
        await changeAvatar(currentUser.handle, '');
        await getCurrentUser();
        template.find('.avatar img').attr('src', currentUser.avatar);
    });

    if (!accountsEnabled) {
        template.find('[data-require-accounts]').hide();
        template.find('.accountsDisabledHint').show();
    }

    const popupOptions = {
        okButton: 'Close',
        wide: false,
        large: false,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
    };
    callGenericPopup(template, POPUP_TYPE.TEXT, '', popupOptions);
}

/**
 * Crop and upload an avatar image.
 * @param {string} handle User handle
 * @param {File} file Avatar file
 * @returns {Promise<string>}
 */
async function cropAndUploadAvatar(handle, file) {
    const dataUrl = await getBase64Async(await ensureImageFormatSupported(file));
    const croppedImage = await callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage: dataUrl });
    if (!croppedImage) {
        return;
    }

    await changeAvatar(handle, String(croppedImage));

    return String(croppedImage);
}

/**
 * Change the avatar of the user.
 * @param {string} handle User handle
 * @param {string} avatar File to upload or base64 string
 * @returns {Promise<void>} Avatar URL
 */
async function changeAvatar(handle, avatar) {
    try {
        const response = await fetch('/api/users/change-avatar', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change avatar');
            return;
        }
    } catch (error) {
        console.error('Error changing avatar:', error);
    }
}

async function openAdminPanel() {
    async function renderUsers() {
        const users = await getUsers();
        template.find('.usersList').empty();
        for (const user of users) {
            const userBlock = template.find('.userAccountTemplate .userAccount').clone();
            userBlock.find('.userName').text(user.name);
            userBlock.find('.userHandle').text(user.handle);
            userBlock.find('.userStatus').text(user.enabled ? 'Enabled' : 'Disabled');
            userBlock.find('.userRole').text(user.admin ? 'Admin' : 'User');
            userBlock.find('.avatar img').attr('src', user.avatar);
            userBlock.find('.hasPassword').toggle(user.password);
            userBlock.find('.noPassword').toggle(!user.password);
            userBlock.find('.userCreated').text(new Date(user.created).toLocaleString());
            userBlock.find('.userEnableButton').toggle(!user.enabled).on('click', () => enableUser(user.handle, renderUsers));
            userBlock.find('.userDisableButton').toggle(user.enabled).on('click', () => disableUser(user.handle, renderUsers));
            userBlock.find('.userPromoteButton').toggle(!user.admin).on('click', () => promoteUser(user.handle, renderUsers));
            userBlock.find('.userDemoteButton').toggle(user.admin).on('click', () => demoteUser(user.handle, renderUsers));
            userBlock.find('.userChangePasswordButton').on('click', () => changePassword(user.handle, renderUsers));
            userBlock.find('.userDelete').on('click', () => deleteUser(user.handle, renderUsers));
            userBlock.find('.userChangeNameButton').on('click', async () => changeName(user.handle, user.name, renderUsers));
            userBlock.find('.userBackupButton').on('click', function () {
                $(this).addClass('disabled').off('click');
                backupUserData(user.handle, renderUsers);
            });
            userBlock.find('.userAvatarChange').on('click', () => userBlock.find('.avatarUpload').trigger('click'));
            userBlock.find('.avatarUpload').on('change', async function () {
                if (!(this instanceof HTMLInputElement)) {
                    return;
                }

                const file = this.files[0];
                if (!file) {
                    return;
                }

                await cropAndUploadAvatar(user.handle, file);
                renderUsers();
            });
            userBlock.find('.userAvatarRemove').on('click', async function () {
                await changeAvatar(user.handle, '');
                renderUsers();
            });
            template.find('.usersList').append(userBlock);
        }
    }

    const template = $(await renderTemplateAsync('admin'));

    template.find('.adminNav > button').on('click', function () {
        const target = String($(this).data('target-tab'));
        template.find('.navTab').each(function () {
            $(this).toggle(this.classList.contains(target));
        });
    });

    template.find('.createUserDisplayName').on('input', async function () {
        const slug = await slugify(String($(this).val()));
        template.find('.createUserHandle').val(slug);
    });

    // A blank password is refused by the server here, so the form does not offer one: the boxes say a password is
    // required and the browser will not submit them empty. Filled in when the answer arrives; the server's refusal
    // still applies if it never does.
    void isPasswordRequired().then(required => {
        if (!required) {
            return;
        }

        template.find('.createUserPassword, .createUserConfirmPassword')
            .attr('placeholder', t`Required`)
            .prop('required', true);
        template.find('.createUserPasswordRequired').show();
    });

    template.find('.userCreateForm').on('submit', function (event) {
        if (!(event.target instanceof HTMLFormElement)) {
            return;
        }

        event.preventDefault();
        createUser(event.target, () => {
            template.find('.manageUsersButton').trigger('click');
            renderUsers();
        });
    });

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false, large: false, allowVerticalScrolling: true, allowHorizontalScrolling: false });
    renderUsers();
}

/**
 * Log out the current user.
 * @returns {Promise<void>}
 */
async function logout() {
    await fetch('/api/users/logout', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    // On an explicit logout stop auto login
    // to allow user to change username even
    // when auto auth (such as authelia or basic)
    // would be valid
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('noauto', 'true');

    window.location.search = urlParams.toString();
}

/**
 * Runs a text through the slugify API endpoint.
 * @param {string} text Text to slugify
 * @returns {Promise<string>} Slugified text
 */
async function slugify(text) {
    try {
        const response = await fetch('/api/users/slugify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text }),
        });

        if (!response.ok) {
            throw new Error('Failed to slugify text');
        }

        return response.text();
    } catch (error) {
        console.error('Error slugifying text:', error);
        return text;
    }
}

/**
 * Client-side warning for the server-enforced idle lock. Polling does not count as activity; the provider
 * supplies any explanation, and a disabled or absent provider makes the poll a no-op.
 */
const IDLE_POLL_INTERVAL = 30 * 1000;
const IDLE_WARNING_MS = 60 * 1000;

/**
 * Bound the warning period to half the lock duration so short locks do not show a warning immediately.
 * @param {number} lockMs The provider's lock timeout
 * @returns {number} How long before the lock to start warning
 */
function idleWarningMs(lockMs) {
    return Math.min(IDLE_WARNING_MS, Math.floor(lockMs / 2));
}

/**
 * How long the last poll said the lock is, so the next poll can be scheduled to fit inside its warning
 * window. Null until the first answer arrives.
 * @type {number|null}
 */
let lastKnownLockMs = null;

/**
 * Poll within the warning window so short lock durations cannot be skipped between polls. The 5-second floor
 * prevents a bad server value from creating a busy loop.
 * @returns {void}
 */
function scheduleIdlePoll() {
    const window = lastKnownLockMs === null ? IDLE_POLL_INTERVAL : idleWarningMs(lastKnownLockMs) / 2;
    const delay = Math.max(5000, Math.min(IDLE_POLL_INTERVAL, window));

    setTimeout(async () => {
        try {
            await pollIdleLock();
        } finally {
            scheduleIdlePoll();
        }
    }, delay);
}

/** @type {Popup|null} The countdown modal, while it is up. */
let idlePopup = null;
/** @type {number|null} When the vault locks, in client-clock milliseconds. */
let idleDeadline = null;
/** @type {ReturnType<typeof setInterval>|null} The one-second countdown ticker. */
let idleTicker = null;
/** @type {(() => void)|null} The live countdown's own render, so a later poll can restart its ticker. */
let idleRender = null;

/**
 * The vault is shut. Nothing on this page can talk to the server any more, so stop pretending it can.
 * @returns {void}
 */
function goToLogin() {
    window.location.assign('/login');
}

/**
 * Put the countdown up, or refresh it if it is already there.
 * @param {number} msUntilLock Milliseconds until the storage locks
 * @param {import('../../src/storage.js').ProviderText|null} text The provider's own account of what is about to happen
 * @returns {Promise<void>}
 */
async function showIdleWarning(msUntilLock, text) {
    idleDeadline = Date.now() + msUntilLock;

    if (idlePopup) {
        // The countdown stops its own ticker when it reaches zero (see `render`), so a poll that comes back
        // with time still on the server's clock has to start it again — otherwise the number stays frozen
        // at "0 seconds" on a session that is, in fact, still alive.
        if (!idleTicker && idleRender) {
            idleRender();
            idleTicker = setInterval(idleRender, 1000);
        }

        return;
    }

    const content = document.createElement('div');
    content.classList.add('flex-container', 'flexFlowColumn', 'flexGap10');

    const heading = document.createElement('h3');
    heading.classList.add('marginBot5');
    heading.textContent = text?.title || t`Locking your data`;

    const countdown = document.createElement('h2');
    countdown.classList.add('marginBot5');

    // The provider explains what is about to be locked and what it will cost. SillyTavern knows only that
    // it is about to happen, so if the provider is silent, so are we — the countdown and the button still
    // say everything the user must act on.
    const prose = [text?.body, ...(text?.notes ?? [])].filter(Boolean).map(paragraph => {
        const p = document.createElement('p');
        p.classList.add('marginBot5');
        p.textContent = paragraph;
        return p;
    });

    content.append(heading, ...prose, countdown);

    // Tick the number down in front of them. A modal that says "soon" is not a warning.
    const render = () => {
        const left = Math.max(0, Math.ceil(((idleDeadline ?? 0) - Date.now()) / 1000));
        countdown.textContent = t`${left} seconds`;

        // The local deadline can be stale after activity in another tab or device. Ask the server before
        // navigating so a countdown alone cannot discard an in-progress message.
        if (left <= 0) {
            if (idleTicker) {
                clearInterval(idleTicker);
                idleTicker = null;
            }

            void pollIdleLock();
        }
    };

    idleRender = render;
    render();
    idleTicker = setInterval(render, 1000);

    idlePopup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: text?.submitLabel || t`Stay signed in`,
        cancelButton: false,
        leftAlign: true,
        // Dismissing without extending the session would hide the warning while the lock remains imminent.
        allowEscapeClose: false,
    });

    const result = await idlePopup.show();

    clearInterval(idleTicker);
    idleTicker = null;
    idleRender = null;
    idlePopup = null;

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    // "I am still here." Arriving at this route is itself the activity that resets the server's clock.
    try {
        const response = await fetch('/api/users/idle-keepalive', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            goToLogin();
        }
    } catch (error) {
        // A failed keepalive leaves the server deadline unchanged, so treat it like a rejected response.
        console.error('Could not extend the idle lock:', error);
        goToLogin();
    }
}

/**
 * Take the countdown down again — the user went and did something, so the server's clock has reset.
 * @returns {void}
 */
function dismissIdleWarning() {
    if (!idlePopup) {
        return;
    }

    if (idleTicker) {
        clearInterval(idleTicker);
        idleTicker = null;
    }

    idleRender = null;

    const popup = idlePopup;
    idlePopup = null;
    popup.complete(POPUP_RESULT.CANCELLED);
}

/**
 * Ask the server how long we have left, and warn if it is nearly up.
 * @returns {Promise<void>}
 */
async function pollIdleLock() {
    if (!currentUser) {
        return;
    }

    let status;

    try {
        const response = await fetch('/api/users/idle-status', { headers: getRequestHeaders() });

        // Already locked — by the sweep, or by a restart, or from another device. The session is gone and
        // every request from here on is a 403. Do not leave them on a dead page.
        if (response.status === 403) {
            goToLogin();
            return;
        }

        // ⚠️ TAKE THE WARNING DOWN ON THE WAY OUT OF EVERY EARLY RETURN. A poll that simply failed is not
        // evidence that the lock is imminent, but leaving the modal up means its ticker keeps running to
        // zero and then navigates away from the page — discarding whatever the user was in the middle of
        // typing, which is the loss this whole feature exists to warn them about rather than cause.
        if (!response.ok) {
            dismissIdleWarning();
            return;
        }

        status = await response.json();
    } catch (error) {
        console.error('Could not check the idle lock:', error);
        dismissIdleWarning();
        return;
    }

    // No provider, or the provider asked for no lock. There is nothing to count down to.
    if (!status.enabled) {
        lastKnownLockMs = null;
        dismissIdleWarning();
        return;
    }

    // Feeds `scheduleIdlePoll`: a short lock has a short warning window, and the poll has to fit inside it.
    lastKnownLockMs = Number.isFinite(status.idleLockMs) ? status.idleLockMs : null;

    if (status.msUntilLock > idleWarningMs(status.idleLockMs)) {
        dismissIdleWarning();
        return;
    }

    await showIdleWarning(status.msUntilLock, status.text ?? null);
}

/**
 * Pings the server to extend the user session.
 */
async function extendUserSession() {
    try {
        const response = await fetch('/api/ping?extend=1', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            throw new Error('Ping did not succeed', { cause: response.status });
        }
    } catch (error) {
        console.error('Failed to extend user session', error);
    }
}

jQuery(() => {
    $('#logout_button').on('click', () => {
        logout();
    });
    $('#admin_button').on('click', () => {
        openAdminPanel();
    });
    $('#account_button').on('click', () => {
        openUserProfile();
    });
    // 🪪 Surface 5 (DESIGN_STORAGE_PROVENANCE.md §7): the one panel that answers "I uninstalled something —
    // what did it take with it?" across the whole account. On demand, behind this button, per §11.3.
    $('#storage_summary_button').on('click', () => {
        openStorageProvenancePanel();
    });
    setInterval(async () => {
        if (currentUser) {
            await extendUserSession();
        }
    }, SESSION_EXTEND_INTERVAL);

    // 🔒 Watch for the idle lock, so it arrives as a warning rather than as a mysterious logout.
    scheduleIdlePoll();
});
