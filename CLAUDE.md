# earlymusicsa — CLAUDE.md

Rebuild of **https://earlymusicsa.org** (Early Music San Antonio) away from
WordPress + EventON, onto the low-bloat house pattern: semantic HTML, CSS-first
styling, JavaScript only where nothing else will do.

The site is an audience-facing listing for Medieval / Renaissance / Baroque
concerts in the San Antonio area, maintained by volunteers. It is not a
ticketing system and never has been — it points people at events.

## Why this project exists

The live site runs WordPress 7.0.4 + the Sinatra theme + **EventON 5.0.13** with
two paid add-ons (`eventon-full-cal`, `eventon-event-lists`). The plugin
licences are expensive and recurring, and the whole stack ships ~74 requests /
50 scripts on the homepage to render three event listings. Nothing on the site
needs that.

## Status

- **Phase 1, content migration — done.** `scrape.js` pulled the complete archive.
- **Phase 2, static site — first pass done.** `build.js` generates the whole
  public site. Listings, calendar, archive and event pages all work.
- **Still to do:** the submission form + moderation server, real contact
  details, search, and filtering by type/venue/organizer.

## Layout

```
scrape.js            one-time export from the live WordPress site
build.js             data/events.json -> dist/  (the static site)
serve.js             local preview server for dist/ (not part of the site)
assets/style.css     the entire design; every value is a custom property
seed/masters.json    EventON saved-location + saved-organizer lists, read from
                     the live /submit-your-event/ form on 2026-08-19
seed/aliases.json    hand-curated merges for duplicate EventON records
data/                the export (committed — this is the point of the repo)
media/               375 mirrored featured images (committed, 23 MB)
cache/               raw event-page HTML, gitignored, delete to re-pull
dist/                generated output, gitignored — rebuild with `node build.js`
```

## Commands

```bash
node scrape.js            # refresh data/ from the live site
node scrape.js --images   # also mirror featured images -> media/
node build.js             # data/ -> dist/
node serve.js             # preview dist/ at http://localhost:4173
```

Event pages are cached under `cache/`, so scraper re-runs are free. The first
full run takes about a minute at concurrency 4.

## The build

The published site ships **zero JavaScript**. Index is 4 requests (HTML, one
stylesheet, two images) against 74 requests and 50 scripts on the WordPress
original.

- Expand-in-place event cards are `<details>`/`<summary>`, not a click handler.
- The calendar is a static `<table>` per month, generated at build time, with
  prev/next links. Under 34rem it becomes a list of only the days that have
  events, via CSS — no separate mobile template.
- Every colour, size and spacing value is a custom property on `:root`, with a
  dark theme through `prefers-color-scheme`. A future style panel should write
  these properties and nothing else.
- Images are rewritten to the local `media/` mirror at build time. `build.js`
  warns if anything still points at a remote host — it should always be zero.
- One `.ics` per event. Note EventON stores 23:59 to mean "no end time given";
  emitting that as `DTEND` would put a four-hour block in someone's calendar,
  so `DTEND` is omitted in that case. Same rule governs the displayed time
  range.
- Event pages carry schema.org JSON-LD, replacing what EventON used to emit.

## How the data was actually obtained

This is the part worth not re-deriving:

- The WordPress REST API is **open** — `/wp-json/wp/v2/ajde_events` returns all
  419 event records (title, description, taxonomy slugs, permalink).
- EventON keeps **dates, times and venues in postmeta that REST never exposes**
  (`meta` comes back as `[]`). Those live only in the rendered page, as
  `data-time="<startUnix>-<endUnix>"` plus `data-location_name` /
  `data-location_address` / `data-locid`.
- So: one REST sweep for records, then one page fetch per event for timing.
- `data-time` values are correct UTC epoch seconds. The JSON-LD `startDate` on
  the same page is **not** trustworthy — it emits local wall-clock time with a
  `+0:00` offset glued on. Use `data-time`.
- The REST API only gives taxonomy *slugs*, so organizer display names come from
  matching those slugs against `seed/masters.json`. That match needs WordPress's
  real `sanitize_title` rule, which **deletes** punctuation rather than replacing
  it: `info@lafollia.org` → `infolafollia-org`, `St. Mark's` → `st-marks`.

## Data hazards found in the source

- **cp1252 mojibake** throughout, from an old migration: `Mission ConcepciÃ³n`,
  `St. Maryâ€™s University`. `fixMojibake()` repairs only the damaged runs —
  a whole-string round-trip fails because descriptions mix damaged bytes with
  correctly-encoded curly quotes.
- **Double-encoded entities** (`&amp;amp;`), so entity decoding loops to a fixed
  point.
- **Stranded `Â` characters** whose trailing nbsp byte was already lost inside
  WordPress. Unrecoverable as a pair; dropped when followed by whitespace.
- **Duplicate venue records** — Mission Concepción exists five times
  (`Concepcian`, `Concepcien`, `Concpeción`, `ConcepciÃ³n`, `Concepcion`), the
  Little Flower basilica five times. Confirmed duplicates are merged via
  `seed/aliases.json`; anything ambiguous is left alone and listed in
  `data/review-merges.json`. That review list is currently **all false
  positives** (St. Mark's / St. Luke's / St. Paul's are genuinely different
  churches) — do not merge them.
- **9 events have no date set at all** in EventON and render as 1970. They are
  exported with `start: null` and listed in `data/report.json` under `problems`.
- **Spam in the dropdowns, not in the events.** The open submission form was
  farmed by conference spammers, leaving orphan location/organizer terms
  (Inovine Scientific Meetings, Pages Conferences, venues in Zurich/Tokyo/
  Prague). No *published* event uses any of them, and `data/locations.json` /
  `organizers.json` only list terms actually referenced by events, so the export
  is already clean. `scrape.js` still carries spam heuristics for future runs.

## What the export contains

419 events spanning **2010-04-11 → 2026-09-11**, 83 venues, 62 organizers,
113 event types. 402 have images, 404 list performers, 361 link out to a
promoter site, 33 record ticket prices. Zero blog posts on the source site.

## Functions the rebuild has to cover

From an audit of the live site: upcoming-events list; expand-in-place event
cards; month-grid calendar with month/year jump (also used as a sidebar
widget); past-events browsing; single event pages; filtering by
type/venue/organizer; iCal export; public event submission with moderation;
contact / email signup; search.

Only the **submission + moderation** piece genuinely needs a server. Everything
public can be static. Cards should be `<details>`/`<summary>`; filtering should
be CSS (`:has()` + inputs); the calendar grid is the one component that earns
real JavaScript. Drop the Google Maps JS embed — a static link to Google Maps
removes ~10 scripts and an exposed API key.

## Conventions

Per the global rules: CSS-first styling (never JS-computed), Google Sans Flex as
the default face, and any style-editing UI should reuse the shared 🎨 Style panel
from `The-Lemmon-Dociere` rather than a bespoke one. If a server is added, follow
the wall-family pattern — Express + `node:sqlite`, persisted server-side, not
`localStorage`.
