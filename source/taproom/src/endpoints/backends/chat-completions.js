/* eslint-disable dot-notation */
import process from 'node:process';
import util from 'node:util';
import express from 'express';
import fetch from 'node-fetch';
import urlJoin from 'url-join';

import { hasPromptInterceptors, runPromptInterceptors, readIdentityHeaders, takeRecentMessages, REWRITTEN_BY, REWRITE_SITES } from '../../generation-interceptors.js';
import { recordOutgoingPrompt, finalizePromptRecord } from '../../prompt-record.js';
import { normalizeDeepSeekChatUsage, createDeepSeekUsageObserver } from '../../deepseek-usage.js';

import {
    AIMLAPI_HEADERS,
    AZURE_OPENAI_KEYS,
    CHAT_COMPLETION_SOURCES,
    GEMINI_SAFETY,
    NANOGPT_REASONING_EFFORT_MAP,
    OPENAI_FIXED_REASONING_EFFORT,
    OPENAI_REASONING_EFFORT_MAP,
    OPENAI_REASONING_EFFORT_MODELS,
    OPENAI_VERBOSITY_MODELS,
    VERTEX_SAFETY,
    SILICONFLOW_ENDPOINT,
    MINIMAX_ENDPOINT,
    ZAI_ENDPOINT,
    POLLINATIONS_ENDPOINT,
} from '../../constants.js';
import {
    forwardFetchResponse,
    getConfigValue,
    tryParse,
    uuidv4,
    mergeObjectWithYaml,
    excludeKeysByYaml,
    color,
    trimTrailingSlash,
    flattenSchema,
} from '../../util.js';
import {
    convertClaudeMessages,
    convertGooglePrompt,
    convertTextCompletionPrompt,
    convertCohereMessages,
    convertMistralMessages,
    convertAI21Messages,
    convertXAIMessages,
    cachingAtDepthForOpenRouterClaude,
    cachingAtDepthForClaude,
    getPromptNames,
    calculateClaudeBudgetTokens,
    calculateGoogleBudgetTokens,
    postProcessPrompt,
    PROMPT_PROCESSING_TYPE,
    addAssistantPrefix,
    embedOpenRouterMedia,
    addReasoningContentToToolCalls,
    cachingSystemPromptForOpenRouter,
    addOpenRouterSignatures,
} from '../../prompt-converters.js';

import { readSecret, SECRET_KEYS } from '../secrets.js';
import { captureConnection } from '../../plugin-generate.js';
import { resolveOpenAiWireChatSource } from '../../chat-source.js';
import { readCachedModelList, writeCachedModelList } from '../../model-list-cache.js';
import {
    getTokenizerModel,
    getSentencepiceTokenizer,
    getTiktokenTokenizer,
    sentencepieceTokenizers,
    TEXT_COMPLETION_MODELS,
    webTokenizers,
    getWebTokenizer,
} from '../tokenizers.js';
import { getVertexAIAuth, getProjectIdFromServiceAccount } from '../google.js';
import { log, LogClass } from '../../logger.js';

// The OpenAI, OpenRouter and Custom base URLs live in chat-source.js (plugin API 8), shared with `generate()`.
const API_CLAUDE = 'https://api.anthropic.com/v1';
const API_MISTRAL = 'https://api.mistral.ai/v1';
const API_COHERE_V1 = 'https://api.cohere.ai/v1';
const API_COHERE_V2 = 'https://api.cohere.ai/v2';
const API_PERPLEXITY = 'https://api.perplexity.ai';
const API_GROQ = 'https://api.groq.com/openai/v1';
const API_MAKERSUITE = 'https://generativelanguage.googleapis.com';
const API_VERTEX_AI = 'https://us-central1-aiplatform.googleapis.com';
const API_AI21 = 'https://api.ai21.com/studio/v1';
const API_CHUTES = 'https://llm.chutes.ai/v1';
const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';
const API_NANOGPT = 'https://nano-gpt.com/api/v1';
const API_DEEPSEEK = 'https://api.deepseek.com/beta';
const API_XAI = 'https://api.x.ai/v1';
const API_AIMLAPI = 'https://api.aimlapi.com/v1';
const API_POLLINATIONS = 'https://gen.pollinations.ai/v1';
const API_POLLINATIONS_ANON = 'https://text.pollinations.ai/v1';
const API_MOONSHOT = 'https://api.moonshot.ai/v1';
const API_FIREWORKS = 'https://api.fireworks.ai/inference/v1';
const API_COMETAPI = 'https://api.cometapi.com/v1';
const API_ZAI_COMMON = 'https://api.z.ai/api/paas/v4';
const API_ZAI_CODING = 'https://api.z.ai/api/coding/paas/v4';
const API_SILICONFLOW = 'https://api.siliconflow.com/v1';
const API_SILICONFLOW_CN = 'https://api.siliconflow.cn/v1';
const API_MINIMAX = 'https://api.minimax.io/v1';
const API_MINIMAX_CN = 'https://api.minimaxi.com/v1';
const API_OPENROUTER = 'https://openrouter.ai/api/v1';
const API_WORKERS_AI = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Module-scoped Claude caching configuration values.
 */
const cacheTTL = getConfigValue('claude.extendedTTL', false, 'boolean') ? '1h' : '5m';
const enableSystemPromptCache = getConfigValue('claude.enableSystemPromptCache', false, 'boolean');
const cachingAtDepth = (() => {
    const value = getConfigValue('claude.cachingAtDepth', -1, 'number');
    return Number.isInteger(value) && value >= 0 ? value : -1;
})();
const enableAdaptiveThinking = getConfigValue('claude.enableAdaptiveThinking', true, 'boolean');

/**
 * Cache for cacheable (writing) OpenRouter model IDs.
 * @type {string[]}
 */
const openRouterCacheableModels = [];

/**
 * Checks if an OpenRouter model supports prompt cache writing.
 * Uses a cache to avoid repeated API calls.
 * @param {string} modelId - The OpenRouter model ID
 * @returns {Promise<boolean>} `true` if the model supports writing cache
 */
async function isOpenRouterModelCacheable(modelId) {
    if (openRouterCacheableModels.includes(modelId)) {
        return true;
    }

    try {
        const response = await fetch(`${API_OPENROUTER}/models`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            log.warn(LogClass.NORMAL, `OpenRouter models API returned ${response.status}: ${response.statusText}`);
            return false;
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            log.warn(LogClass.NORMAL, 'OpenRouter API response format unexpected');
            return false;
        }

        const model = data.data.find(m => m.id === modelId);
        const supportsCache = model?.pricing?.input_cache_write != null;

        if (supportsCache) {
            openRouterCacheableModels.push(modelId);
        }

        return supportsCache;
    } catch (error) {
        log.warn(LogClass.SENSITIVE, `Failed to check OpenRouter cache support for ${modelId}:`, error.message);
        return false;
    }
}

/**
 * Gets OpenRouter transforms based on the request.
 * @param {import('express').Request} request Express request
 * @returns {string[] | undefined} OpenRouter transforms
 */
function getOpenRouterTransforms(request) {
    switch (request.body.middleout) {
        case 'on':
            return ['middle-out'];
        case 'off':
            return [];
        case 'auto':
            return undefined;
    }
}

/**
 * Gets OpenRouter plugins based on the request.
 * @param {import('express').Request} request
 * @returns {any[]} OpenRouter plugins
 */
function getOpenRouterPlugins(request) {
    const plugins = [];

    if (request.body.enable_web_search) {
        plugins.push({ 'id': 'web' });
    }

    return plugins;
}

/**
 * Hacky way to use JSON schema only if json_object format is supported.
 * @param {object} bodyParams Additional body parameters
 * @param {object[]} messages Array of messages
 * @param {object} jsonSchema JSON schema object
 */
function setJsonObjectFormat(bodyParams, messages, jsonSchema) {
    bodyParams['response_format'] = {
        type: 'json_object',
    };
    const message = {
        role: 'user',
        content: `JSON schema for the response:\n${JSON.stringify(jsonSchema.value, null, 4)}`,
    };
    messages.push(message);
}

