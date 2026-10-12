// Vocalis 7.0-m2 — the extension's pairing call, against the REAL /pair/* gate.
//
// 🔴 WHY THIS IS A NODE SMOKE AND NOT A PYTHON ROUTE TEST. `tests/test_pair_surface.py` already
// proves the SERVER refuses an unauthenticated caller. What it cannot see is whether the
// EXTENSION sends a header the server accepts — the two halves of a credential are agreed on by
// nobody, and "both sides look right" is exactly the state in which a bearer never arrives. This
// runs the real, unmodified vocalis-stream.js against the real blueprint over a real socket.
//
// Usage: node st_pairing_smoke.mjs <serverBase> <path-to-vocalis-stream.js> <goodToken>
const [base, streamPath, goodToken, lockedBase] = process.argv.slice(2);
if (!base || !streamPath || !goodToken || !lockedBase) {
  console.error('usage: node st_pairing_smoke.mjs <serverBase> <vocalis-stream.js> <token> <lockedBase>');
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

const { pairPing } = await import(new URL(`file://${streamPath.replace(/\\/g, '/')}`).href);

// 1. The happy path — the token the server minted is the token the extension sends.
{
  const r = await pairPing(base, goodToken);
  ok(r.ok === true && r.paired === true, `the real token is accepted (${JSON.stringify(r)})`);
}

// 2. A wrong token is a clean "not paired", not an error. The extension has to be able to tell
//    "you typed it wrong" apart from "the server is down", because the two have different fixes.
{
  const r = await pairPing(base, 'not-the-token');
  ok(r.ok === true && r.paired === false, `a wrong token reports unpaired rather than unreachable (${JSON.stringify(r)})`);
}

// 3. 🔴 THE EMPTY TOKEN. This is what an install that has never been paired sends, and the whole
//    fail-closed property of the gate rests on it being refused rather than waved through.
{
  const r = await pairPing(base, '');
  ok(r.ok === true && r.paired === false, `an empty token is refused, not treated as "no check required" (${JSON.stringify(r)})`);
}

// 4. 🔴 THE TOKEN IS ACTUALLY SENT AS A BEARER. Everything above would also pass if pairPing
//    posted the token in a query string and the server happened to 401 the lot — so assert the
//    header itself, read back from the server's own echo route.
{
  const seen = await (await fetch(`${base}/__seen_auth`)).json();
  ok(
    (seen.headers || []).includes(`Bearer ${goodToken}`),
    `the server saw an Authorization: Bearer header carrying the token ` + `(${JSON.stringify(seen.headers)})`,
  );
}

// 5. 🔴 A LOCKED VAULT IS NOT A BAD TOKEN, EVEN THOUGH BOTH ARE 401.
//    `_require_unlocked` is an app-level before_request, so it runs before this family's bearer
//    gate and 401s every /pair/* call while the vault is shut - with a correct token in hand.
//    Reporting "not paired" would prompt users to rotate a valid token, revoking a working
//    pairing. The locked-vault state must remain distinct from token rejection.
{
  const r = await pairPing(lockedBase, goodToken);
  ok(
    r.ok === false && r.locked === true && r.paired !== false,
    `a locked vault reports locked, never unpaired, even with the RIGHT token (${JSON.stringify(r)})`,
  );
}

// 6. Unreachable is an error, not "unpaired". A dead server does not establish that the token
//    is invalid.
{
  const r = await pairPing('http://127.0.0.1:1', goodToken, 1500);
  ok(
    r.ok === false && !r.paired && typeof r.error === 'string',
    `an unreachable server is an error, never a pairing verdict (${JSON.stringify(r)})`,
  );
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
// ⚠️ `process.exitCode` AND NOT `process.exit()`. Check 5 aborts a fetch to a dead port, and
// tearing the process down while libuv is still closing that handle trips an assertion inside
// node on Windows — the run then "fails" with a 3221226505 crash and no failing check, which
// reads as a broken feature rather than a broken exit. Letting the loop drain costs milliseconds.
process.exitCode = failed ? 1 : 0;
