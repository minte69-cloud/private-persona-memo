const MODULE_NAME = 'private_persona_memo';
const UI_ID = 'private_persona_memo_block';
const TEXTAREA_ID = 'private_persona_memo_textarea';
const STATUS_ID = 'private_persona_memo_status';
const TOKEN_COUNT_ID = 'private_persona_memo_token_count';
const FALLBACK_PREFIX = 'fallback:';
const STABLE_PREFIX = 'persona-avatar:';
const DEFAULT_SETTINGS = Object.freeze({
    version: 1,
    copyMemoOnDuplicate: true,
    deleteMemoWithPersona: true,
    notes: {},
});

let initialized = false;
let activeKey = '';
let lastKnownAvatarId = '';
let refreshTimer = null;
let statusTimer = null;
let tokenCountTimer = null;
let tokenCountNonce = 0;
let isApplyingMemo = false;

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function cloneDefaultSettings() {
    if (typeof structuredClone === 'function') {
        return structuredClone(DEFAULT_SETTINGS);
    }

    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function getSettings() {
    const context = getContext();
    const extensionSettings = context?.extensionSettings;

    if (!extensionSettings) {
        return null;
    }

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = cloneDefaultSettings();
    }

    if (typeof extensionSettings[MODULE_NAME] !== 'object' || Array.isArray(extensionSettings[MODULE_NAME])) {
        extensionSettings[MODULE_NAME] = cloneDefaultSettings();
    }

    const settings = extensionSettings[MODULE_NAME];
    settings.version ??= DEFAULT_SETTINGS.version;
    settings.copyMemoOnDuplicate ??= DEFAULT_SETTINGS.copyMemoOnDuplicate;
    settings.deleteMemoWithPersona ??= DEFAULT_SETTINGS.deleteMemoWithPersona;

    if (!settings.notes || typeof settings.notes !== 'object' || Array.isArray(settings.notes)) {
        settings.notes = {};
    }

    return settings;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

function hashString(value) {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(36);
}

function stablePersonaKey(avatarId) {
    return avatarId ? `${STABLE_PREFIX}${avatarId}` : '';
}

function fallbackPersonaKey(name, avatarHint) {
    const fallbackSeed = `${String(name || '').trim()}\n${String(avatarHint || '').trim()}`;
    return `${FALLBACK_PREFIX}${hashString(fallbackSeed)}`;
}

function getPowerUserSettings() {
    return getContext()?.powerUserSettings ?? {};
}

function getSelectedAvatarId() {
    return document.querySelector('#user_avatar_block .avatar-container.selected')?.getAttribute('data-avatar-id') || '';
}

function getSelectedAvatarHint(avatarId) {
    if (avatarId) {
        return avatarId;
    }

    return document.querySelector('#user_avatar_block .avatar-container.selected img')?.getAttribute('src')
        || document.querySelector('#user_avatar_block .avatar-container.selected .avatar')?.getAttribute('title')
        || '';
}

function findCurrentAvatarByVisibleState(name, description) {
    const powerUser = getPowerUserSettings();
    const personas = powerUser.personas ?? {};
    const descriptions = powerUser.persona_descriptions ?? {};
    const matchingNames = Object.entries(personas).filter(([, personaName]) => String(personaName) === name);

    if (matchingNames.length === 1) {
        return matchingNames[0][0];
    }

    const matchingDescriptions = matchingNames.filter(([avatarId]) => {
        return String(descriptions[avatarId]?.description ?? '') === description;
    });

    if (matchingDescriptions.length === 1) {
        return matchingDescriptions[0][0];
    }

    return '';
}

function getCurrentPersonaIdentity() {
    const context = getContext();
    const powerUser = getPowerUserSettings();
    const personas = powerUser.personas ?? {};
    const rawVisibleName = String(document.querySelector('#your_name')?.textContent || context?.name1 || '').trim();
    const visibleName = rawVisibleName === '[Persona Name]' ? '' : rawVisibleName;
    const visibleDescription = String(document.querySelector('#persona_description')?.value ?? powerUser.persona_description ?? '');
    const selectedAvatarId = getSelectedAvatarId();
    let avatarId = '';

    if (selectedAvatarId && Object.hasOwn(personas, selectedAvatarId)) {
        avatarId = selectedAvatarId;
    }

    if (!avatarId && lastKnownAvatarId && Object.hasOwn(personas, lastKnownAvatarId)) {
        avatarId = lastKnownAvatarId;
    }

    if (!avatarId) {
        avatarId = findCurrentAvatarByVisibleState(visibleName, visibleDescription);
    }

    if (avatarId) {
        lastKnownAvatarId = avatarId;
    }

    const avatarHint = getSelectedAvatarHint(avatarId);
    const key = avatarId ? stablePersonaKey(avatarId) : (visibleName || avatarHint ? fallbackPersonaKey(visibleName, avatarHint) : '');

    return {
        key,
        stable: Boolean(avatarId),
        avatarId,
        avatarHint,
        name: visibleName,
    };
}

function getNoteText(settings, key) {
    const note = settings?.notes?.[key];

    if (typeof note === 'string') {
        return note;
    }

    return String(note?.text ?? '');
}

function setNoteText(settings, identity, text) {
    if (!settings) {
        return;
    }

    if (!text) {
        delete settings.notes[identity.key];
        return;
    }

    settings.notes[identity.key] = {
        text,
        personaName: identity.name,
        avatarId: identity.avatarId,
        avatarHint: identity.avatarHint,
        updatedAt: new Date().toISOString(),
    };
}

function findFallbackKeysForIdentity(settings, identity) {
    if (!settings || !identity.stable) {
        return [];
    }

    return Object.entries(settings.notes)
        .filter(([key, note]) => {
            if (!key.startsWith(FALLBACK_PREFIX)) {
                return false;
            }

            if (typeof note === 'string') {
                return false;
            }

            return note?.avatarId === identity.avatarId
                || (note?.personaName === identity.name && note?.avatarHint === identity.avatarHint)
                || (note?.personaName === identity.name && !note?.avatarId && !note?.avatarHint);
        })
        .map(([key]) => key);
}

function migrateFallbackMemo(settings, identity) {
    if (!settings || !identity.stable || settings.notes[identity.key]) {
        return;
    }

    const fallbackKeys = findFallbackKeysForIdentity(settings, identity);
    const fallbackKey = fallbackKeys.find(key => getNoteText(settings, key));

    if (!fallbackKey) {
        return;
    }

    settings.notes[identity.key] = {
        ...settings.notes[fallbackKey],
        avatarId: identity.avatarId,
        avatarHint: identity.avatarHint,
        personaName: identity.name,
        migratedFrom: fallbackKey,
        updatedAt: new Date().toISOString(),
    };

    for (const key of fallbackKeys) {
        delete settings.notes[key];
    }

    saveSettings();
}

function showStatus(message) {
    const status = document.getElementById(STATUS_ID);

    if (!status) {
        return;
    }

    status.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        status.textContent = '';
    }, 1600);
}

