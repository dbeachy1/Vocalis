import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';

import { pipeline, env, RawImage } from 'sillytavern-transformers';
import { getConfigValue } from './util.js';
import { serverDirectory } from './server-directory.js';
import { log, LogClass, redact } from './logger.js';

configureTransformers();

function configureTransformers() {
    // Limit the number of threads to 1 to avoid issues on Android
    env.backends.onnx.wasm.numThreads = 1;
    // Use WASM from a local folder to avoid CDN connections
    env.backends.onnx.wasm.wasmPaths = path.join(serverDirectory, 'node_modules', 'sillytavern-transformers', 'dist') + path.sep;
}

const tasks = {
    'text-classification': {
        defaultModel: 'Cohee/distilbert-base-uncased-go-emotions-onnx',
        pipeline: null,
        configField: 'extensions.models.classification',
        quantized: true,
    },
    'image-to-text': {
        defaultModel: 'Xenova/vit-gpt2-image-captioning',
        pipeline: null,
        configField: 'extensions.models.captioning',
        quantized: true,
    },
    'feature-extraction': {
        defaultModel: 'Xenova/all-mpnet-base-v2',
        pipeline: null,
        currentRevision: null,
        configField: 'extensions.models.embedding',
        quantized: true,
    },
    'automatic-speech-recognition': {
        defaultModel: 'Xenova/whisper-small',
        pipeline: null,
        configField: 'extensions.models.speechToText',
        quantized: true,
    },
    'text-to-speech': {
        defaultModel: 'Xenova/speecht5_tts',
        pipeline: null,
        configField: 'extensions.models.textToSpeech',
        quantized: false,
    },
};

/**
 * Gets a RawImage object from a base64-encoded image.
 * @param {string} image Base64-encoded image
 * @returns {Promise<RawImage|null>} Object representing the image
 */
export async function getRawImage(image) {
    try {
        const buffer = Buffer.from(image, 'base64');
        const byteArray = new Uint8Array(buffer);
        const blob = new Blob([byteArray]);

        const rawImage = await RawImage.fromBlob(blob);
        return rawImage;
    } catch {
        return null;
    }
}

/**
 * Gets the model to use for a given transformers.js task.
 * @param {string} task The task to get the model for
 * @returns {string} The model to use for the given task
 */
function getModelForTask(task) {
    const defaultModel = tasks[task].defaultModel;

    try {
        const model = getConfigValue(tasks[task].configField, null);
        return model || defaultModel;
    } catch (error) {
        log.warn(LogClass.NORMAL, 'Failed to read config.yaml, using default classification model.');
        return defaultModel;
    }
}

/**
 * Gets the model a task's pipeline was ACTUALLY loaded with.
 *
 * 🔴 THIS IS NOT `getModelForTask()`, AND THE DIFFERENCE IS THE WHOLE POINT. That one reads the config and
 * answers what the model *would* be on a fresh load; this one answers what it *is*. `getPipeline()` hands back
 * an already-loaded pipeline without re-reading the config, so the two agree only until the config changes
 * under a running process — and from then on the config is describing a model that is not the one producing
 * the vectors.
 *
 * Anyone who has to file a vector under the model that made it needs this answer, not the other one. Two
 * models of the same dimension filed together return arithmetically valid nonsense drawn from two coordinate
 * systems, silently and for ever.
 * @param {string} task The task to ask about
 * @returns {string|null} The model in use, or null if this task's pipeline has not been loaded yet
 */
export function getLoadedModelForTask(task) {
    return tasks[task]?.currentModel ?? null;
}

async function migrateCacheToDataDir() {
    const oldCacheDir = path.join(process.cwd(), 'cache');
    const newCacheDir = path.join(globalThis.DATA_ROOT, '_cache');

    if (!fs.existsSync(newCacheDir)) {
        fs.mkdirSync(newCacheDir, { recursive: true });
    }

    if (fs.existsSync(oldCacheDir) && fs.statSync(oldCacheDir).isDirectory()) {
        const files = fs.readdirSync(oldCacheDir);

        if (files.length === 0) {
            return;
        }

        log.info(LogClass.NORMAL, 'Migrating model cache files to data directory. Please wait...');

        for (const file of files) {
            try {
                const oldPath = path.join(oldCacheDir, file);
                const newPath = path.join(newCacheDir, file);
                fs.cpSync(oldPath, newPath, { recursive: true, force: true });
                fs.rmSync(oldPath, { recursive: true, force: true });
            } catch (error) {
                // Two calls, not redact(error): this had NO published half at all, so the operator saw a
                // bare stub for a real failure. The split keeps the errno on the stub (safeErrorCode()
                // runs only on the suppressed branch) while publishing the sentence that explains it.
                log.warn(LogClass.NORMAL, 'Failed to migrate cache file. The model will be re-downloaded.');
                log.warn(LogClass.SENSITIVE, error);
            }
        }
    }
}

/**
 * Gets the transformers.js pipeline for a given task.
 * @param {import('sillytavern-transformers').PipelineType} task The task to get the pipeline for
 * @param {string} forceModel The model to use for the pipeline, if any
 * @returns {Promise<import('sillytavern-transformers').Pipeline>} The transformers.js pipeline
 */
export async function getPipeline(task, forceModel = '') {
    await migrateCacheToDataDir();

    const model = forceModel || getModelForTask(task);
    const revision = getRevisionForTask(task, model);

    if (tasks[task].pipeline) {
        if (tasks[task].currentModel === model && (tasks[task].currentRevision ?? null) === revision) {
            return tasks[task].pipeline;
        }
        log.info(LogClass.NORMAL, 'Disposing transformers.js pipeline for task', task, 'with model', redact(tasks[task].currentModel));
        await tasks[task].pipeline.dispose();
        tasks[task].pipeline = null;
        tasks[task].currentModel = null;
        tasks[task].currentRevision = null;
    }

    const cacheDir = path.join(globalThis.DATA_ROOT, '_cache');
    const localOnly = !getConfigValue('extensions.models.autoDownload', true, 'boolean');
    log.info(LogClass.NORMAL, 'Initializing transformers.js pipeline for task', task, 'with model', redact(model));
    const options = { cache_dir: cacheDir, quantized: tasks[task].quantized ?? true, local_files_only: localOnly };
    if (revision !== null) {
        options.revision = revision;
    }
    const instance = await pipeline(task, model, options);
    tasks[task].pipeline = instance;
    tasks[task].currentModel = model;
    tasks[task].currentRevision = revision;
    // @ts-ignore
    return instance;
}

function getRevisionForTask(task, model) {
    if (task !== 'feature-extraction') {
        return null;
    }

    try {
        // A configured embedding pin belongs only to that model, never to a forceModel override.
        const configuredModel = getConfigValue(tasks[task].configField, null);
        const revision = getConfigValue('extensions.models.embeddingRevision', null);
        if (configuredModel === model && typeof revision === 'string' && revision.trim() !== '') {
            return revision.trim();
        }
    } catch {
        // An absent optional revision keeps the library's normal default branch behavior.
    }

    return null;
}

export default {
    getRawImage,
    getPipeline,
};
