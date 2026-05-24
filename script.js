/** @typedef {'en'|'pt-br'|string} LanguageCode */

let engine = null;
let selectedWords = [];

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

  syncSendButtonEnabled();

  document.querySelectorAll('#directional-buttons-row .direction-btn').forEach((btn) => {
    btn.disabled = !isGameLoaded;
  });
}

function setSidebarTabsEnabled(isGameLoaded) {
  const sidebar = document.getElementById('sidebar-tabs');
  if (sidebar) sidebar.setAttribute('data-enabled', isGameLoaded ? 'true' : 'false');
  document.querySelectorAll('#sidebar-tabs .tab-btn').forEach((btn) => {
    btn.disabled = !isGameLoaded;
  });
}

function setAdventureTitle(title) {
  setText('adventure-title-row', title || '');
}

function resetUiForNewGame() {
  clearEl('inventory-list');
  setText('mind-panel', ''); 
  clearEl('memory-list');
  selectedWords = [];
  renderCommandBuilder();
  const imgEl = document.getElementById('room-img');
  if (imgEl) {
    imgEl.style.display = 'none';
    imgEl.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  }
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
  // Convert [text] -> <strong>text</strong>, without rendering the brackets.
  // Works on already-escaped HTML.
  return String(text).replace(/\[([^\]]+)\]/g, (_m, inner) => `<strong>${inner}</strong>`);
}

function textToHtmlWithBoldBrackets(text) {
  const escaped = escapeHtml(String(text ?? '').replace(/\r\n/g, '\n'));
  const bolded = formatBracketBoldToHtml(escaped);
  return bolded.replace(/\n/g, '<br>');
}

/** 
 * Append text output to the game log. 
 * @param {string} text 
 */ 
function appendOutput(text) { 
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
  sendBtn.disabled = !engine || selectedWords.length === 0;
}

function addWordToCommand(rawWord) {
  if (!engine) return;
  const word = stripWordPunctuation(rawWord);
  if (!word) return;
  selectedWords.push(word);
  renderCommandBuilder();
}

let pendingWordClickTimer = null;
let suppressPromptAddUntilTs = 0;

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

// ---------------------------
// Engine implementation
// ---------------------------

class InventorySystem {
  /** @param {GameEngine} engine */
  constructor(engine) {
    this.engine = engine;
  }

  get maxCapacity() {
    const invVar = this.engine.gameState.variables.inventory;
    return Number(invVar?.max_capacity ?? invVar?.definition?.max_capacity ?? 9999);
  }

  get items() {
    return this.engine.gameState.inventory;
  }

  has(itemId) {
    return this.items.includes(itemId);
  }

  canAdd(itemId) {
    if (this.items.length >= this.maxCapacity) return false;
    const def = this.engine.definition.items?.[itemId];
    if (def && def.takeable === false) return false;
    return true;
  }

  add(itemId) {
    if (!this.canAdd(itemId)) return false;
    if (this.has(itemId)) return true;
    this.items.push(itemId);
    return true;
  }

  remove(itemId) {
    const idx = this.items.indexOf(itemId);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }
}

class GameEngine {
  /**
   * @param {any} definition
   * @param {{
   *   assetsBase?: string,
   *   assetsResolver?: (relativePath:string)=>Promise<string>,
   *   onOutput?: (text:string)=>void,
   *   onLocationRender?: (locationId:string)=>void,
   *   onInventoryRender?: ()=>void
   * }} hooks
   */
  constructor(definition, hooks = {}) {
    validateDefinition(definition);
    this.definition = definition;
    this.hooks = hooks;
    this.assetsBase = hooks.assetsBase || '';
    this.assetsResolver = typeof hooks.assetsResolver === 'function' ? hooks.assetsResolver : null;
    this.language = /** @type {LanguageCode} */ (definition.metadata.default_language || 'en');

    this.gameState = this._createInitialState();
    this.inventory = new InventorySystem(this);
    this._verbsIndex = this._buildVerbsIndex();
    this._memoryConfig = this._getPlayerMemoryConfig();

    // A small helper object exposed to condition/effect evaluation.
    this._evalContext = {
      inventory: {
        has: (itemId) => this.inventory.has(String(itemId))
      }
    };
  }

  _getPlayerActorId() {
    const list = this.gameState.variables.current_player_actor?.value;
    if (Array.isArray(list) && list.length) return String(list[0]);
    return 'protagonist';
  }

  _getPlayerMemoryConfig() {
    const actorId = this._getPlayerActorId();
    const actor = this.definition.actors?.[actorId];
    const mem = actor?.memory;
    const wordsVar = String(mem?.words_variable || '').trim();
    const maxVar = String(mem?.max_capacity_variable || '').trim();
    if (!wordsVar || !maxVar) return null;
    return { actorId, wordsVar, maxVar };
  }

  _getMemoryWords() {
    const cfg = this._memoryConfig;
    if (!cfg) return [];
    const v = this.gameState.variables?.[cfg.wordsVar]?.value;
    return Array.isArray(v) ? v.map(String) : [];
  }

  _getMemoryMaxCapacity() {
    const cfg = this._memoryConfig;
    if (!cfg) return 0;
    const v = this.gameState.variables?.[cfg.maxVar]?.value;
    return Number(v ?? 0);
  }

