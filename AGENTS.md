# AGENTS.md

## Project Context

- Text adventure game engine built with vanilla JavaScript + HTML + CSS. Ongoing project.
- Entry point: `index.html`. All CSS must be in `styles.css`.
- Text adventure games are defined in YAML files. They are in the folder `adventures/` in their own subfolders. Partial and incomplete YAML game file schema guide here: `penthouse-yaml-schema.md`.
- Since this is still an on-going project, the reference YAML file from now on is `adventures\one-gold-piece\one-gold-piece.yaml`.
- No build steps or tests required.
- Script loading order: `yaml-parser.js` → `ui.js` → `engine.js` → `storage.js` → `script.js` → `prompt-parser.js`.
- YAML parsing (`parseYaml`, `validateDefinition`, `parseScalar`, and helpers) lives in `yaml-parser.js`.
- UI rendering functions (DOM helpers, text formatting, output display, command builder, modal, and engine hook callbacks like `renderRoomImage`, `renderInventoryList`, `renderMindPanel`, `renderMemoryList`) live in `ui.js`.
- Core engine (`InventorySystem`, `GameEngine` classes with condition/effect evaluation, movement, events) lives in `engine.js`. The engine communicates with the UI exclusively through hooks — no direct DOM access.
- Adventure loading and file I/O (IndexedDB helpers, `loadAdventureFromFile`, `loadAdventureFromUrl`, `loadManifest`, `pickAdventureFile`) live in `storage.js`.
- Bootstrap and event wiring (sidebar tabs, click/long-press/drag event delegation, send button, modal/menu button handlers) live in `script.js`.
- User prompt parsing logic (`processPlayerCommand`, `_tryActions`, `_matchAction`, `_matchPatternAgainstPrompt`, `_matchVerbAt`, `_matchItemSlotAt`, `_matchAnyItemAt`, `_matchSpecificItemAt`, `_phraseMatchesItemId`, `_expandTemplate`, `_checkActionConditions`, `_applyActionEffects`, `_findItemIdByName`, `_findItemIdByNameOrSynonym`, `_takeItemByName`, `_dropItemByName`, `_consumeItemByName`, `_verbItemByName`) lives in `prompt-parser.js`.
