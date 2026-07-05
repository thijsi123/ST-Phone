// Rendering layer: builds and updates the phone's DOM, handles drag/position
// application, menus, and view switching. No chat_metadata access except via
// settings.js, no message/vector/generation logic (see phone.js for that).

import {
    ensureState, saveState, flushSaveState, getUserName,
    discoveredContacts, threadKey, getThreadMeta, getThread, selectedThreadKey,
    createGroupThread, threadSummaries, getWindowPosition, saveWindowPosition,
    getLauncherPosition, saveLauncherPosition,
} from './settings.js';
import {
    escapeHtml, normalizeName, namesMatch, contactColor, uniqueNames,
    formatTime, outputModeLabel, visibilityLabel,
} from './utils.js';
import { sendCurrentDraft, publishPhoneMessageToChat, setPrompt, memoryApi } from './phone.js';

let dragState = null;
let launcherDragState = null;
let activeMenuMessageId = null;
let activePickerMessageId = null;

// -------------------- POSITION PERSISTENCE --------------------
// Positions live only in chat_metadata.st_phone.ui (same storage every other
// phone/settings state already uses, so it syncs across every device that
// opens this chat). No localStorage: it's per-browser and would never sync
// between a desktop browser and a phone browser in the first place.
//
// Writes go through flushSaveState() (immediate, not saveState()'s debounce)
// because a mobile browser can suspend a backgrounded tab within a second,
// silently dropping a debounced write that hasn't fired yet.

export function isMobileViewport() {
    return window.matchMedia?.('(max-width: 640px)').matches ?? window.innerWidth <= 640;
}

export function clampToViewport(position, element) {
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y) || !element) return null;
    const rect = element.getBoundingClientRect();
    const width = Math.max(rect.width, 44);
    const height = Math.max(rect.height, 44);
    return {
        x: Math.max(4, Math.min(window.innerWidth - width - 4, position.x)),
        y: Math.max(4, Math.min(window.innerHeight - height - 4, position.y)),
    };
}

