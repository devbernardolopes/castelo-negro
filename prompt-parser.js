// User prompt parsing logic for the text adventure engine.
// Methods are attached to GameEngine.prototype and loaded after script.js.

/**
 * Process a player command (text parser will be expanded later).
 * Currently supports: north/south/east/west, go <dir>, take <item>, drop <item>, use <item>, consume <item>
 * @param {string} input
 */
GameEngine.prototype.processPlayerCommand = function(input) {
  const raw = String(input || '').trim();
  if (!raw) return;
  const cmd = raw.toLowerCase();

  const dirs = ['north', 'south', 'east', 'west'];
  if (dirs.includes(cmd)) return this.go(/** @type {any} */ (cmd));
  if (cmd.startsWith('go ')) {
    const d = cmd.slice(3).trim();
    if (dirs.includes(d)) return this.go(/** @type {any} */ (d));
  }

  // Action system (v1.3+): try declarative action matches first.
  if (this._tryActions(cmd)) return true;

  // Legacy fallback commands (still supported).
  const take = cmd.match(/^(take|get)\s+(.+)$/);
  if (take) return this._takeItemByName(take[2]);
  const drop = cmd.match(/^drop\s+(.+)$/);
  if (drop) return this._dropItemByName(drop[1]);
  const use = cmd.match(/^use\s+(.+)$/);
  if (use) return this._verbItemByName('use', use[1]);
  const consume = cmd.match(/^(consume|eat|drink)\s+(.+)$/);
  if (consume) return this._consumeItemByName(consume[2]);
};

GameEngine.prototype._tryActions = function(cmd) {
  const actions = this.definition.actions && typeof this.definition.actions === 'object' 
    ? this.definition.actions 
    : null;
  if (!actions) return false;

  for (const [actionId, actionDef] of Object.entries(actions)) {
    const match = this._matchAction(actionDef, cmd);
    if (!match) continue;

    const ok = this._checkActionConditions(actionDef, match);
    if (ok) {
      // Happy path: all conditions met
      if (actionDef.effect) this._applyActionEffects(actionDef.effect, match);
      if (actionDef.message_pool) {
        const pool = this._pickLang(actionDef.message_pool);
        if (Array.isArray(pool) && pool.length) {
          const msg = pool[Math.floor(Math.random() * pool.length)];
          if (msg) this.hooks.onOutput?.(this._expandTemplate(msg, match));
        }
      } else {
        const msg = this._pickLang(actionDef.message);
        if (msg) this.hooks.onOutput?.(this._expandTemplate(msg, match));
      }
      this._afterTurn({ kind: 'action', id: actionId });
      return true;
    }

    // Check conditional failure messages
    if (Array.isArray(actionDef.conditional_messages)) {
      for (const conditional of actionDef.conditional_messages) {
        const expanded = this._expandTemplate(String(conditional.condition || ''), match);
        if (this.evaluateCondition(expanded)) {
          const msg = this._pickLang(conditional.message);
          if (msg) this.hooks.onOutput?.(this._expandTemplate(msg, match));
          this._afterTurn({ kind: 'action_failed', id: actionId });
          return true;
        }
      }
    }

    // If no conditional matched, continue to next action
  }
  
  // No action matched at all
  return false;
};

GameEngine.prototype._matchAction = function(actionDef, cmd) {
  const candidates = [];

  if (actionDef?.patterns && typeof actionDef.patterns === 'object') {
    for (const pat of Object.values(actionDef.patterns)) {
      if (Array.isArray(pat)) candidates.push(pat);
    }
  }

  if (Array.isArray(actionDef?.pattern)) {
    candidates.push(actionDef.pattern);
  }

  if (candidates.length === 0) {
    if (cmd) return {};
    return null;
  }

  for (const singlePat of candidates) {
    const expanded = singlePat.map(slot => {
      if (slot.verb) return { verb: this._expandVerbSynonyms(slot.verb) };
      return slot;
    });
    const match = this._matchPatternAgainstPrompt(expanded, cmd);
    if (match) return match;
  }
  return null;
};

