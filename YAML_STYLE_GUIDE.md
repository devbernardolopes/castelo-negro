# YAML Style Guide (v1.2)

This project defines text adventures as YAML files. This guide documents the canonical authoring format expected by the engine.

## General

- Encoding: UTF-8.
- Indentation: 2 spaces (never tabs).
- IDs: stable `snake_case` ASCII strings (do not localize IDs).
- Keep files tidy: avoid trailing blocks of blank lines.

## Languages

- `metadata.languages` is authoritative (example: `[en, pt-br]`).
- Any bilingual map (e.g. `name`, `description`, `message`) must only use keys from `metadata.languages` (plus optional fallbacks handled by the engine).

## Items

- Defined under `items:`.
- `items.<id>.name` is a bilingual map.
- `items.<id>.synonyms.<lang>` is a list of strings used only for parser matching (never for game logic).

Example:

```yaml
items:
  newborn_daughter:
    name: { en: "Newborn Daughter", pt-br: "Filha Recém-Nascida" }
    synonyms: { en: ["baby", "daughter", "infant"], pt-br: ["bebê", "filha"] }
    takeable: true
```

## Actions

- Defined under `actions:` as a map of action IDs.
- **First matching action wins** (add an explicit `priority` field later if needed).

### `pattern` (ordered)

`actions.<id>.pattern` is an ordered YAML **sequence** of 1-key maps. Order is significant.

- Slot names are keys like `verb`, `object`, `target` (more can be added later).
- Slot values are always lists.
- Wildcard is always `["*"]` (never `"*"`).

Example:

```yaml
actions:
  take_item:
    pattern:
      - verb: ["take"]
      - object: ["*"]
```

### Templates

- `{object}` / `{target}` expand to canonical IDs matched by the pattern.
- `{object_name}` / `{target_name}` expand to localized display names.

### Conditions & effects (expression strings)

- `conditions` and `effect` entries are expression strings.
- Use YAML double-quoted strings and single-quote IDs inside helper calls.

Helpers available in expressions:

- `here.has('id')`: true if the current location `contents` includes the entity ID.
- `inventory.has('item_id')`, `inventory.add('item_id')`, `inventory.remove('item_id')`
- `inventory.length`: number of inventory items
- `inventory.max_capacity`: maximum inventory capacity (from `variables.inventory.max_capacity`)
- `items.takeable('item_id')`: true if the item is takeable

Example:

```yaml
conditions:
  - "here.has('{object}')"
  - "items.takeable('{object}')"
  - "inventory.length < inventory.max_capacity"
effect:
  - "inventory.add('{object}')"
```
