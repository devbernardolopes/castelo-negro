// ---------------------------
// Adventure loading & file I/O
// ---------------------------

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

// -------------------------------------------------------
// Data file loading & merging (supports data_path in metadata)
// -------------------------------------------------------

function mergeDataFiles(main, dataParsedList) {
  for (const dataParsed of dataParsedList) {
    if (!dataParsed || typeof dataParsed !== 'object') continue;
    for (const [key, value] of Object.entries(dataParsed)) {
      if (!(key in main)) {
        main[key] = value;
      }
    }
  }
}

async function loadDataFilesFromDir(dirHandle, dataPath) {
  const parts = splitPath(dataPath);
  let cur = dirHandle;
  for (const part of parts) {
    cur = await cur.getDirectoryHandle(part, { create: false });
  }
  const results = [];
  for await (const entry of cur.values()) {
    if (entry.kind === 'file' && entry.name.endsWith('.yaml')) {
      const file = await entry.getFile();
      const text = await file.text();
      results.push(parseYaml(text));
    }
  }
  return results;
}

async function loadDataFilesFromUrl(baseUrl, dataPath, dataFiles) {
  if (!dataFiles || !dataFiles.length) return [];
  const results = [];
  for (const fileName of dataFiles) {
    const url = new URL(joinPath(dataPath, fileName), baseUrl).toString();
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[storage] Failed to load data file: ${url}`);
      continue;
    }
    const text = await res.text();
    results.push(parseYaml(text));
  }
  return results;
}

// -------------------------------------------------------

async function loadAdventureFromFile(file, handleForRemember, dirHandleForAssets) {
  clearPromptHistory();
  const yamlText = await file.text();
  const parsed = parseYaml(yamlText);

  const dataPath = parsed?.metadata?.data_path;
  if (dataPath && dirHandleForAssets) {
    try {
      const dataParsedList = await loadDataFilesFromDir(dirHandleForAssets, dataPath);
      mergeDataFiles(parsed, dataParsedList);
    } catch (err) {
      console.warn('[storage] Failed to load data files:', err);
    }
  }

  const assetsPath = String(parsed?.metadata?.assets_path || 'assets/');
  const assetsResolver = dirHandleForAssets ? makeAssetsResolver(dirHandleForAssets, assetsPath) : null;
  // When not using a directory handle (no FS Access API), fall back to serving from site root.
  const assetsBase = assetsResolver ? '' : assetsPath;

  engine = new GameEngine(parsed, {
    assetsBase,
    assetsResolver,
    onOutput: appendOutput,
    onLocationNameRender: appendLocationName,
    onRoomImageRender: renderRoomImage,
    onInventoryRender: renderInventoryList,
    onMindRender: renderMindPanel,
    onMemoryRender: renderMemoryList,
    onDebugRender: renderDebugPanel,
    onMapRender: renderMap,
    onRelationshipsRender: renderRelationshipsList,
    onStatsRender: renderStatsList
  });
  setAdventureTitle(parsed?.metadata?.title || file.name);
  setMenuButtonsEnabled(true);
  setGameControlsEnabled(true);
  setSidebarTabsEnabled(true);
  setDebugTabVisibility(!!parsed?.metadata?.debug);
  setMapTabVisibility(true);
  document.getElementById('tab-inventory').style.display = '';
  document.getElementById('tab-memory').style.display = '';
  setDirectInputMode(!!parsed?.metadata?.allow_direct_input);
  _focusOnGameTab();
  resetUiForNewGame();
  const textDisplay = document.getElementById('text-display');
  if (textDisplay) textDisplay.innerHTML = '';
  appendGameMetadata(parsed?.metadata);
  const intro = engine.getText('intro');
  if (intro) appendOutput(intro);
  window._buildTabsFromMetadata?.();
  engine.renderCurrentLocation();
}

async function loadAdventureFromUrl(yamlUrl) {
  clearPromptHistory();
  const absoluteYamlUrl = new URL(String(yamlUrl || ''), window.location.href).toString();
  const res = await fetch(absoluteYamlUrl);
  if (!res.ok) throw new Error(`Failed to load adventure YAML: ${yamlUrl}`);
  const yamlText = await res.text();
  const parsed = parseYaml(yamlText);

  const yamlBaseUrl = new URL('./', absoluteYamlUrl).toString();
  const dataPath = parsed?.metadata?.data_path;
  const dataFiles = parsed?.metadata?.data_files;
  if (dataPath && dataFiles) {
    try {
      const dataParsedList = await loadDataFilesFromUrl(yamlBaseUrl, dataPath, dataFiles);
      mergeDataFiles(parsed, dataParsedList);
    } catch (err) {
      console.warn('[storage] Failed to load data files from URL:', err);
    }
  }

  const assetsBaseUrl = new URL(String(parsed?.metadata?.assets_path || 'assets/'), yamlBaseUrl).toString();
  const assetsResolver = async (relativePath) => new URL(String(relativePath || ''), assetsBaseUrl).toString();

  engine = new GameEngine(parsed, {
    assetsBase: '',
    assetsResolver,
    onOutput: appendOutput,
    onLocationNameRender: appendLocationName,
    onRoomImageRender: renderRoomImage,
    onInventoryRender: renderInventoryList,
    onMindRender: renderMindPanel,
    onMemoryRender: renderMemoryList,
    onDebugRender: renderDebugPanel,
    onMapRender: renderMap,
    onRelationshipsRender: renderRelationshipsList,
    onStatsRender: renderStatsList
  });
  setAdventureTitle(parsed?.metadata?.title || yamlUrl);
  setMenuButtonsEnabled(true);
  setGameControlsEnabled(true);
  setSidebarTabsEnabled(true);
  setDebugTabVisibility(!!parsed?.metadata?.debug);
  setMapTabVisibility(true);
  document.getElementById('tab-inventory').style.display = '';
  document.getElementById('tab-memory').style.display = '';
  setDirectInputMode(!!parsed?.metadata?.allow_direct_input);
  _focusOnGameTab();
  resetUiForNewGame();
  const textDisplay = document.getElementById('text-display');
  if (textDisplay) textDisplay.innerHTML = '';
  appendGameMetadata(parsed?.metadata);
  const intro = engine.getText('intro');
  if (intro) appendOutput(intro);
  window._buildTabsFromMetadata?.();
  engine.renderCurrentLocation();
}

async function loadManifest() {
  const res = await fetch('adventures/manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Web adventures unavailable; try Disk mode.');
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Invalid adventures manifest.');
  return data;
}

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

function _focusOnGameTab() {
  const roomTab = document.getElementById('tab-room');
  if (roomTab && window.setSidebarTab) {
    window.setSidebarTab('room');
  } else if (directInputMode && window.setSidebarTab) {
    window.setSidebarTab('inventory');
  } else if (window.setSidebarTab) {
    window.setSidebarTab('memory');
  }
}