export function applyElementPosition(element, position) {
    if (!element) return;
    const clamped = clampToViewport(position, element);
    if (!clamped) {
        element.style.left = '';
        element.style.top = '';
        element.style.right = '';
        element.style.bottom = '';
        return null;
    }
    element.style.left = `${clamped.x}px`;
    element.style.top = `${clamped.y}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    return clamped;
}

export function applyLauncherPosition() {
    const launcher = document.getElementById('st-phone-launcher');
    if (!launcher) return;
    const pos = getLauncherPosition();

    // No saved position yet: leave inline styles empty so the stylesheet's
    // default placement applies (bottom-right corner; the mobile media query
    // has its own safe placement). A position is only persisted once the
    // user actually drags the button.
    const clamped = applyElementPosition(launcher, pos);
    if (clamped && (clamped.x !== pos.x || clamped.y !== pos.y)) {
        saveLauncherPosition(clamped);
    }
}

export function updateMemoryStatus() {
    const node = document.querySelector('#st-phone-window [data-role="memory-plugin-status"]');
    if (!node) return;
    const memory = memoryApi();
    node.textContent = !memory
        ? 'ST-Memory: extension not installed'
        : `ST-Memory: ${memory.isAvailable() ? 'plugin detected' : 'plugin not detected'}`;
}

export function buildUi() {
    if (document.getElementById('st-phone-window')) return;

    const root = document.createElement('div');
    root.id = 'st-phone-window';
    root.innerHTML = `
        <div class="st-phone-status">
            <span class="st-phone-clock">12:00</span>
            <span>ST Phone</span>
            <button class="st-phone-close" type="button" title="Close">x</button>
        </div>
        <div class="st-phone-screen">
            <section class="st-phone-lock active" data-screen="lock">
                <div class="st-phone-lock-time">12:00</div>
                <div class="st-phone-lock-date"></div>
                <button class="st-phone-unlock" type="button">Unlock</button>
            </section>
            <section class="st-phone-home" data-screen="home">
                <div class="st-phone-app-grid">
                    <button class="st-phone-app" type="button" data-open-view="messages">
                        <span class="st-phone-app-icon" style="background:#35d07f;">i</span>
                        <span>Messages</span>
                    </button>
                    <button class="st-phone-app" type="button" data-open-view="contacts">
                        <span class="st-phone-app-icon" style="background:#8b6bff;">@</span>
                        <span>Contacts</span>
                    </button>
                    <button class="st-phone-app" type="button" data-open-view="settings">
                        <span class="st-phone-app-icon" style="background:#8d98aa;">*</span>
                        <span>Settings</span>
                    </button>
                </div>
                <div class="st-phone-dock">
                    <button type="button" data-open-view="messages" title="Messages">i</button>
                    <button type="button" data-open-view="contacts" title="Contacts">@</button>
                </div>
            </section>
            <section class="st-phone-view" data-view="messages">
                <div class="st-phone-header">
                    <button class="st-phone-back" type="button" title="Home">&lt;</button>
                    <div class="st-phone-title">Messages</div>
                    <button class="st-phone-header-action" type="button" data-action="new-group" title="New group">+</button>
                </div>
                <div class="st-phone-contact-list" data-role="message-list"></div>
            </section>
            <section class="st-phone-view" data-view="thread">
                <div class="st-phone-header">
                    <button class="st-phone-back" type="button" title="Messages">&lt;</button>
                    <div class="st-phone-title" data-role="thread-title">Thread</div>
                    <button class="st-phone-header-action" type="button" data-open-view="contacts" title="Contacts">@</button>
                </div>
                <div class="st-phone-thread" data-role="thread"></div>
                <form class="st-phone-composer">
                    <textarea data-role="draft" rows="1" placeholder="Write message"></textarea>
                    <button type="submit">></button>
                </form>
            </section>
            <section class="st-phone-view" data-view="contacts">
                <div class="st-phone-header">
                    <button class="st-phone-back" type="button" title="Home">&lt;</button>
                    <div class="st-phone-title">Contacts</div>
                    <button class="st-phone-header-action" type="button" data-action="add-contact" title="Add">+</button>
                </div>
                <div class="st-phone-contact-list" data-role="contacts"></div>
            </section>
            <section class="st-phone-view" data-view="settings">
                <div class="st-phone-header">
                    <button class="st-phone-back" type="button" title="Home">&lt;</button>
                    <div class="st-phone-title">Settings</div>
                    <span style="width:34px"></span>
                </div>
                <div class="st-phone-settings">
                    <label class="st-phone-setting">
                        <div><strong>Prompt integration</strong><span>Tell the model how to emit phone JSON.</span></div>
                        <input type="checkbox" data-setting="injectPrompt">
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Hide extracted JSON</strong><span>Remove parsed phone JSON from visible replies.</span></div>
                        <input type="checkbox" data-setting="hidePhoneJson">
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Open on incoming</strong><span>Show phone when a new text is parsed.</span></div>
                        <input type="checkbox" data-setting="openOnIncoming">
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Strip reasoning blocks</strong><span>Ignore model thinking before parsing phone JSON.</span></div>
                        <input type="checkbox" data-setting="stripReasoning">
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Default output</strong><span>Where newly sent phone messages go.</span></div>
                        <select data-setting-select="defaultOutputMode">
                            <option value="phone_only">Phone only</option>
                            <option value="phone_chat">Phone + general chat</option>
                            <option value="narrated">Narrated in chat</option>
                        </select>
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Default visibility</strong><span>Who knows newly sent phone messages.</span></div>
                        <select data-setting-select="defaultVisibility">
                            <option value="participants">Participants</option>
                            <option value="all">Everyone</option>
                            <option value="selected">Selected</option>
                        </select>
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Default memory</strong><span>Who keeps phone messages as prompt memory.</span></div>
                        <select data-setting-select="defaultMemoryMode">
                            <option value="none">No memory pin</option>
                            <option value="participants">Participants remember</option>
                            <option value="selected">Selected remember</option>
                            <option value="all">Everyone remembers</option>
                        </select>
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Vector phone memory</strong><span>Use KoboldCpp embeddings to recall old related phone/RP events.</span></div>
                        <input type="checkbox" data-setting="vectorMemoryEnabled">
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Memory recall in normal chat</strong><span>Inject speaker-filtered phone memories into regular RP replies (needs ST-Memory plugin).</span></div>
                        <input type="checkbox" data-setting="recallInChat">
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Vector recall count</strong><span>How many related old memories to add to phone-only replies.</span></div>
                        <input type="number" min="0" max="8" step="1" data-setting-number="vectorRecallCount">
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Vector score threshold</strong><span>Higher values require a closer semantic match.</span></div>
                        <input type="number" min="0" max="1" step="0.05" data-setting-number="vectorScoreThreshold">
                    </label>
                    <label class="st-phone-setting">
                        <div><strong>Nearby chat messages</strong><span>RP messages saved around each phone message.</span></div>
                        <input type="number" min="0" max="24" step="1" data-setting-number="vectorNearbyMessages">
                    </label>
                    <label class="st-phone-setting st-phone-setting-stack">
                        <div><strong>Custom reasoning pairs</strong><span>One per line: start =&gt; end</span></div>
                        <textarea data-setting-text="customReasoningPairs" rows="4" placeholder="&lt;analysis&gt; =&gt; &lt;/analysis&gt;"></textarea>
                    </label>
                    <div class="st-phone-setting-status" data-role="memory-plugin-status">ST-Memory: checking...</div>
                </div>
            </section>
        </div>
        <div class="st-phone-menu" data-role="message-menu"></div>
        <div class="st-phone-picker" data-role="picker">
            <div class="st-phone-picker-card">
                <div class="st-phone-picker-head">
                    <strong>Select characters</strong>
                    <button type="button" data-picker-close>x</button>
                </div>
                <div class="st-phone-picker-list" data-role="picker-list"></div>
                <div class="st-phone-picker-actions">
                    <button type="button" data-picker-apply="visibility">Apply visibility</button>
                    <button type="button" data-picker-apply="memory">Apply memory</button>
                </div>
            </div>
        </div>
    `;
    document.body.append(root);

    const launcher = document.createElement('button');
    launcher.id = 'st-phone-launcher';
    launcher.type = 'button';
    launcher.title = 'Open ST Phone';
    launcher.innerHTML = '<span class="st-phone-launcher-label">Phone</span><span class="st-phone-launcher-badge"></span>';
    document.body.append(launcher);

    bindUi();
}

export function showWindow(open = true) {
    const win = document.getElementById('st-phone-window');
    const launcher = document.getElementById('st-phone-launcher');
    if (!win) return;
    win.classList.toggle('st-phone-visible', open);
    launcher?.classList.toggle('st-phone-launcher-open', open);
    const label = launcher?.querySelector('.st-phone-launcher-label');
    if (label) label.textContent = open ? 'Close' : 'Phone';
    if (launcher) launcher.title = open ? 'Close ST Phone' : 'Open ST Phone';
    if (open) {
        const clamped = applyElementPosition(win, getWindowPosition());
        const pos = getWindowPosition();
        if (clamped && pos && (clamped.x !== pos.x || clamped.y !== pos.y)) {
            saveWindowPosition(clamped);
        }
        updateClock();
        render();
    }
}

export function setScreen(screen) {
    const bucket = ensureState();
    bucket.ui.screen = screen;
    saveState();
    render();
}

export function openView(view) {
    ensureState().ui.screen = view;
    saveState();
    render();
}

export function openThread(name) {
    const bucket = ensureState();
    const key = String(name || '').startsWith('group:') ? String(name) : threadKey(name);
    bucket.ui.selectedContact = key;
    bucket.ui.selectedThreadKey = key;
    bucket.ui.screen = 'thread';
    const th = getThread(key);
    for (const msg of th.list) msg.read = true;
    saveState();
    render();
}

export function messageById(messageId) {
    const bucket = ensureState();
    for (const [threadId, list] of Object.entries(bucket.threads)) {
        if (!Array.isArray(list)) continue;
        const message = list.find((entry) => String(entry?.id) === String(messageId));
        if (message) return { message, threadId, list, meta: getThreadMeta(threadId) };
    }
    return null;
}

export function openPicker(messageId) {
    activePickerMessageId = messageId;
    const picker = document.querySelector('#st-phone-window [data-role="picker"]');
    const list = picker?.querySelector('[data-role="picker-list"]');
    const found = messageById(messageId);
    if (!picker || !list || !found) return;
    const selected = new Set((found.message.visibleTo || []).map(normalizeName));
    const names = uniqueNames([getUserName(), ...discoveredContacts(), ...(found.meta.participants || [])]);
    list.innerHTML = names.map((name) => `
        <label>
            <input type="checkbox" value="${escapeHtml(name)}" ${selected.has(normalizeName(name)) ? 'checked' : ''}>
            <span>${escapeHtml(name)}</span>
        </label>
    `).join('');
    picker.classList.add('active');
}

export function closePicker() {
    activePickerMessageId = null;
    document.querySelector('#st-phone-window [data-role="picker"]')?.classList.remove('active');
}

export function selectedPickerNames() {
    return [...document.querySelectorAll('#st-phone-window [data-role="picker-list"] input:checked')]
        .map((input) => input.value)
        .filter(Boolean);
}

export function openMessageMenu(messageId, anchor) {
    activeMenuMessageId = messageId;
    const menu = document.querySelector('#st-phone-window [data-role="message-menu"]');
    const found = messageById(messageId);
    if (!menu || !found) return;
    menu.innerHTML = `
        <button type="button" data-menu-action="output:phone_only">Output: Phone only</button>
        <button type="button" data-menu-action="output:phone_chat">Output: Phone + chat</button>
        <button type="button" data-menu-action="output:narrated">Output: Narrated</button>
        <hr>
        <button type="button" data-menu-action="visibility:participants">Visible to participants</button>
        <button type="button" data-menu-action="visibility:all">Visible to everyone</button>
        <button type="button" data-menu-action="visibility:selected">Visible to selected...</button>
        <hr>
        <button type="button" data-menu-action="memory:toggle">${found.message.pinnedMemory ? 'Unpin memory' : 'Pin memory'}</button>
        <button type="button" data-menu-action="copy">Copy text</button>
        <button type="button" data-menu-action="delete">Delete from phone</button>
    `;
    const rootRect = document.getElementById('st-phone-window').getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.right - rootRect.left - 176)}px`;
    menu.style.top = `${Math.max(40, rect.bottom - rootRect.top + 4)}px`;
    menu.classList.add('active');
}

