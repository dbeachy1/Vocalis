import express from 'express';
import { getPipeline, getRawImage } from '../transformers.js';
import { log, LogClass } from '../logger.js';

export const router = express.Router();

const TASK = 'image-to-text';

router.post('/', async (req, res) => {
    try {
        const { image } = req.body;

        const rawImage = await getRawImage(image);

        if (!rawImage) {
            log.warn(LogClass.NORMAL, 'Failed to parse captioned image');
            return res.sendStatus(400);
        }

        const pipe = await getPipeline(TASK);
        const result = await pipe(rawImage);
        const text = result[0].generated_text;
        log.info(LogClass.SENSITIVE, 'Image caption:', text);

        return res.json({ caption: text });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to caption image with the local model');
        log.error(LogClass.SENSITIVE, error);
        return res.sendStatus(500);
    }
});
