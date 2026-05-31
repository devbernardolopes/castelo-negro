/** @typedef {'en'|'pt-br'|string} LanguageCode */

const PROMPT_HISTORY_KEY = 'adventure_prompt_history';

let selectedWords = [];
const _tabContentKeys = {};
let _mapPanX = 0;
let _mapPanY = 0;
let _mapZoom = 1;
let pendingWordClickTimer = null;
let suppressPromptAddUntilTs = 0;
let directInputMode = false;
let _historyIndex = null;
let _outputQueue = [];
let _isPausedForSend = false;

let promptHistory = [];
try {
  const saved = localStorage.getItem(PROMPT_HISTORY_KEY);
  if (saved) promptHistory = JSON.parse(saved);
  if (!Array.isArray(promptHistory)) promptHistory = [];
} catch { promptHistory = []; }

function savePromptToHistory(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return;
  promptHistory.push(text);
  try { localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(promptHistory)); } catch {}
}

function clearPromptHistory() {
  promptHistory = [];
  try { localStorage.removeItem(PROMPT_HISTORY_KEY); } catch {}
}

function renderPromptHistoryPanel() {
  const panel = document.getElementById('prompt-history-panel');
  if (!panel) return;
  panel.innerHTML = '';
  for (let i = promptHistory.length - 1; i >= 0; i--) {
    const entry = document.createElement('div');
    entry.className = 'ph-entry';
    entry.textContent = promptHistory[i];
    entry.setAttribute('role', 'option');
    entry.addEventListener('click', (e) => {
      if (_isPausedForSend) return;
      e.preventDefault();
      _historyIndex = null;
      if (directInputMode) {
        const directInput = document.getElementById('direct-text-input');
        if (directInput) {
          directInput.value = promptHistory[i];
          directInput.focus();
          syncSendButtonEnabled();
        }
      } else {
        const words = promptHistory[i].split(/\s+/).filter(Boolean);
        selectedWords = words;
        renderCommandBuilder();
      }
      hidePromptHistoryPanel();
    });
    panel.appendChild(entry);
  }
}

function showPromptHistoryPanel() {
  if (_isPausedForSend) return;
  const panel = document.getElementById('prompt-history-panel');
  if (!panel) return;
  if (promptHistory.length === 0) return;
  _historyIndex = null;
  renderPromptHistoryPanel();
  panel.style.display = 'block';
}

function hidePromptHistoryPanel() {
  const panel = document.getElementById('prompt-history-panel');
  if (!panel) return;
  panel.style.display = 'none';
}

function setText(elId, text) {
  const el = document.getElementById(elId);
  if (el) el.textContent = text || '';
}

function clearEl(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
}

function setMenuButtonsEnabled(isGameLoaded) {
  const ids = ['menu-btn-reset-game', 'menu-btn-load-game', 'menu-btn-save-game', 'menu-btn-change-language'];
  for (const id of ids) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !isGameLoaded;
  }
}

function setGameControlsEnabled(isGameLoaded) {
  const input = document.getElementById('user-input');
  if (input) input.setAttribute('aria-disabled', isGameLoaded ? 'false' : 'true');

  const directInput = document.getElementById('direct-text-input');
  if (directInput) {
    directInput.disabled = !isGameLoaded;
  }

  syncSendButtonEnabled();

  document.querySelectorAll('#directional-buttons-row .direction-btn').forEach((btn) => {
    btn.disabled = !isGameLoaded;
  });
}

function setSidebarTabsEnabled(isGameLoaded) {
  const sidebar = document.getElementById('sidebar-tabs');
  if (sidebar) sidebar.setAttribute('data-enabled', isGameLoaded ? 'true' : 'false');
  document.querySelectorAll('#sidebar-tabs .tab-btn').forEach((btn) => {
    if (btn.id === 'tab-system') return;
    btn.disabled = !isGameLoaded;
  });
}

