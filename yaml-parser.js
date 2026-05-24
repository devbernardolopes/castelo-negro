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
  if (def.verbs && typeof def.verbs !== 'object') console.warn('[engine] `verbs` should be an object map.');
  if (def.actions && typeof def.actions !== 'object') console.warn('[engine] `actions` should be an object map.');
}
