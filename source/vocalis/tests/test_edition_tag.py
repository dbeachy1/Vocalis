"""The header's "Encrypted Edition" tag identifies the install mode.

An install's encryption mode is chosen at install time. The header presents it as an edition
identity, not a temporary setting.

Two surfaces render the tag and they get there differently, which is the whole reason this file
exists rather than one assertion:

  * the main UI unhides its own copy from `pollReady()` when /health reports `initialized`;
  * the LOGIN page has no /health call, so `login_page()` renders it server-side.

The direction that matters in both is the SAFE one: **absent unless a vault is known to exist.**
Claiming encryption an install does not have is the bad failure — it invites someone to trust a
plaintext box — and it is exactly what a default-visible tag would do on the first paint, before
/health lands, or forever if /health never lands at all."""
import re

import pytest
import yaml
from werkzeug.security import generate_password_hash

from conftest import REPO_ROOT, page_html  # noqa: F401  (sys.path side effect)

import vault
import vault_store
import vocalis_server as vs
from vocalis.runtime import auth as rt_auth   # vault store + admin creds (5.1-P4.15)

PW = "correct horse battery staple"
TAG = "Encrypted Edition"

# argon2 at the production 256 MiB costs ~0.11 s per unlock; nothing here needs the real cost.
TEST_KDF = {"algo": "argon2id", "memory_kib": 8 * 1024, "time_cost": 1, "parallelism": 1}

INDEX = REPO_ROOT / "src" / "webui" / "index.html"
JS_ROOT = REPO_ROOT / "src" / "webui" / "js"


def _front_end_source() -> str:
    """The page AND every module under `js/`, joined — the haystack for "this logic exists".

    🔴 7.3 MOVES THE LOGIC THESE TESTS PIN, AND A PAGE-ONLY READ REPORTS THAT AS ITS DELETION.
    `pollReady` lives in `js/sys/model.js` since 7.3-m3, so both assertions below looked for their
    strings in a file that no longer contains them — a red test describing a break that did not
    happen. `test_wbedit_modeglyphs.py` hit this first in 7.1 and wrote down the rule: **widen the
    haystack, never relax the pattern.** Relaxing is what turns a guard into decoration.

    ⚠️ Use this ONLY for "the front end does X somewhere". A check that genuinely means "this is
    in the page" must keep reading INDEX, or it stops testing what it says.
    """
    # page_html(), not INDEX: the tag's own rules are in src/webui/css/ since 7.3.19, and a
    # haystack missing them would let "dressed up as a control" through unnoticed.
    srcs = [page_html()]
    srcs += [p.read_text(encoding="utf-8") for p in sorted(JS_ROOT.rglob("*.js"))]
    return "\n".join(srcs)
LOGIN = REPO_ROOT / "src" / "webui" / "login.html"


def _auth_on(tmp_path, monkeypatch):
    """Auth enabled against a throwaway creds file, globals restored afterward.

    ORDER IS LOAD-BEARING here for the same reason test_auth.py's `creds` fixture spells out:
    auth lives in module globals, so a test that leaves them set 401s every later test."""
    f = tmp_path / "admin_credentials.yaml"
    f.write_text(yaml.safe_dump({"username": "admin",
                                 "password_hash": generate_password_hash(PW)}), encoding="utf-8")
    monkeypatch.setattr(rt_auth, "ADMIN_CREDS_FILE", f)
    monkeypatch.setattr(rt_auth, "ADMIN_USER", "admin")
    monkeypatch.setattr(rt_auth, "_ADMIN_HASH", generate_password_hash(PW))
    monkeypatch.setattr(rt_auth, "_CREDS_BROKEN", False)
    vs.app.secret_key = "test-key-not-derived-from-anything"


def _store(tmp_path, monkeypatch, *, initialized):
    """A store that either has a vault or does not, patched into BOTH names.

    `rt_auth.STORE` and `vault_store.STORE` are two names for one object in production; patching only
    one drives them apart and is how a test can look encrypted while the seams route to None."""
    monkeypatch.setattr(vault, "DEFAULT_KDF", TEST_KDF)
    store = vault_store.VaultStore([("install", tmp_path / "store")], tmp_path / "vault_keys.yaml")
    if initialized:
        store.create(PW)
        store.lock()                       # a restart: initialized but not unlocked
    monkeypatch.setattr(rt_auth, "STORE", store)
    monkeypatch.setattr(vault_store, "STORE", store)
    return store


@pytest.fixture
def client():
    with vs.app.test_client() as c:
        yield c


# ── the login page: server-rendered, because there is no /health call on it ──────────────