  addWordToMemory(rawWord) {
    const cfg = this._memoryConfig;
    if (!cfg) return false;
    const word = stripWordPunctuation(rawWord).toLowerCase();
    if (!word) return false;
    const words = this._getMemoryWords();
    if (words.includes(word)) return false;
    const cap = this._getMemoryMaxCapacity();
    if (cap >= 0 && words.length >= cap) return false;
    const next = [...words, word];
    this.gameState.variables[cfg.wordsVar].value = next;
    this._renderMemory();
    return true;
  }

  removeMemoryWord(index) {
    const cfg = this._memoryConfig;
    if (!cfg) return false;
    const words = this._getMemoryWords();
    if (!Number.isFinite(index) || index < 0 || index >= words.length) return false;
    words.splice(index, 1);
    this.gameState.variables[cfg.wordsVar].value = words;
    this._renderMemory();
    return true;
  }

  moveMemoryWord(index, delta) {
    const cfg = this._memoryConfig;
    if (!cfg) return false;
    const words = this._getMemoryWords();
    const to = index + delta;
    if (!Number.isFinite(index) || index < 0 || index >= words.length) return false;
    if (to < 0 || to >= words.length) return false;
    const [w] = words.splice(index, 1);
    words.splice(to, 0, w);
    this.gameState.variables[cfg.wordsVar].value = words;
    this._renderMemory();
    return true;
  }
 
  _buildVerbsIndex() {
    const index = new Map();
    const verbs = this.definition.verbs && typeof this.definition.verbs === 'object' ? this.definition.verbs : {};
    for (const [canonical, def] of Object.entries(verbs)) {
      index.set(String(canonical).toLowerCase(), String(canonical).toLowerCase());
      const syn = def?.synonyms;
      if (syn && typeof syn === 'object') {
        for (const list of Object.values(syn)) {
          if (!Array.isArray(list)) continue;
          for (const w of list) {
            index.set(String(w).toLowerCase(), String(canonical).toLowerCase());
          }
        }
      }
    }
    return index;
  }

  _canonicalVerb(word) {
    const w = String(word || '').trim().toLowerCase();
    if (!w) return '';
    return this._verbsIndex.get(w) || w;
  }

  _createInitialState() {
    const vars = {};
    for (const [key, def] of Object.entries(this.definition.variables || {})) {
      const type = String(def?.type || 'any');
      const base = {
        type,
        min_value: def?.min_value,
        max_value: def?.max_value,
        possible_values: def?.possible_values,
        max_capacity: def?.max_capacity,
        value: structuredClone(def?.value)
      };
      vars[key] = base;
    }

    const startLoc = this.definition.actors.protagonist.starting_location;
    const invValue = Array.isArray(vars.inventory?.value) ? vars.inventory.value : [];

    return {
      current_location: startLoc,
      variables: vars,
      inventory: invValue,
      game_turn: Number(vars.game_turn?.value ?? 0),
      flags: {},
      story: {}
    };
  }

  /** @param {string} relOrUrl */
  resolveAsset(relOrUrl) {
    const raw = String(relOrUrl || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    const base = String(this.assetsBase || '').trim();
    const metaBase = String(this.definition.metadata.assets_path || '').trim();
    const prefix = base || metaBase;
    if (!prefix) return raw;
    if (raw.startsWith('/')) return raw;
    return `${prefix}${raw}`;
  }

  /**
   * Resolve an asset to a URL suitable for <img src>.
   * If an `assetsResolver` hook is provided (e.g., local filesystem), it is preferred.
   * @param {string} relOrUrl
   * @returns {Promise<string>}
   */
  async resolveAssetUrl(relOrUrl) {
    const raw = String(relOrUrl || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    if (this.assetsResolver) {
      try {
        return await this.assetsResolver(raw);
      } catch (err) {
        console.warn('[engine] assetsResolver failed for', raw, err);
      }
    }
    return this.resolveAsset(raw);
  }

  /** @param {string} key @param {LanguageCode=} language */
  getText(key, language) {
    const lang = language || this.language;
    const val = this.definition.strings?.[key];
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object') {
      return val[lang] ?? val[this.definition.metadata.default_language] ?? Object.values(val)[0] ?? '';
    }
    console.warn(`[engine] Missing strings.${key}`);
    return '';
  }

  /** @param {any} maybeBilingual */
  _pickLang(maybeBilingual) {
    if (maybeBilingual == null) return '';
    if (typeof maybeBilingual === 'string') return maybeBilingual;
    if (typeof maybeBilingual === 'object') {
      return (
        maybeBilingual[this.language] ??
        maybeBilingual[this.definition.metadata.default_language] ??
        Object.values(maybeBilingual)[0] ??
        ''
      );
    }
    return String(maybeBilingual);
  }

  /**
   * Evaluate a condition expression.
   * Supported examples:
   * - "inventory.has('newborn_daughter')"
   * - "newborn_daughter_health > 0"
   * - "current_location == 'xxx'"
   * - "current_location in ['a','b']"
   * - "player_health <= 0 or sanity <= 0"
   * @param {string} conditionString
   * @returns {boolean}
   */
  evaluateCondition(conditionString) {
    const expr = String(conditionString || '').trim();
    if (!expr) return true;

    // Build a minimal sandbox context.
    const ctx = this._buildEvalContext();
    const jsExpr = this._translateConditionToJs(expr);

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('ctx', `with (ctx) { return (${jsExpr}); }`);
      return Boolean(fn(ctx));
    } catch (err) {
      console.warn('[engine] Failed to evaluate condition:', expr, '->', jsExpr, err);
      return false;
    }
  }

