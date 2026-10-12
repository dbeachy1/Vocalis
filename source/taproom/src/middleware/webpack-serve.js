import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from '../../webpack.config.js';
import { log, LogClass } from '../logger.js';

export default function getWebpackServeMiddleware() {
    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    function devMiddleware(req, res, next) {
        const publicLibConfig = getPublicLibConfig();
        const outputPath = publicLibConfig.output?.path;
        const outputFile = publicLibConfig.output?.filename;
        const parsedPath = path.parse(req.path);

        if (req.method === 'GET' && parsedPath.dir === '/' && parsedPath.base === outputFile) {
            return res.sendFile(outputFile, { root: outputPath });
        }

        next();
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=false] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    devMiddleware.runWebpackCompiler = ({ forceDist = false, pruneCache = false } = {}) => {
        log.info(LogClass.NORMAL);
        log.info(LogClass.NORMAL, 'Compiling frontend libraries...');

        const publicLibConfig = getPublicLibConfig({ forceDist, pruneCache });
        const compiler = webpack(publicLibConfig);

        return new Promise((resolve) => {
            compiler.run((error, stats) => {
                // 🔴 THIS ERROR WAS DISCARDED, AND THE FAILURE IT REPORTS IS TOTALLY SILENT. On a hard
                // webpack failure `stats` is undefined, so `output` is falsy and the branch below logs
                // NOTHING — not even a suppression stub — and the boot walks past a broken frontend
                // build with the operator none the wiser. Found during the §4 redaction sweep.
                //
                // Split rather than redact(error): safeErrorCode() runs only on the suppressed branch,
                // so this keeps the errno on the stub. Same reasoning as content-manager.js:106.
                if (error) {
                    log.error(LogClass.NORMAL, 'Frontend library compilation failed.');
                    log.error(LogClass.SENSITIVE, error);
                }

                // A compile that merely *reports* errors does reach the line below, but only as a
                // stub — which tells the operator something happened and nothing about what. The
                // sentence is safe on its own; the stats text is not, since it carries absolute
                // module and cache paths rooted at serverDirectory and DATA_ROOT.
                if (stats?.hasErrors()) {
                    log.error(LogClass.NORMAL, 'Frontend library compilation reported errors.');
                }

                const output = stats?.toString(publicLibConfig.stats);
                if (output) {
                    log.info(LogClass.SENSITIVE, output);
                    log.info(LogClass.NORMAL);
                }
                compiler.close(() => {
                    resolve();
                });
            });
        });
    };

    return devMiddleware;
}
