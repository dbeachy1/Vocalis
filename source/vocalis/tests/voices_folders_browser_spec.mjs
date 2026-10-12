// 8.9.13 — the tick column and BOTH folder gestures, on the voice-side lists, in a REAL
// browser: Voices ▸ Uploaded voices and Voice Studio ▸ Speech clips (originally also Voice
// Training ▸ Training clips and Voice Training ▸ Trained voices, which the Docker edition drops).
//
// 🔴 THE CHECK THIS FILE CARRIES IS THE WAY BACK OUT. Filing had two gestures — tick plus
// `⇥ Move selected here` on the folder row, or drag onto it — and un-filing had ONE, dragging
// onto a divider that `folderRows` did not even emit unless something was already unfiled. So the
// state you reach by using folders (everything filed) was the exact state with no way back. That
// is not a claim any source-level test can settle: `folderAddButton` inserts `⇤ Remove from
// folder` only when the panel can answer `selected()`, and a panel that forgets the 4th argument
// gets NO BUTTON, silently, on a page that otherwise looks finished.
//
// 🔴 THE SECOND IS THAT THE TICK AND THE MOVE ARE THE SAME SET. Every one of these lists keeps its
// ticks in a module-level `Set` (a DOM read would be erased by the training panel's repaint), and
// `⇥ Move selected here` reads that set through a callback wired at module scope. Nothing but
// driving the real clicks can tell "the box is ticked" from "the button will move that row" —
// they are two different objects, in two different files, and 8.9 shipped three lists where the
// second one was never wired at all.
//
// 🔴 AND THE THIRD IS THAT A TICK YOU CANNOT SEE MUST NOT TRAVEL. Type a filter, and the rows it
// hides are still in the set; press ⇥ and they are filed too, from a gesture that pointed at what
// was on screen. Both voice lists now prune their ticks to the rendered rows. The CLIP PICKER
// deliberately does not — its ticks ARE the training selection, and dropping one because a filter
// hid the row would delete a clip from a dataset — so it narrows at the gesture instead, and this
// spec asserts BOTH halves of that: only the visible clip is filed, and the hidden one is still
// ticked and still counted for training.
//
// ⚠️ No backticks inside the CDP expressions: they are template literals here, and an unescaped
// one ends the literal (a whole spec became a syntax error that way in 6.2).
//
// Usage: node voices_folders_browser_spec.mjs <base-url> <chrome-path>
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [baseUrl, chromePath] = process.argv.slice(2);
if (!baseUrl || !chromePath) {
  console.error('usage: node voices_folders_browser_spec.mjs <base-url> <chrome-path>');
  process.exit(2);
}

let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── CDP plumbing ─────────────────────────────────────────────────────────────
let msgId = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error(`cannot open CDP socket ${wsUrl}`)));
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, ready, send };
}

