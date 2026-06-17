# YAML Schema Guide

## NOTE

***The referenced `the-penthouse.yaml` file is currently outdated regarding its format. But this document was not yet updated. However, this is not a big deal because the changes were small.***

## Summary

This document describes the current adventure-file format used by the Penthouse reference adventure and the engine features it already supports.

The goal is to let creators build a new game in this format without reading the JavaScript first. Examples are intentionally generic, but the rules below are based on the actual parser and engine behavior.

## File Layout

An adventure is split across:

- one root adventure file, such as `the-penthouse.yaml`
- several data files under `data/`
- assets under `assets/`

The root file provides metadata and points at the data files to merge into the final definition.

```yaml
metadata:
  title: Example Adventure
  author: Example Author
  version: 1.0
  languages: [en]
  default_language: en
  assets_path: "assets/"
  data_path: "data/"
  data_files:
    - items.yaml
    - locations.yaml
    - actions.yaml
    - actors.yaml
    - strings.yaml
    - variables.yaml
    - verbs.yaml
    - properties.yaml
```

## Root Metadata

- `metadata.title` is required.
- `metadata.default_language` is required.
- `metadata.languages` defines the language keys used by bilingual maps.
- `metadata.assets_path` is the base path for image/file lookup.
- `metadata.data_path` is the folder that contains the referenced YAML fragments.
- `metadata.data_files` is the list of data fragments to merge after the root file is loaded.
- `metadata.allow_direct_input` enables freeform typing in the UI.
- `metadata.debug` toggles debug UI behavior.
- `metadata.auto_container_description` appends automatic contents text for containers when true.
- `metadata.show_continue_message` and `metadata.continue_message` control the pause/continue prompt.
- `metadata.highlight_color_verbs` and `metadata.highlight_color_items` are UI colors.
- `metadata.directional_navigation` toggles directional UI controls.
- `metadata.tabs` controls sidebar visibility and labels.

Tab entries follow this shape:

```yaml
metadata:
  tabs:
    inventory:
      en: "Inventory"
      visible: true
```

## YAML Value Rules

The parser is intentionally tolerant.

- It supports plain mappings, sequences, inline arrays, inline maps, and block scalars.
- It accepts strings, numbers, booleans, `null`, `[]`, and `{}`.
- It accepts bilingual maps such as `{ en: "...", pt-br: "..." }`.
- It accepts inline maps without braces in some tolerant cases, but authors should prefer normal YAML.
- It supports block scalars with `|` and `>`.

Use 2-space indentation.

## Localization

Any field that may be shown to the player can be a string or a language map.

Examples of language maps:

```yaml
name:
  en: "Kitchen"
description:
  en: "A small kitchen."
  pt-br: "Uma cozinha pequena."
```

The engine chooses:

1. the active language
2. the default language
3. the first available value

## `items.yaml`

`items` is a map of item IDs to item definitions.

Common fields:

- `name`
- `short_name`
- `synonyms`
- `description`
- `images`
- `takeable`
- `wearable`
- `owner`
- `size`
- `contents`
- `container_type`
- `container_capacity`
- `actor_capacity`
- `openable`
- `enterable`
- `sittable`
- `sleepable`
- `droppable`
- `show_in_inventory`
- `show_in_auto_container_description`
- `readable`
- `on_ground_messages`
- `contents_visibility`
- `on_drop`
- `on_consume`

### Item naming

- `name` is the primary display name.
- `short_name` is the shorter display label used in descriptions and lists.
- `synonyms.<lang>` is used for parser matching only.
- Item IDs should remain stable `snake_case` identifiers.

### Containers

An item can contain other items with `contents`.

Container-related fields:

- `container_type` may be `in`, `on`, `hanging`, or `attached`.
- `container_capacity` limits item count/size.
- `contents_visibility` can hide specific contents until a condition is true.
- `show_in_auto_container_description` can suppress automatic contents listing.

### Openable items

Openable state is stored in the item definition and tracked by the engine.

```yaml
openable:
  initial: closed
  lockable: true
  locked: false
  side: two_way
  accessible_from: [room_a, room_b]
  show_current_state: true
```

