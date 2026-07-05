// Core phone behavior: prompt injection, embedded-JSON parsing, thread
// message storage, ST-Memory vector indexing/recall, and the normal-chat
// memory-recall generation interceptor. No DOM access (see ui.js).

import {
    Generate,
    chat,
    extension_prompt_types,
    getCurrentChatId,
    getRequestHeaders,
    generateQuietPrompt,
    saveChatConditional,
    sendMessageAsUser,
    setExtensionPrompt,
    updateMessageBlock,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { textgen_types, textgenerationwebui_settings } from '../../../textgen-settings.js';
import { getStringHash } from '../../../utils.js';
import {
    ensureState, saveState, getUserName, getPrimaryCharacterName, getThread, getThreadMeta,
    threadKey, discoveredContacts, stripKnownReasoning, messageVisibleToNames, selectedThreadKey,
} from './settings.js';
import { nowId, uniqueNames, namesMatch, clampNumber } from './utils.js';
// Circular import: ui.js also imports from phone.js. Safe here because
// render()/showWindow() are only invoked from inside later function calls,
// never at module-evaluation time.
import { render, showWindow } from './ui.js';

export const PROMPT_ID = 'st_phone_prompt';
export const PROMPT_RECALL_ID = 'st_phone_recall';

export function vectorSettings() {
    return extension_settings?.vectors || {};
}

export function koboldEmbeddingServer() {
    const vectors = vectorSettings();
    if (vectors.use_alt_endpoint && vectors.alt_endpoint_url) return vectors.alt_endpoint_url;
    return textgenerationwebui_settings?.server_urls?.[textgen_types.KOBOLDCPP] || '';
}

export function phoneVectorCollectionId() {
    const chatId = getCurrentChatId?.() || 'unknown-chat';
    return `st_phone_${Math.abs(getStringHash(String(chatId)))}`;
}

export function memoryApi() {
    return globalThis.STMemory || null;
}

export function mirrorEventToPlugin(message, meta, extra = {}) {
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

// Registered by name via manifest.json's generate_interceptor. Must stay on
// globalThis because SillyTavern looks it up dynamically by that name.
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

export function chatVectorCollectionId() {
    return getCurrentChatId?.() || '';
}

export async function createKoboldEmbeddings(items) {
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

export async function vectorInsertItems(collectionId, items) {
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

export async function vectorQueryCollection(collectionId, searchText, topK, threshold) {
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

export function chatContextNear(index = null, radius = null) {
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

export function vectorTextForPhoneMessage(message, meta, nearbyContext = '') {
    const recipients = Array.isArray(message.to) ? message.to.join(', ') : message.to;
    return [
        `Phone thread: ${meta?.title || message.threadId || 'Unknown'}`,
        `Participants: ${uniqueNames(meta?.participants || [message.from, recipients]).join(', ')}`,
        `Phone message: ${message.from} -> ${recipients}: ${message.text}`,
        nearbyContext ? `Nearby RP context when sent:\n${nearbyContext}` : '',
    ].filter(Boolean).join('\n');
}

export async function indexPhoneMessageVector(message, meta, nearbyIndex = null) {
    const bucket = ensureState();
    if (!bucket.settings.vectorMemoryEnabled || !message?.id || !message?.text) return;
    const nearbyContext = chatContextNear(nearbyIndex);
    const text = vectorTextForPhoneMessage(message, meta, nearbyContext);

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

export function canSeeVectorRecord(record, participants) {
    const visibleTo = uniqueNames(record?.visibleTo || []);
    if (!visibleTo.length) return true;
    return participants.some((name) => visibleTo.some((visible) => namesMatch(visible, name)));
}

export async function buildVectorRecallBlock(threadId, sentMessage, participants) {
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

export function buildPhoneContextBlock() {
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

export function setPrompt() {
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

export async function publishPhoneMessageToChat(message, meta, narrated) {
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

export async function sendCurrentDraft() {
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

export function recentChatContext(max = 8) {
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

export async function generatePhoneOnlyReply(threadId, sentMessage) {
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

export function parseJsonObjectRanges(text) {
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

export function expandFenceRange(text, range) {
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

export function parseEmbeddedPhoneMessages(text) {
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

export function resolveThreadForParsedMessage(item, forcedThreadId) {
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

export function storeParsedPhoneMessages(messages, sourceMessageId, forcedThreadId) {
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

export async function handleRenderedMessage(messageId) {
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
