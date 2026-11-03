# Lodestar (day planner)

Personal day-planner web app, named Lodestar (chosen 2026-10-30). Live at https://lodestarplanner.netlify.app (Netlify deploys every push to main; the old GitHub Pages address forwards there). The GitHub repo is still called Day-planner: time-blocked days, week tabs, templates, recurring templates, categories, consistency grid, streak, "now" line, undo/redo, export/import backup.

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

Spam guard: Cloudflare Turnstile on the sign-in screen (public site key in index.html, sends `captchaToken` with sign-in, sign-up and password reset). Its secret key lives only in Supabase → Authentication → Attack Protection (CAPTCHA).

API: `get(key)` returns `{key, value}` (may return null OR throw when the key is missing), `set(key, value)`, `delete(key)`, `list(prefix)` returns `{keys}`. Writes were rate-limited, so they are done one at a time.

Offline (2026-11-03): `sw.js` keeps copies of the app files (cache `lodestar-files`) and serves them when there is no internet. `storage.js` keeps a per-account copy in localStorage (`lodestar:<userId>:copy`, `:lists`, `:outbox`, plus `lodestar:lastUser`). Online, Supabase is always asked first. Offline, reads use the copy (a key never copied still fails, never "empty"), and writes queue in the outbox and sync when back online. A "blind" queued change (the device never had that key) is merged on sync: a day keeps its saved blocks and gains new ones, id lists are unioned, and anything else keeps the saved value. A known key: the last change synced wins. Signing out or deleting the account clears the copy.

## Lessons already learned (please don't repeat these bugs)
- **Dates:** build day keys from the LOCAL date (`localDateStr`). Never use `toISOString()`: it shifts the day in Sydney (UTC+10/+11).
- **Loading a day is async:** build the day privately and ignore results from older loads (`loadSeq`), otherwise a slow load can land on the wrong day and get overwritten.
- **Saving:** take the JSON snapshot at the moment of the edit, keyed to that day, and flush pending saves when switching days (`pendingSaves`, `flushSaves`).
- **A failed read must not look like "empty":** templates, categories and recurring rules can only be saved once they loaded successfully (`templatesState`, `categoriesState`, `recurringState`; categories and recurring rules load through `loadProtected`, which retries and checks the key list).
- **Missing keys:** treat as empty (`safeGet`).
- **Safety settings reach the helper too:** `_headers` (content security policy) also applies to `sw.js`. Anything the helper fetches must be in `connect-src`, or the app breaks once the helper takes over. After changing `_headers`, change `HELPER_VERSION` in `sw.js` so installed helpers update.
- **Redraws:** the list is briefly emptied while re-rendering; hold its height and scroll position or the page jumps to the top.

## Known gaps
- Checked 2026-11-02 (backup of 37 days): no copies from the old "empty day copies yesterday" bug (those would share block ids with the day before). Look-alike days come from recurring templates.

## Suggested first steps
Outside Claude, `window.storage` doesn't exist, so the app cannot run at all until that is replaced. Do that first so every later step can actually be checked in a browser.
1. Add a small storage layer that implements the same API (`get`, `set`, `delete`, `list`) on top of localStorage, so the app runs in a normal browser. Keep it as one swap point. Check it works, including "Import backup" with the owner's exported data. Commit.
2. Then split the file into `index.html`, `styles.css` and `app.js` (and `storage.js`) with NO behaviour change. Check it still works. Commit.
3. Plan the backend (database + login) before writing any of it. With a real database, most of the storage workarounds above (`consindex`, tidying, sequential writes, `safeGet`) can go.

## Working style
Small steps. Run it after each change. Commit when it works.
