// How the editor renders a revision's timestamp. 7.1-m9.
//
// 📌 A FILE OF ITS OWN BECAUSE TWO MODULES NEED IT AND NEITHER OWNS IT. `wbLoadPromptRevs`
// (prompt.js) and the document revision picker (open.js) both render `revision N [when]`, and the
// two pickers matching is deliberate — m4n built the second to look like the first. Putting this
// in whichever of them moved first would have made that module a dependency of the other for one
// pure formatter, which is the mistake `wbConfirm` was rescued from in m8.
//
// ⚠️ Not `fmtDate` from the inline script: this one is bracketed, has no comma after the year and
// returns '' rather than a placeholder for a missing stamp, because it is appended INSIDE an
// <option> label. They are different formats on purpose; do not merge them.

/**
 * @param {unknown} sec - epoch seconds, honestly: the `typeof` guard below is load-bearing, since
 *   callers pass an optional field straight through (`wbWhen(r.created_at)`) without a null check.
 * @returns {string}
 */
export function wbWhen(sec) {
  if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return '';
  const d = new Date(sec * 1000);
  const day = String(d.getDate());
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  let h = d.getHours();
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12; // 0 and 12 both read as 12
  const m = String(d.getMinutes()).padStart(2, '0');
  return ` [${day}-${mon}-${d.getFullYear()} ${h}:${m} ${ampm}]`;
}
