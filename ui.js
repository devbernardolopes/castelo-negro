/** @typedef {'en'|'pt-br'|string} LanguageCode */

const PROMPT_HISTORY_KEY = 'adventure_prompt_history';

let selectedWords = [];
const _tabContentKeys = {};
let pendingWordClickTimer = null;
let suppressPromptAddUntilTs = 0;
let directInputMode = false;
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
      const words = promptHistory[i].split(/\s+/).filter(Boolean);
      selectedWords = words;
      renderCommandBuilder();
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

function resetUiForNewGame() {
  _outputQueue = [];
  _isPausedForSend = false;
  for (const k of Object.keys(_tabContentKeys)) delete _tabContentKeys[k];
  clearEl('inventory-list');
  setText('mind-panel', '');
  clearEl('memory-list');
  clearEl('debug-panel');
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

function setDirectInputMode(enabled) {
  directInputMode = !!enabled;
  const input = document.getElementById('direct-text-input');
  if (input) {
    input.style.display = directInputMode ? '' : 'none';
    input.value = '';
    input.disabled = !engine;
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

function formatBracketBoldToHtml(text) {
  return String(text).replace(/\[([^\]]+)\]/g, (_m, inner) => `<strong>${inner}</strong>`);
}

function textToHtmlWithBoldBrackets(text) {
  const escaped = escapeHtml(String(text ?? '').replace(/\r\n/g, '\n'));
  const bolded = formatBracketBoldToHtml(escaped);
  return bolded.replace(/\n/g, '<br>');
}

function _doAppendOutput(text) {
  const el = document.getElementById('text-display');
  if (!el) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = textToHtmlWithBoldBrackets(text);
  makeWordsClickable(entry);
  if (el.childNodes.length) el.appendChild(document.createElement('br'));
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
  const contentKey = engine.inventory.items.join(',');
  while (inventoryList.firstChild) inventoryList.removeChild(inventoryList.firstChild);

  for (const itemId of engine.inventory.items) {
    const item = engine.definition.items?.[itemId];
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
    span.textContent = item ? engine._pickLang(item.name) : itemId;
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