/**
 * Sends a request to Claude API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendClaudeRequest(request, response) {
    const apiUrl = new URL(request.body.reverse_proxy || API_CLAUDE).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.CLAUDE, request.body.secret_id);
    const divider = '-'.repeat(process.stdout.columns);

    if (!apiKey) {
        log.warn(LogClass.NORMAL, color.red(`Claude API key is missing.\n${divider}`));
        return response.status(400).send({ error: true });
    }

    try {
        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            controller.abort();
        });
        const additionalHeaders = {};
        const betaHeaders = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
        const useTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
        const useSystemPrompt = Boolean(request.body.use_sysprompt);
        const convertedPrompt = convertClaudeMessages(request.body.messages, request.body.assistant_prefill, useSystemPrompt, useTools, getPromptNames(request));
        // Unanchored to also match prefixed ids passed through proxies, e.g. 'anthropic/claude-fable-5'
        const isFableModel = /claude-fable/.test(request.body.model);
        const useThinking = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/.test(request.body.model) || isFableModel;
        const useWebSearch = (/^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/.test(request.body.model) || isFableModel) && Boolean(request.body.enable_web_search);
        const isLimitedSampling = /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(request.body.model);
        const useVerbosity = /^claude-(opus-4-5|opus-4-6|sonnet-4-6|opus-4-7|opus-4-8)/.test(request.body.model) || isFableModel;
        const noPrefillModel = /^claude-(opus-4-6|sonnet-4-6|opus-4-7|opus-4-8)/.test(request.body.model) || isFableModel;
        const isAdaptiveModel = /^claude-(opus-4-7|opus-4-8)/.test(request.body.model) || isFableModel || (enableAdaptiveThinking && /^claude-(opus-4-6|sonnet-4-6)/.test(request.body.model));
        const noSamplingModel = /^claude-(opus-4-7|opus-4-8)/.test(request.body.model) || isFableModel;
        let fixThinkingPrefill = false;
        // Add custom stop sequences
        const stopSequences = [];
        if (Array.isArray(request.body.stop)) {
            stopSequences.push(...request.body.stop);
        }

        const requestBody = {
            /** @type {any} */ system: [],
            messages: convertedPrompt.messages,
            model: request.body.model,
            max_tokens: request.body.max_tokens,
            stop_sequences: stopSequences,
            temperature: request.body.temperature,
            top_p: request.body.top_p,
            top_k: request.body.top_k,
            stream: request.body.stream,
        };
        if (useSystemPrompt) {
            if (enableSystemPromptCache && Array.isArray(convertedPrompt.systemPrompt) && convertedPrompt.systemPrompt.length) {
                convertedPrompt.systemPrompt[convertedPrompt.systemPrompt.length - 1].cache_control = { type: 'ephemeral', ttl: cacheTTL };
            }

            requestBody.system = convertedPrompt.systemPrompt;
        } else {
            delete requestBody.system;
        }
        if (useTools) {
            betaHeaders.push('tools-2024-05-16');
            requestBody.tool_choice = { type: request.body.tool_choice };
            requestBody.tools = request.body.tools
                .filter(tool => tool.type === 'function')
                .map(tool => tool.function)
                .map(fn => ({ name: fn.name, description: fn.description, input_schema: flattenSchema(fn.parameters, request.body.chat_completion_source) }));

            if (enableSystemPromptCache && requestBody.tools.length) {
                requestBody.tools[requestBody.tools.length - 1].cache_control = { type: 'ephemeral', ttl: cacheTTL };
            }
        }

        // Structured output is a forced tool
        if (request.body.json_schema) {
            const jsonTool = {
                name: request.body.json_schema.name,
                description: request.body.json_schema.description || 'Well-formed JSON object',
                input_schema: request.body.json_schema.value,
            };
            requestBody.tools = [...(requestBody.tools || []), jsonTool];
            requestBody.tool_choice = { type: 'tool', name: request.body.json_schema.name };
        }

        if (useWebSearch) {
            const webSearchTool = [{
                'type': 'web_search_20250305',
                'name': 'web_search',
            }];
            requestBody.tools = [...webSearchTool, ...(requestBody.tools || [])];
        }

        if (cachingAtDepth !== -1) {
            cachingAtDepthForClaude(convertedPrompt.messages, cachingAtDepth, cacheTTL);
        }

        if (enableSystemPromptCache || cachingAtDepth !== -1) {
            betaHeaders.push('prompt-caching-2024-07-31');
            betaHeaders.push('extended-cache-ttl-2025-04-11');
        }

        if (isLimitedSampling) {
            if (requestBody.top_p < 1) {
                delete requestBody.temperature;
            } else {
                delete requestBody.top_p;
            }
        }

        if (noSamplingModel) {
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        }

        const reasoningEffort = request.body.reasoning_effort;
        const includeReasoning = Boolean(request.body.include_reasoning);
        const budgetTokens = calculateClaudeBudgetTokens(requestBody.max_tokens, reasoningEffort, requestBody.stream, isAdaptiveModel);

        // Adaptive thinking: returns a string effort level (like Gemini 3)
        if (useThinking && typeof budgetTokens === 'string') {
            fixThinkingPrefill = true;
            requestBody.thinking = { type: 'adaptive' };
            if (noSamplingModel && includeReasoning) {
                requestBody.thinking.display = 'summarized';
            }
            requestBody.output_config ??= {};
            requestBody.output_config.effort = budgetTokens;
            // top_k is not allowed in adaptive mode
            delete requestBody.top_k;
        } else if (useThinking && isFableModel && reasoningEffort === 'auto' && includeReasoning) {
            // Fable auto thinking is already enabled, but readable summaries require an explicit display request.
            fixThinkingPrefill = true;
            requestBody.thinking = { type: 'adaptive', display: 'summarized' };
        } else if (useThinking && Number.isInteger(budgetTokens)) {
            // Traditional thinking: returns a numeric budget
            fixThinkingPrefill = true;
            const minThinkTokens = 1024;
            if (requestBody.max_tokens <= minThinkTokens) {
                const newValue = requestBody.max_tokens + minThinkTokens;
                log.warn(LogClass.NORMAL, color.yellow(`Claude thinking requires a minimum of ${minThinkTokens} response tokens.`));
                log.info(LogClass.NORMAL, color.blue(`Increasing response length to ${newValue}.`));
                requestBody.max_tokens = newValue;
            }
            requestBody.thinking = {
                type: 'enabled',
                budget_tokens: budgetTokens,
            };

            // NO I CAN'T SILENTLY IGNORE THE TEMPERATURE.
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        }

        if ((fixThinkingPrefill || noPrefillModel) && convertedPrompt.messages.length && convertedPrompt.messages[convertedPrompt.messages.length - 1].role === 'assistant') {
            convertedPrompt.messages[convertedPrompt.messages.length - 1].role = 'user';
        }

        // Verbosity = 'effort' (same values as OpenAI) - only if not already set by adaptive thinking
        if (useVerbosity && request.body.verbosity && !requestBody.output_config?.effort) {
            betaHeaders.push('effort-2025-11-24');
            requestBody.output_config ??= {};
            requestBody.output_config.effort = request.body.verbosity;
        }

        if (betaHeaders.length) {
            additionalHeaders['anthropic-beta'] = betaHeaders.join(',');
        }

        log.debug(LogClass.SENSITIVE, 'Claude request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/messages', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': apiKey,
                ...additionalHeaders,
            },
        });

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response
            await forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const generateResponseText = await generateResponse.text();
                log.warn(LogClass.NORMAL, color.red(`Claude API returned error: ${generateResponse.status} ${generateResponse.statusText}\n${divider}`));
                log.warn(LogClass.SENSITIVE, 'Claude API error body:', generateResponseText);
                return response.status(500).send({ error: true });
            }

            /** @type {any} */
            const generateResponseJson = await generateResponse.json();
            const responseText = generateResponseJson?.content?.[0]?.text || '';
            log.debug(LogClass.SENSITIVE, 'Claude response:', generateResponseJson);

            // Wrap it back to OAI format + save the original content
            const reply = { choices: [{ 'message': { 'content': responseText } }], content: generateResponseJson.content };
            return response.send(reply);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, color.red(`Error communicating with Claude\n${divider}`));
        log.error(LogClass.SENSITIVE, color.red(`Error communicating with Claude: ${error}`));
        if (!response.headersSent) {
            return response.status(500).send({ error: true });
        }
    }
}

/**
 * Sends a request to Google AI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendMakerSuiteRequest(request, response) {
    const useVertexAi = request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.VERTEXAI;
    const apiName = useVertexAi ? 'Google Vertex AI' : 'Google AI Studio';
    let apiUrl;
    let apiKey;

    let authHeader;
    let authType;

    if (useVertexAi) {
        apiUrl = new URL(request.body.reverse_proxy || API_VERTEX_AI);

        try {
            const auth = await getVertexAIAuth(request);
            authHeader = auth.authHeader;
            authType = auth.authType;
            log.debug(LogClass.NORMAL, `Using Vertex AI authentication type: ${authType}`);
        } catch (error) {
            log.warn(LogClass.SENSITIVE, `${apiName} authentication failed: ${error.message}`);
            return response.status(400).send({ error: true, message: error.message });
        }
    } else {
        apiUrl = new URL(request.body.reverse_proxy || API_MAKERSUITE);
        apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MAKERSUITE, request.body.secret_id);

        if (!request.body.reverse_proxy && !apiKey) {
            log.warn(LogClass.NORMAL, `${apiName} API key is missing.`);
            return response.status(400).send({ error: true });
        }

        authHeader = `Bearer ${apiKey}`;
        authType = 'api_key';
    }

    const model = String(request.body.model);
    const stream = Boolean(request.body.stream);
    const enableWebSearch = Boolean(request.body.enable_web_search);
    const requestImages = Boolean(request.body.request_images);
    const reasoningEffort = String(request.body.reasoning_effort);
    const includeReasoning = Boolean(request.body.include_reasoning);
    const aspectRatio = String(request.body.request_image_aspect_ratio);
    const imageSize = String(request.body.request_image_resolution);
    const isGemma3 = /gemma-3/.test(model);
    const isLearnLM = model.includes('learnlm');

    const responseMimeType = request.body.responseMimeType ?? (request.body.json_schema ? 'application/json' : undefined);
    const responseSchema = request.body.responseSchema ?? (request.body.json_schema ? request.body.json_schema.value : undefined);

    const generationConfig = {
        stopSequences: request.body.stop,
        candidateCount: 1,
        maxOutputTokens: request.body.max_tokens,
        temperature: request.body.temperature,
        topP: request.body.top_p,
        topK: request.body.top_k || undefined,
        responseMimeType: responseMimeType,
        responseSchema: responseSchema,
        seed: request.body.seed,
    };

    function getGeminiBody() {
        // #region UGLY MODEL LISTS AREA
        const imageGenerationModels = [
            'gemini-2.0-flash-exp',
            'gemini-2.0-flash-exp-image-generation',
            'gemini-2.0-flash-preview-image-generation',
            'gemini-2.5-flash-image-preview',
            'gemini-2.5-flash-image',
            'gemini-3-pro-image',
            'gemini-3.1-flash-image',
        ];

        const isThinkingConfigModel = m => (/^gemini-2.5-(flash|pro)/.test(m) && !/-image(-preview)?$/.test(m)) || (/^gemini-3[.\d]*-(flash|pro)/.test(m));
        const isImageSizeModel = m => /^gemini-3/.test(m);

        const noSearchModels = [
            'gemini-2.0-flash-lite',
            'gemini-2.0-flash-lite-001',
            'gemini-2.0-flash-lite-preview-02-05',
            'gemini-robotics-er-1.5-preview',
        ];
        // #endregion

        if (!Array.isArray(generationConfig.stopSequences) || !generationConfig.stopSequences.length) {
            delete generationConfig.stopSequences;
        }

        const enableImageModality = requestImages && imageGenerationModels.includes(model);
        const enableImageConfig = enableImageModality && (aspectRatio || imageSize);
        if (enableImageModality) {
            generationConfig.responseModalities = ['text', 'image'];
            if (enableImageConfig) {
                generationConfig.imageConfig = {};
                if (imageSize && isImageSizeModel(model)) {
                    generationConfig.imageConfig.imageSize = imageSize;
                }
                if (aspectRatio) {
                    generationConfig.imageConfig.aspectRatio = aspectRatio;
                }
            }
        }

        const useSystemPrompt = !enableImageModality && !isGemma3 && request.body.use_sysprompt;

        const tools = [];
        const prompt = convertGooglePrompt(request.body.messages, model, useSystemPrompt, getPromptNames(request));
        const safetySettings = [...GEMINI_SAFETY, ...(useVertexAi ? VERTEX_SAFETY : [])];

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0 && !enableImageModality && !isGemma3) {
            const functionDeclarations = [];
            const customTools = [];
            for (const tool of request.body.tools) {
                if (tool.type === 'function') {
                    if (tool.function.parameters?.$schema) {
                        delete tool.function.parameters.$schema;
                    }
                    if (tool.function.parameters?.properties && Object.keys(tool.function.parameters.properties).length === 0) {
                        delete tool.function.parameters;
                    }
                    functionDeclarations.push(tool.function);
                } else if (tool[tool.type]) {
                    customTools.push({ [tool.type]: tool[tool.type] });
                }
            }
            if (functionDeclarations.length > 0) {
                tools.push({ function_declarations: functionDeclarations });
            }
            // Custom tools are only supported when no function calling is present
            if (functionDeclarations.length === 0 && customTools.length > 0) {
                tools.push(...customTools);
            }
        }

        if (enableWebSearch && !enableImageModality && !isGemma3 && !isLearnLM && !noSearchModels.includes(model)) {
            // Tool use with function calling is unsupported
            if (!tools.some(t => t.function_declarations)) {
                tools.push({ google_search: {} });
            }
        }

        if (isThinkingConfigModel(model)) {
            const thinkingConfig = { includeThoughts: includeReasoning };

            const thinkingBudget = calculateGoogleBudgetTokens(generationConfig.maxOutputTokens, reasoningEffort, model);
            if (typeof thinkingBudget === 'number' && Number.isInteger(thinkingBudget)) {
                thinkingConfig.thinkingBudget = thinkingBudget;
            }

            if (typeof thinkingBudget === 'string' && thinkingBudget.length > 0) {
                thinkingConfig.thinkingLevel = thinkingBudget;
            }

            // Vertex doesn't allow mixing disabled thinking with includeThoughts
            if (useVertexAi && thinkingBudget === 0 && thinkingConfig.includeThoughts) {
                log.info(LogClass.NORMAL, 'Thinking budget is 0, but includeThoughts is true. Thoughts will not be included in the response.');
                thinkingConfig.includeThoughts = false;
            }

            generationConfig.thinkingConfig = thinkingConfig;
        }

        let body = {
            contents: prompt.contents,
            safetySettings: safetySettings,
            generationConfig: generationConfig,
        };

        if (useSystemPrompt && Array.isArray(prompt.system_instruction.parts) && prompt.system_instruction.parts.length) {
            body.systemInstruction = prompt.system_instruction;
        }

        if (tools.length) {
            body.tools = tools;

            const toolChoice = request.body.tool_choice;
            let functionCallingConfig;

            // Translate OpenAI's `tool_choice` to Gemini's `functionCallingConfig`
            if (typeof toolChoice === 'string') {
                switch (toolChoice) {
                    case 'none':
                        functionCallingConfig = { mode: 'NONE' };
                        break;
                    case 'required':
                        functionCallingConfig = { mode: 'ANY' };
                        break;
                    case 'auto':
                        functionCallingConfig = { mode: 'AUTO' };
                        break;
                }
            } else if (typeof toolChoice === 'object' && toolChoice?.function?.name) {
                // Force a specific function call
                functionCallingConfig = {
                    mode: 'ANY',
                    allowedFunctionNames: [toolChoice.function.name],
                };
            }

            if (functionCallingConfig) {
                body.toolConfig = { functionCallingConfig };
            }
        }

        return body;
    }

    const body = getGeminiBody();
    log.debug(LogClass.SENSITIVE, `${apiName} request:`, body);

    try {
        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            controller.abort();
        });

        const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
        const responseType = (stream ? 'streamGenerateContent' : 'generateContent');

        let url;
        let headers = {
            'Content-Type': 'application/json',
        };

        if (useVertexAi) {
            if (authType === 'express') {
                // For Express mode (API key authentication), use the key parameter
                const keyParam = authHeader.replace('Bearer ', '');
                const region = request.body.vertexai_region || 'us-central1';
                const projectId = request.body.vertexai_express_project_id;
                const baseUrl = region === 'global'
                    ? 'https://aiplatform.googleapis.com'
                    : `https://${region}-aiplatform.googleapis.com`;
                url = projectId
                    ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`
                    : `${baseUrl}/v1/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`;
            } else if (authType === 'full') {
                // For Full mode (service account authentication), use project-specific URL
                // Get project ID from Service Account JSON
                const serviceAccountJson = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, request.body.secret_id);
                if (!serviceAccountJson) {
                    log.warn(LogClass.NORMAL, 'Vertex AI Service Account JSON is missing.');
                    return response.status(400).send({ error: true });
                }

                let projectId;
                try {
                    const serviceAccount = JSON.parse(serviceAccountJson);
                    projectId = getProjectIdFromServiceAccount(serviceAccount);
                } catch (error) {
                    log.error(LogClass.NORMAL, 'Failed to extract the project ID from the Vertex AI Service Account JSON');
                    log.error(LogClass.SENSITIVE, 'Failed to extract project ID from Service Account JSON:', error);
                    return response.status(400).send({ error: true });
                }
                const region = request.body.vertexai_region || 'us-central1';
                // Handle global region differently - no region prefix in hostname
                if (region === 'global') {
                    url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                } else {
                    url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                }
                headers['Authorization'] = authHeader;
            } else {
                // For proxy mode, use the original URL with Authorization header
                url = `${apiUrl.toString().replace(/\/$/, '')}/v1/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                headers['Authorization'] = authHeader;
            }
        } else {
            url = `${apiUrl.toString().replace(/\/$/, '')}/${apiVersion}/models/${model}:${responseType}?key=${apiKey}${stream ? '&alt=sse' : ''}`;
        }

        const generateResponse = await fetch(url, {
            body: JSON.stringify(body),
            method: 'POST',
            headers: headers,
            signal: controller.signal,
        });

        if (stream) {
            try {
                // Pipe remote SSE stream to Express response
                await forwardFetchResponse(generateResponse, response);
            } catch (error) {
                log.error(LogClass.NORMAL, `Error forwarding the ${apiName} streaming response to the client`);
                log.error(LogClass.SENSITIVE, 'Error forwarding streaming response:', error);
                if (!response.headersSent) {
                    return response.status(500).send({ error: true });
                }
            }
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.NORMAL, `${apiName} API returned error: ${generateResponse.status} ${generateResponse.statusText}`);
                log.warn(LogClass.SENSITIVE, `${apiName} API error body:`, errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }

            /** @type {any} */
            const generateResponseJson = await generateResponse.json();

            const candidates = generateResponseJson?.candidates;
            if (!candidates || candidates.length === 0) {
                let message = `${apiName} API returned no candidate`;
                log.warn(LogClass.SENSITIVE, message, generateResponseJson);
                if (generateResponseJson?.promptFeedback?.blockReason) {
                    message += `\nPrompt was blocked due to : ${generateResponseJson.promptFeedback.blockReason}`;
                }
                return response.send({ error: { message } });
            }

            const responseContent = candidates[0].content ?? candidates[0].output;
            const functionCall = (candidates?.[0]?.content?.parts ?? []).some(part => part.functionCall);
            const inlineData = (candidates?.[0]?.content?.parts ?? []).some(part => part.inlineData);
            log.debug(LogClass.SENSITIVE, `${apiName} response:`, util.inspect(generateResponseJson, { depth: 5, colors: true }));

            const responseText = typeof responseContent === 'string' ? responseContent : responseContent?.parts?.filter(part => !part.thought)?.map(part => part.text)?.join('\n\n');
            if (!responseText && !functionCall && !inlineData) {
                let message = `${apiName} Candidate text empty`;
                log.warn(LogClass.SENSITIVE, message, generateResponseJson);
                return response.send({ error: { message } });
            }

            // Wrap it back to OAI format (responseContent includes thought signatures in parts array)
            const reply = { choices: [{ 'message': { 'content': responseText } }], responseContent };
            return response.send(reply);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, `Error communicating with ${apiName} API`);
        log.error(LogClass.SENSITIVE, `Error communicating with ${apiName} API:`, error);
        if (!response.headersSent) {
            return response.status(500).send({ error: true });
        }
    }
}

