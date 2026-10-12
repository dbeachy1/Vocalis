#!/usr/bin/env node
import { CommandLineParser } from './src/command-line.js';
import { serverDirectory } from './src/server-directory.js';
import { log, LogClass, initLogger, installConsoleSeam, redact } from './src/logger.js';
import { getConfigValue } from './src/util.js';
import { LOG_LEVELS } from './src/constants.js';

// `NODE_ENV` is normally unset, and interpolating it produced the literal line "Running in undefined
// environment." on every boot. It is the FIRST line an operator reads, and on 2026-07-21 it was also the
// line repeated ~500 times while the server crash-looped — so it wants to say something true, or nothing.
const environment = process.env.NODE_ENV ? ` Running in ${process.env.NODE_ENV} environment.` : '';

log.info(LogClass.NORMAL, `Node version: ${process.version}.${environment}`);
log.info(LogClass.NORMAL, 'Server directory:', redact(serverDirectory));

// config.yaml will be set when parsing command line arguments
const cliArgs = new CommandLineParser().parse(process.argv);

// Everything above this point was buffered in memory: config has to be readable before the writer
// can know which file to open, and config loading logs on its way through. Opening it here flushes
// that buffer in order, so nothing escapes to stdout and nothing is lost.
initLogger({
    directory: serverDirectory,
    file: getConfigValue('logging.file', 'st'),
    debugMode: getConfigValue('logging.debugMode', false, 'boolean'),
    minLogLevel: getConfigValue('logging.minLogLevel', LOG_LEVELS.DEBUG, 'number'),
    maxSizeMB: getConfigValue('logging.maxSizeMB', 10, 'number'),
    maxArchives: getConfigValue('logging.maxArchives', 20, 'number'),
    timezone: getConfigValue('logging.timezone', 'local'),
});

// Captures the libraries, which we cannot audit and some of which print user data.
installConsoleSeam();

globalThis.DATA_ROOT = cliArgs.dataRoot;
globalThis.COMMAND_LINE_ARGS = cliArgs;
process.chdir(serverDirectory);

try {
    await import('./src/server-main.js');
} catch (error) {
    log.error(LogClass.NORMAL, 'A critical error has occurred while starting the server.');
    log.error(LogClass.SENSITIVE, 'A critical error has occurred while starting the server:', error);
    process.exitCode = 1;
}