export function closeMessageMenu() {
    activeMenuMessageId = null;
    document.querySelector('#st-phone-window [data-role="message-menu"]')?.classList.remove('active');
}

export function bindUi() {
    const win = document.getElementById('st-phone-window');
    const launcher = document.getElementById('st-phone-launcher');

    launcher.addEventListener('click', () => {
        if (launcherDragState?.moved) return;
        showWindow(!win.classList.contains('st-phone-visible'));
    });
    launcher.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const rect = launcher.getBoundingClientRect();
        launcherDragState = {
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
        };
        launcher.classList.add('st-phone-launcher-dragging');
        launcher.setPointerCapture(event.pointerId);
    });
    launcher.addEventListener('pointermove', (event) => {
        if (!launcherDragState) return;
        const deltaX = Math.abs(event.clientX - launcherDragState.startX);
        const deltaY = Math.abs(event.clientY - launcherDragState.startY);
        if (deltaX > 4 || deltaY > 4) launcherDragState.moved = true;
        const rect = launcher.getBoundingClientRect();
        const nextX = Math.max(4, Math.min(window.innerWidth - Math.min(rect.width, 48), event.clientX - launcherDragState.offsetX));
        const nextY = Math.max(4, Math.min(window.innerHeight - Math.min(rect.height, 44), event.clientY - launcherDragState.offsetY));
        launcher.style.left = `${nextX}px`;
        launcher.style.top = `${nextY}px`;
        launcher.style.right = 'auto';
        launcher.style.bottom = 'auto';
    });
    launcher.addEventListener('pointerup', () => {
        if (!launcherDragState) return;
        const wasMoved = launcherDragState.moved;
        const rect = launcher.getBoundingClientRect();
        launcherDragState = { moved: wasMoved };
        launcher.classList.remove('st-phone-launcher-dragging');
        if (wasMoved) saveLauncherPosition({ x: rect.left, y: rect.top });
        setTimeout(() => { launcherDragState = null; }, 0);
    });
    launcher.addEventListener('pointercancel', () => {
        launcherDragState = null;
        launcher.classList.remove('st-phone-launcher-dragging');
    });
    win.querySelector('.st-phone-close').addEventListener('click', () => showWindow(false));
    win.querySelector('.st-phone-unlock').addEventListener('click', () => setScreen('home'));

    win.addEventListener('click', async (event) => {
        const menuAction = event.target.closest('[data-menu-action]');
        if (menuAction) {
            await handleMenuAction(menuAction.getAttribute('data-menu-action'));
            return;
        }

        if (event.target.closest('[data-picker-close]')) {
            closePicker();
            return;
        }

        const pickerApply = event.target.closest('[data-picker-apply]');
        if (pickerApply) {
            applyPicker(pickerApply.getAttribute('data-picker-apply'));
            return;
        }

        const menuButton = event.target.closest('[data-message-menu]');
        if (menuButton) {
            event.preventDefault();
            event.stopPropagation();
            openMessageMenu(menuButton.getAttribute('data-message-menu'), menuButton);
            return;
        }

        if (!event.target.closest('.st-phone-menu')) closeMessageMenu();

        const target = event.target.closest('[data-open-view], .st-phone-back, [data-action], .st-phone-contact');
        if (!target) return;

        if (target.classList.contains('st-phone-back')) {
            const screen = ensureState().ui.screen;
            openView(screen === 'thread' ? 'messages' : 'home');
            return;
        }

        const view = target.getAttribute('data-open-view');
        if (view) {
            openView(view);
            return;
        }

        if (target.getAttribute('data-action') === 'add-contact') {
            const name = prompt('Contact name');
            if (name?.trim()) {
                const bucket = ensureState();
                if (!bucket.contacts.some((entry) => namesMatch(entry.name, name))) {
                    bucket.contacts.push({ name: name.trim(), addedAt: Date.now() });
                }
                saveState();
                render();
            }
            return;
        }

        if (target.getAttribute('data-action') === 'new-group') {
            const names = prompt('Group participants, comma-separated', discoveredContacts().join(', '));
            if (names?.trim()) {
                createGroupThread(names.split(',').map((entry) => entry.trim()).filter(Boolean));
                render();
            }
            return;
        }

        const contact = target.getAttribute('data-contact');
        if (contact) openThread(contact);
    });

    win.querySelector('.st-phone-composer').addEventListener('submit', async (event) => {
        event.preventDefault();
        await sendCurrentDraft();
    });

    win.addEventListener('input', (event) => {
        // Checkbox/select/number changes are discrete, one-shot events (not
        // rapid keystrokes), so they flush immediately: a debounced write
        // started right before the user backgrounds the app/tab can be lost.
        const setting = event.target?.getAttribute?.('data-setting');
        if (setting) {
            ensureState().settings[setting] = !!event.target.checked;
            flushSaveState();
            setPrompt();
        }
        const selectSetting = event.target?.getAttribute?.('data-setting-select');
        if (selectSetting) {
            ensureState().settings[selectSetting] = String(event.target.value || '');
            flushSaveState();
            setPrompt();
        }
        const numberSetting = event.target?.getAttribute?.('data-setting-number');
        if (numberSetting) {
            ensureState().settings[numberSetting] = Number(event.target.value);
            flushSaveState();
            setPrompt();
        }
        const textSetting = event.target?.getAttribute?.('data-setting-text');
        if (textSetting) {
            // Free-text field: keep the debounce so typing doesn't spam saves,
            // but a blur listener below flushes it immediately once you leave the field.
            ensureState().settings[textSetting] = String(event.target.value || '');
            saveState();
        }
        if (event.target?.matches?.('[data-role="draft"]')) {
            event.target.style.height = '0px';
            event.target.style.height = `${Math.min(112, event.target.scrollHeight || 42)}px`;
        }
    });
    win.addEventListener('focusout', (event) => {
        if (event.target?.getAttribute?.('data-setting-text')) flushSaveState();
    });

    const status = win.querySelector('.st-phone-status');
    status.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        const rect = win.getBoundingClientRect();
        dragState = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        status.setPointerCapture(event.pointerId);
    });
    status.addEventListener('pointermove', (event) => {
        if (!dragState) return;
        const rect = win.getBoundingClientRect();
        const nextX = Math.max(4, Math.min(window.innerWidth - Math.min(rect.width, 48), event.clientX - dragState.x));
        const nextY = Math.max(4, Math.min(window.innerHeight - 48, event.clientY - dragState.y));
        win.style.left = `${nextX}px`;
        win.style.top = `${nextY}px`;
        win.style.right = 'auto';
        win.style.bottom = 'auto';
    });
    status.addEventListener('pointerup', () => {
        if (!dragState) return;
        dragState = null;
        const rect = win.getBoundingClientRect();
        saveWindowPosition({ x: rect.left, y: rect.top });
        console.log('[ST-Phone] Phone window position saved:', rect.left, rect.top);
    });
}

