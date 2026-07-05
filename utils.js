// Pure, stateless helpers shared by settings.js, ui.js, and phone.js.
// Nothing in this file touches chat_metadata, the DOM, or SillyTavern's API.

export function nowId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeName(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase();
}

export function namesMatch(left, right) {
    const a = normalizeName(left);
    const b = normalizeName(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const aTokens = a.split(' ').filter(Boolean);
    const bTokens = b.split(' ').filter(Boolean);
    if (aTokens.length === 1 && bTokens.length === 1) return aTokens[0] === bTokens[0];
    return false;
}

export function uniqueNames(names) {
    const out = [];
    for (const name of names.map((value) => String(value || '').trim()).filter(Boolean)) {
        if (!out.some((entry) => namesMatch(entry, name))) out.push(name);
    }
    return out;
}

export function contactColor(name) {
    let hash = 0;
    for (const char of String(name || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 72% 68%)`;
}

export function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

export function formatTime(ts) {
    const date = new Date(Number(ts) || Date.now());
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function compactPreview(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

export function outputModeLabel(mode) {
    return {
        phone_only: 'Phone only',
        phone_chat: 'Phone + chat',
        narrated: 'Narrated in chat',
    }[mode] || 'Phone only';
}

export function visibilityLabel(mode) {
    return {
        participants: 'Participants',
        all: 'Everyone',
        selected: 'Selected',
    }[mode] || 'Participants';
}

export function memoryModeLabel(mode) {
    return {
        none: 'No memory pin',
        participants: 'Participants remember',
        selected: 'Selected remember',
        all: 'Everyone remembers',
    }[mode] || 'Participants remember';
}
