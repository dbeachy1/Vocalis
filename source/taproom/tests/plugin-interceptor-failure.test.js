import { describe, test, expect, beforeEach, afterAll, jest } from '@jest/globals';

import {
    clearPromptInterceptors,
    onPrompt,
    runPromptInterceptors,
} from '../src/generation-interceptors.js';
import { log } from '../src/logger.js';

/**
 * 🔴 A PLUGIN THAT TRIED AND FAILED REFUSES THE GENERATION. ONE THAT DECLINES DOES NOT.
 *
 * The seam used to log a failing interceptor and send the prompt anyway, on the reasoning that one plugin's
 * bug must not cost the user their chat. Look at what that actually produced: the client has already sent a
 * complete, valid prompt, so the generation SUCCEEDS — the model answers, the reply looks entirely ordinary,
 * and the only thing missing is the memory the plugin was going to inject. Nothing downstream can tell.
 *
 * That is word for word the failure `DESIGN_MEMORY_PLUGIN_API.md` §6.5 exists to forbid ("the user sees a
 * model with no memory and no error anywhere"), and it is the same outcome a HUNG interceptor produces — so
 * the two cannot sensibly have opposite answers. All three shapes now throw, and every calling route turns
 * that into a 500 the user can see and report.
 *
 * The distinction that makes refusing safe is DECLINING, and it is the first thing asserted below: a handler
 * returning nothing has said "not my backend", which is how a chat-only plugin sits out a text generation.
 * If that ever started failing too, a mixed-backend install would stop working entirely.
 */
describe('🔴 an interceptor that fails refuses the generation', () => {
    beforeEach(() => {
        clearPromptInterceptors();
        // The seam logs against the plugin id on every one of these paths. Silence the writer rather than
        // the assertions: what is under test is the control flow, and a spec that printed six stack traces
        // per run would train everyone to ignore its output.
        jest.spyOn(log, 'error').mockImplementation(() => { });
    });

    afterAll(() => {
        clearPromptInterceptors();
        jest.restoreAllMocks();
    });

    const text = () => ({ handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p' });
    const chat = () => ({ handle: 'test-user', backend: 'chat', apiType: 'openai', messages: [{ role: 'user', content: 'p' }] });

    test('🔴 DECLINING IS NOT FAILING — returning nothing leaves the prompt alone and the chain running', async () => {
        let secondRan = false;

        onPrompt('chat-only', async () => undefined);
        onPrompt('after', async (outgoing) => { secondRan = true; return `INJECTED ${outgoing.prompt}`; });

        const result = await runPromptInterceptors(text());

        expect(secondRan).toBe(true);
        expect(result.prompt).toBe('INJECTED p');
    });

    test('a handler returning null declines too — absent and empty are the same intent here', async () => {
        onPrompt('null-decliner', async () => null);

        const result = await runPromptInterceptors(text());

        expect(result.prompt).toBe('p');
    });

    test('🔴 a handler that THROWS refuses the generation rather than sending it unaugmented', async () => {
        onPrompt('broken', async () => { throw new Error('the vector store is down'); });

        await expect(runPromptInterceptors(text())).rejects.toThrow(/vector store is down/);
    });

    test('🔴 the throw names the plugin, because an anonymous stack from a prompt hook is unusable', async () => {
        onPrompt('memory-plugin', async () => { throw new Error('boom'); });

        await runPromptInterceptors(text()).catch(() => { });

        const said = /** @type {any} */ (log.error).mock.calls.map(call => call.join(' ')).join('\n');
        expect(said).toContain('memory-plugin');
    });

    test('🔴 a later plugin never runs once an earlier one has failed — the prompt is already refused', async () => {
        let laterRan = false;

        onPrompt('broken', async () => { throw new Error('boom'); });
        onPrompt('later', async () => { laterRan = true; return 'never used'; });

        await expect(runPromptInterceptors(text())).rejects.toThrow();
        expect(laterRan).toBe(false);
    });

    test('a string returned where messages[] was given refuses, rather than reaching a vendor converter', async () => {
        onPrompt('confused', async () => 'I thought this was the text path');

        await expect(runPromptInterceptors(chat())).rejects.toThrow(/returned string/i);
    });

    test('an array of malformed turns refuses — Array.isArray alone was only half a shape check', async () => {
        onPrompt('malformed', async () => [{ role: 'system' }, null, 'text']);

        await expect(runPromptInterceptors(chat())).rejects.toThrow(/not well-formed/i);
    });

    test('🔴 SILLYTAVERN\'S OWN TOOL-CALL MESSAGE HAS NO content, AND IS NOT MALFORMED', async () => {
        // The client serializes an assistant tool-call turn as `{role, tool_calls}` with `content` undefined
        // (`openai.js:getChat`). The interceptor must accept this valid message shape.
        const withToolCall = () => ({
            handle: 'test-user', backend: 'chat', apiType: 'custom',
            messages: [
                { role: 'user', content: 'try the memory plugin now' },
                { role: 'assistant', content: undefined, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_projects', arguments: '{}' } }] },
                { role: 'tool', content: '{"projects":[]}', tool_call_id: 'call_1' },
            ],
        });
        onPrompt('mnemosyne', async (outgoing) => {
            const messages = outgoing.messages.slice();
            messages.splice(messages.length - 1, 0, { role: 'system', content: 'memory' });
            return messages;
        });

        const result = await runPromptInterceptors(withToolCall());

        expect(result.messages).toHaveLength(4);
        expect(result.messages[1].tool_calls).toHaveLength(1);
        expect(result.messages[2]).toEqual({ role: 'system', content: 'memory' });
    });

    test('a non-string returned on the text path refuses', async () => {
        onPrompt('confused', async () => ({ prompt: 'an object, not a string' }));

        await expect(runPromptInterceptors(text())).rejects.toThrow(/returned object/i);
    });

    test('🔴 AND A WELL-FORMED RETURN STILL WORKS — otherwise the assertions above pass on a broken seam', async () => {
        onPrompt('good-text', async (outgoing) => `INJECTED ${outgoing.prompt}`);
        const textResult = await runPromptInterceptors(text());
        expect(textResult.prompt).toBe('INJECTED p');

        clearPromptInterceptors();

        onPrompt('good-chat', async (outgoing) => [...outgoing.messages, { role: 'system', content: 'memory' }]);
        const chatResult = await runPromptInterceptors(chat());
        expect(chatResult.messages).toHaveLength(2);
        expect(chatResult.messages[1]).toEqual({ role: 'system', content: 'memory' });
    });
});