export async function handleMenuAction(action) {
    const found = messageById(activeMenuMessageId);
    if (!found) {
        closeMessageMenu();
        return;
    }
    const { message, list, meta } = found;
    const [kind, value] = String(action || '').split(':');
    if (kind === 'output') {
        message.outputMode = value || 'phone_only';
        if (value === 'phone_chat') await publishPhoneMessageToChat(message, meta, false);
        if (value === 'narrated') await publishPhoneMessageToChat(message, meta, true);
    } else if (kind === 'visibility') {
        if (value === 'selected') {
            closeMessageMenu();
            openPicker(message.id);
            return;
        }
        message.visibility = value || 'participants';
        message.visibleTo = value === 'all'
            ? uniqueNames([getUserName(), ...discoveredContacts()])
            : uniqueNames(meta.participants || [message.from, message.to]);
    } else if (kind === 'memory') {
        message.pinnedMemory = !message.pinnedMemory;
        message.memoryMode = message.pinnedMemory ? (message.memoryMode || 'participants') : 'none';
        message.memoryVisibleTo = message.pinnedMemory ? uniqueNames(message.visibleTo || meta.participants || []) : [];
    } else if (kind === 'copy') {
        try { await navigator.clipboard?.writeText?.(message.text || ''); } catch { /* noop */ }
    } else if (kind === 'delete') {
        const index = list.findIndex((entry) => entry.id === message.id);
        if (index >= 0) list.splice(index, 1);
    }
    saveState();
    setPrompt();
    closeMessageMenu();
    render();
}

