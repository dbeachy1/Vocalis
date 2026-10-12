"""Browser half of the installed-instance acceptance check, in headless Chromium with audio muted.

After drive_installer.ps1 installs an instance, this walks what a user does in the browser:
Vocalis first-run setup (/setup: admin account and vault, recovery key shown once), Taproom owner
login, pairing the Vocalis extension (token from Vocalis's pairing settings, pasted into the
extension's settings, then the extension's own Test), and one narration whose audio Vocalis
renders and caches.

Audio: Chromium is launched with --mute-audio, so nothing can reach the speakers whatever the page
does (Doug, October 9, 2026: test narration reached his speakers twice from a visible browser). It
is headless, so nothing appears on screen either.

Secrets: the Taproom owner answers come from the installer test's answers file; the Vocalis
password is generated here; the Vocalis password and both recovery keys are written to the secrets
folder and never printed. Steps are idempotent where the product allows: an already-initialized
Vocalis is logged into instead of set up.

Usage: python acceptance_browser.py --vocalis URL --taproom URL --secrets DIR [--step all|vocalis|taproom|narrate]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

# The admin user the installer tests create; another instance under test can name its own.
VOCALIS_USER = os.environ.get("VOCALIS_TEST_USER", "m1instowner")


class Failed(Exception):
    """A check failed; the message says which. An ordinary exception, so the feature sweep that reuses
    these steps records it as that step's failure and carries on."""


def fill_secret(page, selector: str, value: str, what: str) -> None:
    """Type a secret into a field. Playwright's own error for a fill that times out quotes the value it was
    typing, and the scripts print and save error text, so a failure here is re-raised as a plain Failed that
    names the field and never the value (review, October 10, 2026)."""
    try:
        page.locator(selector).fill(value)
    except Exception:  # noqa: BLE001 - deliberately dropped: the original message contains the secret
        raise Failed(f"could not fill {what}") from None


def log(text: str) -> None:
    print(time.strftime("%H:%M:%S"), text, flush=True)


# Taproom's popups are <dialog> elements in the top layer (position: fixed, so offsetParent is null even
# when shown); checkVisibility() is what tells a shown one from a closed one.
POPUP_SHOWN = "() => [...document.querySelectorAll('.popup')].some(p => p.checkVisibility())"


def wait_until(page, condition: str, deadline: float, what: str) -> None:
    """Wait for a page condition, re-checked by Playwright on every animation frame, until the deadline.
    The deadline is a safety bound only; the condition is the signal."""
    try:
        page.wait_for_function(condition, timeout=max(deadline - time.monotonic(), 0.001) * 1000)
    except PlaywrightTimeout:
        raise Failed("timed out waiting for " + what) from None


def clear_popups(page, timeout_s: float = 60) -> None:
    """Answer whatever popups are open, as a user who only wants to chat would: No where there is a No
    (import a lorebook?), otherwise OK. A fresh Taproom user gets first-use popups (persona onboarding)
    when a chat opens, and an open one covers the send button."""
    deadline = time.monotonic() + timeout_s
    while page.evaluate(f"({POPUP_SHOWN})()"):
        if time.monotonic() > deadline:
            raise Failed("Taproom popups kept appearing for 60 s")
        popup = top_popup(page)
        if not popup.count():
            continue
        first_line = (popup.inner_text().strip().splitlines() or [""])[0][:80]
        no = popup.get_by_text("No", exact=True)
        ok = popup.locator(".popup-button-ok:visible").first
        button = no if no.count() else ok if ok.count() else None
        log("Taproom: " + ("answered No to" if no.count() else "closed" if button else "waiting out") + ": " + first_line)
        press_and_wait_closed(popup, button, deadline)


def top_popup(page):
    """The visible popup to answer: the newest one that has a button, else the newest visible one. A
    self-closing notice can stay up beneath a question it opened, and answering the question is what
    lets it close."""
    with_button = page.locator(".popup:visible").filter(
        has=page.locator(".popup-button-ok:visible, .popup-button-close:visible, .popup-button-custom:visible"))
    return with_button.last if with_button.count() else page.locator(".popup:visible").last