def test_login_page_tags_an_encrypted_install(tmp_path, monkeypatch, client):
    _auth_on(tmp_path, monkeypatch)
    _store(tmp_path, monkeypatch, initialized=True)

    html = client.get("/login", headers={"Sec-Fetch-Mode": "navigate"}).get_data(as_text=True)

    assert TAG in html
    assert 'class="edition"' in html


def test_login_page_says_NOTHING_on_an_unencrypted_install(tmp_path, monkeypatch, client):
    """The assertion that actually protects someone: no vault, no claim of one.

    An unencrypted install is a first-class supported mode (DESIGN_5_0_OPTIONAL_ENCRYPTION §1),
    not a degraded one — so the tag is simply absent, with no counterpart badge announcing that
    your data is in the clear."""
    _auth_on(tmp_path, monkeypatch)
    _store(tmp_path, monkeypatch, initialized=False)

    html = client.get("/login", headers={"Sec-Fetch-Mode": "navigate"}).get_data(as_text=True)

    assert TAG not in html
    # `.edition` the CSS rule is always in the page; `class="edition"` the ELEMENT is what must
    # not be, so assert on the element. (The looser check passes for the wrong reason.)
    assert 'class="edition"' not in html


@pytest.mark.parametrize("initialized", [True, False])
def test_login_page_never_leaks_the_placeholder(tmp_path, monkeypatch, client, initialized):
    """`{{EDITION}}` must be substituted on BOTH paths. The unencrypted branch substitutes the
    empty string, which is easy to write as "skip the replace" and ship a literal `{{EDITION}}`
    onto the page — visible, and only on the install nobody tests on."""
    _auth_on(tmp_path, monkeypatch)
    _store(tmp_path, monkeypatch, initialized=initialized)

    html = client.get("/login", headers={"Sec-Fetch-Mode": "navigate"}).get_data(as_text=True)

    assert "{{EDITION}}" not in html
    assert "{{VERSION}}" not in html
    assert "{{RECOVERY}}" not in html


# ── "Forgot your password?" — the only UI that can spend a recovery key ──────────────────

def test_login_page_offers_recovery_on_an_encrypted_install(tmp_path, monkeypatch, client):
    """`/vault/recover` shipped in 5.0 and NOTHING reached it until 6.4-m2: the recovery key was
    the only way back into the data and using it meant hand-crafting a POST."""
    _auth_on(tmp_path, monkeypatch)
    _store(tmp_path, monkeypatch, initialized=True)

    html = client.get("/login", headers={"Sec-Fetch-Mode": "navigate"}).get_data(as_text=True)

    # The ANCHOR, not the phrase: the phrase also occurs in the always-shipped hint JS, so a bare
    # substring check is non-discriminating here (and, in the negative test below, plain wrong).
    assert '<a href="#" id="forgotLink">Forgot your password?</a>' in html


def test_login_page_offers_NO_recovery_without_a_vault(tmp_path, monkeypatch, client):
    """No vault, no `wrap_recovery`, no way back in through a key that was never minted — the
    route would 409. On that box `set-admin-credentials.sh` really is the answer, so offering
    this link would send someone down a path that cannot work."""
    _auth_on(tmp_path, monkeypatch)
    _store(tmp_path, monkeypatch, initialized=False)

    html = client.get("/login", headers={"Sec-Fetch-Mode": "navigate"}).get_data(as_text=True)

    # The ELEMENT is what must be absent. The PHRASE is not: it also appears in the hint string
    # inside the page's JS, which ships unconditionally and is inert without the link. Asserting
    # on the phrase fails for a reason that has nothing to do with the behavior under test —
    # the same "passes/fails for the wrong reason" trap `.edition` records above.
    assert 'id="forgotLink"' not in html


def test_login_ships_the_recovery_panel_INERT():
    """The panel is unconditional markup gated by a server-rendered link, so the hidden default
    is what keeps an unencrypted install from showing a recovery form it cannot honor."""
    html = LOGIN.read_text(encoding="utf-8")

    assert '<div id="recPanel" style="display:none">' in html
    assert 'id="backToLogin" style="display:none"' in html


def test_login_recovery_posts_to_the_auth_open_route():
    """It must hit /vault/recover — the ONE route that takes a recovery key without a LOGIN
    session. A well-meaning move to a login-guarded route would make recovery impossible in the
    emergency it exists for.

    DOCKER EDITION (70ffe7a): in encrypted mode `/vault/recover` is deliberately CSRF-checked, as
    `test_csrf_surface` now pins. That needs no login: the login page itself mints the session
    token and ships it in its `csrf-token` meta tag, so the page must read that tag and send it."""
    html = LOGIN.read_text(encoding="utf-8")

    assert "fetch('/vault/recover'" in html
    assert "recovery_key:key" in html and "new_password:np" in html
    # The CSRF token comes from the login page's own meta tag (no login session is needed to have
    # one), and rides in the header the server's csrf_ok() reads.
    block = html.split("async function doRecover()", 1)[1].split("$('loginForm')", 1)[0]
    assert "meta[name=\"csrf-token\"]" in block and "X-CSRF-Token" in block


