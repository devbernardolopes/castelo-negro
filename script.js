// Castelo Negro - Main game script

const ADVENTURE_FILE = 'adventures/castelo-negro.yaml';
let currentLocation = 'cottage_living_room';
let gameData = {};

// Helper to read file
async function readFile(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Failed to load adventure file');
  return await response.text();
}

// Parse YAML with proper nesting support
function parseYaml(text) {
  const result = {};
  const lines = text.split('\n');
  const stack = [{ obj: result, indent: -1 }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.indexOf(trimmed[0]);
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;

    // Pop stack until we find parent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const key = kvMatch[1];
    const value = kvMatch[2].trim();
    const current = stack[stack.length - 1].obj;

    // Check if next line is indented (nested) or it's a simple value
    const nextLine = lines[i + 1];
    const nextTrimmed = nextLine?.trim();
    const nextIndent = nextLine ? nextLine.length - nextLine.indexOf(nextTrimmed?.[0] || ' ') : -1;

    if (value === '') {
      // Nested object or array
      current[key] = {};
      stack.push({ obj: current[key], indent });
    } else if (value.startsWith('-')) {
      // Array inline
      current[key] = [value.slice(1).trim()];
    } else {
      // Simple value
      const cleanValue = value.replace(/^"|"$/g, '');
      current[key] = cleanValue;
    }
  }
  return result;
}

// Get nested value from object using dot notation
function get(obj, path, defaultVal) {
  const keys = path.split('.');
  let result = obj;
  for (const key of keys) {
    if (result?.[key] === undefined) return defaultVal;
    result = result[key];
  }
  return result;
}

// Display image for location
function displayLocationImage(locationKey) {
  const location = gameData.locations?.[locationKey];
  if (!location) return;

  const images = location.images || [];
  const imgEl = document.getElementById('room-img');

  if (images.length > 0) {
    const imgPath = `adventures/assets/${images[0]}`;
    console.log('Loading image:', imgPath);
    imgEl.src = imgPath;
    imgEl.onload = () => {
      imgEl.style.display = 'block';
      console.log('Image loaded:', imgPath);
    };
    imgEl.onerror = () => {
      console.warn('Image not found:', imgPath);
      imgEl.style.display = 'none';
    };
  } else {
    imgEl.style.display = 'none';
    imgEl.src = '';
  }
}

// Display location description
function displayLocationDescription(locationKey) {
  const location = gameData.locations?.[locationKey];
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
  const mappedDir = DIRECTION_MAP[direction];
  const location = gameData.locations?.[currentLocation];
  const exit = location?.exits?.[mappedDir];
  if (exit) {
    loadLocation(exit);
  } else {
    console.log(`Can't go ${direction} from ${currentLocation}`);
  }
}

// Main initialization
async function initGame() {
  try {
    const yamlText = await readFile(ADVENTURE_FILE);
    gameData = parseYaml(yamlText);

    // Set starting location
    currentLocation = gameData.actors?.protagonist?.starting_location || 'cottage_living_room';
    loadLocation(currentLocation);

    // Set initial inventory
    const inventory = gameData.variables?.inventory?.value || [];
    const inventoryList = document.getElementById('inventory-list');
    inventory.forEach(itemName => {
      const li = document.createElement('li');
      li.textContent = itemName;
      inventoryList.appendChild(li);
    });

    window.gameData = gameData;
    console.log('Game initialized');
  } catch (error) {
    console.error('Failed to initialize game:', error);
    document.getElementById('text-display').textContent = 'Failed to load adventure file.';
  }
}

// Event handlers
document.addEventListener('DOMContentLoaded', initGame);

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('direction-btn')) {
    const direction = e.target.getAttribute('data-direction');
    moveDirection(direction);
  }
});