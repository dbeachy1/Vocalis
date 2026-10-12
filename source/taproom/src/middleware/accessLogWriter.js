import path from 'node:path';
import fs from 'node:fs';
import { getIpAddress } from '../express-common.js';
import { color, getConfigValue } from '../util.js';
import { log, LogClass } from '../logger.js';

const enableAccessLog = getConfigValue('logging.enableAccessLog', true, 'boolean');

const knownIPs = new Set();

export const getAccessLogPath = () => path.join(globalThis.DATA_ROOT, 'access.log');

export function migrateAccessLog() {
    try {
        if (!fs.existsSync('access.log')) {
            return;
        }
        const logPath = getAccessLogPath();
        if (fs.existsSync(logPath)) {
            return;
        }
        fs.renameSync('access.log', logPath);
        log.info(LogClass.SENSITIVE, color.yellow('Migrated access.log to new location:'), logPath);
    } catch (e) {
        log.error(LogClass.NORMAL, 'Failed to migrate access.log to the data directory');
        log.error(LogClass.SENSITIVE, 'Failed to migrate access log:', e);
        log.info(LogClass.NORMAL, 'Please move access.log to the data directory manually.');
    }
}

/**
 * Creates middleware for logging access and new connections
 * @returns {import('express').RequestHandler}
 */
export default function accessLoggerMiddleware() {
    return function (req, res, next) {
        const clientIp = getIpAddress(req, true);
        const userAgent = req.headers['user-agent'];

        if (!knownIPs.has(clientIp)) {
            // Log new connection
            knownIPs.add(clientIp);

            // Write to access log if enabled
            if (enableAccessLog) {
                log.info(LogClass.SENSITIVE, color.yellow(`New connection from ${clientIp}; User Agent: ${userAgent}\n`));
                const logPath = getAccessLogPath();
                const timestamp = new Date().toISOString();
                const entry = `${timestamp} ${clientIp} ${userAgent}\n`;

                fs.appendFile(logPath, entry, (err) => {
                    if (err) {
                        log.error(LogClass.NORMAL, 'Failed to append a new connection entry to the access log');
                        log.error(LogClass.SENSITIVE, 'Failed to write access log:', err);
                    }
                });
            }
        }

        next();
    };
}
