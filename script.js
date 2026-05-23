// Text Adventure Engine (v1.2+) - Main game script
// One-file, modular-ish layout: YAML loader -> validation -> engine state -> actions/events -> UI hooks.

/** @typedef {'en'|'pt-br'|string} LanguageCode */

let engine = null;

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

function setAdventureTitle(title) {
  setText('adventure-title-row', title || '');
}

function resetUiForNewGame() {
  clearEl('inventory-list');
  const imgEl = document.getElementById('room-img');
  if (imgEl) {
    imgEl.style.display = 'none';
    imgEl.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  }
}

/**
 * Append text output to the game log.
 * @param {string} text
 */
function appendOutput(text) {
  const el = document.getElementById('text-display');
  if (!el) return;
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  el.textContent = (el.textContent ? `${el.textContent}\n\n${normalized}` : normalized);
  el.scrollTop = el.scrollHeight;
}

// ---------------------------
// YAML parsing (tolerant subset)
// ---------------------------

function countIndent(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function stripComments(line) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '#' && !inSingle && !inDouble) break;
    out += ch;
  }
  return out;
}

function splitTopLevelComma(input) {
  const parts = [];
  let buf = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        parts.push(buf.trim());
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'null' || v === 'Null' || v === 'NULL' || v === '~') return null;
  if (v === 'true' || v === 'True' || v === 'TRUE') return true;
  if (v === 'false' || v === 'False' || v === 'FALSE') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelComma(inner).map(s => parseScalar(s));
  }
  if (v.startsWith('{') && v.endsWith('}')) {
    return parseInlineMap(v);
  }
  return v;
}

function parseInlineMap(v) {
  const inner = v.trim().slice(1, -1).trim();
  const obj = {};
  if (!inner) return obj;
  for (const part of splitTopLevelComma(inner)) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    obj[key] = parseScalar(val);
  }
  return obj;
}

function looksLikeInlineMapWithoutBraces(rest) {
  // Tolerant: "en: 'X', pt-br: 'Y' }" (seen in reference file once).
  const s = rest.trim();
  if (!s.includes(':')) return false;
  // Must contain a comma separating pairs OR multiple colons.
  const comma = s.includes(',');
  const colonCount = (s.match(/:/g) || []).length;
  return comma || colonCount >= 2;
}

function parseInlineMapWithoutBraces(rest) {
  const cleaned = rest.trim().replace(/}\s*$/, '').trim();
  const obj = {};
  for (const part of splitTopLevelComma(cleaned)) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    obj[key] = parseScalar(val);
  }
  return obj;
}

/**
 * Parse a YAML text adventure definition (subset + a few tolerant extensions).
 * Supports:
 * - mappings by indentation
 * - sequences by indentation
 * - inline arrays/maps: [a, b], { en: "x", pt-br: "y" }
 * - block scalars with "|" and ">"
 * @param {string} text
 * @returns {any}
 */
