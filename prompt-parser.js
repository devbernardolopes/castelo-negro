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

      // Check follow-ups before conditions — slots left empty get prompted
      if (actionDef.follow_up) {
        for (const [slotName, promptMsg] of Object.entries(actionDef.follow_up)) {
          if (!match[slotName] || match[slotName] === '') {
            const msg = this._pickLang(promptMsg);
            if (msg) this.hooks.onOutput?.(msg);
            this._pendingSlotPrompt = {
              actionId, actionDef, match,
              slotName,
              slotDef: this._getSlotDef(actionDef, slotName),
              message: promptMsg
            };
            return true;
          }
        }
      }

      const ok = this._checkActionConditions(actionDef, match);
      if (ok) {
        if (actionDef.confirmation) {
          const msg = this._pickLang(actionDef.confirmation);
          if (msg) this.hooks.onOutput?.(msg);
          this._pendingConfirmation = { actionId, actionDef, match };
          return true;
        }
        this._executeActionSuccess(actionId, actionDef, match);
      } else {
        this._executeActionFailure(actionId, actionDef, match);
      }
      return true;
    }
    this._pendingAmbiguity = null;
  }

  // Check for pending slot prompt
  if (this._pendingSlotPrompt) {
    const { actionId, actionDef, match, slotName, slotDef } = this._pendingSlotPrompt;
    const resolved = this._resolveSlotPrompt(slotName, slotDef, cmd, actionDef, match);
    if (resolved) {
      if (resolved.ambiguous) {
        this._pendingSlotPrompt = null;
        this._pendingAmbiguity = {
          actionId,
          actionDef,
          match,
          slotName,
          candidates: resolved.candidates,
          phrase: resolved.phrase
        };
        const msg = this._buildDisambiguationMessage(resolved.candidates, resolved.phrase, false);
        if (msg) this.hooks.onOutput?.(msg);
        return true;
      }
      match[slotName] = resolved.value;
      match[`${slotName}_name`] = resolved.label;
      if (resolved.phrase) match[`_${slotName}_phrase`] = resolved.phrase;
      this._pendingSlotPrompt = null;

      // If the resolved value was an actor name used as an object slot,
      // reconstruct the full command and re-process so legacy handlers
      // (e.g. _takeItemByName) can produce a proper response instead of
      // the action's conditions failing with empty values.
      if (match._actorAsObject) {
        const fullCmd = ((match.verb || '') + ' ' + cmd).trim();
        this.processPlayerCommand(fullCmd);
        return true;
      }

      // Check if another slot needs prompting (multi-slot sequential)
      if (actionDef.follow_up) {
        for (const [nextSlot, nextPrompt] of Object.entries(actionDef.follow_up)) {
          if (!match[nextSlot] || match[nextSlot] === '') {
            const msg = this._pickLang(nextPrompt);
            if (msg) this.hooks.onOutput?.(msg);
            this._pendingSlotPrompt = {
              actionId, actionDef, match,
              slotName: nextSlot,
              slotDef: this._getSlotDef(actionDef, nextSlot),
              message: nextPrompt
            };
            return true;
          }
        }
      }

      const ok = this._checkActionConditions(actionDef, match);
      if (ok) {
        if (actionDef.confirmation) {
          const msg = this._pickLang(actionDef.confirmation);
          if (msg) this.hooks.onOutput?.(msg);
          this._pendingConfirmation = { actionId, actionDef, match };
          return true;
        }
        this._executeActionSuccess(actionId, actionDef, match);
      } else {
        this._executeActionFailure(actionId, actionDef, match);
      }
    } else {
      this._pendingSlotPrompt = null;
      if (match._strangerBlocked) {
        this.hooks.onOutput?.("You don't know anyone by that name.");
        this._afterTurn({ kind: 'action_failed', id: actionId });
      } else if (!this._executeActionFailure(actionId, actionDef, match)) {
        this.hooks.onOutput?.("You can't do that.");
        this._afterTurn({ kind: 'action_cancelled', id: actionId });
      }
    }
    return true;
  }

  // Check for pending confirmation
  if (this._pendingConfirmation) {
    const { actionId, actionDef, match } = this._pendingConfirmation;
    const answer = this._resolveBinaryAnswer(cmd);
    this._pendingConfirmation = null;
    if (answer === 'yes') {
      this._executeActionSuccess(actionId, actionDef, match);
    } else {
      this.hooks.onOutput?.("Very well.");
      this._afterTurn({ kind: 'action_cancelled', id: actionId });
    }
    return true;
  }

  // If reading mode is active, intercept input for page navigation first
  if (this.gameState.reading?.active) {
    if (this._tryReadingInput(cmd)) return true;
    this._renderReadingChunk(this.gameState.reading.currentChunk);
    return true;
  }

  // If conversation is active, try dialogue options next
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

  // Redirect to reading mode only if this is specifically a "read" action
  if (actionId === 'read') {
    const objectId = resolvedMatch.object;
    const item = objectId ? this.definition.items?.[objectId] : null;
    if (item?.readable && !this.gameState.reading?.active) {
      this._startReading(objectId);
      if (this.gameState.reading?.active) return;
    }
  }

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
        if (msg) {
          // Temporarily replace {slotName}_name with _{slotName}_phrase
          // so failure messages use the player's raw input instead of
          // resolved display names (avoiding information leakage).
          const saved = {};
          for (const key of Object.keys(match)) {
            const m = key.match(/^_(.+)_phrase$/);
            if (m) {
              const nameKey = m[1] + '_name';
              if (nameKey in match) {
                saved[nameKey] = match[nameKey];
                match[nameKey] = match[key];
              }
            }
          }
          this.hooks.onOutput?.(this._expandTemplate(msg, match));
          // Restore original display names
          for (const [k, v] of Object.entries(saved)) {
            match[k] = v;
          }
        }
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
        // Check if conditions failed due to empty follow-up slots
        let hasEmptyFollowUp = false;
        if (actionDef.follow_up) {
          for (const [fSlotName] of Object.entries(actionDef.follow_up)) {
            if (fSlotName === match.slotName) continue;
            if (!match.partialMatch[fSlotName] || match.partialMatch[fSlotName] === '') {
              hasEmptyFollowUp = true;
              break;
            }
          }
        }
        if (hasEmptyFollowUp) {
          // Defer condition check — let follow-up handle empty slots after ambiguity is resolved
          passingCandidates.push(...match.candidates);
        } else {
          const testMatch = { ...match.partialMatch };
          testMatch[match.slotName] = match.candidates[0];
          testMatch[`${match.slotName}_name`] = match.phrase;
          if (this._executeActionFailure(actionId, actionDef, testMatch)) return true;
          continue;
        }
      }

      if (passingCandidates.length === 1) {
        const finalMatch = { ...match.partialMatch };
        finalMatch[match.slotName] = passingCandidates[0];
        finalMatch[`${match.slotName}_name`] = match.phrase;
        this._executeActionSuccess(actionId, actionDef, finalMatch);
        return true;
      }

      this._pendingAmbiguity = {
        actionId,
        actionDef,
        match: match.partialMatch,
        slotName: match.slotName,
        candidates: passingCandidates,
        phrase: match.phrase
      };
      const msg = this._buildDisambiguationMessage(passingCandidates, match.phrase, match._isStrangerAmbiguity);
      if (msg) this.hooks.onOutput?.(msg);
      return true;
    }

    // Stranger blocked: player used a name for someone they don't know
    if (match._strangerBlocked) {
      this.hooks.onOutput?.("You don't know anyone by that name.");
      this._afterTurn({ kind: 'action_failed', id: actionId });
      return true;
    }

    // Catch-all actions (no pattern, empty match) — defer to lowest priority
    if (Object.keys(match).length === 0) {
      if (!fallbackMatch) fallbackMatch = { actionId, actionDef, match };
      continue;
    }

    // Check for follow-up slot prompts before evaluating conditions
    if (actionDef.follow_up) {
      for (const [slotName, promptMsg] of Object.entries(actionDef.follow_up)) {
        if (!match[slotName] || match[slotName] === '') {
          // If the player already attempted to fill this slot (leftover tokens
          // in the command that weren't consumed by any slot), use the leftover
          // text as the slot value so conditions / conditional_messages can
          // produce proper error messages (e.g. "There's no sabinekl here.")
          // instead of prompting again.
          const consumed = match._consumedTokens || 0;
          const total = match._totalTokens || 0;
          if (consumed < total) {
            const tokens = String(cmd || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            const stopwords = this._getParserStopwords();
            const leftover = tokens.slice(consumed).filter(t => !stopwords.has(t));
            if (leftover.length > 0) {
              const rawVal = leftover.join(' ');
              // If leftover text matches an actor name and this action has no
              // actor slot, skip the action entirely so it doesn't treat an
              // actor name as an item (e.g. "take anya", "take sabine").
              const actorCheck = this._matchActorSlotAt(leftover, 0, ['*']);
              const hasActorSlot = actionDef.follow_up?.actor !== undefined
                || actionDef.pattern?.some(s => s.actor)
                || (actionDef.patterns && Object.values(actionDef.patterns).some(
                    pat => Array.isArray(pat) && pat.some(s => s.actor)));
              if (actorCheck && !hasActorSlot) {
                match._skipAction = true;
                break;
              }
              match[slotName] = rawVal;
              match[`${slotName}_name`] = rawVal;
            }
            break;
          }

          const msg = this._pickLang(promptMsg);
          if (msg) this.hooks.onOutput?.(msg);
          this._pendingSlotPrompt = {
            actionId,
            actionDef,
            match,
            slotName,
            slotDef: this._getSlotDef(actionDef, slotName),
            message: promptMsg
          };
          return true;
        }
      }
    }

    // Skip action if marked (e.g. leftover actor name used in item slot)
    if (match._skipAction) continue;

    const ok = this._checkActionConditions(actionDef, match);
    if (ok) {
      // Confirmation gate
      if (actionDef.confirmation) {
        const msg = this._pickLang(actionDef.confirmation);
        if (msg) this.hooks.onOutput?.(msg);
        this._pendingConfirmation = { actionId, actionDef, match };
        return true;
      }
      this._executeActionSuccess(actionId, actionDef, match);
      return true;
    }

    if (this._executeActionFailure(actionId, actionDef, match)) return true;
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
        out[Object.keys(slotEntry)[0]] = '';
        optionalSkipped = true;
        continue;
      }
      // If required, we fail
      return null;
    }

    if (!slotEntry || typeof slotEntry !== 'object') return null;
    const entries = Object.entries(slotEntry).filter(([k]) => k !== 'optional' && k !== 'match_mode');
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
        if (isOptional) {
          // Player typed something for this slot but it didn't match any item.
          // Inject the raw text as the slot value so conditions can fail and
          // conditional_messages can produce proper error responses instead of
          // empty-slot bypass (e.g. examine: "{object} == '' or here.has(...)").
          const remaining = tokens.slice(i).filter(t => !stopwords.has(t));
          if (remaining.length > 0) {
            const raw = remaining.join(' ');
            out[slotName] = raw;
            out[`${slotName}_name`] = raw;
            out[`_${slotName}_phrase`] = raw;
            i = tokens.length;
          } else {
            out[slotName] = '';
            optionalSkipped = true;
          }
          continue;
        }
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
      out[`_${slotName}_phrase`] = itemMatch.phrase;
      i += itemMatch.len;
      continue;
    }

    if (slotName === 'location') {
      const locationIds = Array.isArray(slotDef) ? slotDef.map(id => String(id)) : [];
      const locMatch = this._matchLocationSlotAt(tokens, i, locationIds);
      if (!locMatch) {
        if (isOptional) {
          const remaining = tokens.slice(i).filter(t => !stopwords.has(t));
          if (remaining.length > 0) {
            const raw = remaining.join(' ');
            out[slotName] = raw;
            out[`${slotName}_name`] = raw;
            i = tokens.length;
          } else {
            out[slotName] = '';
            optionalSkipped = true;
          }
          continue;
        }
        return null;
      }
      out[slotName] = locMatch.locationId;
      out[`${slotName}_name`] = this._pickLang(this.definition.locations?.[locMatch.locationId]?.name) || locMatch.locationId;
      i += locMatch.len;
      continue;
    }

    if (slotName === 'actor') {
      skipStops();
      const actorIds = Array.isArray(slotDef) ? slotDef.map(id => String(id)) : [];
      const matchMode = slotEntry.match_mode;
      const actorMatch = this._matchActorSlotAt(tokens, i, actorIds.length ? actorIds : '*', { matchMode });
      if (!actorMatch) {
        if (isOptional) {
          const remaining = tokens.slice(i).filter(t => !stopwords.has(t));
          if (remaining.length > 0) {
            const raw = remaining.join(' ');
            out[slotName] = raw;
            out[`${slotName}_name`] = raw;
            out[`_${slotName}_phrase`] = raw;
            i = tokens.length;
          } else {
            out[slotName] = '';
            optionalSkipped = true;
          }
          continue;
        }
        return null;
      }
      if (actorMatch.ambiguous) {
        const result = {
          _ambiguous: true,
          slotName,
          candidates: actorMatch.candidates,
          phrase: actorMatch.phrase,
          len: actorMatch.len,
          partialMatch: out
        };
        if (actorMatch._isStrangerAmbiguity) result._isStrangerAmbiguity = true;
        return result;
      }
      if (actorMatch._strangerBlocked) out._strangerBlocked = true;
      if (actorMatch._visualMatch) out._visualMatch = true;
      out[slotName] = actorMatch.actorId;
      out[`${slotName}_name`] = this._pickLang(this.definition.actors?.[actorMatch.actorId]?.name) || actorMatch.actorId;
      out[`_${slotName}_phrase`] = actorMatch.phrase;
      i += actorMatch.len;

      // If actor was matched by stripping possessive (e.g. "sabine's" → "sabine")
      // and remaining non-stopword tokens match an item, reject so a more specific
      // action (e.g. examine with object="sabine's jeans") can handle the input.
      const possPhrase = String(actorMatch.phrase || '').trim();
      if (possPhrase.endsWith("'s") || possPhrase.endsWith("'")) {
        skipStops();
        if (i < tokens.length) {
          const restTokens = tokens.slice(i).filter(t => !stopwords.has(t));
          if (restTokens.length > 0) {
            const fullPhrase = (possPhrase + ' ' + restTokens.join(' ')).toLowerCase();
            if (this._findAllItemIdsByNameOrSynonym(fullPhrase).length > 0) {
              return null;
            }
          }
        }
      }

      continue;
    }

    // Unknown slot types not supported in v1.
    return null;
  }

  skipStops();
  out._consumedTokens = i;
  out._totalTokens = tokens.length;
  if (i < tokens.length) {
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

GameEngine.prototype._matchActorSlotAt = function(tokens, idx, slotDef, opts = {}) {
  const isWildcard = slotDef === '*' || (Array.isArray(slotDef) && slotDef.includes('*'));

  let candidates;
  if (isWildcard) {
    candidates = this._getVisibleActorsInLocation(this.gameState.current_location);
  } else if (Array.isArray(slotDef)) {
    const visible = new Set(this._getVisibleActorsInLocation(this.gameState.current_location));
    candidates = slotDef.map(String).filter(id => visible.has(id));
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

      if (opts.matchMode !== 'name_only') {
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
    }

    if (matched.length > 1) {
      const playerId = this._getPlayerActorId();
      const idx = matched.indexOf(playerId);
      if (idx !== -1) matched.splice(idx, 1);
    }
    if (matched.length === 0) {
      const selfWords = ['myself', 'me', 'yourself'];
      if (selfWords.includes(p)) {
        matched.push(this._getPlayerActorId());
      }
    }
    if (matched.length === 1) {
      const playerId = this._getPlayerActorId();
      if (matched[0] === playerId) {
        return { actorId: matched[0], len, phrase };
      }
      if (this._isActorStrangerToPlayer(matched[0])) {
        if (opts.matchMode !== 'name_only' && this._getActorAliasPhrases(matched[0]).has(p)) {
          return { actorId: matched[0], len, phrase, _aliasMatch: true };
        }
        return { _strangerBlocked: true, actorId: matched[0], len, phrase };
      }
      return { actorId: matched[0], len, phrase };
    }
    if (matched.length > 1) {
      const playerId = this._getPlayerActorId();
      const allStrangers = matched.every(id => this._isActorStrangerToPlayer(id));
      return { ambiguous: true, candidates: matched, len, phrase, _isStrangerAmbiguity: allStrangers };
    }
  }

  // Fallback: try visual descriptor matching (no stranger blocking)
  for (let len = Math.min(3, tokens.length - idx); len >= 1; len--) {
    const phrase = tokens.slice(idx, idx + len).join(' ');
    let p = String(phrase).trim().toLowerCase();
    p = this._stripPossessive(p);
    if (!p) continue;

    const matched = [];
    for (const actorId of candidates) {
      const descriptors = this._getActorVisualDescriptors(actorId);
      if (descriptors.has(p)) matched.push(actorId);
    }

    if (matched.length > 1) {
      const playerId = this._getPlayerActorId();
      const idx = matched.indexOf(playerId);
      if (idx !== -1) matched.splice(idx, 1);
    }
    if (matched.length === 1) return { actorId: matched[0], len, phrase, _visualMatch: true };
    if (matched.length > 1) {
      return { ambiguous: true, candidates: matched, len, phrase, _isStrangerAmbiguity: true };
    }
  }

  return null;
};

GameEngine.prototype._getActorAliasPhrases = function(actorId) {
  const actorDef = this.definition.actors?.[actorId];
  const aliases = new Set();
  if (!actorDef) return aliases;

  const name = this._pickLang(actorDef.name);
  if (name) aliases.add(String(name).trim().toLowerCase());

  const syn = actorDef.synonyms;
  if (syn && typeof syn === 'object') {
    const list = syn[this.language];
    if (Array.isArray(list)) {
      for (const s of list) aliases.add(String(s).trim().toLowerCase());
    }
  }

  for (const descriptor of this._getActorVisualDescriptors(actorId)) {
    aliases.add(String(descriptor).trim().toLowerCase());
  }

  return aliases;
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
    const ok = this._selectDialogueOption(num - 1);
    if (ok) return true;
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

  // Input didn't match any dialogue option — end conversation
  this._endConversation();
  return false;
};

GameEngine.prototype._tryReadingInput = function(input) {
  const reading = this.gameState.reading;
  if (!reading?.active) return false;

  const cmd = String(input || '').trim().toLowerCase();
  if (!cmd) return false;

  const isFirst = reading.currentChunk === 0;
  const isLast = reading.currentChunk === reading.totalChunks - 1;

  // Calculate option numbers based on position
  // Page 1: [1] Continue, [2] Close  → 2 options
  // Pages 2..N-1: [1] Continue, [2] Previous, [3] Close  → 3 options
  // Page N: [1] Close, [2] Previous  → 2 options
  // Single page: [1] Close  → 1 option
  let optionCount;
  if (isFirst && isLast) {
    optionCount = 1;
  } else if (isFirst || isLast) {
    optionCount = 2;
  } else {
    optionCount = 3;
  }

  // Try text commands
  const nextWords = ['next', 'n', 'continue', 'c'];
  const prevWords = ['back', 'b', 'prev', 'p', 'previous'];
  const closeWords = ['exit', 'e', 'close', 'quit', 'stop', 'end'];

  if (nextWords.includes(cmd) && !isLast) {
    this._nextReadingPage();
    return true;
  }
  if (prevWords.includes(cmd) && !isFirst) {
    this._prevReadingPage();
    return true;
  }
  if (closeWords.includes(cmd)) {
    this._endReading();
    return true;
  }

  // Try "page N" or "go N" or "go to N" syntax
  const pageMatch = cmd.match(/^(?:page|go(?:\s+to)?)\s+(\d+)$/);
  if (pageMatch) {
    const pageNum = parseInt(pageMatch[1], 10);
    if (pageNum >= 1 && pageNum <= reading.totalChunks) {
      this._goToReadingPage(pageNum);
      return true;
    }
    return false;
  }

  // Try bare number
  const num = parseInt(cmd, 10);
  if (!isNaN(num) && num >= 1) {
    if (num <= optionCount) {
      // Map option number to action
      // Page 1: [1]=next, [2]=close
      // Middle: [1]=next, [2]=prev, [3]=close
      // Last:   [1]=close, [2]=prev
      if (isFirst && isLast && num === 1) {
        this._endReading();
        return true;
      }
      if (isFirst) {
        if (num === 1) { this._nextReadingPage(); return true; }
        if (num === 2) { this._endReading(); return true; }
      } else if (isLast) {
        if (num === 1) { this._endReading(); return true; }
        if (num === 2) { this._prevReadingPage(); return true; }
      } else {
        if (num === 1) { this._nextReadingPage(); return true; }
        if (num === 2) { this._prevReadingPage(); return true; }
        if (num === 3) { this._endReading(); return true; }
      }
    } else if (num <= reading.totalChunks) {
      // Number exceeds option count → direct page jump
      this._goToReadingPage(num);
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

GameEngine.prototype._getScopedItemIds = function() {
  const currentLoc = this.gameState.current_location;
  const loc = this.getFullLocationData(currentLoc);
  const scoped = new Set();
  const queue = [];

  for (const c of (Array.isArray(loc?.contents) ? loc.contents : [])) {
    queue.push([c, null]);
  }

  for (const actorData of Object.values(this.gameState.actors_data || {})) {
    if (actorData.current_location !== currentLoc) continue;
    for (const rootId of [
      ...(Array.isArray(actorData.inventory) ? actorData.inventory : []),
      ...(Array.isArray(actorData.wearing) ? actorData.wearing : [])
    ]) {
      queue.push([rootId, null]);
    }
  }

  const visited = new Set();
  while (queue.length) {
    const [childId, parentId] = queue.shift();
    if (visited.has(childId)) continue;
    visited.add(childId);

    if (parentId) {
      const parentDef = this.definition.items?.[parentId];
      if (parentDef?.openable && !this._isItemOpen(parentId)) continue;
      if (!this._isContainerItemVisible(parentId, childId)) continue;
    }

    scoped.add(childId);

    const sub = this.gameState.container_contents?.[childId];
    if (Array.isArray(sub)) {
      for (const grandchild of sub) {
        queue.push([grandchild, childId]);
      }
    }
  }

  return scoped;
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

    if (key === 'actor_examine_output') {
      const actorId = match?.actor;
      if (actorId) return this._getActorExamineOutput(actorId);
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

    if (key === 'readable_text') {
      const objectId = match?.object;
      if (objectId && objectId !== '' && objectId !== '__location__') {
        const item = this.definition.items?.[objectId];
        if (item?.readable) {
          return this.getText(item.readable);
        }
      }
      return '';
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
          const sClean = String(s).trim().toLowerCase();
          if (sClean === q || this._stripPossessive(sClean) === q) {
            if (!results.includes(id)) results.push(id);
            break;
          }
        }
      }
    }
  }

  // Fallback: try de-pluralizing the last word (simple English plural heuristic)
  if (results.length === 0 && this.language === 'en') {
    const words = q.split(/\s+/);
    if (words.length > 0) {
      const last = words[words.length - 1];
      // Only strip trailing 's' if the word doesn't end with 'ss', 'sh', 'ch', 'x', or 'z'
      if (last.endsWith('s') && !/ss$|sh$|ch$|[xz]$/.test(last) && last.length >= 4) {
        const depluralized = last.slice(0, -1);
        const altQ = words.slice(0, -1).concat([depluralized]).join(' ');
        return this._findAllItemIdsByNameOrSynonym(altQ);
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

  const numericChoice = q.match(/^\[(\d+)\]$/) || q.match(/^(\d+)$/);
  if (numericChoice) {
    const index = Number.parseInt(numericChoice[1], 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < candidates.length) {
      const candidateId = candidates[index];
      return { itemId: candidateId, phrase: this._resolveAmbiguityChoicePhrase(candidateId) };
    }
  }

  for (const candidateId of candidates) {
    if (this._phraseMatchesItemId(q, candidateId)) {
      return { itemId: candidateId, phrase: this._resolveAmbiguityChoicePhrase(candidateId) };
    }
  }

  // Also try matching against actor names/synonyms
  for (const candidateId of candidates) {
    const actorDef = this.definition.actors?.[candidateId];
    if (!actorDef) continue;
    const actorName = this._pickLang(actorDef.name);
    if (actorName && q === String(actorName).trim().toLowerCase()) {
      return { itemId: candidateId, phrase: this._resolveAmbiguityChoicePhrase(candidateId) };
    }
    const syns = actorDef.synonyms?.[this.language] || [];
    for (const s of syns) {
      if (q === String(s).trim().toLowerCase()) {
        return { itemId: candidateId, phrase: this._resolveAmbiguityChoicePhrase(candidateId) };
      }
    }
  }

  // Resolve a candidate id to a display phrase (short name, fallback full name)
  const _resolvePhrase = (id) =>
    this._getItemDisplayShortName(id)
    || this._getItemDisplayName(id)
    || id.replace(/_/g, ' ');

  // Handle "mine" — match items owned by the player
  const rawInput = String(input || '').trim().toLowerCase();
  const playerId = this._getPlayerActorId();
  if (rawInput === 'mine') {
    const mineMatches = candidates.filter(id => this._getItemOwner(id) === playerId);
    if (mineMatches.length === 1) {
      return { itemId: mineMatches[0], phrase: _resolvePhrase(mineMatches[0]) };
    }
  }

  // Handle "my {word}" — match player-owned items matching the keyword
  const myMatch = rawInput.match(/^my\s+(.+)$/);
  if (myMatch) {
    const keyword = myMatch[1].trim().toLowerCase();
    const myMatches = candidates.filter(id => {
      if (this._getItemOwner(id) !== playerId) return false;
      const item = this.definition.items?.[id];
      if (!item) return false;
      const name = this._pickLang(item.name) || '';
      const sn = this._pickLang(item.short_name) || '';
      const syns = item.synonyms?.[this.language] || [];
      const allTerms = [name.toLowerCase(), sn.toLowerCase(), ...syns.map(s => s.toLowerCase()), id.replace(/_/g, ' ')];
      return allTerms.some(t => t.includes(keyword));
    });
    if (myMatches.length === 1) {
      return { itemId: myMatches[0], phrase: _resolvePhrase(myMatches[0]) };
    }
  }

  // Handle "hers"/"her's"/"her" — match items owned by a female actor
  if (rawInput === 'hers' || rawInput === "her's" || rawInput === 'her') {
    const herCandidates = candidates.filter(id => {
      const ownerId = this._getItemOwner(id);
      if (!ownerId) return false;
      const ownerDef = this.definition.actors?.[ownerId];
      return ownerDef?.properties?.gender === 'female';
    });
    if (herCandidates.length === 1) {
      return { itemId: herCandidates[0], phrase: _resolvePhrase(herCandidates[0]) };
    }
  }

  const words = q.split(/\s+/);
  if (words.length === 1) {
    const singleWord = this._stripPossessive(words[0]);
    const scored = [];
    for (const candidateId of candidates) {
      // Check items
      const item = this.definition.items?.[candidateId];
      if (item) {
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
      // Check actors
      const actor = this.definition.actors?.[candidateId];
      if (actor) {
        const name = this._pickLang(actor.name) || '';
        const syns = actor.synonyms?.[this.language] || [];
        const allTerms = [
          candidateId.replace(/_/g, ' '),
          name.toLowerCase(),
          ...syns.map(s => s.toLowerCase())
        ];
        for (const term of allTerms) {
          if (term.split(/\s+/).includes(singleWord)) {
            if (!scored.includes(candidateId)) scored.push(candidateId);
            break;
          }
        }
      }
    }
    if (scored.length === 1) {
      return { itemId: scored[0], phrase: _resolvePhrase(scored[0]) };
    }
  }

  return null;
};

GameEngine.prototype._resolveAmbiguityChoicePhrase = function(itemId) {
  return this._getItemDisplayShortName(itemId)
    || this._getItemDisplayName(itemId)
    || this._pickLang(this.definition.actors?.[itemId]?.name)
    || String(itemId || '').replace(/_/g, ' ');
};

GameEngine.prototype._buildDisambiguationMessage = function(candidates, phrase, isStrangerAmbiguity) {
  const labels = candidates.map((id, index) => {
    if (isStrangerAmbiguity && this.definition.actors?.[id]) {
      return `[${index + 1}] ${this._getAppearanceDescription(id)}`;
    }

    const item = this.definition.items?.[id];
    const actor = this.definition.actors?.[id];

    // Build natural label for items with ownership
    if (item) {
      const shortName = this._pickLang(item.short_name) || '';
      const ownerId = this._getItemOwner(id);
      const playerId = this._getPlayerActorId();
      const baseName = shortName.toLowerCase() ||
        (this._pickLang(item.name) || id.replace(/_/g, ' '))
          .replace(/\{owner\}\s*'?s?\s*/i, '')
          .trim()
          .toLowerCase();

      if (ownerId) {
        if (ownerId === playerId) {
          return `[${index + 1}] your ${baseName}`;
        }
        const ownerDef = this.definition.actors?.[ownerId];
        const ownerName = ownerDef ? (this._pickLang(ownerDef.name) || ownerId) : ownerId;
        const possessive = this._getPossessiveForm(ownerName);
        return `[${index + 1}] ${possessive} ${baseName}`;
      }

      // No owner: prefer short name, then resolved name, then id
      return `[${index + 1}] ${shortName || this._getItemResolvedName(id) || id.replace(/_/g, ' ')}`;
    }

    // For actors: use proper name (capitalized)
    if (actor) {
      return `[${index + 1}] ${this._pickLang(actor.name) || id.replace(/_/g, ' ')}`;
    }

    return `[${index + 1}] ${id.replace(/_/g, ' ')}`;
  });

  // Capitalize first letter of first label (starts second sentence after "?")
  const capitalized = labels.map((l, i) => i === 0 ? l.charAt(0).toUpperCase() + l.slice(1) : l);
  if (this.language === 'pt-br') {
    return `Qual ${phrase}? ${capitalized.join(' ou ')}?`;
  }
  return `Which ${phrase}? ${capitalized.join(' or ')}?`;
};

/**
 * Resolve a pending slot prompt by matching user input against the slot type.
 * @param {string} slotName
 * @param {*} slotDef
 * @param {string} input
 * @returns {{ value: string, label: string }|null}
 */
GameEngine.prototype._resolveSlotPrompt = function(slotName, slotDef, input, actionDef, match) {
  const cmd = String(input || '').trim().toLowerCase();
  if (!cmd) return null;
  const tokens = cmd.split(/\s+/).filter(Boolean);

  if (slotName === 'object' || slotName === 'target') {
    const itemMatch = this._matchItemSlotAt(tokens, 0, slotDef || '*');
    if (itemMatch) {
      if (itemMatch.ambiguous) {
        return {
          ambiguous: true,
          candidates: itemMatch.candidates,
          phrase: itemMatch.phrase,
          slotName,
          actionDef,
          match,
          slotDef
        };
      }
      const label = this._getItemDisplayShortName(itemMatch.itemId)
        || this._getItemDisplayName(itemMatch.itemId)
        || itemMatch.phrase;
      return { value: itemMatch.itemId, label, phrase: itemMatch.phrase };
    }
    // No item matched — if the input looks like an actor name, signal the
    // caller to skip this action and fall through to legacy handling.
    const stopwords = this._getParserStopwords();
    const nonStopTokens = tokens.filter(t => !stopwords.has(t));
    if (nonStopTokens.length > 0) {
      const rawVal = nonStopTokens.join(' ');
      if (this._matchActorSlotAt(nonStopTokens, 0, ['*'])) {
        match._actorAsObject = true;
      }
      return { value: rawVal, label: rawVal, phrase: cmd };
    }
  }

  if (slotName === 'actor') {
    const actorMatch = this._matchActorSlotAt(tokens, 0, slotDef === '*' ? '*' : slotDef);
    if (actorMatch) {
      // Stranger blocked — don't reveal the actor's name; let failure handler
      // show "You don't know anyone by that name."
      if (actorMatch._strangerBlocked) {
        match._strangerBlocked = true;
        return null;
      }
      if (actorMatch.ambiguous) {
        return {
          ambiguous: true,
          candidates: actorMatch.candidates,
          phrase: actorMatch.phrase,
          slotName,
          actionDef,
          match,
          slotDef
        };
      }
      const actorDef = this.definition.actors?.[actorMatch.actorId];
      const label = this._pickLang(actorDef?.name) || actorMatch.actorId;
      return { value: actorMatch.actorId, label, phrase: actorMatch.phrase };
    }
  }

  if (slotName === 'location') {
    const locationIds = Array.isArray(slotDef) ? slotDef : [];
    const locMatch = this._matchLocationSlotAt(tokens, 0, locationIds);
    if (locMatch) {
      const locDef = this.definition.locations?.[locMatch.locationId];
      const label = this._pickLang(locDef?.name) || locMatch.locationId;
      return { value: locMatch.locationId, label };
    }
  }

  return null;
};

/**
 * Resolve a binary (yes/no) answer from user input using verbs.binary.
 * @param {string} input
 * @returns {'yes'|'no'|null}
 */
GameEngine.prototype._resolveBinaryAnswer = function(input) {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return null;
  const binary = this.definition.verbs?.binary?.[this.language];
  if (binary) {
    if (Array.isArray(binary.yes) && binary.yes.includes(q)) return 'yes';
    if (Array.isArray(binary.no) && binary.no.includes(q)) return 'no';
  }
  // English fallback
  if (['yes', 'y', 'yeah', 'yep', 'sure', 'ok', 'okay'].includes(q)) return 'yes';
  if (['no', 'n', 'nope', 'nah', 'not really'].includes(q)) return 'no';
  return null;
};

/**
 * Extract a slot definition from an action's pattern by slot name.
 * @param {object} actionDef
 * @param {string} slotName
 * @returns {*}
 */
GameEngine.prototype._getSlotDef = function(actionDef, slotName) {
  if (actionDef?.patterns) {
    for (const pat of Object.values(actionDef.patterns)) {
      if (Array.isArray(pat)) {
        for (const entry of pat) {
          if (entry && typeof entry === 'object') {
            const entries = Object.entries(entry).filter(([k]) => k !== 'optional' && k !== 'match_mode');
            if (entries.length === 1 && entries[0][0] === slotName) {
              return entries[0][1];
            }
          }
        }
      }
    }
  }
  if (Array.isArray(actionDef?.pattern)) {
    for (const entry of actionDef.pattern) {
      if (entry && typeof entry === 'object') {
        const entries = Object.entries(entry).filter(([k]) => k !== 'optional' && k !== 'match_mode');
        if (entries.length === 1 && entries[0][0] === slotName) {
          return entries[0][1];
        }
      }
    }
  }
  return '*';
};
