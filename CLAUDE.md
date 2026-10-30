# Day planner

Personal day-planner web app: time-blocked days, week tabs, templates, recurring templates, categories, consistency grid, streak, "now" line, undo/redo, export/import backup.

It began as one self-contained HTML file (`index.html`, originally `day-planner-v1.9.html`) running inside a Claude artifact. Plain HTML, CSS and JavaScript. No framework, no build step.

The owner is learning JavaScript. Keep changes small, explain them simply, and don't add features that weren't asked for. Ask before any big rewrite.

## Goals
1. Run outside Claude (in a normal browser).
2. Later: a real backend with accounts so the data syncs between laptop and phone.
3. Keep it simple and free to run.

## Storage (`window.storage`, defined in `storage.js`)
Outside Claude, `storage.js` stores everything in Supabase (table `planner_items`: `user_id`, `key`, `value`, `updated_at`; row level security lets each signed-in user touch only their own rows) and shows a sign-in screen until someone signs in. Only the publishable key belongs in the code, never the secret / service_role key.

All values are JSON strings. Keys:
- `plan:YYYY-MM-DD` — array of blocks: `{id, time:"HH:MM", title, notes, tags:[names], done, duration (minutes)}`
- `categories` — `[{name, color}]`
- `templates` — `{templateName: [{time, title, notes, tags, duration}]}`
- `recurring` — `[{id, templateName, weekdays:[0-6, Sunday=0]}]`
- `recurapplied:YYYY-MM-DD` — ids of recurring rules already applied to that day
- `settings` — `{bg, accent, font, dark, showProgress, showMiniTimeline, showConsistency, quickAdd}`
- `consindex` — `{"YYYY-MM-DD": [done, total]}`: summaries of days older than 14 days (the full day is deleted once summarised)
- `lastexport` — set when a backup was exported; old-day tidying only runs after this exists
- `pushsub:<id>` — one per device that turned reminders on: `{sub, tz, minutes}` (not in backups)
- `remindsent:YYYY-MM-DD` — block ids already reminded today; written by the sender, older days deleted

Reminders: `sw.js` shows them; `supabase/functions/send-reminders` (Supabase Edge Function, run every minute by a Cron job, JWT check off) sends them. Its secret `VAPID_PRIVATE_KEY` lives only in Supabase secrets and the git-ignored `secrets/` folder. The table needed `grant ... to service_role` for the sender to read it.

API: `get(key)` returns `{key, value}` (may return null OR throw when the key is missing), `set(key, value)`, `delete(key)`, `list(prefix)` returns `{keys}`. Writes were rate-limited, so they are done one at a time.

## Lessons already learned (please don't repeat these bugs)
- **Dates:** build day keys from the LOCAL date (`localDateStr`). Never use `toISOString()`: it shifts the day in Sydney (UTC+10/+11).
- **Loading a day is async:** build the day privately and ignore results from older loads (`loadSeq`), otherwise a slow load can land on the wrong day and get overwritten.
- **Saving:** take the JSON snapshot at the moment of the edit, keyed to that day, and flush pending saves when switching days (`pendingSaves`, `flushSaves`).
- **A failed read must not look like "empty":** templates, categories and recurring rules can only be saved once they loaded successfully (`templatesState`, `categoriesState`, `recurringState`; categories and recurring rules load through `loadProtected`, which retries and checks the key list).
- **Missing keys:** treat as empty (`safeGet`).
- **Redraws:** the list is briefly emptied while re-rendering; hold its height and scroll position or the page jumps to the top.

## Known gaps
- Some days may be duplicates of the previous day, caused by an old bug (before ~11am an empty day could copy the day before). Not cleaned up.

## Suggested first steps
Outside Claude, `window.storage` doesn't exist, so the app cannot run at all until that is replaced. Do that first so every later step can actually be checked in a browser.
1. Add a small storage layer that implements the same API (`get`, `set`, `delete`, `list`) on top of localStorage, so the app runs in a normal browser. Keep it as one swap point. Check it works, including "Import backup" with the owner's exported data. Commit.
2. Then split the file into `index.html`, `styles.css` and `app.js` (and `storage.js`) with NO behaviour change. Check it still works. Commit.
3. Plan the backend (database + login) before writing any of it. With a real database, most of the storage workarounds above (`consindex`, tidying, sequential writes, `safeGet`) can go.

## Working style
Small steps. Run it after each change. Commit when it works.
