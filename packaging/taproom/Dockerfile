# syntax=docker/dockerfile:1.7
# Build context is the generated build context; retained components come from named source contexts.
FROM --platform=linux/amd64 ubuntu@sha256:88a381d5b5eeb2b35d3ad70925a362c37ce569daf43ede89ff818ec20e4d3794 AS base
ARG DEBIAN_FRONTEND=noninteractive

COPY --from=taproom-source /payload/packaging/taproom/apt-runtime.sha256 /tmp/apt-runtime.sha256
RUN --mount=type=bind,from=apt-runtime,target=/apt,readonly \
    set -eu; \
    cd /apt; \
    sha256sum -c /tmp/apt-runtime.sha256; \
    DEBIAN_FRONTEND=noninteractive dpkg -i \
      /apt/libssl3t64_3.5.5-1ubuntu3.7_amd64.deb \
      /apt/openssl-provider-legacy_3.5.5-1ubuntu3.7_amd64.deb \
      /apt/openssl_3.5.5-1ubuntu3.7_amd64.deb \
      /apt/ca-certificates_20260601~26.04.1_all.deb \
      /apt/xz-utils_5.8.3-1_amd64.deb \
      /apt/libatomic1_16-20260322-1ubuntu1_amd64.deb; \
    rm /tmp/apt-runtime.sha256

ADD --checksum=sha256:3883bfc73f9a680ca4eab04b196068aaaab1373ffa77d8fc1a4408222495b651 \
    https://nodejs.org/dist/v26.11.1/node-v26.11.1-linux-x64.tar.xz \
    /tmp/node.tar.xz
RUN mkdir -p /opt/node \
 && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
 && rm /tmp/node.tar.xz

ENV PATH=/opt/node/bin:${PATH}

FROM base AS dependencies
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=taproom-source /payload/packaging/taproom/apt-build.sha256 /tmp/apt-build.sha256
RUN --mount=type=bind,from=apt-build,target=/apt,readonly \
    set -eu; \
    cd /apt; \
    sha256sum -c /tmp/apt-build.sha256; \
    for deb in /apt/*.deb; do \
      name=${deb##*/}; \
      if ! grep -Fq "  $name" /tmp/apt-build.sha256; then \
        echo "unmanifested apt artifact: $name" >&2; exit 1; \
      fi; \
    done; \
    set --; \
    for deb in /apt/*.deb; do \
      case "$deb" in */python3-minimal_*.deb|*/python3_*.deb) ;; *) set -- "$@" "$deb" ;; esac; \
    done; \
    DEBIAN_FRONTEND=noninteractive dpkg -i "$@"; \
    DEBIAN_FRONTEND=noninteractive dpkg -i \
      /apt/python3-minimal_3.14.3-0ubuntu2_amd64.deb; \
    DEBIAN_FRONTEND=noninteractive dpkg -i \
      /apt/python3_3.14.3-0ubuntu2_amd64.deb; \
    rm /tmp/apt-build.sha256

ENV npm_config_build_from_source=true \
    npm_config_nodedir=/opt/node \
    npm_config_node_gyp=/opt/node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js \
    npm_config_cache=/tmp/npm-cache

WORKDIR /opt/taproom
COPY --from=taproom-source /payload/source/taproom/package.json /payload/source/taproom/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os=linux --cpu=x64 \
 && npm rebuild protobufjs --offline --no-audit --no-fund \
 && rm -rf /tmp/npm-cache

WORKDIR /opt/taproom/plugins/mnemosyne
COPY --from=taproom-source /payload/source/mnemosyne/package.json /payload/source/mnemosyne/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os=linux --cpu=x64 \
 && npm rebuild better-sqlite3-multiple-ciphers --offline --foreground-scripts --loglevel=verbose \
 && node -e "const Database=require('better-sqlite3-multiple-ciphers'); const sqliteVec=require('sqlite-vec'); const db=new Database(':memory:'); db.pragma(\"cipher='sqlcipher'\"); sqliteVec.load(db); db.exec('CREATE VIRTUAL TABLE vectors USING vec0(embedding float[2])'); db.close();" \
 && rm -rf /tmp/npm-cache

# MCP client (Moeblack/sillytavern-mcp-client at 745ff27, AGPL-3.0).
# Built here from the imported source and its lockfile, never from upstream's committed bundles (and not from the
# untracked bundle a standalone install may carry). `--include=dev` because the build tools (tsup, vite,
# typescript) are devDependencies; `--replace-registry-host=always` because upstream's lockfile names a mirror host
# for every tarball and every download is checked against the lockfile's integrity hash either way.
# The result is the server plugin (plugin/index.bundle.js plus the committed ESM shim plugin/index.js) and the
# extension (dist/), plus the license notices of the npm packages bundled into the plugin.
FROM base AS mcp-client-build
ENV npm_config_cache=/tmp/npm-cache
WORKDIR /opt/mcp-client
COPY --from=taproom-source /payload/source/mcp-client/ ./
COPY --from=taproom-source /payload/packaging/taproom/collect-npm-notices.mjs /opt/collect-npm-notices.mjs
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund --os=linux --cpu=x64 --replace-registry-host=always \
 && npm run build \
 && node /opt/collect-npm-notices.mjs /opt/mcp-client /opt/mcp-client-notices \
 && test -s plugin/index.bundle.js && test -s dist/index.iife.js \
 && rm -rf /tmp/npm-cache