function setTokenCount(value) {
    const counter = document.getElementById(TOKEN_COUNT_ID);

    if (counter) {
        counter.textContent = String(value);
    }
}

async function updateNoteTokenCount() {
    const textarea = document.getElementById(TEXTAREA_ID);
    const getTokenCountAsync = getContext()?.getTokenCountAsync;

    if (!(textarea instanceof HTMLTextAreaElement)) {
        setTokenCount(0);
        return;
    }

    const text = textarea.value;
    const nonce = ++tokenCountNonce;

    if (!text) {
        setTokenCount(0);
        return;
    }

    if (typeof getTokenCountAsync !== 'function') {
        setTokenCount('...');
        return;
    }

    setTokenCount('...');

    try {
        const count = await getTokenCountAsync(text);

        if (nonce === tokenCountNonce) {
            setTokenCount(count);
        }
    } catch (error) {
        console.warn('[Private Persona Memo] Failed to count note tokens.', error);

        if (nonce === tokenCountNonce) {
            setTokenCount('?');
        }
    }
}

function scheduleNoteTokenCount(delay = 200) {
    clearTimeout(tokenCountTimer);
    tokenCountTimer = setTimeout(updateNoteTokenCount, delay);
}

function saveTextareaMemo() {
    if (isApplyingMemo) {
        return;
    }

    const textarea = document.getElementById(TEXTAREA_ID);
    const settings = getSettings();

    if (!(textarea instanceof HTMLTextAreaElement) || !settings) {
        return;
    }

    const identity = getCurrentPersonaIdentity();

    if (!identity.key) {
        return;
    }

    activeKey = identity.key;
    setNoteText(settings, identity, textarea.value);
    saveSettings();
    showStatus(textarea.value ? '개인 노트 저장됨' : '노트 비움');
    scheduleNoteTokenCount();
}

