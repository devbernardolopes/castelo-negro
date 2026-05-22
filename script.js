// Text Adventure Engine - Main game script

let currentLocation = null;
let gameData = null;
let adventureSource = null; // { kind: 'url'|'file', label, baseDir, fileName }

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
  const ids = [
    'menu-btn-reset-game',
    'menu-btn-load-game',
    'menu-btn-save-game',
    'menu-btn-change-language'
  ];
  for (const id of ids) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !isGameLoaded;
  }
}

function setAdventureTitle(title) {
  setText('adventure-title-row', title || '');
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load: ${url}`);
  return await response.text();
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'null' || v === 'Null' || v === 'NULL' || v === '~') return null;
  if (v === 'true' || v === 'True' || v === 'TRUE') return true;
  if (v === 'false' || v === 'False' || v === 'FALSE') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => parseScalar(s.trim()));
  }
  return v;
}

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

// Minimal YAML subset parser: mappings + sequences by indentation.
// Supports scalars, inline arrays, nested objects/arrays, and "- key: value" objects.
function parseYaml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const root = {};
  const stack = [{ indent: -1, container: root, type: 'object' }];

  function currentFrame() {
    return stack[stack.length - 1];
  }

  function ensureContainer(parent, key, type) {
    if (type === 'array') {
      if (!Array.isArray(parent[key])) parent[key] = [];
      return parent[key];
    }
    if (typeof parent[key] !== 'object' || parent[key] === null || Array.isArray(parent[key])) parent[key] = {};
    return parent[key];
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = stripComments(lines[i]);
    if (!rawLine.trim()) continue;

    const indent = countIndent(rawLine);
    const line = rawLine.trim();

    while (stack.length > 1 && currentFrame().indent >= indent) stack.pop();
    const frame = currentFrame();

    const isSeqItem = line.startsWith('- ');
    if (isSeqItem) {
      if (frame.type !== 'array') {
        // If we encounter a sequence item but current container isn't an array,
        // coerce only when the container is a property placeholder created earlier.
        // This parser expects YAML authors to use sequences under keys.
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
        obj[kv[1].trim()] = kv[2] === '' ? {} : parseScalar(kv[2]);
        frame.container.push(obj);
        if (kv[2] === '') {
          stack.push({ indent, container: obj[kv[1].trim()], type: 'object' });
        }
      } else {
        frame.container.push(parseScalar(itemText));
      }
      continue;
    }

    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const rest = match[2];

    if (frame.type !== 'object') {
      throw new Error(`YAML parse error near line ${i + 1}: mapping inside sequence not supported here`);
    }

    if (rest === '') {
      // Decide if this should be an array or object by peeking next non-empty line.
      let j = i + 1;
      let nextNonEmpty = null;
      while (j < lines.length) {
        const peek = stripComments(lines[j]);
        if (peek.trim()) {
          nextNonEmpty = peek;
          break;
        }
        j++;
      }

      const nextIsArray = nextNonEmpty && nextNonEmpty.trim().startsWith('- ') && countIndent(nextNonEmpty) > indent;
      frame.container[key] = nextIsArray ? [] : {};
      stack.push({ indent, container: frame.container[key], type: nextIsArray ? 'array' : 'object' });
    } else {
      frame.container[key] = parseScalar(rest);
    }
  }

  return root;
}

// Display image for location
function displayLocationImage(locationKey) {
  const location = gameData?.locations?.[locationKey];
  if (!location) return;

  const images = location.images || [];
  const imgEl = document.getElementById('room-img');

  if (images.length > 0) {
    const imgPath = resolveAssetUrl(images[0]);
    imgEl.src = imgPath;
    imgEl.onload = () => {
      imgEl.style.display = 'block';
    };
    imgEl.onerror = () => {
      imgEl.style.display = 'none';
    };
  } else {
    imgEl.style.display = 'none';
    imgEl.src = '';
  }
}

// Display location description
function displayLocationDescription(locationKey) {
  const location = gameData?.locations?.[locationKey];
  if (!location) return;

  const desc = location.description?.base || '';
  const textDisplay = document.getElementById('text-display');
  textDisplay.textContent = desc;
}

// Load location
function loadLocation(locationKey) {
  currentLocation = locationKey;
  displayLocationImage(locationKey);
  displayLocationDescription(locationKey);
}

// Movement direction mapping
const DIRECTION_MAP = {
  'up': 'north',
  'down': 'south',
  'left': 'west',
  'right': 'east'
};

// Movement handler
function moveDirection(direction) {
  if (!gameData || !currentLocation) return;
  const mappedDir = DIRECTION_MAP[direction];
  const location = gameData.locations?.[currentLocation];
  const exit = location?.exits?.[mappedDir];
  if (exit) {
    loadLocation(exit);
  } else {
    console.log(`Can't go ${direction} from ${currentLocation}`);
  }
}

