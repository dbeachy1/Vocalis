// `prettier --write`, run to a FIXPOINT. 8.3.4.
//
// Run Prettier to a bounded fixpoint because a JSDoc type cast may gain grouping parentheses on a
// later pass. A later pass can also change the expression to which the cast applies, affecting type
// checking. The loop is bounded so an oscillating formatter cannot run indefinitely; reaching the
// cap reports that formatting did not stabilize.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const GLOBS = [
  'src/webui/js/**/*.js',
  'src/webui/vocalis_stream_player.js',
  'tests/**/*.{mjs,js}',
  'tools/*.mjs',
  'sillytavern/extension/*.js',
  'nomi/chrome_extension/*.js',
];

const MAX_PASSES = 5;

// Resolve Prettier's JavaScript entry point and invoke it with Node directly. This avoids
// platform-specific command shims while keeping shell execution disabled.
const PRETTIER = createRequire(import.meta.url).resolve('prettier/bin/prettier.cjs');
const run = (mode, quiet) =>
  spawnSync(process.execPath, [PRETTIER, mode, ...GLOBS], {
    stdio: quiet ? ['ignore', 'ignore', 'ignore'] : 'inherit',
    shell: false,
  });

let pass = 0;
for (; pass < MAX_PASSES; pass++) {
  run('--write', true);
  if (run('--check', true).status === 0) {
    console.log(`formatted — stable after ${pass + 1} pass${pass ? 'es' : ''}`);
    process.exit(0);
  }
}

console.error(
  `prettier did not reach a fixpoint in ${MAX_PASSES} passes. That is not a formatting problem, ` +
    'it is Prettier oscillating on some construct in this tree — run `npx prettier --check` with ' +
    'the globs in this file to see which, and report it upstream rather than looping harder.',
);
run('--check', false);
process.exit(1);
