let engine = null;
let fileInput;

const DIRECTION_MAP = { up: 'north', down: 'south', left: 'west', right: 'east' };
const LS_KEY_THEME = 'adventure_theme';

const THEMES = [
  { id: 'default', name: { en: 'Dark', 'pt-br': 'Escuro' }, colors: ['#000000', '#1a1a1a', '#341db6', '#e0e0e0'] },
  { id: 'light', name: { en: 'Light', 'pt-br': 'Claro' }, colors: ['#ffffff', '#f0f0f0', '#2563eb', '#1a1a1a'] },
  { id: 'terminal', name: { en: 'Terminal', 'pt-br': 'Terminal' }, colors: ['#0c0c0c', '#111111', '#00ff41', '#00ff41'] },
  { id: 'sepia', name: { en: 'Sepia', 'pt-br': 'Sépia' }, colors: ['#f4ecd8', '#e8dcc8', '#8b4513', '#3b2f1e'] }
];

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('direction-btn')) {
    if (!engine || _isPausedForSend) return;
    const direction = e.target.getAttribute('data-direction');
    const mapped = DIRECTION_MAP[direction];
    if (!mapped) return;
    const prompt = `go ${mapped}`;
    savePromptToHistory(prompt);
    appendPlayerPrompt(prompt);
    engine.processPlayerCommand(prompt);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  setMenuButtonsEnabled(false);
  setGameControlsEnabled(false);
  setSidebarTabsEnabled(false);
  setAdventureTitle('');
  resetUiForNewGame();
  setText('text-display', 'Load an adventure to begin.');
  updateScrollBtnVisibility();

  // Apply saved theme
  const savedTheme = localStorage.getItem(LS_KEY_THEME) || 'default';
  document.body.setAttribute('data-theme', savedTheme);

  // Sidebar tabs wiring (Mind / Inventory / Memory / Debug / etc).
  function setSidebarTab(tabName) {
    const panels = {
      system: document.getElementById('tab-panel-system'),
      mind: document.getElementById('tab-panel-mind'),
      inventory: document.getElementById('tab-panel-inventory'),
      memory: document.getElementById('tab-panel-memory'),
      debug: document.getElementById('tab-panel-debug')
    };
    const buttons = {
      system: document.getElementById('tab-system'),
      mind: document.getElementById('tab-mind'),
      inventory: document.getElementById('tab-inventory'),
      memory: document.getElementById('tab-memory'),
      debug: document.getElementById('tab-debug')
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
  setSidebarTab('system');

  renderCommandBuilder();

  document.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
    if (!target) return;

    // Close prompt history panel on outside click
    const panel = document.getElementById('prompt-history-panel');
    if (panel && panel.style.display !== 'none' && !panel.contains(target)) {
      hidePromptHistoryPanel();
    }

    if (target.classList.contains('click-word')) {
      if (_isPausedForSend) return;
      if (Date.now() < suppressPromptAddUntilTs) return;
      scheduleAddWordToCommand(target.getAttribute('data-word') || target.textContent || '');
      return;
    }

    if (target.classList.contains('word-token-remove')) {
      if (_isPausedForSend) return;
      const token = target.closest('.word-token');
      const index = Number(token?.getAttribute('data-index'));
      if (Number.isFinite(index) && index >= 0) {
        selectedWords.splice(index, 1);
        renderCommandBuilder();
      }
    }

    const memAction = target.getAttribute('data-action');
    if (memAction === 'mem-remove' || memAction === 'mem-up' || memAction === 'mem-down') {
      if (!engine || _isPausedForSend) return;
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
      if (!engine || _isPausedForSend) return;
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
    if (_isPausedForSend) return;
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

    // Double-click empty space in #user-input -> show prompt history
    if (target.closest('#user-input') && !target.closest('.word-token')) {
      ev.preventDefault();
      showPromptHistoryPanel();
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
    if (_isPausedForSend) return;
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
    if (_isPausedForSend) return;
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
    if (_isPausedForSend) return;
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

  function buildPromptFromInput() {
    const directInput = document.getElementById('direct-text-input');
    const typed = directInputMode && directInput ? directInput.value.trim() : '';
    const words = selectedWords.join(' ').trim();
    if (typed && words) return typed + ' ' + words;
    return typed || words;
  }

  function submitPrompt() {
    if (!engine && !_isPausedForSend) return;
    if (_isPausedForSend) {
      resumeFromPause();
      return;
    }
    const prompt = buildPromptFromInput();
    if (!prompt) return;
    savePromptToHistory(prompt);
    appendPlayerPrompt(prompt);
    selectedWords = [];
    renderCommandBuilder();
    const directInput = document.getElementById('direct-text-input');
    if (directInput) directInput.value = '';
    syncSendButtonEnabled();
    engine.processPlayerCommand(prompt);
  }

  const sendBtn = document.getElementById('input-btn-send');
  sendBtn?.addEventListener('click', submitPrompt);

  const directTextInput = document.getElementById('direct-text-input');
  directTextInput?.addEventListener('keydown', (ev) => {
    if (!engine && !_isPausedForSend) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submitPrompt();
      return;
    }
    if (directInputMode && ev.key === 'Backspace' && directTextInput.value === '') {
      ev.preventDefault();
      if (selectedWords.length > 0) {
        selectedWords.pop();
        renderCommandBuilder();
      }
      return;
    }
    if (directInputMode && ev.key === 'Delete' && directTextInput.value === '') {
      ev.preventDefault();
      if (selectedWords.length > 0) {
        selectedWords.shift();
        renderCommandBuilder();
      }
      return;
    }
  });

  directTextInput?.addEventListener('input', syncSendButtonEnabled);

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
      updateScrollBtnVisibility();
    }
  });

  // Scroll-to-bottom button
  function updateScrollBtnVisibility() {
    const el = document.getElementById('text-display');
    const btn = document.getElementById('scroll-down-btn');
    if (!el || !btn) return;
    const threshold = 30;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    btn.classList.toggle('is-visible', !isNearBottom);
  }

  const textDisplay = document.getElementById('text-display');
  textDisplay?.addEventListener('scroll', updateScrollBtnVisibility);

  document.getElementById('scroll-down-btn')?.addEventListener('click', () => {
    const el = document.getElementById('text-display');
    if (el) el.scrollTop = el.scrollHeight;
  });

  // Initial check
  updateScrollBtnVisibility();

  // Modal UI wiring
  const closeBtn = document.getElementById('adventure-modal-close');
  closeBtn?.addEventListener('click', () => setModalVisible(false));
  document.getElementById('adventure-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target?.id === 'adventure-modal-backdrop') setModalVisible(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setModalVisible(false); setThemeModalVisible(false); }
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

  // Theme modal wiring
  function setThemeModalVisible(visible) {
    const el = document.getElementById('theme-modal-backdrop');
    if (el) el.style.display = visible ? 'flex' : 'none';
  }

  function renderThemeGrid() {
    const grid = document.getElementById('theme-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const currentTheme = document.body.getAttribute('data-theme') || 'default';
    for (const t of THEMES) {
      const card = document.createElement('button');
      card.className = 'theme-card' + (t.id === currentTheme ? ' is-active' : '');
      card.setAttribute('data-theme-id', t.id);

      const preview = document.createElement('div');
      preview.className = 'theme-preview';
      for (const c of t.colors) {
        const swatch = document.createElement('span');
        swatch.className = 'theme-swatch';
        swatch.style.background = c;
        preview.appendChild(swatch);
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'theme-name';
      nameEl.textContent = t.name.en;

      card.appendChild(preview);
      card.appendChild(nameEl);

      card.addEventListener('click', () => {
        document.body.setAttribute('data-theme', t.id);
        localStorage.setItem(LS_KEY_THEME, t.id);
        document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('is-active'));
        card.classList.add('is-active');
      });

      grid.appendChild(card);
    }
  }

  document.getElementById('menu-btn-theme')?.addEventListener('click', () => {
    renderThemeGrid();
    setThemeModalVisible(true);
  });

  document.getElementById('theme-modal-close')?.addEventListener('click', () => setThemeModalVisible(false));
  document.getElementById('theme-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target?.id === 'theme-modal-backdrop') setThemeModalVisible(false);
  });

  document.getElementById('menu-btn-reset-game')?.addEventListener('click', () => {
    if (!engine) return;
    clearPromptHistory();
    const def = engine.definition;
    engine = new GameEngine(def, {
      assetsBase: engine.assetsBase,
      assetsResolver: engine.assetsResolver,
      onOutput: appendOutput,
      onLocationNameRender: appendLocationName,
      onRoomImageRender: renderRoomImage,
      onInventoryRender: renderInventoryList,
      onMindRender: renderMindPanel,
      onMemoryRender: renderMemoryList,
      onDebugRender: renderDebugPanel
    });
    resetUiForNewGame();
    const textDisplay = document.getElementById('text-display');
    if (textDisplay) textDisplay.innerHTML = '';
    updateScrollBtnVisibility();
    const intro = engine.getText('intro');
    if (intro) appendOutput(intro);
    setDebugTabVisibility(!!engine?.definition?.metadata?.debug);
    engine.renderCurrentLocation();
    setMenuButtonsEnabled(true);
    setGameControlsEnabled(true);
    setSidebarTabsEnabled(true);
    setDirectInputMode(!!engine?.definition?.metadata?.allow_direct_input);
  });
});
