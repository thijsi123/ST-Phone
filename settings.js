// State and persistence layer. Two storage tiers, matching how built-in
// extensions do it:
//
//   extension_settings.st_phone  (global settings.json on the server)
//     -> settings, launcher position, window position. Loads on every page
//        in every chat; saved via saveSettingsDebounced like every other
//        extension. This is UI preference data - it must not be per-chat.
//
//   chat_metadata.st_phone  (per-chat, stored in the chat file header)
//     -> threads, messages, contacts, vector records, per-chat UI state
//        (open screen, selected thread). This is chat DATA.
//
// No DOM access here, no rendering - see ui.js for that, and phone.js for
// message/vector/generation behavior.

import { chat_metadata, saveSettings, saveSettingsDebounced } from '../../../../script.js';
import { cancelDebouncedMetadataSave, extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { saveMetadata } from '../../../../script.js';
import { nowId, uniqueNames, namesMatch, compactPreview, formatTime, escapeRegExp } from './utils.js';

export const METADATA_KEY = 'st_phone';
export const SETTINGS_KEY = 'st_phone';

export const defaultSettings = Object.freeze({
    enabled: true,
    injectPrompt: true,
    hidePhoneJson: true,
    openOnIncoming: false,
    showLauncher: true,
    defaultOutputMode: 'phone_only',
    defaultVisibility: 'participants',
    defaultMemoryMode: 'participants',
    stripReasoning: true,
    customReasoningPairs: '',
    vectorMemoryEnabled: false,
    vectorRecallCount: 2,
    vectorScoreThreshold: 0.4,
    vectorNearbyMessages: 6,
    recallInChat: false,
});

function isValidPosition(pos) {
    return Number.isFinite(pos?.x) && Number.isFinite(pos?.y);
}

// Global (cross-chat) bucket inside extension_settings, persisted to the
// server's settings.json — the same mechanism every other extension uses.
export function ensureGlobalSettings() {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }
    const global = extension_settings[SETTINGS_KEY];
    global.settings = { ...defaultSettings, ...(global.settings || {}) };
    if (!isValidPosition(global.launcherPosition)) global.launcherPosition = null;
    if (!isValidPosition(global.windowPosition)) global.windowPosition = null;
    return global;
}

export function migrateThreadShape(bucket) {
    bucket.threadMeta = bucket.threadMeta && typeof bucket.threadMeta === 'object' ? bucket.threadMeta : {};
    for (const [key, list] of Object.entries(bucket.threads || {})) {
        if (!Array.isArray(list)) {
            bucket.threads[key] = [];
            continue;
        }
        if (!bucket.threadMeta[key]) {
            const participants = uniqueNames([getUserName(), key]);
            bucket.threadMeta[key] = {
                id: key,
                title: key,
                type: 'direct',
                participants,
                createdAt: Date.now(),
            };
        }
        for (const message of list) {
            if (!message || typeof message !== 'object') continue;
            message.id ||= nowId();
            message.threadId ||= key;
            message.visibility ||= bucket.settings?.defaultVisibility || 'participants';
            message.visibleTo = Array.isArray(message.visibleTo) && message.visibleTo.length
                ? uniqueNames(message.visibleTo)
                : uniqueNames(bucket.threadMeta[key].participants || [message.from, message.to]);
            message.outputMode ||= message.publicInChat ? 'phone_chat' : (bucket.settings?.defaultOutputMode || 'phone_only');
            message.memoryMode ||= bucket.settings?.defaultMemoryMode || 'participants';
            message.memoryVisibleTo = Array.isArray(message.memoryVisibleTo)
                ? uniqueNames(message.memoryVisibleTo)
                : uniqueNames(message.visibleTo);
            message.pinnedMemory = !!message.pinnedMemory;
        }
    }
}