function setDebugTabVisibility(visible) {
  const tabBtn = document.getElementById('tab-debug');
  if (tabBtn) tabBtn.style.display = visible ? '' : 'none';
  if (!visible) {
    const panel = document.getElementById('tab-panel-debug');
    if (panel) panel.style.display = 'none';
    if (tabBtn && tabBtn.getAttribute('aria-selected') === 'true') {
      const systemBtn = document.getElementById('tab-system');
      if (systemBtn) systemBtn.click();
    }
  }
}

function setAdventureTitle(title) {
  setText('adventure-title-row', title || '');
}

function setMapTabVisibility(visible) {
  const tabBtn = document.getElementById('tab-map');
  if (tabBtn) tabBtn.style.display = visible ? '' : 'none';
  if (!visible) {
    const panel = document.getElementById('tab-panel-map');
    if (panel) panel.style.display = 'none';
    if (tabBtn && tabBtn.getAttribute('aria-selected') === 'true') {
      const systemBtn = document.getElementById('tab-system');
      if (systemBtn) systemBtn.click();
    }
  }
}

function resetUiForNewGame() {
  _outputQueue = [];
  _isPausedForSend = false;
  for (const k of Object.keys(_tabContentKeys)) delete _tabContentKeys[k];
  clearEl('inventory-list');
  setText('mind-panel', '');
  clearEl('memory-list');
  clearEl('debug-panel');
  clearEl('map-grid');
  _mapPanX = 0;
  _mapPanY = 0;
  _mapZoom = 1;
  selectedWords = [];
  renderCommandBuilder();
  const directInput = document.getElementById('direct-text-input');
  if (directInput) directInput.value = '';
  const imgEl = document.getElementById('room-img');
  if (imgEl) {
    imgEl.style.display = 'none';
    imgEl.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  }
}

function appendGameMetadata(metadata) {
  if (!metadata) return;
  const lines = [];
  if (metadata.title) lines.push(metadata.title);
  if (metadata.author) lines.push(`by ${metadata.author}`);
  if (metadata.version) lines.push(`version ${metadata.version}`);
  if (lines.length) appendOutput(lines.join('\n'));
}

function setDirectInputMode(enabled) {
  directInputMode = !!enabled;
  const input = document.getElementById('direct-text-input');
  if (input) {
    input.style.display = directInputMode ? '' : 'none';
    input.value = '';
    input.disabled = !engine;
  }
  const userInput = document.getElementById('user-input');
  if (userInput) userInput.style.display = directInputMode ? 'none' : '';
  const memBtn = document.getElementById('tab-memory');
  const memPanel = document.getElementById('tab-panel-memory');
  if (directInputMode) {
    if (memBtn) memBtn.style.display = 'none';
    if (memPanel) memPanel.style.display = 'none';
  }
  syncSendButtonEnabled();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMarkupToHtml(text) {
  const TAG_HANDLERS = {
    b: () => ({ open: '<strong>', close: '</strong>' }),
    i: () => ({ open: '<em>', close: '</em>' }),
    color: (value) => {
      if (!value) return null;
      const cssValue = value.startsWith('#') ? value : 'var(--' + value + ')';
      return { open: '<span style="color:' + cssValue + '">', close: '</span>' };
    },
    shake: () => ({ open: '<span class="effect-shake">', close: '</span>' }),
    blink: () => ({ open: '<span class="effect-blink">', close: '</span>' }),
    glow: () => ({ open: '<span class="effect-glow">', close: '</span>' }),
    pulse: () => ({ open: '<span class="effect-pulse">', close: '</span>' }),
    wiggle: () => ({ open: '<span class="effect-wiggle">', close: '</span>' }),
    grow: () => ({ open: '<span class="effect-grow">', close: '</span>' }),
    shrink: () => ({ open: '<span class="effect-shrink">', close: '</span>' })
  };

  const s = String(text ?? '').replace(/\r\n/g, '\n');
  const out = [];
  const stack = [];
  let i = 0;

  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out.push(escapeHtml(s[i + 1]));
      i += 2;
      continue;
    }

    if (s[i] === '[') {
      const closeIdx = s.indexOf(']', i + 1);
      if (closeIdx !== -1) {
        const tagContent = s.slice(i + 1, closeIdx);

        if (tagContent.startsWith('/')) {
          const tagName = tagContent.slice(1).trim().toLowerCase();
          if (stack.length > 0 && stack[stack.length - 1].name === tagName) {
            out.push(stack.pop().close);
          }
          i = closeIdx + 1;
          continue;
        }

        const eqIdx = tagContent.indexOf('=');
        let tagName, tagValue;
        if (eqIdx !== -1) {
          tagName = tagContent.slice(0, eqIdx).trim().toLowerCase();
          tagValue = tagContent.slice(eqIdx + 1).trim();
        } else {
          tagName = tagContent.trim().toLowerCase();
          tagValue = null;
        }

        const handler = TAG_HANDLERS[tagName];
        if (handler) {
          const tag = handler(tagValue);
          if (tag) {
            stack.push({ name: tagName, close: tag.close });
            out.push(tag.open);
          }
        }
        i = closeIdx + 1;
        continue;
      }
    }

    out.push(escapeHtml(s[i]));
    i++;
  }

  while (stack.length > 0) {
    out.push(stack.pop().close);
  }

  return out.join('').replace(/\n/g, '<br>');
}