Supported values:

- `initial`: `open` or `closed`
- `lockable`: whether the item can be locked
- `locked`: starting lock state
- `side`: used for one-way access logic
- `accessible_from`: locations that can interact with the item
- `show_current_state`: appends current open/closed text in descriptions

### Item descriptions

Descriptions can be:

- a string
- a bilingual map
- a structured object with `base` and `conditions`

When `conditions` are present, each condition entry is checked in order and matching messages are appended.

```yaml
description:
  base:
    en: "A plain desk."
  conditions:
    - if: "inventory.has('key')"
      message:
        en: "The key is on the desk."
```

### Item lifecycle hooks

- `on_ground_messages` lets a ground item choose a message by condition.
- `on_drop.effect` runs when the item is dropped.
- `on_consume.effect` runs when the item is consumed.

## `locations.yaml`

`locations` is a map of location IDs to location definitions.

Common fields:

- `name`
- `map_name`
- `synonyms`
- `description`
- `contents`
- `exits`
- `images`

### Location descriptions

Location descriptions support the same `base + conditions` pattern as items.

After the base text and conditional text, the engine may append:

- visible ground-item messages
- actor presence text

### Exits

An exit can be a simple target string or a gated object:

```yaml
exits:
  north: room_b
  east:
    location: room_c
    conditions:
      - if: "items.isOpen('door_east')"
        allow: true
      - if: "items.isLocked('door_east')"
        allow: false
        message:
          en: "The door is locked."
```

Exit condition entries use:

- `if`
- `allow`
- `message`

The first matching exit rule decides whether travel is allowed.

## `actors.yaml`

`actors` is a map of actor IDs to actor definitions.

Common fields:

- `name`
- `synonyms`
- `playable`
- `images`
- `display_image`
- `starting_location`
- `starting_contained_by`
- `starting_posture`
- `known_locations`
- `inventory`
- `wearing`
- `max_capacity`
- `properties`
- `relationships`
- `dialogue`

### Actor state

At load time, the engine initializes:

- inventory
- worn items
- current location
- containment
- posture
- known locations
- per-actor property values
- relationship data

### Actor properties

Actor properties are defined globally in `properties.yaml` and then assigned per actor.

Example:

```yaml
properties:
  mood:
    type: string
    default: neutral
    possible_values: [neutral, happy, sad, curious]
```

An actor may override a property value directly or override some constraints for that actor.

### Actor display images

`display_image` is an ordered list of rules.

Each rule may include:

- `id`
- `image`
- `conditions`

The first rule whose conditions all pass wins. If none match, the engine falls back to `images.full`.

### Actor dialogue

`dialogue` is the most important advanced schema in the Penthouse reference.

Shape:

```yaml
dialogue:
  entry_nodes:
    - id: greeting
      conditions:
        - "..."
  nodes:
    greeting:
      message:
        en: "Hello."
      options:
        - text:
            en: "Hi."
          effects:
            - "..."
          next: null
```

#### Entry nodes

- `entry_nodes` is an ordered list.
- Each entry has an `id` and optional `conditions`.
- The first entry whose conditions all pass becomes the starting node.
- If `entry_nodes` is omitted, the engine falls back to a `greeting` node when present.

#### Dialogue nodes

Each node may contain:

- `message`
- `options`

Node messages are rendered as `Actor Name: "message text"`.

#### Options

Each option may contain:

- `text`
- `conditions`
- `effects`
- `next`

Rules:

- Invisible options are skipped if their conditions fail.
- Options are displayed and chosen in the order they appear.
- Selecting an option runs `effects` first.
- If `next` is set, the dialogue continues at that node.
- If `next` is null or absent, the conversation ends.

## `actions.yaml`

`actions` is a map of command-driven actions.

Common fields:

- `pattern`
- `patterns`
- `follow_up`
- `conditions`
- `effect`
- `message`
- `message_pool`
- `conditional_messages`
- `progressive_messages`
- `confirmation`

### Patterns

An action can define either:

