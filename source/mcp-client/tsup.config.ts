import { defineConfig } from 'tsup';

export default defineConfig({
  // Downstream change (Vocalis, October 10, 2026; see DOWNSTREAM-CHANGES.md): the bundle is named
  // plugin/index.bundle.js (upstream: plugin/index.js) because plugin/index.js is now the committed ESM shim that
  // defines `require` and re-exports the bundle. The build output (index.bundle.js, its map and typings) is never
  // committed: the image build produces it from this source and the lockfile.
  entry: { 'index.bundle': 'server-plugin/src/index.ts' },
  outDir: 'plugin',
  dts: true,
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  clean: false, // plugin/ contains package.json that must persist
  // Bundle the MCP SDK into the output so we don't need subpath export resolution
  // Only externalize node built-ins and express (provided by SillyTavern)
  noExternal: [
    '@modelcontextprotocol/sdk',
    'zod',
  ],
  external: [
    'express',
    'child_process',
    'node:child_process',
    'fs',
    'node:fs',
    'path',
    'node:path',
    'url',
    'node:url',
    'module',
    'node:module',
  ],
  banner: {
    js: '// SillyTavern MCP Client Plugin - Built from TypeScript source',
  },
});