/**
 * Sends a request to AI21 API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendAI21Request(request, response) {
    if (!request.body) return response.sendStatus(400);

    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AI21, request.body.secret_id);
    if (!apiKey) {
        log.warn(LogClass.NORMAL, 'AI21 API key is missing.');
        return response.status(400).send({ error: true });
    }

    const bodyParams = {};
    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });
    // Hack to support JSON schema
    if (request.body.json_schema) {
        bodyParams.response_format = {
            type: 'json_object',
        };
        const message = {
            role: 'user',
            content: `JSON schema for the response:\n${JSON.stringify(request.body.json_schema.value, null, 4)}`,
        };
        request.body.messages.push(message);
    }
    const convertedPrompt = convertAI21Messages(request.body.messages, getPromptNames(request));
    const body = {
        messages: convertedPrompt,
        model: request.body.model,
        max_tokens: request.body.max_tokens,
        temperature: request.body.temperature,
        top_p: request.body.top_p,
        stop: request.body.stop,
        stream: request.body.stream,
        tools: request.body.tools,
        ...bodyParams,
    };
    const options = {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
    };

    log.debug(LogClass.SENSITIVE, 'AI21 request:', body);

    try {
        const generateResponse = await fetch(API_AI21 + '/chat/completions', options);
        if (request.body.stream) {
            await forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.NORMAL, `AI21 API returned error: ${generateResponse.status} ${generateResponse.statusText}`);
                log.warn(LogClass.SENSITIVE, 'AI21 API error body:', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'AI21 response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with AI21 API');
        log.error(LogClass.SENSITIVE, 'Error communicating with AI21 API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to MistralAI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendMistralAIRequest(request, response) {
    const apiUrl = new URL(request.body.reverse_proxy || API_MISTRAL).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MISTRALAI, request.body.secret_id);

    if (!apiKey) {
        log.warn(LogClass.NORMAL, 'MistralAI API key is missing.');
        return response.status(400).send({ error: true });
    }

    try {
        const messages = convertMistralMessages(request.body.messages, getPromptNames(request));
        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            controller.abort();
        });

        const requestBody = {
            'model': request.body.model,
            'messages': messages,
            'temperature': request.body.temperature,
            'top_p': request.body.top_p,
            'frequency_penalty': request.body.frequency_penalty,
            'presence_penalty': request.body.presence_penalty,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'safe_prompt': request.body.safe_prompt,
            'random_seed': request.body.seed === -1 ? undefined : request.body.seed,
            'stop': Array.isArray(request.body.stop) && request.body.stop.length > 0 ? request.body.stop : undefined,
        };

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            requestBody['tools'] = request.body.tools;
            requestBody['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.json_schema) {
            requestBody['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
            timeout: 0,
        };

        log.debug(LogClass.SENSITIVE, 'MisralAI request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        if (request.body.stream) {
            await forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.NORMAL, `MistralAI API returned error: ${generateResponse.status} ${generateResponse.statusText}`);
                log.warn(LogClass.SENSITIVE, 'MistralAI API error body:', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'MistralAI response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with MistralAI API');
        log.error(LogClass.SENSITIVE, 'Error communicating with MistralAI API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Cohere API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendCohereRequest(request, response) {
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.COHERE, request.body.secret_id);
    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });

    if (!apiKey) {
        log.warn(LogClass.NORMAL, 'Cohere API key is missing.');
        return response.status(400).send({ error: true });
    }

    try {
        const convertedHistory = convertCohereMessages(request.body.messages, getPromptNames(request));
        const tools = [];

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            tools.push(...request.body.tools);
            tools.forEach(tool => {
                if (tool?.function?.parameters?.$schema) {
                    delete tool.function.parameters.$schema;
                }
            });
        }

        // https://docs.cohere.com/reference/chat
        const requestBody = {
            stream: Boolean(request.body.stream),
            model: request.body.model,
            messages: convertedHistory.chatHistory,
            temperature: request.body.temperature,
            max_tokens: request.body.max_tokens,
            k: request.body.top_k,
            p: request.body.top_p,
            seed: request.body.seed,
            stop_sequences: request.body.stop,
            frequency_penalty: request.body.frequency_penalty,
            presence_penalty: request.body.presence_penalty,
            documents: [],
            tools: tools,
        };

        const canDoSafetyMode = String(request.body.model).endsWith('08-2024');
        if (canDoSafetyMode) {
            requestBody.safety_mode = 'OFF';
        }

        if (request.body.json_schema) {
            requestBody.response_format = {
                type: 'json_schema',
                schema: request.body.json_schema.value,
            };
        }

        log.debug(LogClass.SENSITIVE, 'Cohere request:', requestBody);

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
            timeout: 0,
        };

        const apiUrl = API_COHERE_V2 + '/chat';

        if (request.body.stream) {
            const stream = await fetch(apiUrl, config);
            await forwardFetchResponse(stream, response);
        } else {
            const generateResponse = await fetch(apiUrl, config);
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.NORMAL, `Cohere API returned error: ${generateResponse.status} ${generateResponse.statusText}`);
                log.warn(LogClass.SENSITIVE, 'Cohere API error body:', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'Cohere response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with Cohere API');
        log.error(LogClass.SENSITIVE, 'Error communicating with Cohere API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to DeepSeek API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {{handle: string|undefined, backend: string, recordId: string}|null} [recordRef] The prompt record
 * this generation belongs to, built by the router from `recordOutgoingPrompt()`'s result — see Cache Lens
 * raw generation rows design §6.2. `null`/absent-safe: when no record was created (the router's prompt was
 * not a string, or the caller did not pass one at all), this helper still sends the request normally and
 * simply finalizes nothing.
 */
