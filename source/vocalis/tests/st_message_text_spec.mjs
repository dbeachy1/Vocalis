// What text the extension hands the server for a message, and which messages it never sends.
//
// Two facts, both run from the extension's own source rather than restated here:
//
//   1. LINE BREAKS SURVIVE. The server ends a stand-alone heading ("0900 the next morning") as its
//      own sentence and takes a scene-break line ("***", "---") out; it cannot tell which line is
//      which from a message flattened to one line. `cleanText` used to flatten it.
//   2. A MESSAGE WITH NO LETTER AND NO DIGIT IS NOT SENT. The server refuses such text ("no
//      speakable text"), and that refusal looked like a lost connection to "Preload from here on",
//      which retried five times and then stopped for good at a reply that was only "...".
//      `bodyFor` now answers the question itself, with the server's rule.
//
// Usage: node st_message_text_spec.mjs <extension-dir>
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const extDir = process.argv[2];
if (!extDir) {
  console.error('usage: node st_message_text_spec.mjs <ext-dir>');
  process.exit(2);
}

let failed = 0;
const ok = (cond, what) => {
  if (cond) console.log(`  ok   ${what}`);
  else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

const src = (await readFile(join(extDir, 'index.js'), 'utf-8')).replace(/\r\n/g, '\n');

/** A top-level function out of the file, by name. A rename is a loud failure, not a skipped test. */
function cut(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} is not in index.js any more`);
  const end = src.indexOf('\n}\n', at);
  if (end < 0) throw new Error(`the end of ${name} was not found`);
  return src.slice(at, end + 3);
}

const ctx = () => ({ substituteParams: s => s });
const cleanText = new Function('ctx', `${cut('cleanText')}; return cleanText;`)(ctx);
// The rule `bodyFor` applies before it will send anything, taken from its own source.
const rule = /if \(!text \|\| !(\/.+?\/u)\.test\(text\)\) return null;/.exec(cut('bodyFor'));
if (!rule) throw new Error('bodyFor no longer refuses text with no letter or digit');
const sent = new Function('text', `return !!text && ${rule[1]}.test(text);`);
const speaks = raw => sent(cleanText(raw));

const scene = cleanText('He left.\r\n\r\n***\n\n  0900 the next\tmorning  \n\n\n\nShe woke.');
ok(
  scene === 'He left.\n\n***\n\n0900 the next morning\n\nShe woke.',
  `the paragraphs of a message arrive as paragraphs (${JSON.stringify(scene)})`,
);
ok(cleanText('one\ntwo') === 'one\ntwo', 'a single line break is kept as one');
ok(cleanText('a  \t b') === 'a b', 'runs of spaces and tabs inside a line still become one space');
ok(cleanText('x\n\n\n\n\ny') === 'x\n\ny', 'and any number of blank lines becomes one');

ok(!speaks('...'), 'a reply that is only "..." is not sent');
ok(!speaks('?!'), 'nor one that is only punctuation');
ok(!speaks('---') && !speaks('***') && !speaks('* * *'), 'nor one that is only a scene-break rule');
ok(!speaks('\u{1F600}'), 'nor one that is only an emoji');
ok(!speaks('   \n  '), 'nor one that is only white space');
ok(speaks('Hi.'), 'a word is sent');
ok(speaks('42'), 'a number by itself is sent');
ok(speaks('да') && speaks('はい'), 'and so is a word in any script');

console.log(failed ? `\n${failed} check(s) failed` : '\nall message-text checks passed');
process.exit(failed ? 1 : 0);
