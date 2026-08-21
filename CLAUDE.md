# earlymusicsa — CLAUDE.md

Rebuild of **https://earlymusicsa.org** (Early Music San Antonio) away from
WordPress + EventON, onto the low-bloat house pattern: semantic HTML, CSS-first
styling, JavaScript only where nothing else will do.

The site is an audience-facing listing for Medieval / Renaissance / Baroque
concerts in the San Antonio area, maintained by volunteers. It is not a
ticketing system and never has been — it points people at events.

Remote: **https://github.com/aloysiusb/earlymusicsa.org**

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
- **About page done** (2026-08-21), matched to the live one.
- **Past Events done** (2026-08-21). Note it uses a *different card* from the
  home page: a full-width three-column grid of 366x446 tiles, 20px radius,
  image filling the tile with the text over it, and no sidebar. Paginated 12
  per page to match the live rhythm, with a year jump row added on top.
- **Deploy:** `render.yaml` is in place. One-click blueprint link:
  https://render.com/deploy?repo=https://github.com/aloysiusb/earlymusicsa.org
  Render runs `node build.js` and serves `dist/` on the free static tier;
  every push to `main` redeploys. Verified to build from a clean clone.
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
seed/pages.json      copy + hero images for hand-written pages (About, etc.)
render.yaml          Render blueprint: build to dist/, serve as a static site
data/                the export (committed — this is the point of the repo)
media/               948 mirrored images incl. every size variant (47 MB)
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

The published site ships **zero JavaScript**. The home page is 6 requests
(HTML, the Google Fonts stylesheet, one local stylesheet, logo, banner, one
thumbnail) against 74 requests and 50 scripts on the WordPress original.

- Event cards are plain `<article>`s matching the live collapsed card: title,
  thumbnail, date block, time. They do not expand — the live card's expanded
  view is what the per-event page is for.
- The mobile menu is a hidden checkbox plus a label, so the nav still opens
  with no script.
- The calendar is a static grid per month, generated at build time, with
  prev/next links and a day-level link into the month page.
- Every colour, size and spacing value is a custom property on `:root`. A style
  panel should write these properties and nothing else. There is deliberately
  no dark theme — the live site has none.
- Images are rewritten to the local `media/` mirror at build time. `build.js`
  warns if anything still points at a remote host — it should always be zero.
  The header banner originally came from a leftover Bluehost staging domain
  (`qtz.bhi.mybluehost.me`), which is exactly why it is mirrored.
- **Responsive images.** WordPress had already generated resized copies of every
  upload; `scrape.js` harvests those (`media_details.sizes`) and mirrors them,
  and `build.js` emits a real `srcset`. Because the thumbnails crop a wide
  banner into a square, `sizes` asks for `box x aspect-ratio`, not the box
  width — otherwise the browser picks a 300x86 file and upscales it into a
  140px square. The home page loads a 34KB 768w file rather than the 1400w
  original, and the first two cards are `fetchpriority="high"` rather than lazy.
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
- **Repeating events are invisible on their own page.** 14 events recur, but the
  single event page only ever renders the first date — the others exist only at
  `<permalink>/var/ri-N.l-L1`, and EventON silently falls back to instance 0
  once N runs past the last one, which is the stop signal. Missing this loses 14
  dates from the archive and drops one card off the home page. `scrape.js`
  probes those URLs and stores every date in `instances`; `build.js` expands one
  card per date, which is what the live listings do.
- **Spam in the dropdowns, not in the events.** The open submission form was
  farmed by conference spammers, leaving orphan location/organizer terms
  (Inovine Scientific Meetings, Pages Conferences, venues in Zurich/Tokyo/
  Prague). No *published* event uses any of them, and `data/locations.json` /
  `organizers.json` only list terms actually referenced by events, so the export
  is already clean. `scrape.js` still carries spam heuristics for future runs.

## What the export contains

419 event records / 424 dates (14 events repeat) spanning **2010-04-11 →
2026-09-11**, 83 venues, 62 organizers,
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

## Design: match the live site

The owner asked (2026-08-20) for the rebuild to look **exactly like the live
WordPress site** — same layout, same calendar, same proportions. So this repo
deliberately departs from two global defaults:

- **Raleway, not Google Sans Flex.** The live site loads Raleway 400/500 from
  Google Fonts and the whole design is built on it. Weights 700/800 are added
  because EventON used them for card titles and calendar headings.
- The colours are the live site's, not a fresh palette.

Every measurement in `assets/style.css` was read off the live site's *computed*
styles at 1280px and 375px, not eyeballed, then verified the same way after
rebuilding. The home page matches within a pixel: main card 698x219 (live
697x219), thumbnail 140x140, "Show More Events" 160x36, sidebar thumbnail 50x50
at 15,54, days grid 352x255, footer bar 74px.

Reference values, should the live site ever go away:

| Thing | Value |
| --- | --- |
| Heading gold | `#9e7e00` |
| Footer bar | `#8c7200` |
| Event card panel | `#b3d1db`, white text, 20px padding |
| Card title | 24px / 800 / uppercase |
| Date block | day 30px/700, month 11px, year 10px/700, time 10px/700 |
| Thumbnail | 140x140, 10px radius, `cover` from top |
| Calendar | day names `#ececec` on `#9e9e9e`; days 12px/700 `#d4d4d4` |
| Banner | 155px tall, `cover`, position `24% 42%` |
| Columns | main 748px (incl. 50px gutter), sidebar 352px, container 1265px |
| Breakpoints | 900px sidebar drops below, 782px mobile nav |

**Deliberate deviations from the live look**, each one token: cards are rounded
10px with a 10px gap (live: square, butted together) — asked for on 2026-08-21,
and 10px is the radius the rest of the design already uses; the banner reserves
its full height so the H1 is not hidden; maps come from OpenStreetMap.

Note the live site sets white text on `#b3d1db`, which is about 1.7:1 contrast —
well below WCAG AA. Reproduced faithfully because that is what was asked for,
but `--card-text` is a single token if it should ever be darkened.

## Conventions

Per the global rules: CSS-first styling, never JS-computed. **Every value the
design depends on is a custom property on `:root`** — the planned style-editing
page should write only those properties, never rules. That page should reuse the
shared 🎨 Style panel from `The-Lemmon-Dociere` rather than a bespoke one, and
persist server-side (Express + `node:sqlite`), not to `localStorage`.

Two constants in `build.js` deliberately mirror CSS values and must be kept in
step: `THUMB` (matches `--thumb-size`) and the `sizes` attribute it feeds.
`sizes` is parsed by the HTML parser, so it cannot use `var()`.