FROM dependencies AS source-verify
COPY --from=taproom-source /payload/ /tmp/source-payload/
COPY --from=taproom-source /artifacts/ /tmp/source-artifacts/
RUN python3 /tmp/source-payload/packaging/source-offer/verify_source_context.py \
      /tmp/source-payload /tmp/source-artifacts \
 && touch /tmp/source-offer-verified

FROM base AS taproom
ARG TAPROOM_UID=10001
ARG TAPROOM_GID=10001

WORKDIR /opt/taproom
COPY --from=dependencies /opt/node /opt/node
COPY --from=dependencies /opt/taproom/node_modules /opt/taproom/node_modules
COPY --from=source-verify /tmp/source-offer-verified /tmp/source-offer-verified
COPY --from=taproom-source /payload/source/taproom/server.js ./server.js
COPY --from=taproom-source /payload/source/taproom/package.json ./package.json
COPY --from=taproom-source /payload/source/taproom/webpack.config.js ./webpack.config.js
COPY --from=taproom-source /payload/source/taproom/src/ ./src/
COPY --from=taproom-source /payload/source/taproom/default/ ./default/
COPY --from=taproom-source /payload/source/taproom/public/ ./public/
COPY --from=taproom-source /payload/source/taproom/third-party-licenses/ ./third-party-licenses/
COPY --from=taproom-source /payload/packaging/taproom/config.yaml ./config.yaml
COPY --from=taproom-source /payload/packaging/taproom/entrypoint.sh ./entrypoint.sh
COPY --from=taproom-source /payload/packaging/taproom/provision-owner.mjs ./provision-owner.mjs

COPY --from=taproom-source /payload/source/vault/package.json ./storage-providers/vault/package.json
COPY --from=taproom-source /payload/source/vault/src/ ./storage-providers/vault/src/
COPY --from=taproom-source /payload/source/mnemosyne/package.json ./plugins/mnemosyne/package.json
COPY --from=taproom-source /payload/source/mnemosyne/src/ ./plugins/mnemosyne/src/
COPY --from=dependencies /opt/taproom/plugins/mnemosyne/node_modules ./plugins/mnemosyne/node_modules
# Extension folder names are the names on existing installs (October 10, 2026),
# so an existing per-user copy of the same name takes precedence exactly as today (discovery drops a global
# copy only on an exact name match, endpoints/extensions.js) and per-extension state keyed by folder name carries
# across. Superseded: `cachelens` and `vocalis` (lower case), the names of the earlier Docker test images.
COPY --from=taproom-source /payload/source/cachelens/ ./public/scripts/extensions/third-party/taproom-cache-lens/
COPY --from=taproom-source /payload/source/vocalis/sillytavern/extension/ ./public/scripts/extensions/third-party/Vocalis/
# MCP client: the extension (built dist/ plus its manifest and stylesheet) under the folder name existing installs use, and the server
# plugin under /opt/taproom/plugins/mcp-client (the committed ESM shim index.js loads the built index.bundle.js).
# Both trees are read-only at run time; the server list lives outside the image (TAPROOM_MCP_CONFIG).
COPY --from=mcp-client-build /opt/mcp-client/dist/ ./public/scripts/extensions/third-party/sillytavern-mcp-client/dist/
COPY --from=mcp-client-build /opt/mcp-client/manifest.json /opt/mcp-client/style.css /opt/mcp-client/LICENSE ./public/scripts/extensions/third-party/sillytavern-mcp-client/
COPY --from=mcp-client-build /opt/mcp-client/plugin/index.js /opt/mcp-client/plugin/package.json /opt/mcp-client/plugin/index.bundle.js /opt/mcp-client/plugin/index.bundle.js.map /opt/mcp-client/LICENSE ./plugins/mcp-client/