function parseYaml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const root = {};
  const stack = [{ indent: -1, container: root, type: 'object' }];

  const currentFrame = () => stack[stack.length - 1];

  function peekNextNonEmpty(fromIdx) {
    for (let j = fromIdx; j < lines.length; j++) {
      const peek = stripComments(lines[j]);
      if (peek.trim()) return { raw: peek, indent: countIndent(peek), text: peek.trim(), idx: j };
    }
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = stripComments(lines[i]);
    if (!rawLine.trim()) continue;

    const indent = countIndent(rawLine);
    const line = rawLine.trim();

    while (stack.length > 1 && currentFrame().indent >= indent) stack.pop();
    const frame = currentFrame();

    // Sequence item
    if (line.startsWith('- ')) {
      if (frame.type !== 'array') {
        throw new Error(`YAML parse error near line ${i + 1}: unexpected sequence item`);
      }
      const itemText = line.slice(2).trim();
      if (!itemText) {
        const obj = {};
        frame.container.push(obj);
        stack.push({ indent, container: obj, type: 'object' });
        continue;
      }

      const kv = itemText.match(/^([^:]+):\s*(.*)$/);
      if (kv) {
        const obj = {};
        const k = kv[1].trim();
        const rest = kv[2];
        if (rest === '|' || rest === '>') {
          const blockIndentBase = indent + 2;
          const chunks = [];
          let j = i + 1;
          while (j < lines.length) {
            const raw = lines[j];
            if (!raw.trim()) {
              chunks.push('');
              j++;
              continue;
            }
            const ind = countIndent(raw);
            if (ind < blockIndentBase) break;
            chunks.push(raw.slice(blockIndentBase));
            j++;
          }
          obj[k] = rest === '>' ? chunks.join(' ').trim() : chunks.join('\n');
          frame.container.push(obj);
          i = j - 1;
          continue;
        }

        obj[k] = rest === '' ? {} : parseScalar(rest);
        frame.container.push(obj);

        // If this list item continues on following indented lines, push the item object onto the stack.
        // Example:
        //   - id: baby_cries
        //     type: recurring
        const next = peekNextNonEmpty(i + 1);
        if (next && next.indent > indent) {
          // When "- key:" created a nested container, keep parsing inside that container.
          if (rest === '') {
            const nextIsArray = next.text.startsWith('- ') && next.indent > indent;
            obj[k] = nextIsArray ? [] : {};
            stack.push({ indent, container: obj[k], type: nextIsArray ? 'array' : 'object' });
          } else {
            stack.push({ indent, container: obj, type: 'object' });
          }
        }
      } else {
        frame.container.push(parseScalar(itemText));
      }
      continue;
    }

    // Key: value
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const rest = match[2];

    if (frame.type !== 'object') {
      throw new Error(`YAML parse error near line ${i + 1}: mapping inside sequence not supported here`);
    }

    if (rest === '|' || rest === '>') {
      const blockIndentBase = indent + 2;
      const chunks = [];
      let j = i + 1;
      while (j < lines.length) {
        const raw = lines[j];
        if (!raw.trim()) {
          chunks.push('');
          j++;
          continue;
        }
        const ind = countIndent(raw);
        if (ind < blockIndentBase) break;
        chunks.push(raw.slice(blockIndentBase));
        j++;
      }
      frame.container[key] = rest === '>' ? chunks.join(' ').trim() : chunks.join('\n');
      i = j - 1;
      continue;
    }

    if (rest === '') {
      const next = peekNextNonEmpty(i + 1);
      const nextIsArray = next && next.text.startsWith('- ') && next.indent > indent;
      frame.container[key] = nextIsArray ? [] : {};
      stack.push({ indent, container: frame.container[key], type: nextIsArray ? 'array' : 'object' });
      continue;
    }

    // Tolerant: inline map missing braces.
    if (looksLikeInlineMapWithoutBraces(rest) && !rest.trim().startsWith('{')) {
      frame.container[key] = parseInlineMapWithoutBraces(rest);
      continue;
    }

    frame.container[key] = parseScalar(rest);
  }

  return root;
}

// ---------------------------
// Definition validation
// ---------------------------

function assertSection(cond, message) {
  if (!cond) throw new Error(message);
}

