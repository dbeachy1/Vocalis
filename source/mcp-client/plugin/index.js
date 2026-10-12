// Downstream addition (Vocalis, October 10, 2026): the plugin entry Taproom loads. NOT part of upstream
// Moeblack/sillytavern-mcp-client (745ff27), whose plugin/index.js is the committed build output; that file is not
// imported here. See DOWNSTREAM-CHANGES.md at the root of this source tree.
//
// The bundle (index.bundle.js, built by `npm run build:server` into this folder) contains CommonJS dependencies that
// call `require`, which an ES module does not define. Define it first, then load the bundle with a dynamic import so
// the definition is in place before any bundled code runs (a static import would be evaluated before this line).
// This is the same shim the standalone SillyTavern install already runs.
import { createRequire } from 'node:module';

globalThis.require ??= createRequire(import.meta.url);

const plugin = await import('./index.bundle.js');

export const info = plugin.info;
export const init = plugin.init;
export const exit = plugin.exit;