- a single `pattern`
- multiple `patterns`

Patterns are ordered sequences of one-key slot maps.

```yaml
pattern:
  - verb: ["take"]
  - object: ["*"]
```

Supported slot types in the current engine:

- `verb`
- `object`
- `target`
- `actor`
- `location`

Slot rules:

- `optional: true` allows a slot to be skipped.
- `match_mode` is supported for actor slots.
- `["*"]` means wildcard matching.

### Follow-up prompts

`follow_up` lets the engine ask for missing slot values.

Example:

```yaml
follow_up:
  object:
    en: "Take what?"
  actor:
    en: "To whom?"
```

### Conditions and results

- `conditions` must all pass for the action to succeed.
- `effect` runs on success.
- `message` is the success message.
- `message_pool` is a random choice list of success messages.
- `conditional_messages` run only on failure.
- `progressive_messages` run after effects when their condition passes.
- `confirmation` creates a yes/no gate before success.

## `variables.yaml`

`variables` defines mutable game variables.

Common fields:

- `type`
- `value`
- `min_value`
- `max_value`
- `possible_values`
- `max_capacity`

Supported types:

- `int`
- `bool`
- `string`
- `list`
- `object`
- `any`

The engine uses variable values in conditions, effects, and template expansion.

## `verbs.yaml`

`verbs` is a map of canonical verb IDs to synonym lists.

```yaml
verbs:
  take:
    synonyms:
      en: [take, pick up, grab]
```

Verb synonyms are used only for parser matching.

## `properties.yaml`

`properties` defines reusable actor property schemas.

Common fields:

- `type`
- `min_value`
- `max_value`
- `possible_values`
- `default`
- `label`
- `is_stat`
- `show_in_relationships`

These definitions drive actor property initialization and clamping.

## `events.yaml`

`events` is a list of event definitions.

Common fields:

- `id`
- `type`
- `interval`
- `conditions`
- `trigger_when`
- `trigger_on`
- `action_id`
- `location`
- `message`
- `effect`

Supported event types in the engine:

- `recurring`
- `time_based`
- `location_enter`

Events can also be triggered directly by ID.

## `strings.yaml`

`strings` stores reusable text assets and long-form content.

Typical uses:

- intro text
- books and readable passages
- death or ending messages
- reusable lore fragments

Long text can use `---page---` to split reading chunks.

## `end_conditions.yaml`

`end_conditions` defines game-ending win/lose checks.

Shape:

```yaml
end_conditions:
  lose:
    - id: player_dead
      condition: "health <= 0"
      message:
        en: "You have died."
  win:
    - id: escape
      condition: "current_location == 'exit'"
      message:
        en: "You escaped."
```

The engine checks lose conditions first, then win conditions.

## `groups`

`groups` is a convenience map for author organization and map grouping.

Common fields:

- `name`
- `color`
- `locations`

Groups are not required for core play, but they are useful for author tooling and map presentation.

## Conditions and Expressions

The engine evaluates many condition strings as expressions.

It supports:

- logical operators: `and`, `or`, `not`
- comparison operators
- arithmetic operators
- string literals
- array membership via `in`
- helper calls

### Common context values

The eval context includes values such as:

- `current_location`
- `game_turn`
- `current_player_actor`
- actor properties exposed as bare names in some contexts
- relationship and item helpers

### Common helpers in conditions

The following helpers are supported in the current engine:

- `getActor(actorId)`
- `getActorProp(actorId, propName)`
- `getRelationship(actorId, propName)`
- `getRelationshipBetween(actorId1, actorId2, propName)`
- `here.has(itemId)`
- `inventory.has(itemId)`
- `containerHas(containerId, itemId)`
- `isWorn(itemId)`
- `isWornBy(actorId, itemId)`
- `isSeated(actorId)`
- `getPosture(actorId)`
- `isActorHidden(actorId)`
- `getContainerOccupantsCount(itemId)`
- `items.takeable(itemId)`
- `items.droppable(itemId)`
- `items.openable(itemId)`
- `items.isOpen(itemId)`
- `items.isLocked(itemId)`
- `items.canOpen(itemId)`
- `items.enterable(itemId)`
- `items.sittable(itemId)`
- `items.sleepable(itemId)`
- `items.container_capacity(itemId)`
- `items.container_count(itemId)`
- `items.item_size(itemId)`
- `items.isAncestor(itemId, ancestorId)`
- `items.getProp(itemId, path)`
- `items.getProp(itemId, 'openable.side')`
- `items.getProp(itemId, 'openable.accessible_from')`
- `actors.<actorId>.max_capacity` in action conditions where the current definition is expanded