export function ensureState() {
    if (!chat_metadata[METADATA_KEY] || typeof chat_metadata[METADATA_KEY] !== 'object') {
        chat_metadata[METADATA_KEY] = {};
    }

    const bucket = chat_metadata[METADATA_KEY];
    // Settings live in the GLOBAL bucket (settings.json). bucket.settings is
    // a live reference to it so all existing `ensureState().settings.X`
    // reads/writes hit the global object. One-time migration: if this chat
    // still carries old per-chat settings, fold them into the global bucket.
    const global = ensureGlobalSettings();
    if (bucket.settings && typeof bucket.settings === 'object' && bucket.settings !== global.settings && !global.migratedFromChat) {
        global.settings = { ...global.settings, ...bucket.settings };
        global.migratedFromChat = true;
        saveSettingsDebounced();
    }
    bucket.settings = global.settings;
    bucket.threads = bucket.threads && typeof bucket.threads === 'object' ? bucket.threads : {};
    bucket.contacts = Array.isArray(bucket.contacts) ? bucket.contacts : [];
    bucket.vectorMemory = bucket.vectorMemory && typeof bucket.vectorMemory === 'object' ? bucket.vectorMemory : {};
    bucket.vectorMemory.records = bucket.vectorMemory.records && typeof bucket.vectorMemory.records === 'object'
        ? bucket.vectorMemory.records
        : {};
    bucket.ui = bucket.ui && typeof bucket.ui === 'object' ? bucket.ui : {};
    bucket.ui.screen = bucket.ui.screen || 'lock';
    bucket.ui.selectedContact = bucket.ui.selectedContact || '';
    bucket.ui.selectedThreadKey = bucket.ui.selectedThreadKey || bucket.ui.selectedContact || '';
    migrateThreadShape(bucket);
    return bucket;
}

// Debounced save of BOTH tiers. Chat data goes to the chat file, settings
// and positions go to settings.json.
export function saveState() {
    saveMetadataDebounced();
    saveSettingsDebounced();
}

// Immediate save for discrete actions (toggle, drag end) and for flushing
// when the tab goes to background. saveMetadata() is a no-op warning on the
// welcome screen (no chat file) - that's fine, settings still persist
// because they go through saveSettings() into settings.json.
export function flushSaveState() {
    cancelDebouncedMetadataSave();
    Promise.resolve(saveMetadata()).catch((error) => console.warn('[ST-Phone] Failed to save metadata', error));
    Promise.resolve(saveSettings()).catch((error) => console.warn('[ST-Phone] Failed to save settings', error));
}

export function getUserName() {
    try {
        return String(getContext()?.name1 || 'You').trim() || 'You';
    } catch {
        return 'You';
    }
}

export function getPrimaryCharacterName() {
    try {
        const context = getContext();
        if (context?.name2) return String(context.name2).trim();
        if (context?.characterId !== undefined && context.characters?.[context.characterId]) {
            return String(context.characters[context.characterId].name || '').trim();
        }
    } catch {
        // noop
    }
    return '';
}

export function discoveredContacts() {
    const context = getContext();
    const names = new Set();
    const primary = getPrimaryCharacterName();
    if (primary) names.add(primary);

    try {
        if (context?.groupId && Array.isArray(context.groups)) {
            const group = context.groups.find((entry) => String(entry.id) === String(context.groupId));
            const members = Array.isArray(group?.members) ? group.members : [];
            for (const avatar of members) {
                const character = context.characters?.find((entry) => entry?.avatar === avatar || entry?.name === avatar);
                if (character?.name) names.add(String(character.name).trim());
            }
        }
    } catch {
        // noop
    }

    for (const contact of ensureState().contacts) {
        if (contact?.name) names.add(String(contact.name).trim());
    }

    return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function threadKey(name) {
    const canonical = discoveredContacts().find((entry) => namesMatch(entry, name)) || String(name || '').trim();
    return canonical || 'Unknown';
}

export function getThreadMeta(key) {
    const bucket = ensureState();
    const resolved = String(key || '').trim() || threadKey(getPrimaryCharacterName() || 'Unknown');
    if (!bucket.threadMeta[resolved]) {
        bucket.threadMeta[resolved] = {
            id: resolved,
            title: resolved.replace(/^group:/, 'Group '),
            type: resolved.startsWith('group:') ? 'group' : 'direct',
            participants: uniqueNames([getUserName(), resolved.replace(/^group:/, '')]),
            createdAt: Date.now(),
        };
    }
    return bucket.threadMeta[resolved];
}

export function getThread(nameOrKey) {
    const raw = String(nameOrKey || '').trim();
    const key = raw.startsWith('group:') ? raw : threadKey(raw);
    const bucket = ensureState();
    if (!Array.isArray(bucket.threads[key])) bucket.threads[key] = [];
    getThreadMeta(key);
    return { key, list: bucket.threads[key] };
}

export function selectedThreadKey() {
    const bucket = ensureState();
    return bucket.ui.selectedThreadKey || bucket.ui.selectedContact || threadSummaries()[0]?.key || '';
}

export function createGroupThread(participants, title = '') {
    const bucket = ensureState();
    const selected = uniqueNames([getUserName(), ...participants]);
    if (selected.length < 2) return '';
    const key = `group:${nowId()}`;
    bucket.threads[key] = [];
    bucket.threadMeta[key] = {
        id: key,
        title: title.trim() || selected.filter((name) => !namesMatch(name, getUserName())).join(', '),
        type: 'group',
        participants: selected,
        createdAt: Date.now(),
    };
    bucket.ui.selectedThreadKey = key;
    bucket.ui.selectedContact = key;
    bucket.ui.screen = 'thread';
    saveState();
    return key;
}

export function customReasoningPairs() {
    return String(ensureState().settings.customReasoningPairs || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/^(.+?)\s*(?:=>|->|\|)\s*(.+)$/);
            return match ? { start: match[1].trim(), end: match[2].trim() } : null;
        })
        .filter((entry) => entry?.start && entry?.end);
}