def press_and_wait_closed(popup, button, deadline: float) -> None:
    """Press a popup's button and wait until that same popup has closed, so the next look at the page
    cannot see it again. With no button (a self-closing notice), wait until it closes or another popup
    opens: Taproom's "Initializing..." notice stays up until the recovery key popup it opens is answered
    (seen October 9, 2026 on a first login)."""
    handle = popup.element_handle()
    if button is not None:
        button.click()
    page = popup.page
    try:
        page.wait_for_function(
            """([p, waitForOthers]) => !p.isConnected || !p.checkVisibility()
                || (waitForOthers && [...document.querySelectorAll('.popup')].some(o => o !== p && o.checkVisibility()))""",
            arg=[handle, button is None], timeout=max(deadline - time.monotonic(), 0.001) * 1000)
    except PlaywrightTimeout:
        raise Failed("a Taproom popup did not close") from None


def read_secret(directory: Path, name: str) -> str | None:
    path = directory / name
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


def write_secret(directory: Path, name: str, value: str) -> None:
    path = directory / name
    path.write_text(value + "\n", encoding="utf-8")


def vocalis_setup(page, base: str, secrets_dir: Path) -> None:
    """First-run /setup through the real page, or a login when it already ran."""
    password = read_secret(secrets_dir, "vocalis-password")
    page.goto(base + "/setup", wait_until="domcontentloaded")
    if "/setup" in page.url and page.locator("#create").is_visible():
        if password is None:
            password = secrets.token_urlsafe(18)
            write_secret(secrets_dir, "vocalis-password", password)
        page.fill("#username", VOCALIS_USER)
        fill_secret(page, "#password", password, "the Vocalis password field")
        fill_secret(page, "#confirm", password, "the Vocalis password confirmation field")
        page.click("#create")
        page.wait_for_selector("#recovery-value:not(:empty)", timeout=60000)
        write_secret(secrets_dir, "vocalis-recovery-key", page.inner_text("#recovery-value"))
        log("Vocalis: admin account and vault created; recovery key saved to the secrets folder")
        page.click("#continue")
        page.wait_for_load_state("domcontentloaded")
    else:
        vocalis_login(page, base, password)
    health = page.evaluate("async () => (await fetch('/health')).json()")
    log(f"Vocalis health: initialized={health.get('initialized')} locked={health.get('locked')} version={health.get('version')}")
    if not health.get("initialized") or health.get("locked"):
        raise Failed("Vocalis is not initialized and unlocked after setup")


def vocalis_login(page, base: str, password: str | None) -> None:
    if password is None:
        raise Failed("Vocalis is already set up and the secrets folder has no vocalis-password")
    status = page.evaluate(
        """async ([u, p]) => (await fetch('/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username: u, password: p})})).status""", [VOCALIS_USER, password])
    log(f"Vocalis login: HTTP {status}")
    page.goto(base + "/", wait_until="domcontentloaded")


def pairing_token(page) -> str:
    """The token the pairing settings show; minted (rotated) only when none exists yet."""
    current = page.evaluate("async () => (await fetch('/wbedit/pairing')).json()")
    if current.get("paired") and current.get("token"):
        return current["token"]
    minted = page.evaluate("""async () => (await fetch('/wbedit/pairing/rotate', {method: 'POST',
        headers: {'Origin': location.origin}})).json()""")
    log("Vocalis: pairing token minted")
    return minted["token"]