function _doAppendOutput(text) {
  const el = document.getElementById('text-display');
  if (!el) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = formatMarkupToHtml(text);
  makeWordsClickable(entry);
  if (el.childNodes.length) el.appendChild(document.createElement('br'));
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

function _doAppendLocationName(text) {
  const el = document.getElementById('text-display');
  if (!el) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry location-name';
  entry.textContent = text;
  makeWordsClickable(entry);
  if (el.childNodes.length) el.appendChild(document.createElement('br'));
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

function appendOutput(text) {
  if (_isPausedForSend) {
    _outputQueue.push({ type: 'text', text });
    return;
  }
  const idx = String(text).indexOf('>>>>');
  if (idx !== -1) {
    _doAppendOutput(text.slice(0, idx));
    const rest = text.slice(idx + 4);
    if (rest.trim()) _outputQueue.push({ type: 'text', text: rest });
    _enterPauseState();
    return;
  }
  _doAppendOutput(text);
}

function _showContinueMessage() {
  if (!engine?.definition?.metadata?.show_continue_message) return;
  const msg = engine._pickLang(engine.definition.metadata.continue_message);
  if (msg) _doAppendOutput(msg);
}

function _enterPauseState() {
  if (_isPausedForSend) return;
  _isPausedForSend = true;

  document.querySelectorAll('#directional-buttons-row .direction-btn').forEach(btn => {
    btn.dataset.savedDisabled = btn.disabled ? 'true' : 'false';
    btn.disabled = true;
  });

  document.querySelectorAll('#sidebar-tabs .tab-btn').forEach(btn => {
    if (btn.id === 'tab-system') return;
    btn.dataset.savedDisabled = btn.disabled ? 'true' : 'false';
    btn.disabled = true;
  });

  const userInput = document.getElementById('user-input');
  if (userInput) {
    userInput.dataset.savedAriaDisabled = userInput.getAttribute('aria-disabled') || 'false';
    userInput.setAttribute('aria-disabled', 'true');
  }
  const directInput = document.getElementById('direct-text-input');
  if (directInput) {
    directInput.dataset.savedDisabled = directInput.disabled ? 'true' : 'false';
    directInput.disabled = true;
  }

  const sendBtn = document.getElementById('input-btn-send');
  if (sendBtn) sendBtn.disabled = false;

  _showContinueMessage();
}

function resumeFromPause() {
  if (!_isPausedForSend) return;

  _isPausedForSend = false;

  let morePauses = false;
  while (_outputQueue.length > 0 && !morePauses) {
    const item = _outputQueue.shift();
    if (item.type === 'location') {
      _doAppendLocationName(item.text);
    } else {
      const parts = String(item.text).split('>>>>');
      if (parts.length > 1) {
        _doAppendOutput(parts[0]);
        _showContinueMessage();
        for (let i = parts.length - 1; i >= 1; i--) {
          const trimmed = parts[i].trim();
          if (trimmed) _outputQueue.unshift({ type: 'text', text: trimmed });
        }
        morePauses = true;
      } else {
        _doAppendOutput(item.text);
      }
    }
  }

  if (morePauses) {
    _isPausedForSend = true;
    const sendBtn = document.getElementById('input-btn-send');
    if (sendBtn) sendBtn.disabled = false;
    return;
  }

  document.querySelectorAll('#directional-buttons-row .direction-btn').forEach(btn => {
    if ('savedDisabled' in btn.dataset) {
      btn.disabled = btn.dataset.savedDisabled === 'true';
      delete btn.dataset.savedDisabled;
    }
  });

  document.querySelectorAll('#sidebar-tabs .tab-btn').forEach(btn => {
    if ('savedDisabled' in btn.dataset) {
      btn.disabled = btn.dataset.savedDisabled === 'true';
      delete btn.dataset.savedDisabled;
    }
  });

  const userInput = document.getElementById('user-input');
  if (userInput && 'savedAriaDisabled' in userInput.dataset) {
    userInput.setAttribute('aria-disabled', userInput.dataset.savedAriaDisabled);
    delete userInput.dataset.savedAriaDisabled;
  }
  const directInput = document.getElementById('direct-text-input');
  if (directInput && 'savedDisabled' in directInput.dataset) {
    directInput.disabled = directInput.dataset.savedDisabled === 'true';
    delete directInput.dataset.savedDisabled;
  }

  syncSendButtonEnabled();
}

function appendLocationName(text) {
  if (_isPausedForSend) {
    _outputQueue.push({ type: 'location', text });
    return;
  }
  _doAppendLocationName(text);
}

function appendPlayerPrompt(promptText) {
  const el = document.getElementById('text-display');
  if (!el) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry player-prompt';
  entry.textContent = `> ${promptText}`;
  if (el.childNodes.length) el.appendChild(document.createElement('br'));
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

function stripWordPunctuation(rawWord) {
  return String(rawWord || '').replace(/^[\s"'“”‘’\(\[\{<]+|[\s"'“”‘’\)\]\}>.,!?:;]+$/g, '');
}

function makeWordsClickable(rootEl) {
  if (!rootEl) return;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('.click-word')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.nodeValue || '';
    const parts = text.split(/(\s+)/);
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
        continue;
      }
      const span = document.createElement('span');
      span.className = 'click-word';
      span.setAttribute('data-word', part);
      span.textContent = part;
      frag.appendChild(span);
    }
    node.parentNode?.replaceChild(frag, node);
  }
}

function renderCommandBuilder() {
  // Clear any in-progress text selection before DOM rebuild
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  const container = document.getElementById('user-input');
  if (!container) return;
  container.innerHTML = '';

  for (let i = 0; i < selectedWords.length; i++) {
    const word = selectedWords[i];
    const token = document.createElement('div');
    token.className = 'word-token';
    token.setAttribute('role', 'listitem');
    token.setAttribute('draggable', 'true');
    token.setAttribute('data-index', String(i));

    const handle = document.createElement('div');
    handle.className = 'word-token-handle';
    handle.setAttribute('aria-label', 'Drag to reorder');
    handle.textContent = '≡';

    const text = document.createElement('div');
    text.className = 'word-token-text';
    text.textContent = word;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'word-token-remove';
    remove.setAttribute('aria-label', 'Remove word');
    remove.textContent = 'X';

    token.appendChild(handle);
    token.appendChild(text);
    token.appendChild(remove);
    container.appendChild(token);
  }

  syncSendButtonEnabled();
}

function syncSendButtonEnabled() {
  const sendBtn = document.getElementById('input-btn-send');
  if (!sendBtn) return;
  const input = document.getElementById('direct-text-input');
  const hasTextInput = input && input.value.trim().length > 0;
  sendBtn.disabled = !engine || (selectedWords.length === 0 && !(directInputMode && hasTextInput));
}

function addWordToCommand(rawWord) {
  if (!engine || _isPausedForSend) return;
  const word = stripWordPunctuation(rawWord);
  if (!word) return;
  selectedWords.push(word);
  renderCommandBuilder();
}

function scheduleAddWordToCommand(rawWord) {
  if (pendingWordClickTimer) clearTimeout(pendingWordClickTimer);
  pendingWordClickTimer = setTimeout(() => {
    pendingWordClickTimer = null;
    addWordToCommand(rawWord);
  }, 250);
}

function setModalVisible(visible) {
  const el = document.getElementById('adventure-modal-backdrop');
  if (!el) return;
  el.style.display = visible ? 'flex' : 'none';
}

function _markTabUpdate(tabName) {
  const btn = document.getElementById(`tab-${tabName}`);
  if (btn && btn.getAttribute('aria-selected') !== 'true' && !btn.classList.contains('has-update')) {
    btn.classList.add('has-update');
  }
}

function _isTabContentChanged(tabName, contentKey) {
  if (_tabContentKeys[tabName] === undefined) {
    _tabContentKeys[tabName] = contentKey;
    return false;
  }
  if (_tabContentKeys[tabName] === contentKey) return false;
  _tabContentKeys[tabName] = contentKey;
  return true;
}

// --- Engine hook rendering callbacks (DOM-free engine hooks into these) ---

/**
 * Render the current room image into #room-img.
 * @param {string|null} url - resolved image URL, or null to hide
 */
function renderRoomImage(url) {
  const imgEl = document.getElementById('room-img');
  if (!imgEl) return;
  if (url) {
    imgEl.src = url;
    imgEl.style.display = 'block';
    imgEl.onload = () => { imgEl.style.display = 'block'; };
    imgEl.onerror = () => { imgEl.style.display = 'none'; };
  } else {
    imgEl.style.display = 'none';
  }
}

/**
 * Re-render the inventory list from engine state.
 * Reads engine.gameState.inventory and engine.definition.items globals.
 */
function renderInventoryList() {
  const inventoryList = document.getElementById('inventory-list');
  if (!inventoryList) return;
  if (!engine) return;
  const items = engine.getVisibleInventoryItems ? engine.getVisibleInventoryItems() : engine.inventory.items;
  const contentKey = items.join(',');
  while (inventoryList.firstChild) inventoryList.removeChild(inventoryList.firstChild);

  const playerActorId = engine._getPlayerActorId ? engine._getPlayerActorId() : null;
  const wearing = playerActorId ? (engine.gameState.actors_data?.[playerActorId]?.wearing || []) : [];

  const parentMap = {};
  for (const [containerId, children] of Object.entries(engine.gameState.container_contents || {})) {
    for (const childId of children) {
      parentMap[childId] = containerId;
    }
  }

  const wornChain = new Set(wearing);
  const queue = [...wearing];
  while (queue.length) {
    const id = queue.shift();
    const children = engine.gameState.container_contents?.[id] || [];
    for (const childId of children) {
      if (!wornChain.has(childId)) {
        wornChain.add(childId);
        queue.push(childId);
      }
    }
  }

  for (const itemId of items) {
    const item = engine.definition.items?.[itemId];
    if (item && item.show_in_inventory === false) continue;

    const li = document.createElement('li');

    const images = Array.isArray(item?.images) ? item.images : [];
    if (images.length > 0) {
      const img = document.createElement('img');
      img.className = 'inventory-item-img';
      img.alt = '';
      engine.resolveAssetUrl(images[0]).then((url) => {
        if (url) img.src = url;
      });
      img.onerror = () => { img.style.display = 'none'; };
      li.appendChild(img);
    }

    const span = document.createElement('span');
    let name = item ? engine._getItemDisplayName(itemId) : itemId;
    if (wearing.includes(itemId)) {
      name += ' (wearing)';
    } else {
      const parentId = parentMap[itemId];
      if (parentId && wornChain.has(parentId)) {
        const parentDef = engine.definition.items?.[parentId];
        const tag = parentDef ? (engine._pickLang(parentDef.short_name) || engine._pickLang(parentDef.name) || parentId) : parentId;
        name += ` (${tag})`;
      }
    }
    span.textContent = name;
    li.appendChild(span);

    makeWordsClickable(li);
    inventoryList.appendChild(li);
  }
  if (_isTabContentChanged('inventory', contentKey)) _markTabUpdate('inventory');
}

/**
 * Re-render the mind panel from engine state.
 */
function renderMindPanel() {
  if (!engine) return;
  const health = engine.gameState.variables.player_health?.value;
  const sanity = engine.gameState.variables.sanity?.value;
  const timeOfDay = engine.gameState.variables.time_of_day?.value;
  const turn = engine.gameState.game_turn;
  const contentKey = `${health ?? ''}|${sanity ?? ''}|${timeOfDay ?? ''}|${turn}`;
  const lines = [];
  if (health !== undefined) lines.push(`Health: ${health}`);
  if (sanity !== undefined) lines.push(`Sanity: ${sanity}`);
  if (timeOfDay !== undefined) lines.push(`Time: ${timeOfDay}`);
  lines.push(`Turn: ${turn}`);
  setText('mind-panel', lines.join('\n'));
  if (_isTabContentChanged('mind', contentKey)) _markTabUpdate('mind');
}

/**
 * Re-render the memory word list from engine state.
 */
function renderMemoryList() {
  const el = document.getElementById('memory-list');
  if (!el) return;
  if (!engine) return;
  const words = engine._getMemoryWords();
  const contentKey = words.join(',');
  while (el.firstChild) el.removeChild(el.firstChild);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const token = document.createElement('div');
    token.className = 'memory-token';
    token.setAttribute('role', 'listitem');
    token.setAttribute('data-index', String(i));
    token.setAttribute('draggable', words.length > 1 ? 'true' : 'false');

    const handle = document.createElement('div');
    handle.className = 'word-token-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '≡';

    const text = document.createElement('div');
    text.className = 'word-token-text';
    text.textContent = word;

    const controls = document.createElement('div');
    controls.className = 'memory-token-controls';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'memory-token-btn';
    up.setAttribute('data-action', 'mem-up');
    up.setAttribute('aria-label', 'Move up');
    up.textContent = '↑';
    up.disabled = i === 0;

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'memory-token-btn';
    down.setAttribute('data-action', 'mem-down');
    down.setAttribute('aria-label', 'Move down');
    down.textContent = '↓';
    down.disabled = i === words.length - 1;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'word-token-remove';
    remove.setAttribute('data-action', 'mem-remove');
    remove.setAttribute('aria-label', 'Remove word');
    remove.textContent = 'X';

    controls.appendChild(up);
    controls.appendChild(down);
    token.appendChild(handle);
    token.appendChild(text);
    token.appendChild(controls);
    token.appendChild(remove);
    el.appendChild(token);
  }
  if (_isTabContentChanged('memory', contentKey)) _markTabUpdate('memory');
}

function formatDebugValue(val) {
  if (val === undefined || val === null) return 'undefined';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (Array.isArray(val)) return `[${val.join(', ')}]`;
  return String(val);
}

function renderDebugPanel() {
  const el = document.getElementById('debug-panel');
  if (!el) return;
  if (!engine) return;

  const vars = engine.definition.variables || {};
  const state = engine.gameState.variables || {};
  const contentKey = Object.entries(vars)
    .filter(([, def]) => def.debug_variable)
    .map(([k]) => `${k}:${state[k]?.value}`)
    .join('|');
  while (el.firstChild) el.removeChild(el.firstChild);

  for (const [varName, def] of Object.entries(vars)) {
    if (!def.debug_variable) continue;
    const val = state[varName]?.value;
    const row = document.createElement('div');
    row.className = 'debug-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'debug-var-name';
    nameSpan.textContent = varName;

    const valueSpan = document.createElement('span');
    valueSpan.className = 'debug-var-value';
    valueSpan.textContent = formatDebugValue(val);

    row.appendChild(nameSpan);
    row.appendChild(valueSpan);
    el.appendChild(row);
  }
  if (_isTabContentChanged('debug', contentKey)) _markTabUpdate('debug');
}

var _mapControlsInit = false;

function _initMapControls() {
  if (_mapControlsInit) return;
  _mapControlsInit = true;
  const vp = document.getElementById('map-viewport');
  if (!vp) return;

  let dragging = false;
  let startX = 0, startY = 0;
  let panX = 0, panY = 0;

  vp.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX - _mapPanX;
    startY = e.clientY - _mapPanY;
    vp.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    _mapPanX = e.clientX - startX;
    _mapPanY = e.clientY - startY;
    _applyMapTransform();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    vp.style.cursor = '';
  });

  vp.addEventListener('dblclick', () => {
    _mapPanX = 0;
    _mapPanY = 0;
    _mapZoom = 1;
    _applyMapTransform();
  });

  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    _mapZoom = Math.max(0.3, Math.min(3, _mapZoom - e.deltaY * 0.002));
    _applyMapTransform();
  }, { passive: false });

  let touches = [];
  let lastTouchDist = 0;
  let lastTapTime = 0;

  vp.addEventListener('touchstart', (e) => {
    touches = Array.from(e.touches);
    if (touches.length === 1) {
      startX = e.touches[0].clientX - _mapPanX;
      startY = e.touches[0].clientY - _mapPanY;
    } else if (touches.length === 2) {
      lastTouchDist = Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
      );
    }
  }, { passive: true });

  vp.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1) {
      _mapPanX = e.touches[0].clientX - startX;
      _mapPanY = e.touches[0].clientY - startY;
      _applyMapTransform();
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (lastTouchDist) {
        _mapZoom = Math.max(0.3, Math.min(3, _mapZoom + (dist - lastTouchDist) * 0.01));
        _applyMapTransform();
      }
      lastTouchDist = dist;
    }
  }, { passive: true });

  vp.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTapTime < 300 && lastTapTime > 0) {
      _mapPanX = 0;
      _mapPanY = 0;
      _mapZoom = 1;
      _applyMapTransform();
      lastTapTime = 0;
    } else {
      lastTapTime = now;
    }
    lastTouchDist = 0;
  }, { passive: true });
}

