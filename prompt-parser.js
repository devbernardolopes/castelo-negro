// User prompt parsing logic for the text adventure engine.
// Methods are attached to GameEngine.prototype and loaded after script.js.

/**
 * Process a player command (text parser will be expanded later).
 * @param {string} input
 */
GameEngine.prototype.processPlayerCommand = function(input) {
  const raw = String(input || '').trim();
  if (!raw) return;
  const cmd = raw.toLowerCase();

  // Check for pending disambiguation
  if (this._pendingAmbiguity) {
    const resolved = this._resolveAmbiguity(cmd);
    if (resolved) {
      const { actionId, actionDef, match, slotName } = this._pendingAmbiguity;
      match[slotName] = resolved.itemId;
      match[`${slotName}_name`] = resolved.phrase;
      this._pendingAmbiguity = null;

      const ok = this._checkActionConditions(actionDef, match);
      if (ok) {
        this._executeActionSuccess(actionId, actionDef, match);
      } else {
        this._executeActionFailure(actionId, actionDef, match);
      }
      return true;
    }
    this._pendingAmbiguity = null;
  }

  // If conversation is active, try dialogue options first
  if (this.gameState.conversation?.active) {
    if (this._tryDialogueInput(cmd)) return true;
  }

  const dir = this._resolveDirection(cmd);
  if (dir) return this.go(/** @type {any} */ (dir));

  const goVerb = this._matchGoVerb(cmd);
  if (goVerb) {
    const d = cmd.slice(goVerb.length).trim();
    const resolved = this._resolveDirection(d);
    if (resolved) return this.go(/** @type {any} */ (resolved));
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

GameEngine.prototype._executeActionSuccess = function(actionId, actionDef, match) {
  // Pre-resolve contained_by_name (with short name) before effects run,
  // since the stand action's releaseActor clears contained_by from state.
  const resolvedMatch = { ...match };
  const pid = this._getPlayerActorId();
  const pdata = this.gameState.actors_data?.[pid];
  const cb = pdata?.contained_by;
  if (cb) {
    resolvedMatch.contained_by_name = this._getItemDisplayShortName(cb)
      || this._getItemDisplayName(cb)
      || cb;
  }

  if (actionDef.effect) this._applyActionEffects(actionDef.effect, resolvedMatch);

  if (actionDef.message_pool) {
    const pool = this._pickLang(actionDef.message_pool);
    if (Array.isArray(pool) && pool.length) {
      const msg = pool[Math.floor(Math.random() * pool.length)];
      if (msg) this.hooks.onOutput?.(this._expandTemplate(msg, resolvedMatch));
    }
  } else {
    const msg = this._pickLang(actionDef.message);
    if (msg) this.hooks.onOutput?.(this._expandTemplate(msg, resolvedMatch));
  }

  if (Array.isArray(actionDef.progressive_messages)) {
    const matching = [];
    for (const pm of actionDef.progressive_messages) {
      const expanded = this._expandTemplate(String(pm.condition || ''), resolvedMatch);
      if (this.evaluateCondition(expanded)) matching.push(pm);
    }
    for (const pm of matching) {
      if (pm.effect) this._applyActionEffects(pm.effect, resolvedMatch);
      const msg = this._pickLang(pm.message);
      if (msg) this.hooks.onOutput?.(this._expandTemplate(msg, resolvedMatch));
    }
  }

  this._afterTurn({ kind: 'action', id: actionId });
};

GameEngine.prototype._executeActionFailure = function(actionId, actionDef, match) {
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
  return false;
};

GameEngine.prototype._tryActions = function(cmd) {
  const actions = this.definition.actions && typeof this.definition.actions === 'object' 
    ? this.definition.actions 
    : null;
  if (!actions) return false;

  let firstAmbiguity = null;
  let fallbackMatch = null;

  for (const [actionId, actionDef] of Object.entries(actions)) {
    const match = this._matchAction(actionDef, cmd);
    if (!match) continue;

    if (match._ambiguous) {
      const passingCandidates = [];
      for (const candidateId of match.candidates) {
        const testMatch = { ...match.partialMatch };
        testMatch[match.slotName] = candidateId;
        testMatch[`${match.slotName}_name`] = match.phrase;
        if (this._checkActionConditions(actionDef, testMatch)) {
          passingCandidates.push(candidateId);
        }
      }

      if (passingCandidates.length === 0) {
        const testMatch = { ...match.partialMatch };
        testMatch[match.slotName] = match.candidates[0];
        testMatch[`${match.slotName}_name`] = match.phrase;
        if (this._executeActionFailure(actionId, actionDef, testMatch)) return true;
        continue;
      }

      if (passingCandidates.length === 1) {
        const finalMatch = { ...match.partialMatch };
        finalMatch[match.slotName] = passingCandidates[0];
        finalMatch[`${match.slotName}_name`] = match.phrase;
        this._executeActionSuccess(actionId, actionDef, finalMatch);
        return true;
      }

      if (!firstAmbiguity) {
        firstAmbiguity = {
          actionId, actionDef, match,
          filteredCandidates: passingCandidates
        };
      }
      continue;
    }

    // Catch-all actions (no pattern, empty match) — defer to lowest priority
    if (Object.keys(match).length === 0) {
      if (!fallbackMatch) fallbackMatch = { actionId, actionDef, match };
      continue;
    }

    const ok = this._checkActionConditions(actionDef, match);
    if (ok) {
      this._executeActionSuccess(actionId, actionDef, match);
      return true;
    }

    if (this._executeActionFailure(actionId, actionDef, match)) return true;
  }

  if (firstAmbiguity) {
    const { actionId, actionDef, match, filteredCandidates } = firstAmbiguity;
    this._pendingAmbiguity = {
      actionId,
      actionDef,
      match: match.partialMatch,
      slotName: match.slotName,
      candidates: filteredCandidates,
      phrase: match.phrase
    };
    const msg = this._buildDisambiguationMessage(filteredCandidates, match.phrase);
    if (msg) this.hooks.onOutput?.(msg);
    return true;
  }

  if (fallbackMatch) {
    const { actionId, actionDef, match } = fallbackMatch;
    this._executeActionSuccess(actionId, actionDef, match);
    return true;
  }

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
  let optionalSkipped = false;

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
        optionalSkipped = true;
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
      if (!verbMatch) {
        if (isOptional) { out.verb = ''; optionalSkipped = true; continue; }
        return null;
      }
      out.verb = verbMatch.canonical;
      i += verbMatch.len;
      continue;
    }

    if (slotName === 'object' || slotName === 'target') {
      const itemMatch = this._matchItemSlotAt(tokens, i, slotDef);
      if (!itemMatch) {
        if (isOptional) { out[slotName] = ''; optionalSkipped = true; continue; }
        return null;
      }
      if (itemMatch.ambiguous) {
        return {
          _ambiguous: true,
          slotName,
          candidates: itemMatch.candidates,
          phrase: itemMatch.phrase,
          len: itemMatch.len,
          partialMatch: out
        };
      }
      out[slotName] = itemMatch.itemId;
      out[`${slotName}_name`] = this._getItemDisplayShortName(itemMatch.itemId)
        || this._getItemDisplayName(itemMatch.itemId)
        || itemMatch.phrase;
      i += itemMatch.len;
      continue;
    }

    if (slotName === 'location') {
      const locationIds = Array.isArray(slotDef) ? slotDef.map(id => String(id)) : [];
      const locMatch = this._matchLocationSlotAt(tokens, i, locationIds);
      if (!locMatch) {
        if (isOptional) { out[slotName] = ''; optionalSkipped = true; continue; }
        return null;
      }
      out[slotName] = locMatch.locationId;
      out[`${slotName}_name`] = this._pickLang(this.definition.locations?.[locMatch.locationId]?.name) || locMatch.locationId;
      i += locMatch.len;
      continue;
    }

    if (slotName === 'actor') {
      const actorIds = Array.isArray(slotDef) ? slotDef.map(id => String(id)) : [];
      const actorMatch = this._matchActorSlotAt(tokens, i, actorIds.length ? actorIds : '*');
      if (!actorMatch) {
        if (isOptional) { out[slotName] = ''; optionalSkipped = true; continue; }
        return null;
      }
      if (actorMatch.ambiguous) {
        return {
          _ambiguous: true,
          slotName,
          candidates: actorMatch.candidates,
          phrase: actorMatch.phrase,
          len: actorMatch.len,
          partialMatch: out
        };
      }
      out[slotName] = actorMatch.actorId;
      out[`${slotName}_name`] = this._pickLang(this.definition.actors?.[actorMatch.actorId]?.name) || actorMatch.actorId;
      i += actorMatch.len;
      continue;
    }

    // Unknown slot types not supported in v1.
    return null;
  }

  skipStops();
  if (i < tokens.length) {
    if (optionalSkipped) return null;
    for (let j = i; j < tokens.length; j++) {
      if (this._verbsIndex.has(tokens[j])) return null;
    }
  }

  return out;
};

