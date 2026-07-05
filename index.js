import {
    Generate,
    chat,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_types,
    getCurrentChatId,
    getRequestHeaders,
    generateQuietPrompt,
    saveChatConditional,
    sendMessageAsUser,
    setExtensionPrompt,
    updateMessageBlock,
} from '../../../../script.js';
import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';
import { getStringHash } from '../../../utils.js';

const EXTENSION_NAME = 'ST-Phone';
const METADATA_KEY = 'st_phone';
const PROMPT_ID = 'st_phone_prompt';

const defaultSettings = Object.freeze({
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

let state = null;
let initialized = false;
let dragState = null;
let launcherDragState = null;
let activeMenuMessageId = null;
let activePickerMessageId = null;

function nowId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeName(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase();
}

function namesMatch(left, right) {
    const a = normalizeName(left);
    const b = normalizeName(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const aTokens = a.split(' ').filter(Boolean);
    const bTokens = b.split(' ').filter(Boolean);
    if (aTokens.length === 1 && bTokens.length === 1) return aTokens[0] === bTokens[0];
    return false;
}

function contactColor(name) {
    let hash = 0;
    for (const char of String(name || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 72% 68%)`;
}

function uniqueNames(names) {
    const out = [];
    for (const name of names.map((value) => String(value || '').trim()).filter(Boolean)) {
        if (!out.some((entry) => namesMatch(entry, name))) out.push(name);
    }
    return out;
}

function outputModeLabel(mode) {
    return {
        phone_only: 'Phone only',
        phone_chat: 'Phone + chat',
        narrated: 'Narrated in chat',
    }[mode] || 'Phone only';
}

function visibilityLabel(mode) {
    return {
        participants: 'Participants',
        all: 'Everyone',
        selected: 'Selected',
    }[mode] || 'Participants';
}

function memoryModeLabel(mode) {
    return {
        none: 'No memory pin',
        participants: 'Participants remember',
        selected: 'Selected remember',
        all: 'Everyone remembers',
    }[mode] || 'Participants remember';
}

function migrateThreadShape(bucket) {
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

function ensureState() {
    if (!chat_metadata[METADATA_KEY] || typeof chat_metadata[METADATA_KEY] !== 'object') {
        chat_metadata[METADATA_KEY] = {};
    }

    const bucket = chat_metadata[METADATA_KEY];
    bucket.settings = { ...defaultSettings, ...(bucket.settings || {}) };
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
    bucket.ui.position = bucket.ui.position && typeof bucket.ui.position === 'object'
        ? bucket.ui.position
        : { x: null, y: null };
    bucket.ui.launcherPosition = bucket.ui.launcherPosition && typeof bucket.ui.launcherPosition === 'object'
        ? bucket.ui.launcherPosition
        : { x: null, y: null };
    migrateThreadShape(bucket);
    state = bucket;
    return bucket;
}

function saveState() {
    saveMetadataDebounced();
}

function getUserName() {
    try {
        return String(getContext()?.name1 || 'You').trim() || 'You';
    } catch {
        return 'You';
    }
}

function getPrimaryCharacterName() {
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

function discoveredContacts() {
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

function threadKey(name) {
    const canonical = discoveredContacts().find((entry) => namesMatch(entry, name)) || String(name || '').trim();
    return canonical || 'Unknown';
}

function getThreadMeta(key) {
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

function getThread(nameOrKey) {
    const raw = String(nameOrKey || '').trim();
    const key = raw.startsWith('group:') ? raw : threadKey(raw);
    const bucket = ensureState();
    if (!Array.isArray(bucket.threads[key])) bucket.threads[key] = [];
    getThreadMeta(key);
    return { key, list: bucket.threads[key] };
}

function selectedThreadKey() {
    const bucket = ensureState();
    return bucket.ui.selectedThreadKey || bucket.ui.selectedContact || threadSummaries()[0]?.key || '';
}

function createGroupThread(participants, title = '') {
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

function formatTime(ts) {
    const date = new Date(Number(ts) || Date.now());
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function compactPreview(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function customReasoningPairs() {
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

function stripPairedBlocks(text, pairs) {
    let output = String(text || '');
    for (const pair of pairs) {
        const pattern = new RegExp(`${escapeRegExp(pair.start)}[\\s\\S]*?${escapeRegExp(pair.end)}`, 'gi');
        output = output.replace(pattern, '');
    }
    return output;
}

function stripKnownReasoning(text) {
    const bucket = ensureState();
    if (!bucket.settings.stripReasoning) return String(text || '');
    let output = String(text || '');
    output = output.replace(/<\|channel\>thought[\s\S]*?<channel\|>/gi, '');
    output = output.replace(/<think>[\s\S]*?<\/think>/gi, '');
    output = stripPairedBlocks(output, customReasoningPairs());
    return output.trim();
}

function messageVisibleToNames(message, meta) {
    if (message.visibility === 'all') return uniqueNames([getUserName(), ...discoveredContacts()]);
    if (message.visibility === 'selected') return uniqueNames(message.visibleTo || []);
    return uniqueNames(meta?.participants || [message.from, message.to]);
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function vectorSettings() {
    return extension_settings?.vectors || {};
}

function koboldEmbeddingServer() {
    const vectors = vectorSettings();
    if (vectors.use_alt_endpoint && vectors.alt_endpoint_url) return vectors.alt_endpoint_url;
    return textgenerationwebui_settings?.server_urls?.[textgen_types.KOBOLDCPP] || '';
}

function phoneVectorCollectionId() {
    const chatId = getCurrentChatId?.() || 'unknown-chat';
    return `st_phone_${Math.abs(getStringHash(String(chatId)))}`;
}

// ST-Memory integration: the ST-Memory extension owns plugin detection,
// chat keys, and transport. ST-Phone only hands events over, lazily, so
// extension load order does not matter and absence is a silent no-op.
function memoryApi() {
    return globalThis.STMemory || null;
}

function updateMemoryStatus() {
    const node = document.querySelector('#st-phone-window [data-role="memory-plugin-status"]');
    if (!node) return;
    const memory = memoryApi();
    node.textContent = !memory
        ? 'ST-Memory: extension not installed'
        : `ST-Memory: ${memory.isAvailable() ? 'plugin detected' : 'plugin not detected'}`;
}

function mirrorEventToPlugin(message, meta, extra = {}) {
    const memory = memoryApi();
    if (!memory?.isAvailable() || !message) return;
    const event = {
        kind: 'phone_message',
        message,
        threadTitle: meta?.title || message.threadId || '',
        participants: meta?.participants || [],
        ...extra,
    };
    Promise.resolve(memory.appendEvent(event))
        .catch((error) => console.warn('[ST-Phone] Failed to mirror event to ST-Memory', error));
}

const PROMPT_RECALL_ID = 'st_phone_recall';

// Generation interceptor (registered in manifest.json). Before each normal
// chat generation, retrieves phone memories the CURRENT speaker is allowed
// to know and injects them as a compact block. Quiet generations are skipped:
// the phone-only reply path does its own recall.
globalThis.stPhoneMemoryInterceptor = async function (chatArray, _contextSize, _abort, type) {
    try {
        const bucket = ensureState();
        const memory = memoryApi();
        const active = bucket.settings.enabled
            && bucket.settings.vectorMemoryEnabled
            && bucket.settings.recallInChat
            && memory?.isAvailable()
            && memory.hasEmbeddingServer()
            && type !== 'quiet';

        if (!active) {
            setExtensionPrompt(PROMPT_RECALL_ID, '', extension_prompt_types.IN_PROMPT, 1, true, 'system');
            return;
        }

        const speaker = getPrimaryCharacterName();
        const recent = (Array.isArray(chatArray) ? chatArray : chat).slice(-6)
            .map((message) => `${message.name || ''}: ${String(message.mes || '').replace(/\s+/g, ' ').trim()}`)
            .filter((line) => line.length > 2)
            .join('\n')
            .slice(0, 2500);
        if (!recent) {
            setExtensionPrompt(PROMPT_RECALL_ID, '', extension_prompt_types.IN_PROMPT, 1, true, 'system');
            return;
        }

        const topK = clampNumber(bucket.settings.vectorRecallCount, 0, 8, 2);
        const threshold = clampNumber(bucket.settings.vectorScoreThreshold, 0, 1, 0.55);
        const { block } = await memory.recall({
            query: recent,
            speaker,
            topK,
            threshold,
            budgetChars: 1200,
        });

        const prompt = block
            ? [
                `[Private memories known to ${speaker || 'the current speaker'} (phone messages and related events; other characters do not know these unless stated):`,
                block,
                ']',
            ].join('\n')
            : '';
        setExtensionPrompt(PROMPT_RECALL_ID, prompt, extension_prompt_types.IN_PROMPT, 1, true, 'system');
    } catch (error) {
        console.warn('[ST-Phone] Memory recall interceptor failed', error);
        setExtensionPrompt(PROMPT_RECALL_ID, '', extension_prompt_types.IN_PROMPT, 1, true, 'system');
    }
};

function chatVectorCollectionId() {
    return getCurrentChatId?.() || '';
}

async function createKoboldEmbeddings(items) {
    const server = koboldEmbeddingServer();
    if (!server) throw new Error('KoboldCpp URL is not configured for embeddings.');
    const response = await fetch('/api/backends/kobold/embed', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ items, server }),
    });
    if (!response.ok) throw new Error('Failed to get KoboldCpp embeddings.');
    const data = await response.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== items.length || !data.model) {
        throw new Error('Invalid KoboldCpp embedding response.');
    }
    const embeddings = {};
    for (let i = 0; i < items.length; i += 1) embeddings[items[i]] = data.embeddings[i];
    return { embeddings, model: data.model };
}

async function vectorInsertItems(collectionId, items) {
    if (!items.length) return;
    const args = await createKoboldEmbeddings(items.map((item) => item.text));
    const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            collectionId,
            items,
            source: 'koboldcpp',
            ...args,
        }),
    });
    if (!response.ok) throw new Error(`Failed to insert ST-Phone vectors into ${collectionId}.`);
}

async function vectorQueryCollection(collectionId, searchText, topK, threshold) {
    if (!collectionId || !searchText?.trim()) return { hashes: [], metadata: [] };
    const args = await createKoboldEmbeddings([searchText]);
    const response = await fetch('/api/vector/query', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            collectionId,
            searchText,
            topK,
            threshold,
            source: 'koboldcpp',
            ...args,
        }),
    });
    if (!response.ok) throw new Error(`Failed to query vector collection ${collectionId}.`);
    return response.json();
}

function chatContextNear(index = null, radius = null) {
    const bucket = ensureState();
    const count = clampNumber(radius ?? bucket.settings.vectorNearbyMessages, 0, 24, 6);
    if (!count) return '';
    const lastIndex = Math.max(0, chat.length - 1);
    const center = Number.isInteger(index) ? Math.max(0, Math.min(lastIndex, index)) : lastIndex;
    const start = Math.max(0, center - count);
    const end = Math.min(chat.length, center + count + 1);
    return chat.slice(start, end)
        .map((message, offset) => {
            const actual = start + offset;
            const name = message.name || (message.is_user ? getUserName() : 'Character');
            const text = String(message.mes || '').replace(/\s+/g, ' ').trim();
            return text ? `#${actual} ${name}: ${text}` : '';
        })
        .filter(Boolean)
        .join('\n')
        .slice(0, 3500);
}

function vectorTextForPhoneMessage(message, meta, nearbyContext = '') {
    const recipients = Array.isArray(message.to) ? message.to.join(', ') : message.to;
    return [
        `Phone thread: ${meta?.title || message.threadId || 'Unknown'}`,
        `Participants: ${uniqueNames(meta?.participants || [message.from, recipients]).join(', ')}`,
        `Phone message: ${message.from} -> ${recipients}: ${message.text}`,
        nearbyContext ? `Nearby RP context when sent:\n${nearbyContext}` : '',
    ].filter(Boolean).join('\n');
}

async function indexPhoneMessageVector(message, meta, nearbyIndex = null) {
    const bucket = ensureState();
    if (!bucket.settings.vectorMemoryEnabled || !message?.id || !message?.text) return;
    const nearbyContext = chatContextNear(nearbyIndex);
    const text = vectorTextForPhoneMessage(message, meta, nearbyContext);

    // Preferred path: ST-Memory's server-side index with visibility metadata.
    const memory = memoryApi();
    if (memory?.isAvailable() && memory.hasEmbeddingServer()) {
        const indexed = await memory.indexItems([{
            id: message.id,
            text,
            metadata: {
                kind: 'phone',
                threadId: message.threadId,
                threadTitle: meta?.title || message.threadId || '',
                ts: message.ts || Date.now(),
                pinned: !!message.pinnedMemory,
                visibility: message.visibility,
                visibleTo: messageVisibleToNames(message, meta),
                memoryVisibleTo: uniqueNames(message.memoryVisibleTo || []),
            },
        }]);
        if (indexed) return;
    }

    // Legacy fallback: client-computed embeddings into SillyTavern's vector API.
    const hash = getStringHash(`${message.id}:${text}`);
    bucket.vectorMemory.records[String(hash)] = {
        hash,
        messageId: message.id,
        threadId: message.threadId,
        title: meta?.title || message.threadId || '',
        text,
        visibleTo: messageVisibleToNames(message, meta),
        ts: message.ts || Date.now(),
    };
    saveState();
    await vectorInsertItems(phoneVectorCollectionId(), [{ hash, text, index: Number(message.ts || Date.now()) }]);
}

function canSeeVectorRecord(record, participants) {
    const visibleTo = uniqueNames(record?.visibleTo || []);
    if (!visibleTo.length) return true;
    return participants.some((name) => visibleTo.some((visible) => namesMatch(visible, name)));
}

async function buildVectorRecallBlock(threadId, sentMessage, participants) {
    const bucket = ensureState();
    if (!bucket.settings.vectorMemoryEnabled) return '';
    const topK = clampNumber(bucket.settings.vectorRecallCount, 0, 8, 2);
    if (!topK) return '';
    const threshold = clampNumber(bucket.settings.vectorScoreThreshold, 0, 1, 0.55);
    const thread = getThread(threadId).list.slice(-8).map((message) => `${message.from}: ${message.text}`).join('\n');
    const searchText = [
        `Thread: ${getThreadMeta(threadId).title}`,
        `Participants: ${participants.join(', ')}`,
        `Latest phone message: ${sentMessage.from}: ${sentMessage.text}`,
        thread,
    ].filter(Boolean).join('\n');

    // Preferred path: server-side recall, visibility-filtered inside the query.
    const memory = memoryApi();
    if (memory?.isAvailable() && memory.hasEmbeddingServer()) {
        try {
            const { block } = await memory.recall({
                query: searchText,
                participants,
                excludeIds: [sentMessage.id],
                topK,
                threshold,
                budgetChars: 1600,
            });
            if (!block) return '';
            return [
                'Relevant older memories for this phone conversation (do not repeat verbatim):',
                block,
            ].join('\n');
        } catch (error) {
            console.warn('[ST-Phone] ST-Memory recall failed, falling back to legacy vectors', error);
        }
    }

    const lines = [];
    try {
        const phoneResults = await vectorQueryCollection(phoneVectorCollectionId(), searchText, topK + 2, threshold);
        for (const metadata of phoneResults.metadata || []) {
            const record = bucket.vectorMemory.records[String(metadata.hash)];
            if (!record || record.messageId === sentMessage.id || !canSeeVectorRecord(record, participants)) continue;
            lines.push(`- Related phone/RP memory from ${new Date(record.ts).toLocaleString()}: ${record.text}`);
            if (lines.length >= topK) break;
        }
    } catch (error) {
        console.warn('[ST-Phone] Phone vector recall failed', error);
    }

    const chatCollection = chatVectorCollectionId();
    if (chatCollection && lines.length < topK) {
        try {
            const chatResults = await vectorQueryCollection(chatCollection, searchText, topK - lines.length, threshold);
            for (const metadata of chatResults.metadata || []) {
                if (metadata?.text) lines.push(`- Related visible RP event: ${metadata.text}`);
            }
        } catch (error) {
            console.debug('[ST-Phone] Chat vector recall unavailable', error);
        }
    }

    if (!lines.length) return '';
    return [
        'Related long-term phone/RP memory:',
        ...lines.slice(0, topK),
        'Use this only if it is relevant and visible to the current phone participants.',
    ].join('\n');
}

function buildPhoneContextBlock() {
    const bucket = ensureState();
    const lines = [];
    for (const [key, list] of Object.entries(bucket.threads)) {
        if (!Array.isArray(list) || !list.length) continue;
        const meta = getThreadMeta(key);
        const recent = list.slice(-12);
        for (const message of recent) {
            if (!message?.text) continue;
            const visibleTo = messageVisibleToNames(message, meta);
            const pin = message.pinnedMemory ? ' pinned' : '';
            lines.push(`- [${meta.title || key}${pin}; visible to: ${visibleTo.join(', ')}] ${message.from} -> ${Array.isArray(message.to) ? message.to.join(', ') : message.to}: ${message.text}`);
        }
    }
    if (!lines.length) return '';
    return [
        '[ST PHONE CONTEXT]',
        'Phone messages below may be private. Characters should only know a message if they are listed in "visible to" or if the normal visible chat already revealed it.',
        ...lines.slice(-40),
        '[/ST PHONE CONTEXT]',
    ].join('\n');
}

function setPrompt() {
    const bucket = ensureState();
    if (!bucket.settings.enabled || !bucket.settings.injectPrompt) {
        setExtensionPrompt(PROMPT_ID, '', extension_prompt_types.IN_PROMPT, 0, true, 'system');
        return;
    }

    const userName = getUserName();
    const contacts = discoveredContacts().join(', ') || 'current characters';
    const prompt = [
        '[ST PHONE]',
        `The user has an in-character phone UI. User/persona name: ${userName}. Known phone contacts: ${contacts}.`,
        'When the story includes a text/SMS/phone message that should appear on the phone, include a compact JSON object in your response.',
        'Use this exact shape and no extra keys:',
        '{"phoneMessages":[{"from":"Character Name","to":"Recipient Name or Group Title","message":"Text message body"}]}',
        'For phone group chats, "to" may be a group thread title if obvious.',
        'Keep phone message bodies natural and concise. Do not put narration inside message bodies.',
        'You may still write normal prose around the JSON when needed.',
        'Only include phoneMessages when a phone message actually happens.',
        buildPhoneContextBlock(),
        '[/ST PHONE]',
    ].filter(Boolean).join('\n');
    setExtensionPrompt(PROMPT_ID, prompt, extension_prompt_types.IN_PROMPT, 0, true, 'system');
}

function buildUi() {
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

function showWindow(open = true) {
    const win = document.getElementById('st-phone-window');
    const launcher = document.getElementById('st-phone-launcher');
    if (!win) return;
    win.classList.toggle('st-phone-visible', open);
    launcher?.classList.toggle('st-phone-launcher-open', open);
    const label = launcher?.querySelector('.st-phone-launcher-label');
    if (label) label.textContent = open ? 'Close' : 'Phone';
    if (launcher) launcher.title = open ? 'Close ST Phone' : 'Open ST Phone';
    if (open) {
        const pos = ensureState().ui.position;
        if (Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
            const rect = win.getBoundingClientRect();
            const nextX = Math.max(4, Math.min(window.innerWidth - Math.min(rect.width, 48), pos.x));
            const nextY = Math.max(4, Math.min(window.innerHeight - 48, pos.y));
            win.style.left = `${nextX}px`;
            win.style.top = `${nextY}px`;
            win.style.right = 'auto';
            if (nextX !== pos.x || nextY !== pos.y) {
                ensureState().ui.position = { x: nextX, y: nextY };
                saveState();
            }
        }
        updateClock();
        render();
    }
}

function setScreen(screen) {
    const bucket = ensureState();
    bucket.ui.screen = screen;
    saveState();
    render();
}

function openView(view) {
    ensureState().ui.screen = view;
    saveState();
    render();
}

function openThread(name) {
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

function messageById(messageId) {
    const bucket = ensureState();
    for (const [threadId, list] of Object.entries(bucket.threads)) {
        if (!Array.isArray(list)) continue;
        const message = list.find((entry) => String(entry?.id) === String(messageId));
        if (message) return { message, threadId, list, meta: getThreadMeta(threadId) };
    }
    return null;
}

function openPicker(messageId) {
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

function closePicker() {
    activePickerMessageId = null;
    document.querySelector('#st-phone-window [data-role="picker"]')?.classList.remove('active');
}

function selectedPickerNames() {
    return [...document.querySelectorAll('#st-phone-window [data-role="picker-list"] input:checked')]
        .map((input) => input.value)
        .filter(Boolean);
}

function openMessageMenu(messageId, anchor) {
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

function closeMessageMenu() {
    activeMenuMessageId = null;
    document.querySelector('#st-phone-window [data-role="message-menu"]')?.classList.remove('active');
}

function bindUi() {
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
        ensureState().ui.launcherPosition = { x: rect.left, y: rect.top };
        saveState();
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
        const setting = event.target?.getAttribute?.('data-setting');
        if (setting) {
            ensureState().settings[setting] = !!event.target.checked;
            saveState();
            setPrompt();
        }
        const selectSetting = event.target?.getAttribute?.('data-setting-select');
        if (selectSetting) {
            ensureState().settings[selectSetting] = String(event.target.value || '');
            saveState();
            setPrompt();
        }
        const numberSetting = event.target?.getAttribute?.('data-setting-number');
        if (numberSetting) {
            ensureState().settings[numberSetting] = Number(event.target.value);
            saveState();
            setPrompt();
        }
        const textSetting = event.target?.getAttribute?.('data-setting-text');
        if (textSetting) {
            ensureState().settings[textSetting] = String(event.target.value || '');
            saveState();
        }
        if (event.target?.matches?.('[data-role="draft"]')) {
            event.target.style.height = '0px';
            event.target.style.height = `${Math.min(112, event.target.scrollHeight || 42)}px`;
        }
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
    });
    status.addEventListener('pointerup', () => {
        if (!dragState) return;
        dragState = null;
        const rect = win.getBoundingClientRect();
        ensureState().ui.position = { x: rect.left, y: rect.top };
        saveState();
    });
}

async function handleMenuAction(action) {
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

function applyPicker(mode) {
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

async function publishPhoneMessageToChat(message, meta, narrated) {
    if (message.chatPublishedAt && message.chatPublishedMode === (narrated ? 'narrated' : 'phone_chat')) return;
    const recipients = Array.isArray(message.to) ? message.to.join(', ') : message.to;
    const text = narrated
        ? `${message.from} sends a phone message to ${recipients || meta.title}.`
        : `${message.from} texts ${recipients || meta.title}: ${message.text}`;
    try {
        await sendMessageAsUser(text);
        message.chatPublishedAt = Date.now();
        message.chatPublishedMode = narrated ? 'narrated' : 'phone_chat';
    } catch (error) {
        console.warn('[ST-Phone] Failed to publish phone message to chat', error);
    }
}

async function sendCurrentDraft() {
    const bucket = ensureState();
    const contact = selectedThreadKey() || discoveredContacts()[0] || getPrimaryCharacterName();
    const textarea = document.querySelector('#st-phone-window [data-role="draft"]');
    const text = String(textarea?.value || '').trim();
    if (!contact || !text) return;

    const th = getThread(contact);
    const meta = getThreadMeta(th.key);
    const recipients = meta.type === 'group'
        ? uniqueNames((meta.participants || []).filter((name) => !namesMatch(name, getUserName())))
        : [meta.title || th.key];
    const message = {
        id: nowId(),
        from: getUserName(),
        to: recipients,
        text,
        ts: Date.now(),
        outgoing: true,
        read: true,
        threadId: th.key,
        visibility: bucket.settings.defaultVisibility || 'participants',
        visibleTo: bucket.settings.defaultVisibility === 'all'
            ? uniqueNames([getUserName(), ...discoveredContacts()])
            : uniqueNames(meta.participants || [getUserName(), ...recipients]),
        outputMode: bucket.settings.defaultOutputMode || 'phone_only',
        memoryMode: bucket.settings.defaultMemoryMode || 'participants',
        memoryVisibleTo: uniqueNames(meta.participants || [getUserName(), ...recipients]),
        pinnedMemory: bucket.settings.defaultMemoryMode !== 'none',
    };
    th.list.push(message);
    textarea.value = '';
    saveState();
    render();
    indexPhoneMessageVector(message, meta).catch((error) => console.warn('[ST-Phone] Failed to index outgoing phone message', error));
    mirrorEventToPlugin(message, meta, { direction: 'outgoing' });

    try {
        if (message.outputMode === 'phone_chat' || message.outputMode === 'narrated') {
            await publishPhoneMessageToChat(message, meta, message.outputMode === 'narrated');
            await Generate('normal');
        } else {
            await generatePhoneOnlyReply(th.key, message);
        }
    } catch (error) {
        console.error('[ST-Phone] Failed to send through SillyTavern', error);
        toastr?.error?.('Failed to send phone message through SillyTavern.', 'ST Phone');
    }
}

function recentChatContext(max = 8) {
    try {
        return chat.slice(-max)
            .map((message) => `${message.name || (message.is_user ? getUserName() : 'Character')}: ${String(message.mes || '').replace(/\s+/g, ' ').trim()}`)
            .filter((line) => line.trim().length > 2)
            .join('\n')
            .slice(0, 3000);
    } catch {
        return '';
    }
}

async function generatePhoneOnlyReply(threadId, sentMessage) {
    const meta = getThreadMeta(threadId);
    const participants = uniqueNames(meta.participants || []);
    const possibleResponders = participants.filter((name) => !namesMatch(name, getUserName()));
    if (!possibleResponders.length) return;
    const thread = getThread(threadId).list.slice(-14)
        .map((message) => `${message.from}: ${message.text}`)
        .join('\n');
    const vectorRecall = await buildVectorRecallBlock(threadId, sentMessage, participants);
    const prompt = [
        'You are resolving a private in-character phone text exchange for SillyTavern.',
        'Return ONLY the final compact JSON object. No markdown, no prose, no analysis, no reasoning trace, no channel tags.',
        'If nobody would reply, return {"phoneMessages":[]}.',
        '{"phoneMessages":[{"from":"Responder Name","to":"Recipient Name or Group Title","message":"Text message body"}]}',
        `Thread title: ${meta.title}`,
        `Participants: ${participants.join(', ')}`,
        `Likely responders: ${possibleResponders.join(', ')}`,
        `Latest outgoing text from ${sentMessage.from}: ${sentMessage.text}`,
        recentChatContext() ? `Recent visible RP context:\n${recentChatContext()}` : '',
        vectorRecall,
        `Phone thread so far:\n${thread}`,
    ].filter(Boolean).join('\n\n');

    const response = await generateQuietPrompt({
        quietPrompt: prompt,
        skipWIAN: false,
        responseLength: 1000,
        removeReasoning: true,
    });
    const { messages } = parseEmbeddedPhoneMessages(String(response || ''));
    if (!messages.length) return;
    const stored = storeParsedPhoneMessages(messages, undefined, threadId);
    for (const entry of stored) {
        indexPhoneMessageVector(entry.message, entry.meta).catch((error) => console.warn('[ST-Phone] Failed to index generated phone reply', error));
        mirrorEventToPlugin(entry.message, entry.meta, { direction: 'incoming', generated: true });
    }
    saveState();
    setPrompt();
    render();
}

function parseJsonObjectRanges(text) {
    const ranges = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                ranges.push({ start, end: i + 1 });
                start = -1;
            }
            if (depth < 0) {
                depth = 0;
                start = -1;
            }
        }
    }
    return ranges;
}

function expandFenceRange(text, range) {
    let start = range.start;
    let end = range.end;
    const before = text.slice(0, start);
    const opening = before.match(/(?:^|\n)[ \t]*```(?:json)?[ \t]*\n?[ \t]*$/i);
    if (opening?.index !== undefined) start = opening.index;
    const after = text.slice(end);
    const closing = after.match(/^[ \t]*\n?[ \t]*```[ \t]*(?=\n|$)/);
    if (closing) end += closing[0].length;
    return { start, end };
}

function parseEmbeddedPhoneMessages(text) {
    text = stripKnownReasoning(text);
    const parsed = [];
    const removeRanges = [];
    for (const range of parseJsonObjectRanges(text)) {
        const source = text.slice(range.start, range.end);
        try {
            const value = JSON.parse(source);
            if (!Array.isArray(value?.phoneMessages)) continue;
            const messages = value.phoneMessages
                .map((entry) => ({
                    from: String(entry?.from || '').trim(),
                    to: String(entry?.to || '').trim(),
                    text: String(entry?.message || entry?.text || '').trim(),
                }))
                .filter((entry) => entry.from && entry.to && entry.text);
            if (messages.length) {
                parsed.push(...messages);
                removeRanges.push(expandFenceRange(text, range));
            }
        } catch {
            // Ignore prose JSON-looking fragments.
        }
    }
    return { messages: parsed, removeRanges };
}

function resolveThreadForParsedMessage(item, forcedThreadId) {
    if (forcedThreadId) return forcedThreadId;
    const bucket = ensureState();
    const to = String(item.to || '').trim();
    const from = String(item.from || '').trim();
    for (const [key, meta] of Object.entries(bucket.threadMeta || {})) {
        if (meta?.type === 'group' && (namesMatch(meta.title, to) || (meta.participants || []).some((name) => namesMatch(name, to)))) {
            return key;
        }
    }
    return namesMatch(from, getUserName()) ? threadKey(to) : threadKey(from);
}

function storeParsedPhoneMessages(messages, sourceMessageId, forcedThreadId) {
    const userName = getUserName();
    const bucket = ensureState();
    const stored = [];
    for (const item of messages) {
        const threadId = resolveThreadForParsedMessage(item, forcedThreadId);
        const th = getThread(threadId);
        const meta = getThreadMeta(th.key);
        const outgoing = namesMatch(item.from, userName);
        const participants = uniqueNames(meta.participants || [item.from, item.to, userName]);
        meta.participants = participants;
        const phoneMessage = {
            id: nowId(),
            from: item.from,
            to: item.to,
            text: item.text,
            ts: Date.now(),
            outgoing,
            sourceMessageId,
            read: bucket.ui.screen === 'thread' && bucket.ui.selectedThreadKey === th.key,
            threadId: th.key,
            visibility: bucket.settings.defaultVisibility || 'participants',
            visibleTo: bucket.settings.defaultVisibility === 'all'
                ? uniqueNames([getUserName(), ...discoveredContacts()])
                : participants,
            outputMode: 'phone_only',
            memoryMode: bucket.settings.defaultMemoryMode || 'participants',
            memoryVisibleTo: participants,
            pinnedMemory: bucket.settings.defaultMemoryMode !== 'none',
        };
        th.list.push(phoneMessage);
        stored.push({ message: phoneMessage, meta, sourceMessageId });
    }
    return stored;
}

async function handleRenderedMessage(messageId) {
    const message = chat?.[messageId];
    if (!message || message.is_user || !message.mes) return;
    const { messages, removeRanges } = parseEmbeddedPhoneMessages(message.mes);
    if (!messages.length) return;

    const bucket = ensureState();
    const stored = storeParsedPhoneMessages(messages, messageId);
    for (const entry of stored) {
        indexPhoneMessageVector(entry.message, entry.meta, messageId).catch((error) => console.warn('[ST-Phone] Failed to index parsed phone message', error));
        mirrorEventToPlugin(entry.message, entry.meta, { sourceMessageId: messageId });
    }

    if (bucket.settings.hidePhoneJson && removeRanges.length) {
        const cleaned = removeRanges
            .sort((a, b) => b.start - a.start)
            .reduce((current, range) => `${current.slice(0, range.start)}${current.slice(range.end)}`, message.mes)
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        message.mes = cleaned || message.mes;
        try {
            updateMessageBlock(messageId, message);
            await saveChatConditional();
        } catch (error) {
            console.warn('[ST-Phone] Failed to update visible message after phone JSON extraction', error);
        }
    }

    saveState();
    setPrompt();
    if (bucket.settings.openOnIncoming) showWindow(true);
    render();
}

function threadSummaries() {
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

function renderContactButton(summary, active = false) {
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

function clampLauncherPosition(position) {
    const launcher = document.getElementById('st-phone-launcher');
    if (!launcher || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
    const rect = launcher.getBoundingClientRect();
    const width = Math.max(rect.width, 48);
    const height = Math.max(rect.height, 44);
    return {
        x: Math.max(4, Math.min(window.innerWidth - width - 4, position.x)),
        y: Math.max(4, Math.min(window.innerHeight - height - 4, position.y)),
    };
}

function applyLauncherPosition() {
    const launcher = document.getElementById('st-phone-launcher');
    if (!launcher) return;
    const bucket = ensureState();
    if (!Number.isFinite(bucket.ui.launcherPosition?.x) || !Number.isFinite(bucket.ui.launcherPosition?.y)) {
        if (window.matchMedia?.('(max-width: 640px)').matches) {
            const rect = launcher.getBoundingClientRect();
            bucket.ui.launcherPosition = {
                x: Math.max(4, Math.round((window.innerWidth - Math.max(rect.width, 88)) / 2)),
                y: Math.max(4, Math.round((window.innerHeight - Math.max(rect.height, 46)) / 2)),
            };
            saveState();
        } else {
            return;
        }
    }
    const clamped = clampLauncherPosition(bucket.ui.launcherPosition);
    if (!clamped) return;
    launcher.style.left = `${clamped.x}px`;
    launcher.style.top = `${clamped.y}px`;
    launcher.style.right = 'auto';
    launcher.style.bottom = 'auto';
    if (clamped.x !== bucket.ui.launcherPosition.x || clamped.y !== bucket.ui.launcherPosition.y) {
        bucket.ui.launcherPosition = clamped;
        saveState();
    }
}

function render() {
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

function updateClock() {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    document.querySelectorAll('#st-phone-window .st-phone-clock, #st-phone-window .st-phone-lock-time')
        .forEach((node) => { node.textContent = time; });
    const dateNode = document.querySelector('#st-phone-window .st-phone-lock-date');
    if (dateNode) dateNode.textContent = date;
}

function syncViewportPositions() {
    applyLauncherPosition();
    const win = document.getElementById('st-phone-window');
    const bucket = ensureState();
    const pos = bucket.ui.position;
    if (!win || !Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return;
    const rect = win.getBoundingClientRect();
    const nextX = Math.max(4, Math.min(window.innerWidth - Math.min(rect.width, 48), pos.x));
    const nextY = Math.max(4, Math.min(window.innerHeight - 48, pos.y));
    win.style.left = `${nextX}px`;
    win.style.top = `${nextY}px`;
    win.style.right = 'auto';
    if (nextX !== pos.x || nextY !== pos.y) {
        bucket.ui.position = { x: nextX, y: nextY };
        saveState();
    }
}

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
    updateMemoryStatus();
    eventSource.on('st_memory_status', updateMemoryStatus);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleRenderedMessage);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        ensureState();
        setPrompt();
        render();
        updateMemoryStatus();
    });
}

eventSource.once(event_types.APP_READY, init);
