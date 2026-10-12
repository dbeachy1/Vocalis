// Release audit 2026-10-11 — the page's Docker-conditional texts, driven by tests/test_docker_texts_ui.py.
//
// Each helper below is sliced out of the real module and run twice, once with the page's DOCKER flag
// (js/sys/modelstate.js, set from /health) true and once false, because the whole point of the
// flag is that the SAME control says a different, true thing in the container:
//   * the KoboldCpp / llama.cpp "not treated as this machine" sentence (names the compose.local.yaml setting),
//   * the ACE-Step LoRA path placeholder and tooltip (the models folder, not "a path on the server"),
//   * the Voices refresh tooltip and the address placeholders (attributes, which CSS cannot switch),
//   * the voice-clean finished dialog (names every ticked step that was skipped, with its reason).
//
// No npm dependencies (the kobold_ui_smoke.mjs convention).
//
// Usage: node docker_texts_smoke.mjs <path-to-index.html>
import vm from 'node:vm';
import { loadWebSources, sliceDef, stripModuleSyntax } from './_websrc.mjs';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node docker_texts_smoke.mjs <index.html>');
  process.exit(2);
}
await loadWebSources(htmlPath);

let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);

/** A sandbox holding one sliced source, with `DOCKER` set the way the page's flag would be. */
function sandbox(src, docker, extra = {}) {
  const ctx = { esc, DOCKER: docker, ...extra };
  vm.createContext(ctx);
  vm.runInContext(stripModuleSyntax(src), ctx);
  return ctx;
}

// ── item 1: the finished voice-clean dialog names every skipped step, with its reason ────────────
const skipSrc = sliceDef('function vCleanSkippedHtml(', 'async function vCleanPoll(');
{
  const c = sandbox(skipSrc, true);
  ok(c.vCleanSkippedHtml([]) === '', 'no skipped step: the dialog gets no extra paragraph');
  ok(c.vCleanSkippedHtml(undefined) === '', 'an older server that sends no list: no paragraph, no throw');
  const html = c.vCleanSkippedHtml([
    {
      step: 'Remove reverb / echo',
      why: 'Lead Vocal needs model files that have not been downloaded yet: a.pth. Run setup again to fetch them',
    },
  ]);
  ok(/Remove reverb \/ echo/.test(html), 'names the step the way the tickbox words it');
  ok(/was not done/.test(html), 'says plainly that it was not done');
  ok(/Run setup again/.test(html), 'carries the reason');
  const two = c.vCleanSkippedHtml([
    { step: 'Remove reverb / echo', why: 'r1' },
    { step: 'Enhance', why: 'the enhancer exited 3' },
  ]);
  ok(/Remove reverb \/ echo[\s\S]*r1[\s\S]*Enhance[\s\S]*the enhancer exited 3/.test(two), 'both skipped steps are named, in order');
  ok(!/<script/i.test(c.vCleanSkippedHtml([{ step: '<script>x</script>', why: '<b>y' }])), 'step and reason are escaped');
}

// ── item 8: "not treated as this machine" sentences ──────────────────────────────────────────────
{
  const src = sliceDef('function kobNotLocalNote(', 'async function kobLoadAll(');
  const d = sandbox(src, true).kobNotLocalNote();
  const p = sandbox(src, false).kobNotLocalNote();
  ok(/VOCALIS_KOBOLD_LOCAL=1/.test(d) && /compose\.local\.yaml/.test(d), 'Docker: names VOCALIS_KOBOLD_LOCAL=1 and compose.local.yaml');
  ok(!/another box/i.test(d) && !/another box/i.test(p), 'neither variant says "another box"');
  ok(/VOCALIS_KOBOLD_LOCAL=1/.test(p) && !/compose\.local\.yaml/.test(p), 'non-Docker: names the setting, not the compose file');
}
{
  const src = sliceDef('function llaNotLocalNote(', 'function paint(');
  const d = sandbox(src, true).llaNotLocalNote();
  const p = sandbox(src, false).llaNotLocalNote();
  ok(/VOCALIS_LLAMA_LOCAL=1/.test(d) && /compose\.local\.yaml/.test(d), 'llama Docker: names VOCALIS_LLAMA_LOCAL=1 and compose.local.yaml');
  ok(/VOCALIS_LLAMA_LOCAL=1/.test(p) && !/compose\.local\.yaml/.test(p), 'llama non-Docker: names the setting only');
}

// ── item 9: the ACE-Step LoRA path text ──────────────────────────────────────────────────────────
{
  const src = sliceDef('function loraPathPlaceholder(', 'function loraCell(');
  const d = sandbox(src, true);
  const p = sandbox(src, false);
  ok(/^\/models\/vocalis\/lora\//.test(d.loraPathPlaceholder()), 'Docker placeholder is a path as the container sees it');
  ok(
    /models folder/.test(d.loraPathTitle()) && /\/models\/vocalis\/lora\//.test(d.loraPathTitle()),
    'Docker tooltip says the adapter must be in the models folder and gives the path form',
  );
  ok(
    !/on the server|ACE-Step box/.test(d.loraPathTitle() + d.loraPathPlaceholder()),
    'Docker text no longer says "a path on the server" / "the ACE-Step box"',
  );
  ok(/ACE-Step box/.test(p.loraPathPlaceholder()) && /path on the server/.test(p.loraPathTitle()), 'non-Docker text is unchanged');
}

// ── items 5 and 8: attribute texts ───────────────────────────────────────────────────────────────
{
  const src = sliceDef('function applyDockerAttributes(', 'async function pollReady(');
  /** @type {Record<string, Record<string, string>>} */
  const make = () => {
    const els = {};
    for (const id of ['kobUrl', 'llaUrl', 'vRefresh'])
      els[id] = {
        a: {},
        setAttribute(k, v) {
          this.a[k] = v;
        },
      };
    return els;
  };
  for (const docker of [true, false]) {
    const els = make();
    const c = sandbox(src, docker, { document: { getElementById: id => els[id] || null } });
    c.applyDockerAttributes();
    const kob = els.kobUrl.a.placeholder,
      lla = els.llaUrl.a.placeholder,
      tip = els.vRefresh.a.title;
    if (docker) {
      ok(
        /^http:\/\/host\.docker\.internal:\d+$/.test(kob) && /^http:\/\/host\.docker\.internal:\d+$/.test(lla),
        'Docker address placeholders name host.docker.internal',
      );
      ok(
        !/voice_samples/.test(tip) && /not picked up/.test(tip) && /Upload/.test(tip),
        'Docker Voices refresh tooltip is true in the encrypted edition',
      );
    } else {
      ok(/127\.0\.0\.1/.test(kob) && /127\.0\.0\.1/.test(lla), 'non-Docker placeholders keep the loopback examples');
      ok(/voice_samples/.test(tip), 'non-Docker Voices refresh tooltip is unchanged');
    }
  }
  const noEls = sandbox(src, true, { document: { getElementById: () => null } });
  let threw = false;
  try {
    noEls.applyDockerAttributes();
  } catch (e) {
    threw = true;
  }
  ok(!threw, 'a page without those elements (a spec fixture) does not throw');
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all docker text checks passed');