def taproom_login(page, base: str, secrets_dir: Path) -> None:
    """Owner login through the real login page, then the one-time recovery key popup and first-run popups."""
    answers = json.loads((secrets_dir / "owner-answers.json").read_text(encoding="utf-8"))
    password = dict(answers)["Owner password: "]
    page.goto(base + "/", wait_until="domcontentloaded")
    if "/login" in page.url:
        page.click(".userSelect")
        page.wait_for_selector("#userPassword", state="visible")
        fill_secret(page, "#userPassword", password, "the Taproom password field")
        page.click("#loginButton")
        page.wait_for_url(lambda url: "/login" not in url, timeout=60000)
    log("Taproom: logged in as the owner")
    # Taproom finishes starting up only after its first-run popups are answered (the recovery key one
    # holds initialization), and the chat box is visible long before that. "Fully loaded" is the moment
    # the Vocalis extension has built its settings, so popups are handled until then.
    loaded = f"() => !!document.querySelector('#vocalis_token') && !({POPUP_SHOWN})()"
    deadline = time.monotonic() + 120
    while True:
        wait_until(page, f"() => ({loaded})() || ({POPUP_SHOWN})()", deadline,
                   "Taproom to finish loading (the Vocalis extension's settings never appeared)")
        if page.evaluate(loaded):
            break
        popup = top_popup(page)
        if not popup.count():
            continue  # it closed itself between the two checks
        text = popup.inner_text()
        if "Save your recovery key" in text:
            # The key wraps across lines in the popup; with whitespace removed it is the only run of
            # upper-case/digit groups joined by dashes (the prose around it is mixed case).
            key = re.search(r"([0-9A-Z]{5}(?:-[0-9A-Z]{1,6}){4,})", re.sub(r"\s+", "", text))
            if not key:
                raise Failed("Taproom showed its recovery key popup but no key could be read from it")
            write_secret(secrets_dir, "taproom-recovery-key", key.group(1))
            popup.locator("input[type=checkbox]").first.check()
            press_and_wait_closed(popup, popup.locator(".popup-button-ok"), deadline)
            log("Taproom: recovery key saved to the secrets folder and confirmed")
        elif re.search(r"lorebook|world info", text, re.I) and popup.get_by_text("No", exact=True).count():
            press_and_wait_closed(popup, popup.get_by_text("No", exact=True), deadline)
            log("Taproom: answered No to the lorebook import question")
        else:
            # A popup with no visible button (Taproom's own "Initializing..." notice) closes itself.
            button = popup.locator(".popup-button-ok:visible, .popup-button-close:visible").first
            log("Taproom: " + ("closing" if button.count() else "waiting out") + " a first-run popup: "
                + text.strip().splitlines()[0][:80])
            press_and_wait_closed(popup, button if button.count() else None, deadline)


def open_first_character(page, need_narrate_button: bool, timeout_s: float) -> None:
    """Open the first character's chat and return once it is on the page and the Vocalis extension has
    handled the chat change; first-time questions (import the embedded lorebook?) are answered No, as a
    user who only wants to chat would."""
    deadline = time.monotonic() + timeout_s
    # A brand-new user's character list arrives after the first-run notices close; selecting a character before
    # it exists does nothing and no chat change ever follows (seen October 10, 2026 on a fresh install: the
    # step timed out, then took 4.7 s on the next run). So the list is waited for first.
    wait_until(page, "() => (SillyTavern.getContext().characters || []).length > 0", deadline,
               "Taproom's character list to load")
    page.evaluate("""async () => {
        const ctx = SillyTavern.getContext();
        // The extension stops any playback and resets its message states in its own CHAT_CHANGED
        // handler, so a narration started before that handler ran is cut off. Listening last means this
        // flag is set only after every other listener, the extension's included, has finished.
        window.__vocalisChatSettled = String(ctx.characterId) === '0';
        if (!window.__vocalisChatSettled) {
            ctx.eventSource.makeLast(ctx.eventTypes.CHAT_CHANGED, () => { window.__vocalisChatSettled = true; });
            await ctx.selectCharacterById('0');
        }
    }""")
    # The welcome chat also has a message 0, so "ready" is the character's own chat being open. The
    # narrate button is a hover-only message button: it is attached, not visible, until hovered.
    target = '.mes[mesid="0"] .vocalis_narrate' if need_narrate_button else '.mes[mesid="0"]'
    ready = f"""() => {{ const c = SillyTavern.getContext(); return !!window.__vocalisChatSettled
        && String(c.characterId) === '0' && c.chat.length > 0 && !!document.querySelector('{target}'); }}"""
    while True:
        try:
            wait_until(page, f"() => ({ready})() || ({POPUP_SHOWN})()", deadline,
                       "the first character's chat to open" + (" with a narrate button" if need_narrate_button else ""))
        except Failed as exc:
            # What the page showed, so a failure on a fresh user (which cannot be recreated at will) explains itself.
            seen = page.evaluate("""() => { const c = SillyTavern.getContext();
                return {characterId: c.characterId, characters: (c.characters || []).length, chat: (c.chat || []).length,
                        settled: !!window.__vocalisChatSettled, narrate: !!document.querySelector('.mes[mesid="0"] .vocalis_narrate'),
                        popups: [...document.querySelectorAll('.popup')].filter(p => p.checkVisibility())
                                 .map(p => p.innerText.trim().split('\\n')[0].slice(0, 80))}; }""")
            raise Failed(f"{exc}; page state: {json.dumps(seen)}") from None
        if page.evaluate(ready):
            return
        popup = top_popup(page)
        if not popup.count():
            continue
        first_line = popup.inner_text().strip().splitlines()[0][:80]
        if popup.get_by_text("No", exact=True).count():
            press_and_wait_closed(popup, popup.get_by_text("No", exact=True), deadline)
            log("Taproom: answered No to: " + first_line)
        elif popup.locator(".popup-button-ok:visible").count():
            press_and_wait_closed(popup, popup.locator(".popup-button-ok:visible").first, deadline)
            log("Taproom: closed: " + first_line)
        else:
            press_and_wait_closed(popup, None, deadline)