export function stripPairedBlocks(text, pairs) {
    let output = String(text || '');
    for (const pair of pairs) {
        const pattern = new RegExp(`${escapeRegExp(pair.start)}[\\s\\S]*?${escapeRegExp(pair.end)}`, 'gi');
        output = output.replace(pattern, '');
    }
    return output;
}

export function stripKnownReasoning(text) {
    const bucket = ensureState();
    if (!bucket.settings.stripReasoning) return String(text || '');
    let output = String(text || '');
    output = output.replace(/<\|channel\>thought[\s\S]*?<channel\|>/gi, '');
    output = output.replace(/<think>[\s\S]*?<\/think>/gi, '');
    output = stripPairedBlocks(output, customReasoningPairs());
    return output.trim();
}

export function messageVisibleToNames(message, meta) {
    if (message.visibility === 'all') return uniqueNames([getUserName(), ...discoveredContacts()]);
    if (message.visibility === 'selected') return uniqueNames(message.visibleTo || []);
    return uniqueNames(meta?.participants || [message.from, message.to]);
}

// Positions are global (settings.json), not per-chat: where you put the
// button/window is a device-independent preference, same on every chat.

export function getWindowPosition() {
    return ensureGlobalSettings().windowPosition || null;
}

export function saveWindowPosition(position) {
    ensureGlobalSettings().windowPosition = { x: position.x, y: position.y };
    Promise.resolve(saveSettings()).catch((error) => console.warn('[ST-Phone] Failed to save settings', error));
}

export function getLauncherPosition() {
    return ensureGlobalSettings().launcherPosition || null;
}

export function saveLauncherPosition(position) {
    ensureGlobalSettings().launcherPosition = { x: position.x, y: position.y };
    Promise.resolve(saveSettings()).catch((error) => console.warn('[ST-Phone] Failed to save settings', error));
}

// Back to pure-CSS default placement for both elements.
export function resetPositions() {
    const global = ensureGlobalSettings();
    global.launcherPosition = null;
    global.windowPosition = null;
    Promise.resolve(saveSettings()).catch((error) => console.warn('[ST-Phone] Failed to save settings', error));
}

export function threadSummaries() {
    const bucket = ensureState();
    const names = new Set([...discoveredContacts().map(threadKey), ...Object.keys(bucket.threads)]);
    return [...names].filter(Boolean).map((key) => {
        const th = getThread(key);
        const meta = getThreadMeta(th.key);
        const last = th.list[th.list.length - 1];
        const unread = th.list.filter((entry) => !entry.outgoing && !entry.read).length;
        return {
            key: th.key,
            name: meta.title || th.key,
            type: meta.type || 'direct',
            participants: meta.participants || [],
            last,
            unread,
            preview: last ? compactPreview(last.text) : 'No messages yet',
            time: last ? formatTime(last.ts) : '',
        };
    }).sort((a, b) => Number(b.last?.ts || 0) - Number(a.last?.ts || 0) || a.name.localeCompare(b.name));
}