  _buildEvalContext() {
    const engine = this;
    const vars = {};
    for (const [k, v] of Object.entries(this.gameState.variables)) vars[k] = v.value;
    const currentLoc = this.getFullLocationData(this.gameState.current_location);
    const locationHas = (itemId) => {
      const contents = Array.isArray(currentLoc?.contents) ? currentLoc.contents : [];
      return contents.includes(String(itemId));
    };
    const maxCap = Number(this.gameState.variables.inventory?.max_capacity ?? this.definition.variables?.inventory?.max_capacity ?? 9999);
    const inventoryObj = {
      ...this._evalContext.inventory,
      add: (itemId) => this.inventory.add(String(itemId)),
      remove: (itemId) => this.inventory.remove(String(itemId)),
      get length() {
        return Array.isArray(engine.gameState.inventory) ? engine.gameState.inventory.length : 0;
      },
      get max_capacity() {
        return maxCap;
      }
    };
    return {
      ...vars,
      current_location: this.gameState.current_location,
      game_turn: this.gameState.game_turn,
      inventory: inventoryObj,
      here: { has: locationHas },
      items: {
        ...this.definition.items,
        takeable: (itemId) => Boolean(this.definition.items?.[String(itemId)]?.takeable)
      },
      locations: this.definition.locations || {},
      actors: this.definition.actors || {}
    };
  }

