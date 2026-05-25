let engine = null;
let fileInput;

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
  fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.yaml,.yml,text/yaml';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

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
        if (diskHint) diskHint.textContent = "Disk mode can\u2019t load images in this browser; use Web mode or a Chromium-based browser.";
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
      if (diskHint) diskHint.textContent = "Disk mode can\u2019t load images in this browser; use Web mode or a Chromium-based browser.";
    } else if (diskHint) {
      diskHint.textContent = '';
    }
  });

  document.getElementById('menu-btn-reset-game')?.addEventListener('click', () => {
    if (!engine) return;
    const def = engine.definition;
    engine = new GameEngine(def, {
      assetsBase: engine.assetsBase,
      onOutput: appendOutput,
      onRoomImageRender: renderRoomImage,
      onInventoryRender: renderInventoryList,
      onMindRender: renderMindPanel,
      onMemoryRender: renderMemoryList
    });
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
