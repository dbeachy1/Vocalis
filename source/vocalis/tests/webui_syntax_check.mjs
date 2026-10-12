// Parse whatever arrives on stdin as a CLASSIC <script>, and nothing else. Driven by
// tests/test_webui_syntax.py — see that file for why this check exists at all.
//
// 🔴 WHY THIS IS NOT `node --check`. The CLI parses stdin as CommonJS (or, since Node 22,
// auto-detects between CommonJS and ESM), and neither goal symbol is what a browser applies to
// an inline <script>. CommonJS wraps the source in a function, so a top-level `return` — dead
// on arrival in a real page — parses clean; auto-detection goes further and accepts `import`
// and `export`, which a classic script cannot have at all. `new vm.Script` is the exact
// browser rule: the Script goal symbol, top level, no wrapper. The modules are checked the
// other way round (`--input-type=module`), by the Python side, for the same reason in reverse.
//
// The source is fed on STDIN rather than named as a file because the thing being checked is a
// slice of index.html, not a file: writing it out to a temp file first would buy nothing and
// would put a copy of the product on disk for every run.
//
// Usage: <source on stdin> | node webui_syntax_check.mjs <label>
// Exit 0 = it parses. Exit 1 = it does not, and stderr names the label, the line, the offending
// source line and the parser's own message.
import vm from 'node:vm';

const label = process.argv[2] || 'inline-script';

let src = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) src += chunk;

if (!src.trim()) {
  // ⚠️ NOT a pass. An empty read means the caller sliced nothing — the exact silent-hole shape
  // this whole test file exists to prevent (DESIGN_7_3_FRONTEND_SPLIT.md §3.5) — and an empty
  // string parses perfectly, so reporting "ok" here would be a green check over no product.
  console.error(label + ': nothing arrived on stdin, so nothing was checked');
  process.exit(2);
}

try {
  new vm.Script(src, { filename: label });
} catch (e) {
  // e.stack leads with `<label>:<line>`, the source line and a caret, then the SyntaxError
  // message. That is the whole diagnosis, so it is passed through verbatim; the frames below
  // it are node's own internals and say nothing about the page.
  const stack = String(e.stack || e.message).split('\n');
  const upto = stack.findIndex(l => /^\s+at /.test(l));
  console.error(stack.slice(0, upto < 0 ? stack.length : upto).join('\n'));
  process.exit(1);
}