  _translateConditionToJs(expr) {
    let out = expr;
    out = out.replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!');
    // Python-style "x in [a,b]" -> "[a,b].includes(x)"
    out = out.replace(/([A-Za-z_]\w*)\s+in\s+(\[[^\]]*\])/g, (_m, lhs, rhs) => `(${rhs}).includes(${lhs})`);
    // Allow "inventory.has(newborn_daughter)" (unquoted) for convenience -> quote bare identifiers.
    out = out.replace(/inventory\.has\(\s*([A-Za-z_]\w*)\s*\)/g, (_m, id) => `inventory.has('${id}')`);
    // Allow "here.has(newborn_daughter)" (unquoted) for convenience -> quote bare identifiers.
    out = out.replace(/here\.has\(\s*([A-Za-z_]\w*)\s*\)/g, (_m, id) => `here.has('${id}')`);
    return out;
  }

  /**
   * Apply effect(s) to game state.
   * Supports:
   * - "var = true"
   * - "var += 1"
   * - "var -= 1"
   * - "newborn_daughter_health += 1 if inventory.has(newborn_daughter) else 0"
   * @param {string|string[]} effectString
   */
  applyEffect(effectString) {
    const lines = Array.isArray(effectString) ? effectString : String(effectString || '').split('\n');
    for (const raw of lines) {
      const line = String(raw).trim();
      if (!line) continue;
 
      // Support simple engine-affecting calls used by v1.3 actions.
      const call = line.match(/^(inventory)\.(add|remove)\(\s*(['"])(.+?)\3\s*\)\s*$/);
      if (call) {
        const [, , method, , arg] = call;
        if (method === 'add') this.inventory.add(String(arg));
        if (method === 'remove') this.inventory.remove(String(arg));
        continue;
      }

      const condMatch = line.match(/^([A-Za-z_]\w*)\s*([+\-*/]?=)\s*(.+)\s+if\s+(.+)\s+else\s+(.+)$/);
      if (condMatch) {
        const [, varName, op, whenTrue, cond, whenFalse] = condMatch;
        const delta = this.evaluateCondition(cond) ? whenTrue : whenFalse;
        this._applyAssignment(varName, op, delta);
        continue;
      }

      const m = line.match(/^([A-Za-z_]\w*)\s*([+\-*/]?=)\s*(.+)$/);
      if (!m) {
        console.warn('[engine] Unrecognized effect line:', line);
        continue;
      }
      const [, varName, op, rhs] = m;
      this._applyAssignment(varName, op, rhs);
    }
  }

  _applyAssignment(varName, op, rhsExpr) {
    const variable = this.gameState.variables[varName];
    if (!variable) {
      console.warn(`[engine] Effect references unknown variable: ${varName}`);
      return;
    }

    const ctx = this._buildEvalContext();
    let rhsValue;
    try {
      const jsRhs = this._translateConditionToJs(String(rhsExpr));
      // eslint-disable-next-line no-new-func
      const fn = new Function('ctx', `with (ctx) { return (${jsRhs}); }`);
      rhsValue = fn(ctx);
    } catch (err) {
      console.warn('[engine] Failed to evaluate effect RHS:', rhsExpr, err);
      rhsValue = parseScalar(String(rhsExpr));
    }

    const prev = variable.value;
    let next = rhsValue;
    if (op === '+=') next = Number(prev) + Number(rhsValue);
    if (op === '-=') next = Number(prev) - Number(rhsValue);
    if (op === '*=') next = Number(prev) * Number(rhsValue);
    if (op === '/=') next = Number(prev) / Number(rhsValue);

    variable.value = this._coerceAndClamp(variable, next);
    if (varName === 'game_turn') this.gameState.game_turn = Number(variable.value) || 0;
    if (varName === 'inventory' && Array.isArray(variable.value)) this.gameState.inventory = variable.value;
  }

  _coerceAndClamp(variable, value) {
    const type = String(variable.type || 'any');
    let v = value;
    if (type === 'int') v = Number(v);
    if (type === 'bool') v = Boolean(v);
    if (type === 'string') v = String(v);
    if (type === 'list' && !Array.isArray(v)) v = Array.isArray(variable.value) ? variable.value : [];

    if (type === 'int') {
      if (Number.isNaN(v)) v = 0;
      if (typeof variable.min_value === 'number') v = Math.max(variable.min_value, v);
      if (typeof variable.max_value === 'number') v = Math.min(variable.max_value, v);
    }
    if (type === 'string' && Array.isArray(variable.possible_values) && variable.possible_values.length) {
      if (!variable.possible_values.includes(v)) {
        console.warn('[engine] string variable out of possible_values:', v);
      }
    }
    return v;
  }

  /** @param {string} locationId */
  getFullLocationData(locationId) {
    return this.definition.locations?.[locationId] || null;
  }

  /** @param {string} locationId */
  getLocationDescription(locationId) {
    const loc = this.getFullLocationData(locationId);
    if (!loc) return '';
    const base = this._pickLang(loc.description?.base);
    const parts = [base].filter(Boolean);
    const conds = loc.description?.conditions;
    if (Array.isArray(conds)) {
      for (const c of conds) {
        const ok = this.evaluateCondition(c?.if || '');
        if (ok) parts.push(this._pickLang(c?.text));
      }
    }
    return parts.filter(Boolean).join('\n');
  }

  renderCurrentLocation() {
    const locationId = this.gameState.current_location;
    const loc = this.getFullLocationData(locationId);
    if (!loc) return;

    const imgEl = document.getElementById('room-img');
    const images = Array.isArray(loc.images) ? loc.images : [];
    if (imgEl) {
      if (images.length) {
        this.resolveAssetUrl(images[0]).then((url) => {
          if (!url) {
            imgEl.style.display = 'none';
            return;
          }
          imgEl.src = url;
        });
        imgEl.onload = () => {
          imgEl.style.display = 'block';
        };
        imgEl.onerror = () => {
          imgEl.style.display = 'none';
        };
      } else {
        imgEl.style.display = 'none';
      }
    }

    const desc = this.getLocationDescription(locationId);
    this.hooks.onOutput?.(desc);
    this._renderInventory();
    this._renderMind();
    this._renderMemory();
    this.hooks.onLocationRender?.(locationId);
  }

  _renderInventory() {
    const inventoryList = document.getElementById('inventory-list');
    if (!inventoryList) return;
    while (inventoryList.firstChild) inventoryList.removeChild(inventoryList.firstChild);

    for (const itemId of this.gameState.inventory) {
      const item = this.definition.items?.[itemId];
      const li = document.createElement('li');

      const images = Array.isArray(item?.images) ? item.images : [];
      if (images.length > 0) {
        const img = document.createElement('img');
        img.className = 'inventory-item-img';
        img.alt = '';
        this.resolveAssetUrl(images[0]).then((url) => {
          if (url) img.src = url;
        });
        img.onerror = () => { img.style.display = 'none'; };
        li.appendChild(img);
      }

      const span = document.createElement('span');
      span.textContent = item ? this._pickLang(item.name) : itemId;
      li.appendChild(span);

      makeWordsClickable(li);
      inventoryList.appendChild(li);
    }
    this.hooks.onInventoryRender?.();
  }
 
  _renderMind() {
    const lines = [];
    const health = this.gameState.variables.player_health?.value;
    const sanity = this.gameState.variables.sanity?.value;
    const timeOfDay = this.gameState.variables.time_of_day?.value;
    const turn = this.gameState.game_turn;
    if (health !== undefined) lines.push(`Health: ${health}`);
    if (sanity !== undefined) lines.push(`Sanity: ${sanity}`);
    if (timeOfDay !== undefined) lines.push(`Time: ${timeOfDay}`);
    lines.push(`Turn: ${turn}`);
    setText('mind-panel', lines.join('\n'));
  }

  _renderMemory() {
    const el = document.getElementById('memory-list');
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);

    const words = this._getMemoryWords();
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
  }

  /** @param {'north'|'south'|'east'|'west'} direction */
  go(direction) {
    const loc = this.getFullLocationData(this.gameState.current_location);
    const next = loc?.exits?.[direction];
    if (!next) {
      this.hooks.onOutput?.(`You can't go ${direction}.`);
      return false;
    }
    if (!this.definition.locations?.[next]) {
      console.warn('[engine] Exit points to unknown location:', next);
      this.hooks.onOutput?.(`You can't go ${direction}.`);
      return false;
    }
    this.gameState.current_location = next;
    this._afterTurn({ kind: 'move', direction, location: next });
    return true;
  }

  /** @param {string} eventId */
  triggerEvent(eventId) {
    const ev = (this.definition.events || []).find(e => e?.id === eventId);
    if (!ev) {
      console.warn('[engine] triggerEvent: unknown event id:', eventId);
      return false;
    }
    this._executeEvent(ev);
    return true;
  }

  _executeEvent(ev) {
    const conds = Array.isArray(ev.conditions) ? ev.conditions : [];
    for (const c of conds) {
      if (!this.evaluateCondition(String(c))) return false;
    }
    if (ev.effect) this.applyEffect(ev.effect);
    const msg = this._pickLang(ev.message);
    if (msg) this.hooks.onOutput?.(msg);
    return true;
  }

  _runEventsForAction(action) {
    const events = Array.isArray(this.definition.events) ? this.definition.events : [];
    for (const ev of events) {
      if (!ev || !ev.type) continue;
      if (ev.type === 'recurring') {
        const interval = Number(ev.interval || 0);
        if (interval > 0 && this.gameState.game_turn % interval === 0) this._executeEvent(ev);
      }
      if (ev.type === 'time_based') {
        if (ev.trigger_when && this.evaluateCondition(String(ev.trigger_when))) this._executeEvent(ev);
      }
      if (ev.type === 'location_enter') {
        if (action?.kind === 'move' && String(ev.location) === this.gameState.current_location) this._executeEvent(ev);
      }
    }
  }

  _checkEndConditions() {
    const ends = this.definition.end_conditions || {};
    const lose = Array.isArray(ends.lose) ? ends.lose : [];
    const win = Array.isArray(ends.win) ? ends.win : [];

    for (const e of lose) {
      if (e?.condition && this.evaluateCondition(String(e.condition))) {
        const msg = this._pickLang(e.message) || this.getText('death_player');
        this.hooks.onOutput?.(msg);
        return { type: 'lose', id: e.id || 'lose' };
      }
    }
    for (const e of win) {
      if (e?.condition && this.evaluateCondition(String(e.condition))) {
        const msg = this._pickLang(e.message);
        if (msg) this.hooks.onOutput?.(msg);
        return { type: 'win', id: e.id || 'win' };
      }
    }
    return null;
  }

  _afterTurn(action) {
    // Turn bookkeeping
    if (this.gameState.variables.game_turn) {
      this.applyEffect('game_turn += 1');
    } else {
      this.gameState.game_turn += 1;
    }

    // Location-enter + recurring + time-based
    this._runEventsForAction(action);

    // Render and end checks
    this.renderCurrentLocation();
    this._checkEndConditions();
  }
}

// ---------------------------
// UI bootstrap & file picker
// ---------------------------

const DIRECTION_MAP = { up: 'north', down: 'south', left: 'west', right: 'east' };

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('direction-btn')) {
    const direction = e.target.getAttribute('data-direction');
    const mapped = DIRECTION_MAP[direction];
    if (!engine || !mapped) return;
    engine.go(/** @type {any} */ (mapped));
  }
});