async function sendDeepSeekRequest(request, response, recordRef) {
    const apiUrl = new URL(request.body.reverse_proxy || API_DEEPSEEK).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.DEEPSEEK, request.body.secret_id);

    if (!apiKey && !request.body.reverse_proxy) {
        log.warn(LogClass.NORMAL, 'DeepSeek API key is missing.');

        // Finalize the prompt record before returning: this guard runs before `finalizeRecord` and the socket
        // close handler are available, so neither can finalize this rejected request.
        if (recordRef) {
            const result = finalizePromptRecord({
                handle: recordRef.handle,
                backend: recordRef.backend,
                recordId: recordRef.recordId,
                status: 'failed',
                completedAt: Date.now(),
            });

            log.debug(LogClass.NORMAL, `DeepSeek transport: recordId ${recordRef.recordId} seq ${result.seq ?? 'unknown'} -> status "failed" (no API key configured), result reason "${result.reason}".`);
        }

        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();

    // 🔴 FINALIZE EXACTLY ONCE (design §6.5). `finalizePromptRecord` is itself idempotent for a repeated
    // IDENTICAL terminal update and rejects a contradictory one, but that is a backstop, not the mechanism —
    // relying on it alone would let an abort landing in the same tick as a stream error race to log a
    // spurious "contradictory" when both were really the same generation ending badly. This flag is the
    // actual guard; the record-level idempotency only covers the case where this flag itself somehow failed.
    let recordFinalized = false;

    /**
     * Finalize the prompt record for this generation, once, if a record exists at all.
     * @param {"completed"|"failed"|"cancelled"} status The terminal status to apply.
     * @param {{usageState?: "available"|"absent"|"invalid", usage?: object}} [usageResult] Usage to attach —
     * design §11.1: `cancelled` and `failed` never pass one, so they finalize with no usage.
     */
    function finalizeRecord(status, usageResult) {
        if (!recordRef) {
            return;
        }

        if (recordFinalized) {
            log.debug(LogClass.NORMAL, `DeepSeek transport: recordId ${recordRef.recordId} already finalized locally; skipped a second attempt at status "${status}".`);
            return;
        }

        recordFinalized = true;

        const result = finalizePromptRecord({
            handle: recordRef.handle,
            backend: recordRef.backend,
            recordId: recordRef.recordId,
            status,
            completedAt: Date.now(),
            usageState: usageResult?.usageState,
            usage: usageResult?.usage,
        });

        log.debug(LogClass.NORMAL, `DeepSeek transport: recordId ${recordRef.recordId} seq ${result.seq ?? 'unknown'} backend ${recordRef.backend} -> status "${status}", usageState "${usageResult?.usageState ?? 'absent'}", result reason "${result.reason}".`);
    }

    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
        // The existing abort / client-disconnect path (design §6.5): a downstream close before the generation
        // reached a terminal status of its own is a cancellation, not a failure.
        finalizeRecord('cancelled');
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;

            // DeepSeek doesn't permit empty required arrays
            bodyParams.tools.forEach(tool => {
                const required = tool?.function?.parameters?.required;
                if (Array.isArray(required) && required.length === 0) {
                    delete tool.function.parameters.required;
                }
            });
        }

        // Hack to support JSON schema
        if (request.body.json_schema) {
            bodyParams.response_format = {
                type: 'json_object',
            };
            const message = {
                role: 'user',
                content: `JSON schema for the response:\n${JSON.stringify(request.body.json_schema.value, null, 4)}`,
            };
            request.body.messages.push(message);
        }

        const processedMessages = addAssistantPrefix(postProcessPrompt(request.body.messages, PROMPT_PROCESSING_TYPE.SEMI_TOOLS, getPromptNames(request)), bodyParams.tools, 'prefix');
        addReasoningContentToToolCalls(processedMessages);

        if (request.body.include_reasoning && request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }

        const requestBody = {
            'messages': processedMessages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'stop': request.body.stop,
            'seed': request.body.seed,
            'thinking': { type: request.body.include_reasoning ? 'enabled' : 'disabled' },
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        log.debug(LogClass.SENSITIVE, 'DeepSeek request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            // Observed only when there is a record to finalize — an observer with nowhere to report its
            // result would just be spending CPU parsing SSE events for nothing (design §6.5).
            const observer = recordRef ? createDeepSeekUsageObserver({ recordId: recordRef.recordId }) : undefined;

            if (observer) {
                observer.on('end', function () {
                    // Normal upstream end: the observer has seen everything it is ever going to see.
                    finalizeRecord('completed', observer.getResult());
                });
                observer.on('error', function (error) {
                    // The observer's own contract (deepseek-usage.js) is that it never throws past its
                    // caller, but a Transform can still surface a stream-level error from Node itself; treat
                    // either as a failed generation rather than letting it hang unfinalized.
                    log.warn(LogClass.NORMAL, 'DeepSeek usage observer errored while watching a streaming response.');
                    log.warn(LogClass.SENSITIVE, 'DeepSeek usage observer error:', error?.message ?? error);
                    finalizeRecord('failed');
                });
            }

            if (generateResponse.body) {
                // Errors on the raw provider stream do not propagate through `.pipe()` to `observer` by
                // Node's own semantics, so this is listened for independently of the observer above — it is
                // what actually catches a connection drop or a mid-stream provider fault (design §6.5:
                // "finalizes `failed` on provider or stream error").
                generateResponse.body.on('error', function (error) {
                    log.warn(LogClass.NORMAL, 'DeepSeek streaming response errored.');
                    log.warn(LogClass.SENSITIVE, 'DeepSeek streaming response error:', error?.message ?? error);
                    finalizeRecord('failed');
                });
            }

            if (!generateResponse.ok) {
                // `forwardFetchResponse()` still forwards the error body/status to the browser below; the
                // observer, if any, is never piped in this branch (the pipe only happens past this check), so
                // finalization has to happen here rather than relying on an 'end'/'error' event that will
                // never fire.
                log.warn(LogClass.NORMAL, `DeepSeek API returned error: ${generateResponse.status} ${generateResponse.statusText}`);
                finalizeRecord('failed');
            }

            await forwardFetchResponse(generateResponse, response, observer);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.NORMAL, `DeepSeek API returned error: ${generateResponse.status} ${generateResponse.statusText}`);
                log.warn(LogClass.SENSITIVE, 'DeepSeek API error body:', errorText);
                // No error body or message is ever passed to the record (design §6.4) — only the terminal
                // status. The numeric status is already on the NORMAL line above if it needs to be grepped.
                finalizeRecord('failed');
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'DeepSeek response:', generateResponseJson);
            // Normalize and finalize BEFORE the response is sent to the browser (design §6.4 step order),
            // and the object sent below is the exact object just parsed from the provider — untouched.
            const normalizedUsage = normalizeDeepSeekChatUsage(generateResponseJson.usage);
            finalizeRecord('completed', normalizedUsage);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with DeepSeek API');
        log.error(LogClass.SENSITIVE, 'Error communicating with DeepSeek API: ', error);
        // A fetch error, a JSON-parse error, or any other exception in the try block above: the generation
        // did not complete, and no error body or message is stored on the record either way (design §6.4).
        finalizeRecord('failed');
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to XAI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendXaiRequest(request, response) {
    const apiUrl = new URL(request.body.reverse_proxy || API_XAI).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.XAI, request.body.secret_id);

    if (!apiKey && !request.body.reverse_proxy) {
        log.warn(LogClass.NORMAL, 'xAI API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort === 'high' ? 'high' : 'low';
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    strict: request.body.json_schema.strict ?? true,
                    schema: request.body.json_schema.value,
                },
            };
        }

        const processedMessages = request.body.messages = convertXAIMessages(request.body.messages, getPromptNames(request));

        const requestBody = {
            'messages': processedMessages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'max_completion_tokens': request.body.max_completion_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        log.debug(LogClass.SENSITIVE, 'xAI request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            await forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.NORMAL, `xAI API returned error: ${generateResponse.status} ${generateResponse.statusText}`);
                log.warn(LogClass.SENSITIVE, 'xAI API error body:', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'xAI response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with xAI API');
        log.error(LogClass.SENSITIVE, 'Error communicating with xAI API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to AI/ML API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendAimlapiRequest(request, response) {
    const apiUrl = API_AIMLAPI;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AIMLAPI, request.body.secret_id);

    if (!apiKey) {
        log.warn(LogClass.NORMAL, 'AI/ML API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...AIMLAPI_HEADERS,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        log.debug(LogClass.SENSITIVE, 'AI/ML API request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            await forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.NORMAL, `AI/ML API returned error: ${generateResponse.status} ${generateResponse.statusText}`);
                log.warn(LogClass.SENSITIVE, 'AI/ML API error body:', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'AI/ML API response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with AI/ML API');
        log.error(LogClass.SENSITIVE, 'Error communicating with AI/ML API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Electron Hub.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendElectronHubRequest(request, response) {
    const apiUrl = API_ELECTRONHUB;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB, request.body.secret_id);

    if (!apiKey) {
        log.warn(LogClass.NORMAL, 'Electron Hub key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.enable_web_search) {
            bodyParams['web_search'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const isClaude = /^claude-/.test(request.body.model);

        if (Array.isArray(request.body.messages) && isClaude) {
            if (enableSystemPromptCache) {
                cachingSystemPromptForOpenRouter(request.body.messages, cacheTTL);
            }

            if (cachingAtDepth !== -1) {
                cachingAtDepthForOpenRouterClaude(request.body.messages, cachingAtDepth, cacheTTL);
            }
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'logit_bias': request.body.logit_bias,
            'seed': request.body.seed,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        log.debug(LogClass.SENSITIVE, 'Electron Hub request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            await forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.SENSITIVE, 'Electron Hub returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'Electron Hub response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with Electron Hub');
        log.error(LogClass.SENSITIVE, 'Error communicating with Electron Hub: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Chutes.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendChutesRequest(request, response) {
    const apiUrl = API_CHUTES;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.CHUTES, request.body.secret_id);

    if (!apiKey) {
        log.warn(LogClass.NORMAL, 'Chutes key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'repetition_penalty': request.body.repetition_penalty,
            'min_p': request.body.min_p,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'seed': request.body.seed,
            'stop': request.body.stop,
            'reasoning_effort': request.body.reasoning_effort,
            'logit_bias': request.body.logit_bias,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        log.debug(LogClass.SENSITIVE, 'Chutes request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            await forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.SENSITIVE, 'Chutes returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'Chutes response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with Chutes');
        log.error(LogClass.SENSITIVE, 'Error communicating with Chutes: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to MiniMax.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 */
async function sendMinimaxRequest(request, response) {
    const apiUrl = request.body.minimax_endpoint === MINIMAX_ENDPOINT.CN
        ? API_MINIMAX_CN : API_MINIMAX;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.MINIMAX, request.body.secret_id);

    if (!apiKey) {
        log.warn(LogClass.NORMAL, 'MiniMax key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });

    try {
        // MiniMax does not allow consecutive messages with the same role.
        // Merge them into a single message to avoid "invalid chat setting (2013)".
        const messages = postProcessPrompt(request.body.messages, PROMPT_PROCESSING_TYPE.MERGE_TOOLS, getPromptNames(request));

        let bodyParams = {};

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        const requestBody = {
            'messages': messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.model === 'M2-her' ? Math.min(request.body.max_tokens, 2048) : request.body.max_tokens,
            'stream': request.body.stream,
            'top_p': request.body.top_p,
            'stop': request.body.stop,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        log.debug(LogClass.SENSITIVE, 'MiniMax request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            await forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                log.warn(LogClass.SENSITIVE, 'MiniMax returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            log.debug(LogClass.SENSITIVE, 'MiniMax response:', generateResponseJson);
            return response.send(generateResponseJson);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error communicating with MiniMax');
        log.error(LogClass.SENSITIVE, 'Error communicating with MiniMax: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * @param {express.Request} request Express request object (contains request.body with all generate_data)
 * @param {express.Response} response Express response object
 */
async function sendAzureOpenAIRequest(request, response) {
    // 1. GATHER & VALIDATE SETTINGS
    const { azure_base_url, azure_deployment_name, azure_api_version } = request.body;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AZURE_OPENAI, request.body.secret_id);
    if (!azure_base_url || !azure_deployment_name || !azure_api_version || !apiKey) {
        return response.status(400).send({
            error: {
                message: 'Azure OpenAI configuration is incomplete. Please provide Base URL, Deployment Name, API Version, and API Key in the connection settings.',
            },
        });
    }

    // 2. PREPARE THE REQUEST
    const url = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
    url.searchParams.set('api-version', azure_api_version);
    const endpointUrl = url.toString();

    // Create the base payload with all standard parameters
    const apiRequestBody = /** @type {any} */ ({});
    for (const key of AZURE_OPENAI_KEYS) {
        if (Object.hasOwn(request.body, key)) {
            apiRequestBody[key] = request.body[key];
        }
    }

    // Handle Structured Output (JSON Mode) by translating the custom `json_schema` object.
    if (request.body.json_schema) {
        apiRequestBody['response_format'] = {
            type: 'json_schema',
            json_schema: {
                name: request.body.json_schema.name,
                strict: request.body.json_schema.strict ?? true,
                schema: request.body.json_schema.value,
            },
        };
    }

    // Adjust logprobs for Azure OpenAI, which follows the OpenAI Chat Completions API spec.
    if (typeof apiRequestBody.logprobs === 'number' && apiRequestBody.logprobs > 0) {
        apiRequestBody.top_logprobs = apiRequestBody.logprobs;
        apiRequestBody.logprobs = true;
    }

    // Do not send reasoning effort to models which do not support it
    apiRequestBody['reasoning_effort'] = OPENAI_REASONING_EFFORT_MODELS.includes(request.body.model)
        ? OPENAI_FIXED_REASONING_EFFORT[request.body.model] ?? OPENAI_REASONING_EFFORT_MAP[request.body.reasoning_effort] ?? request.body.reasoning_effort
        : undefined;

    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', () => controller.abort());

    const config = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        },
        body: JSON.stringify(apiRequestBody),
        signal: controller.signal,
    };

    log.info(LogClass.SENSITIVE, `Sending request to Azure OpenAI: ${endpointUrl}`);
    log.debug(LogClass.SENSITIVE, 'Azure OpenAI Request Body:', apiRequestBody);
    try {
        const fetchResponse = await fetch(endpointUrl, config);

        if (request.body.stream) {
            return await forwardFetchResponse(fetchResponse, response);
        }

        if (fetchResponse.ok) {
            /** @type {any} */
            const json = await fetchResponse.json();
            log.debug(LogClass.SENSITIVE, 'Azure OpenAI response:', json);
            return response.send(json);
        }

        const text = await fetchResponse.text();
        const data = tryParse(text) || { error: { message: fetchResponse.statusText || 'Unknown error occurred' } };
        return response.status(500).send(data);
    } catch (error) {
        const message = error.name === 'AbortError'
            ? 'Request was aborted by the client.'
            : (error.message || 'An unknown network error occurred.');
        return response.status(500).send({ error: { message, ...error } });
    }
}

export const router = express.Router();

/**
 * Is this Custom base URL Featherless? The single-model lookup and the on-disk list cache are Featherless
 * behaviour (see the text-completion route's `handleFeatherlessModelsStatus`); every other Custom endpoint
 * keeps the plain "download `/models` on Connect" flow, because a local server's list is small and changes
 * whenever the user swaps a model.
 * @param {string} apiUrl
 * @returns {boolean}
 */
function isFeatherlessHost(apiUrl) {
    try {
        return /(^|\.)featherless\.ai$/i.test(new URL(apiUrl).hostname);
    } catch {
        return false;
    }
}

/**
 * The Custom-source twin of the text route's Featherless branch, same three outcomes: a forced refresh or
 * an empty cache downloads the full list and caches it; a typed model is confirmed with one ~825-byte
 * lookup and answered with the cached list; no model and a cache answers from disk with no network at all.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {string} apiUrl The Custom base URL, `/v1` included
 * @param {string} apiKey The Custom key, or '' for none
 * @param {Record<string, string>} headers The user's additional headers
 * @returns {Promise<import('express').Response>}
 */
async function handleFeatherlessCustomStatus(request, response, apiUrl, apiKey, headers) {
    const cacheKey = new URL(apiUrl).host;
    // `refresh_models` downloads and returns the catalog. A normal Connect returns only the cached count and
    // timestamp; the cache also serves the first Connect after a restart.
    const wantsRefresh = request.body.refresh_models === true;
    const requestedModel = typeof request.body.model === 'string' && request.body.model.length > 0 ? request.body.model : null;
    const fetchHeaders = { ...headers };
    if (apiKey) {
        fetchHeaders['Authorization'] = 'Bearer ' + apiKey;
    }

    const cached = readCachedModelList(cacheKey);

    if (wantsRefresh || !cached) {
        log.info(LogClass.NORMAL, `Custom/Featherless status check for '${cacheKey}': fetching the full model list (refresh_models=${wantsRefresh}, hadCache=${!!cached}).`);
        const listReply = await fetch(new URL(urlJoin(apiUrl, '/models')), { method: 'GET', headers: fetchHeaders });

        if (!listReply.ok) {
            log.warn(LogClass.NORMAL, 'Custom/Featherless models endpoint is offline.', listReply.status);
            return response.status(400).send({ error: true });
        }

        /** @type {any} */
        const data = await listReply.json();
        if (!Array.isArray(data?.data)) {
            log.warn(LogClass.NORMAL, 'Custom/Featherless models response is not an array.');
            return response.status(400).send({ error: true });
        }

        log.info(LogClass.NORMAL, `Models available: ${data.data.length} models.`);
        const record = writeCachedModelList(cacheKey, data.data);
        return response.send({ data: data.data, cached_models: data.data.length, cached_at: record.cachedAt, cached: false });
    }

    // An ordinary Connect returns the selected model response and cache metadata, not the full catalog. The
    // list leaves the server only when the caller explicitly requests a refresh.
    if (requestedModel) {
        const t0 = Date.now();
        const modelReply = await fetch(`${apiUrl}/models/${encodeURIComponent(requestedModel)}`, { method: 'GET', headers: fetchHeaders });

        if (!modelReply.ok) {
            log.info(LogClass.NORMAL, `Featherless does not know model '${requestedModel}' for '${cacheKey}' (status ${modelReply.status}, ${Date.now() - t0} ms).`);
            return response.status(400).send({ error: `Featherless does not know model ${requestedModel}` });
        }

        log.info(LogClass.NORMAL, `Custom/Featherless status check for '${cacheKey}': model '${requestedModel}' confirmed in ${Date.now() - t0} ms; ${cached.models.length} models cached from ${cached.cachedAt}, none sent.`);
        return response.send({ data: [], cached_models: cached.models.length, cached_at: cached.cachedAt, cached: true });
    }

    log.info(LogClass.NORMAL, `Custom/Featherless status check for '${cacheKey}': no model selected; ${cached.models.length} models cached from ${cached.cachedAt}, none sent, no network call.`);
    return response.send({ data: [], cached_models: cached.models.length, cached_at: cached.cachedAt, cached: true });
}

router.post('/status', async function (request, statusResponse) {
    try {
        if (!request.body) return statusResponse.sendStatus(400);

        let apiUrl = '';
        let apiKey = '';
        let headers = {};
        let queryParams = {};

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENAI) {
            // Resolved by chat-source.js so this route, `/status` and a plugin's `generate()` (API 8) agree.
            const openaiSource = resolveOpenAiWireChatSource(CHAT_COMPLETION_SOURCES.OPENAI, { reverseProxy: request.body.reverse_proxy });
            apiUrl = openaiSource.apiUrl;
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, openaiSource.secretKey, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
            const openrouterSource = resolveOpenAiWireChatSource(CHAT_COMPLETION_SOURCES.OPENROUTER);
            apiUrl = openrouterSource.apiUrl;
            apiKey = readSecret(request.user.directories, openrouterSource.secretKey, request.body.secret_id);
            // OpenRouter needs to pass the Referer and X-Title: https://openrouter.ai/docs#requests
            headers = { ...openrouterSource.headers };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_MISTRAL).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MISTRALAI, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            const customSource = resolveOpenAiWireChatSource(CHAT_COMPLETION_SOURCES.CUSTOM, { customUrl: request.body.custom_url });
            apiUrl = customSource.apiUrl;
            apiKey = readSecret(request.user.directories, customSource.secretKey, request.body.secret_id);
            headers = {};
            mergeObjectWithYaml(headers, request.body.custom_include_headers);
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE) {
            apiUrl = API_COHERE_V1;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COHERE, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES) {
            apiUrl = API_CHUTES;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.CHUTES, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.ELECTRONHUB) {
            apiUrl = API_ELECTRONHUB;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
            apiUrl = API_NANOGPT;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.NANOGPT, request.body.secret_id);
            headers = {};
            queryParams = { detailed: true };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
            apiUrl = new URL(request.body.reverse_proxy || API_DEEPSEEK.replace('/beta', '')).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.DEEPSEEK, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.XAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_XAI).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.XAI, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.AIMLAPI) {
            apiUrl = API_AIMLAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.AIMLAPI, request.body.secret_id);
            headers = { ...AIMLAPI_HEADERS };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS) {
            const isAnonymous = request.body.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS;
            apiUrl = 'https://gen.pollinations.ai/text';
            apiKey = isAnonymous ? 'anonymous' : readSecret(request.user.directories, SECRET_KEYS.POLLINATIONS, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
            apiUrl = API_GROQ;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.GROQ, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COMETAPI) {
            apiUrl = API_COMETAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COMETAPI, request.body.secret_id);
            headers = {};
            throw new Error('This provider is temporarily disabled.');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT) {
            apiUrl = new URL(request.body.reverse_proxy || API_MOONSHOT).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MOONSHOT, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS) {
            apiUrl = API_FIREWORKS;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.FIREWORKS, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MAKERSUITE, request.body.secret_id);
            apiUrl = trimTrailingSlash(request.body.reverse_proxy || API_MAKERSUITE);
            const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
            const modelsUrl = !apiKey && request.body.reverse_proxy
                ? `${apiUrl}/${apiVersion}/models`
                : `${apiUrl}/${apiVersion}/models?key=${apiKey}`;

            if (!apiKey && !request.body.reverse_proxy) {
                log.warn(LogClass.NORMAL, 'Google AI Studio API key is missing.');
                return statusResponse.status(400).send({ error: true });
            }

            try {
                const response = await fetch(modelsUrl);

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    // Transform Google AI Studio models to OpenAI format
                    const models = data.models
                        ?.filter(model => model.supportedGenerationMethods?.includes('generateContent'))
                        ?.map(model => ({
                            ...model,
                            id: model.name.replace('models/', ''),
                        })) || [];

                    log.info(LogClass.SENSITIVE, 'Available Google AI Studio models:', models.map(m => m.id));
                    return statusResponse.send({ data: models });
                } else {
                    log.warn(LogClass.NORMAL, 'Google AI Studio models endpoint failed:', response.status, response.statusText);
                    return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
                }
            } catch (error) {
                log.error(LogClass.NORMAL, 'Error fetching the Google AI Studio model list');
                log.error(LogClass.SENSITIVE, 'Error fetching Google AI Studio models:', error);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.AZURE_OPENAI) {
            const { azure_base_url, azure_deployment_name, azure_api_version } = request.body;
            const apiKey = readSecret(request.user.directories, SECRET_KEYS.AZURE_OPENAI, request.body.secret_id);

            // 1) Validate configuration from the frontend
            if (!apiKey || !azure_base_url || !azure_deployment_name || !azure_api_version) {
                log.warn(LogClass.NORMAL, 'Azure OpenAI status check failed: missing config from frontend.');
                return statusResponse.status(400).send({ error: true, message: 'Azure configuration is incomplete.' });
            }
            // 2) Build URLs using the URL API for consistency and robustness.
            const modelsUrl = new URL('/openai/models', azure_base_url);
            modelsUrl.searchParams.set('api-version', azure_api_version);

            const chatUrl = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
            chatUrl.searchParams.set('api-version', azure_api_version);

            // Map common status codes to user-friendly error messages
            const azureStatusErrorMap = {
                400: 'API version may be invalid for this resource.',
                401: 'Invalid API key or insufficient permissions.',
                403: 'Invalid API key or insufficient permissions.',
                404: 'Endpoint URL appears incorrect (404).',
            };

            try {
                // ---- A) GET /models: fast sanity check for endpoint + api key + api version ----
                const apiConfigTest = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: { 'api-key': apiKey, 'Accept': 'application/json' },
                });

                if (!apiConfigTest.ok) {
                    let errText = '';
                    try { errText = await apiConfigTest.text(); } catch { /* response body may be empty */ }

                    log.warn(LogClass.NORMAL, 'Azure OpenAI GET /models failed:', apiConfigTest.status, apiConfigTest.statusText);
                    log.warn(LogClass.SENSITIVE, 'Azure OpenAI GET /models error body:', errText || '');

                    const defaultMessage = `Azure Models endpoint error: ${apiConfigTest.statusText}`;
                    const message = azureStatusErrorMap[apiConfigTest.status] ?? defaultMessage;
                    return statusResponse.status(apiConfigTest.status).send({ error: true, message });
                }

                // ---- B) POST /chat/completions: verify deployment + read underlying model ID ----
                // Small, deterministic probe to minimize cost/latency
                const modelPayload = {
                    messages: [{ role: 'user', content: 'Say word Hi' }],
                    stream: false,
                    max_completion_tokens: 5,
                };

                const modelRequest = await fetch(chatUrl, {
                    method: 'POST',
                    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify(modelPayload),
                });

                let modelResponse;
                try {
                    modelResponse = await modelRequest.json();
                } catch {
                    modelResponse = { raw: 'Failed to parse JSON response from chat completions probe.' };
                }

                const modelId = /** @type {any} */ (modelResponse)?.model;
                if (!modelId) {
                    log.warn(LogClass.NORMAL, 'Azure status check succeeded but could not find a model ID in the response.');
                    log.debug(LogClass.SENSITIVE, 'Azure Response Body:', modelResponse);
                    // Keep a benign success to avoid UX disruption in the UI
                    return statusResponse.send({ data: [] });
                }

                log.info(LogClass.SENSITIVE, color.green('Azure OpenAI connection successful. Detected model:'), modelId);
                // Consistent response format: always an array of { id }
                return statusResponse.send({ data: [{ id: modelId }] });
            } catch (error) {
                log.error(LogClass.NORMAL, 'Azure OpenAI status check could not connect to the endpoint');
                log.error(LogClass.SENSITIVE, 'Azure OpenAI status check connection error:', error);
                return statusResponse.status(500).send({ error: true, message: 'Failed to connect to the Azure endpoint.' });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
            const defaultApiUrl = request.body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN
                ? API_SILICONFLOW_CN : API_SILICONFLOW;
            apiUrl = defaultApiUrl;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.SILICONFLOW, request.body.secret_id);
            headers = {};
            queryParams = { type: 'text', sub_type: 'chat' };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.WORKERS_AI) {
            apiKey = readSecret(request.user.directories, SECRET_KEYS.WORKERS_AI, request.body.secret_id);

            if (!apiKey) {
                log.warn(LogClass.NORMAL, 'Cloudflare Workers AI API key is missing.');
                return statusResponse.status(400).send({ error: true });
            }

            try {
                const accountId = String(request.body.workers_ai_account_id || '').trim();
                if (!accountId) {
                    log.warn(LogClass.NORMAL, 'Cloudflare Workers AI Account ID is missing.');
                    return statusResponse.status(400).send({ error: true });
                }

                const modelsUrl = new URL(`${API_WORKERS_AI}/${encodeURIComponent(accountId)}/ai/models/search`);
                modelsUrl.searchParams.set('task', 'Text Generation');
                modelsUrl.searchParams.set('per_page', '1000');

                const response = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': 'Bearer ' + apiKey,
                    },
                });

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    const models = Array.isArray(data?.result)
                        ? data.result.map(model => ({ ...model, id: model.name }))
                        : [];

                    log.debug(LogClass.SENSITIVE, 'Available Cloudflare Workers AI models:', models.map(m => m.id));
                    return statusResponse.send({ data: models });
                } else {
                    log.warn(LogClass.NORMAL, 'Cloudflare Workers AI models endpoint failed:', response.status, response.statusText);
                    return statusResponse.status(response.status).send({ error: true });
                }
            } catch (error) {
                log.error(LogClass.NORMAL, 'Error fetching the Cloudflare Workers AI model list');
                log.error(LogClass.SENSITIVE, 'Error fetching Cloudflare Workers AI models:', error);
                return statusResponse.status(500).send({ error: true });
            }
        } else {
            log.warn(LogClass.NORMAL, 'This chat completion source is not supported yet.');
            return statusResponse.status(400).send({ error: true });
        }

        if (!apiKey && !request.body.reverse_proxy && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            log.warn(LogClass.NORMAL, 'Chat Completion API key is missing.');
            return statusResponse.status(400).send({ error: true });
        }

        // 🔴 FEATHERLESS BEHIND A CUSTOM URL SPLITS OFF HERE, for the same reason the text-completion route
        // does (see `handleFeatherlessModelsStatus` there): its `/models` is 22,009 entries and 7 MB, and
        // A GLM-5.2 connection can use this shape. Connect validates only the model typed in
        // the box through the single-model lookup and answers with the cached list; the "Refresh model
        // list" button is the one way to download the list again. Keyed on the HOST so nobody else's
        // Custom endpoint — a local llama.cpp, whose list changes when the user swaps a model — is ever
        // answered from a stale cache.
        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM && isFeatherlessHost(apiUrl)) {
            return await handleFeatherlessCustomStatus(request, statusResponse, apiUrl, apiKey, headers);
        }

        const modelsUrl = new URL(urlJoin(apiUrl, '/models'));
        Object.keys(queryParams).forEach(key => {
            modelsUrl.searchParams.append(key, queryParams[key]);
        });
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
        });

        if (response.ok) {
            /** @type {any} */
            let data = await response.json();

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS && Array.isArray(data)) {
                data = { data: data.map(model => ({ id: model.name, ...model })) };
            }

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES && Array.isArray(data?.data)) {
                data.data = data.data
                    .filter(model => model?.id)
                    .map(model => {
                        if (model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined) {
                            return {
                                ...model,
                                pricing: {
                                    ...model.pricing,
                                    input: model.pricing.prompt,
                                    output: model.pricing.completion,
                                },
                            };
                        }
                        return model;
                    });
            }

            statusResponse.send(data);

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE && Array.isArray(data?.models)) {
                data.data = data.models.map(model => ({ id: model.name, ...model }));
            }

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER && Array.isArray(data?.data)) {
                let models = [];

                data.data.forEach(model => {
                    const context_length = model.context_length;
                    const tokens_dollar = Number(1 / (1000 * model.pricing?.prompt));
                    const tokens_rounded = (Math.round(tokens_dollar * 1000) / 1000).toFixed(0);
                    models[model.id] = {
                        tokens_per_dollar: tokens_rounded + 'k',
                        context_length: context_length,
                    };
                });

                log.info(LogClass.SENSITIVE, 'Available OpenRouter models:', models);
            } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
                const models = data?.data;
                log.info(LogClass.SENSITIVE, models);
            } else {
                const models = data?.data;

                if (Array.isArray(models)) {
                    const modelIds = models.filter(x => x && typeof x === 'object').map(x => x.id).sort();
                    log.info(LogClass.SENSITIVE, 'Available models:', modelIds);
                } else {
                    log.warn(LogClass.NORMAL, 'Chat Completion endpoint did not return a list of models.');
                }
            }
        } else {
            log.error(LogClass.NORMAL, 'Chat Completion status check failed. Either Access Token is incorrect or API endpoint is down.');
            statusResponse.send({ error: true, data: { data: [] } });
        }
    } catch (e) {
        log.error(LogClass.NORMAL, 'Chat completion status check failed');
        log.error(LogClass.SENSITIVE, e);

        if (!statusResponse.headersSent) {
            statusResponse.send({ error: true });
        } else {
            statusResponse.end();
        }
    }
});

