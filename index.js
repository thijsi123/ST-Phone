// Thin bootstrap: wires up SillyTavern events and delegates everything else
// to settings.js (state/persistence), ui.js (rendering), and phone.js (core
// phone behavior: parsing, vector memory, generation). Import side effects
// from phone.js also register globalThis.stPhoneMemoryInterceptor, which
// manifest.json's generate_interceptor references by name.

import { eventSource, event_types } from '../../../../script.js';
import { ensureState, flushSaveState } from './settings.js';
import { buildUi, render, updateClock, syncViewportPositions, updateMemoryStatus, applyLauncherPosition } from './ui.js';
import { setPrompt, handleRenderedMessage } from './phone.js';

let initialized = false;

function init() {
    if (initialized) return;
    initialized = true;
    ensureState();
    buildUi();
    setPrompt();
    render();
    setInterval(updateClock, 30000);
    window.addEventListener('resize', syncViewportPositions, { passive: true });
    window.addEventListener('orientationchange', syncViewportPositions, { passive: true });
    // Mobile browsers can suspend a backgrounded tab within a second or two,
    // silently dropping any debounced write that hasn't fired yet. Flush
    // immediately whenever the page is about to leave the foreground.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) flushSaveState();
    });
    window.addEventListener('pagehide', flushSaveState);
    updateMemoryStatus();
    eventSource.on('st_memory_status', updateMemoryStatus);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleRenderedMessage);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        ensureState();
        setPrompt();
        render();
        updateMemoryStatus();
        applyLauncherPosition();
    });
}

eventSource.once(event_types.APP_READY, init);