GameEngine.prototype._getParserStopwords = function() {
  const base = ['the', 'a', 'an', 'to', 'at', 'on', 'in', 'into', 'from', 'with', 'of'];
  const pt = ['o', 'a', 'os', 'as', 'um', 'uma', 'para', 'pro', 'pra', 'no', 'na', 'nos', 'nas', 'em', 'de', 'do', 'da', 'dos', 'das', 'com'];
  return new Set([...base, ...pt]);
};

GameEngine.prototype._stripPossessive = function(str) {
  if (this.language !== 'en') return String(str);
  return String(str).replace(/'s$/, '').replace(/'$/, '');
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

GameEngine.prototype._buildActorIndex = function() {
  const index = new Map();
  if (!this.definition.actors) return index;
  for (const [actorId, actorDef] of Object.entries(this.definition.actors)) {
    index.set(actorId.toLowerCase(), actorId);
    const name = this._pickLang(actorDef.name);
    if (name) index.set(String(name).trim().toLowerCase(), actorId);
    const syn = actorDef.synonyms;
    if (syn && typeof syn === 'object') {
      const list = syn[this.language];
      if (Array.isArray(list)) {
        for (const s of list) index.set(String(s).trim().toLowerCase(), actorId);
      }
    }
  }
  return index;
};

GameEngine.prototype._matchActorSlotAt = function(tokens, idx, slotDef) {
  const isWildcard = slotDef === '*' || (Array.isArray(slotDef) && slotDef.includes('*'));

  let candidates;
  if (isWildcard) {
    candidates = Object.keys(this.definition.actors || {});
  } else if (Array.isArray(slotDef)) {
    candidates = slotDef.map(String);
  } else {
    return null;
  }

  for (let len = Math.min(5, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    let p = String(phrase).trim().toLowerCase();
    p = this._stripPossessive(p);
    if (!p) continue;

    const matched = [];
    for (const actorId of candidates) {
      if (p === actorId.toLowerCase()) { matched.push(actorId); continue; }
      if (p === actorId.replace(/_/g, ' ').toLowerCase()) { matched.push(actorId); continue; }

      const actorDef = this.definition.actors?.[actorId];
      if (!actorDef) continue;
      const name = this._pickLang(actorDef.name);
      if (name && p === String(name).trim().toLowerCase()) { matched.push(actorId); continue; }

      const syn = actorDef.synonyms;
      if (syn && typeof syn === 'object') {
        const langList = syn[this.language];
        if (Array.isArray(langList)) {
          for (const s of langList) {
            if (p === String(s).trim().toLowerCase()) { matched.push(actorId); break; }
          }
        }
      }
    }

    if (matched.length === 1) return { actorId: matched[0], len, phrase };
    if (matched.length > 1) return { ambiguous: true, candidates: matched, len, phrase };
  }
  return null;
};

GameEngine.prototype._tryDialogueInput = function(input) {
  const conv = this.gameState.conversation;
  if (!conv?.active) return false;

  const cmd = String(input || '').trim().toLowerCase();
  if (!cmd) return false;

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

  // Try number match
  const num = parseInt(cmd, 10);
  if (!isNaN(num) && num >= 1 && num <= visibleOptions.length) {
    this._selectDialogueOption(num - 1);
    return true;
  }

  // Try text match (exact after normalization)
  const matching = [];
  for (let i = 0; i < visibleOptions.length; i++) {
    const optText = this._pickLang(visibleOptions[i].text);
    if (optText) {
      const normalized = String(optText).trim().toLowerCase().replace(/[.!?]+$/, '');
      if (cmd === normalized) matching.push(i);
    }
  }
  if (matching.length === 1) {
    this._selectDialogueOption(matching[0]);
    return true;
  }

  // Try partial text match (input is a substring of exactly one option)
  if (cmd.length >= 2) {
    const partialMatches = [];
    for (let i = 0; i < visibleOptions.length; i++) {
      const optText = this._pickLang(visibleOptions[i].text);
      if (optText) {
        const normalized = String(optText).trim().toLowerCase().replace(/[.!?]+$/, '');
        if (normalized.includes(cmd)) partialMatches.push(i);
      }
    }
    if (partialMatches.length === 1) {
      this._selectDialogueOption(partialMatches[0]);
      return true;
    }
  }

  return false;
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
  for (let len = Math.min(5, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    const matches = this._findAllItemIdsByNameOrSynonym(phrase);
    if (matches.length === 1) return { itemId: matches[0], len, phrase };
    if (matches.length > 1) return { ambiguous: true, candidates: matches, phrase, len };
  }
  // Fallback: check if phrase matches the current location (by name or synonym)
  for (let len = Math.min(5, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    const locId = this._findLocationIdByNameOrSynonym(phrase);
    if (locId && locId === this.gameState.current_location) {
      return { itemId: '__location__', len, phrase };
    }
  }
  return null;
};

GameEngine.prototype._matchSpecificItemAt = function(tokens, idx, itemIds) {
  const canonicalIds = itemIds.map((id) => String(id));
  for (let len = Math.min(5, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    const matches = [];
    for (const itemId of canonicalIds) {
      if (this._phraseMatchesItemId(phrase, itemId)) matches.push(itemId);
    }
    if (matches.length === 1) return { itemId: matches[0], len, phrase };
    if (matches.length > 1) return { ambiguous: true, candidates: matches, phrase, len };
  }
  return null;
};

GameEngine.prototype._phraseMatchesItemId = function(phrase, itemId) {
  let p = String(phrase || '').trim().toLowerCase();
  p = this._stripPossessive(p);
  const id = String(itemId || '').trim();
  if (!p || !id) return false;
  if (p === id.toLowerCase()) return true;
  if (p === id.replace(/_/g, ' ').toLowerCase()) return true;

  const item = this.definition.items?.[id];
  const name = this._pickLang(item?.name);
  if (name && p === String(name).trim().toLowerCase()) return true;

  const shortName = this._pickLang(item?.short_name);
  if (shortName && p === String(shortName).trim().toLowerCase()) return true;

  const resolvedName = this._getItemResolvedName(id);
  if (resolvedName) {
    const resolvedLower = String(resolvedName).trim().toLowerCase();
    if (p === resolvedLower || this._stripPossessive(resolvedLower) === p) return true;
  }

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
  let p = String(phrase || '').trim().toLowerCase();
  p = this._stripPossessive(p);
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
      
      // Otherwise, return location description (includes ground item messages)
      const locId = this.gameState.current_location;
      const loc = this.getFullLocationData(locId);
      if (loc) {
        const nameText = this._pickLang(loc.name);
        if (nameText) this.hooks.onLocationNameRender?.(nameText);
        return this.getLocationDescription(locId);
      }
      return '';
    }

    if (key === 'object_owner') {
      const objId = match?.object;
      if (objId && objId !== '__location__') {
        const oid = this._getItemOwner(objId);
        if (oid) return this._pickLang(this.definition.actors?.[oid]?.name) || oid;
      }
      return '';
    }

    const v = match?.[key];
    // __location__ sentinel acts as empty string in condition templates
    if (key === 'object' && v === '__location__') return '';
    if (v != null) return String(v);

    // Fallback: current player's own properties
    const pActorId = this._getPlayerActorId();
    const pData = this.gameState.actors_data?.[pActorId];
    if (pData?.properties?.[key] !== undefined) {
      return String(pData.properties[key]);
    }

    // Fallback: relationship_<otherId>_<propName>
    const relMatch = key.match(/^relationship_(\w+)_(\w+)$/);
    if (relMatch) {
      const val = pData?.relationships?.[relMatch[1]]?.[relMatch[2]];
      if (val !== undefined) return String(val);
    }

    // Fallback: actor_<actorId>_<propName>
    const actorMatch = key.match(/^actor_(\w+)_(\w+)$/);
    if (actorMatch) {
      const val = this.gameState.actors_data?.[actorMatch[1]]?.properties?.[actorMatch[2]];
      if (val !== undefined) return String(val);
    }

    // Fallback: contained_by_name (item name of what the player is sitting on)
    if (key === 'contained_by_name') {
      const pActorId = this._getPlayerActorId();
      const pData = this.gameState.actors_data?.[pActorId];
      const containedBy = pData?.contained_by;
      if (containedBy) {
        const itemDef = this.definition.items?.[containedBy];
        return this._pickLang(itemDef?.name) || containedBy;
      }
      return '';
    }

    return '';
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
  let q = String(query || '').trim().toLowerCase();
  q = this._stripPossessive(q);
  if (!q) return null;
  // Allow direct id
  if (this.definition.items?.[q]) return q;
  for (const [id, item] of Object.entries(this.definition.items || {})) {
    const n = this._pickLang(item?.name).toLowerCase();
    if (n === q) return id;
    const resolved = this._getItemResolvedName(id);
    if (resolved) {
      const resolvedLower = String(resolved).trim().toLowerCase();
      if (resolvedLower === q || this._stripPossessive(resolvedLower) === q) return id;
    }
  }
  return null;
};

GameEngine.prototype._findItemIdByNameOrSynonym = function(query) {
  let q = String(query || '').trim().toLowerCase();
  q = this._stripPossessive(q);
  if (!q) return null;
  // Allow direct id / id-as-phrase
  if (this.definition.items?.[q]) return q;
  const asId = q.replace(/\s+/g, '_');
  if (this.definition.items?.[asId]) return asId;

  for (const [id, item] of Object.entries(this.definition.items || {})) {
    const n = this._pickLang(item?.name);
    if (n && String(n).trim().toLowerCase() === q) return id;

    const resolved = this._getItemResolvedName(id);
    if (resolved) {
      const resolvedLower = String(resolved).trim().toLowerCase();
      if (resolvedLower === q || this._stripPossessive(resolvedLower) === q) return id;
    }

    const sn = this._pickLang(item?.short_name);
    if (sn && String(sn).trim().toLowerCase() === q) return id;

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

GameEngine.prototype._findAllItemIdsByNameOrSynonym = function(query) {
  let q = String(query || '').trim().toLowerCase();
  q = this._stripPossessive(q);
  if (!q) return [];
  const results = [];
  if (this.definition.items?.[q]) results.push(q);
  const asId = q.replace(/\s+/g, '_');
  if (asId !== q && this.definition.items?.[asId]) results.push(asId);

  for (const [id, item] of Object.entries(this.definition.items || {})) {
    if (results.includes(id)) continue;
    const n = this._pickLang(item?.name);
    if (n && String(n).trim().toLowerCase() === q) {
      results.push(id);
      continue;
    }
    const resolved = this._getItemResolvedName(id);
    if (resolved) {
      const resolvedLower = String(resolved).trim().toLowerCase();
      if (resolvedLower === q || this._stripPossessive(resolvedLower) === q) {
        results.push(id);
        continue;
      }
    }
    const sn = this._pickLang(item?.short_name);
    if (sn && String(sn).trim().toLowerCase() === q) {
      results.push(id);
      continue;
    }
    const syn = item?.synonyms;
    if (syn && typeof syn === 'object') {
      const langList = syn?.[this.language];
      if (Array.isArray(langList)) {
        for (const s of langList) {
          if (String(s).trim().toLowerCase() === q) {
            if (!results.includes(id)) results.push(id);
            break;
          }
        }
      }
    }
  }
  return results;
};

GameEngine.prototype._findLocationIdByNameOrSynonym = function(query) {
  let q = String(query || '').trim().toLowerCase();
  q = this._stripPossessive(q);
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
  if (!this._itemExistsInLocationScope(itemId)) {
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
  this._removeItemFromWorld(itemId);
  this.hooks.onOutput?.(`You take the ${this._getItemDisplayName(itemId) || itemId}.`);
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
  this.hooks.onOutput?.(msg || `You drop the ${this._getItemDisplayName(itemId) || itemId}.`);
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

GameEngine.prototype._resolveAmbiguity = function(input) {
  let q = String(input || '').trim().toLowerCase();
  q = this._stripPossessive(q);
  if (!q || !this._pendingAmbiguity) return null;
  const { candidates } = this._pendingAmbiguity;

  for (const candidateId of candidates) {
    if (this._phraseMatchesItemId(q, candidateId)) {
      return { itemId: candidateId, phrase: q };
    }
  }

  const words = q.split(/\s+/);
  if (words.length === 1) {
    const singleWord = this._stripPossessive(words[0]);
    const scored = [];
    for (const candidateId of candidates) {
      const item = this.definition.items?.[candidateId];
      if (!item) continue;
      const name = this._pickLang(item.name) || '';
      const syns = item.synonyms?.[this.language] || [];
      const allTerms = [
        candidateId.replace(/_/g, ' '),
        name.toLowerCase(),
        ...syns.map(s => s.toLowerCase())
      ];
      for (const term of allTerms) {
        if (term.split(/\s+/).includes(singleWord)) {
          scored.push(candidateId);
          break;
        }
      }
    }
    if (scored.length === 1) {
      return { itemId: scored[0], phrase: singleWord };
    }
  }

  return null;
};

GameEngine.prototype._buildDisambiguationMessage = function(candidates, phrase) {
  const labels = candidates.map(id => {
    const item = this.definition.items?.[id];
    const actor = this.definition.actors?.[id];
    const def = item || actor;
    if (!def) return id;
    const name = this._pickLang(def.name) || id;
    const syns = def.synonyms?.[this.language] || [];

    const allTerms = [...syns.map(s => s.trim().toLowerCase()), name.trim().toLowerCase(), id.replace(/_/g, ' ')];
    const sharedTerms = new Set();
    if (candidates.length > 1) {
      for (const otherId of candidates) {
        if (otherId === id) continue;
        const otherDef = this.definition.items?.[otherId] || this.definition.actors?.[otherId];
        if (!otherDef) continue;
        const otherName = this._pickLang(otherDef.name) || '';
        const otherSyns = otherDef.synonyms?.[this.language] || [];
        const otherTerms = [...otherSyns.map(s => s.trim().toLowerCase()), otherName.trim().toLowerCase(), otherId.replace(/_/g, ' ')];
        for (const t of allTerms) {
          if (otherTerms.includes(t)) sharedTerms.add(t);
        }
      }
    }

    const unique = allTerms.filter(t => !sharedTerms.has(t));
    if (unique.length > 0) {
      unique.sort((a, b) => a.length - b.length);
      return unique[0];
    }
    allTerms.sort((a, b) => a.length - b.length);
    return allTerms[0];
  });

  if (this.language === 'pt-br') {
    return `Qual ${phrase}? ${labels.join(' ou ')}?`;
  }
  return `Which ${phrase}? ${labels.join(' or ')}?`;
};