document.addEventListener('DOMContentLoaded', () => { 
  setMenuButtonsEnabled(false); 
  setGameControlsEnabled(false); 
  setSidebarTabsEnabled(false); 
  setAdventureTitle('');
  resetUiForNewGame(); 
  setText('text-display', 'Load an adventure to begin.');
 
  // Sidebar tabs wiring (Mind / Inventory / Memory / etc).
  function setSidebarTab(tabName) {
    const panels = {
      mind: document.getElementById('tab-panel-mind'),
      inventory: document.getElementById('tab-panel-inventory'),
      memory: document.getElementById('tab-panel-memory')
    };
    const buttons = {
      mind: document.getElementById('tab-mind'),
      inventory: document.getElementById('tab-inventory'),
      memory: document.getElementById('tab-memory')
    }; 
    for (const [name, panel] of Object.entries(panels)) {
      if (panel) panel.style.display = name === tabName ? 'flex' : 'none';
    }
    for (const [name, btn] of Object.entries(buttons)) {
      if (!btn) continue;
      btn.setAttribute('aria-selected', name === tabName ? 'true' : 'false');
      btn.tabIndex = name === tabName ? 0 : -1;
    }
  }
 
  document.querySelectorAll('#sidebar-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setSidebarTab(btn.getAttribute('data-tab'))); 
  });
  setSidebarTab('mind');
  
  renderCommandBuilder();

  document.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (!target) return;

    if (target.classList.contains('click-word')) {
      if (Date.now() < suppressPromptAddUntilTs) return;
      scheduleAddWordToCommand(target.getAttribute('data-word') || target.textContent || '');
      return;
    }

    if (target.classList.contains('word-token-remove')) {
      const token = target.closest('.word-token');
      const index = Number(token?.getAttribute('data-index'));
      if (Number.isFinite(index) && index >= 0) {
        selectedWords.splice(index, 1);
        renderCommandBuilder();
      }
    }

    const memAction = target.getAttribute('data-action');
    if (memAction === 'mem-remove' || memAction === 'mem-up' || memAction === 'mem-down') {
      if (!engine) return;
      const token = target.closest('.memory-token');
      const index = Number(token?.getAttribute('data-index'));
      if (!Number.isFinite(index) || index < 0) return;
      if (memAction === 'mem-remove') engine.removeMemoryWord(index);
      if (memAction === 'mem-up') engine.moveMemoryWord(index, -1);
      if (memAction === 'mem-down') engine.moveMemoryWord(index, 1);
      return;
    }

    // Click a memory token (not buttons) -> add word to prompt (memory remains unchanged).
    const memToken = target.closest('.memory-token');
    if (memToken && !target.closest('button')) {
      if (!engine) return;
      const word = memToken.querySelector('.word-token-text')?.textContent || '';
      if (!word) return;
      addWordToCommand(word);
    }
  });

  function tryAddMemoryFromElement(el) {
    if (!engine || !el) return;
    const raw = el.getAttribute('data-word') || el.textContent || '';
    engine.addWordToMemory(raw);
  }

  document.addEventListener('dblclick', (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (!target) return;
    if (pendingWordClickTimer) clearTimeout(pendingWordClickTimer);
    pendingWordClickTimer = null;
    suppressPromptAddUntilTs = Date.now() + 400;

    if (target.classList.contains('click-word')) {
      ev.preventDefault();
      ev.stopPropagation();
      return tryAddMemoryFromElement(target);
    }
    if (target.classList.contains('word-token-text') && target.closest('#user-input')) {
      ev.preventDefault();
      ev.stopPropagation();
      return tryAddMemoryFromElement(target);
    }
  });

  // Mobile equivalent for double-click: long-press on a word (~450ms).
  let longPressTimer = null;
  let longPressTarget = null;
  const LONG_PRESS_MS = 450;

  const clearLongPress = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressTarget = null;
  };

  document.addEventListener('pointerdown', (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (!target) return;
    const isClickWord = target.classList.contains('click-word');
    const isPromptWord = target.classList.contains('word-token-text') && Boolean(target.closest('#user-input'));
    if (!isClickWord && !isPromptWord) return;
    longPressTarget = target;
    longPressTimer = setTimeout(() => {
      tryAddMemoryFromElement(longPressTarget);
      suppressPromptAddUntilTs = Date.now() + 700;
      clearLongPress();
    }, LONG_PRESS_MS);
  });
  document.addEventListener('pointerup', clearLongPress);
  document.addEventListener('pointercancel', clearLongPress);
  document.addEventListener('pointermove', (ev) => {
    if (!longPressTarget) return;
    if (Math.abs(ev.movementX) + Math.abs(ev.movementY) > 6) clearLongPress();
  });

  const commandBuilder = document.getElementById('user-input');
  let dragIndex = null;

  commandBuilder?.addEventListener('pointerdown', (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (!target) return;
    if (!target.classList.contains('word-token-handle')) return;
    const token = target.closest('.word-token');
    if (!token) return;
    token.setAttribute('data-drag-armed', 'true');
  });

  commandBuilder?.addEventListener('dragstart', (ev) => {
    const token = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (!token || !token.classList.contains('word-token')) return;
    if (token.getAttribute('data-drag-armed') !== 'true') {
      ev.preventDefault();
      return;
    }
    dragIndex = Number(token.getAttribute('data-index'));
    token.classList.add('dragging');
    ev.dataTransfer?.setData('text/plain', String(dragIndex));
    ev.dataTransfer && (ev.dataTransfer.effectAllowed = 'move');
  });

  commandBuilder?.addEventListener('dragend', (ev) => {
    const token = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (token?.classList.contains('word-token')) {
      token.classList.remove('dragging');
      token.removeAttribute('data-drag-armed');
    }
    dragIndex = null;
  });

  commandBuilder?.addEventListener('dragover', (ev) => {
    if (dragIndex === null) return;
    ev.preventDefault();
    ev.dataTransfer && (ev.dataTransfer.dropEffect = 'move');
  });

  commandBuilder?.addEventListener('drop', (ev) => {
    if (dragIndex === null) return;
    ev.preventDefault();
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    const token = target?.closest('.word-token');
    const dropIndex = Number(token?.getAttribute('data-index'));
    if (!Number.isFinite(dropIndex) || dropIndex < 0) return;
    if (dropIndex === dragIndex) return;

    const [moved] = selectedWords.splice(dragIndex, 1);
    selectedWords.splice(dropIndex, 0, moved);
    renderCommandBuilder();
  });

  // Memory list reorder (vertical only), armed by handle.
  const memoryList = document.getElementById('memory-list');
  let memDragIndex = null;

  memoryList?.addEventListener('pointerdown', (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (!target) return;
    if (!target.classList.contains('word-token-handle')) return;
    const token = target.closest('.memory-token');
    if (!token) return;
    token.setAttribute('data-drag-armed', 'true');
  });

  memoryList?.addEventListener('dragstart', (ev) => {
    const token = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (!token || !token.classList.contains('memory-token')) return;
    if (token.getAttribute('draggable') !== 'true') {
      ev.preventDefault();
      return;
    }
    if (token.getAttribute('data-drag-armed') !== 'true') {
      ev.preventDefault();
      return;
    }
    memDragIndex = Number(token.getAttribute('data-index'));
    token.classList.add('dragging');
    ev.dataTransfer?.setData('text/plain', String(memDragIndex));
    ev.dataTransfer && (ev.dataTransfer.effectAllowed = 'move');
  });

  memoryList?.addEventListener('dragend', (ev) => {
    const token = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (token?.classList.contains('memory-token')) {
      token.classList.remove('dragging');
      token.removeAttribute('data-drag-armed');
    }
    memDragIndex = null;
  });

  memoryList?.addEventListener('dragover', (ev) => {
    if (memDragIndex === null) return;
    ev.preventDefault();
    ev.dataTransfer && (ev.dataTransfer.dropEffect = 'move');
  });

  memoryList?.addEventListener('drop', (ev) => {
    if (memDragIndex === null) return;
    ev.preventDefault();
    if (!engine) return;
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    const token = target?.closest('.memory-token');
    const dropIndex = Number(token?.getAttribute('data-index'));
    if (!Number.isFinite(dropIndex) || dropIndex < 0) return;
    if (dropIndex === memDragIndex) return;
    engine.moveMemoryWord(memDragIndex, dropIndex - memDragIndex);
  });

  const sendBtn = document.getElementById('input-btn-send'); 
  sendBtn?.addEventListener('click', () => { 
    if (!engine) return;
    if (selectedWords.length === 0) return;
    const prompt = selectedWords.join(' ').trim();
    if (!prompt) return;
    appendPlayerPrompt(prompt);
    selectedWords = [];
    renderCommandBuilder();
    engine.processPlayerCommand(prompt); 
  }); 
 
  // File picker helpers (prefers File System Access API when available). 
  const DB_NAME = 'text-adventure-engine';
  const DB_STORE = 'handles';
  const DB_KEY_LAST_ADVENTURE = 'lastAdventureFileHandle';
  const DB_KEY_LAST_ADVENTURE_DIR = 'lastAdventureDirectoryHandle';
  const LS_KEY_LAST_MODE = 'adventureLoadMode';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const store = tx.objectStore(DB_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function idbSet(key, value) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const store = tx.objectStore(DB_STORE);
        const req = store.put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function ensureAdventureDirectoryHandle(startIn) {
    // Try previously saved directory handle first.
    try {
      const saved = await idbGet(DB_KEY_LAST_ADVENTURE_DIR);
      if (saved) return saved;
    } catch {
      // ignore
    }

    if (typeof window.showDirectoryPicker !== 'function') return null;
    const dir = await window.showDirectoryPicker({ startIn });
    try {
      await idbSet(DB_KEY_LAST_ADVENTURE_DIR, dir);
    } catch {
      // ignore
    }
    return dir;
  }

  function joinPath(a, b) {
    const left = String(a || '').replace(/\\/g, '/').replace(/\/+$/g, '');
    const right = String(b || '').replace(/\\/g, '/').replace(/^\/+/g, '');
    if (!left) return right;
    if (!right) return left;
    return `${left}/${right}`;
  }

  function splitPath(p) {
    return String(p || '')
      .replace(/\\/g, '/')
      .split('/')
      .map(s => s.trim())
      .filter(Boolean);
  }

  async function fileFromDir(dirHandle, relPath) {
    const parts = splitPath(relPath);
    let cur = dirHandle;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        return await cur.getFileHandle(part, { create: false });
      }
      cur = await cur.getDirectoryHandle(part, { create: false });
    }
    throw new Error('Invalid asset path');
  }

  function makeAssetsResolver(dirHandle, assetsPath) {
    const base = String(assetsPath || '').trim();
    return async (relativePath) => {
      const combined = joinPath(base, relativePath);
      const fileHandle = await fileFromDir(dirHandle, combined);
      const file = await fileHandle.getFile();
      return URL.createObjectURL(file);
    };
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.yaml,.yml,text/yaml';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  async function loadAdventureFromFile(file, handleForRemember, dirHandleForAssets) {
    const yamlText = await file.text();
    const parsed = parseYaml(yamlText);

    const assetsPath = String(parsed?.metadata?.assets_path || 'assets/');
    const assetsResolver = dirHandleForAssets ? makeAssetsResolver(dirHandleForAssets, assetsPath) : null;
    // When not using a directory handle (no FS Access API), fall back to serving from site root.
    const assetsBase = assetsResolver ? '' : assetsPath;

    engine = new GameEngine(parsed, {
      assetsBase,
      assetsResolver,
      onOutput: appendOutput
    });
    setAdventureTitle(parsed?.metadata?.title || file.name);
    setMenuButtonsEnabled(true);
    setGameControlsEnabled(true);
    setSidebarTabsEnabled(true);
    resetUiForNewGame();
    const textDisplay = document.getElementById('text-display');
    if (textDisplay) textDisplay.innerHTML = '';
    const intro = engine.getText('intro');
    if (intro) appendOutput(intro);
    engine.renderCurrentLocation();

    if (handleForRemember) {
      try {
        await idbSet(DB_KEY_LAST_ADVENTURE, handleForRemember);
      } catch {
        // ignore
      }
    }
  }

  async function loadAdventureFromUrl(yamlUrl) {
    const absoluteYamlUrl = new URL(String(yamlUrl || ''), window.location.href).toString();
    const res = await fetch(absoluteYamlUrl);
    if (!res.ok) throw new Error(`Failed to load adventure YAML: ${yamlUrl}`);
    const yamlText = await res.text();
    const parsed = parseYaml(yamlText);

    const yamlBaseUrl = new URL('./', absoluteYamlUrl).toString();
    const assetsBaseUrl = new URL(String(parsed?.metadata?.assets_path || 'assets/'), yamlBaseUrl).toString();
    const assetsResolver = async (relativePath) => new URL(String(relativePath || ''), assetsBaseUrl).toString();

    engine = new GameEngine(parsed, {
      assetsBase: '',
      assetsResolver,
      onOutput: appendOutput
    });
    setAdventureTitle(parsed?.metadata?.title || yamlUrl);
    setMenuButtonsEnabled(true);
    setGameControlsEnabled(true);
    setSidebarTabsEnabled(true);
    resetUiForNewGame();
    const textDisplay = document.getElementById('text-display');
    if (textDisplay) textDisplay.innerHTML = '';
    const intro = engine.getText('intro');
    if (intro) appendOutput(intro);
    engine.renderCurrentLocation();
  }

  async function loadManifest() {
    const res = await fetch('adventures/manifest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Web adventures unavailable; try Disk mode.');
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid adventures manifest.');
    return data;
  }

  fileInput.addEventListener('change', async () => { 
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      await loadAdventureFromFile(file, null, null);
    } catch (err) { 
      console.error(err); 
      engine = null; 
      setMenuButtonsEnabled(false); 
      setGameControlsEnabled(false); 
      setSidebarTabsEnabled(false); 
      setAdventureTitle(''); 
      setText('text-display', 'Failed to load adventure file.'); 
    } 
  }); 

  async function pickAdventureFile() {
    if (typeof window.showOpenFilePicker !== 'function') {
      fileInput.click();
      return;
    }

    let startIn = undefined;
    try {
      const lastHandle = await idbGet(DB_KEY_LAST_ADVENTURE);
      if (lastHandle) startIn = lastHandle;
    } catch {
      // ignore
    }

    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      startIn,
      types: [
        {
          description: 'YAML adventures',
          accept: {
            'text/yaml': ['.yaml', '.yml'],
            'application/x-yaml': ['.yaml', '.yml']
          }
        }
      ],
      excludeAcceptAllOption: true
    });
    if (!handle) return;
    let dirHandle = null;
    try {
      dirHandle = await ensureAdventureDirectoryHandle(startIn || handle);
    } catch (err) {
      // User can cancel directory picking; proceed without images.
      console.warn('[engine] Adventure folder not selected; images may not load.', err);
    }
    const file = await handle.getFile();
    await loadAdventureFromFile(file, handle, dirHandle);
  }

  // Modal UI wiring
  const closeBtn = document.getElementById('adventure-modal-close');
  closeBtn?.addEventListener('click', () => setModalVisible(false));
  document.getElementById('adventure-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target?.id === 'adventure-modal-backdrop') setModalVisible(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setModalVisible(false);
  });

  const webPane = document.getElementById('adventure-web-pane');
  const diskPane = document.getElementById('adventure-disk-pane');
  const webSelect = document.getElementById('adventure-web-select');
  const webHint = document.getElementById('adventure-web-hint');
  const diskHint = document.getElementById('adventure-disk-hint');
  const webLoadBtn = document.getElementById('adventure-web-load');
  const diskLoadBtn = document.getElementById('adventure-disk-load');

  function setMode(mode) {
    localStorage.setItem(LS_KEY_LAST_MODE, mode);
    const webRadio = document.querySelector('input[name="adventure-load-mode"][value="web"]');
    const diskRadio = document.querySelector('input[name="adventure-load-mode"][value="disk"]');
    if (webRadio) webRadio.checked = mode === 'web';
    if (diskRadio) diskRadio.checked = mode === 'disk';
    if (webPane) webPane.style.display = mode === 'web' ? 'flex' : 'none';
    if (diskPane) diskPane.style.display = mode === 'disk' ? 'flex' : 'none';
  }

  document.querySelectorAll('input[name="adventure-load-mode"]').forEach((el) => {
    el.addEventListener('change', () => setMode(el.value));
  });

  async function populateManifestUi() {
    if (!webSelect) return;
    webSelect.innerHTML = '';
    if (webHint) webHint.textContent = 'Loading…';
    try {
      const manifest = await loadManifest();
      for (const entry of manifest) {
        const opt = document.createElement('option');
        opt.value = entry.yaml;
        opt.textContent = entry.title || entry.id || entry.yaml;
        webSelect.appendChild(opt);
      }
      if (webHint) webHint.textContent = '';
    } catch (err) {
      if (webHint) webHint.textContent = String(err?.message || err);
      console.error(err);
    }
  }

  webLoadBtn?.addEventListener('click', async () => { 
    const yamlUrl = webSelect?.value;
    if (!yamlUrl) return;
    try {
      await loadAdventureFromUrl(yamlUrl);
      setModalVisible(false);
    } catch (err) { 
      console.error(err); 
      setMenuButtonsEnabled(false); 
      setGameControlsEnabled(false); 
      setSidebarTabsEnabled(false); 
      if (webHint) webHint.textContent = 'Failed to load web adventure.'; 
    } 
  }); 

  diskLoadBtn?.addEventListener('click', async () => { 
    try {
      if (typeof window.showOpenFilePicker !== 'function') {
        if (diskHint) diskHint.textContent = "Disk mode can’t load images in this browser; use Web mode or a Chromium-based browser.";
        fileInput.click();
        return;
      }
      await pickAdventureFile();
      setModalVisible(false);
    } catch (err) { 
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return; 
      console.error(err); 
      setMenuButtonsEnabled(false); 
      setGameControlsEnabled(false); 
      setSidebarTabsEnabled(false); 
      if (diskHint) diskHint.textContent = 'Failed to load disk adventure.'; 
    } 
  }); 

  document.getElementById('menu-btn-load-adventure')?.addEventListener('click', async () => {
    const lastMode = localStorage.getItem(LS_KEY_LAST_MODE) || 'web';
    setMode(lastMode);
    setModalVisible(true);
    if (lastMode === 'web') await populateManifestUi();
    if (lastMode === 'disk' && typeof window.showOpenFilePicker !== 'function') {
      if (diskHint) diskHint.textContent = "Disk mode can’t load images in this browser; use Web mode or a Chromium-based browser.";
    } else if (diskHint) {
      diskHint.textContent = '';
    }
  });

  document.getElementById('menu-btn-reset-game')?.addEventListener('click', () => { 
    if (!engine) return; 
    const def = engine.definition; 
    engine = new GameEngine(def, { assetsBase: engine.assetsBase, onOutput: appendOutput }); 
    resetUiForNewGame(); 
    const textDisplay = document.getElementById('text-display');
    if (textDisplay) textDisplay.innerHTML = '';
    const intro = engine.getText('intro'); 
    if (intro) appendOutput(intro); 
    engine.renderCurrentLocation(); 
    setMenuButtonsEnabled(true); 
    setGameControlsEnabled(true); 
    setSidebarTabsEnabled(true); 
  }); 
}); 