export function applyPicker(mode) {
    const found = messageById(activePickerMessageId);
    if (!found) return closePicker();
    const names = selectedPickerNames();
    if (mode === 'memory') {
        found.message.memoryMode = 'selected';
        found.message.pinnedMemory = true;
        found.message.memoryVisibleTo = uniqueNames(names);
    } else {
        found.message.visibility = 'selected';
        found.message.visibleTo = uniqueNames(names);
    }
    saveState();
    setPrompt();
    closePicker();
    render();
}

export function renderContactButton(summary, active = false) {
    const color = contactColor(summary.name);
    return `
        <button class="st-phone-contact${active ? ' active' : ''}" type="button" data-contact="${escapeHtml(summary.key || summary.name)}">
            <span class="st-phone-avatar" style="color:${color}">${escapeHtml(summary.name.slice(0, 1).toUpperCase())}</span>
            <span class="st-phone-contact-main">
                <span class="st-phone-contact-top">
                    <strong style="color:${color}">${escapeHtml(summary.name)}</strong>
                    <small>${escapeHtml(summary.time || '')}</small>
                </span>
                <span class="st-phone-contact-bottom">
                    <span>${escapeHtml(summary.type === 'group' && !summary.last ? `${summary.participants.length} participants` : (summary.preview || ''))}</span>
                    ${summary.unread ? `<b class="st-phone-unread">${summary.unread}</b>` : ''}
                </span>
            </span>
        </button>
    `;
}