async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
  if (r.exceptionDetails) {
    throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const t0 = Date.now();
  let lastThrow = null;
  for (;;) {
    // 🔴 `Promise.resolve(...)`, never `!!(expr)` — on a promise the latter is true synchronously
    // and always, so the wait returns on its first poll and waits for nothing. It fails as a PASS,
    // which is why it survived 25 specs; see feedback_a_wait_that_does_not_wait.
    // 🔴 A POLL THAT THROWS IS "NOT YET", NOT "FAILED". `evaluate` turns a page exception into
    // a thrown Error, so before this guard any wait whose expression dereferenced a node was a
    // race rather than a wait - the FIRST poll landing mid-repaint killed the spec. The wait is
    // FOR the repaint, so polling during it is the normal case and the early polls being false
    // is the entire point. Proved by mutation on 2026-08-20, not reasoned about.
    // ⚠️ THE THROW IS REMEMBERED, NOT SWALLOWED - an expression with a typo in it throws on
    // every poll, and without this it would simply time out saying nothing about why.
    try {
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(v => !!v)`)) return true;
      lastThrow = null;
    } catch (err) {
      lastThrow = err && err.message ? err.message : String(err);
    }
    if (Date.now() - t0 > timeoutMs) {
      if (lastThrow) console.log(`  (wait gave up after ${timeoutMs}ms; last page exception: ${lastThrow})`);
      return false;
    }
    await sleep(100);
  }
}

// ── the fixture's rows, and which one each list hides behind its filter ───────
//
// One token — "zephyr" — is the query for all FOUR, and it matches exactly one row in each:
// the TTS list searches `label + filename`, the clip picker searches the clip's STEM (not its
// ref) and the registry searches `name + training`. A query that matched two rows would make the
// hidden-tick assertion below vacuous, so the names are chosen to share no substring.
//
// 📌 DOCKER EDITION: TWO OF THE ORIGINAL FOUR LISTS ARE GONE, BECAUSE THEIR SCREENS ARE. Voice
// Training ▸ Training clips (the second `train_sources` host) and Voice Training ▸ Trained voices
// (`voices_rvc`) belong to the excluded training and RVC surfaces and have no panel in this image.
// What remains is the two lists the product ships: Uploaded voices and Voice Studio ▸ Speech clips.
// `ticksSurviveAFilter: true` was only ever Training clips' answer (its ticks were the training
// selection), so no entry below sets it now; the branch that reads it is kept for the contract.
const LISTS = [
  {
    scope: 'voices_tts',
    what: 'Voices ▸ Uploaded voices',
    host: 'vList',
    refresh: 'vRefresh',
    filterId: 'vFilter',
    route: '/voices',
    refKey: 'name',
    keep: 'Zephyr.wav',
    hide: 'Marlow.wav',
    // A row's own click behavior here is ▶, which opens the ONE shared player inside the row.
    quiet: `document.querySelectorAll('#vList .vplayer, #vList audio, #vList input[type=text]').length === 0`,
    quietWhat: 'ticking a voice does not open its player, and does not start any audio',
    // Its ticks mean only "the ones I am about to file", so a filter drops the ones it hides.
    ticksSurviveAFilter: false,
    show: `(() => { document.querySelector('[data-tab="voices"]').click(); return true; })()`,
  },
  {
    // 🔴 9.0.6 — THE SECOND PANEL ON `train_sources`, AND THAT IS THE POINT OF ADDING IT HERE.
    // `web/train.py` says it in the code: *"THREE PANELS render this one dataset (Speech tab,
    // Training ▸ sources, and the Voice Swap picker's speech half) … filing a clip in one and
    // finding it unfiled in another would read as data loss."* This panel was the one not
    // honoring that — the server had stamped every row with its folder since 8.9 and the screen
    // discarded the field. Running the SAME contract over the SAME scope from a second host is
    // what makes "the two panels agree" a test rather than a claim.
    // 📌 Safe to share a scope because the loop deletes its folder at the end of every iteration
    // ("leave the scope as we found it"), so this entry starts from an empty one.
    scope: 'train_sources',
    what: 'Voice Studio ▸ Speech clips',
    host: 'spList',
    refresh: 'spRefresh',
    filterId: 'spFilter',
    route: '/train/sources',
    refKey: 'ref',
    keep: 'Zephyr_clip.mp3',
    hide: 'Marlow_clip.mp3',
    // 🔴 THIS ROW'S OWN BEHAVIORS ARE AN INLINE RENAME BOX (✏) AND ▶, AND NEITHER MAY FIRE.
    // The rename one is the dangerous half: a tick that re-rendered the list would destroy a name
    // being typed in a DIFFERENT row — the Playground tick-cell data loss with the pieces
    // rearranged. `#spList` must therefore hold no text input, `#spPlayerWrap` no audio element,
    // and exactly one row may be outlined so the box and the row agree about what is ticked.
    quiet:
      `document.querySelectorAll('#spList input[type=text]').length === 0 && ` +
      `document.querySelectorAll('#spPlayerWrap audio').length === 0 && ` +
      `document.querySelectorAll('#spList .item.active').length === 1`,
    quietWhat: 'ticking a clip opens no rename box, starts no audio, and outlines exactly its own row',
    // These ticks answer ONE question — "what am I filing" — unlike Voice Training's, which are
    // also the training selection. So the set is pruned to what is on screen, like the uploaded
    // voices list, and a filter drops the ticks it hides.
    ticksSurviveAFilter: false,
    show: `(() => { document.querySelector('[data-tab="voicestudio"]').click();
                    document.querySelector('[data-vstab="speech"]').click(); return true; })()`,
  },
];

const QUERY = 'zephyr';

// Page-side helpers. Installed once; they read the DOM the way a user sees it — children of the
// host in document order, which is what makes "inside the open folder" a positional claim rather
// than a guess about markup.
const HELPERS = `(() => {
  const H = id => document.getElementById(id);
  const kids = host => [...H(host).children];
  window.__vf = {
    rows: host => kids(host).filter(n => n.classList.contains('item')).map(n => n.getAttribute('data-vrow')),
    box: (host, ref) => H(host).querySelector('.item[data-vrow=' + JSON.stringify(ref) + '] input[type=checkbox]'),
    // Idempotent: the clip picker never clears its ticks, so "make sure this row is ticked" and
    // "click the box" are not the same instruction — clicking an already-ticked row UNTICKS it.
    // Re-queried after the click because three of these lists repaint from the change handler.
    tick(host, ref) {
      const b = this.box(host, ref);
      if (!b) return 'NO ROW ' + ref;
      if (!b.checked) b.click();
      const after = this.box(host, ref);
      return after ? after.checked : 'ROW GONE ' + ref;
    },
    ticked: host => [...H(host).querySelectorAll('.item[data-vrow] input[type=checkbox]')]
      .filter(b => b.checked).map(b => b.closest('.item').getAttribute('data-vrow')).sort().join(','),
    everyRowHasATick(host) {
      const items = [...H(host).querySelectorAll('.item[data-vrow]')];
      return items.length > 0 && items.every(n => n.querySelector('input[type=checkbox]'));
    },
    // The rows painted between the OPEN folder row and whatever ends it (the next folder, or the
    // divider). null when nothing is open.
    openChildren(host) {
      const k = kids(host);
      const i = k.findIndex(n => n.classList.contains('vfolder') && n.classList.contains('open'));
      if (i < 0) return null;
      const out = [];
      for (let j = i + 1; j < k.length; j++) {
        if (k[j].classList.contains('vfolder') || k[j].classList.contains('vfgap')) break;
        if (k[j].classList.contains('item')) out.push(k[j].getAttribute('data-vrow'));
      }
      return out;
    },
    // Is this row painted BELOW the divider, i.e. back at the root? -1 for either half means no.
    belowTheDivider(host, ref) {
      const k = kids(host);
      const gap = k.findIndex(n => n.classList.contains('vfgap'));
      const row = k.findIndex(n => n.classList.contains('item') && n.getAttribute('data-vrow') === ref);
      return gap >= 0 && row > gap;
    },
    filter(id, q) { const el = H(id); el.value = q; el.dispatchEvent(new Event('input', {bubbles: true})); return true; },
    // 🔴 SCOPED TO ONE TOOLBAR, NOT THE DOCUMENT. folderAddButton keys its button on the SCOPE,
    // and 9.0.6 made two panels share 'train_sources' (Voice Training's picker and the Speech
    // clip library). A document-wide querySelector for that scope then answers whichever is first
    // in the DOM, so both entries below would measure the SAME button and one of them would pass
    // without its panel having a button at all.
    // 📌 nearId is the panel's refresh button, which is exactly where folderAddButton inserts, so
    // the lookup asks the question the code answers instead of a document-wide one.
    // ⚠️ NO BACKTICKS ANYWHERE IN THIS BLOCK: it lives inside the HELPERS template literal, and a
    // backtick in a comment terminates the string. It fails as a JS syntax error two hundred
    // lines away, which is a long walk back to a comment.
    button: (sel, nearId) => { const near = nearId && document.getElementById(nearId);
                     const root = near && near.parentElement ? near.parentElement : document;
                     const b = root.querySelector(sel);
                     // A missing button reports WHAT IT LOOKED IN. "missing: true" alone sends the
                     // reader hunting for a wrong id, a wrong scope or an anchor that did not
                     // exist yet, and the toolbar's own markup separates those three in one line.
                     if (!b) return {missing: true, anchor: !!near,
                                     // How many exist ANYWHERE: 0 = folderAddButton never ran or
                                     // bailed on its anchor; 1+ = it ran but built into a
                                     // different toolbar than the one being searched.
                                     globally: document.querySelectorAll(sel).length,
                                     // The toolbar's children by tag+id+vfadd — far more use than
                                     // innerHTML, which truncates before reaching the interesting end.
                                     kids: root === document ? '(document)' :
                                       [...root.children].map(c => c.tagName + '#' + (c.id || '-') +
                                         (c.dataset && c.dataset.vfadd ? '[vfadd=' + c.dataset.vfadd + ']' : '')).join(' ')};
                     const r = b.getBoundingClientRect();
                     return {w: r.width, h: r.height, text: b.textContent.trim()}; },
  };
  return true; })()`;

// ── launch ───────────────────────────────────────────────────────────────────
const profile = await mkdtemp(join(tmpdir(), 'vocalis-vfolders-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Mute browser audio so a playback regression cannot use host output devices. This spec also
    // asserts that ticking a voice does not start playback.
    '--mute-audio',
    '--ignore-certificate-errors',
    '--window-size=1600,1200',
    'about:blank',
  ],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Chromium resolves ScopedTempDir from process TEMP/TMP, not --user-data-dir.
    // Both variables point into the owned profile so cleanup contains extracted scratch.
    env: { ...process.env, TEMP: profile, TMP: profile },
  },
);

