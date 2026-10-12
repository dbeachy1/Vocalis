/**
 * The ComfyUI HTTP basic-auth credential.
 *
 * This is three lines and it still lives in its own module, because `index.js` transitively imports the
 * whole application and therefore cannot be loaded under jest — the same reason
 * `chat-storage-marker-logic.js` and `plugin-prompts.js` exist. The rule below is the entire security
 * contract of the ComfyUI auth feature, and asserting it by eye in a 6000-line file is how it gets
 * quietly broken later.
 */

/**
 * Compose the credential to send to ComfyUI, in the `username:password` wire format the server's
 * `getBasicAuthHeader` expects — the same shape `auto`, `vlad` and `drawthings` already send.
 *
 * 🔴 THE CHECKBOX IS THE ONLY THING THAT DECIDES, AND AN UNCHECKED BOX SENDS NOTHING.
 *
 * The username and password deliberately SURVIVE unchecking, so that turning authentication back on
 * does not mean retyping them. That convenience is exactly what makes this dangerous: with the fields
 * still populated, any implementation that keys off "is there a username?" instead of "is the box
 * ticked?" keeps sending a live credential to a server the user has just told it not to authenticate
 * against. Off has to mean byte-for-byte what this endpoint did before it could authenticate at all.
 * @param {object} settings The `extension_settings.sd` object
 * @returns {string} `username:password`, or '' when authentication is off
 */
export function getComfyAuthCredential(settings) {
    if (!settings?.comfy_auth_enabled) {
        return '';
    }

    return `${settings.comfy_auth_username ?? ''}:${settings.comfy_auth_password ?? ''}`;
}
