"""MCP tool-calling acceptance for an installed Taproom, driven the way a user would in headless Chromium with
audio muted. It connects Chat Completion to an OpenAI-compatible endpoint (Featherless by default) with function
calling on, makes sure the bundled MCP client has handed its tools to Taproom, asks the model to use one, and
records whether a tool call happened and what came back.

Two modes:
  --add-server URL   add (and afterwards remove) a test MCP server at URL, with the header
                     "Authorization: Bearer probe-token-123", and expect its `echo` tool to be called;
  (without it)       use whatever servers the install already has configured and report what the model was offered.

Doug, October 10, 2026: tool use depends on the model ("Not all models can load MCPs"), so the model is a
parameter and the result records it. Secrets are read from files and never printed.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import acceptance_browser as ab  # noqa: E402
from acceptance_browser import Failed, log  # noqa: E402

PROBE_ID = "vocalis-acceptance-probe"
PLUGIN = """async ([path, body]) => {
  const t = (await (await fetch('/csrf-token')).json()).token;
  const r = await fetch('/api/plugins/mcp-client/' + path, {method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CSRF-Token': t}, body: JSON.stringify(body)});
  let j = null; try { j = await r.json(); } catch (e) {}
  return {status: r.status, body: j};
}"""


def wait_js(page, condition: str, seconds: float, what: str, arg=None) -> None:
    try:
        page.wait_for_function(condition, arg=arg, timeout=seconds * 1000, polling="raf")
    except Exception as exc:  # noqa: BLE001 - Playwright's timeout type; the message says what was awaited
        raise Failed(f"timed out after {seconds:.0f} s waiting for {what}") from exc


def connect_chat_completion(page, url: str, key: str, model: str, reply_cap: int) -> dict:
    """Chat Completion > Custom (OpenAI-compatible), the key through its own field, function calling on."""
    if page.evaluate("() => document.querySelector('#rm_api_block').classList.contains('closedDrawer')"):
        page.click("#API-status-top")
        wait_js(page, "() => !document.querySelector('#rm_api_block').classList.contains('closedDrawer')", 10, "the API drawer")
    page.select_option("#main_api", "openai")
    page.select_option("#chat_completion_source", "custom")
    page.fill("#custom_api_url_text", url)
    ab.fill_secret(page, "#api_key_custom", key, "the API key field")
    page.fill("#custom_model_id", model)
    page.evaluate("() => $('#custom_model_id').trigger('input').trigger('change')")
    page.click("#api_button_openai")
    wait_js(page, "() => SillyTavern.getContext().onlineStatus !== 'no_connection'", 90, "the chat completion endpoint to connect")
    # Function calling and a non-streamed, bounded reply, through the same controls the user has.
    page.evaluate(f"""() => {{
        const set = (sel, on) => {{ const el = $(sel); if (el.prop('checked') !== on) el.prop('checked', on).trigger('input').trigger('change'); }};
        set('#openai_function_calling', true);
        set('#stream_toggle', false);
        $('#openai_max_tokens').val({reply_cap}).trigger('input').trigger('change');
        // Taproom's default Chat Completion context (4095 tokens) cannot hold a character card plus tool
        // definitions ("Mandatory prompts exceed the context size"); use a size any current model has.
        set('#oai_max_context_unlocked', true);
        $('#openai_max_context').val(32768).trigger('input').trigger('change');
        $('#custom_prompt_post_processing').val('').trigger('change');
    }}""")
    page.evaluate("""() => $('.drawer-content.openDrawer').each((_, d) =>
        $(d).closest('.drawer').find('.drawer-toggle').first().trigger('click'))""")
    wait_js(page, "() => !document.querySelector('.drawer-content.openDrawer')", 10, "the settings drawers to close")
    return page.evaluate("""() => ({mainApi: $('#main_api').val(), source: $('#chat_completion_source').val(),
        model: $('#custom_model_id').val(), functionCalling: $('#openai_function_calling').prop('checked'),
        streaming: $('#stream_toggle').prop('checked'), status: SillyTavern.getContext().onlineStatus,
        toolCallingSupported: SillyTavern.getContext().ToolManager.isToolCallingSupported()})""")


def tool_state(page) -> dict:
    return page.evaluate("""() => { const tm = SillyTavern.getContext().ToolManager;
        const names = tm.tools.map(t => t.toFunctionOpenAI().function.name);
        return {offered: names.length, names: names.slice(0, 12), supported: tm.isToolCallingSupported()}; }""")


def install_watchers(page) -> None:
    page.evaluate("""() => {
        if (window.__mcpWatch) return;
        const c = SillyTavern.getContext();
        window.__mcpWatch = {ended: 0, stopped: 0, errors: [], toolCalls: []};
        c.eventSource.makeLast(c.eventTypes.GENERATION_ENDED, () => { window.__mcpWatch.ended++; });
        c.eventSource.makeLast(c.eventTypes.GENERATION_STOPPED, () => { window.__mcpWatch.stopped++; });
        c.eventSource.on(c.eventTypes.TOOL_CALLS_PERFORMED, (invocations) => {
            for (const i of (invocations || [])) window.__mcpWatch.toolCalls.push({name: String(i.name || ''),
                result: String(i.result || '').slice(0, 200)});
        });
        const original = toastr.error.bind(toastr);
        toastr.error = (...a) => { window.__mcpWatch.errors.push(String(a[0]).slice(0, 300)); return original(...a); };
    }""")


def ask(page, text: str, seconds: float) -> dict:
    """Send one message and wait until generation has gone quiet: a tool call makes Taproom generate again, so the
    turn is over when a generation has ended and none is running."""
    wait_js(page, """() => { const b = document.querySelector('#send_but'), f = document.querySelector('#send_form');
        return b && f && !f.classList.contains('no-connection') && getComputedStyle(b).display !== 'none'; }""",
            60, "the send button")
    ab.clear_popups(page)
    before = page.evaluate("() => window.__mcpWatch.ended + window.__mcpWatch.stopped")
    started = time.monotonic()
    page.fill("#send_textarea", text)
    page.click("#send_but")
    wait_js(page, f"""() => window.__mcpWatch.ended + window.__mcpWatch.stopped > {before}
        && !document.body.dataset.generating && getComputedStyle(document.querySelector('#send_but')).display !== 'none'""",
            seconds, "the reply (including any tool call round)")
    out = page.evaluate("""() => { const c = SillyTavern.getContext(), m = c.chat[c.chat.length - 1];
        return {reply: m && !m.is_user ? String(m.mes || '') : '', toolCalls: window.__mcpWatch.toolCalls.slice(),
                errors: window.__mcpWatch.errors.slice()}; }""")
    out["seconds"] = round(time.monotonic() - started, 1)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--taproom", required=True)
    ap.add_argument("--secrets", required=True, type=Path)
    ap.add_argument("--key-file", required=True, type=Path)
    ap.add_argument("--api-url", default="https://api.featherless.ai/v1")
    ap.add_argument("--model", default="deepseek-ai/DeepSeek-V4-Pro")
    ap.add_argument("--add-server", default=None, help="URL of a test MCP server to add for this run and remove after")
    ap.add_argument("--prompt", default=None, help="what to ask when using the install's own servers")
    ap.add_argument("--reply-cap", type=int, default=400)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    key = args.key_file.read_text(encoding="utf-8").strip()
    word = f"pineapple-{random.randint(100, 999)}"
    result: dict = {"model": args.model, "apiUrl": args.api_url, "addedServer": bool(args.add_server)}
    code = 1
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--mute-audio"])
        page = browser.new_page()
        plugin = lambda path, body=None: page.evaluate(PLUGIN, [path, body or {}])  # noqa: E731
        try:
            ab.taproom_login(page, args.taproom, args.secrets)
            if args.add_server:
                server = {"id": PROBE_ID, "name": "Vocalis acceptance probe", "enabled": True, "autoConnect": True,
                          "transport": {"type": "streamable-http", "url": args.add_server,
                                        "headers": {"Authorization": "Bearer probe-token-123"}}}
                plugin("servers/remove", {"id": PROBE_ID})
                added = plugin("servers/add", server)
                connected = plugin("servers/connect", {"id": PROBE_ID})
                if added["status"] != 200 or connected["status"] != 200:
                    raise Failed(f"could not add/connect the test server: add {added['status']}, connect {connected['status']}")
                # The extension hands tools to Taproom when it starts, so load the page again.
                page.reload(wait_until="domcontentloaded")
                ab.taproom_login(page, args.taproom, args.secrets)
            result["servers"] = [{"status": s.get("status")} for s in (plugin("servers/status")["body"] or {}).get("servers", [])]
            ab.open_first_character(page, need_narrate_button=False, timeout_s=120)
            result["connection"] = connect_chat_completion(page, args.api_url, key, args.model, args.reply_cap)
            log(f"Taproom: connected: {json.dumps(result['connection'])}")
            result["tools"] = tool_state(page)
            log(f"MCP: tools offered to the model: {result['tools']['offered']} {result['tools']['names']}")
            install_watchers(page)
            if args.add_server:
                question = (f"Use the echo tool with the text \"{word}\" and then tell me exactly what the tool returned.")
            else:
                question = args.prompt or "Use your available tools to list what you can look up for me, then summarize in one sentence."
            turn = ask(page, question, 300)
            # The probe server's results are synthetic, so they are kept; an install's own servers return real
            # data, so only the lengths are recorded for them (review, October 10, 2026).
            result["turn"] = {"seconds": turn["seconds"], "toolCalls": [c["name"] for c in turn["toolCalls"]],
                              "toolResults": [c["result"] if args.add_server else f"<{len(c['result'])} characters>"
                                              for c in turn["toolCalls"]][:3],
                              "replyLength": len(turn["reply"]), "errors": turn["errors"]}
            log(f"Model turn: {turn['seconds']} s, tool calls {result['turn']['toolCalls']}, reply {len(turn['reply'])} characters")
            if args.add_server:
                called = any("echo" in c["name"] for c in turn["toolCalls"])
                returned = any(f"probe-echo: {word}" in c["result"] for c in turn["toolCalls"])
                result["echoCalled"], result["echoReturned"] = called, returned
                result["replyQuotesResult"] = f"probe-echo: {word}" in turn["reply"] or word in turn["reply"]
                if not (called and returned):
                    raise Failed(f"the model did not call the echo tool (offered {result['tools']['offered']} tools, "
                                 f"tool calling supported: {result['tools']['supported']})")
            result["result"] = "passed" if args.add_server else "reported"
            code = 0
        except Failed as exc:
            result["result"], result["failure"] = "failed", str(exc)
            log(f"FAILED: {exc}")
        finally:
            if args.add_server:
                try:
                    plugin("servers/remove", {"id": PROBE_ID})
                except Exception:  # noqa: BLE001 - cleanup only; the run's own result is already recorded
                    pass
            browser.close()
    args.out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    log(f"results: {args.out}")
    return code


if __name__ == "__main__":
    sys.exit(main())
