let engine = null;
let fileInput;
let _isMobileLayout = false;

const DIRECTION_MAP = { n: 'north', s: 'south', w: 'west', e: 'east', nw: 'northwest', ne: 'northeast', sw: 'southwest', se: 'southeast' };
const LS_KEY_THEME = 'adventure_theme';
const LS_KEY_FONT_FAMILY = 'adventure_font_family';
const LS_KEY_FONT_SIZE = 'adventure_font_size';

const THEMES = [
  { id: 'default', name: { en: 'Dark', 'pt-br': 'Escuro' }, colors: ['#000000', '#1a1a1a', '#341db6', '#e0e0e0'] },
  { id: 'light', name: { en: 'Light', 'pt-br': 'Claro' }, colors: ['#ffffff', '#f0f0f0', '#2563eb', '#1a1a1a'] },
  { id: 'terminal', name: { en: 'Terminal', 'pt-br': 'Terminal' }, colors: ['#0c0c0c', '#111111', '#00ff41', '#00ff41'] },
  { id: 'sepia', name: { en: 'Sepia', 'pt-br': 'Sépia' }, colors: ['#f4ecd8', '#e8dcc8', '#8b4513', '#3b2f1e'] },
  { id: 'high-contrast', name: { en: 'High Contrast', 'pt-br': 'Alto Contraste' }, colors: ['#000000', '#000000', '#ffff00', '#ffffff'] },
  { id: 'black-white', name: { en: 'Black & White', 'pt-br': 'Preto e Branco' }, colors: ['#000000', '#111111', '#ffffff', '#ffffff'] },
  { id: 'pastel', name: { en: 'Pastel', 'pt-br': 'Pastel' }, colors: ['#fef9f0', '#fdf6e3', '#a8d8ea', '#5d4e37'] }
];

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('direction-btn')) {
    if (!engine || _isPausedForSend) return;
    const direction = e.target.getAttribute('data-direction');
    const mapped = DIRECTION_MAP[direction];
    if (!mapped) return;
    const goList = engine._pickLang(engine.definition.verbs?.go?.synonyms);
    const dirList = engine._pickLang(engine.definition.directions?.[mapped]?.synonyms);
    const goWord = Array.isArray(goList) ? String(goList[0]).toLowerCase() : 'go';
    const dirWord = Array.isArray(dirList) ? String(dirList[0]).toLowerCase() : mapped;
    const prompt = `${goWord} ${dirWord}`;
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

  // Apply saved font family & size
  const FONT_SIZE_MAP = ['small', 'regular', 'large', 'larger'];
  const savedFontFamily = localStorage.getItem(LS_KEY_FONT_FAMILY) || "'Courier New', Courier, monospace";
  const savedFontSize = localStorage.getItem(LS_KEY_FONT_SIZE) || '1';
  const textDisplayEl = document.getElementById('text-display');
  if (textDisplayEl) {
    textDisplayEl.style.fontFamily = savedFontFamily;
    textDisplayEl.setAttribute('data-font-size', FONT_SIZE_MAP[parseInt(savedFontSize)] || 'regular');
  }

  _updateMobileLayout();

  // Sidebar tabs wiring.
  function setSidebarTab(tabName) {
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.style.display = panel.id === `tab-panel-${tabName}` ? 'flex' : 'none';
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const name = btn.getAttribute('data-tab');
      const isSelected = name === tabName;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
      if (isSelected) btn.classList.remove('has-update');
    });
  }
  window.setSidebarTab = setSidebarTab;

  function _focusGameTab() {
    const roomTab = document.getElementById('tab-room');
    if (roomTab) {
      setSidebarTab('room');
    } else if (directInputMode) {
      setSidebarTab('inventory');
    } else {
      setSidebarTab('memory');
    }
  }

  function _buildTabsFromMetadata() {
    const tabs = engine?.definition?.metadata?.tabs;
    if (!tabs) return;

    const tabsHeader = document.querySelector('#sidebar-tabs .tabs-header');
    const tabsBody = document.querySelector('#sidebar-tabs .tabs-body');
    if (!tabsHeader || !tabsBody) return;

    const created = [];

    for (const [tabName, tabDef] of Object.entries(tabs)) {
      if (tabName === 'system' || tabName === 'room') continue;

      const visible = tabDef.visible !== false;
      const label = engine._pickLang(tabDef) || tabName;

      let btn = document.getElementById(`tab-${tabName}`);
      let panel = document.getElementById(`tab-panel-${tabName}`);

      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'tab-btn';
        btn.type = 'button';
        btn.role = 'tab';
        btn.setAttribute('aria-selected', 'false');
        btn.setAttribute('aria-controls', `tab-panel-${tabName}`);
        btn.id = `tab-${tabName}`;
        btn.setAttribute('data-tab', tabName);
        btn.textContent = label;
        btn.addEventListener('click', () => {
          setSidebarTab(tabName);
          if (tabName === 'map' && typeof _centerMapOnCurrentLocation === 'function') {
            _centerMapOnCurrentLocation();
          }
        });
        if (!engine) btn.disabled = true;
        tabsHeader.appendChild(btn);
        created.push(tabName);
      } else {
        btn.textContent = label;
      }

      if (!panel) {
        const contentId = `${tabName}-list`;
        panel = document.createElement('div');
        panel.className = 'tab-panel';
        panel.role = 'tabpanel';
        panel.id = `tab-panel-${tabName}`;
        panel.setAttribute('aria-labelledby', `tab-${tabName}`);
        panel.style.display = 'none';
        const inner = document.createElement('div');
        inner.id = contentId;
        panel.appendChild(inner);
        tabsBody.appendChild(panel);
      }

      btn.style.display = visible ? '' : 'none';
      if (!visible && btn.getAttribute('aria-selected') === 'true') {
        const sysBtn = document.getElementById('tab-system');
        if (sysBtn) sysBtn.click();
      }
    }

    // Reorder metadata tab buttons after system
    const sysBtn = document.getElementById('tab-system');
    for (const tabName of Object.keys(tabs)) {
      if (tabName === 'system') continue;
      const btn = document.getElementById(`tab-${tabName}`);
      if (btn && btn.parentNode === tabsHeader) {
        tabsHeader.appendChild(btn);
      }
    }
    if (sysBtn && sysBtn.parentNode === tabsHeader) {
      tabsHeader.insertBefore(sysBtn, tabsHeader.firstChild);
    }

    // Reorder panels to match
    for (const tabName of Object.keys(tabs)) {
      const panel = document.getElementById(`tab-panel-${tabName}`);
      if (panel && panel.parentNode === tabsBody) {
        tabsBody.appendChild(panel);
      }
    }
  }
  window._buildTabsFromMetadata = _buildTabsFromMetadata;

  document.querySelectorAll('#sidebar-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      setSidebarTab(tab);
      if (tab === 'map' && typeof _centerMapOnCurrentLocation === 'function') {
        _centerMapOnCurrentLocation();
      }
    });
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
      if (directInputMode) return;
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

    // Double-click direct-text-input -> show prompt history
    if (target.id === 'direct-text-input' || target.closest('#direct-text-input')) {
      ev.preventDefault();
      showPromptHistoryPanel();
      return;
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
    _historyIndex = null;
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

    if (directInputMode && promptHistory.length > 0) {
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (_historyIndex === null) {
          _historyIndex = promptHistory.length - 1;
        } else if (_historyIndex > 0) {
          _historyIndex--;
        }
        directTextInput.value = promptHistory[_historyIndex];
        syncSendButtonEnabled();
        return;
      }
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (_historyIndex === null) return;
        if (_historyIndex >= promptHistory.length - 1) {
          _historyIndex = null;
          directTextInput.value = '';
        } else {
          _historyIndex++;
          directTextInput.value = promptHistory[_historyIndex];
        }
        syncSendButtonEnabled();
        return;
      }
    }

    _historyIndex = null;

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
    if (e.key === 'Escape') { setModalVisible(false); setThemeModalVisible(false); setLanguageModalVisible(false); setImageModalVisible(false); const cb = document.getElementById('lang-confirm-backdrop'); if (cb) cb.style.display = 'none'; }
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

  // Font controls wiring
  const fontFamilySelect = document.getElementById('font-family-select');
  const fontSizeSlider = document.getElementById('font-size-slider');

  if (fontFamilySelect) {
    fontFamilySelect.value = savedFontFamily;
    fontFamilySelect.addEventListener('change', () => {
      const val = fontFamilySelect.value;
      const td = document.getElementById('text-display');
      if (td) td.style.fontFamily = val;
      localStorage.setItem(LS_KEY_FONT_FAMILY, val);
    });
  }

  if (fontSizeSlider) {
    fontSizeSlider.value = savedFontSize;
    fontSizeSlider.addEventListener('input', () => {
      const val = parseInt(fontSizeSlider.value);
      const label = FONT_SIZE_MAP[val] || 'regular';
      const td = document.getElementById('text-display');
      if (td) td.setAttribute('data-font-size', label);
      localStorage.setItem(LS_KEY_FONT_SIZE, String(val));
    });
  }

  const LANG_NAMES = {
    en: 'English',
    'pt-br': 'Português (Brasil)',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    ja: '日本語',
    'zh-cn': '简体中文',
    'zh-tw': '繁體中文'
  };

  function setLanguageModalVisible(visible) {
    const el = document.getElementById('language-modal-backdrop');
    if (el) el.style.display = visible ? 'flex' : 'none';
  }

  function renderLanguageGrid() {
    const grid = document.getElementById('language-grid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!engine) return;
    const languages = engine.definition.metadata.languages;
    if (!Array.isArray(languages)) return;
    const currentLang = engine.language;
    for (const lang of languages) {
      const card = document.createElement('button');
      card.className = 'theme-card' + (lang === currentLang ? ' is-active' : '');
      card.setAttribute('data-lang', lang);
      const nameEl = document.createElement('div');
      nameEl.className = 'theme-name';
      nameEl.textContent = LANG_NAMES[lang] || lang;
      card.appendChild(nameEl);
      card.addEventListener('click', () => {
        if (lang === currentLang) { setLanguageModalVisible(false); return; }
        const cb = document.getElementById('lang-confirm-backdrop');
        if (cb) {
          cb.style.display = 'flex';
          cb.setAttribute('data-selected-lang', lang);
        }
      });
      grid.appendChild(card);
    }
  }

  document.getElementById('language-modal-close')?.addEventListener('click', () => setLanguageModalVisible(false));
  document.getElementById('language-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target?.id === 'language-modal-backdrop') setLanguageModalVisible(false);
  });

  // Image modal
  function setImageModalVisible(visible) {
    const el = document.getElementById('img-modal-backdrop');
    if (el) el.style.display = visible ? 'flex' : 'none';
  }

  function showImageModal(src, title) {
    if (!src) return;
    const backdrop = document.getElementById('img-modal-backdrop');
    const img = document.getElementById('img-modal-view');
    const titleEl = document.getElementById('img-modal-title');
    if (!backdrop || !img) return;

    if (title && titleEl) titleEl.textContent = title;

    img.style.transform = 'scale(1)';
    img.src = src;

    const body = document.querySelector('.img-modal-body');
    if (body) { body.scrollTop = 0; body.scrollLeft = 0; }

    setImageModalVisible(true);
  }
  window.showImageModal = showImageModal;

  document.getElementById('img-modal-close')?.addEventListener('click', () => setImageModalVisible(false));
  document.getElementById('img-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target?.id === 'img-modal-backdrop') setImageModalVisible(false);
  });

  document.getElementById('room-img')?.addEventListener('click', function () {
    if (this.style.display === 'none' || !this.src) return;
    showImageModal(this.src, 'Room Image');
  });

  document.getElementById('inventory-list')?.addEventListener('click', (e) => {
    const img = e.target.closest('.inventory-item-img');
    if (img && img.src) {
      const li = img.closest('li');
      const nameSpan = li?.querySelector('span');
      const title = nameSpan?.textContent || '';
      showImageModal(img.src, title);
    }
  });

  {
    const imgView = document.getElementById('img-modal-view');
    let _imgLastTap = 0;
    if (imgView) {
      imgView.addEventListener('wheel', (e) => {
        e.preventDefault();
        let scale = parseFloat(imgView.dataset.scale) || 1;
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        scale = Math.max(0.25, Math.min(5, scale + delta));
        imgView.dataset.scale = String(scale);
        imgView.style.transform = 'scale(' + scale + ')';
      }, { passive: false });

      imgView.addEventListener('click', function () {
        const now = Date.now();
        if (now - _imgLastTap < 300) {
          _imgLastTap = 0;
          this.dataset.scale = '1';
          this.style.transform = 'scale(1)';
        } else {
          _imgLastTap = now;
        }
      });
    }
  }

  document.getElementById('lang-confirm-cancel')?.addEventListener('click', () => {
    const cb = document.getElementById('lang-confirm-backdrop');
    if (cb) cb.style.display = 'none';
  });
  document.getElementById('lang-confirm-backdrop')?.addEventListener('click', (e) => {
    if (e.target?.id === 'lang-confirm-backdrop') {
      const cb = document.getElementById('lang-confirm-backdrop');
      if (cb) cb.style.display = 'none';
    }
  });
  document.getElementById('lang-confirm-ok')?.addEventListener('click', () => {
    const cb = document.getElementById('lang-confirm-backdrop');
    const newLang = cb ? cb.getAttribute('data-selected-lang') : null;
    if (cb) cb.style.display = 'none';
    setLanguageModalVisible(false);
    if (!engine || !newLang) return;
    clearPromptHistory();
    const def = engine.definition;
    engine = new GameEngine(def, {
      assetsBase: engine.assetsBase,
      assetsResolver: engine.assetsResolver,
      language: newLang,
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
    resetUiForNewGame();
    setDebugTabVisibility(!!engine?.definition?.metadata?.debug);
    setMapTabVisibility(true);
    document.getElementById('tab-inventory').style.display = '';
    document.getElementById('tab-memory').style.display = '';
    setMenuButtonsEnabled(true);
    setGameControlsEnabled(true);
    setSidebarTabsEnabled(true);
    setDirectInputMode(!!engine?.definition?.metadata?.allow_direct_input);
    _focusGameTab();
    const textDisplay = document.getElementById('text-display');
    if (textDisplay) textDisplay.innerHTML = '';
    updateScrollBtnVisibility();
    appendGameMetadata(engine?.definition?.metadata);
    const intro = engine.getText('intro');
    if (intro) appendOutput(intro);
    _buildTabsFromMetadata();
    engine.renderCurrentLocation();
  });
    if (!engine) return;
    renderLanguageGrid();
    setLanguageModalVisible(true);
  });

  function _updateMobileLayout() {
    const isMobile = window.innerWidth <= 767 || window.innerHeight <= 500;
    if (isMobile === _isMobileLayout) return;
    _isMobileLayout = isMobile;

    const rightPanel = document.getElementById('right-panel');
    const roomImage = document.getElementById('room-image');
    const sidebarTabs = document.getElementById('sidebar-tabs');
    if (!rightPanel || !roomImage || !sidebarTabs) return;

    if (isMobile) {
      const roomDef = engine?.definition?.metadata?.tabs?.room;
      const roomVisible = roomDef ? roomDef.visible !== false : true;
      if (!roomVisible) {
        // Room tab disabled in metadata — keep room image in right panel
        return;
      }
      const roomTab = document.createElement('button');
      roomTab.className = 'tab-btn';
      roomTab.type = 'button';
      roomTab.role = 'tab';
      roomTab.setAttribute('aria-selected', 'false');
      roomTab.setAttribute('aria-controls', 'tab-panel-room');
      roomTab.id = 'tab-room';
      roomTab.setAttribute('data-tab', 'room');
      roomTab.textContent = 'Room';
      roomTab.addEventListener('click', () => setSidebarTab('room'));
      if (!engine) roomTab.disabled = true;

      const systemTab = document.getElementById('tab-system');
      if (systemTab && systemTab.parentNode) {
        systemTab.parentNode.insertBefore(roomTab, systemTab.nextSibling);
      }

      const tabsBody = sidebarTabs.querySelector('.tabs-body');
      if (tabsBody) {
        const roomPanel = document.createElement('div');
        roomPanel.className = 'tab-panel';
        roomPanel.role = 'tabpanel';
        roomPanel.id = 'tab-panel-room';
        roomPanel.setAttribute('aria-labelledby', 'tab-room');
        roomPanel.style.display = 'none';
        tabsBody.insertBefore(roomPanel, tabsBody.firstChild);
        roomPanel.appendChild(roomImage);
      }
    } else {
      const roomPanel = document.getElementById('tab-panel-room');
      const roomTab = document.getElementById('tab-room');
      if (roomPanel && roomImage) {
        rightPanel.insertBefore(roomImage, sidebarTabs);
      }
      if (roomPanel) roomPanel.remove();
      if (roomTab) {
        const wasActive = roomTab.getAttribute('aria-selected') === 'true';
        roomTab.remove();
        if (wasActive) setSidebarTab('system');
      }
    }
  }

  window.addEventListener('resize', _updateMobileLayout);

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
      onDebugRender: renderDebugPanel,
      onMapRender: renderMap,
      onRelationshipsRender: renderRelationshipsList,
      onStatsRender: renderStatsList
    });
    resetUiForNewGame();
    setDebugTabVisibility(!!engine?.definition?.metadata?.debug);
    setMapTabVisibility(true);
    document.getElementById('tab-inventory').style.display = '';
    document.getElementById('tab-memory').style.display = '';
    setMenuButtonsEnabled(true);
    setGameControlsEnabled(true);
    setSidebarTabsEnabled(true);
    setDirectInputMode(!!engine?.definition?.metadata?.allow_direct_input);
    _focusGameTab();
    const textDisplay = document.getElementById('text-display');
    if (textDisplay) textDisplay.innerHTML = '';
    updateScrollBtnVisibility();
    appendGameMetadata(engine?.definition?.metadata);
    const intro = engine.getText('intro');
    if (intro) appendOutput(intro);
    _buildTabsFromMetadata();
    engine.renderCurrentLocation();
  });
});