GameEngine.prototype._matchPatternAgainstPrompt = function(pattern, cmd) {
  const tokens = String(cmd || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;

  const stopwords = this._getParserStopwords();

  /** @type {any} */
  const out = {};
  let i = 0;

  const skipStops = () => {
    while (i < tokens.length && stopwords.has(tokens[i])) i++;
  };

  for (const slotEntry of pattern) {
    skipStops();
    
    const isOptional = slotEntry?.optional === true;
    
    if (i >= tokens.length) {
      // If we're out of tokens and this slot is optional, skip it
      if (isOptional) {
        out[Object.keys(slotEntry)[0]] = '';  // Set to empty string
        continue;
      }
      // If required, we fail
      return null;
    }

    if (!slotEntry || typeof slotEntry !== 'object') return null;
    const entries = Object.entries(slotEntry).filter(([k]) => k !== 'optional');
    if (entries.length !== 1) return null;
    const slotName = entries[0][0];
    const slotDef = entries[0][1];

    if (slotName === 'verb') {
      const verbIds = Array.isArray(slotDef) ? slotDef.map(v => String(v).toLowerCase()) : [];
      const verbMatch = this._matchVerbAt(tokens, i, verbIds);
      if (!verbMatch) return null;
      out.verb = verbMatch.canonical;
      i += verbMatch.len;
      continue;
    }

    if (slotName === 'object' || slotName === 'target') {
      const itemMatch = this._matchItemSlotAt(tokens, i, slotDef);
      if (!itemMatch) return null;
      out[slotName] = itemMatch.itemId;
      out[`${slotName}_name`] = this._pickLang(this.definition.items?.[itemMatch.itemId]?.name) || itemMatch.itemId;
      i += itemMatch.len;
      continue;
    }

    if (slotName === 'location') {
      const locationIds = Array.isArray(slotDef) ? slotDef.map(id => String(id)) : [];
      const locMatch = this._matchLocationSlotAt(tokens, i, locationIds);
      if (!locMatch) return null;
      out[slotName] = locMatch.locationId;
      out[`${slotName}_name`] = this._pickLang(this.definition.locations?.[locMatch.locationId]?.name) || locMatch.locationId;
      i += locMatch.len;
      continue;
    }

    // Unknown slot types not supported in v1.
    return null;
  }

  return out;
};

GameEngine.prototype._getParserStopwords = function() {
  const base = ['the', 'a', 'an', 'to', 'at', 'on', 'in', 'into', 'from', 'with', 'of'];
  const pt = ['o', 'a', 'os', 'as', 'um', 'uma', 'para', 'pro', 'pra', 'no', 'na', 'nos', 'nas', 'em', 'de', 'do', 'da', 'dos', 'das', 'com'];
  return new Set([...base, ...pt]);
};

GameEngine.prototype._expandVerbSynonyms = function(verbIds) {
  const expanded = new Set();
  for (const vid of verbIds) {
    expanded.add(vid);
    const verbDef = this.definition.verbs?.[vid];
    if (verbDef?.synonyms?.[this.language]) {
      verbDef.synonyms[this.language].forEach(s => expanded.add(s));
    }
  }
  return Array.from(expanded);
};

GameEngine.prototype._matchVerbAt = function(tokens, idx, verbIds) {
  const wantsAny = verbIds.includes('*');
  const maxLen = Math.min(3, tokens.length - idx);
  for (let len = maxLen; len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    const canonical = this._canonicalVerb(phrase);
    if (!canonical) continue;
    const allowedCanonicals = verbIds.filter(v => v !== '*').map(v => this._canonicalVerb(v));
    const isKnownVerbPhrase = this._verbsIndex.has(phrase) || this._verbsIndex.has(canonical);
    if (!isKnownVerbPhrase) continue;
    if (verbIds.length === 0 || wantsAny || allowedCanonicals.includes(canonical)) return { canonical, len };
  }
  return null;
};

GameEngine.prototype._matchItemSlotAt = function(tokens, idx, slotDef) {
  if (slotDef === '*') return this._matchAnyItemAt(tokens, idx);
  if (Array.isArray(slotDef)) {
    const list = slotDef.map(String);
    if (list.includes('*')) return this._matchAnyItemAt(tokens, idx);
    return this._matchSpecificItemAt(tokens, idx, list);
  }
  return null;
};

GameEngine.prototype._matchAnyItemAt = function(tokens, idx) {
  const items = this.definition.items && typeof this.definition.items === 'object' ? this.definition.items : {};
  for (let len = Math.min(5, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    const itemId = this._findItemIdByNameOrSynonym(phrase);
    if (itemId) return { itemId, len };
  }
  // Fallback: check if phrase matches the current location (by name or synonym)
  for (let len = Math.min(5, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    const locId = this._findLocationIdByNameOrSynonym(phrase);
    if (locId && locId === this.gameState.current_location) {
      return { itemId: '__location__', len };
    }
  }
  return null;
};

GameEngine.prototype._matchSpecificItemAt = function(tokens, idx, itemIds) {
  const canonicalIds = itemIds.map((id) => String(id));
  for (let len = Math.min(5, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    for (const itemId of canonicalIds) {
      if (this._phraseMatchesItemId(phrase, itemId)) return { itemId, len };
    }
  }
  return null;
};

GameEngine.prototype._phraseMatchesItemId = function(phrase, itemId) {
  const p = String(phrase || '').trim().toLowerCase();
  const id = String(itemId || '').trim();
  if (!p || !id) return false;
  if (p === id.toLowerCase()) return true;
  if (p === id.replace(/_/g, ' ').toLowerCase()) return true;

  const item = this.definition.items?.[id];
  const name = this._pickLang(item?.name);
  if (name && p === String(name).trim().toLowerCase()) return true;

  const syn = item?.synonyms;
  if (syn && typeof syn === 'object') {
    const langList = syn?.[this.language];
    if (Array.isArray(langList)) {
      for (const s of langList) {
        if (p === String(s).trim().toLowerCase()) return true;
      }
    }
  }
  return false;
};

GameEngine.prototype._matchLocationSlotAt = function(tokens, idx, locationIds) {
  for (let len = Math.min(5, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    for (const locId of locationIds) {
      if (this._phraseMatchesLocationId(phrase, locId)) return { locationId: locId, len };
    }
  }
  return null;
};

GameEngine.prototype._phraseMatchesLocationId = function(phrase, locId) {
  const p = String(phrase || '').trim().toLowerCase();
  const id = String(locId || '').trim();
  if (!p || !id) return false;
  if (p === id.toLowerCase()) return true;
  if (p === id.replace(/_/g, ' ').toLowerCase()) return true;

  const loc = this.definition.locations?.[id];
  const name = this._pickLang(loc?.name);
  if (name && p === String(name).trim().toLowerCase()) return true;

  const syn = loc?.synonyms;
  if (syn && typeof syn === 'object') {
    const langList = syn?.[this.language];
    if (Array.isArray(langList)) {
      for (const s of langList) {
        if (p === String(s).trim().toLowerCase()) return true;
      }
    }
  }
  return false;
};

GameEngine.prototype._expandTemplate = function(str, match) {
  return String(str).replace(/\{(\w+)\}/g, (_m, key) => {
    // Handle {location_or_object_description}
    if (key === 'location_or_object_description') {
      const objectId = match?.object;
      
      // If a real object is specified, return its description
      // __location__ is a sentinel meaning "current location", skip item lookup
      if (objectId && objectId !== '' && objectId !== '__location__') {
        const item = this.definition.items?.[objectId];
        if (item?.description) {
          return this.getItemDescription(objectId);
        }
      }
      
      // Otherwise, return location description
      const locId = this.gameState.current_location;
      const loc = this.getFullLocationData(locId);
      if (loc) {
        const baseDescript = this._pickLang(loc.description?.base);
        const conditions = Array.isArray(loc.description?.conditions) 
          ? loc.description.conditions 
          : [];
        
        let fullDesc = baseDescript || '';
        
        for (const cond of conditions) {
          const condExpanded = this._expandTemplate(String(cond.if || ''), match);
          if (this.evaluateCondition(condExpanded)) {
            const condText = this._pickLang(cond.message);
            if (condText) fullDesc += '\n\n' + condText;
          }
        }
        
        return fullDesc;
      }
      return '';
    }
    
    const v = match?.[key];
    // __location__ sentinel acts as empty string in condition templates
    if (key === 'object' && v === '__location__') return '';
    return v == null ? '' : String(v);
  });
};

GameEngine.prototype._checkActionConditions = function(actionDef, match) {
  const conds = Array.isArray(actionDef.conditions) ? actionDef.conditions : [];
  for (const c of conds) {
    const expanded = this._expandTemplate(String(c), match);
    if (!this.evaluateCondition(expanded)) return false;
  }
  return true;
};

GameEngine.prototype._applyActionEffects = function(effect, match) {
  if (Array.isArray(effect)) {
    for (const e of effect) this.applyEffect(this._expandTemplate(String(e), match));
    return;
  }
  this.applyEffect(this._expandTemplate(String(effect), match));
};

GameEngine.prototype._findItemIdByName = function(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  // Allow direct id
  if (this.definition.items?.[q]) return q;
  for (const [id, item] of Object.entries(this.definition.items || {})) {
    const n = this._pickLang(item?.name).toLowerCase();
    if (n === q) return id;
  }
  return null;
};

GameEngine.prototype._findItemIdByNameOrSynonym = function(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  // Allow direct id / id-as-phrase
  if (this.definition.items?.[q]) return q;
  const asId = q.replace(/\s+/g, '_');
  if (this.definition.items?.[asId]) return asId;

  for (const [id, item] of Object.entries(this.definition.items || {})) {
    const n = this._pickLang(item?.name);
    if (n && String(n).trim().toLowerCase() === q) return id;

    const syn = item?.synonyms;
    if (syn && typeof syn === 'object') {
      const langList = syn?.[this.language];
      if (Array.isArray(langList)) {
        for (const s of langList) {
          if (String(s).trim().toLowerCase() === q) return id;
        }
      }
    }
  }
  return null;
};

GameEngine.prototype._findLocationIdByNameOrSynonym = function(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  if (this.definition.locations?.[q]) return q;
  const asId = q.replace(/\s+/g, '_');
  if (this.definition.locations?.[asId]) return asId;
  for (const [id, loc] of Object.entries(this.definition.locations || {})) {
    const n = this._pickLang(loc?.name);
    if (n && String(n).trim().toLowerCase() === q) return id;
    const syn = loc?.synonyms;
    if (syn && typeof syn === 'object') {
      const langList = syn?.[this.language];
      if (Array.isArray(langList)) {
        for (const s of langList) {
          if (String(s).trim().toLowerCase() === q) return id;
        }
      }
    }
  }
  return null;
};

GameEngine.prototype._takeItemByName = function(query) {
  const itemId = this._findItemIdByName(query);
  if (!itemId) {
    this.hooks.onOutput?.("You don't see that here.");
    this._afterTurn({ kind: 'take' });
    return false;
  }
  const loc = this.getFullLocationData(this.gameState.current_location);
  const contents = Array.isArray(loc?.contents) ? loc.contents : [];
  if (!contents.includes(itemId)) {
    // Not directly in location — search inside containers at this location
    let foundInContainer = false;
    for (const childId of contents) {
      const sub = this.gameState.container_contents?.[childId];
      if (Array.isArray(sub) && sub.includes(itemId)) {
        foundInContainer = true;
        break;
      }
    }
    if (!foundInContainer) {
      this.hooks.onOutput?.("You don't see that here.");
      this._afterTurn({ kind: 'take' });
      return false;
    }
  }
  if (!this.inventory.canAdd(itemId)) {
    this.hooks.onOutput?.('You cannot carry any more.');
    this._afterTurn({ kind: 'take' });
    return false;
  }
  this.inventory.add(itemId);
  this._removeItemFromWorld(itemId);
  this.hooks.onOutput?.(`You take the ${this._pickLang(this.definition.items?.[itemId]?.name) || itemId}.`);
  this._afterTurn({ kind: 'take', itemId });
  return true;
};

GameEngine.prototype._dropItemByName = function(query) {
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
};

GameEngine.prototype._consumeItemByName = function(query) {
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
};

GameEngine.prototype._verbItemByName = function(verb, query) {
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
};