function validateDefinition(def) {
  assertSection(def && typeof def === 'object', 'Invalid YAML root object');
  assertSection(def.metadata && typeof def.metadata === 'object', 'Missing `metadata` section');
  assertSection(typeof def.metadata.title === 'string', '`metadata.title` must be a string');
  assertSection(def.metadata.default_language, '`metadata.default_language` is required');
  assertSection(def.variables && typeof def.variables === 'object', 'Missing `variables` section');
  assertSection(def.locations && typeof def.locations === 'object', 'Missing `locations` section');
  assertSection(def.actors && typeof def.actors === 'object', 'Missing `actors` section');
  assertSection(def.actors.protagonist && typeof def.actors.protagonist === 'object', 'Missing `actors.protagonist`');
  assertSection(typeof def.actors.protagonist.starting_location === 'string', '`actors.protagonist.starting_location` is required');
  assertSection(def.locations[def.actors.protagonist.starting_location], 'Starting location not found in `locations`');

  // Inventory variable is strongly recommended in v1.2
  if (!def.variables.inventory) console.warn('[engine] `variables.inventory` missing; inventory features will be limited.');
  if (!def.strings || typeof def.strings !== 'object') console.warn('[engine] `strings` missing; intro/death messages may not render.');
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

    // A small helper object exposed to condition/effect evaluation.
    this._evalContext = {
      inventory: {
        has: (itemId) => this.inventory.has(String(itemId))
      }
    };
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
    const vars = {};
    for (const [k, v] of Object.entries(this.gameState.variables)) vars[k] = v.value;
    return {
      ...vars,
      current_location: this.gameState.current_location,
      game_turn: this.gameState.game_turn,
      inventory: this._evalContext.inventory
    };
  }

  _translateConditionToJs(expr) {
    let out = expr;
    out = out.replace(/\band\b/g, '&&').replace(/\bor\b/g, '||').replace(/\bnot\b/g, '!');
    // Python-style "x in [a,b]" -> "[a,b].includes(x)"
    out = out.replace(/([A-Za-z_]\w*)\s+in\s+(\[[^\]]*\])/g, (_m, lhs, rhs) => `(${rhs}).includes(${lhs})`);
    // Allow "inventory.has(newborn_daughter)" (unquoted) for convenience -> quote bare identifiers.
    out = out.replace(/inventory\.has\(\s*([A-Za-z_]\w*)\s*\)/g, (_m, id) => `inventory.has('${id}')`);
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
    this.hooks.onLocationRender?.(locationId);
  }

  _renderInventory() {
    const inventoryList = document.getElementById('inventory-list');
    if (!inventoryList) return;
    while (inventoryList.firstChild) inventoryList.removeChild(inventoryList.firstChild);

    for (const itemId of this.gameState.inventory) {
      const item = this.definition.items?.[itemId];
      const li = document.createElement('li');
      li.textContent = item ? this._pickLang(item.name) : itemId;
      inventoryList.appendChild(li);
    }
    this.hooks.onInventoryRender?.();
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

  /**
   * Process a player command (text parser will be expanded later).
   * Currently supports: north/south/east/west, go <dir>, take <item>, drop <item>, use <item>, consume <item>
   * @param {string} input
   */
  processPlayerCommand(input) {
    const raw = String(input || '').trim();
    if (!raw) return;
    const cmd = raw.toLowerCase();

    const dirs = ['north', 'south', 'east', 'west'];
    if (dirs.includes(cmd)) return this.go(/** @type {any} */ (cmd));
    if (cmd.startsWith('go ')) {
      const d = cmd.slice(3).trim();
      if (dirs.includes(d)) return this.go(/** @type {any} */ (d));
    }

    const take = cmd.match(/^(take|get)\s+(.+)$/);
    if (take) return this._takeItemByName(take[2]);
    const drop = cmd.match(/^drop\s+(.+)$/);
    if (drop) return this._dropItemByName(drop[1]);
    const use = cmd.match(/^use\s+(.+)$/);
    if (use) return this._verbItemByName('use', use[1]);
    const consume = cmd.match(/^(consume|eat|drink)\s+(.+)$/);
    if (consume) return this._consumeItemByName(consume[2]);

    this.hooks.onOutput?.("Command not understood (parser not implemented yet).");
    this._afterTurn({ kind: 'noop' });
  }

  _findItemIdByName(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    // Allow direct id
    if (this.definition.items?.[q]) return q;
    for (const [id, item] of Object.entries(this.definition.items || {})) {
      const n = this._pickLang(item?.name).toLowerCase();
      if (n === q) return id;
    }
    return null;
  }

  _takeItemByName(query) {
    const itemId = this._findItemIdByName(query);
    if (!itemId) {
      this.hooks.onOutput?.("You don't see that here.");
      this._afterTurn({ kind: 'take' });
      return false;
    }
    const loc = this.getFullLocationData(this.gameState.current_location);
    const contents = Array.isArray(loc?.contents) ? loc.contents : [];
    if (!contents.includes(itemId)) {
      this.hooks.onOutput?.("You don't see that here.");
      this._afterTurn({ kind: 'take' });
      return false;
    }
    if (!this.inventory.canAdd(itemId)) {
      this.hooks.onOutput?.('You cannot carry any more.');
      this._afterTurn({ kind: 'take' });
      return false;
    }
    this.inventory.add(itemId);
    loc.contents = contents.filter(x => x !== itemId);
    this.hooks.onOutput?.(`You take the ${this._pickLang(this.definition.items?.[itemId]?.name) || itemId}.`);
    this._afterTurn({ kind: 'take', itemId });
    return true;
  }

  _dropItemByName(query) {
    const itemId = this._findItemIdByName(query);
    if (!itemId || !this.inventory.has(itemId)) {
      this.hooks.onOutput?.("You're not carrying that.");
      this._afterTurn({ kind: 'drop' });
      return false;
    }
    this.inventory.remove(itemId);
    const loc = this.getFullLocationData(this.gameState.current_location);
    if (!Array.isArray(loc.contents)) loc.contents = [];
    loc.contents.push(itemId);

    const item = this.definition.items?.[itemId];
    if (item?.on_drop?.effect) this.applyEffect(item.on_drop.effect);
    const msg = this._pickLang(item?.on_drop?.message);
    this.hooks.onOutput?.(msg || `You drop the ${this._pickLang(item?.name) || itemId}.`);
    this._afterTurn({ kind: 'drop', itemId });
    return true;
  }

  _consumeItemByName(query) {
    const itemId = this._findItemIdByName(query);
    const item = itemId ? this.definition.items?.[itemId] : null;
    if (!itemId || !this.inventory.has(itemId)) {
      this.hooks.onOutput?.("You're not carrying that.");
      this._afterTurn({ kind: 'consume' });
      return false;
    }
    if (!item?.consumable) {
      this.hooks.onOutput?.("You can't consume that.");
      this._afterTurn({ kind: 'consume', itemId });
      return false;
    }
    if (item?.on_consume?.effect) this.applyEffect(item.on_consume.effect);
    const msg = this._pickLang(item?.on_consume?.message);
    if (msg) this.hooks.onOutput?.(msg);
    this.inventory.remove(itemId);
    this._afterTurn({ kind: 'consume', itemId });
    return true;
  }

  _verbItemByName(verb, query) {
    const itemId = this._findItemIdByName(query);
    if (!itemId) {
      this.hooks.onOutput?.("You don't have that.");
      this._afterTurn({ kind: 'verb', verb });
      return false;
    }
    const item = this.definition.items?.[itemId];
    const verbDef = item?.verbs?.[verb];
    if (!verbDef) {
      this.hooks.onOutput?.("Nothing happens.");
      this._afterTurn({ kind: 'verb', verb, itemId });
      return false;
    }

    const rules = Array.isArray(verbDef.conditions) ? verbDef.conditions : [];
    for (const rule of rules) {
      const ok = this.evaluateCondition(rule?.if || '');
      if (!ok) continue;
      if (rule?.effect) this.applyEffect(rule.effect);
      const msg = this._pickLang(rule?.message);
      if (msg) this.hooks.onOutput?.(msg);
      this._afterTurn({ kind: 'verb', verb, itemId });
      return true;
    }

    this.hooks.onOutput?.("Nothing happens.");
    this._afterTurn({ kind: 'verb', verb, itemId });
    return false;
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
  setAdventureTitle('');
  resetUiForNewGame();
  setText('text-display', 'Load an adventure to begin.');

  // Bind user input -> command processing (basic stub).
  const userInput = document.getElementById('user-input');
  userInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const value = userInput.value;
      userInput.value = '';
      if (!engine) return;
      appendOutput(`> ${value.trim()}`);
      engine.processPlayerCommand(value);
    }
  });

  // File picker helpers (prefers File System Access API when available).
  const DB_NAME = 'text-adventure-engine';
  const DB_STORE = 'handles';
  const DB_KEY_LAST_ADVENTURE = 'lastAdventureFileHandle';
  const DB_KEY_LAST_ADVENTURE_DIR = 'lastAdventureDirectoryHandle';

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
    resetUiForNewGame();
    setText('text-display', '');
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
    const dirHandle = await ensureAdventureDirectoryHandle(startIn || handle);
    const file = await handle.getFile();
    await loadAdventureFromFile(file, handle, dirHandle);
  }

  document.getElementById('menu-btn-load-adventure')?.addEventListener('click', async () => {
    try {
      await pickAdventureFile();
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
      console.error(err);
      engine = null;
      setMenuButtonsEnabled(false);
      setAdventureTitle('');
      setText('text-display', 'Failed to load adventure file.');
    }
  });

  document.getElementById('menu-btn-reset-game')?.addEventListener('click', () => {
    if (!engine) return;
    const def = engine.definition;
    engine = new GameEngine(def, { assetsBase: engine.assetsBase, onOutput: appendOutput });
    resetUiForNewGame();
    setText('text-display', '');
    const intro = engine.getText('intro');
    if (intro) appendOutput(intro);
    engine.renderCurrentLocation();
  });
});