COPY --from=taproom-source /payload/LICENSE /usr/share/licenses/vocalis-g1/Vocalis-LICENSE
COPY --from=taproom-source /payload/source/vault/LICENSE /usr/share/licenses/vocalis-g1/vault-LICENSE
COPY --from=taproom-source /payload/source/mnemosyne/LICENSE /usr/share/licenses/vocalis-g1/mnemosyne-LICENSE
# Provenance and the open license question for the embedding model (no weights are shipped; Taproom downloads them at
# the user's installation). October 10, 2026: multi-qa-mpnet-base-cos-v1, unpinned; the all-mpnet Apache LICENSE that
# used to be in this folder is gone because it did not apply to the model now configured.
COPY --from=taproom-source /payload/packaging/models/mnemosyne/ /usr/share/licenses/vocalis-g1/mnemosyne-embedding/
COPY --from=taproom-source /payload/source/cachelens/LICENSE /usr/share/licenses/vocalis-g1/cachelens-LICENSE
COPY --from=taproom-source /payload/source/mcp-client/LICENSE /usr/share/licenses/vocalis-g1/mcp-client-LICENSE
COPY --from=taproom-source /payload/source/mcp-client/DOWNSTREAM-CHANGES.md /usr/share/licenses/vocalis-g1/mcp-client-DOWNSTREAM-CHANGES.md
COPY --from=mcp-client-build /opt/mcp-client-notices/ /usr/share/licenses/vocalis-g1/mcp-client-npm-notices/
COPY --from=taproom-source /payload/source/taproom/LICENSE /usr/share/licenses/vocalis-g1/taproom-LICENSE
# October 11, 2026: the texts that packaging/licenses/NOTICE.md cites for Taproom's copyleft and notice-requiring
# dependencies. ip-matching is LGPL-3.0-only (LGPL-3.0 incorporates GPL-3.0); sqlite-vec is MIT or Apache-2.0; the
# SQLite3 Multiple Ciphers and better-sqlite3-multiple-ciphers notices are in the same folder. The npm packages also
# keep their own license files inside node_modules.
COPY --from=taproom-source /payload/packaging/licenses/LGPL-3.0.txt /usr/share/licenses/vocalis-g1/LGPL-3.0.txt
COPY --from=taproom-source /payload/packaging/licenses/GPL-3.0.txt /usr/share/licenses/vocalis-g1/GPL-3.0.txt
COPY --from=taproom-source /payload/packaging/licenses/sqlite/ /usr/share/licenses/vocalis-g1/sqlite/
COPY --from=taproom-source /artifacts/ /opt/taproom/public/source/

RUN node --input-type=module -e "import fs from 'node:fs'; import webpack from 'webpack'; import getPublicLibConfig from './webpack.config.js'; const config = getPublicLibConfig({ forceDist: true }); const compiler = webpack(config); let stats; let runError; try { stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result))); } catch (error) { runError = error; } await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve())); if (runError) throw runError; if (!stats || stats.hasErrors()) { console.error(stats?.toString('errors-only') ?? 'Webpack returned no compilation result'); throw new Error('Frontend library compilation failed'); } const output = config.output.path + '/' + config.output.filename; if (!fs.statSync(output).isFile()) throw new Error('Webpack frontend output is missing');"

RUN node --input-type=module -e "import crypto from 'node:crypto'; import { argon2id } from './storage-providers/vault/src/crypto/argon2.js'; if (process.versions.node !== '26.11.1') throw new Error('Expected Node 26.11.1'); if (typeof crypto.argon2 !== 'function') throw new Error('Node crypto.argon2 is unavailable'); const key = await argon2id({ password: 'runtime-smoke', salt: Buffer.alloc(16, 1), parallelism: 1, iterations: 1, memoryKiB: 8192, hashLength: 16 }); if (key.length !== 16) throw new Error('Unexpected Argon2 output length');" \
 && cd /opt/taproom/plugins/mnemosyne \
 && node --input-type=module -e "import Database from 'better-sqlite3-multiple-ciphers'; import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const sqliteVec = require('sqlite-vec'); const db = new Database(':memory:'); db.pragma(\"cipher='sqlcipher'\"); sqliteVec.load(db); db.exec('CREATE VIRTUAL TABLE vectors USING vec0(embedding float[2])'); db.close();" \
 && node --input-type=module -e "await import('./src/index.js');" \
 && cd /opt/taproom \
 && node --input-type=module -e "const p = await import('/opt/taproom/plugins/mcp-client/index.js'); if (p.info?.id !== 'mcp-client' || typeof p.init !== 'function' || typeof p.exit !== 'function') throw new Error('MCP client plugin entry is incomplete');" \
 && test -f /opt/taproom/public/scripts/extensions/third-party/Vocalis/manifest.json \
 && test -f /opt/taproom/public/scripts/extensions/third-party/taproom-cache-lens/manifest.json \
 && test -f /opt/taproom/public/scripts/extensions/third-party/sillytavern-mcp-client/dist/index.iife.js

RUN mkdir -p /logs \
 && chown -R "${TAPROOM_UID}:${TAPROOM_GID}" /logs \
 && chmod 0555 /opt/taproom/entrypoint.sh \
 && chmod -R a-w /opt/taproom

ENV NODE_ENV=production
USER ${TAPROOM_UID}:${TAPROOM_GID}
EXPOSE 8000
ENTRYPOINT ["/opt/taproom/entrypoint.sh"]