function _applyMapTransform() {
  const grid = document.getElementById('map-grid');
  if (grid) {
    grid.style.transform = `translate(${_mapPanX}px, ${_mapPanY}px) scale(${_mapZoom})`;
  }
}

function renderMap() {
  const vp = document.getElementById('map-viewport');
  if (!vp) return;
  if (!engine) return;
  _initMapControls();

  const actorId = engine._getPlayerActorId();
  const actorData = engine.gameState.actors_data?.[actorId];
  const known = actorData?.known_locations;
  if (!known || !known.length) {
    clearEl('map-grid');
    _applyMapTransform();
    return;
  }

  const currentLoc = engine.gameState.current_location;
  const grid = engine._buildMapGrid(known);
  if (!grid || !grid.length) {
    clearEl('map-grid');
    _applyMapTransform();
    return;
  }

  const contentKey = known.join(',');
  const mapEl = document.getElementById('map-grid');
  if (!mapEl) return;
  while (mapEl.firstChild) mapEl.removeChild(mapEl.firstChild);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cell of grid) {
    if (cell.x < minX) minX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y > maxY) maxY = cell.y;
  }

  const CELL = 72;
  const GAP = 8;

  for (const cell of grid) {
    const div = document.createElement('div');
    div.className = 'map-cell';
    if (cell.isCurrent) div.classList.add('map-cell-current');
    div.title = cell.name;
    div.style.left = ((cell.x - minX) * (CELL + GAP)) + 'px';
    div.style.top = ((cell.y - minY) * (CELL + GAP)) + 'px';
    div.style.width = CELL + 'px';
    div.style.height = CELL + 'px';
    div.textContent = cell.shortName;
    mapEl.appendChild(div);
  }

  mapEl.style.width = ((maxX - minX + 1) * (CELL + GAP) - GAP) + 'px';
  mapEl.style.height = ((maxY - minY + 1) * (CELL + GAP) - GAP) + 'px';

  _applyMapTransform();
  if (_isTabContentChanged('map', contentKey)) _markTabUpdate('map');
}
