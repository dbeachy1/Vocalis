"""The chat-model half of the acceptance check, in headless Chromium with audio muted.

What acceptance_features.py cannot cover without a chat model: Mnemosyne pulling a fact out of a
chat and recalling it in a later reply, Cache Lens recording each generation's prompt measurements,
and Vocalis auto-narrating a new AI reply. It uses Featherless (Doug, October 9, 2026: "Just use
featherless"), model deepseek-ai/DeepSeek-V4.1-Flash with the "DeepSeek V4.1 Flash (chat)" instruct
preset, as the October 8 runs on the earlier candidate did.

Cost bound: a 350-token reply cap and at most MAX_GENERATIONS chat turns, plus Mnemosyne's own
extraction calls (a few per ingest).

Secrets: the Taproom owner answers come from the secrets folder, and so does the Featherless key
(featherless-key.txt, one line, put there by Doug). The key is typed into Taproom's own key field and
never printed, logged or written anywhere else. Nothing appears on screen and nothing reaches the
speakers: Chromium is headless and launched with --mute-audio.

Usage: python acceptance_llm.py --vocalis URL --taproom URL --secrets DIR [--key-file FILE] [--out FILE]
Exit code: 0 every check passed; 1 a check failed (the reason is printed and in the results file).
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from pathlib import Path

import acceptance_browser as ab
from acceptance_browser import Failed, log
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

MODEL = "deepseek-ai/DeepSeek-V4.1-Flash"
PRESET = "DeepSeek V4.1 Flash (chat)"
REPLY_CAP = 350
MAX_GENERATIONS = 7
# Mnemosyne's first ingest runs once the chat holds this many fresh messages (its firstPassMessages
# default). The character's greeting is not one: its log reads "ingest: 4/5 fresh turns" after two turns.
FIRST_PASS_MESSAGES = 5
# A fact new to every run, so a memory an earlier run left behind can never satisfy the checks.
STATION = f"Zephyr-{secrets.randbelow(900) + 100}"
COLOUR = secrets.choice(["cobalt blue", "amber gold", "jade green", "crimson red"])
FACT = (f"For this test, remember one thing about me: my radio station is called {STATION} "
        f"and its signal light is {COLOUR}.")
FOLLOW_UP = "Thanks. Please just acknowledge briefly."
RECALL = f"What colour is the signal light at {STATION}? Answer in one short sentence."
POLISH_DRAFT = "ok thx. one more thing, pls tell me agian in one short sentance what u like most about the forest"


def wait_js(page, condition: str, seconds: float, what: str, arg=None, polling="raf") -> None:
    """Wait for a page condition; the deadline is a safety bound, the condition is the signal. A condition
    that asks the server (a fetch) is re-checked every `polling` ms rather than every frame."""
    try:
        page.wait_for_function(condition, arg=arg, timeout=seconds * 1000, polling=polling)
    except PlaywrightTimeout:
        raise Failed(f"timed out after {seconds:.0f} s waiting for {what}") from None


def connect_featherless(page, key: str) -> dict:
    """Select Text Completion > Featherless, save the key through its own field, connect, then pick the
    model and the instruct preset through the normal controls."""
    if page.evaluate("() => document.querySelector('#rm_api_block').classList.contains('closedDrawer')"):
        page.click("#API-status-top")
        wait_js(page, "() => !document.querySelector('#rm_api_block').classList.contains('closedDrawer')", 10, "the API drawer")
    page.select_option("#main_api", "textgenerationwebui")
    page.select_option("#textgen_type", "featherless")
    ab.fill_secret(page, "#api_key_featherless", key, "the Featherless key field")
    page.click("#api_button_textgenerationwebui")
    wait_js(page, "() => SillyTavern.getContext().onlineStatus !== 'no_connection'", 60, "Featherless to connect")
    with page.expect_response(lambda r: r.url.endswith("/api/backends/text-completions/status"), timeout=60000):
        page.click("#featherless_refresh_models_button")
    if page.input_value("#featherless_category_selection") != "All":
        page.select_option("#featherless_category_selection", "All")
    page.fill("#featherless_model_search_bar", MODEL)
    card = page.locator("#featherless_model_card_block .model-card").filter(has_text=MODEL)
    card.first.wait_for(state="visible", timeout=30000)
    with page.expect_response(lambda r: r.url.endswith("/api/backends/text-completions/status"), timeout=30000):
        card.first.click()
    wait_js(page, "m => (document.querySelector('#featherless_selected_model')?.textContent || '').trim() === m",
            15, "the model to be selected", MODEL)
    if not page.locator("#instruct_presets").is_visible():
        page.click("#advanced-formatting-button .drawer-toggle")
    page.locator("#instruct_presets").wait_for(state="visible", timeout=10000)
    page.select_option("#instruct_presets", PRESET)
    if not page.is_checked("#instruct_enabled"):
        page.click("#instruct_enabled_label")
    wait_js(page, "p => document.querySelector('#instruct_presets').value === p && document.querySelector('#instruct_enabled').checked",
            10, "the instruct preset", PRESET)
    page.evaluate(f"() => $('#amount_gen').val({REPLY_CAP}).trigger('input').trigger('change')")
    wait_js(page, f"() => Number($('#amount_gen').val()) === {REPLY_CAP}", 5, "the reply cap")
    # Close the settings drawers again, as a user would: an open one covers the chat's send button.
    page.evaluate("""() => $('.drawer-content.openDrawer').each((_, d) =>
        $(d).closest('.drawer').find('.drawer-toggle').first().trigger('click'))""")
    wait_js(page, "() => !document.querySelector('.drawer-content.openDrawer')", 10, "the settings drawers to close")
    return page.evaluate("""() => ({mainApi: $('#main_api').val(), textgen: $('#textgen_type').val(),
        model: ($('#featherless_selected_model').text() || '').trim(), preset: $('#instruct_presets').val(),
        instruct: $('#instruct_enabled').prop('checked'), replyCap: Number($('#amount_gen').val()),
        status: SillyTavern.getContext().onlineStatus})""")


def install_watchers(page) -> None:
    """Count finished generations and catch error toasts, from events rather than by looking for a pause."""
    page.evaluate("""() => {
        if (window.__llmWatch) return;
        const c = SillyTavern.getContext();
        window.__llmWatch = {ended: 0, stopped: 0, errors: []};
        c.eventSource.makeLast(c.eventTypes.GENERATION_ENDED, () => { window.__llmWatch.ended++; });
        c.eventSource.makeLast(c.eventTypes.GENERATION_STOPPED, () => { window.__llmWatch.stopped++; });
        const original = toastr.error.bind(toastr);
        toastr.error = (...a) => { window.__llmWatch.errors.push(String(a[0]).slice(0, 300)); return original(...a); };
    }""")


def send_turn(page, text: str, generations: list) -> str:
    if len(generations) >= MAX_GENERATIONS:
        raise Failed(f"the {MAX_GENERATIONS}-generation budget would be exceeded")
    wait_js(page, """() => { const b = document.querySelector('#send_but'), f = document.querySelector('#send_form');
        return b && f && !f.classList.contains('no-connection') && getComputedStyle(b).display !== 'none'; }""",
            60, "the send button")
    ab.clear_popups(page)
    before = page.evaluate("() => window.__llmWatch.ended + window.__llmWatch.stopped")
    errors_before = page.evaluate("() => window.__llmWatch.errors.length")
    started = time.monotonic()
    page.fill("#send_textarea", text)
    page.click("#send_but")
    wait_js(page, f"() => window.__llmWatch.ended + window.__llmWatch.stopped > {before}", 240, "the reply")
    errors = page.evaluate(f"() => window.__llmWatch.errors.slice({errors_before})")
    reply = page.evaluate("""() => { const c = SillyTavern.getContext(), m = c.chat[c.chat.length - 1];
        return m && !m.is_user ? String(m.mes || '') : ''; }""")
    generations.append(round(time.monotonic() - started, 1))
    if errors or not reply.strip():
        raise Failed(f"no reply to {text[:40]!r}; errors: {errors}")
    log(f"Taproom: reply {len(generations)} in {generations[-1]} s ({len(reply)} characters)")
    return reply


def polish_turn(page, draft: str, generations: list) -> dict:
    """Type a draft, press Vocalis's Polish and Send control, and wait for the polished message and the
    character's reply to it. Two model calls: the polish itself and the reply."""
    if len(generations) + 2 > MAX_GENERATIONS:
        raise Failed(f"the {MAX_GENERATIONS}-generation budget would be exceeded")
    wait_js(page, """() => { const c = document.querySelector('#vocalis_polish_send');
        return c && !c.hidden && !c.classList.contains('vocalis_polish_unavailable') && !c.classList.contains('vocalis_polish_busy'); }""",
            60, "the Polish and Send control to be available")
    ab.clear_popups(page)
    before = page.evaluate("() => SillyTavern.getContext().chat.length")
    errors_before = page.evaluate("() => window.__llmWatch.errors.length")
    started = time.monotonic()
    page.fill("#send_textarea", draft)
    page.click("#vocalis_polish_send")
    wait_js(page, f"""() => {{ const c = SillyTavern.getContext().chat, last = c[c.length - 1];
        return c.length >= {before + 2} && last && !last.is_user && String(last.mes || '').trim()
            && !document.body.dataset.generating && getComputedStyle(document.querySelector('#send_but')).display !== 'none'; }}""",
            300, "the polished message and its reply")
    errors = page.evaluate(f"() => window.__llmWatch.errors.slice({errors_before})")
    sent = page.evaluate(f"() => String(SillyTavern.getContext().chat[{before}]?.mes || '')")
    if errors or not sent.strip():
        raise Failed(f"Polish and Send did not complete; errors: {errors}")
    generations.extend([round(time.monotonic() - started, 1), 0.0])
    return {"seconds": generations[-2], "draftCharacters": len(draft), "sentCharacters": len(sent), "changedTheDraft": sent.strip() != draft.strip()}


