// ---------------------------
// Engine implementation
// ---------------------------

class InventorySystem {
  /** @param {GameEngine} engine */
  constructor(engine) {
    this.engine = engine;
  }

  get maxCapacity() {
    const actorId = this.engine._getPlayerActorId();
    const actorDef = this.engine.definition.actors?.[actorId];
    return Number(actorDef?.max_capacity ?? 9999);
  }

  get items() {
    const actorId = this.engine._getPlayerActorId();
    return this.engine.gameState.actors_data?.[actorId]?.inventory ?? [];
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
   *   language?: LanguageCode,
   *   onOutput?: (text:string)=>void,
   *   onLocationNameRender?: (name:string)=>void,
   *   onLocationRender?: (locationId:string)=>void,
   *   onInventoryRender?: ()=>void,
   *   onRoomImageRender?: (url:string|null)=>void,
   *   onMindRender?: ()=>void,
   *   onMemoryRender?: ()=>void,
   *   onDebugRender?: ()=>void
   * }} hooks
   */
  constructor(definition, hooks = {}) {
    validateDefinition(definition);
    this.definition = definition;
    this.hooks = hooks;
    this.assetsBase = hooks.assetsBase || '';
    this.assetsResolver = typeof hooks.assetsResolver === 'function' ? hooks.assetsResolver : null;
    this.language = /** @type {LanguageCode} */ (hooks.language || definition.metadata.default_language || 'en');

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
    const val = this.gameState.variables.current_player_actor?.value;
    if (Array.isArray(val) && val.length) return String(val[0]);
    if (typeof val === 'string') return val;
    return 'protagonist';
  }

  _addKnownLocation(actorId, locationId) {
    const data = this.gameState.actors_data?.[actorId];
    if (!data) return;
    if (!Array.isArray(data.known_locations)) data.known_locations = [];
    if (!data.known_locations.includes(locationId)) data.known_locations.push(locationId);
  }

  _buildMapGrid(knownLocationIds) {
    const set = new Set(knownLocationIds);
    const DIR = {
      north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
      northeast: [1, -1], northwest: [-1, -1], southeast: [1, 1], southwest: [-1, 1]
    };
    const startId = this.gameState.current_location;
    if (!set.has(startId)) return [];

    const coords = {};
    coords[startId] = { x: 0, y: 0 };
    const queue = [startId];
    const visited = new Set();

    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      const pos = coords[id];
      const locDef = this.definition.locations?.[id];
      if (!locDef?.exits) continue;

      for (const [dir, target] of Object.entries(locDef.exits)) {
        const offset = DIR[dir];
        if (!offset) continue;
        const neighbor = typeof target === 'string' ? target : target?.location;
        if (!neighbor || !set.has(neighbor)) continue;
        if (neighbor in coords) continue;
        coords[neighbor] = { x: pos.x + offset[0], y: pos.y + offset[1] };
        queue.push(neighbor);
      }
    }

    const result = [];
    for (const id of knownLocationIds) {
      const c = coords[id];
      if (!c) continue;
      const locDef = this.definition.locations?.[id];
      const fullName = this._pickLang(locDef?.name) || id;
      const shortName = fullName.length > 14 ? fullName.substring(0, 12) + '…' : fullName;
      result.push({ id, x: c.x, y: c.y, name: fullName, shortName, isCurrent: id === startId });
    }
    return result;
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
    this.hooks.onMemoryRender?.();
    return true;
  }

  removeMemoryWord(index) {
    const cfg = this._memoryConfig;
    if (!cfg) return false;
    const words = this._getMemoryWords();
    if (!Number.isFinite(index) || index < 0 || index >= words.length) return false;
    words.splice(index, 1);
    this.gameState.variables[cfg.wordsVar].value = words;
    this.hooks.onMemoryRender?.();
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
    this.hooks.onMemoryRender?.();
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
      const rawVal = structuredClone(def?.value);
      const value = rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)
        ? this._pickLang(rawVal)
        : rawVal;
      const base = {
        type,
        min_value: def?.min_value,
        max_value: def?.max_value,
        possible_values: def?.possible_values,
        max_capacity: def?.max_capacity,
        value
      };
      vars[key] = base;
    }

    const startLoc = this.definition.actors.protagonist.starting_location;

    const actorsData = {};
    for (const [actorId, actorDef] of Object.entries(this.definition.actors || {})) {
      actorsData[actorId] = {
        inventory: Array.isArray(actorDef.inventory) ? [...actorDef.inventory] : [],
        known_locations: Array.isArray(actorDef.known_locations) ? [...actorDef.known_locations] : [],
        properties: this._initActorProperties(actorDef.properties || {}),
        relationships: structuredClone(actorDef.relationships || {})
      };
    }

    return {
      current_location: startLoc,
      previous_location: null,
      variables: vars,
      actors_data: actorsData,
      game_turn: Number(vars.game_turn?.value ?? 0),
      flags: {},
      story: {},
      container_contents: this._initContainerContents()
    };
  }

  _initContainerContents() {
    const map = {};
    for (const [id, def] of Object.entries(this.definition.items || {})) {
      if (Array.isArray(def.contents)) map[id] = [...def.contents];
    }
    return map;
  }

  _initActorProperties(actorPropsDef) {
    const result = {};
    for (const [propName, propDef] of Object.entries(this.definition.properties || {})) {
      const rawVal = actorPropsDef?.[propName] ?? propDef.default;
      result[propName] = this._coerceAndClamp({
        type: propDef.type || 'any',
        min_value: propDef.min_value,
        max_value: propDef.max_value,
        possible_values: propDef.possible_values
      }, rawVal);
    }
    for (const [key, val] of Object.entries(actorPropsDef || {})) {
      if (!(key in result)) result[key] = val;
    }
    return result;
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

  /** Resolve a direction alias (ID or synonym) to its canonical ID */
  _resolveDirection(input) {
    const lower = String(input || '').trim().toLowerCase();
    if (!lower) return null;

    const dirs = this.definition.directions;
    if (dirs && typeof dirs === 'object') {
      for (const [dirId, dirDef] of Object.entries(dirs)) {
        if (dirId.toLowerCase() === lower) return dirId;
        if (dirDef?.synonyms) {
          for (const langSyns of Object.values(dirDef.synonyms)) {
            if (Array.isArray(langSyns) && langSyns.some(s => String(s).toLowerCase() === lower)) {
              return dirId;
            }
          }
        }
      }
    }

    const legacy = { north: ['n', 'north'], south: ['s', 'south'], east: ['e', 'east'], west: ['w', 'west'] };
    for (const [dir, aliases] of Object.entries(legacy)) {
      if (dir === lower || aliases.includes(lower)) return dir;
    }

    return null;
  }

  /** If input starts with a go-verb synonym, return the matched verb prefix */
  _matchGoVerb(input) {
    const lower = String(input || '').trim().toLowerCase();
    if (!lower) return null;

    const verbs = new Set(['go']);
    const syns = this.definition.verbs?.go?.synonyms;
    if (syns && typeof syns === 'object') {
      for (const langSyns of Object.values(syns)) {
        if (Array.isArray(langSyns)) {
          langSyns.forEach(s => verbs.add(String(s).toLowerCase()));
        }
      }
    }

    for (const verb of verbs) {
      if (lower === verb || lower.startsWith(verb + ' ')) return verb;
    }
    return null;
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
    const locationHas = (itemId) => engine._itemExistsInLocationScope(itemId);
    const inventoryObj = {
      ...this._evalContext.inventory,
      add: (itemId) => this.inventory.add(String(itemId)),
      remove: (itemId) => this.inventory.remove(String(itemId)),
      get length() {
        const actorId = engine._getPlayerActorId();
        const data = engine.gameState.actors_data?.[actorId];
        return data?.inventory?.length ?? 0;
      },
      get max_capacity() {
        const actorId = engine._getPlayerActorId();
        const actorDef = engine.definition.actors?.[actorId];
        return Number(actorDef?.max_capacity ?? 9999);
      }
    };
    const playerActorId = this._getPlayerActorId();
    const playerData = engine.gameState.actors_data?.[playerActorId] || {};

    return {
      ...vars,
      ...(playerData.properties || {}),
      current_location: this.gameState.current_location,
      game_turn: this.gameState.game_turn,
      inventory: inventoryObj,
      here: { has: locationHas },
      containerHas: (containerId, itemId) => {
        const contents = engine.gameState.container_contents?.[String(containerId)];
        return Array.isArray(contents) && contents.includes(String(itemId));
      },
      items: {
        ...this.definition.items,
        takeable: (itemId) => Boolean(this.definition.items?.[String(itemId)]?.takeable),
        openable: (itemId) => Boolean(this.definition.items?.[String(itemId)]?.openable),
        droppable: (itemId) => {
          const def = engine.definition.items?.[String(itemId)];
          if (def?.droppable !== undefined) return Boolean(def.droppable);
          return def?.takeable === true;
        },
        container_capacity: (itemId) => {
          return engine.definition.items?.[String(itemId)]?.container_capacity ?? Infinity;
        },
        container_count: (itemId) => {
          const c = engine.gameState.container_contents?.[String(itemId)];
          if (!Array.isArray(c)) return 0;
          return c.reduce((sum, childId) => {
            const size = engine.definition.items?.[childId]?.size;
            return sum + (typeof size === 'number' ? size : 1);
          }, 0);
        },
        item_size: (itemId) => {
          return engine.definition.items?.[String(itemId)]?.size ?? 1;
        }
      },
      locations: this.definition.locations || {},
      actors: this.definition.actors || {},
      getActor: (id) => engine.gameState.actors_data?.[id],
      getActorProp: (actorId, propName) =>
        engine.gameState.actors_data?.[actorId]?.properties?.[propName],
      getRelationship: (otherActorId, propName) =>
        playerData.relationships?.[otherActorId]?.[propName],
      getRelationshipBetween: (actorId1, actorId2, propName) =>
        engine.gameState.actors_data?.[actorId1]?.relationships?.[actorId2]?.[propName]
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
    // Allow "containerHas(containerId, itemId)" (unquoted) for convenience -> quote bare identifiers.
    out = out.replace(/containerHas\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)/g, (_m, c, i) => `containerHas('${c}', '${i}')`);
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
      const call = line.match(/^(inventory|here)\.(add|remove)\(\s*(['"])(.+?)\3\s*\)\s*$/);
      if (call) {
        const [, scope, method, , arg] = call;
        if (scope === 'inventory') {
          if (method === 'add') {
            this.inventory.add(String(arg));
            this._removeItemFromWorld(String(arg));
          }
          if (method === 'remove') this.inventory.remove(String(arg));
        } else if (scope === 'here') {
          const loc = this.getFullLocationData(this.gameState.current_location);
          if (!loc) { console.warn('[engine] here.add/remove: no current location'); continue; }
          if (!Array.isArray(loc.contents)) loc.contents = [];
          if (method === 'add') loc.contents.push(String(arg));
          if (method === 'remove') {
            const idx = loc.contents.indexOf(String(arg));
            if (idx !== -1) loc.contents.splice(idx, 1);
          }
        }
        continue;
      }

      // containerAdd('id','item') / containerRemove('id','item') / putInTarget('t','i')
      const containerCall = line.match(/^(containerAdd|containerRemove|putInTarget)\(\s*(['"])(.+?)\2\s*,\s*(['"])(.+?)\4\s*\)\s*$/);
      if (containerCall) {
        const [, func, , arg1, , arg2] = containerCall;
        const id1 = String(arg1);
        const id2 = String(arg2);
        if (func === 'containerAdd') {
          const contents = this.gameState.container_contents[id1] || (this.gameState.container_contents[id1] = []);
          contents.push(id2);
        } else if (func === 'containerRemove') {
          const contents = this.gameState.container_contents[id1];
          if (Array.isArray(contents)) {
            const idx = contents.indexOf(id2);
            if (idx !== -1) contents.splice(idx, 1);
          }
        } else if (func === 'putInTarget') {
          if (id1 === '__location__') {
            const loc = this.getFullLocationData(this.gameState.current_location);
            if (!loc) { console.warn('[engine] putInTarget: no current location'); continue; }
            if (!Array.isArray(loc.contents)) loc.contents = [];
            loc.contents.push(id2);
          } else {
            const contents = this.gameState.container_contents[id1] || (this.gameState.container_contents[id1] = []);
            contents.push(id2);
          }
        }
        continue;
      }

      const condMatch = line.match(/^([A-Za-z_]\w*)\s*([+\-*/]?=)\s*(.+)\s+if\s+(.+)\s+else\s+(.+)$/);
      if (condMatch) {
        const [, varName, op, whenTrue, cond, whenFalse] = condMatch;
        const delta = this.evaluateCondition(cond) ? whenTrue : whenFalse;
        this._applyAssignment(varName, op, delta);
        continue;
      }

      // relationship('otherActorId', 'propName') += value
      const relMatch = line.match(/^relationship\(\s*['"](.+?)['"]\s*,\s*['"](.+?)['"]\s*\)\s*([+\-*/]?=)\s*(.+)$/);
      if (relMatch) {
        const [, otherActorId, propName, op, rhs] = relMatch;
        this._applyRelationshipAssignment(otherActorId, propName, op, rhs);
        continue;
      }

      const m = line.match(/^([A-Za-z_]\w*)\s*([+\-*/]?=)\s*(.+)$/);
      if (!m) {
        console.warn('[engine] Unrecognized effect line:', line);
        continue;
      }
      const [, varName, op, rhs] = m;
      if (this.definition.properties?.[varName]) {
        this._applyActorPropAssignment(varName, op, rhs);
      } else {
        this._applyAssignment(varName, op, rhs);
      }
    }
  }

  _isContainerItemVisible(containerId, itemId) {
    const contDef = this.definition.items?.[containerId];
    const rule = contDef?.contents_visibility?.[itemId];
    if (!rule) return true;
    if (!rule.visible_when) return true;
    return this.evaluateCondition(String(rule.visible_when));
  }

  _getContainerVisibleContents(containerId) {
    const contents = this.gameState.container_contents?.[containerId];
    if (!Array.isArray(contents)) return [];
    return contents.filter(itemId => this._isContainerItemVisible(containerId, itemId));
  }

  _itemExistsInLocationScope(itemId) {
    const id = String(itemId);
    const loc = this.getFullLocationData(this.gameState.current_location);
    const queue = [];
    for (const c of (Array.isArray(loc?.contents) ? loc.contents : [])) {
      queue.push([c, null]);
    }
    const visited = new Set();
    while (queue.length) {
      const [childId, parentId] = queue.shift();
      if (childId === id) return true;
      if (visited.has(childId)) continue;
      visited.add(childId);
      if (parentId && !this._isContainerItemVisible(parentId, childId)) continue;
      const sub = this.gameState.container_contents?.[childId];
      if (Array.isArray(sub)) {
        for (const grandchild of sub) {
          queue.push([grandchild, childId]);
        }
      }
    }
    return false;
  }

  _removeItemFromWorld(itemId) {
    const id = String(itemId);
    const loc = this.getFullLocationData(this.gameState.current_location);
    if (loc && Array.isArray(loc.contents)) {
      const idx = loc.contents.indexOf(id);
      if (idx !== -1) { loc.contents.splice(idx, 1); return; }
    }
    for (const contents of Object.values(this.gameState.container_contents || {})) {
      const idx = contents.indexOf(id);
      if (idx !== -1) { contents.splice(idx, 1); return; }
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
  }

  _applyActorPropAssignment(propName, op, rhsExpr) {
    const actorId = this._getPlayerActorId();
    const actorData = this.gameState.actors_data?.[actorId];
    if (!actorData) return;
    if (!actorData.properties) actorData.properties = {};

    const ctx = this._buildEvalContext();
    let rhsValue;
    try {
      const jsRhs = this._translateConditionToJs(String(rhsExpr));
      const fn = new Function('ctx', `with (ctx) { return (${jsRhs}); }`);
      rhsValue = fn(ctx);
    } catch (err) {
      console.warn('[engine] Failed to evaluate property RHS:', rhsExpr, err);
      rhsValue = parseScalar(String(rhsExpr));
    }

    const prev = actorData.properties[propName] ?? 0;
    let next = rhsValue;
    if (op === '+=') next = Number(prev) + Number(rhsValue);
    if (op === '-=') next = Number(prev) - Number(rhsValue);
    if (op === '*=') next = Number(prev) * Number(rhsValue);
    if (op === '/=') next = Number(prev) / Number(rhsValue);

    const propDef = this.definition.properties?.[propName];
    actorData.properties[propName] = this._coerceAndClamp({
      type: propDef?.type || 'any',
      min_value: propDef?.min_value,
      max_value: propDef?.max_value,
      possible_values: propDef?.possible_values
    }, next);
  }

  _applyRelationshipAssignment(otherActorId, propName, op, rhsExpr) {
    const actorId = this._getPlayerActorId();
    const actorData = this.gameState.actors_data?.[actorId];
    if (!actorData) return;
    if (!actorData.relationships) actorData.relationships = {};
    if (!actorData.relationships[otherActorId]) actorData.relationships[otherActorId] = {};

    const ctx = this._buildEvalContext();
    let rhsValue;
    try {
      const jsRhs = this._translateConditionToJs(String(rhsExpr));
      const fn = new Function('ctx', `with (ctx) { return (${jsRhs}); }`);
      rhsValue = fn(ctx);
    } catch (err) {
      console.warn('[engine] Failed to evaluate relationship RHS:', rhsExpr, err);
      rhsValue = parseScalar(String(rhsExpr));
    }

    const prev = actorData.relationships[otherActorId][propName] ?? 0;
    let next = rhsValue;
    if (op === '+=') next = Number(prev) + Number(rhsValue);
    if (op === '-=') next = Number(prev) - Number(rhsValue);
    if (op === '*=') next = Number(prev) * Number(rhsValue);
    if (op === '/=') next = Number(prev) / Number(rhsValue);

    const propDef = this.definition.properties?.[propName];
    actorData.relationships[otherActorId][propName] = propDef
      ? this._coerceAndClamp({ type: propDef.type, min_value: propDef.min_value, max_value: propDef.max_value, possible_values: propDef.possible_values }, next)
      : next;
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
    const desc = loc.description;
    if (!desc) return '';
    let base;
    if (typeof desc === 'string') {
      base = desc;
    } else if (desc.base !== undefined || Array.isArray(desc.conditions)) {
      base = desc.base ? this._pickLang(desc.base) : this._pickLang(desc);
    } else {
      base = this._pickLang(desc);
    }
    const parts = [base].filter(Boolean);
    const conds = desc.conditions;
    if (Array.isArray(conds)) {
      for (const c of conds) {
        const ok = this.evaluateCondition(c?.if || '');
        if (ok) parts.push(this._pickLang(c?.message));
      }
    }
    const groundMsgs = this._getGroundItemMessages(locationId);
    if (groundMsgs) parts.push(groundMsgs);
    return parts.filter(Boolean).join('\n');
  }

  /** @param {string} itemId */
  getItemDescription(itemId) {
    const def = this.definition.items?.[itemId];
    if (!def) return '';
    const desc = def.description;
    if (!desc) return '';
    const matchCtx = { object: itemId, object_name: this._pickLang(def.name) || itemId };
    let result;
    if (typeof desc === 'string') {
      result = desc;
    } else if (desc.base !== undefined || Array.isArray(desc.conditions)) {
      const base = desc.base ? this._pickLang(desc.base) : this._pickLang(desc);
      const parts = [base].filter(Boolean);
      if (Array.isArray(desc.conditions)) {
        for (const c of desc.conditions) {
          if (this.evaluateCondition(this._expandTemplate(String(c?.if || ''), matchCtx)))
            parts.push(this._expandTemplate(this._pickLang(c?.message) || '', matchCtx));
        }
      }
      result = parts.filter(Boolean).join('\n');
    } else {
      result = this._pickLang(desc);
    }
    if (this.definition.metadata?.auto_container_description) {
      const visible = this._getContainerVisibleContents(itemId);
      if (visible.length > 0) {
        const names = visible.map(id => this._pickLang(this.definition.items?.[id]?.name) || id);
        result += '\nInside you see: ' + names.join(', ') + '.';
      }
    }
    return result;
  }

  _getGroundItemMessages(locationId) {
    const loc = this.getFullLocationData(locationId);
    if (!loc) return '';
    const contents = Array.isArray(loc.contents) ? loc.contents : [];
    const lines = [];
    for (const itemId of contents) {
      const item = this.definition.items?.[itemId];
      if (!item) continue;
      const isDroppable = item.droppable !== undefined ? !!item.droppable : item.takeable === true;
      if (!isDroppable) continue;
      const groundMsgs = item.on_ground_messages;
      if (Array.isArray(groundMsgs)) {
        for (const msgDef of groundMsgs) {
          if (this.evaluateCondition(String(msgDef.condition || 'true'))) {
            const msg = this._pickLang(msgDef.message);
            if (msg) { lines.push(msg); break; }
          }
        }
      } else {
        const name = this._pickLang(item.name) || itemId;
        lines.push(`There is a ${name} here.`);
      }
    }
    return lines.join('\n');
  }

  async renderCurrentLocation() {
    const locationId = this.gameState.current_location;
    const loc = this.getFullLocationData(locationId);
    if (!loc) return;

    const prevLoc = this.gameState.previous_location;
    if (prevLoc !== locationId) {
      const nameText = this._pickLang(loc.name);
      if (nameText) this.hooks.onLocationNameRender?.(nameText);

      const desc = this.getLocationDescription(locationId);
      this.hooks.onOutput?.(desc);

      this.gameState.previous_location = locationId;
    }

    const images = Array.isArray(loc.images) ? loc.images : [];
    if (images.length) {
      const url = await this.resolveAssetUrl(images[0]);
      this.hooks.onRoomImageRender?.(url || null);
    } else {
      this.hooks.onRoomImageRender?.(null);
    }

    this.hooks.onInventoryRender?.();
    this.hooks.onMindRender?.();
    this.hooks.onMemoryRender?.();
    this.hooks.onDebugRender?.();
    this.hooks.onMapRender?.();
    this.hooks.onLocationRender?.(locationId);
  }

  /** @param {'north'|'south'|'east'|'west'} direction */
  go(direction) {
    const loc = this.getFullLocationData(this.gameState.current_location);
    const raw = loc?.exits?.[direction];
    if (!raw) {
      this.hooks.onOutput?.(`You can't go ${direction}.`);
      return false;
    }

    let targetLocation;
    if (typeof raw === 'string') {
      targetLocation = raw;
    } else if (raw && typeof raw === 'object') {
      targetLocation = raw.location;
      if (!targetLocation) {
        this.hooks.onOutput?.(`You can't go ${direction}.`);
        return false;
      }
      const conditions = Array.isArray(raw.conditions) ? raw.conditions : [];
      for (const cond of conditions) {
        if (cond.if && this.evaluateCondition(String(cond.if))) {
          if (cond.allow === true) break;
          const msg = this._pickLang(cond.message);
          if (msg) this.hooks.onOutput?.(msg);
          return false;
        }
      }
    } else {
      this.hooks.onOutput?.(`You can't go ${direction}.`);
      return false;
    }

    if (!this.definition.locations?.[targetLocation]) {
      console.warn('[engine] Exit points to unknown location:', targetLocation);
      this.hooks.onOutput?.(`You can't go ${direction}.`);
      return false;
    }
    this.gameState.current_location = targetLocation;
    this._addKnownLocation(this._getPlayerActorId(), targetLocation);
    this._afterTurn({ kind: 'move', direction, location: targetLocation });
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
        const targetLoc = action?.location || this.gameState.current_location;
        const entered = String(ev.location) === targetLoc;
        if (action?.kind === 'move' && entered) {
          console.log('[events] location_enter triggered:', ev.id, 'at', targetLoc);
          this._executeEvent(ev);
        }
      }
      if (ev.trigger_on) {
        if (ev.trigger_on === action?.kind) {
          if (!ev.action_id || String(ev.action_id) === action?.id) {
            this._executeEvent(ev);
          }
        }
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

    // Render first so event messages appear after the location description
    this.renderCurrentLocation();

    // Location-enter + recurring + time-based
    this._runEventsForAction(action);
    this._checkEndConditions();
  }
}
