import fs from 'fs';
import path from 'path';
import { serverDirectory } from './server-directory.js';
import { log, LogClass } from './logger.js';

// Default to 0 seconds (disabled) if not set
const intervalSeconds = parseInt(process.env.SILLYTAVERN_HEARTBEATINTERVAL || '0');
const intervalMs = intervalSeconds * 1000;

// Heartbeat disabled
if (Number.isNaN(intervalSeconds) || intervalSeconds <= 0) {
    process.exit(0);
}

// Allow a grace period (2 missed beats)
const threshold = intervalMs * 2;

const dataRoot = process.env.SILLYTAVERN_DATAROOT || path.join(serverDirectory, 'data');
const heartbeatFile = path.join(dataRoot, 'heartbeat.json');

try {
    if (!fs.existsSync(heartbeatFile)) {
        log.error(LogClass.NORMAL, 'Healthcheck: the heartbeat file does not exist');
        log.error(LogClass.SENSITIVE, `Heartbeat file not found at: ${heartbeatFile}`);
        process.exit(1);
    }

    const stats = fs.statSync(heartbeatFile);
    const lastModified = stats.mtimeMs;
    const now = Date.now();
    const diff = now - lastModified;

    if (diff > threshold) {
        log.error(LogClass.NORMAL, `Server is unresponsive. Last heartbeat was ${Math.round(diff / 1000)} seconds ago.`);
        process.exit(1);
    }

    process.exit(0);
} catch (err) {
    log.error(LogClass.NORMAL, 'Healthcheck failed while reading the heartbeat file');
    log.error(LogClass.SENSITIVE, 'Healthcheck error:', err.message);
    process.exit(1);
}