function createMemoBlock() {
    const block = document.createElement('div');
    block.id = UI_ID;
    block.className = 'range-block private-persona-memo';

    const header = document.createElement('h4');
    header.className = 'flex-container alignItemsBaseline private-persona-memo-header';

    const title = document.createElement('span');
    title.textContent = 'Persona Note';

    const lock = document.createElement('i');
    lock.className = 'fa-solid fa-lock opacity50p';
    lock.title = '페르소나 설명과 별도로 저장되며 프롬프트에 절대 추가되지 않습니다.';

    const maximizeButton = document.createElement('i');
    maximizeButton.className = 'editor_maximize fa-solid fa-maximize right_menu_button';
    maximizeButton.dataset.for = TEXTAREA_ID;
    maximizeButton.title = '큰 편집창으로 열기';

    const spacer = document.createElement('span');
    spacer.className = 'flex1';

    header.append(title, maximizeButton, lock, spacer);

    const textarea = document.createElement('textarea');
    textarea.id = TEXTAREA_ID;
    textarea.className = 'text_pole textarea_compact';
    textarea.rows = 4;
    textarea.autocomplete = 'off';
    textarea.spellcheck = true;
    textarea.placeholder = '이 페르소나에 대한 개인 노트...';
    textarea.addEventListener('input', saveTextareaMemo);

    const footer = document.createElement('div');
    footer.className = 'private-persona-memo-footer';

    const status = document.createElement('small');
    status.id = STATUS_ID;
    status.className = 'text_muted';

    const tokenCounter = document.createElement('div');
    tokenCounter.className = 'extension_token_counter widthFitContent';

    const tokenLabel = document.createElement('span');
    tokenLabel.textContent = '페르소나 노트 토큰';

    const tokenSeparator = document.createTextNode(': ');

    const tokenCount = document.createElement('span');
    tokenCount.id = TOKEN_COUNT_ID;
    tokenCount.textContent = '0';

    tokenCounter.append(tokenLabel, tokenSeparator, tokenCount);
    footer.append(status, tokenCounter);

    block.append(header, textarea, footer);
    return block;
}

function ensureMemoBlock() {
    if (document.getElementById(UI_ID)) {
        return true;
    }

    const positionContainer = document.querySelector('.persona_management_description_position_container');
    const descriptionTextarea = document.getElementById('persona_description');
    const anchor = positionContainer || descriptionTextarea;

    if (!anchor) {
        return false;
    }

    anchor.insertAdjacentElement('afterend', createMemoBlock());
    return true;
}

function refreshMemoTextarea() {
    if (!ensureMemoBlock()) {
        scheduleRefresh(250);
        return;
    }

    const textarea = document.getElementById(TEXTAREA_ID);
    const settings = getSettings();

    if (!(textarea instanceof HTMLTextAreaElement) || !settings) {
        return;
    }

    const identity = getCurrentPersonaIdentity();
    migrateFallbackMemo(settings, identity);
    activeKey = identity.key;

    isApplyingMemo = true;
    textarea.disabled = !identity.key;
    textarea.value = getNoteText(settings, identity.key);
    isApplyingMemo = false;
    scheduleNoteTokenCount(0);
}

