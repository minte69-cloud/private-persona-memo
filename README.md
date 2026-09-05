# Private Persona Memo

A SillyTavern UI extension that adds a private memo textarea to the Persona Management panel.

## What It Does

- Adds a `Private Memo` textarea below the persona description position controls.
- Saves one memo per persona in `extensionSettings.private_persona_memo.notes`.
- Uses the persona avatar id as the stable key whenever SillyTavern exposes it.
- Falls back to a key derived from the visible persona name and avatar hint if a stable id cannot be found.
- Copies a memo when a persona is duplicated, and removes a memo when its persona is deleted.

## Privacy Boundary

The memo is intentionally stored outside `power_user.persona_descriptions`, character cards, chat metadata, World Info, Author's Note, and extension prompts.

This extension does not register:

- prompt interceptors
- custom macros
- function tools
- extension prompts
- World Info entries
- Author's Note content

The textarea also avoids SillyTavern's `data-macros` attribute and does not use the `persona_description` field name.

## Installation

1. Copy this folder into one of these SillyTavern extension locations:
   - `data/<your-user-handle>/extensions/private-persona-memo`
   - `public/scripts/extensions/third-party/private-persona-memo`
2. Restart or reload SillyTavern.
3. Open the Persona Management panel and select a persona.

## Files

- `manifest.json` - SillyTavern extension manifest.
- `index.js` - UI insertion, per-persona memo storage, and persona event handling.
- `style.css` - Small layout adjustments for the memo block.

## License

MIT
