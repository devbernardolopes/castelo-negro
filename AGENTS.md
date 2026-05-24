# AGENTS.md

## Project Context

- Text adventure game engine built with vanilla JavaScript + HTML + CSS. Ongoing project.
- Entry point: `index.html`. All CSS must be in `styles.css`.
- Text adventure games are defined in YAML files. They are in the folder `adventures/` in their own subfolders.
- No build steps or tests required.
- YAML parsing (parseYaml, validateDefinition, and helpers) lives in `yaml-parser.js`, loaded before `script.js`.
- User prompt parsing logic (processPlayerCommand, _tryActions, _matchAction, _matchPatternAgainstPrompt, _matchVerbAt, _matchItemSlotAt, _matchAnyItemAt, _matchSpecificItemAt, _phraseMatchesItemId, _expandTemplate, _checkActionConditions, _applyActionEffects, _findItemIdByName, _findItemIdByNameOrSynonym, _takeItemByName, _dropItemByName, _consumeItemByName, _verbItemByName) lives in `prompt-parser.js`, loaded after `script.js`.