let cleanedUp = false;
const cleanup = async () => {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    chrome.kill();
  } catch {
    /* already gone */
  }
  // 🔴 WAIT FOR CHROME TO GO BEFORE DELETING ITS PROFILE — kill() returns at once, Windows holds
  // the handles a moment longer, and a swallowed EBUSY leaked 4.76 GB per suite run.
  if (chrome.exitCode === null && chrome.signalCode === null)
    await new Promise(r => {
      chrome.once('exit', r);
      setTimeout(r, 4000);
    });
  for (let i = 0; i < 6; i++) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
};
process.on('exit', () => {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
});

async function devtoolsPort() {
  for (let i = 0; i < 100; i++) {
    try {
      const txt = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const port = txt.split('\n')[0].trim();
      if (port) return port;
    } catch {
      /* not written yet */
    }
    await sleep(100);
  }
  throw new Error('Chrome never reported a DevTools port');
}

let exitCode = 1;
try {
  const port = await devtoolsPort();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target in Chrome');

  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    }
  });

  await cdp.send('Page.navigate', { url: baseUrl });
  await waitFor(cdp, `document.readyState === 'complete'`);
  // 🔴 BOTH FLAGS. `__uiReady` is "the modules ran"; `__bootDone` is "the data arrived and the
  // page is wired". A click between the two is dropped in silence.
  // ⚠️ 45s, not the default: this runs inside the full suite beside fifteen other workers, and
  // Chrome's cold start plus the module fetches genuinely exceeds 15s on a loaded box. The
  // CONDITION is unchanged, so nothing is weakened — a spec that is red only when the machine is
  // busy teaches people to re-run.
  await waitFor(cdp, `window.__uiReady === true && window.__bootDone === true`, 45000);
  await evaluate(cdp, HELPERS);

  for (const L of LISTS) {
    console.log(`\n── ${L.what}  (scope ${L.scope}) ──`);
    const S = JSON.stringify(L.scope);
    const H = JSON.stringify(L.host);
    const KEEP = JSON.stringify(L.keep);
    const HIDE = JSON.stringify(L.hide);
    // What the SERVER says is filed in a folder — read from the same route the panel renders
    // from, so this is the stamp the list itself will see and not a second opinion.
    const filedIn = fid =>
      `fetch(${JSON.stringify(L.route)}).then(r => r.json()).then(rows => rows` +
      `.filter(x => x.folder === ${JSON.stringify(fid)}).map(x => x[${JSON.stringify(L.refKey)}]).sort().join(','))`;
    // 🔴 THE COMPARISON GOES INSIDE THE `.then`, AND THE FIRST CUT PUT IT OUTSIDE. `promise ===
    // 'Zephyr.wav'` is a PROMISE compared to a string: false forever, whatever it resolves to, so
    // the wait spun for its full timeout and reported a failure while the very next line read the
    // right value back. Sibling of the `!!(aPromise)` trap `waitFor` already warns about — same
    // cause (a promise used as a value), opposite symptom: that one passes instantly and always,
    // this one fails slowly and always. Both are invisible in the expression.
    const filedIs = (fid, expected) => `${filedIn(fid)}.then(v => v === ${expected})`;

    await evaluate(cdp, L.show);
    const listed = await waitFor(cdp, `window.__vf.rows(${H}).length === 3`, 30000);
    ok(listed, `${L.what}: the list renders the three fixture rows`);
    if (!listed) {
      const got = await evaluate(cdp, `window.__vf.rows(${H})`);
      throw new Error(`${L.what}: the fixture did not reach the page (${JSON.stringify(got)})`);
    }

    // ── 1. both toolbar buttons exist, and the second one is the whole point ────────────────
    // `folderAddButton` builds them (index.html has a hard line ceiling), so "does it exist" is a
    // real question: a wrong anchor id — or a missing 4th argument — makes it no-op in silence.
    const R = JSON.stringify(L.refresh);
    const add = await evaluate(cdp, `window.__vf.button('[data-vfadd=' + ${S} + ']', ${R})`);
    ok(
      !add.missing && add.w > 20 && add.h > 8,
      `${L.what}: ✚ Folder is on the toolbar with a real size ${add.missing ? JSON.stringify(add) : ''}`,
    );
    const out = await evaluate(cdp, `window.__vf.button('[data-vfout=' + ${S} + ']', ${R})`);
    ok(!out.missing, `🔴 ${L.what}: ⇤ Remove from folder exists`);
    ok(!out.missing && out.w > 20 && out.h > 8, `${L.what}: and it is a real control, not a zero-sized one`);
    ok(out.text === '⇤ Remove from folder', `${L.what}: …labeled “⇤ Remove from folder” (${JSON.stringify(out.text)})`);

    // ── 2. a folder, made server-side, then loaded through the panel's own ↻ ────────────────
    const made = await evaluate(
      cdp,
      `fetch('/folders/' + ${S}, {method: 'POST', headers: {'Content-Type': 'application/json'},` +
        ` body: JSON.stringify({name: 'Sample Folder'})}).then(r => r.json())`,
    );
    ok(made && /^f_[0-9a-f]{8}$/.test(made.id || ''), `${L.what}: the folder is created server-side (${made && made.id})`);
    const fid = String(made.id);
    await evaluate(cdp, `(() => { document.getElementById(${JSON.stringify(L.refresh)}).click(); return true; })()`);
    ok(
      await waitFor(cdp, `document.querySelectorAll('#' + ${H} + ' .vfolder').length === 1`),
      `${L.what}: ↻ Refresh brings the folder row into the list`,
    );

    // ── 3. EVERY row carries a tick ─────────────────────────────────────────────────────────
    ok(await evaluate(cdp, `window.__vf.everyRowHasATick(${H})`), `${L.what}: every row carries a tick box`);

    // ── 4. ticking does not fire the row's own behavior ────────────────────────────────────
    ok((await evaluate(cdp, `window.__vf.tick(${H}, ${KEEP})`)) === true, `${L.what}: clicking the box ticks the row`);
    ok(await waitFor(cdp, L.quiet), `${L.what}: ${L.quietWhat}`);
    ok((await evaluate(cdp, `window.__vf.tick(${H}, ${HIDE})`)) === true, `${L.what}: a second row ticks too`);
    ok(
      (await evaluate(cdp, `window.__vf.ticked(${H})`)) === [L.keep, L.hide].sort().join(','),
      `${L.what}: the set holds BOTH rows — ticking one did not replace the other`,
    );

    // ── 5. a filter hides one of the two ticked rows ────────────────────────────────────────
    const filterTo = q => `window.__vf.filter(${JSON.stringify(L.filterId)}, ${JSON.stringify(q)})`;
    await evaluate(cdp, filterTo(QUERY));
    const filtered = await waitFor(cdp, `JSON.stringify(window.__vf.rows(${H})) === JSON.stringify([${KEEP}])`);
    // A `waitFor` that times out reports only "false", which sends the reader looking for a wiring
    // fault when the truth may be that the filter matched two rows or none. Read the DOM back.
    const sawRows = filtered ? '' : JSON.stringify(await evaluate(cdp, `window.__vf.rows(${H})`));
    ok(filtered, `${L.what}: filtering to “${QUERY}” leaves only one row on screen ${sawRows}`);

    // ── 6. what the filter did to the ticks, which is NOT the same answer on all three ──────
    //
    // 🔴 THIS IS CHECKED BEFORE ANY MOVE, DELIBERATELY. `⇥ Move selected here` clears the tick set
    // on the two voice lists, so asserting the prune after a move would pass on a build that never
    // pruned anything — the move would have emptied the set either way. The claim is about the
    // FILTER, so nothing else may have touched the set when it is read.
    await evaluate(cdp, filterTo(''));
    ok(await waitFor(cdp, `window.__vf.rows(${H}).length >= 2`), `${L.what}: clearing the filter brings the other rows back`);
    const stillTicked = await evaluate(cdp, `window.__vf.ticked(${H})`);
    ok(stillTicked.split(',').includes(L.keep), `${L.what}: the row the filter KEPT on screen is still ticked`);
    if (L.ticksSurviveAFilter) {
      ok(
        stillTicked.split(',').includes(L.hide),
        `🔴 ${L.what}: the hidden clip is STILL ticked — these ticks are the TRAINING selection, ` +
          `and a filter must never delete a clip from the dataset (${JSON.stringify(stillTicked)})`,
      );
      ok(
        await evaluate(cdp, `document.getElementById('vtTotal').textContent.indexOf('2 clips selected') >= 0`),
        `${L.what}: and the panel total still counts BOTH, which is what you check before pressing Start`,
      );
    } else {
      ok(
        !stillTicked.split(',').includes(L.hide),
        `🔴 ${L.what}: the tick the filter hid was DROPPED — a tick you cannot see must not ` +
          `silently widen the next move (${JSON.stringify(stillTicked)})`,
      );
    }

    // ── 7. ⇥ Move selected here files the VISIBLE tick, and only it ─────────────────────────
    await evaluate(cdp, filterTo(QUERY));
    ok(
      await waitFor(cdp, `JSON.stringify(window.__vf.rows(${H})) === JSON.stringify([${KEEP}])`),
      `${L.what}: filtering again leaves the same single row`,
    );
    await evaluate(cdp, `(() => { document.querySelector('#' + ${H} + ' .vfolder [data-fact="move"]').click(); return true; })()`);
    ok(await waitFor(cdp, filedIs(fid, KEEP)), `🔴 ${L.what}: ⇥ Move selected here reaches the SERVER — the ticked row is filed`);
    const filed = await evaluate(cdp, filedIn(fid));
    ok(
      filed === L.keep,
      `🔴 ${L.what}: and ONLY it — a tick the filter is hiding does not travel with the gesture (${JSON.stringify(filed)})`,
    );
    await evaluate(cdp, filterTo(''));
    ok(await waitFor(cdp, `window.__vf.rows(${H}).length >= 2`), `${L.what}: the filter clears again`);
    // 🔴 THE SCREEN, NOT ONLY THE STORE. The count on the folder row is drawn from the rows'
    // `.folder` stamps, which come down WITH the rows — so a panel that re-rendered instead of
    // refetching would print the old number here while the server held the new one.
    ok(
      await waitFor(cdp, `document.querySelector('#' + ${H} + ' .vfolder .vfn').textContent.trim() === '(1)'`),
      `${L.what}: the folder row itself counts the filing — it reads (1)`,
    );

    // ── 8. open the folder: the row inside it has a tick too ────────────────────────────────
    await evaluate(cdp, `(() => { document.querySelector('#' + ${H} + ' .vfolder [data-fact="open"]').click(); return true; })()`);
    ok(
      await waitFor(cdp, `JSON.stringify(window.__vf.openChildren(${H})) === JSON.stringify([${KEEP}])`),
      `${L.what}: the folder opens and the filed row is painted inside it`,
    );
    ok(
      await evaluate(cdp, `window.__vf.everyRowHasATick(${H})`),
      `🔴 ${L.what}: the row INSIDE the open folder carries a tick — otherwise nothing in a folder can be picked`,
    );

    // ── 9. 🔴 AND BACK OUT AGAIN, which is the whole reason this file exists ────────────────
    ok((await evaluate(cdp, `window.__vf.tick(${H}, ${KEEP})`)) === true, `${L.what}: the row inside the folder ticks`);
    // 🔴 SCOPED TO THIS PANEL'S TOOLBAR, LIKE THE MEASUREMENT ABOVE. A document-wide
    // `querySelector('[data-vfout=train_sources]')` clicks whichever button is first in the DOM,
    // and 9.0.6 made two panels share that scope — so this pressed Voice Training's ⇤ while
    // asserting about the Speech list, and the failures landed three assertions later on a screen
    // that had never been asked to change. The button is inserted beside the panel's refresh, so
    // that is the container to search.
    await evaluate(
      cdp,
      `(() => { const t = document.getElementById(${R}).parentElement;
                t.querySelector('[data-vfout=' + ${S} + ']').click(); return true; })()`,
    );
    ok(
      await waitFor(cdp, filedIs(fid, `''`)),
      `🔴 ${L.what}: ⇤ Remove from folder takes it back OUT — the server no longer files it anywhere`,
    );
    ok(
      await waitFor(cdp, `window.__vf.belowTheDivider(${H}, ${KEEP})`),
      `🔴 ${L.what}: and the row is painted back at the ROOT, below the divider`,
    );
    // 🔴 THE ASSERTION THAT CATCHES A RELOAD THAT ONLY RE-RENDERS. Un-filing changes the server's
    // assignment, but every row's `.folder` stamp arrived WITH the row — so a panel that repaints
    // from what it already holds puts the rows straight back into the folder they were just taken
    // out of, and the count keeps reading (1). The store is right and the screen is wrong, which
    // self-corrects on the next unrelated refresh and reaches you as a bug report about something
    // else. Measured exactly this way in `vs_folders_browser_spec.mjs`.
    ok(
      await waitFor(cdp, `document.querySelector('#' + ${H} + ' .vfolder .vfn').textContent.trim() === '(0)'`),
      `🔴 ${L.what}: and the folder's OWN COUNT goes back to (0) — the screen agrees with the store`,
    );
    ok(
      (await evaluate(cdp, `JSON.stringify(window.__vf.openChildren(${H}))`)) !== JSON.stringify([L.keep]),
      `${L.what}: …and is no longer inside the folder it came from`,
    );

    // Leave the scope as we found it, so a later list cannot inherit an open folder.
    await evaluate(cdp, `fetch('/folders/' + ${S} + '/' + ${JSON.stringify(fid)}, {method: 'DELETE'}).then(r => r.json())`);
  }

  // ── 9.7.2: 🗑 Delete selected — the second verb the tick set never had ─────────────────────
  //
  // 🔴 LAST IN THE FILE ON PURPOSE: it DELETES two of the three fixtures. Anywhere earlier and
  // every later check would be running against a library it did not plant.
  //
  // 🔴 AND IT IS THE JOIN THAT NEEDS A BROWSER, not the route. `DELETE /voices/<name>` has been
  // there since 4.x and is covered; the tick set has been there since 8.9 and is covered by the
  // twenty checks above. What nothing could see is that NOTHING WAS EVER WIRED BETWEEN THEM — the
  // selection had exactly one verb, `⇥ Move selected here`. A unit test cannot fail on a button
  // that does not exist, which is precisely why this bug survived: every part of it was fine.
  {
    await evaluate(cdp, LISTS[0].show);
    await evaluate(cdp, `document.getElementById('vRefresh').click()`);
    await waitFor(cdp, `document.querySelectorAll('#vList .item').length >= 3`);

    const tick = n =>
      `(() => { const c = [...document.querySelectorAll('#vList .item')]
            .find(r => r.dataset.vrow === ${JSON.stringify(n)})?.querySelector('.vchk');
          if (!c) return false; c.checked = true;
          c.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`;
    ok(await evaluate(cdp, tick('Marlow.wav')), 'Voices ▸ Uploaded voices: a row can be ticked for deletion');
    await evaluate(cdp, tick('Petrichor.wav'));

    // 🔴 THE BUTTON READS THE SELECTION. Disabled-with-a-count is what stops the confirm being a
    // surprise, and it is the half `vSyncBulk` exists for — a handler that deleted the right rows
    // while the button still said "Delete selected" would pass every other check here.
    ok(
      await waitFor(cdp, `document.getElementById('vDelSel').disabled === false`),
      'Voices ▸ Uploaded voices: 🗑 Delete selected arms once rows are ticked',
    );
    ok(
      await waitFor(cdp, `/\\(2\\)/.test(document.getElementById('vDelSel').textContent || '')`),
      'Voices ▸ Uploaded voices: …and it says how many it is about to delete',
    );

    await evaluate(cdp, `document.getElementById('vDelSel').click()`);
    ok(
      await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`),
      'Voices ▸ Uploaded voices: pressing it asks before deleting anything',
    );
    // Confirm with the button that names the item count.
    await evaluate(
      cdp,
      `(() => { [...document.querySelectorAll('#mActs button')]
            .find(b => /Delete 2/.test(b.textContent)).click(); return true; })()`,
    );

    // 🔴 ASSERTED AT THE SERVER, NOT ON SCREEN. A row can leave the list because the delete worked
    // or because the list re-rendered from a stale store; only /voices can tell those apart, and
    // the difference is "your voices are gone" versus "your voices look gone".
    const gone = `fetch('/voices').then(r => r.json()).then(v => {
        const n = v.map(x => x.name);
        return !n.includes('Marlow.wav') && !n.includes('Petrichor.wav') && n.includes('Zephyr.wav'); })`;
    ok(await waitFor(cdp, gone), '🔴 Voices ▸ Uploaded voices: both ticked voices are deleted ON THE SERVER, and the unticked one is not');
    ok(
      await waitFor(cdp, `document.querySelectorAll('#vList .item').length === 1`),
      'Voices ▸ Uploaded voices: and the list repaints without them',
    );
    // ⚠️ THE SELECTION IS SPENT. A button still armed over names that no longer exist would 404 on
    // the next press and read as a broken delete.
    ok(
      await waitFor(cdp, `document.getElementById('vDelSel').disabled === true`),
      'Voices ▸ Uploaded voices: and the button disarms, because the selection is gone',
    );
  }

  ok(pageErrors.length === 0, `no uncaught page errors (${JSON.stringify(pageErrors.slice(0, 3))})`);
  exitCode = failed === 0 ? 0 : 1;
  console.log(failed ? `\n${failed} FAILED` : '\nall browser assertions passed');
} catch (err) {
  console.error(`  FAIL ${err && err.stack ? err.stack : err}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
