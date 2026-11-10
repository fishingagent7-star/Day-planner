# Lodestar: map of this folder

Lodestar is a calm day planner: plan your day in time blocks, tick them off, and every good day lights a star in your Night Sky.
Live at **https://lodestarplanner.pages.dev**. Every upload (push) to GitHub goes live on Cloudflare in under a minute.

## The website (these must stay at the top: Cloudflare puts this folder online)

**The app itself**
| File | What it is |
|---|---|
| `index.html` | The page that opens: the layout of everything you see (sign-in screen, day tabs, menus, Settings) |
| `app.js` | The app's brain: blocks, days, templates, the Night Sky, reminders button, undo, backups |
| `storage.js` | Saving and loading: talks to Supabase, sign-in, the offline copy and syncing |
| `styles.css` | How it looks: colours, fonts, spacing, themes |
| `sw.js` | The "helper" that runs in the background: makes the app open offline and shows reminders |

**Other pages**
| File | What it is |
|---|---|
| `privacy.html`, `terms.html` | The privacy policy and terms of use |
| `404.html` | The "page not found" page |

**Pictures and fonts**
| File | What it is |
|---|---|
| `icon.svg` | The app icon (browser tab) |
| `apple-touch-icon.png` | The icon on an iPhone Home Screen |
| `og-image.png` | The picture shown when someone shares the link |
| `fonts/` | The app's fonts, kept here so it works offline |

**Website settings**
| File | What it is |
|---|---|
| `_headers` | Safety rules for the browser (what the app may load). Change `HELPER_VERSION` in `sw.js` after editing it |
| `robots.txt`, `sitemap.xml` | Help search engines find the site |

## The server side
| Folder | What it is |
|---|---|
| `supabase/` | Things that run on Supabase, not in the app: the reminder sender (`functions/send-reminders`) and database setup notes (`.sql`). Changing these does NOT go live by pushing: they're updated in the Supabase dashboard |

## For you (never uploaded)
| Folder | What it is |
|---|---|
| `notes/` | Your notes and prompts (e.g. `fable-prompts.md`) |
| `backup/` | Your exported planner backups (personal data) |
| `archive/` | Old versions of the app, kept for reference |
| `secrets/` | Private keys. Never share or upload |

## For Claude
| File | What it is |
|---|---|
| `CLAUDE.md` | Instructions and lessons for Claude about this project. Stays at the top |

Hidden folders (`.git`, `.claude`, `.ua`) are tools' own files. You never need to open them.