export function render() {
    const bucket = ensureState();
    const win = document.getElementById('st-phone-window');
    const launcher = document.getElementById('st-phone-launcher');
    if (!win || !launcher) return;

    launcher.style.display = bucket.settings.showLauncher ? 'grid' : 'none';
    applyLauncherPosition();
    const isOpen = win.classList.contains('st-phone-visible');
    launcher.classList.toggle('st-phone-launcher-open', isOpen);
    const launcherLabel = launcher.querySelector('.st-phone-launcher-label');
    if (launcherLabel) launcherLabel.textContent = isOpen ? 'Close' : 'Phone';
    launcher.title = isOpen ? 'Close ST Phone' : 'Open ST Phone';

    win.querySelectorAll('[data-screen], .st-phone-view').forEach((node) => node.classList.remove('active'));
    if (bucket.ui.screen === 'lock') {
        win.querySelector('[data-screen="lock"]').classList.add('active');
    } else if (bucket.ui.screen === 'home') {
        win.querySelector('[data-screen="home"]').classList.add('active');
    } else {
        win.querySelector(`[data-view="${bucket.ui.screen}"]`)?.classList.add('active');
    }

    const summaries = threadSummaries();
    const totalUnread = summaries.reduce((sum, item) => sum + item.unread, 0);
    const badge = launcher.querySelector('.st-phone-launcher-badge');
    badge.textContent = String(totalUnread);
    badge.style.display = totalUnread ? 'inline-flex' : 'none';

    const messageList = win.querySelector('[data-role="message-list"]');
    messageList.innerHTML = summaries.length
        ? summaries.map((summary) => renderContactButton(summary, summary.key === bucket.ui.selectedThreadKey)).join('')
        : '<div class="st-phone-empty">No phone contacts yet.</div>';

    const contacts = discoveredContacts();
    const contactList = win.querySelector('[data-role="contacts"]');
    contactList.innerHTML = contacts.length
        ? contacts.map((name) => renderContactButton({ key: threadKey(name), name, preview: 'Open thread', time: '', unread: 0, type: 'direct' }, namesMatch(name, bucket.ui.selectedContact))).join('')
        : '<div class="st-phone-empty">No contacts found for this chat.</div>';

    const selected = selectedThreadKey() || summaries[0]?.key || (contacts[0] ? threadKey(contacts[0]) : '');
    if (selected && !bucket.ui.selectedThreadKey) bucket.ui.selectedThreadKey = selected;
    const meta = selected ? getThreadMeta(selected) : null;
    win.querySelector('[data-role="thread-title"]').textContent = meta?.title || selected || 'Messages';
    const threadNode = win.querySelector('[data-role="thread"]');
    const th = selected ? getThread(selected) : { list: [] };
    threadNode.innerHTML = th.list.length
        ? th.list.map((entry) => `
            <div class="st-phone-bubble ${entry.outgoing ? 'outgoing' : 'incoming'}">
                <button class="st-phone-bubble-menu-btn" type="button" data-message-menu="${escapeHtml(entry.id)}" title="Message options">...</button>
                <div>${escapeHtml(entry.text)}</div>
                <small>${escapeHtml(entry.from || '')} · ${escapeHtml(formatTime(entry.ts))}</small>
                <span class="st-phone-bubble-flags">${escapeHtml(outputModeLabel(entry.outputMode))} · ${escapeHtml(visibilityLabel(entry.visibility))}${entry.pinnedMemory ? ' · pinned' : ''}</span>
            </div>
        `).join('')
        : '<div class="st-phone-empty">No messages in this thread.</div>';
    threadNode.scrollTop = threadNode.scrollHeight;

    for (const input of win.querySelectorAll('[data-setting]')) {
        const key = input.getAttribute('data-setting');
        input.checked = !!bucket.settings[key];
    }
    for (const select of win.querySelectorAll('[data-setting-select]')) {
        const key = select.getAttribute('data-setting-select');
        select.value = bucket.settings[key] || defaultSettings[key] || '';
    }
    for (const input of win.querySelectorAll('[data-setting-number]')) {
        const key = input.getAttribute('data-setting-number');
        input.value = String(bucket.settings[key] ?? defaultSettings[key] ?? '');
    }
    for (const textarea of win.querySelectorAll('[data-setting-text]')) {
        const key = textarea.getAttribute('data-setting-text');
        if (textarea.value !== String(bucket.settings[key] || '')) {
            textarea.value = String(bucket.settings[key] || '');
        }
    }
    updateClock();
}

export function updateClock() {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    document.querySelectorAll('#st-phone-window .st-phone-clock, #st-phone-window .st-phone-lock-time')
        .forEach((node) => { node.textContent = time; });
    const dateNode = document.querySelector('#st-phone-window .st-phone-lock-date');
    if (dateNode) dateNode.textContent = date;
}

export function syncViewportPositions() {
    applyLauncherPosition();
    const win = document.getElementById('st-phone-window');
    if (!win || !win.classList.contains('st-phone-visible')) return;
    const pos = getWindowPosition();
    const clamped = applyElementPosition(win, pos);
    if (clamped && pos && (clamped.x !== pos.x || clamped.y !== pos.y)) {
        saveWindowPosition(clamped);
    }
}
