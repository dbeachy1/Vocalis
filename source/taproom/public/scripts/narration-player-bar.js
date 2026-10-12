/* Reusable narration player bar.
 *
 * A compact transport control — pause/resume, a click-and-drag seek bar, a running time readout,
 * mute and stop — docked just above the message input while a narration clip plays. It is built
 * once and then pointed at whichever audio element is currently speaking: the built-in TTS
 * extension's shared `#tts_audio`, or a per-clip element minted by another TTS extension such as
 * Vocalis. No one narrates through two engines at once, so a single shared bar with one active
 * binding is all this needs.
 *
 * The transport itself is the existing {@link AudioPlayer} component; this module only owns the
 * docked container, decides when it is visible, and re-points the player at the current clip.
 */
import { AudioPlayer } from './audio-player.js';

let bar = null;
let player = null;
let boundEl = null;
let stopHandler = null;

function ensureBar() {
    if (bar) {
        return bar;
    }
    const anchor = document.getElementById('send_form');
    if (!anchor?.parentNode) {
        // The chat input isn't in the DOM yet — nothing to dock onto.
        return null;
    }

    bar = document.createElement('div');
    bar.id = 'narration_player_bar';
    bar.classList.add('audio-player-controls');
    bar.style.display = 'none';
    bar.innerHTML = `
        <div class="narration-player-speaker" title=""></div>
        <button class="audio-player-play-pause right_menu_button fa-fw fa-solid fa-play" title="Play"></button>
        <div class="audio-player-time">
            <span class="audio-player-current-time">0:00</span>
            <span class="audio-player-time-separator">/</span>
            <span class="audio-player-total-time">0:00</span>
        </div>
        <div class="audio-player-progress"><div class="audio-player-progress-bar"></div></div>
        <button class="audio-player-volume right_menu_button fa-fw fa-solid fa-volume-high" title="Mute"></button>
        <button class="narration-player-stop right_menu_button fa-fw fa-solid fa-stop" title="Stop"></button>`;
    anchor.parentNode.insertBefore(bar, anchor);

    bar.querySelector('.narration-player-stop').addEventListener('click', () => {
        // Prefer the engine's own stop — it cancels the server render / resets the queue. Fall back
        // to just pausing the element. Either way the bar retires.
        if (typeof stopHandler === 'function') {
            stopHandler();
        } else if (boundEl) {
            try { boundEl.pause(); } catch { /* already gone */ }
        }
        hideNarrationPlayerBar();
    });

    return bar;
}

/**
 * Show the bar for a clip and bind the transport to its audio element.
 * @param {HTMLAudioElement} audioEl the element that is (about to be) playing
 * @param {{ speaker?: string, onStop?: (() => void) | null }} [opts]
 *   `speaker` labels the bar; `onStop` is what the bar's stop button calls (the engine's own stop).
 */
export function showNarrationPlayerBar(audioEl, { speaker = '', onStop = null } = {}) {
    if (!(audioEl instanceof HTMLAudioElement)) {
        return;
    }
    const el = ensureBar();
    if (!el) {
        return;
    }

    // Re-point the transport at this clip's element if it changed. Vocalis mints a fresh Audio()
    // per clip; the built-in TTS reuses one element, so this is a no-op there.
    if (boundEl !== audioEl) {
        if (player) {
            player.destroy();
        }
        boundEl = audioEl;

        // 🔴 SAY WHICH SUBTREE, OR THIS OBSERVES THE WHOLE DOCUMENT. `AudioPlayer` falls back to
        // `audioEl.closest('#chat')` and then to `document.body` with `subtree: true` — and this bar is
        // handed a Vocalis-minted `new Audio()` that is not in the DOM at all, so `closest` is null and the
        // fallback is taken every time. That callback iterates `removedNodes` and calls `contains()` twice
        // per node, on every streamed message re-render and every popup open and close. `observeRoot` was
        // added to this component precisely so a caller that knows its own subtree can say so, and the
        // sibling caller in the TTS extension already does.
        player = new AudioPlayer(audioEl, el, { observeRoot: el.parentNode ?? el });
    }
    stopHandler = onStop;

    // We usually bind mid-play (the caller shows the bar once audio is audible), i.e. after the
    // element's own 'play' event already fired, so sync the toggle to the live state.
    const toggle = el.querySelector('.audio-player-play-pause');
    if (toggle) {
        const playing = !audioEl.paused;
        toggle.classList.toggle('fa-pause', playing);
        toggle.classList.toggle('fa-play', !playing);
        toggle.setAttribute('title', playing ? 'Pause' : 'Play');
    }

    const sp = el.querySelector('.narration-player-speaker');
    if (sp) {
        sp.textContent = speaker || '';
        sp.setAttribute('title', speaker || '');
    }

    el.style.display = 'flex';
}

/** Retire the bar. A manual pause does NOT call this — pausing keeps the bar up. */
export function hideNarrationPlayerBar() {
    if (bar) {
        bar.style.display = 'none';
    }

    // ⚠️ AND TEAR THE TRANSPORT DOWN, BECAUSE HIDING IS NOT DESTROYING. Setting `display: none` left the
    // player's MutationObserver and its six audio listeners live and bound to a clip that has finished —
    // until the next `show` happened to arrive with a different element. Retiring the bar is exactly the
    // moment there is nothing left to observe.
    if (player) {
        player.destroy();
        player = null;
    }

    boundEl = null;
    stopHandler = null;
}