router.post('/bias', async function (request, response) {
    if (!request.body || !Array.isArray(request.body))
        return response.sendStatus(400);

    try {
        const result = {};
        const model = getTokenizerModel(String(request.query.model || ''));

        // no bias for claude
        if (model == 'claude') {
            return response.send(result);
        }

        let encodeFunction;

        if (sentencepieceTokenizers.includes(model)) {
            const tokenizer = getSentencepiceTokenizer(model);
            const instance = await tokenizer?.get();
            if (!instance) {
                log.error(LogClass.NORMAL, 'Tokenizer not initialized for the requested model');
                log.error(LogClass.SENSITIVE, 'Tokenizer not initialized:', model);
                return response.send({});
            }
            encodeFunction = (text) => new Uint32Array(instance.encodeIds(text));
        } else if (webTokenizers.includes(model)) {
            const tokenizer = getWebTokenizer(model);
            const instance = await tokenizer?.get();
            if (!instance) {
                log.warn(LogClass.SENSITIVE, 'Tokenizer not initialized:', model);
                return response.send({});
            }
            encodeFunction = (text) => new Uint32Array(instance.encode(text));
        } else {
            const tokenizer = getTiktokenTokenizer(model);
            encodeFunction = (tokenizer.encode.bind(tokenizer));
        }

        for (const entry of request.body) {
            if (!entry || !entry.text) {
                continue;
            }

            try {
                const tokens = getEntryTokens(entry.text, encodeFunction);

                for (const token of tokens) {
                    result[token] = entry.value;
                }
            } catch {
                log.warn(LogClass.SENSITIVE, 'Tokenizer failed to encode:', entry.text);
            }
        }

        // not needed for cached tokenizers
        //tokenizer.free();
        return response.send(result);

        /**
         * Gets tokenids for a given entry
         * @param {string} text Entry text
         * @param {(string) => Uint32Array} encode Function to encode text to token ids
         * @returns {Uint32Array} Array of token ids
         */
        function getEntryTokens(text, encode) {
            // Get raw token ids from JSON array
            if (text.trim().startsWith('[') && text.trim().endsWith(']')) {
                try {
                    const json = JSON.parse(text);
                    if (Array.isArray(json) && json.every(x => typeof x === 'number')) {
                        return new Uint32Array(json);
                    }
                } catch {
                    // ignore
                }
            }

            // Otherwise, get token ids from tokenizer
            return encode(text);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to compute logit bias token ids');
        log.error(LogClass.SENSITIVE, error);
        return response.send({});
    }
});

router.post('/generate', async function (request, response) {
    try {
        if (!request.body) return response.status(400).send({ error: true });

        const postProcessingType = request.body.custom_prompt_post_processing;
        if (Array.isArray(request.body.messages) && postProcessingType) {
            log.info(LogClass.SENSITIVE, 'Applying custom prompt post-processing of type', postProcessingType);
            request.body.messages = postProcessPrompt(
                request.body.messages,
                postProcessingType,
                getPromptNames(request));
        }

        if (request.body.json_schema?.value) {
            request.body.json_schema.value = flattenSchema(request.body.json_schema.value, request.body.chat_completion_source);
        }

        // 🔴 ABOVE THE DISPATCH, AND THAT IS THE WHOLE TRICK. Every branch of the switch below converts FROM
        // `request.body.messages` into its own vendor wire format -- Claude, Gemini, Mistral, Cohere, xAI,
        // OpenRouter, all of them. That array is the canonical, vendor-neutral shape, so one interceptor
        // placed here reaches every backend at once while knowing nothing about any of them. Below the
        // switch there is no such place; there are twenty.
        // ⚠️ STRIPPED HERE TOO, AND THAT IS NOT REDUNDANT EVEN THOUGH THIS PATH CANNOT LEAK IT. Each vendor
        // branch below builds its payload by naming fields, so an extra one on `request.body` is inert -- but
        // the strip is where the field's LIFETIME is defined, and a rule with an exception on one of two paths
        // is a rule nobody can apply from memory. It is also above the gate, for §17.2's reason: whether a
        // plugin registered must never change what leaves the process.
        const recentMessages = takeRecentMessages(request);

        // ⚠️ HOISTED OUT OF THE `if` BELOW BECAUSE THE RECORD NEEDS IT TOO, AND IT IS SAFE TO HOIST: these are
        // pure header reads with no side effects and no writes to the request.
        const identity = readIdentityHeaders(request);

        /** @type {string[]} Plugins whose interceptors actually changed the prompt; see `prompt-record.js`. */
        let rewrittenBy = [];

        /** @type {Array<{id: string, atChar: number, delta: number}>} Where each of those changes begins. */
        let rewriteSites = [];

        if (hasPromptInterceptors() && Array.isArray(request.body.messages)) {
            const intercepted = await runPromptInterceptors({
                handle: request.user?.profile?.handle,
                backend: 'chat',
                apiType: request.body.chat_completion_source,
                messages: request.body.messages,
                // ⚠️ UNDEFINED, HONESTLY, AND NOT BY OVERSIGHT. Unlike text completions -- which carries
                // `truncation_length` because the backend needs it -- the chat completions body has no input
                // context budget. The client fits the prompt to `openai_max_context` and keeps the number:
                // `generate_data` sends `max_tokens`, which is the OUTPUT limit and a different thing
                // entirely. An interceptor here does not know how much room it has, and must be told rather
                // than allowed to assume.
                budget: undefined,
                // Character/chat identity, carried in headers (see readIdentityHeaders). The chat body already
                // holds `char_name`/`group_names` for post-processing, but the header channel is uniform across
                // both backends and carries the chat id, which the body does not.
                charName: identity.charName,
                chatId: identity.chatId,
                genType: identity.genType,
                // §22: the avatar filename goes in, a stable `charId` comes out. `runPromptInterceptors`
                // resolves it against the server-owned map and strips this key before any plugin sees it —
                // one resolution point for both backends, rather than the same rule written twice.
                charAvatar: identity.charAvatar,
                personaId: identity.personaId,
                userRoot: request.user?.directories?.root,
                // 🔴 PRESENT HERE TOO, AND THAT IS THE POINT OF §17. `messages` on this path is the ASSEMBLED
                // prompt -- system prompt, world info, examples, the lot -- not the conversation's turns. A
                // plugin wanting the turns cannot recover them from it, so it gets the same field, with the
                // same meaning, on every path, and writes one code path.
                recentMessages: recentMessages,
            });

            request.body.messages = intercepted.messages;
            rewrittenBy = intercepted[REWRITTEN_BY] ?? [];
            rewriteSites = intercepted[REWRITE_SITES] ?? [];
        }

        // Plugin API 8: remember which chat source this user is talking to, so a plugin's `context.generate()`
        // can later reach the same one — the same capture the text route makes, and for the same reason
        // (Mnemosyne's change request of 2026-09-22: extraction after a Chat Completion generation used to
        // find either nothing, or the user's LAST TEXT backend, and replay against that). Last-write-wins:
        // a user alternating text and chat generations gets whichever one just passed, which is what they
        // are talking to. EVERY source is captured, including the vendor-converted ones `generate()` cannot
        // drive, so that its refusal names the source rather than claiming no backend was seen.
        //
        // ⚠️ THE ADDRESS OF THE KEY, NEVER THE KEY. The resolver names the secret SLOT; the key is read at
        // send time. A reverse proxy's password arrives in this body and is deliberately NOT captured (see
        // chat-source.js). `custom_include_headers` / `custom_include_body` ARE captured, parsed, because a
        // Custom source may need them to be reachable at all; they are cleared on `storage.lock()`.
        {
            const source = request.body.chat_completion_source;
            const resolved = resolveOpenAiWireChatSource(source, { customUrl: request.body.custom_url, reverseProxy: request.body.reverse_proxy });
            const extraHeaders = {};
            const extraBody = {};
            if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
                mergeObjectWithYaml(extraHeaders, request.body.custom_include_headers);
                mergeObjectWithYaml(extraBody, request.body.custom_include_body);
            }
            captureConnection(request.user?.profile?.handle, {
                family: 'chat',
                api_type: source,
                api_server: resolved?.apiUrl || 'unsupported:',
                model: request.body.model,
                directories: request.user?.directories,
                secretId: request.body.secret_id ?? null,
                secretKey: resolved?.secretKey ?? '',
                keyRequired: resolved?.keyRequired ?? false,
                readSecret,
                extraHeaders: { ...(resolved?.headers ?? {}), ...extraHeaders },
                extraBody,
            });
        }

        // 🔴 AFTER THE INTERCEPTORS AND BEFORE THE WIRE — see `prompt-record.js`.
        //
        // ⚠️ THE SERIALISED MESSAGE ARRAY, NOT THE WIRE BODY, AND THE DIFFERENCE IS STATED RATHER THAN GLOSSED.
        // Each vendor branch below converts these messages into its own shape (`convertClaudeMessages` and
        // friends), so what actually leaves the process is not this string. What this IS, is the assembled
        // prompt at exactly the level the browser's own copy exists at — which is what makes the two
        // comparable. A consumer wanting the literal vendor payload is not served by this and must not think
        // it is.
        const promptRecord = recordOutgoingPrompt({
            handle: request.user?.profile?.handle,
            backend: 'chat',
            apiType: request.body.chat_completion_source,
            chatId: identity.chatId,
            genType: identity.genType,
            shape: identity.promptShape,
            prompt: Array.isArray(request.body.messages) ? JSON.stringify(request.body.messages) : undefined,
            rewrittenBy: rewrittenBy,
            rewriteSites: rewriteSites,
        });

        // ⚠️ THE CORRELATION HANDLE, AND IT IS A HEADER BECAUSE THE STREAMING PATH HAS NO JSON ENVELOPE.
        // A client that just made a generation needs to know WHICH record is its own; matching by time or by
        // chat id is guesswork the moment two generations overlap. Headers precede the body on both the
        // streaming and non-streaming paths, so this is the one channel that works for both.
        if (promptRecord && !response.headersSent) {
            response.setHeader('X-ST-Prompt-Seq', String(promptRecord.seq));
        }

        // 🔴 REQUEST-LOCAL, AND NOTHING ELSE. Cache Lens raw generation rows design §6.2: this carries only
        // enough to locate the record later (`handle`/`backend`/`recordId`) so the DeepSeek helper can call
        // `finalizePromptRecord()` when the generation ends. It is passed as an explicit argument, same as
        // `promptRecord` above is used for the header — never attached to `request.body` (which is serialized
        // verbatim to the model by every backend endpoint, per the comment above `recordOutgoingPrompt`),
        // never to `response.locals`, never to a module-level side table. `null` when no record was created
        // (a non-string prompt, e.g. a text-completion body) — the DeepSeek helper treats that as
        // absent-safe and finalizes nothing.
        const recordRef = promptRecord ? { handle: request.user?.profile?.handle, backend: 'chat', recordId: promptRecord.recordId } : null;

        switch (request.body.chat_completion_source) {
            case CHAT_COMPLETION_SOURCES.CLAUDE: return await sendClaudeRequest(request, response);
            case CHAT_COMPLETION_SOURCES.AI21: return await sendAI21Request(request, response);
            case CHAT_COMPLETION_SOURCES.MAKERSUITE: return await sendMakerSuiteRequest(request, response);
            case CHAT_COMPLETION_SOURCES.VERTEXAI: return await sendMakerSuiteRequest(request, response);
            case CHAT_COMPLETION_SOURCES.MISTRALAI: return await sendMistralAIRequest(request, response);
            case CHAT_COMPLETION_SOURCES.COHERE: return await sendCohereRequest(request, response);
            case CHAT_COMPLETION_SOURCES.DEEPSEEK: return await sendDeepSeekRequest(request, response, recordRef);
            case CHAT_COMPLETION_SOURCES.AIMLAPI: return await sendAimlapiRequest(request, response);
            case CHAT_COMPLETION_SOURCES.XAI: return await sendXaiRequest(request, response);
            case CHAT_COMPLETION_SOURCES.CHUTES: return await sendChutesRequest(request, response);
            case CHAT_COMPLETION_SOURCES.MINIMAX: return await sendMinimaxRequest(request, response);
            case CHAT_COMPLETION_SOURCES.ELECTRONHUB: return await sendElectronHubRequest(request, response);
            case CHAT_COMPLETION_SOURCES.AZURE_OPENAI: return await sendAzureOpenAIRequest(request, response);
        }

        let apiUrl;
        let apiKey;
        let headers;
        let bodyParams;
        const isTextCompletion = Boolean(request.body.model && TEXT_COMPLETION_MODELS.includes(request.body.model)) || typeof request.body.messages === 'string';

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENAI) {
            // Resolved by chat-source.js so this route, `/status` and a plugin's `generate()` (API 8) agree.
            const openaiSource = resolveOpenAiWireChatSource(CHAT_COMPLETION_SOURCES.OPENAI, { reverseProxy: request.body.reverse_proxy });
            apiUrl = openaiSource.apiUrl;
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, openaiSource.secretKey, request.body.secret_id);
            headers = {};
            bodyParams = {
                logprobs: request.body.logprobs,
                top_logprobs: undefined,
            };

            // Adjust logprobs params for Chat Completions API, which expects { top_logprobs: number; logprobs: boolean; }
            if (!isTextCompletion && bodyParams.logprobs > 0) {
                bodyParams.top_logprobs = bodyParams.logprobs;
                bodyParams.logprobs = true;
            }

            if (getConfigValue('openai.randomizeUserId', false, 'boolean')) {
                bodyParams['user'] = uuidv4();
            }

            embedOpenRouterMedia(request.body.messages, { audio: true, video: false });
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
            const openrouterSource = resolveOpenAiWireChatSource(CHAT_COMPLETION_SOURCES.OPENROUTER);
            apiUrl = openrouterSource.apiUrl;
            apiKey = readSecret(request.user.directories, openrouterSource.secretKey, request.body.secret_id);
            // OpenRouter needs to pass the Referer and X-Title: https://openrouter.ai/docs#requests
            headers = { ...openrouterSource.headers };
            const includeReasoning = Boolean(request.body.include_reasoning);
            bodyParams = {
                transforms: getOpenRouterTransforms(request),
                plugins: getOpenRouterPlugins(request),
                reasoning: {
                    exclude: !includeReasoning,
                },
            };

            if (request.body.logprobs > 0) {
                bodyParams['top_logprobs'] = request.body.logprobs;
                bodyParams['logprobs'] = true;
            }

            if (request.body.min_p !== undefined) {
                bodyParams['min_p'] = request.body.min_p;
            }

            if (request.body.top_a !== undefined) {
                bodyParams['top_a'] = request.body.top_a;
            }

            if (request.body.repetition_penalty !== undefined) {
                bodyParams['repetition_penalty'] = request.body.repetition_penalty;
            }

            if (Array.isArray(request.body.provider) && request.body.provider.length > 0) {
                bodyParams['provider'] = {
                    allow_fallbacks: request.body.allow_fallbacks ?? true,
                    order: request.body.provider ?? [],
                };
            }

            if (Array.isArray(request.body.quantizations) && request.body.quantizations.length > 0) {
                bodyParams['provider'] ??= {};
                bodyParams['provider']['quantizations'] = request.body.quantizations;
            }

            if (request.body.use_fallback) {
                bodyParams['route'] = 'fallback';
            }

            if (request.body.reasoning_effort) {
                bodyParams['reasoning']['effort'] = request.body.reasoning_effort;
            }

            if (request.body.verbosity) {
                bodyParams['verbosity'] = request.body.verbosity;
            }

            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        strict: request.body.json_schema.strict ?? true,
                        schema: request.body.json_schema.value,
                    },
                };
            }

            const isClaude = /^anthropic\/claude/.test(request.body.model);
            const isGemini = /google\/gemini/.test(request.body.model);
            const isCacheableGemini = isGemini && await isOpenRouterModelCacheable(request.body.model);
            const enableGeminiSystemPromptCache = getConfigValue('gemini.enableSystemPromptCache', false, 'boolean');

            if (Array.isArray(request.body.messages)) {
                embedOpenRouterMedia(request.body.messages, { audio: true, video: true });
                addOpenRouterSignatures(request.body.messages, request.body.model);

                if (isClaude) {
                    if (enableSystemPromptCache) {
                        cachingSystemPromptForOpenRouter(request.body.messages, cacheTTL);
                    }

                    if (cachingAtDepth !== -1) {
                        cachingAtDepthForOpenRouterClaude(request.body.messages, cachingAtDepth, cacheTTL);
                    }
                }

                if (isCacheableGemini && enableGeminiSystemPromptCache) {
                    cachingSystemPromptForOpenRouter(request.body.messages);
                }
            }

            if (isGemini) {
                bodyParams['safety_settings'] = GEMINI_SAFETY;
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            const customSource = resolveOpenAiWireChatSource(CHAT_COMPLETION_SOURCES.CUSTOM, { customUrl: request.body.custom_url });
            apiUrl = customSource.apiUrl;
            apiKey = readSecret(request.user.directories, customSource.secretKey, request.body.secret_id);
            headers = {};
            bodyParams = {
                logprobs: request.body.logprobs,
                top_logprobs: undefined,
            };

            // Adjust logprobs params for Chat Completions API, which expects { top_logprobs: number; logprobs: boolean; }
            if (!isTextCompletion && bodyParams.logprobs > 0) {
                bodyParams.top_logprobs = bodyParams.logprobs;
                bodyParams.logprobs = true;
            }

            mergeObjectWithYaml(bodyParams, request.body.custom_include_body);
            mergeObjectWithYaml(headers, request.body.custom_include_headers);
            embedOpenRouterMedia(request.body.messages, { audio: true, video: false });
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        strict: request.body.json_schema.strict ?? true,
                        schema: request.body.json_schema.value,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.PERPLEXITY) {
            apiUrl = API_PERPLEXITY;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.PERPLEXITY, request.body.secret_id);
            headers = {};
            bodyParams = {
                reasoning_effort: request.body.reasoning_effort,
            };
            request.body.messages = postProcessPrompt(request.body.messages, PROMPT_PROCESSING_TYPE.STRICT, getPromptNames(request));
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        schema: request.body.json_schema.value,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
            apiUrl = API_GROQ;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.GROQ, request.body.secret_id);
            headers = {};
            bodyParams = {};
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        description: request.body.json_schema.description,
                        schema: request.body.json_schema.value,
                        strict: request.body.json_schema.strict ?? true,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS) {
            apiUrl = API_FIREWORKS;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.FIREWORKS, request.body.secret_id);
            headers = {};
            bodyParams = {};
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        description: request.body.json_schema.description,
                        schema: request.body.json_schema.value,
                        strict: request.body.json_schema.strict ?? true,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
            apiUrl = API_NANOGPT;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.NANOGPT, request.body.secret_id);
            headers = {};
            bodyParams = {};
            if (request.body.nanogpt_provider) {
                headers['X-Provider'] = request.body.nanogpt_provider;
            }
            if (request.body.nanogpt_payg_override) {
                headers['X-Billing-Mode'] = 'paygo';
                bodyParams['billing_mode'] = 'paygo';
            }
            if (request.body.enable_web_search && !/:online$/.test(request.body.model)) {
                request.body.model = `${request.body.model}:online`;
            }
            if (request.body.min_p !== undefined) {
                bodyParams['min_p'] = request.body.min_p;
            }
            if (request.body.top_a !== undefined) {
                bodyParams['top_a'] = request.body.top_a;
            }
            if (request.body.repetition_penalty !== undefined) {
                bodyParams['repetition_penalty'] = request.body.repetition_penalty;
            }
            if (request.body.reasoning_effort) {
                const effort = NANOGPT_REASONING_EFFORT_MAP[request.body.reasoning_effort];
                bodyParams['reasoning'] = { effort: effort };
            }

            const isClaude = /(?:^|\/)claude[-_]/.test(request.body.model);
            if (enableSystemPromptCache && isClaude) {
                bodyParams['cache_control'] = {
                    'enabled': true,
                    'ttl': cacheTTL,
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS) {
            const isAnonymous = request.body.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS;
            apiUrl = isAnonymous ? API_POLLINATIONS_ANON : API_POLLINATIONS;
            apiKey = isAnonymous ? 'anonymous' : readSecret(request.user.directories, SECRET_KEYS.POLLINATIONS, request.body.secret_id);
            headers = {};
            bodyParams = {
                seed: request.body.seed ?? Math.floor(Math.random() * 99999999),
            };
            if (!isAnonymous) {
                bodyParams['reasoning_effort'] = request.body.reasoning_effort;
                if (request.body.json_schema) {
                    bodyParams['response_format'] = {
                        type: 'json_schema',
                        json_schema: {
                            schema: request.body.json_schema.value,
                        },
                    };
                }
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT) {
            apiUrl = new URL(request.body.reverse_proxy || API_MOONSHOT).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MOONSHOT, request.body.secret_id);
            headers = {};
            bodyParams = {
                thinking: {
                    type: request.body.include_reasoning ? 'enabled' : 'disabled',
                },
            };
            request.body.json_schema
                ? setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema)
                : addAssistantPrefix(request.body.messages, [], 'partial');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COMETAPI) {
            apiUrl = API_COMETAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COMETAPI, request.body.secret_id);
            headers = {};
            bodyParams = {
                reasoning_effort: request.body.reasoning_effort,
            };
            throw new Error('This provider is temporarily disabled.');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.ZAI) {
            const defaultApiUrl = request.body.zai_endpoint === ZAI_ENDPOINT.CODING ? API_ZAI_CODING : API_ZAI_COMMON;
            apiUrl = new URL(request.body.reverse_proxy || defaultApiUrl).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.ZAI, request.body.secret_id);
            headers = {
                'Accept-Language': 'en-US,en',
            };
            bodyParams = {
                thinking: {
                    type: request.body.include_reasoning ? 'enabled' : 'disabled',
                },
            };
            if (request.body.json_schema) {
                setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema);
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
            const defaultApiUrl = request.body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN
                ? API_SILICONFLOW_CN : API_SILICONFLOW;
            apiUrl = defaultApiUrl;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.SILICONFLOW, request.body.secret_id);
            headers = {};
            bodyParams = {};
            if (request.body.json_schema) {
                setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema);
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.WORKERS_AI) {
            apiKey = readSecret(request.user.directories, SECRET_KEYS.WORKERS_AI, request.body.secret_id);
            const accountId = String(request.body.workers_ai_account_id || '').trim();
            if (!accountId) {
                log.warn(LogClass.NORMAL, 'Cloudflare Workers AI Account ID is missing.');
                return response.status(400).send({ error: true });
            }
            apiUrl = `${API_WORKERS_AI}/${encodeURIComponent(accountId)}/ai/v1`;
            headers = {};
            bodyParams = {
                repetition_penalty: request.body.repetition_penalty,
            };
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: request.body.json_schema.value,
                };
            }
        } else {
            log.warn(LogClass.NORMAL, 'This chat completion source is not supported yet.');
            return response.status(400).send({ error: true });
        }

        // A few of OpenAIs reasoning models support reasoning effort
        if (request.body.reasoning_effort && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(request.body.chat_completion_source)) {
            if (OPENAI_REASONING_EFFORT_MODELS.includes(request.body.model)) {
                bodyParams['reasoning_effort'] = OPENAI_FIXED_REASONING_EFFORT[request.body.model] ?? OPENAI_REASONING_EFFORT_MAP[request.body.reasoning_effort] ?? request.body.reasoning_effort;
            }
            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM && /^koboldcpp\/(.+)$/.test(request.body.model)) {
                bodyParams['reasoning_effort'] = request.body.reasoning_effort;
            }
        }

        if (request.body.verbosity && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(request.body.chat_completion_source)) {
            if (OPENAI_VERBOSITY_MODELS.test(request.body.model)) {
                bodyParams['verbosity'] = request.body.verbosity;
            }
        }

        if (!apiKey && !request.body.reverse_proxy && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            log.warn(LogClass.NORMAL, 'OpenAI API key is missing.');
            return response.status(400).send({ error: true });
        }

        // Add custom stop sequences
        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        const textPrompt = isTextCompletion ? convertTextCompletionPrompt(request.body.messages) : '';
        const endpointUrl = isTextCompletion && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.OPENROUTER ?
            `${apiUrl}/completions` :
            `${apiUrl}/chat/completions`;

        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            controller.abort();
        });

        if (!isTextCompletion && Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.json_schema && !bodyParams['response_format']) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    strict: request.body.json_schema.strict ?? true,
                    schema: request.body.json_schema.value,
                },
            };
        }

        const requestBody = {
            'messages': isTextCompletion === false ? request.body.messages : undefined,
            'prompt': isTextCompletion === true ? textPrompt : undefined,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'max_completion_tokens': request.body.max_completion_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'stop': isTextCompletion === false ? request.body.stop : undefined,
            'logit_bias': request.body.logit_bias,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            excludeKeysByYaml(requestBody, request.body.custom_exclude_body);
        }

        /** @type {import('node-fetch').RequestInit} */
        const config = {
            method: 'post',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };

        log.debug(LogClass.SENSITIVE, 'Chat Completion request:', requestBody);

        const fetchResponse = await fetch(endpointUrl, config);

        if (request.body.stream) {
            log.info(LogClass.NORMAL, 'Streaming request in progress');
            return await forwardFetchResponse(fetchResponse, response);
        }

        if (fetchResponse.ok) {
            /** @type {any} */
            const json = await fetchResponse.json();
            log.debug(LogClass.SENSITIVE, 'Chat Completion response:', json);
            return response.send(json);
        } else {
            const responseText = await fetchResponse.text();
            const errorData = tryParse(responseText);

            const message = fetchResponse.statusText || 'Unknown error occurred';
            const quota_error = fetchResponse.status === 429 && errorData?.error?.type === 'insufficient_quota';
            log.error(LogClass.NORMAL, 'Chat completion request error: ', message);
            log.error(LogClass.SENSITIVE, 'Chat completion error body:', responseText);

            if (!response.headersSent) {
                response.send({ error: { message }, quota_error: quota_error });
            } else if (!response.writableEnded) {
                response.write(responseText);
            } else {
                response.end();
            }
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Chat completion generation failed');
        log.error(LogClass.SENSITIVE, 'Generation failed', error);
        const message = error.code === 'ECONNREFUSED'
            ? `Connection refused: ${error.message}`
            : error.message || 'Unknown error occurred';

        if (!response.headersSent) {
            response.status(502).send({ error: { message, ...error } });
        } else {
            response.end();
        }
    }
});