function scheduleRefresh(delay = 0) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshMemoTextarea, delay);
}

function onPersonaChanged(avatarId) {
    if (typeof avatarId === 'string' && avatarId) {
        lastKnownAvatarId = avatarId;
    }

    scheduleRefresh();
}

function onPersonaCreated(data) {
    const settings = getSettings();

    if (!settings || !data?.avatarId) {
        scheduleRefresh();
        return;
    }

    if (settings.copyMemoOnDuplicate && data.duplicatedFromAvatarId) {
        const sourceKey = stablePersonaKey(data.duplicatedFromAvatarId);
        const targetKey = stablePersonaKey(data.avatarId);
        const sourceText = getNoteText(settings, sourceKey);

        if (sourceText && !settings.notes[targetKey]) {
            settings.notes[targetKey] = {
                text: sourceText,
                personaName: data.name || '',
                avatarId: data.avatarId,
                avatarHint: data.avatarId,
                duplicatedFromAvatarId: data.duplicatedFromAvatarId,
                updatedAt: new Date().toISOString(),
            };
            saveSettings();
        }
    }

    scheduleRefresh();
}

function onPersonaRenamed(data) {
    const settings = getSettings();
    const note = settings?.notes?.[stablePersonaKey(data?.avatarId)];

    if (note && typeof note === 'object') {
        note.personaName = data.newName || note.personaName || '';
        saveSettings();
    }

    scheduleRefresh();
}

function onPersonaDeleted(data) {
    const settings = getSettings();

    if (!settings || !settings.deleteMemoWithPersona || !data?.avatarId) {
        scheduleRefresh();
        return;
    }

    delete settings.notes[stablePersonaKey(data.avatarId)];

    for (const [key, note] of Object.entries(settings.notes)) {
        if (!key.startsWith(FALLBACK_PREFIX) || typeof note === 'string') {
            continue;
        }

        if (note.avatarId === data.avatarId || (note.personaName === data.name && note.avatarHint === data.avatarId)) {
            delete settings.notes[key];
        }
    }

    if (lastKnownAvatarId === data.avatarId) {
        lastKnownAvatarId = '';
    }

    saveSettings();
    scheduleRefresh();
}

function bindPersonaEvents() {
    const context = getContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes || context?.event_types || {};

    if (!eventSource || !eventTypes) {
        return;
    }

    const bind = (eventName, handler) => {
        if (eventName) {
            eventSource.on(eventName, handler);
        }
    };

    bind(eventTypes.APP_READY, () => scheduleRefresh());
    bind(eventTypes.CHAT_CHANGED, () => scheduleRefresh());
    bind(eventTypes.SETTINGS_LOADED, () => scheduleRefresh());
    bind(eventTypes.PERSONA_CHANGED, onPersonaChanged);
    bind(eventTypes.PERSONA_CREATED, onPersonaCreated);
    bind(eventTypes.PERSONA_UPDATED, () => scheduleRefresh());
    bind(eventTypes.PERSONA_RENAMED, onPersonaRenamed);
    bind(eventTypes.PERSONA_DELETED, onPersonaDeleted);
}

function bindDomFallbacks() {
    document.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('#user_avatar_block .avatar-container')) {
            scheduleRefresh(50);
        }
    });

    document.addEventListener('input', event => {
        if (event.target instanceof Element && event.target.matches('#persona_description')) {
            scheduleRefresh(50);
        }
    });
}

export function init() {
    if (initialized) {
        scheduleRefresh();
        return;
    }

    initialized = true;
    getSettings();
    bindPersonaEvents();
    bindDomFallbacks();
    scheduleRefresh();
}

export function clean() {
    const context = getContext();

    if (context?.extensionSettings?.[MODULE_NAME]) {
        delete context.extensionSettings[MODULE_NAME];
        saveSettings();
    }
}