# ── the main UI: static contract, since the toggle itself is browser-side ────────────────

def test_index_ships_the_tag_HIDDEN():
    """Hidden in the markup, unhidden only by /health. If someone deletes the `hidden` attribute
    to "make it show", every unencrypted install claims encryption until the first poll returns —
    and forever if the server is down. index.html has no build step, so this is the only guard."""
    # 9.0-m0: this markup is in the shell today, so reading the file still passes - but the
    # contract is now "grep the PAGE", and the day the header moves to a partial the file read
    # goes quietly wrong rather than loudly wrong.
    from conftest import page_markup
    html = page_markup()

    assert '<span class="edition" id="edition" hidden>' in html
    assert TAG in html


def test_index_drives_the_tag_from_the_vault_flag_only():
    """The tag tracks ENCRYPTED (= /health `initialized`), not `locked` and not `auth`. Locked is
    a transient state of an encrypted box; the edition is not, and must not flicker with it.

    Both lines are inside `pollReady`, which moved to `js/sys/model.js` in 7.3-m3 — hence the
    widened haystack.

    ✅ `ENCRYPTED` ITSELF MOVED AT 7.3-m12d, and the reason it had not is worth keeping because it
    was a misreading. It was declared in index.html on the argument that pollReady REASSIGNS it and
    the shim's `Object.assign` copies a value once, so publishing it would pin it at `false` and
    silently disarm the two vault guards in applyLogin. Every word of that is true about the SHIM
    and none of it is true about modules: a module-to-module `import` is a live binding. Once every
    reader was a module it moved to `js/sys/modelstate.js`, and the write is `setEncrypted(...)`
    because assigning to an imported binding is a SyntaxError.

    ⚠️ SO THIS TEST ASSERTS THE SETTER CALL, not an assignment. The claim is unchanged — the tag
    tracks /health's `initialized` — but the shape that expresses it is now a function call, and a
    check looking for `ENCRYPTED=` would go quietly green the day someone stopped calling it.
    """
    src = _front_end_source()

    # ⚠️ A REGEX, NOT A SUBSTRING, SINCE 8.3.2 — Prettier writes `$('edition').hidden = !ENCRYPTED;`.
    # The claim is unchanged: that exact element's `hidden` is driven by the NEGATION of ENCRYPTED.
    #
    # ⚠️ AND THE CAST FORM IS SPELLED OUT IN FULL SINCE 8.8-m10, when `$()` became honestly
    # nullable and every call site grew a JSDoc assertion. A cast adds a PAREN GROUP, and the
    # harnesses' `relaxSpace` relaxes whitespace, not parens — so a shape pinned on the bare call
    # breaks the day the call site is made honest. 🔴 THE REPAIR IS AN ALTERNATION OF THE TWO EXACT
    # FORMS, NEVER `.*` — widening this to match anything would go green while deleting the claim,
    # which is the vacuous-guard failure this file exists to prevent.
    assert re.search(
        r"(?:\$\('edition'\)|/\*\* @type \{VEl\} \*/ \(\$\('edition'\)\))"
        r"\.hidden\s*=\s*!ENCRYPTED;",
        src,
    )
    assert "setEncrypted(h.initialized);" in src, (
        "pollReady no longer writes ENCRYPTED through js/sys/modelstate.js's setter. It is an "
        "imported live binding since 7.3-m12d, so a bare `ENCRYPTED=...` is a SyntaxError in a "
        "module and anything else is writing a name nothing reads.")


def test_neither_page_dresses_the_tag_up_as_a_control():
    """The edition tag is inert text and must not look clickable.

    A background, a border or a radius on .edition would make it read as a button or a status
    pill — and there is nothing to click and nothing to toggle."""
    # ⚠️ THE TWO PAGES GET THEIR CSS DIFFERENTLY SINCE 7.3.19, and reading both the same way
    # is what made this raise IndexError rather than fail: index.html's rules moved out to
    # src/webui/css/, so `.edition{` is simply not in that file any more. login.html is a
    # standalone page and keeps its own inline block.
    for name, css in (("index.html", page_html()),
                      (LOGIN.name, LOGIN.read_text(encoding="utf-8"))):
        assert ".edition{" in css, f"{name}: no .edition rule at all — this test is blind"
        rule = css.split(".edition{", 1)[1].split("}", 1)[0]
        for banned in ("background", "border", "radius", "cursor", "padding"):
            assert banned not in rule, f"{name}: .edition sets {banned} — that is a control"