const multimodalModels = express.Router();

multimodalModels.post('/pollinations', async (_req, res) => {
    try {
        const response = await fetch('https://gen.pollinations.ai/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data)) {
            return res.json([]);
        }

        const multimodalModels = data
            .filter(m => Array.isArray(m?.input_modalities))
            .filter(m => m.input_modalities.includes('image'))
            .map(m => m.name);
        return res.json(multimodalModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the Pollinations multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/aimlapi', async (_req, res) => {
    try {
        const response = await fetch('https://api.aimlapi.com/v1/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }

        const multimodalModels = data.data.filter(m => m?.features?.includes('openai/chat-completion.vision')).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the AI/ML API multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/nanogpt', async (_req, res) => {
    try {
        const response = await fetch('https://nano-gpt.com/api/v1/models?detailed=true');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }

        const multimodalModels = data.data.filter(m => m?.capabilities?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the NanoGPT multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/electronhub', async (_req, res) => {
    try {
        const response = await fetch('https://api.electronhub.ai/v1/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.data.filter(m => m.metadata?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the Electron Hub multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/chutes', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.CHUTES);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://llm.chutes.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        const data = await response.json();

        const modelsData = /** @type {{object: string, data: Array<{id: string, input_modalities?: string[]}>}} */ (data);
        const multimodalModels = modelsData.data
            .filter(m => m.input_modalities?.includes('image'))
            .map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the Chutes multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/mistral', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.MISTRALAI);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://api.mistral.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.data.filter(m => m.capabilities?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the MistralAI multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/xai', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.XAI);

        if (!key) {
            return res.json([]);
        }

        // xAI's /models endpoint doesn't return modality info, so we must use /language-models instead
        const response = await fetch('https://api.x.ai/v1/language-models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.models.filter(m => m.input_modalities?.includes('image')).map(m => m.id);
        if (!multimodalModels.includes('grok-4-0709')) {
            // The endpoint says it doesn't support images, but it does
            multimodalModels.push('grok-4-0709');
        }
        return res.json(multimodalModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the xAI multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/moonshot', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.MOONSHOT);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://api.moonshot.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        const multimodalModels = data.data.filter(m => m.supports_image_in).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the Moonshot multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/workers_ai', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.WORKERS_AI);
        const accountId = String(req.body.workers_ai_account_id || '').trim();

        if (!key || !accountId) {
            return res.json([]);
        }

        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=Text+Generation&per_page=1000`;
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + key },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const models = Array.isArray(data?.result)
            ? data.result
                .filter(m => Array.isArray(m.properties) && m.properties.some(p => p.property_id === 'vision' && p.value === 'true'))
                .map(m => m.name)
            : [];
        return res.json(models);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to fetch the Cloudflare Workers AI multimodal model list');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});

router.use('/multimodal-models', multimodalModels);

router.post('/process', async function (request, response) {
    try {
        if (!Array.isArray(request.body.messages)) {
            return response.status(400).send({ error: 'Invalid messages format' });
        }

        if (!Object.values(PROMPT_PROCESSING_TYPE).includes(request.body.type)) {
            return response.status(400).send({ error: 'Unknown processing type' });
        }

        const messages = postProcessPrompt(request.body.messages, request.body.type, getPromptNames(request));
        return response.send({ messages });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to post-process the prompt');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});