def open_mnemosyne(page):
    """Open the Memories panel and wait until it has drawn its list (it fills in after it opens)."""
    page.locator("#pluginPanelButton_mnemosyne_0").wait_for(state="attached", timeout=15000)
    page.click("#pluginPanelButton_mnemosyne_0")
    page.locator('#pluginPanel-mnemosyne [data-panel-region="list"]').wait_for(state="attached", timeout=15000)


def close_mnemosyne(page) -> None:
    page.click(".popup:has(#pluginPanel-mnemosyne) .popup-button-ok")
    page.locator("#pluginPanel-mnemosyne").wait_for(state="detached", timeout=10000)


# The panel lists memory rows in its "list" region (one "slot-N" per row) and, after a reply that used
# memory, shows what was recalled in its "recalled" region ("Just recalled", "What was sent").
MEMORY_ROWS = """([station, colour]) => { const p = document.querySelector('#pluginPanel-mnemosyne');
    const rows = [...(p ? p.querySelectorAll('[data-panel-region="list"] [data-panel-region^="slot-"]') : [])];
    const fact = t => t.includes(station) && t.toLowerCase().includes(colour.split(' ')[0]);
    const recalled = p?.querySelector('[data-panel-region="recalled"]')?.innerText || '';
    return {rows: rows.length, containsFact: rows.some(e => fact(e.innerText)), factRecalled: fact(recalled)}; }"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--vocalis", required=True)
    parser.add_argument("--taproom", required=True)
    parser.add_argument("--secrets", required=True)
    parser.add_argument("--out", help="results JSON (default: llm-<time>.json in the secrets folder's parent)")
    parser.add_argument("--key-file", help="the Featherless key file (default: featherless-key.txt in --secrets); "
                        "lets another instance's test use the one key file without copying it")
    parser.add_argument("--taproom-log", help="the install's Taproom log file (logs/taproom/st.log), when it is readable "
                        "from here: the Polish step then requires Mnemosyne's 'left a background request alone' line")
    args = parser.parse_args()
    taproom_log = Path(args.taproom_log) if args.taproom_log else None
    secrets_dir = Path(args.secrets)
    key_file = Path(args.key_file) if args.key_file else secrets_dir / "featherless-key.txt"
    if not key_file.is_file():
        raise Failed(f"no Featherless key file at {key_file}")
    out = Path(args.out) if args.out else secrets_dir.parent / time.strftime("llm-%Y%m%d-%H%M%S.json")
    results: dict = {"fact": {"station": STATION, "colour": COLOUR}, "model": MODEL, "preset": PRESET, "replyCap": REPLY_CAP, "generations": []}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--mute-audio", "--autoplay-policy=no-user-gesture-required"])
            context = browser.new_context()
            vocalis = context.new_page()
            ab.vocalis_setup(vocalis, args.vocalis.rstrip("/"), secrets_dir)
            token = ab.pairing_token(vocalis)
            page = context.new_page()
            ab.taproom_login(page, args.taproom.rstrip("/"), secrets_dir)
            ab.pair_extension(page, args.vocalis.rstrip("/"), token)

            results["connection"] = connect_featherless(page, key_file.read_text(encoding="utf-8").strip())
            log("Taproom: connected: " + json.dumps(results["connection"]))

            # Earlier runs of this test left their own made-up station facts in this user's memory. Mnemosyne treats
            # a new fact at least 0.90 similar to a stored one, with no "now"/"changed" marker, as the same fact said
            # again and drops it (its duplicateCosine, a calibrated trade-off), so a second run's different station
            # would never be stored (seen October 10, 2026). Only those test memories are removed; nothing else.
            removed = page.evaluate("""async () => {
                const h = SillyTavern.getContext().getRequestHeaders();
                const r = await fetch('/api/plugins/mnemosyne/memory?limit=500&includeRetired=1', {headers: h});
                const rows = r.ok ? ((await r.json()).memories || []) : [];
                let n = 0;
                for (const m of rows) {
                    if (/Zephyr-\\d{3}/.test(JSON.stringify(m))) {
                        const d = await fetch('/api/plugins/mnemosyne/memory/' + m.id, {method: 'DELETE', headers: h});
                        if (d.ok) n++;
                    }
                }
                return n;
            }""")
            log(f"Mnemosyne: removed {removed} memory(ies) left by earlier runs of this test")

            # A fresh chat with the first character, so earlier tests' messages do not count.
            ab.open_first_character(page, need_narrate_button=False, timeout_s=90)
            page.evaluate("async () => { const m = await import('/script.js'); await m.doNewChat(); }")
            wait_js(page, "() => SillyTavern.getContext().chat.length === 1", 30, "the new chat's greeting")
            install_watchers(page)
            page.evaluate("() => $('#vocalis_auto').prop('checked', true).trigger('change')")

            # 1. Auto-narration of a new reply, and the fact Mnemosyne should keep.
            gens = results["generations"]
            send_turn(page, FACT, gens)
            last = "() => { const c = SillyTavern.getContext(); return c.chat.length - 1; }"
            mesid = page.evaluate(last)
            wait_js(page, f"""() => {{ const b = document.querySelector('.mes[mesid="{mesid}"] .vocalis_narrate');
                return b && /vocalis_(cached|playing)/.test(b.className); }}""", 600, "the reply to be auto-narrated")
            results["autoNarration"] = page.evaluate(f"""() => document.querySelector('.mes[mesid="{mesid}"] .vocalis_narrate').className""")
            log("Vocalis: new reply auto-narrated: " + results["autoNarration"])
            page.evaluate("() => $('#vocalis_auto').prop('checked', false).trigger('change')")

            # 2. Enough turns for Mnemosyne's first ingest, then the extracted memory row.
            while page.evaluate("() => SillyTavern.getContext().chat.length - 1") < FIRST_PASS_MESSAGES:
                send_turn(page, FOLLOW_UP, gens)
            # Mnemosyne extracts in the background after the reply, and its panel shows the store as it was
            # when opened, so the wait is on the store itself; the panel is opened once the fact is there.
            # wait_for_function does not await a promise (a pending one counts as true), so each check
            # starts one request and reports the last answer that came back.
            wait_js(page, """station => { const w = window.__memoryPoll ||= {busy: false, found: false};
                if (!w.busy) { w.busy = true;
                    fetch('/api/plugins/mnemosyne/memory?limit=500', {headers: SillyTavern.getContext().getRequestHeaders()})
                        .then(r => r.ok ? r.json() : {}).then(j => { w.found = JSON.stringify(j.memories || []).includes(station); })
                        .catch(() => {}).finally(() => { w.busy = false; }); }
                return w.found; }""", 300, "Mnemosyne to store the fact", STATION, polling=2000)
            open_mnemosyne(page)
            results["memoryStored"] = page.evaluate(MEMORY_ROWS, [STATION, COLOUR])
            if not results["memoryStored"]["containsFact"]:
                # Synthetic test text only, so it is safe to keep for diagnosis.
                results["panelText"] = page.evaluate("() => document.querySelector('#pluginPanel-mnemosyne').innerText.slice(0, 3000)")
                raise Failed("the Mnemosyne panel does not show the stored fact")
            log("Mnemosyne: stored: " + json.dumps(results["memoryStored"]))
            close_mnemosyne(page)

            # 3. Recall: the reply answers from memory, and the panel marks the row as recalled.
            answer = send_turn(page, RECALL, gens)
            results["recallAnswerMentionsFact"] = COLOUR.split()[0] in answer.lower()
            open_mnemosyne(page)
            results["memoryRecalled"] = page.evaluate(MEMORY_ROWS, [STATION, COLOUR])
            # "What was sent" shows what Mnemosyne searched on. October 10, 2026 (Mnemosyne 1.7.1): it used to
            # search on the last three LINES of the prompt, which with this instruct preset was the whole chat,
            # so the embedder never saw the question and the fact was missed about two runs in three. The
            # search text must be the question that was typed (synthetic test text only).
            page.locator("#pluginPanel-mnemosyne").get_by_text("What was sent", exact=True).first.click()
            page.locator("#pluginPanel-mnemosyne .mnemosyne-query").first.wait_for(state="attached", timeout=15000)
            results["recallSearchedFor"] = page.evaluate(
                "() => document.querySelector('#pluginPanel-mnemosyne .mnemosyne-query').innerText.trim().slice(0, 1200)")
            results["recallPlacedAboveLastTurn"] = page.evaluate(
                "() => document.querySelector('#pluginPanel-mnemosyne').innerText.includes('Inserted immediately above your own message')")
            close_mnemosyne(page)
            log(f"Mnemosyne: recall answer names the colour: {results['recallAnswerMentionsFact']}; "
                f"panel: {json.dumps(results['memoryRecalled'])}; searched on the question: "
                f"{results['recallSearchedFor'] == RECALL}; placed above the last turn: {results['recallPlacedAboveLastTurn']}")
            if not results["recallAnswerMentionsFact"] or not results["memoryRecalled"]["factRecalled"]:
                raise Failed("the recall turn did not answer from the stored memory")
            if results["recallSearchedFor"] != RECALL:
                raise Failed(f"Mnemosyne searched on {len(results['recallSearchedFor'])} characters that are not the question typed")
            if not results["recallPlacedAboveLastTurn"]:
                raise Failed("the panel does not say the memories were inserted above the user's message")

            # 3b. Polish and Send: Vocalis asks the chat model to polish the draft (a background request), then
            # Taproom sends the polished text and the character replies. October 10, 2026 (Mnemosyne 1.8.0):
            # memories are made from and added to real replies only, so the Polish request must be left
            # alone; with --taproom-log the server's own line for that is required.
            log_before = taproom_log.stat().st_size if taproom_log else 0
            results["polish"] = polish_turn(page, POLISH_DRAFT, gens)
            log(f"Polish and Send: {json.dumps(results['polish'])}")
            if taproom_log:
                with taproom_log.open("rb") as handle:
                    handle.seek(log_before)
                    tail = handle.read().decode("utf-8", errors="replace")
                results["polishLeftAlone"] = tail.count("[Mnemosyne] Left a background request alone")
                log(f"Mnemosyne: background requests left alone during Polish and Send: {results['polishLeftAlone']}")
                if results["polishLeftAlone"] < 1:
                    raise Failed("the Taproom log has no '[Mnemosyne] Left a background request alone' line for the Polish request")

            # 4. Cache Lens: each generation's prompt size and tokens recorded, and still there after a reload.
            page.click("#extensionsMenuButton")
            page.locator("#cache_lens_button").wait_for(state="visible", timeout=10000)
            page.click("#cache_lens_button")
            page.locator(".cachelens .cachelens-rows").wait_for(state="visible", timeout=15000)
            stamps = """async () => { const {chat, chat_metadata} = await import('/script.js');
                const s = chat.map(m => m?.extra?.cacheLens).filter(Boolean)
                    .filter(x => x.promptChars > 0 && x.promptTokens > 0).length;
                const raw = (chat_metadata?.cacheLens?.rawRequests || []).length;
                return {stamps: s, rawRequests: raw, panelRows: document.querySelectorAll('.cachelens-row').length}; }"""
            results["cacheLens"] = page.evaluate(stamps)
            chat_file = page.evaluate("() => SillyTavern.getContext().getCurrentChatId()")
            page.reload(wait_until="domcontentloaded")
            ab.taproom_login(page, args.taproom.rstrip("/"), secrets_dir)
            ab.open_first_character(page, need_narrate_button=False, timeout_s=90)
            page.evaluate("async c => { await SillyTavern.getContext().openCharacterChat(c); }", chat_file)
            wait_js(page, f"() => SillyTavern.getContext().chat.length >= {FIRST_PASS_MESSAGES + 3}", 30, "the chat to reopen")
            reopened = page.evaluate(stamps.replace(", panelRows: document.querySelectorAll('.cachelens-row').length", ""))
            results["cacheLensAfterReload"] = reopened
            log(f"Cache Lens: {json.dumps(results['cacheLens'])}; after reload: {json.dumps(reopened)}")
            if results["cacheLens"]["stamps"] < 1 or results["cacheLens"]["panelRows"] < 1 or reopened["stamps"] < results["cacheLens"]["stamps"]:
                raise Failed("Cache Lens did not record and keep the generations' prompt measurements")
            browser.close()
        results["result"] = "passed"
        log(f"acceptance LLM checks passed ({len(results['generations'])} generations)")
        return 0
    except Exception as exc:  # noqa: BLE001 - recorded, then reported as the failure
        results["result"] = "failed"
        results["failure"] = f"{type(exc).__name__}: {str(exc)[:600]}"
        log("FAILED: " + results["failure"])
        return 1
    finally:
        out.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
        log(f"results: {out}")


if __name__ == "__main__":
    sys.exit(main())
