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

  _getItemOwner(itemId) {
    const id = String(itemId);
    if (this.gameState.ownership && id in this.gameState.ownership) {
      return this.gameState.ownership[id] || null;
    }
    return null;
  }

  _getPossessiveForm(name) {
    if (!name) return '';
    const trimmed = String(name).trim();
    if (trimmed.toLowerCase().endsWith('s')) return trimmed + "'";
    return trimmed + "'s";
  }

  _expandItemText(itemId, text, forceShowOwner) {
    if (!text || !text.includes('{owner}')) return text;
    const ownerId = this._getItemOwner(itemId);
    const viewerId = this._getPlayerActorId();

    if (ownerId && (forceShowOwner || ownerId !== viewerId)) {
      const ownerName = this._pickLang(this.definition.actors?.[ownerId]?.name) || ownerId;
      if (text.includes("{owner}'s") || text.includes("{owner}'")) {
        text = text.replace(/\{owner\}(?:'s?)?/g, this._getPossessiveForm(ownerName));
      } else {
        text = text.replace(/\{owner\}/g, ownerName);
      }
    } else {
      text = text.replace(/\{owner\}(?:'s?)?\s*/g, '');
    }
    return text.replace(/\s{2,}/g, ' ').trim();
  }

  _getItemDisplayName(itemId) {
    const item = this.definition.items?.[itemId];
    if (!item) return '';
    return this._expandItemText(itemId, this._pickLang(item.name));
  }

  _getItemDisplayShortName(itemId) {
    const item = this.definition.items?.[itemId];
    if (!item) return '';
    const sn = item.short_name;
    return sn ? this._expandItemText(itemId, this._pickLang(sn)) : '';
  }

  _getItemDescription(itemId) {
    const item = this.definition.items?.[itemId];
    if (!item) return '';
    const raw = typeof item.description === 'string'
      ? item.description
      : this._pickLang(item.description?.base || item.description);
    return raw ? this._expandItemText(itemId, raw) : '';
  }

  _getItemResolvedName(itemId) {
    const item = this.definition.items?.[itemId];
    if (!item) return '';
    return this._expandItemText(itemId, this._pickLang(item.name), true);
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

    const initActorId = vars.current_player_actor?.value || 'protagonist';
    const startLoc = this.definition.actors[initActorId]?.starting_location;

    const actorsData = {};
    for (const [actorId, actorDef] of Object.entries(this.definition.actors || {})) {
      const { values: props, overrides } = this._initActorProperties(actorDef.properties || {});
      actorsData[actorId] = {
        inventory: Array.isArray(actorDef.inventory) ? [...actorDef.inventory] : [],
        wearing: Array.isArray(actorDef.wearing) ? [...actorDef.wearing] : [],
        current_location: actorDef.starting_location,
        contained_by: actorDef.starting_contained_by || null,
        posture: actorDef.starting_posture || 'standing',
        known_locations: Array.isArray(actorDef.known_locations) ? [...actorDef.known_locations] : [],
        properties: props,
        property_overrides: overrides,
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
      container_contents: this._initContainerContents(),
      ownership: this._initOwnership(),
      conversation: {
        active: false,
        actorId: null,
        nodeId: null
      }
    };
  }

  _initContainerContents() {
    const map = {};
    for (const [id, def] of Object.entries(this.definition.items || {})) {
      if (Array.isArray(def.contents)) map[id] = [...def.contents];
    }
    return map;
  }

  _initOwnership() {
    const map = {};
    for (const [id, def] of Object.entries(this.definition.items || {})) {
      if (def.owner) map[id] = def.owner;
    }
    return map;
  }

  _initActorProperties(actorPropsDef) {
    const values = {};
    const overrides = {};
    for (const [propName, propDef] of Object.entries(this.definition.properties || {})) {
      const rawVal = actorPropsDef?.[propName];
      let value, overrideData;
      if (rawVal !== null && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
        value = rawVal.value ?? propDef.default;
        overrideData = {};
        if ('min_value' in rawVal) overrideData.min_value = rawVal.min_value;
        if ('max_value' in rawVal) overrideData.max_value = rawVal.max_value;
        if ('possible_values' in rawVal) overrideData.possible_values = rawVal.possible_values;
      } else {
        value = rawVal ?? propDef.default;
        overrideData = {};
      }
      values[propName] = this._coerceAndClamp({
        type: propDef.type || 'any',
        min_value: overrideData.min_value ?? propDef.min_value,
        max_value: overrideData.max_value ?? propDef.max_value,
        possible_values: overrideData.possible_values ?? propDef.possible_values
      }, value);
      if (Object.keys(overrideData).length > 0) {
        overrides[propName] = overrideData;
      }
    }
    for (const [key, val] of Object.entries(actorPropsDef || {})) {
      if (!(key in values)) values[key] = val;
    }
    return { values, overrides };
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
        },
        sittable: (itemId) => Boolean(engine.definition.items?.[String(itemId)]?.sittable),
        sleepable: (itemId) => Boolean(engine.definition.items?.[String(itemId)]?.sleepable),
        enterable: (itemId) => Boolean(engine.definition.items?.[String(itemId)]?.enterable),
        actor_capacity: (itemId) => engine.definition.items?.[String(itemId)]?.actor_capacity ?? Infinity
      },
      locations: this.definition.locations || {},
      actors: this.definition.actors || {},
      getActor: (id) => engine.gameState.actors_data?.[id],
      getActorProp: (actorId, propName) =>
        engine.gameState.actors_data?.[actorId]?.properties?.[propName],
      getRelationship: (otherActorId, propName) =>
        playerData.relationships?.[otherActorId]?.[propName],
      getRelationshipBetween: (actorId1, actorId2, propName) =>
        engine.gameState.actors_data?.[actorId1]?.relationships?.[actorId2]?.[propName],
      isWorn: (itemId) => {
        const loc = engine.gameState.current_location;
        for (const ad of Object.values(engine.gameState.actors_data || {})) {
          if (ad.current_location !== loc) continue;
          if (Array.isArray(ad.wearing) && ad.wearing.includes(String(itemId))) return true;
        }
        return false;
      },
      getActorWearing: (actorId) => {
        const ad = engine.gameState.actors_data?.[actorId];
        return ad && Array.isArray(ad.wearing) ? [...ad.wearing] : [];
      },
      isSeated: (actorId) => {
        const data = engine.gameState.actors_data?.[String(actorId)];
        return data ? data.contained_by != null : false;
      },
      isActorHidden: (actorId) => engine._isActorHidden(String(actorId)),
      getContainedBy: (actorId) => {
        const data = engine.gameState.actors_data?.[String(actorId)];
        return data ? data.contained_by : null;
      },
      getPosture: (actorId) => {
        const data = engine.gameState.actors_data?.[String(actorId)];
        return data ? data.posture : 'standing';
      },
      getContainerOccupants: (itemId) => {
        const id = String(itemId);
        const occupants = [];
        for (const [actorId, data] of Object.entries(engine.gameState.actors_data || {})) {
          if (data.contained_by === id) occupants.push(actorId);
        }
        return occupants;
      },
      getContainerOccupantsCount: (itemId) => {
        const id = String(itemId);
        let count = 0;
        for (const data of Object.values(engine.gameState.actors_data || {})) {
          if (data.contained_by === id) count++;
        }
        return count;
      },
      getOwner: (itemId) => engine._getItemOwner(String(itemId)),
      getOwnerName: (itemId) => {
        const oid = engine._getItemOwner(String(itemId));
        if (!oid) return '';
        return engine._pickLang(engine.definition.actors?.[oid]?.name) || oid;
      }
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

      // setActorProp('actorId', 'propName', value)
      const setActorPropMatch = line.match(/^setActorProp\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*(.+)\s*\)$/);
      if (setActorPropMatch) {
        this._applySetActorProp(setActorPropMatch[1], setActorPropMatch[2], setActorPropMatch[3]);
        continue;
      }

      // setRelationship('actorId1', 'actorId2', 'propName', value)
      const setRelMatch = line.match(/^setRelationship\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*(.+)\s*\)$/);
      if (setRelMatch) {
        this._applySetRelationship(setRelMatch[1], setRelMatch[2], setRelMatch[3], setRelMatch[4]);
        continue;
      }

      // setPlayerActor('actorId')
      const setPlayerMatch = line.match(/^setPlayerActor\(\s*(.+)\s*\)$/);
      if (setPlayerMatch) {
        this._applySetPlayerActor(setPlayerMatch[1]);
        continue;
      }

      // setOwner('itemId', 'actorId') — actorId empty removes ownership
      const setOwnerMatch = line.match(/^setOwner\s*\(\s*['"]?([^,'"]+)['"]?\s*,\s*['"]?([^'"]*)['"]?\s*\)\s*$/);
      if (setOwnerMatch) {
        const itemId = String(setOwnerMatch[1]).trim();
        const actorId = String(setOwnerMatch[2]).trim();
        if (!actorId) {
          delete this.gameState.ownership[itemId];
        } else {
          this.gameState.ownership[itemId] = actorId;
        }
        continue;
      }

      // containActor('actorId', 'containerId'[, 'posture']) or containActor(actorId, 'containerId'[, 'posture'])
      const containMatch = line.match(/^containActor\(\s*([^,]+)\s*,\s*([^,]+)(?:\s*,\s*['"]?([^)'"]+)['"]?)?\s*\)\s*$/);
      if (containMatch) {
        const actorId = String(this._evalExpression(containMatch[1]) ?? '');
        const containerId = String(this._evalExpression(containMatch[2]) ?? '');
        const posture = containMatch[3] ? String(containMatch[3]).trim() : undefined;
        if (actorId) this._containActor(actorId, containerId, posture);
        continue;
      }

      // releaseActor('actorId') or releaseActor(actorId)
      const releaseMatch = line.match(/^releaseActor\(\s*(.+)\s*\)\s*$/);
      if (releaseMatch) {
        const actorId = String(this._evalExpression(releaseMatch[1]) ?? '');
        if (actorId) this._releaseActor(actorId);
        continue;
      }

      // setPosture('actorId', 'posture') or setPosture(actorId, 'posture')
      const setPostureMatch = line.match(/^setPosture\(\s*([^,]+)\s*,\s*['"]?([^)'"]+)['"]?\s*\)\s*$/);
      if (setPostureMatch) {
        const actorId = String(this._evalExpression(setPostureMatch[1]) ?? '');
        const posture = String(setPostureMatch[2]).trim();
        const data = this.gameState.actors_data?.[actorId];
        if (data) data.posture = posture;
        continue;
      }

      // startConversation('actorId') or startConversation(actorId)
      const startConvMatch = line.match(/^startConversation\(\s*(.+)\s*\)\s*$/);
      if (startConvMatch) {
        const actorId = String(this._evalExpression(startConvMatch[1]) ?? '');
        if (actorId) this._startConversation(actorId);
        continue;
      }

      // endConversation()
      const endConvMatch = line.match(/^endConversation\(\)\s*$/);
      if (endConvMatch) {
        this._endConversation();
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
    const currentLoc = this.gameState.current_location;
    const loc = this.getFullLocationData(currentLoc);
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

    // Search inventory and wearing of actors co-located at the current location
    for (const actorData of Object.values(this.gameState.actors_data || {})) {
      if (actorData.current_location !== currentLoc) continue;
      const roots = [
        ...(Array.isArray(actorData.inventory) ? actorData.inventory : []),
        ...(Array.isArray(actorData.wearing) ? actorData.wearing : [])
      ];
      for (const rootId of roots) {
        const sq = [[rootId, null]];
        while (sq.length) {
          const [childId, parentId] = sq.shift();
          if (childId === id) return true;
          if (visited.has(childId)) continue;
          visited.add(childId);
          if (parentId && !this._isContainerItemVisible(parentId, childId)) continue;
          const sub = this.gameState.container_contents?.[childId];
          if (Array.isArray(sub)) {
            for (const grandchild of sub) {
              sq.push([grandchild, childId]);
            }
          }
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

  /** Traverse container_contents to find all descendant items of given root IDs */
  _flattenContainerChain(itemIds) {
    const result = [];
    const queue = Array.isArray(itemIds) ? [...itemIds] : [];
    const visited = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      result.push(id);
      const sub = this.gameState.container_contents?.[id];
      if (Array.isArray(sub)) {
        for (const child of sub) queue.push(child);
      }
    }
    return result;
  }

  /** Union of direct inventory + items reachable from worn containers */
  getVisibleInventoryItems() {
    const actorId = this._getPlayerActorId();
    const data = this.gameState.actors_data?.[actorId];
    if (!data) return [];
    const direct = Array.isArray(data.inventory) ? [...data.inventory] : [];
    const wornItems = Array.isArray(data.wearing) ? data.wearing : [];
    const fromWorn = this._flattenContainerChain(wornItems);
    const seen = new Set(direct);
    const combined = [...direct];
    for (const id of fromWorn) {
      if (!seen.has(id)) { seen.add(id); combined.push(id); }
    }
    return combined;
  }

  _isActorContained(actorId) {
    const data = this.gameState.actors_data?.[actorId];
    return data ? data.contained_by : null;
  }

  _containActor(actorId, containerId, posture) {
    const data = this.gameState.actors_data?.[actorId];
    if (!data) return;
    data.contained_by = containerId;
    data.posture = posture || 'seated';
  }

  _releaseActor(actorId) {
    const data = this.gameState.actors_data?.[actorId];
    if (!data) return;
    data.contained_by = null;
    data.posture = 'standing';
  }

  _getRelationshipLevel(fromActorId, toActorId) {
    const rel = this.gameState.actors_data?.[fromActorId]?.relationships?.[toActorId];
    return rel?.relationship_level || 'strangers';
  }

  _isActorHidden(actorId) {
    const data = this.gameState.actors_data?.[actorId];
    if (!data || !data.contained_by) return false;
    const containerId = data.contained_by;
    const containerDef = this.definition.items?.[containerId];
    if (!containerDef) return false;
    if (containerDef.sittable || containerDef.sleepable) return false;
    if (containerDef.openable) {
      const openVar = this.gameState.variables?.[`${containerId}_open`];
      const isOpen = openVar?.value === true;
      if (!isOpen) return true;
    }
    return false;
  }

  _getVisibleActorsInLocation(locationId) {
    const playerId = this._getPlayerActorId();
    const visible = [];
    for (const [actorId, data] of Object.entries(this.gameState.actors_data || {})) {
      if (data.current_location !== locationId) continue;
      if (actorId === playerId) continue;
      if (this._isActorHidden(actorId)) continue;
      visible.push(actorId);
    }
    return visible;
  }

  _getAppearanceDescription(actorId) {
    const props = this.gameState.actors_data?.[actorId]?.properties || {};
    const hair = props.hair || '';
    const gender = props.gender || 'other';
    const age = typeof props.age === 'number' ? props.age : null;

    const HAIR_MAP = {
      black: 'black-haired', brown: 'brunette', blonde: 'blonde',
      red: 'red-haired', gray: 'gray-haired', white: 'white-haired', bald: 'bald'
    };
    const hairAdj = HAIR_MAP[hair] || '';

    const GENDER_MAP = { male: 'man', female: 'woman' };
    const genderLabel = GENDER_MAP[gender] || 'person';

    const POSSESSIVE_MAP = { male: 'his', female: 'her' };
    const poss = POSSESSIVE_MAP[gender] || 'their';

    let ageRange = '';
    if (age !== null) {
      if (age <= 12) {
        ageRange = 'child';
      } else if (age <= 17) {
        ageRange = `teenage`;
      } else if (age <= 19) {
        ageRange = `in ${poss} late teens`;
      } else {
        const decade = Math.floor(age / 10) * 10;
        ageRange = `in ${poss} ${decade}s`;
      }
    }

    const parts = [hairAdj, genderLabel, ageRange].filter(Boolean);
    return `a ${parts.join(' ')}`;
  }

  _getActorReference(actorId, fromPlayerId) {
    const relLevel = this._getRelationshipLevel(fromPlayerId, actorId);
    const actorName = this._pickLang(this.definition.actors?.[actorId]?.name) || actorId;

    if (relLevel === 'strangers' || !relLevel) {
      return this._getAppearanceDescription(actorId);
    }

    if (relLevel === 'friends') {
      return `your friend ${actorName}`;
    }

    return actorName;
  }

  _getContainerPosture(containerId, actorId) {
    if (!containerId) return 'here';
    const def = this.definition.items?.[containerId];
    if (!def) return 'here';
    const shortName = this._getItemDisplayShortName(containerId)
      || this._getItemDisplayName(containerId)
      || containerId;

    // Check actor's explicit posture if provided
    if (actorId) {
      const posture = this.gameState.actors_data?.[actorId]?.posture;
      if (posture && posture !== 'standing') {
        const prep = (def.sleepable || def.sittable) ? 'on' : 'in';
        const postures = {
          seated: `seated ${prep} the ${shortName}`,
          lying: `lying ${prep} the ${shortName}`,
          crouched: `crouching ${prep} the ${shortName}`,
          on_knees: `kneeling ${prep} the ${shortName}`,
          on_all_fours: `on all fours ${prep} the ${shortName}`,
          flying: 'flying',
          falling: 'falling'
        };
        return postures[posture] || `standing in the ${shortName}`;
      }
    }

    // Fall back to item property inference (backward compat)
    if (def.sleepable) return `lying on the ${shortName}`;
    if (def.sittable) return `seated on the ${shortName}`;
    return `inside the ${shortName}`;
  }

  _getContainerSimplePosture(containerId) {
    if (!containerId) return 'here';
    const def = this.definition.items?.[containerId];
    if (!def) return 'here';
    const shortName = this._getItemDisplayShortName(containerId)
      || this._getItemDisplayName(containerId)
      || containerId;
    if (def.sleepable || def.sittable) return `on the ${shortName}`;
    if (def.enterable) return `in the ${shortName}`;
    return `inside the ${shortName}`;
  }

  _getPosturePhrase(actorId) {
    const data = this.gameState.actors_data?.[actorId];
    return this._getContainerPosture(data?.contained_by || null, actorId);
  }

  _formatList(items) {
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  }

  _getActorVisualDescriptors(actorId) {
    const props = this.gameState.actors_data?.[actorId]?.properties || {};
    const descriptors = new Set();

    const GENDER_DESC = { male: ['man', 'guy', 'male'], female: ['woman', 'lady', 'female'] };
    const gender = props.gender || 'other';
    for (const d of (GENDER_DESC[gender] || ['person'])) descriptors.add(d);

    const HAIR_DESC = {
      black: ['black-haired', 'black haired'], brown: ['brunette'],
      blonde: ['blonde'], red: ['red-haired', 'red haired', 'ginger'],
      gray: ['gray-haired', 'gray haired'], white: ['white-haired', 'white haired'],
      bald: ['bald']
    };
    const hair = props.hair || '';
    for (const d of (HAIR_DESC[hair] || [])) descriptors.add(d);

    const age = typeof props.age === 'number' ? props.age : null;
    if (age !== null) {
      if (age <= 12) descriptors.add('child');
      else if (age <= 17) descriptors.add('teen');
      else if (age <= 25) descriptors.add('young');
      else if (age >= 60) descriptors.add('elderly');
      else if (age >= 40) descriptors.add('middle-aged');
    }

    const genderLabel = GENDER_DESC[gender]?.[0] || 'person';
    for (const hairDesc of (HAIR_DESC[hair] || [])) {
      descriptors.add(`${hairDesc} ${genderLabel}`);
    }

    return descriptors;
  }

  _isActorStrangerToPlayer(actorId) {
    const playerId = this._getPlayerActorId();
    return this._getRelationshipLevel(playerId, actorId) === 'strangers';
  }

  _moodToDescription(mood) {
    if (!mood) return '';
    const map = {
      neutral: 'looks neutral', happy: 'looks happy', sad: 'looks sad',
      anxious: 'looks anxious', curious: 'looks curious', angry: 'looks angry',
      tired: 'looks tired'
    };
    return map[mood] || `looks ${mood}`;
  }

  _getActorExamineOutput(actorId) {
    const playerId = this._getPlayerActorId();
    const actorData = this.gameState.actors_data?.[actorId];
    const actorDef = this.definition.actors?.[actorId];
    if (!actorData || !actorDef) return '';

    const parts = [];
    const relLevel = this._getRelationshipLevel(playerId, actorId);
    const isStranger = !relLevel || relLevel === 'strangers';

    const customDesc = actorDef.description
      ? (typeof actorDef.description === 'string' ? actorDef.description : this._pickLang(actorDef.description))
      : null;
    if (customDesc) parts.push(customDesc);

    let subject;
    if (isStranger) {
      const appearance = this._getAppearanceDescription(actorId);
      subject = appearance.charAt(0).toUpperCase() + appearance.slice(1);
    } else {
      const ref = this._getActorReference(actorId, playerId);
      subject = ref.charAt(0).toUpperCase() + ref.slice(1);
    }

    const posture = this._getPosturePhrase(actorId);
    parts.push(`${subject} is ${posture}.`);

    const wearing = actorData.wearing || [];
    if (wearing.length > 0) {
      const itemNames = wearing.map(id => this._getItemDisplayName(id) || id);
      parts.push(`${subject} is wearing ${this._formatList(itemNames)}.`);
    }

    const mood = actorData.properties?.mood;
    if (mood) {
      parts.push(`${subject} ${this._moodToDescription(mood)}.`);
    }

    return parts.join('\n');
  }

  _buildActorPresenceDescription(locationId) {
    const playerId = this._getPlayerActorId();
    const playerData = this.gameState.actors_data?.[playerId];
    const visibleActors = this._getVisibleActorsInLocation(locationId);

    const sentences = [];

    const groups = {};
    for (const actorId of visibleActors) {
      const containerId = this.gameState.actors_data?.[actorId]?.contained_by || null;
      const key = containerId || '__standing__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(actorId);
    }

    const playerContainer = playerData?.contained_by || null;
    const sameContainerGroup = playerContainer !== null ? groups[playerContainer] : null;

    if (playerContainer && !sameContainerGroup) {
      const posture = this._getPosturePhrase(playerId);
      sentences.push(`You are ${posture}.`);
    }

    for (const [key, actorIds] of Object.entries(groups)) {
      const containerId = key === '__standing__' ? null : key;
      const isSameContainer = playerContainer && containerId === playerContainer;

      const posture = containerId
        ? this._getContainerPosture(containerId, actorIds[0])
        : null;

      const references = actorIds.map(id => this._getActorReference(id, playerId));
      const hasStranger = actorIds.some(id => {
        const rel = this._getRelationshipLevel(playerId, id);
        return !rel || rel === 'strangers';
      });

      const containerShortName = containerId
        ? (this._getItemDisplayShortName(containerId) || this._getItemDisplayName(containerId) || containerId)
        : null;

      if (isSameContainer) {
        const allRefs = this._formatList(references);
        const verb = actorIds.length === 1 ? 'is' : 'are';
        sentences.push(`Alongside you on the ${containerShortName} ${verb} ${allRefs}.`);
      } else if (containerId === null) {
        const allRefs = this._formatList(references);
        if (hasStranger) {
          sentences.push(`You can see ${allRefs} here.`);
        } else {
          const verb = actorIds.length === 1 ? 'is' : 'are';
          sentences.push(`${allRefs.charAt(0).toUpperCase() + allRefs.slice(1)} ${verb} here.`);
        }
      } else {
        const allRefs = this._formatList(references);
        if (hasStranger) {
          sentences.push(`You can see ${allRefs} ${posture}.`);
        } else {
          const verb = actorIds.length === 1 ? 'is' : 'are';
          sentences.push(`${allRefs.charAt(0).toUpperCase() + allRefs.slice(1)} ${verb} ${posture}.`);
        }
      }
    }

    return sentences.join('\n');
  }

  _startConversation(actorId) {
    this._endConversation();
    const actorDef = this.definition.actors?.[actorId];
    const dialogue = actorDef?.dialogue;
    if (!dialogue?.nodes) return;

    const entryNodes = Array.isArray(dialogue.entry_nodes) ? dialogue.entry_nodes : [{ id: 'greeting', conditions: [] }];
    let entryId = null;
    for (const entry of entryNodes) {
      const conds = Array.isArray(entry.conditions) ? entry.conditions : [];
      const allOk = conds.length === 0 || conds.every(c => this.evaluateCondition(String(c)));
      if (allOk) { entryId = entry.id; break; }
    }
    if (!entryId || !dialogue.nodes[entryId]) return;

    this.gameState.conversation = { active: true, actorId, nodeId: entryId };
    this._renderDialogueNode(entryId);
  }

  _endConversation() {
    if (!this.gameState.conversation?.active) return;
    this.gameState.conversation = { active: false, actorId: null, nodeId: null };
  }

  _renderDialogueNode(nodeId) {
    const conv = this.gameState.conversation;
    if (!conv?.active) return;
    const actorDef = this.definition.actors?.[conv.actorId];
    const node = actorDef?.dialogue?.nodes?.[nodeId];
    if (!node) { this._endConversation(); return; }

    const actorName = this._pickLang(actorDef.name) || conv.actorId;
    const msg = this._pickLang(node.message);
    if (msg) {
      const output = `${actorName}: "${msg}"`;
      this.hooks.onOutput?.(output);
    }

    if (Array.isArray(node.options) && node.options.length > 0) {
      const lines = [];
      for (let i = 0; i < node.options.length; i++) {
        const opt = node.options[i];
        const conds = Array.isArray(opt.conditions) ? opt.conditions : [];
        if (conds.length > 0 && !conds.every(c => this.evaluateCondition(String(c)))) continue;
        const text = this._pickLang(opt.text);
        if (text) lines.push(`[${i + 1}] ${text}`);
      }
      if (lines.length) this.hooks.onOutput?.(lines.join('\n'));
    }

    this.hooks.onInventoryRender?.();
  }

  _selectDialogueOption(index) {
    const conv = this.gameState.conversation;
    if (!conv?.active) return false;
    const actorDef = this.definition.actors?.[conv.actorId];
    const node = actorDef?.dialogue?.nodes?.[conv.nodeId];
    if (!node) return false;

    const visibleOptions = [];
    for (let i = 0; i < (node.options || []).length; i++) {
      const opt = node.options[i];
      const conds = Array.isArray(opt.conditions) ? opt.conditions : [];
      if (conds.length === 0 || conds.every(c => this.evaluateCondition(String(c)))) {
        visibleOptions.push(opt);
      }
    }

    const chosen = visibleOptions[index];
    if (!chosen) return false;

    if (chosen.effects) this.applyEffect(chosen.effects);
    if (chosen.next) {
      conv.nodeId = chosen.next;
      this._renderDialogueNode(chosen.next);
    } else {
      const prevActorId = conv.actorId;
      const prevNodeId = conv.nodeId;
      this._endConversation();
      this._afterTurn({ kind: 'dialogue_end', actorId: prevActorId, nodeId: prevNodeId });
      return true;
    }
    this._afterTurn({ kind: 'dialogue', actorId: conv.actorId, nodeId: conv.nodeId });
    return true;
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

  _evalExpression(expr) {
    const ctx = this._buildEvalContext();
    try {
      const js = this._translateConditionToJs(String(expr).trim());
      const fn = new Function('ctx', `with (ctx) { return (${js}); }`);
      return fn(ctx);
    } catch (err) {
      console.warn('[engine] Failed to evaluate expression:', expr, err);
      return undefined;
    }
  }

  _getPropConstraints(actorId, propName) {
    const global = this.definition.properties?.[propName] || {};
    const overrides = this.gameState.actors_data?.[actorId]?.property_overrides?.[propName] || {};
    return { ...global, ...overrides };
  }

  _applySetActorProp(actorIdExpr, propNameExpr, rhsValueExpr) {
    const actorId = String(this._evalExpression(actorIdExpr) ?? '');
    const propName = String(this._evalExpression(propNameExpr) ?? '');
    if (!actorId || !propName) return;
    const actorData = this.gameState.actors_data?.[actorId];
    if (!actorData) return;
    if (!actorData.properties) actorData.properties = {};
    let rhsValue = this._evalExpression(rhsValueExpr);
    if (rhsValue === undefined) rhsValue = parseScalar(String(rhsValueExpr));
    const constraints = this._getPropConstraints(actorId, propName);
    actorData.properties[propName] = this._coerceAndClamp({
      type: constraints.type || 'any',
      min_value: constraints.min_value,
      max_value: constraints.max_value,
      possible_values: constraints.possible_values
    }, rhsValue);
  }

  _applySetRelationship(actorId1Expr, actorId2Expr, propNameExpr, rhsValueExpr) {
    const actorId1 = String(this._evalExpression(actorId1Expr) ?? '');
    const actorId2 = String(this._evalExpression(actorId2Expr) ?? '');
    const propName = String(this._evalExpression(propNameExpr) ?? '');
    if (!actorId1 || !actorId2 || !propName) return;
    const actorData = this.gameState.actors_data?.[actorId1];
    if (!actorData) return;
    if (!actorData.relationships) actorData.relationships = {};
    if (!actorData.relationships[actorId2]) actorData.relationships[actorId2] = {};
    let rhsValue = this._evalExpression(rhsValueExpr);
    if (rhsValue === undefined) rhsValue = parseScalar(String(rhsValueExpr));
    const constraints = this._getPropConstraints(actorId1, propName);
    actorData.relationships[actorId2][propName] = constraints.type
      ? this._coerceAndClamp({
          type: constraints.type,
          min_value: constraints.min_value,
          max_value: constraints.max_value,
          possible_values: constraints.possible_values
        }, rhsValue)
      : rhsValue;
  }

  _applySetPlayerActor(actorIdExpr) {
    const actorId = String(this._evalExpression(actorIdExpr) ?? '');
    if (!actorId || !this.definition.actors?.[actorId]) return;
    const variable = this.gameState.variables.current_player_actor;
    if (!variable) return;
    variable.value = this._coerceAndClamp(variable, actorId);
    this._endConversation();
    const actorData = this.gameState.actors_data?.[actorId];
    if (actorData?.current_location) {
      this.gameState.current_location = actorData.current_location;
      this.gameState.previous_location = null;
    } else {
      const actorDef = this.definition.actors[actorId];
      if (actorDef.starting_location) {
        this.gameState.current_location = actorDef.starting_location;
        this.gameState.previous_location = null;
        if (actorData) actorData.current_location = actorDef.starting_location;
      }
    }
    this._memoryConfig = this._getPlayerMemoryConfig();
    this.hooks.onInventoryRender?.();
    this.hooks.onLocationRender?.(this.gameState.current_location);
    this.hooks.onMindRender?.();
    this.hooks.onMemoryRender?.();
    this.hooks.onMapRender?.();
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

    const presence = this._buildActorPresenceDescription(locationId);
    if (presence) parts.push('\n' + presence);

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
        const names = visible.map(id => this._getItemDisplayName(id) || id);
        result += '\nInside you see: ' + names.join(', ') + '.';
      }
    }

    const occupantActors = [];
    const playerIdForContainer = this._getPlayerActorId();
    for (const [actorId, data] of Object.entries(this.gameState.actors_data || {})) {
      if (data.contained_by === itemId
          && data.current_location === this.gameState.current_location
          && actorId !== playerIdForContainer
          && !this._isActorHidden(actorId)) {
        occupantActors.push(actorId);
      }
    }
    if (occupantActors.length > 0) {
      const isPlayerOnSame = this.gameState.actors_data?.[playerIdForContainer]?.contained_by === itemId;
      const refs = occupantActors.map(id => this._getActorReference(id, playerIdForContainer));
      const verb = occupantActors.length === 1 ? 'is' : 'are';
      result += `\nCurrently, ${this._formatList(refs)} ${verb} ${this._getContainerSimplePosture(itemId)}${isPlayerOnSame ? ' with you' : ''}.`;
    }

    return this._expandItemText(itemId, result);
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
        const name = this._getItemDisplayName(itemId) || itemId;
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

    const movingActorId = this._getPlayerActorId();
    const movingData = this.gameState.actors_data?.[movingActorId];
    if (movingData?.contained_by) {
      const shortName = this._getItemDisplayShortName(movingData.contained_by)
        || this._getItemDisplayName(movingData.contained_by)
        || movingData.contained_by;
      this.hooks.onOutput?.(`You need to stand up from the ${shortName} first.`);
      return false;
    }

    this.gameState.current_location = targetLocation;
    const movedActorId = this._getPlayerActorId();
    const movedData = this.gameState.actors_data?.[movedActorId];
    if (movedData) movedData.current_location = targetLocation;
    this._addKnownLocation(movedActorId, targetLocation);
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
