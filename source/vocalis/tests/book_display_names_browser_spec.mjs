// Display-name and rename acceptance in a real browser with synthetic books only.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const [baseUrl, chromePath, beforeScreenshotPath, afterScreenshotPath, labelsPath] = process.argv.slice(2);
if (!baseUrl || !chromePath || !beforeScreenshotPath || !afterScreenshotPath || !labelsPath) {
  console.error(
    'usage: node book_display_names_browser_spec.mjs <base-url> <chrome-path> <before-screenshot> <after-screenshot> <labels-path>',
  );
  process.exit(2);
}

const REFS = {
  favorite: 'heart-magic-ref',
  auto: 'second-story-ref',
  imported: 'manual-import',
  live: 'queued-source-ref',
};
let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log(`  ok   ${message}`);
  else {
    console.error(`  FAIL ${message}`);
    failed++;
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let messageId = 0;
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error(`cannot open CDP socket ${url}`)));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++messageId;
      pending.set(id, message => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, ready, send };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(`page threw: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
  }
  return response.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdp, `Promise.resolve(${expression}).then(value => !!value)`)) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

const profile = await mkdtemp(join(tmpdir(), 'vocalis-book-display-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--ignore-certificate-errors',
    '--window-size=1500,1100',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TEMP: profile, TMP: profile } },
);

async function cleanup() {
  try {
    chrome.kill();
  } catch {}
  if (chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise(resolve => {
      chrome.once('exit', resolve);
      setTimeout(resolve, 5000);
    });
  }
  const tempRoot = tmpdir()
    .replace(/[\\/]+$/, '')
    .toLowerCase();
  const ownedPath = profile.replace(/[\\/]+$/, '').toLowerCase();
  if (!ownedPath.startsWith(tempRoot + '\\') || !ownedPath.split(/[\\/]/).at(-1).startsWith('vocalis-book-display-')) {
    throw new Error(`refusing to remove unverified Chrome profile ${profile}`);
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 7) throw new Error(`could not remove owned Chrome profile ${profile}: ${error}`);
      await sleep(250 * (attempt + 1));
    }
  }
}

let exitCode = 1;
try {
  const portFile = join(profile, 'DevToolsActivePort');
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = (await (await import('node:fs/promises')).readFile(portFile, 'utf8')).split('\n')[0].trim();
      if (port) break;
    } catch {}
    await sleep(100);
  }
  if (!port) throw new Error('Chrome never reported a DevTools port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(target => target.type === 'page');
  if (!page) throw new Error('no page target in Chrome');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const pageErrors = [];
  cdp.ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
  });
  await cdp.send('Page.navigate', { url: baseUrl });
  ok(await waitFor(cdp, `document.readyState === 'complete'`), 'the synthetic page loads');
  ok(await waitFor(cdp, `window.__uiReady === true && window.__bootDone === true`), 'the app finishes booting');
  await evaluate(
    cdp,
    `(() => { document.querySelector('[data-tab="book"]').click(); document.querySelector('[data-bktab="library"]').click(); return true; })()`,
  );
  ok(await waitFor(cdp, `document.querySelector('[data-book="${REFS.favorite}"] .t')`), 'the synthetic library loads');

  ok(
    await evaluate(
      cdp,
      `document.querySelector('[data-book="${REFS.favorite}"] .t').textContent.includes('Test Book One (Test Voice 1 Current)')`,
    ),
    'automatic titles use the current voice label',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const text = document.querySelector('[data-book="${REFS.favorite}"] .m').textContent; return text.indexOf('Test Voice 1 Current') >= 0 && text.indexOf('Test_Voice_1.wav') > text.indexOf('Test Voice 1 Current'); })()`,
    ),
    'raw voice filename follows its friendly label',
  );
  ok(
    await evaluate(cdp, `document.querySelector('[data-book="${REFS.imported}"] .m').textContent.includes('imported')`),
    'imported books retain their imported indicator',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const row = document.querySelector('.bookplaceholder[data-book="${REFS.live}"]'); return !!row && row.querySelector('.t').textContent.includes('Queued Synthetic Story (Test Voice 1 Current)'); })()`,
    ),
    'queued jobs show their registered stable reference and label',
  );

  await evaluate(cdp, `document.querySelector('[data-book="${REFS.favorite}"] .t').click()`);
  ok(await waitFor(cdp, `document.querySelector('#outList audio')`), 'selecting a rendered book mounts its chapter player');
  ok(
    await evaluate(
      cdp,
      `(() => { const card = document.querySelector('[data-book="${REFS.favorite}"]'); const links = [...card.querySelectorAll('a[data-full-download]')]; return links.length === 3 && links[0].textContent.includes('Download Opus') && links[1].textContent.includes('Download MP3') && links[2].textContent.includes('Download AAC (Apple)') && card.textContent.includes('0 B') && links[0].getAttribute('href') === '/output/${REFS.favorite}/file/${REFS.favorite}_full.opus?download=1' && card.querySelector('.book-full-download b').textContent === 'Complete audiobooks'; })()`,
    ),
    'the Library row exposes one ordered download row for each completed format',
  );
  ok(
    await evaluate(
      cdp,
      `fetch(document.querySelector('[data-book="${REFS.favorite}"] a[data-full-download]').href).then(r => r.text()).then(t => t === 'complete opus test bytes')`,
    ),
    'the Opus audiobook link returns the saved file bytes',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const a = document.querySelector('[data-book="${REFS.auto}"] a[data-full-download]'); if (!a) return false; const stop = e => e.preventDefault(); a.addEventListener('click', stop, {once:true, capture:true}); a.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); return document.querySelector('#libList .bookcard.active')?.dataset.book === '${REFS.favorite}'; })()`,
    ),
    'downloading from another card does not select or scroll to its chapters',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const a = document.querySelector('[data-book="${REFS.auto}"] a[data-full-download]'); return !!a && a.textContent.includes('Download MP3'); })()`,
    ),
    'an existing complete MP3 is labeled with its actual container',
  );
  await evaluate(cdp, `document.querySelector('[data-book="${REFS.auto}"] .t').click()`);
  ok(
    await waitFor(cdp, `document.querySelector('#outList audio')?.getAttribute('src').includes('${REFS.auto}')`),
    'the MP3-only book can be selected',
  );
  await evaluate(
    cdp,
    `(() => { const f = document.getElementById('outConcatFormat'); f.value = 'aac'; f.dispatchEvent(new Event('change')); return true; })()`,
  );
  ok(
    await evaluate(cdp, `document.getElementById('outConcat').textContent.includes('Create single audiobook (AAC (Apple))')`),
    'AAC is Create when that book has only a different codec',
  );
  await evaluate(cdp, `document.querySelector('[data-book="${REFS.favorite}"] .t').click()`);
  ok(
    await waitFor(cdp, `document.querySelector('#outList audio')?.getAttribute('src').includes('${REFS.favorite}')`),
    'the book with all codecs can be reopened',
  );
  ok(
    await evaluate(cdp, `document.getElementById('outConcat').textContent.includes('Rebuild single audiobook (AAC (Apple))')`),
    'AAC is Rebuild when an AAC export exists beside the other codecs',
  );
  ok(
    await evaluate(cdp, `document.querySelectorAll('#outMeta .full-export a').length === 3`),
    'the selected book details list all completed exports',
  );
  await evaluate(
    cdp,
    `(() => { const card = document.querySelector('[data-book="${REFS.favorite}"]'); const button = card.querySelector('[data-delete-audiobook$=".opus"]'); const original = window.fetch.bind(window); window.__qaSavedFetch = original; window.__qaDeletes = []; window.fetch = (input, init = {}) => { if (init.method === 'DELETE') window.__qaDeletes.push(String(input)); return original(input, init); }; button.click(); return true; })()`,
  );
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`), 'an export delete opens a confirmation dialog');
  ok(
    await evaluate(
      cdp,
      `document.getElementById('mBody').textContent.includes('${REFS.favorite}_full.opus') && document.getElementById('mBody').textContent.includes('Opus') && document.getElementById('mBody').textContent.includes('book, its chapters') && document.getElementById('mBody').textContent.includes('every other completed audiobook')`,
    ),
    'the confirmation names the exact export and says chapters and other formats stay',
  );
  await evaluate(cdp, `document.querySelector('#mActs button').click()`);
  ok(
    await waitFor(
      cdp,
      `!document.getElementById('overlay').classList.contains('on') && window.__qaDeletes.length === 0 && document.querySelector('#libList .bookcard.active')?.dataset.book === '${REFS.favorite}'`,
    ),
    'cancel makes no delete request and keeps the current book selected',
  );
  await evaluate(cdp, `window.fetch = window.__qaSavedFetch;`);
  await evaluate(
    cdp,
    `(() => { const f = document.getElementById('outConcatFormat'); f.value = 'opus'; f.dispatchEvent(new Event('change')); const original = window.fetch.bind(window); window.__qaDeleteRequests = []; window.fetch = (input, init = {}) => { if (init.method === 'DELETE') window.__qaDeleteRequests.push({url:String(input), method:init.method}); return original(input, init); }; document.querySelector('[data-book="${REFS.favorite}"] [data-delete-audiobook$=".opus"]').click(); return true; })()`,
  );
  ok(
    await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`),
    'confirming a second export delete opens its own dialog',
  );
  await evaluate(cdp, `document.querySelectorAll('#mActs button')[1].click()`);
  ok(
    await waitFor(
      cdp,
      `document.querySelectorAll('[data-book="${REFS.favorite}"] [data-delete-audiobook]').length === 2 && document.querySelectorAll('#outMeta .full-export a').length === 2 && !document.getElementById('overlay').classList.contains('on')`,
    ),
    'confirmed deletion refreshes the shelf and details with the two surviving exports',
  );
  ok(
    await evaluate(
      cdp,
      `window.__qaDeleteRequests.length === 1 && window.__qaDeleteRequests[0].method === 'DELETE' && window.__qaDeleteRequests[0].url === '/output/${REFS.favorite}/audiobook/${REFS.favorite}_full.opus' && document.querySelector('#libList .bookcard.active')?.dataset.book === '${REFS.favorite}' && !!document.querySelector('#outList audio') && document.getElementById('outConcat').textContent.includes('Create single audiobook (Opus)')`,
    ),
    'the exact endpoint ran, chapter audio and selection remain, and the deleted selected codec now says Create',
  );
  ok(
    await evaluate(cdp, `fetch('/output/${REFS.favorite}/file/mp3/00_Chapter_1.mp3?download=1').then(r => r.status === 200)`),
    'chapter files remain downloadable after deleting one full export',
  );
  await evaluate(cdp, `window.fetch = window.__qaSavedFetch;`);
  ok(
    await evaluate(
      cdp,
      `(() => { const f = document.getElementById('outConcatFormat'); const b = document.getElementById('outConcatBitrate'); return !!f && !!b && f.getAttribute('aria-label') === 'Single audiobook format' && b.getAttribute('aria-label') === 'Single audiobook bitrate' && Array.from(f.options).map(o => o.value).join(',') === 'opus,mp3,aac' && Array.from(b.options).map(o => o.value).join(',') === '192,160,128,96,64' && b.value === '192'; })()`,
    ),
    'the audiobook format and mono bitrate selectors have the requested options and default',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const controls = document.getElementById('outConcatControls'); const action = document.getElementById('outActions'); const rect = controls.getBoundingClientRect(); const button = document.getElementById('outConcat').getBoundingClientRect(); return getComputedStyle(action).rowGap === '8px' && rect.width <= 360 && Math.abs(rect.right - button.right) < 2; })()`,
    ),
    'the compact paired selectors use 8px row spacing and end at the build button edge',
  );
  await evaluate(cdp, `document.getElementById('libRefresh').click()`);
  ok(
    await waitFor(cdp, `document.querySelector('[data-book="${REFS.favorite}"] a[data-full-download]')`),
    'the complete download remains visible after refreshing the Library',
  );
  const before = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  await mkdir(dirname(beforeScreenshotPath), { recursive: true });
  await writeFile(beforeScreenshotPath, Buffer.from(before.data, 'base64'));
  console.log(`  screenshot ${beforeScreenshotPath}`);

  // Hold only the concat response while selecting another real fixture book. This exercises
  // completion ordering without making a slow audio build part of the browser UX test.
  await evaluate(
    cdp,
    `(() => { const original = window.fetch.bind(window); window.fetch = (input, init) => String(input).endsWith('/output/${REFS.favorite}/concat') ? new Promise(resolve => { window.__qaConcatBody = JSON.parse(init.body); window.__qaFinishConcat = () => resolve(new Response(JSON.stringify({file: '${REFS.favorite}_full.m4a', size: 23, duration_s: 1, book_duration_s: 1, chapters: 1}), {status: 200, headers: {'Content-Type': 'application/json'}})); }) : original(input, init); window.__qaRestoreFetch = () => { window.fetch = original; }; const s = document.getElementById('outConcatFormat'); s.value = 'aac'; s.dispatchEvent(new Event('change')); document.getElementById('outConcatBitrate').value = '96'; document.getElementById('outConcat').click(); return true; })()`,
  );
  ok(await waitFor(cdp, `typeof window.__qaFinishConcat === 'function'`), 'the audiobook build remains in progress while browsing');
  ok(
    await evaluate(
      cdp,
      `window.__qaConcatBody.format === 'aac' && window.__qaConcatBody.bitrate === 96 && document.getElementById('outConcatFormat').disabled && document.getElementById('outConcatBitrate').disabled`,
    ),
    'the selected AAC format and 96 kbps bitrate are sent and both selectors are disabled while building',
  );
  await evaluate(cdp, `document.querySelector('[data-book="${REFS.imported}"] .t').click()`);
  ok(
    await waitFor(cdp, `document.querySelector('#outList audio')?.getAttribute('src').includes('${REFS.imported}')`),
    'another book can be selected during an audiobook build',
  );
  await evaluate(cdp, `window.__qaFinishConcat()`);
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`), 'the completed build shows its success dialog');
  ok(
    await evaluate(
      cdp,
      `document.querySelector('#libList .bookcard.active')?.dataset.book === '${REFS.imported}' && document.querySelector('#outList audio')?.getAttribute('src').includes('${REFS.imported}')`,
    ),
    'build completion preserves the selected book and its chapter actions',
  );
  await evaluate(cdp, `document.querySelector('#mActs button').click(); window.__qaRestoreFetch()`);
  ok(
    await waitFor(
      cdp,
      `!document.getElementById('outConcat').disabled && !document.getElementById('outConcatFormat').disabled && !document.getElementById('outConcatBitrate').disabled && document.getElementById('outConcat').textContent.includes('Create single audiobook (AAC (Apple))')`,
    ),
    'the build button and both selectors restore after browsing another book',
  );
  await evaluate(cdp, `document.querySelector('[data-book="${REFS.favorite}"] .t').click()`);
  ok(
    await waitFor(cdp, `document.querySelector('#outList audio')?.getAttribute('src').includes('${REFS.favorite}')`),
    'the original book can still be reopened',
  );
  ok(
    await evaluate(cdp, `document.getElementById('outConcat').textContent.includes('Rebuild single audiobook (AAC (Apple))')`),
    'switching back restores the rebuild label with the selected format',
  );
  await evaluate(
    cdp,
    `(() => { const original = window.fetch.bind(window); window.fetch = (input, init) => String(input).endsWith('/output/${REFS.favorite}/concat') ? Promise.resolve(new Response(JSON.stringify({error:'encoder failed'}), {status:400, headers:{'Content-Type':'application/json'}})) : original(input, init); document.getElementById('outConcat').click(); return true; })()`,
  );
  ok(await waitFor(cdp, `document.getElementById('overlay').classList.contains('on')`), 'a failed audiobook build shows its error dialog');
  await evaluate(cdp, `document.querySelector('#mActs button').click()`);
  ok(
    await waitFor(
      cdp,
      `!document.getElementById('outConcat').disabled && !document.getElementById('outConcatFormat').disabled && !document.getElementById('outConcatBitrate').disabled`,
    ),
    'the build button and both selectors restore after a failed build',
  );
  await evaluate(cdp, `window.__qaRestoreFetch()`);

  await evaluate(cdp, `document.querySelector('.bookplaceholder[data-book="${REFS.live}"] [data-renamebook]').click()`);
  ok(await waitFor(cdp, `!!document.getElementById('vcNameIn')`), 'the live placeholder opens its rename dialog');
  await evaluate(
    cdp,
    `(() => { const i = document.getElementById('vcNameIn'); i.value = 'Queued Story Title'; document.querySelector('#mActs button:last-child').click(); return true; })()`,
  );
  ok(
    await waitFor(cdp, `document.querySelector('[data-book="${REFS.live}"] .t').textContent.includes('Queued Story Title')`),
    'queued books can be renamed before their first chapter',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const row = document.querySelector('[data-book="${REFS.live}"]'); const detail = row && row.querySelector('.m').textContent; return !!detail && detail.includes('Test Voice 1 Current') && detail.includes('Test_Voice_1.wav') && detail.includes('metadata pending') && !detail.includes('imported'); })()`,
    ),
    'a renamed live book keeps job voice details and shows metadata pending instead of imported',
  );

  await evaluate(
    cdp,
    `(() => { const a = document.querySelector('#outList audio'); a.dataset.qaToken = 'same-audio-element'; window.__qaRenameRequests = []; const original = window.fetch.bind(window); window.fetch = (input, init) => { const url = String(input); if (url.includes('/rename')) window.__qaRenameRequests.push({url, body: init && init.body}); return original(input, init); }; return true; })()`,
  );
  const originalSource = await evaluate(cdp, `document.querySelector('#outList audio').getAttribute('src')`);

  await evaluate(cdp, `document.querySelector('[data-book="${REFS.favorite}"] [data-renamebook]').click()`);
  ok(
    await waitFor(cdp, `document.getElementById('vcNameIn') && document.getElementById('vcNameIn').value.includes('Test Book One')`),
    'the rename dialog starts with the friendly current title',
  );
  await evaluate(cdp, `document.querySelector('#mActs button').click()`);
  ok(await waitFor(cdp, `!document.getElementById('overlay').classList.contains('on')`), 'Cancel closes the dialog');
  ok(
    await evaluate(
      cdp,
      `document.querySelector('[data-book="${REFS.favorite}"] .t').textContent.includes('Test Book One (Test Voice 1 Current)')`,
    ),
    'Cancel leaves the current title alone',
  );

  await evaluate(cdp, `document.getElementById('outRename').click()`);
  ok(await waitFor(cdp, `!!document.getElementById('vcNameIn')`), 'the Chapters action opens Rename for the selected book');
  await evaluate(
    cdp,
    `(() => { const i = document.getElementById('vcNameIn'); i.value = 'My Favorite Story'; document.querySelector('#mActs button:last-child').click(); return true; })()`,
  );
  ok(
    await waitFor(cdp, `document.querySelector('[data-book="${REFS.favorite}"] .t').textContent.includes('My Favorite Story')`),
    'Save keeps the stable book reference and updates the visible title',
  );
  ok(
    await evaluate(cdp, `document.getElementById('outTitle').textContent.includes('My Favorite Story')`),
    'the selected heading updates immediately',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const a = document.querySelector('#outList audio'); return a.dataset.qaToken === 'same-audio-element' && a.getAttribute('src') === ${JSON.stringify(originalSource)}; })()`,
    ),
    'the selected heading updates without replacing its audio node',
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const r = window.__qaRenameRequests.at(-1); return r && r.url.endsWith('/book/${REFS.favorite}/rename') && JSON.parse(r.body).name === 'My Favorite Story'; })()`,
    ),
    'rename requests use the stable book reference',
  );

  await writeFile(labelsPath, JSON.stringify({ 'Test_Voice_1.wav': 'Test Voice 1 Changed' }), 'utf8');
  await evaluate(cdp, `document.getElementById('libRefresh').click()`);
  ok(
    await waitFor(
      cdp,
      `document.querySelector('[data-book="${REFS.auto}"] .t').textContent.includes('Test Book Two (Test Voice 1 Changed)')`,
    ),
    'automatic titles track a changed voice label',
  );
  ok(
    await evaluate(cdp, `document.querySelector('[data-book="${REFS.favorite}"] .t').textContent.includes('My Favorite Story')`),
    'the explicit title survives a voice-label change and reload',
  );
  await evaluate(
    cdp,
    `(() => { const e = document.getElementById('libFilter'); e.value = 'My Favorite Story'; e.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`,
  );
  ok(await waitFor(cdp, `document.querySelectorAll('#libList .bookcard').length === 1`), 'filtering matches the display name');
  await evaluate(
    cdp,
    `(() => { const e = document.getElementById('libFilter'); e.value = ''; e.dispatchEvent(new Event('input', {bubbles:true})); const s = document.getElementById('libSort'); s.value = 'name'; s.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`,
  );
  ok(
    await evaluate(
      cdp,
      `(() => { const titles = [...document.querySelectorAll('#libList .bookcard .t')].map(e => e.textContent.trim()); return JSON.stringify(titles) === JSON.stringify([...titles].sort((a,b) => a.localeCompare(b))); })()`,
    ),
    'title sorting follows display names',
  );

  const after = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  await mkdir(dirname(afterScreenshotPath), { recursive: true });
  await writeFile(afterScreenshotPath, Buffer.from(after.data, 'base64'));
  console.log(`  screenshot ${afterScreenshotPath}`);
  ok(pageErrors.length === 0, `no uncaught page errors (${JSON.stringify(pageErrors.slice(0, 3))})`);
  exitCode = failed === 0 ? 0 : 1;
  cdp.ws.close();
} catch (error) {
  console.error(`  FAIL ${error && error.stack ? error.stack : error}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
