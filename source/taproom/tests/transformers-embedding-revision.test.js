import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';

const pipelineMock = jest.fn();
const transformerEnv = { backends: { onnx: { wasm: {} } } };
jest.unstable_mockModule('sillytavern-transformers', () => ({
    pipeline: pipelineMock,
    env: transformerEnv,
    RawImage: {},
}));

const configEnvironmentKeys = [
    'SILLYTAVERN_EXTENSIONS_MODELS_EMBEDDING',
    'SILLYTAVERN_EXTENSIONS_MODELS_EMBEDDINGREVISION',
    'SILLYTAVERN_EXTENSIONS_MODELS_AUTODOWNLOAD',
];
const originalEnvironment = new Map(configEnvironmentKeys.map(key => [key, process.env[key]]));
const originalDataRoot = globalThis.DATA_ROOT;
let dataRoot;
let moduleSequence = 0;

afterEach(() => {
    pipelineMock.mockReset();
    for (const key of configEnvironmentKeys) {
        const value = originalEnvironment.get(key);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    if (dataRoot) {
        fs.rmSync(dataRoot, { recursive: true, force: true });
        dataRoot = undefined;
    }
    if (originalDataRoot === undefined) {
        delete globalThis.DATA_ROOT;
    } else {
        globalThis.DATA_ROOT = originalDataRoot;
    }
});

function prepareEnvironment({ model = 'Xenova/multi-qa-mpnet-base-cos-v1', revision, autoDownload = 'true' } = {}) {
    for (const key of configEnvironmentKeys) {
        delete process.env[key];
    }
    process.env.SILLYTAVERN_EXTENSIONS_MODELS_EMBEDDING = model;
    process.env.SILLYTAVERN_EXTENSIONS_MODELS_AUTODOWNLOAD = autoDownload;
    if (revision !== undefined) {
        process.env.SILLYTAVERN_EXTENSIONS_MODELS_EMBEDDINGREVISION = revision;
    }
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transformers-revision-'));
    globalThis.DATA_ROOT = dataRoot;
}

async function loadTransformerModule() {
    moduleSequence += 1;
    return import(`../src/transformers.js?revision-test=${moduleSequence}`);
}

function makePipeline() {
    return { dispose: jest.fn().mockResolvedValue(undefined) };
}

describe('embedding model revision pin', () => {
    test('passes the configured revision and reuses the same model/revision pipeline', async () => {
        const revision = '0123456789abcdef0123456789abcdef01234567';
        prepareEnvironment({ revision });
        const instance = makePipeline();
        pipelineMock.mockResolvedValue(instance);
        const { getPipeline } = await loadTransformerModule();

        const first = await getPipeline('feature-extraction');
        const second = await getPipeline('feature-extraction');

        expect(first).toBe(instance);
        expect(second).toBe(instance);
        expect(pipelineMock).toHaveBeenCalledTimes(1);
        expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'Xenova/multi-qa-mpnet-base-cos-v1', {
            cache_dir: path.join(dataRoot, '_cache'),
            quantized: true,
            local_files_only: false,
            revision,
        });
    });

    test('does not apply the configured model revision to a forceModel override', async () => {
        prepareEnvironment({ revision: 'pinned-revision' });
        const configuredPipeline = makePipeline();
        const overridePipeline = makePipeline();
        pipelineMock.mockResolvedValueOnce(configuredPipeline).mockResolvedValueOnce(overridePipeline);
        const { getPipeline } = await loadTransformerModule();

        await getPipeline('feature-extraction');
        const override = await getPipeline('feature-extraction', 'Xenova/other-model');

        expect(override).toBe(overridePipeline);
        expect(configuredPipeline.dispose).toHaveBeenCalledTimes(1);
        expect(pipelineMock).toHaveBeenNthCalledWith(2, 'feature-extraction', 'Xenova/other-model', expect.not.objectContaining({ revision: expect.anything() }));
    });

    test('does not apply a configured revision when using the task fallback model', async () => {
        prepareEnvironment({ model: '', revision: 'configured-model-revision' });
        pipelineMock.mockResolvedValue(makePipeline());
        const { getPipeline } = await loadTransformerModule();

        await getPipeline('feature-extraction');

        expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-mpnet-base-v2', expect.not.objectContaining({ revision: expect.anything() }));
    });

    test('omits empty revisions and reloads when the configured revision changes', async () => {
        prepareEnvironment({ revision: '' });
        const firstPipeline = makePipeline();
        const secondPipeline = makePipeline();
        pipelineMock.mockResolvedValueOnce(firstPipeline).mockResolvedValueOnce(secondPipeline);
        const { getPipeline } = await loadTransformerModule();

        await getPipeline('feature-extraction');
        expect(pipelineMock.mock.calls[0][2]).not.toHaveProperty('revision');

        process.env.SILLYTAVERN_EXTENSIONS_MODELS_EMBEDDINGREVISION = 'new-pinned-revision';
        const updated = await getPipeline('feature-extraction');

        expect(updated).toBe(secondPipeline);
        expect(firstPipeline.dispose).toHaveBeenCalledTimes(1);
        expect(pipelineMock).toHaveBeenNthCalledWith(2, 'feature-extraction', 'Xenova/multi-qa-mpnet-base-cos-v1', expect.objectContaining({ revision: 'new-pinned-revision' }));
    });
});
