/**
 * Scripts to be done before starting the server for the first time.
 */
import path from 'node:path';
import process from 'node:process';
import { addMissingConfigValues } from './config-init.js';
import { log, LogClass } from './logger.js';

try {
    addMissingConfigValues(path.join(process.cwd(), './config.yaml'));
} catch (error) {
    log.error(LogClass.NORMAL, 'Failed to add missing config values to config.yaml');
    log.error(LogClass.SENSITIVE, error);
}