function resolveAssetUrl(relOrUrl) {
  const raw = String(relOrUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
  const baseDir = adventureSource?.baseDir || '';
  if (!baseDir) return raw;
  if (raw.startsWith('/')) return raw;
  return `${baseDir}${raw}`;
}

function normalizeInventory(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.value)) return value.value;
  return [];
}

function resetUiForNewGame() {
  clearEl('inventory-list');
  setText('text-display', '');
  const imgEl = document.getElementById('room-img');
  if (imgEl) {
    imgEl.style.display = 'none';
    imgEl.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  }
}

function startGameFromData(data) {
  gameData = data;
  currentLocation = null;
  resetUiForNewGame();

  const title = data?.metadata?.title || adventureSource?.label || adventureSource?.fileName || '';
  setAdventureTitle(title);
  setMenuButtonsEnabled(true);

  currentLocation = data?.actors?.protagonist?.starting_location || data?.starting_location || null;
  if (!currentLocation && data?.locations && typeof data.locations === 'object') {
    const keys = Object.keys(data.locations);
    currentLocation = keys.length ? keys[0] : null;
  }
  if (currentLocation) loadLocation(currentLocation);

  const inventory = normalizeInventory(data?.variables?.inventory);
  const inventoryList = document.getElementById('inventory-list');
  for (const itemName of inventory) {
    const li = document.createElement('li');
    li.textContent = String(itemName);
    inventoryList.appendChild(li);
  }

  window.gameData = gameData;
}

function unloadGame() {
  gameData = null;
  currentLocation = null;
  adventureSource = null;
  setAdventureTitle('');
  setMenuButtonsEnabled(false);
  resetUiForNewGame();
  setText('text-display', 'Load an adventure to begin.');
}

async function loadAdventureFromUrl(url) {
  const yamlText = await fetchText(url);
  const parsed = parseYaml(yamlText);
  const baseDir = url.includes('/') ? url.slice(0, url.lastIndexOf('/') + 1) : '';
  adventureSource = { kind: 'url', label: url, baseDir, fileName: url.split('/').pop() };
  startGameFromData(parsed);
}

async function loadAdventureFromFile(file) {
  const yamlText = await file.text();
  const parsed = parseYaml(yamlText);
  adventureSource = { kind: 'file', label: file.name, baseDir: '', fileName: file.name };
  startGameFromData(parsed);
}

// Event handlers
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('direction-btn')) {
    const direction = e.target.getAttribute('data-direction');
    moveDirection(direction);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  setMenuButtonsEnabled(false);
  setAdventureTitle('');
  setText('text-display', 'Load an adventure to begin.');

  // File picker helpers (prefers File System Access API when available).
  const DB_NAME = 'text-adventure-engine';
  const DB_STORE = 'handles';
  const DB_KEY_LAST_ADVENTURE = 'lastAdventureFileHandle';

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

  // Fallback hidden file input (session-level "remembers last folder" behavior is browser-managed).
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.yaml,.yml,text/yaml';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  async function handlePickedFile(file) {
    if (!file) return;
    try {
      await loadAdventureFromFile(file);
    } catch (err) {
      console.error(err);
      unloadGame();
      setText('text-display', 'Failed to load adventure file.');
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    await handlePickedFile(file);
  });

  async function pickAdventureFile() {
    if (typeof window.showOpenFilePicker !== 'function') {
      fileInput.click();
      return;
    }

    let startIn = undefined;
    try {
      const lastHandle = await idbGet(DB_KEY_LAST_ADVENTURE);
      if (lastHandle) {
        try {
          const perm = await lastHandle.queryPermission?.({ mode: 'read' });
          if (perm === 'granted') startIn = lastHandle;
        } catch {
          // ignore
        }
      }
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
    try {
      await idbSet(DB_KEY_LAST_ADVENTURE, handle);
    } catch {
      // ignore
    }

    const file = await handle.getFile();
    await handlePickedFile(file);
  }

  document.getElementById('menu-btn-load-adventure')?.addEventListener('click', async () => {
    try {
      await pickAdventureFile();
    } catch (err) {
      // User cancelled is fine; anything else should show error.
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
      console.error(err);
      unloadGame();
      setText('text-display', 'Failed to load adventure file.');
    }
  });

  document.getElementById('menu-btn-reset-game')?.addEventListener('click', () => {
    if (!gameData) return;
    startGameFromData(gameData);
  });
});
