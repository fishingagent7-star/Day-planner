# Day planner

Personal day-planner web app: time-blocked days, week tabs, templates, recurring templates, categories, consistency grid, streak, "now" line, undo/redo, export/import backup.

It began as one self-contained HTML file (`index.html`, originally `day-planner-v1.9.html`) running inside a Claude artifact. Plain HTML, CSS and JavaScript. No framework, no build step.

The owner is learning JavaScript. Keep changes small, explain them simply, and don't add features that weren't asked for. Ask before any big rewrite.

## Goals
1. Run outside Claude (in a normal browser).
2. Later: a real backend with accounts so the data syncs between laptop and phone.
3. Keep it simple and free to run.

## Storage (currently `window.storage`, which only exists inside Claude artifacts)
All values are JSON strings. Keys:
- `plan:YYYY-MM-DD` — array of blocks: `{id, time:"HH:MM", title, notes, tags:[names], done, duration (minutes)}`
- `categories` — `[{name, color}]`
- `templates` — `{templateName: [{time, title, notes, tags, duration}]}`
- `recurring` — `[{id, templateName, weekdays:[0-6, Sunday=0]}]`
- `recurapplied:YYYY-MM-DD` — ids of recurring rules already applied to that day
- `settings` — `{bg, accent, font, dark, showProgress, showMiniTimeline, showConsistency, quickAdd}`
- `consindex` — `{"YYYY-MM-DD": [done, total]}`: summaries of days older than 14 days (the full day is deleted once summarised)
- `lastexport` — set when a backup was exported; old-day tidying only runs after this exists

API: `get(key)` returns `{key, value}` (may return null OR throw when the key is missing), `set(key, value)`, `delete(key)`, `list(prefix)` returns `{keys}`. Writes were rate-limited, so they are done one at a time.

## Lessons already learned (please don't repeat these bugs)
- **Dates:** build day keys from the LOCAL date (`localDateStr`). Never use `toISOString()`: it shifts the day in Sydney (UTC+10/+11).
- **Loading a day is async:** build the day privately and ignore results from older loads (`loadSeq`), otherwise a slow load can land on the wrong day and get overwritten.
- **Saving:** take the JSON snapshot at the moment of the edit, keyed to that day, and flush pending saves when switching days (`pendingSaves`, `flushSaves`).
- **A failed read must not look like "empty":** templates can only be saved once they loaded successfully (`templatesState`). Categories and recurring rules do NOT have this protection yet.
- **Missing keys:** treat as empty (`safeGet`).
- **Redraws:** the list is briefly emptied while re-rendering; hold its height and scroll position or the page jumps to the top.

## Known gaps
- Categories and recurring rules lack the failed-read protection templates have.
- Some days may be duplicates of the previous day, caused by an old bug (before ~11am an empty day could copy the day before). Not cleaned up.
- Nothing syncs between devices.

## Suggested first steps
Outside Claude, `window.storage` doesn't exist, so the app cannot run at all until that is replaced. Do that first so every later step can actually be checked in a browser.
1. Add a small storage layer that implements the same API (`get`, `set`, `delete`, `list`) on top of localStorage, so the app runs in a normal browser. Keep it as one swap point. Check it works, including "Import backup" with the owner's exported data. Commit.
2. Then split the file into `index.html`, `styles.css` and `app.js` (and `storage.js`) with NO behaviour change. Check it still works. Commit.
3. Plan the backend (database + login) before writing any of it. With a real database, most of the storage workarounds above (`consindex`, tidying, sequential writes, `safeGet`) can go.

## Working style
Small steps. Run it after each change. Commit when it works.
