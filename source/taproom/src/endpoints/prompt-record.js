/**
 * Read back what was actually sent — the client-facing half of `prompt-record.js`.
 *
 * The recorder sits in the four backend endpoints and captures each outgoing prompt after any server plugin
 * has rewritten it. This is where a browser extension asks what it captured.
 *
 * 🔴 A USER READS THEIR OWN RECORDS AND NOBODY ELSE'S. The handle comes from the authenticated session, never
 * from a parameter — there is no route here that takes a handle, because a route that took one would be a
 * route that could be asked for someone else's conversation. On a multi-account install that is the whole
 * security model of this feature, and it is enforced by there being no other way to address the store.
 *
 * ⚠️ `supported: true` IS THE POINT OF THE ENVELOPE, NOT DECORATION. An extension has to distinguish "this
 * fork does not have the feature" (404, older build) from "it has it and there is nothing recorded yet"
 * (200, empty array). Those demand different UI — the first degrades permanently, the second resolves on the
 * next generation — and a bare array cannot tell them apart.
 */

import express from 'express';

import { getRecords, PROMPT_HISTORY_DEPTH } from '../prompt-record.js';

export const router = express.Router();

/** The backend families the recorder knows, matching what the four endpoints pass in. */
const KNOWN_BACKENDS = ['text', 'chat', 'kobold', 'novel'];

/**
 * What was sent, most recent last.
 *
 * ⚠️ THE PROMPT TEXT IS IN THIS RESPONSE, WHICH IS WHY THE ROUTE IS SHAPED THE WAY IT IS. It goes only to the
 * session that produced it, over the same channel that carried the prompt in the first place, so it crosses
 * no boundary the prompt had not already crossed. That is the argument for it being safe; it stops being true
 * the moment anything here accepts a handle, so nothing here ever will.
 */
router.get('/:backend', function (request, response) {
    const backend = String(request.params.backend);

    if (!KNOWN_BACKENDS.includes(backend)) {
        return response.status(400).send({
            error: true,
            response: `Unknown backend '${backend}'. Expected one of: ${KNOWN_BACKENDS.join(', ')}.`,
        });
    }

    const records = getRecords(request.user?.profile?.handle, backend);

    return response.send({
        supported: true,
        depth: PROMPT_HISTORY_DEPTH,
        backend: backend,
        records: records,
    });
});

/**
 * The probe an extension makes on load, and the cheap one — no prompt text in the reply.
 *
 * Without this, discovering whether the fork has the feature means asking for a backend's records and
 * receiving up to five prompts to answer a yes/no question.
 */
router.get('/', function (_request, response) {
    return response.send({
        supported: true,
        depth: PROMPT_HISTORY_DEPTH,
        backends: KNOWN_BACKENDS,
    });
});