The engine also accepts convenience forms such as:

- `inventory.has(newborn_daughter)` without quotes
- `here.has(newborn_daughter)` without quotes
- `containerHas(containerId, itemId)` without quotes in some cases

## Effects and Game-State Mutations

Effect strings are executed line by line.

Supported effect calls include:

- `inventory.add('item_id')`
- `inventory.remove('item_id')`
- `here.add('item_id')`
- `here.remove('item_id')`
- `containerAdd('container_id', 'item_id')`
- `containerRemove('container_id', 'item_id')`
- `putInTarget('target_id', 'item_id')`
- `actorInventoryAdd('actor_id', 'item_id')`
- `actorInventoryRemove('actor_id', 'item_id')`
- `setActorProp('actor_id', 'prop_name', value)`
- `setRelationship('actor_id_1', 'actor_id_2', 'prop_name', value)`
- `setPlayerActor('actor_id')`
- `setOwner('item_id', 'actor_id')`
- `containActor('actor_id', 'container_id', 'posture')`
- `releaseActor('actor_id')`
- `setPosture('actor_id', 'posture')`
- `removeWornItem('actor_id', 'item_id')`
- `addWornItem('actor_id', 'item_id')`
- `startConversation('actor_id')`
- `endConversation()`
- `setOpen('item_id', true|false)`
- `setLocked('item_id', true|false)`

The engine also supports simple assignments like:

```yaml
effect:
  - "game_turn += 1"
  - "invalid_attempt_count += 1"
```

And conditional assignments:

```yaml
effect:
  - "health += 1 if inventory.has('medkit') else 0"
```

## Template Expansion

The engine expands placeholders in many messages, descriptions, and dialogue strings.

Common placeholders:

- `{object}`
- `{object_name}`
- `{target}`
- `{target_name}`
- `{actor}`
- `{actor_name}`
- `{location}`
- `{location_name}`
- `{readable_text}`
- `{actor_examine_output}`
- `{location_or_object_description}`
- `{object_owner}`
- `{contained_by_name}`

Dialogue context also includes:

- `actor`
- `actor_id`
- `current_actor`
- `current_actor_id`
- `actor_name`
- `actor_gender`
- `actor_mood`
- `current_player_actor`
- `current_player_actor_id`
- `current_player_actor_name`
- `current_player_actor_gender`
- `current_player_actor_mood`
- `relationship_affinity`
- `relationship_level`
- `player_relationship_affinity`
- `player_relationship_level`
- `game_turn`

## Authoring Rules

- Keep IDs stable and ASCII-only.
- Keep `name`, `description`, `message`, and similar player-facing strings localized.
- Use `synonyms` for parser matching, not for display.
- Use `conditions` for gating and `effect` for mutation.
- Prefer data-driven branches over hard-coded story logic.
- For dialogue, put branching logic in node conditions and option conditions, not in the text itself.
- Use `follow_up` for missing slots instead of making every command form explicit.
- Use `conditional_messages` for tailored failure feedback.
- Use `progressive_messages` for multi-stage success feedback after state changes.
- Use the tolerant YAML subset conservatively: standard YAML syntax is safest for long-term maintenance.

## Notes on the Penthouse Reference

The Penthouse adventure uses these patterns heavily:

- relationship-aware dialogue
- actor containment and posture
- wearable clothing layered on top of inventory
- openable/lockable doors and containers
- readable books split into pages
- actor-specific display images based on conditions

That makes it a good reference adventure for future content, but the engine contract documented here is broader than the current sample content.