def pair_extension(page, vocalis_base: str, token: str) -> None:
    """Paste the Vocalis URL and token into the extension's settings fields and press its Test button."""
    page.wait_for_selector("#vocalis_token", state="attached", timeout=60000)
    page.evaluate("""([url, token]) => {
        $('#vocalis_url').val(url).trigger('change');
        $('#vocalis_token').val(token).trigger('change');
        $('#vocalis_status').text('');
        $('#vocalis_test').trigger('click');
    }""", [vocalis_base, token])
    page.wait_for_function("() => /OK|fail|reject|locked|not paired/i.test($('#vocalis_status').text())", timeout=60000)
    status = page.evaluate("() => $('#vocalis_status').text()")
    log("Taproom extension Test: " + status)
    if "paired" not in status or "not paired" in status or "rejected" in status:
        raise Failed("the extension did not report a working pairing")


def narrate_first_message(page) -> None:
    """Open the first character's chat and narrate its greeting; success is the button turning 'cached'."""
    page.evaluate("""async () => {
        window.__vocalisToasts = [];
        for (const kind of ['error', 'warning']) {
            const original = toastr[kind].bind(toastr);
            toastr[kind] = (...a) => { window.__vocalisToasts.push(kind + ': ' + String(a[0]).slice(0, 200)); return original(...a); };
        }
    }""")
    open_first_character(page, need_narrate_button=True, timeout_s=60)
    name = page.evaluate("() => SillyTavern.getContext().name2")
    log(f"Taproom: narrating the greeting of {name}")
    started = time.monotonic()
    page.evaluate("""() => document.querySelector('.mes[mesid="0"] .vocalis_narrate').click()""")
    page.wait_for_function("""() => document.querySelector('.mes[mesid="0"] .vocalis_narrate').className.includes('vocalis_cached')
        || (window.__vocalisToasts || []).some(t => t.startsWith('error'))""", timeout=600000)
    toasts = page.evaluate("() => window.__vocalisToasts")
    classes = page.evaluate("""() => document.querySelector('.mes[mesid="0"] .vocalis_narrate').className""")
    log(f"Taproom: narration button after {time.monotonic() - started:.0f} s: {classes}; toasts: {toasts}")
    if "vocalis_cached" not in classes:
        raise Failed("the narration did not complete")
    page.evaluate("""() => { const b = document.querySelector('.mes[mesid="0"] .vocalis_narrate');
        if (b.className.includes('fa-stop')) b.click(); }""")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--vocalis", required=True)
    parser.add_argument("--taproom", required=True)
    parser.add_argument("--secrets", required=True)
    parser.add_argument("--step", default="all", choices=["all", "vocalis", "taproom", "narrate"])
    parser.add_argument("--shots", help="folder for step screenshots (optional)")
    args = parser.parse_args()
    secrets_dir = Path(args.secrets)
    shots = Path(args.shots) if args.shots else None

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--mute-audio", "--autoplay-policy=no-user-gesture-required"])
        context = browser.new_context()
        vocalis = context.new_page()
        vocalis_setup(vocalis, args.vocalis.rstrip("/"), secrets_dir)
        token = pairing_token(vocalis)
        if shots:
            vocalis.screenshot(path=str(shots / "vocalis.png"))
        if args.step == "vocalis":
            browser.close()
            return 0
        taproom = context.new_page()
        taproom_login(taproom, args.taproom.rstrip("/"), secrets_dir)
        pair_extension(taproom, args.vocalis.rstrip("/"), token)
        if args.step != "taproom":
            narrate_first_message(taproom)
        if shots:
            taproom.screenshot(path=str(shots / "taproom.png"))
        browser.close()
        log("acceptance browser steps passed")
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Failed as exc:
        log("FAILED: " + str(exc))
        sys.exit(1)
