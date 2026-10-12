import { getPipeline, getLoadedModelForTask } from '../transformers.js';
const TASK = 'feature-extraction';

/**
 * Gets the vectorized text in form of an array of numbers.
 * @param {string} text - The text to vectorize
 * @returns {Promise<number[]>} - The vectorized text in form of an array of numbers
 */
export async function getTransformersVector(text) {
    const pipe = await getPipeline(TASK);
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(result.data);
    return vector;
}

/**
 * Gets the vectorized texts in form of an array of arrays of numbers.
 * @param {string[]} texts - The texts to vectorize
 * @returns {Promise<number[][]>} - The vectorized texts in form of an array of arrays of numbers
 */
export async function getTransformersBatchVector(texts) {
    const result = [];
    for (const text of texts) {
        result.push(await getTransformersVector(text));
    }
    return result;
}

/**
 * Gets the vectorized texts TOGETHER WITH the model that produced them.
 *
 * 🔴 THE MODEL NAME IS NOT A NICETY, WHICH IS WHY IT IS NOT OPTIONAL. A vector is only meaningful next to
 * other vectors from the same model. A caller that stores vectors — keyed by model, as SillyTavern's own
 * `vectors/<source>/<collectionId>/<model>` layout already is — cannot file one it cannot name, and two models
 * of the same dimension filed together compare cleanly and mean nothing. Returning the pair as one value is
 * what makes it impossible to have the vectors without the name.
 *
 * Vectors arrive unit-normalised (`normalize: true`, above), so cosine similarity is a plain dot product.
 * @param {string[]} texts - The texts to vectorize
 * @returns {Promise<{vectors: number[][], model: string|null}>} The vectors, and the model that made them
 */
export async function getTransformersBatchVectorWithModel(texts) {
    // Load first, ask second. An empty batch never touches the pipeline, and the model of a pipeline that was
    // never loaded is null -- so the degenerate case would be the one that answers "no model", which is the
    // one answer this function exists to never give.
    await getPipeline(TASK);
    const vectors = await getTransformersBatchVector(texts);

    // Asked AFTER the vectors exist, so it names the pipeline that actually made them rather than the one the
    // config would pick today.
    const model = getLoadedModelForTask(TASK);
    return { vectors, model };
}
