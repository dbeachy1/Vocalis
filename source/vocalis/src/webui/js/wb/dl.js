/** Download an exportable document through the existing route. Fetch before opening a save target so HTTP errors are reported instead of navigating to raw JSON or writing an error body as a backup.
 */
import { wbSay } from './say.js';

/** The filename returned in `Content-Disposition`; blob URLs do not carry a download name.
 * @param {unknown} disposition - the raw `Content-Disposition` header, or absent.
 * @param {string} fallback - used when the header carries no filename at all.
 * @returns {string}
 */
export function wbDlName(disposition, fallback) {
  const s = String(disposition || '');
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(s);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch (e) {
      /* fall through to the ASCII one */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(s);
  if (plain && plain[1].trim()) return plain[1].trim();
  return fallback;
}

/** Offer exported bytes in a native save dialog. Fetch completes before the picker creates a file, so a failed response cannot leave a zero-byte backup. The picker may be unavailable or canceled; callers retain the existing fallback.
 * @param {Blob} blob - the bytes the route already returned.
 * @param {string} name - the filename the SERVER chose, offered as the dialog's suggestion.
 * @param {string} type - the bare media type, parameters stripped.
 * @returns {Promise<'saved'|'cancelled'|'failed'|'unavailable'>}
 */
async function wbSaveAs(blob, name, type) {
  const pick = window.showSaveFilePicker;
  if (!pick) return 'unavailable';
  // From the server's own filename, so `Équestria.json` and a card's `.png` both keep the
  // extension the route decided on rather than one guessed a second time from the media type.
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : type.indexOf('png') >= 0 ? '.png' : '.json';
  let handle;
  try {
    handle = await pick.call(window, {
      // 🔴 A STABLE `id` IS THE "REMEMBER MY BACKUP FOLDER" FEATURE. Chrome keys the last-used
      // directory on it; without one every export reopens at the default download location, which
      // is the thing being fixed here.
      id: 'vocalis-wbedit-export',
      suggestedName: name,
      types: [
        {
          description: ext === '.png' ? 'SillyTavern character card' : 'SillyTavern JSON',
          accept: { [type || 'application/json']: [ext] },
        },
      ],
    });
  } catch (e) {
    // 🔴 CANCEL IS NOT A FAILURE AND MUST NOT FALL THROUGH TO THE ANCHOR — a download fired after
    // he pressed Cancel is the file he just declined, saved anyway, somewhere he did not pick.
    // `useUnknownInCatchVariables` is on, so the name is read defensively rather than cast.
    const why = e && typeof e === 'object' && 'name' in e ? String(/** @type {{name: unknown}} */ (e).name) : '';
    return why === 'AbortError' ? 'cancelled' : 'unavailable';
  }
  try {
    const out = await handle.createWritable();
    await out.write(blob);
    await out.close();
  } catch (e) {
    // The file exists and is empty or half-written by now — the picker already truncated it. Say
    // so; silently retrying through the anchor would leave that carcass on disk under the same
    // name as the good copy.
    return 'failed';
  }
  return 'saved';
}

/**
 * Download one document. `opts.revision` is the one on screen, or null/undefined for the latest —
 * which is what a row means, since a row is not showing a revision at all.
 *
 * `opts.pending` says his unsaved edits are NOT in this file. A draft lives on the server and is
 * not part of any revision, so a backup taken over the top of one is honest about what it holds or
 * it is a backup of the wrong thing — quietly, which is the failure this whole editor is built
 * against.
 *
 * @param {string} kind
 * @param {string} id
 * @param {{revision?: number|null, name?: string, pending?: boolean}} [opts]
 */
export async function wbDownload(kind, id, opts) {
  const o = opts || {};
  const url =
    '/wbedit/documents/' + encodeURIComponent(id) + '/export' + (o.revision == null ? '' : '?revision=' + encodeURIComponent(o.revision));
  wbSay(kind, 'preparing the download…', 'busy');
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    wbSay(kind, 'could not reach the server.', 'bad');
    return;
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    wbSay(
      kind,
      r.status === 423 ? 'The vault is locked — nothing was downloaded.' : j.error || 'the download failed (HTTP ' + r.status + ')',
      'bad',
    );
    return;
  }
  const blob = await r.blob();
  // `.split(';')` — `application/json; charset=utf-8` is a legal header and is NOT a key the
  // picker's `accept` map accepts. The old `indexOf('png')` reading below is unaffected either way.
  const type = String(r.headers.get('Content-Type') || '')
    .split(';')[0]
    .trim();
  const name = wbDlName(r.headers.get('Content-Disposition'), (o.name || 'document') + (type.indexOf('png') >= 0 ? '.png' : '.json'));
  // 🔴 THE UNSAVED-EDITS WARNING RIDES ON EVERY OUTCOME THAT WROTE A FILE, not just the anchor
  // one. It is the sentence that makes the backup honest about what is in it (see `opts.pending`),
  // so a second exit that dropped it would be a backup of the wrong thing, quietly — which is the
  // failure this whole editor is built against.
  const stale = o.pending ? ' — your unsaved edits are NOT in it; press Save first to include them.' : '';
  const where = await wbSaveAs(blob, name, type);
  if (where === 'saved') {
    wbSay(kind, 'saved ' + name + stale, 'ok');
    return;
  }
  if (where === 'cancelled') {
    wbSay(kind, 'nothing was saved.');
    return;
  }
  if (where === 'failed') {
    wbSay(kind, 'could not write ' + name + ' — the file on disk may be empty or incomplete. Nothing in Vocalis changed.', 'bad');
    return;
  }
  // `unavailable` — no picker in this browser, or the gesture expired. The original path, unchanged.
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  // 🔴 IN THE DOCUMENT BEFORE IT IS CLICKED. A detached anchor's click is ignored by Firefox, and
  // this is exactly the kind of thing that works in the browser it was written in and silently
  // does nothing in the other one.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ⚠️ NOT REVOKED IN THIS TURN. The click hands the URL to the download machinery, which resolves
  // it asynchronously; revoking immediately truncates large files in some browsers. The delay is
  // not a race window to tune — it is simply when the page stops holding its copy of the bytes.
  setTimeout(() => URL.revokeObjectURL(href), 60000);
  wbSay(kind, 'downloaded ' + name + stale, 'ok');
}
