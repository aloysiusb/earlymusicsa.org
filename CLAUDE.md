# earlymusicsa — CLAUDE.md

Rebuild of **https://earlymusicsa.org** (Early Music San Antonio) away from
WordPress + EventON, onto the low-bloat house pattern: semantic HTML, CSS-first
styling, JavaScript only where nothing else will do.

The site is an audience-facing listing for Medieval / Renaissance / Baroque
concerts in the San Antonio area, maintained by volunteers. It is not a
ticketing system and never has been — it points people at events.

Remote: **https://github.com/aloysiusb/earlymusicsa.org**

## The old site went down on 2026-08-22 — and came back on 2026-08-30

**Resolved.** Eight of eight probes returned the real WordPress site again on
2026-08-30, so it can be measured once more. The account of the outage below is
kept because the lesson stands: this host has failed once, without warning, and
its error page returns HTTP 200 so uptime checks will not catch it.

### What happened

Part-way through that day's work `earlymusicsa.org` stopped serving. Measured
over ten attempts: **zero** returned the real site — four returned a 195-byte
hosting error page ("Please contact your service provider"), six timed out. Note
the error page comes back with **HTTP 200**, so any check that only looks at
status codes will report the site as healthy.

It was working earlier the same day; the scrape and the stylesheet fetches all
succeeded. So this is recent, and it means:

- Design values captured while it was up are in the reference table below; use
  those first, and only re-measure if the host is answering.
- **Nothing was lost.** The export had already mirrored all 419 events, 424
  dates and 948 images, and they are in git and deployed. This is precisely the
  failure the migration was meant to survive.
- Visitors to `earlymusicsa.org` are currently seeing an error page, which makes
  pointing DNS at Render an improvement rather than a risk.

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
- **Database in place** (2026-08-22): submissions + style tokens, tested, and
  the Render blueprint switched to a web service with a persistent disk.
  Still needed on top of it: the submit form UI, the moderation screen, the
  style-editing page, and a decision on how to deploy the server.
- **Calendar done** (2026-08-30, re-matched 2026-09-02): full width, no
  sidebar, seven columns of 157px cells - 91px for an empty row, 111px where
  something is on, 30px padding, day numbers 20px/700. Each event shows in its
  day as a 10px chip with a 5px radius in that event own colour. Month title
  26px/800. Current Month is hidden while you are on the current month, as on
  the live page. Jump Months is a <details> panel of every month with events.
  Note the live calendar measured differently in August than in September;
  re-measure rather than trusting older numbers.
- **Contact done** (2026-08-30) and the form actually works: it posts to the
  server, stores into a messages table, and returns a real thank-you page so it
  functions with JavaScript off. Honeypot included. Volunteers read the queue at
  GET /api/messages (admin token).
- **Submit form, moderation and style editor done** (2026-08-30). The public
  submit form needs no JavaScript; the volunteer tools at /admin.html do, which
  is the one place on the site that is true.
- **Event edit mode done** (2026-09-02). Any archived event can be changed from
  /admin.html without touching `data/events.json`. See
  "Editing events" below — the design is deliberate and worth reading before
  changing it.
- **Maps are Google's** (2026-09-02), over the mirrored tiles, and clicking one
  opens a larger zoomable view. Needs `GOOGLE_MAPS_KEY`; without it the tiles
  stand alone and the click opens Google Maps in a new tab, so the site is
  complete either way. See "Maps".
- **Notification email done** (2026-09-02). A submission or a contact message
  emails whoever is listed in `MAIL_TO`. Optional: with the SMTP variables
  unset nothing is sent and nothing breaks. See "Telling somebody".
- **Guide expanded** (2026-09-16). `assets/guide.html` gained an "Everything you
  can change" list naming all thirteen editable event fields — the prose summary
  it replaced omitted `Sub title` and was vague about `Ends`. The sign-in step
  now says to paste into the box marked **Admin token**, matching what
  `admin.html` actually labels it; it previously said "admin password", which is
  the kind of small mismatch that produces a phone call.
- **Still to do:** search, and filtering by type/venue/organizer.

## Roadmap — the volunteer tools

Agreed 2026-09-16. Goal: give Leslie (and whoever follows her) control over as
many attributes as possible, without her ever needing a developer. Ship one
phase a week; each is independently useful, so stopping after any of them leaves
nothing half-built.

**The spine, which already exists and must not be broken.** Imported data in
`data/*.json` is never mutated. Every editor change is a *patch* in SQLite keyed
to the thing it changes, with a history table behind it, merged at build time by
`applyEventPatch()`. That is why "Undo all edits to this event" works no matter
how long ago or how many times. Everything below extends this pattern rather
than working around it.

1. ~~**All Events table.**~~ **Done 2026-09-16.** New `All events` tab: every
   event in one table, sortable by any column, a filter box that searches every
   field, a live "13 of 419 shown" count, and a CSV export that respects the
   current filter (BOM-prefixed so Excel opens the accents correctly). Backed by
   `GET /api/events/all`, deliberately separate from `/api/events` — that one is
   the editor's type-ahead and caps at 60. Fetched once, then sorted and
   filtered in the browser: 419 rows is small enough that a round trip per
   keystroke would be slower, and it keeps query-building off the server.
   Read-only by design; editing stays in `Edit events`. Still to add here: a
   download of the SQLite file for anyone who wants to open it in DB Browser.
2. **Venues and Organizers.** `location_edits` and `organizer_edits`, same patch
   pattern, same history, same undo. Two new tabs. Today a venue address only
   exists as free text per event, so correcting one means editing every event at
   that venue — 83 venues, 62 organizers. Biggest single jump in editing power.
3. **Image picker.** Browse the existing library visually rather than pasting a
   URL into `Image link`. Thumbnail grid, search, click to attach.
4. **Restructure the shell.** At seven tabs a flat row stops working. Group into
   Content / Inbox / Appearance, with a landing view showing what needs
   attention.

**Standing invitation to Leslie:** if she wants to edit an attribute that is not
exposed, add it. `EDITABLE_FIELDS` and `validateEventPatch` in `db.js` are the
two places to touch. The thirteen current fields are what was needed at the
time, not a design limit.

## Layout

```
scrape.js            one-time export from the live WordPress site
build.js             data/events.json -> dist/  (the static site)
server.js            serves dist/ + the submissions and style API (node:http)
db.js                SQLite schema and helpers (node:sqlite, no deps)
tiles.js             mirrors the OpenStreetMap tiles each venue map needs
assets/submit.js     the Submit page: field toggles, venue picker, live map
audit.js             finds EventON fields the export is dropping
test-db.mjs          32 checks over storage, validation and the routes
test-deploy.mjs      rehearses the Render setup: disk-mounted DB, rebuilds
assets/style.css     the entire design; every value is a custom property
assets/admin.*       volunteer tools: moderation, messages, style editor
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
npm start                 # serve dist/ + the API at http://localhost:4173
npm test                  # storage, validation and route checks
node audit.js --values    # what EventON data the export is dropping
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

## The database

`db.js` + `server.js`, using `node:sqlite` and `node:http` with **no
dependencies**, following the wall-family pattern (see `C:\Users\xnytr\Claude\server.js`).

```bash
npm start          # serve dist/ + the API on :4173
npm test           # 156 checks over storage, validation, routes, edits, mail and limits
```

Everything in it is something that changes at runtime:

- **`submissions`** — events sent through the public form, awaiting moderation.
  Approved rows are merged into the listings by `build.js` at build time.
- **`messages`** — what the Contact form collected.
- **`style_settings`** (+ `style_history`) — the design tokens the style-editing
  page writes. Every change is kept, so a bad edit can be walked back.
- **`event_edits`** (+ `event_edit_history`) — changes to archived events, held
  as overrides rather than rewritten into the export. See "Editing events".
- **`geocache`** — venue coordinates already looked up, so Nominatim is asked
  once per address and never again.

`db.js` runs a `migrate()` on open. **`CREATE TABLE IF NOT EXISTS` does not add
a column to a table that already exists** — that is how a live database gets a
"SQL logic error" after a deploy. New columns go in `migrate()`, not the DDL.

The event archive stays in `data/events.json`. It is the export of a site that
no longer changes, and belongs in git where it is diffable and backed up —
only things that change at runtime need a database.

**The database file is gitignored.** It holds submitter names and email
addresses; that must not go into a public repo.

Routes: `POST /api/submit` and `GET /style-overrides.css` are public;
everything else needs `ADMIN_TOKEN` set on the server and sent as an
`X-Admin-Token` header. With no `ADMIN_TOKEN` set, admin routes refuse every
request rather than falling open. The submit form carries a honeypot field —
anything filling it gets a cheerful 200 and is not stored.

`build.js` reads the database **if it is there** and merges approved events; if
it is absent the site still builds, which is what keeps a plain static deploy
working.

### The written guide — /guide.html

The instructions the volunteers actually follow, at `assets/guide.html`, copied
into `dist/` by the build and linked from the top of the admin page. `noindex`,
and nothing public links to it.

It is a self-contained document — its own inline CSS and its own light/dark
palette, unlike the rest of the site, which is light only. That is deliberate:
it is a thing to be read rather than a page of the site, and it may well be read
late at night on a phone.

If the tools change, change this too. A guide describing buttons that are no
longer there is worse than no guide.

### The volunteer tools — /admin.html

Not linked from the public nav, and `noindex`. Sign in with the `ADMIN_TOKEN`
Render generated (service → Environment). The token is held in `sessionStorage`
for that tab, or `localStorage` if "keep me signed in" is ticked, and is never
written into the page.

Four tabs:

- **Events awaiting review** — the full submission, with anything the spam
  heuristics flagged called out. Approving rebuilds the site immediately, so the
  event is live within seconds.
- **Messages** — what the Contact form collected, with a reply-by-email link and
  a "dealt with" button.
- **Edit events** — search the archive, open an event, change whatever needs
  changing. Described in full below.
- **Style** — the design tokens, grouped as Colours / Type / Layout. Native
  `<input type="color">` swatches beside a text field, following the reference
  panel in `The-Lemmon-Dociere`; no raw HSL sliders. Typing previews live on the
  page; Save persists to the server, so it follows the volunteer between devices.

Public pages link `/style-overrides.css`, which the server renders from those
saved tokens. On a purely static deploy that 404s harmlessly and the defaults
stand.

**This admin page is the only part of the site that needs JavaScript.** It is a
tool being operated rather than a page being read, so the CSS-first rule does
not fit it — but it should eventually be unified with the shared 🎨 Style panel
rather than staying a second implementation.

### Deploying it

`render.yaml` declares **one web service** (`runtime: node`) with a **persistent
disk** at `/var/data`, and `DB_PATH` pointing into it. `ADMIN_TOKEN` is
generated by Render — read it from the service's Environment tab; it is never
in this file or in git.

Render rejects a `headers:` block on anything but a static site, so the cache
and security headers are set in `server.js` instead (verified on live
responses: nosniff, referrer-policy, frame-options, and a one-year immutable
cache on /media/*).

A disk requires a **paid** instance type. That is the whole reason this is not
on the free tier: without a disk, SQLite is wiped on every deploy and every
submission is lost.

**Render warns "Scaling is not supported for servers with disks". Keep the disk
— do not delete it.** The warning only means the service cannot run as multiple
instances, which this site neither needs nor wants: each instance would have its
own `dist/`, so approving an event would rebuild the pages on one copy and leave
the others stale, and a visitor would see the new event or not depending which
they hit. A single instance is the correct shape for this design, not a
compromise. Asked and answered 2026-08-22.

**The catch that shapes this design:** Render mounts the disk at *run* time, not
during the build, so the deploy-time build cannot see the database and an
approved event would never reach a page. The server therefore rebuilds itself —
at start-up if there are approved events, and again whenever one is approved.
`build.js --skip-media` leaves the 952 copied images alone, which takes the
rebuild from ~9.6s to ~6s. Rebuilds are serialised, and a request arriving
mid-build queues exactly one more instead of piling up.

`test-deploy.mjs` rehearses all of that locally: it puts an approved row in a
database the build never saw, starts the server the way Render will, and checks
the event reaches both its own page and its month of the calendar.

To go back to the free static tier, the previous blueprint is in git history:
`runtime: static` with `staticPublishPath: ./dist` and no disk. The public
pages work perfectly that way; there is simply nowhere to put a submission.

### The options that were considered

The current `render.yaml` is a **static site**: free, always on, no server. That
cannot serve the API. The options, with the catch on each:

1. **Static site + a separate web service for submissions/admin.** Public pages
   stay free and fast. But Render's free web services sleep after inactivity and
   have **no persistent disk**, so a SQLite file is wiped on redeploy — usable
   for testing, not for real submissions.
2. **One web service serving everything, with a Render persistent disk.** Simple
   and correct, and the disk is a **paid** add-on. Still likely far cheaper than
   the EventON licences.
3. **Static site, with the admin service committing back to git.** Approved
   events and style tokens get written into the repo, which triggers a rebuild.
   Keeps everything free, but is the most moving parts.

Option 2 was chosen on 2026-08-22 at the owner's request. The blueprint is
configured for it; creating the service and confirming the charge is theirs to
do in Render.

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

## Editing events

The site is built from `data/events.json`, which is the export of a WordPress
site that no longer changes. That file is the record, it lives in git, and
`scrape.js` can regenerate it. So an edit must never be written back into it.

**Edits are overrides.** `event_edits` holds one row per event, a JSON patch of
just the fields somebody actually changed. `build.js` lays each patch over its
event on the way to `dist/` and never touches the export. That buys three
things worth keeping:

- Undo is deleting a row. Nothing is lost and nothing has to be re-scraped.
- A field nobody touched still follows the source, so a later re-scrape
  improves it rather than being overwritten by a stale copy.
- `data/events.json` stays diffable. A test asserts it comes out byte for byte
  unchanged after a full edit/save/hide/revert loop.

The editable fields are the `EDITABLE_FIELDS` list in `db.js`; anything else in
a request is dropped silently rather than rejected. `validateEventPatch()`
enforces the length limits, checks the dates parse and run forwards, checks the
colour is a hex value, and checks links look like links. `applyEventPatch()`
does the laying-on, including the nested shapes — `locationName` becomes
`location.name`, and clearing a venue name nulls the whole location.

**`hidden`** takes an event off the site without deleting anything: `build.js`
filters it out, its page and its calendar chip go, and unticking the box brings
it all back.

**Slugs never change.** An edited title does not move the page, so links people
already have keep working.

**A description typed as prose stays prose.** Descriptions are WordPress HTML
and go back onto the page as HTML, so a tagless one is escaped and its
blank-line blocks wrapped in `<p>` — an ampersand somebody types cannot become
markup, and nobody has to write tags.

**The form sends only what differs.** Every box is pre-filled with the current
value, so a naive save would freeze all fifteen fields as overrides. Each input
carries `data-orig` and the save compares against it; emptying a box that had
something in it clears that field, and a box left alone is not sent at all.

Routes (all admin):

```
GET    /api/events?q=      search the archive, 60 results, newest first
GET    /api/events/:id     the merged event, its patch, and the untouched original
PUT    /api/events/:id     save a patch, then rebuild
DELETE /api/events/:id     drop the patch, then rebuild
```

`test-edits.mjs` walks the whole loop against a real server: 27 checks.

## Maps

The map on the page is Google's, and it is built in three layers. Each layer is
a working map on its own, which is the whole point of the arrangement.

**Underneath: static OpenStreetMap tiles.** `tiles.js` mirrors them to
`media/tiles/` and `mapPanel()` composes a 3x3 grid with the venue centred
under a pin. They come from our own domain, need no key and no script, and
paint immediately — so there is a map on the page before anything third-party
has been asked for, and still a map if the frame is blocked or never arrives.
(If Google answers with an *error* page, that error is what shows; the tiles
cover the loading gap and outright blocking, not a bad key.)

**Over them: a Maps Embed iframe.** Present only when `GOOGLE_MAPS_KEY` was set
at build time. Once it paints it covers the tiles and takes the interaction, so
the map pans and zooms in place. Google draws its own marker, venue name and
attribution, so ours are hidden under `.has-live` rather than sitting on top of
its controls.

**Above both: the "Larger map" button.** An iframe swallows clicks, so the way
to a bigger view has to sit above it and be only as large as itself. It opens a
panel holding the same embed at `--mapbox-width`.

**Inside a detail panel the iframe carries `data-src`, not `src`.** A panel is
`display:none` until opened and an iframe with a `src` loads anyway — that would
be a request to Google for every event on a page nobody opened. The script fills
it in when the panel opens, and the larger map's frame likewise only gets its
`src` at the moment it opens, and loses it on close so the map stops.

Order of fallback, worst case first: no key -> tiles, and the click opens Google
Maps in a new tab. No JavaScript -> same, and event pages still carry their map
directly. Google unreachable -> the tiles are still the map. Nothing here leaves
a visitor with a grey box.

### The key

```bash
GOOGLE_MAPS_KEY=...    # Render -> service -> Environment
```

It is the **Maps Embed API** key, not the Maps JavaScript one — the embed is the
free product and needs no script of Google's on the page.

**The key is public once the page ships.** That is unavoidable for any map
embed and is not the thing to worry about; the restriction is. In the Google
console it must be limited by HTTP referrer to `earlymusicsa.org/*` and
`www.earlymusicsa.org/*`, and by API to the Maps Embed API alone. Restricting
it is what protects it, not hiding it. Do not put it in the repo.

The embed URL asks for the venue by name and address so Google shows its place
card, but pins `center` to the coordinates EventON geocoded, which are the
authoritative ones.

**A build says which mode it is in** — "1660 maps, all clickable" versus
"...1660 of them zoomable on the page" — and warns if an embed URL was built
without a key, or a map was built without an embed when a key was set.

### While in here: Escape

Closing a panel used to be `history.replaceState`, which tidies the URL but
**does not recompute `:target`** — so Escape appeared to do nothing. The hash
has to be cleared first, then the URL tidied. If you touch that handler, test it
by pressing Escape, not by reading the URL.

### The banner wash

The wash over the header photo is `.site-banner::after`, absolutely positioned
with `inset: 0`. At <=782px the banner switches out of `position: fixed` so it
can grow with the open menu — and it must become **`relative`, not `static`**.
Static leaves the wash with no positioned ancestor, so it resolves against the
initial containing block and sizes itself to the *viewport*: a dark film over
the whole first screenful, ending in a hard edge partway down the page. It
looked fine on desktop, where the banner is `fixed` and therefore positioned.

If you touch the banner's `position` at any breakpoint, check the wash's height
equals the banner's, at 375px and 768px, with the menu both shut and open.

## The DNS notes

Measured 2026-09-18 against 1.1.1.1. **The web moved to Render; the mail did
not.** Two different machines now answer for this domain, and confusing them is
how the group's email breaks.

| Name | Points at | Runs |
|---|---|---|
| `earlymusicsa.org` (A) | `216.24.57.1` | Render — the static site, **web only** |
| `www` (CNAME) | `earlymusicsa.org` | as above |
| MX, priority 10 | `mail.earlymusicsa.org` | — |
| `mail` / `webmail` / `autodiscover` / `cpanel` (A) | `162.241.253.117` | Bluehost cPanel — **all the mail** |

SPF is `v=spf1 ip4:162.241.253.117 a mx include:websitewelcome.com ~all`. The
`a` term now authorises Render's IP as a sender, which is harmless but no longer
means anything; leave it alone regardless — **this zone carries the group's real
mail and is not to be experimented with.**

### The full zone, as Cloudflare's import actually read it on 2026-09-24

Insurance. If the Bluehost zone stops answering before it is copied, this is the
record. First measured against 1.1.1.1 on 2026-09-18, then **corrected on
2026-09-24 against Cloudflare's own import, which found 18 records — four more
than were measured by hand.** The four are marked new below; the scan missed
nothing, so the earlier worry about it dropping `autoconfig` and `webdisk` did not
materialise.

| Type | Name | Value | Cloudflare proxy |
|---|---|---|---|
| A | `earlymusicsa.org` | `216.24.57.1` (Render) | DNS only |
| CNAME | `www` | `earlymusicsa.org` | DNS only |
| MX | `earlymusicsa.org` | `mail.earlymusicsa.org`, priority 10 | n/a |
| A | `mail` | `162.241.253.117` | **DNS only** |
| A | `webmail` | `162.241.253.117` | **DNS only** |
| A | `autodiscover` | `162.241.253.117` | **DNS only** |
| A | `autoconfig` | `162.241.253.117` | **DNS only** |
| CNAME | `imap` | `mail.earlymusicsa.org` | **DNS only** — new |
| CNAME | `pop` | `mail.earlymusicsa.org` | **DNS only** — new |
| CNAME | `smtp` | `mail.earlymusicsa.org` | **DNS only** — new |
| A | `cpanel` | `162.241.253.117` | DNS only |
| A | `whm` | `162.241.253.117` | DNS only — new |
| A | `webdisk` | `162.241.253.117` | DNS only |
| A | `ftp` | `162.241.253.117` | DNS only |
| A | `localhost` | `127.0.0.1` | n/a — cPanel litter, harmless |
| SRV | `_autodiscover._tcp` | `0 0 443 cpanelemaildiscovery.cpanel.net` | n/a — new |
| TXT | `earlymusicsa.org` | `v=spf1 ip4:162.241.253.117 a mx include:websitewelcome.com ~all` | n/a |
| TXT | `default._domainkey` | `v=DKIM1; k=rsa; p=MIIBIjANBgkq…` (Bluehost's signing key, ~400 chars) | n/a |

**The three mail CNAMEs are the important find.** `imap`, `pop` and `smtp` all
point at `mail.earlymusicsa.org`, and they arrive from the importer **proxied**.
Any client configured against `imap.earlymusicsa.org` or `smtp.earlymusicsa.org`
breaks exactly as one pointed at a proxied `mail` would — and because these names
were never in the hand-measured table, they are easy to leave orange. They are
also worth checking against Leslie's settings screenshot: her client may well be
using one of them rather than `mail.` itself.

There is **no `_dmarc` record**. Nothing depends on that today; worth adding
once mail is settled on Purelymail, not before.

The DKIM value is long and is the one most likely to be corrupted by a
copy-paste that inserts a line break or drops the trailing `;`. If outgoing mail
starts failing authentication after the move, check that record character by
character first.

**Confirmed 2026-09-24: the import carried it across intact.** Cloudflare split it
into two adjacent quoted strings, which is normal for a TXT value over 255 bytes
and resolves as one concatenated string — not corruption, and not to be "fixed"
into a single quoted run. It opens `v=DKIM1; k=rsa; p=MII…` and closes
`…IDAQAB;` with the trailing semicolon present. This key is Bluehost's and gets
deleted at step 9 regardless, so it needs no further care.

### Turn the orange cloud off for anything to do with mail

The way this migration usually breaks. Cloudflare's importer defaults new `A`
records to **proxied**, and Cloudflare proxies HTTP and HTTPS only. A proxied
`mail` record answers with Cloudflare's own addresses, so IMAP, POP3 and SMTP
stop dead — while the dashboard looks entirely correct.

The complete list that must be **grey cloud, DNS only** — thirteen rows, every
proxied record the 2026-09-24 import produced:

```
A      mail  webmail  autodiscover  autoconfig  cpanel  whm  webdisk  ftp
CNAME  imap  pop  smtp  www
A      earlymusicsa.org   (the apex)
```

The apex and `www` belong on that list during the cutover too, so that what is
being tested is the real thing rather than Cloudflare's cache. When it is done,
nothing in the zone reads "Proxied".

`localhost`, the `MX`, the `SRV` and both `TXT` records arrive as DNS only already
and need no attention.

### The trap this sets

cPanel hosts hand out `earlymusicsa.org` as the incoming/outgoing server name,
and that used to be the same box as the mail. Since the cutover it is Render,
which answers on 80/443 and **nothing else** — 993, 995, 143, 110, 587 and 465
are all dead there. Any mail client still configured with the bare domain stops
collecting mail the day DNS moves, silently, with the mailbox itself untouched.

The mailbox is fine; only the address the client dials is wrong. Correct it to:

```
Incoming   mail.earlymusicsa.org   993 IMAP / 995 POP3, SSL-TLS
Outgoing   mail.earlymusicsa.org   465 SSL-TLS  (or 587 STARTTLS)
Username   the whole address, not the part before the @
```

Never port 25 — it is filtered on that host.

### Webmail is at :2096, and only at :2096

Webmail bypasses the mail client entirely, which makes it the quickest way to
prove a mailbox is healthy — but reach it on the cPanel port:

```
https://mail.earlymusicsa.org:2096      webmail   — 200, Roundcube login
https://mail.earlymusicsa.org:2083      cPanel    — 200
https://webmail.earlymusicsa.org        500 Internal Server Error, from nginx
```

Measured 2026-09-18. The `webmail.` subdomain on 443 goes through Bluehost's
nginx and the leftover WordPress vhost, which now answers **500** — and that
error page names `earlymusicsa-org.qtz.bhi.mybluehost.me` and invites you to
write to the server administrator, so it reads like a mail failure. It is not
one. Port 2096 is cpsrvd and skips that stack entirely: it serves the
cPanel/Roundcube login and sets its session cookies normally. Plain
`https://mail.earlymusicsa.org/` is no use either — that vhost only redirects to
`www`, which is Render now.

**So a 500 at `webmail.earlymusicsa.org` says nothing about the mail.** Retest on
:2096 before concluding anything.

**Confirmed 2026-09-21: Leslie logs into :2096 fine.** So the mailbox, the
password and the whole mail stack are healthy, and the original "email is not
downloading" complaint was only ever her client pointed at the bare domain — which
is Render now and runs no mail. That closes the question; do not go looking for an
account-level fault.

**Decided 2026-09-24: do not reconfigure her client now.** The settings above
would fix it, but the mail is moving to Purelymail within weeks and the client
would then need changing a second time — two rounds of fiddly remote settings
surgery with somebody who will not enjoy either. She uses webmail on :2096 in the
meantime and the client gets set up once, at step 9, as a fresh account rather
than an edited broken one. Editing beats re-adding almost never here: macOS Mail
and Outlook grey out or silently revert the incoming hostname, while iOS Mail and
Thunderbird let it be changed.

### AutoSSL will lose the web names on renewal

The Let's Encrypt cert Dovecot presents (issued 2026-08-10, expires
**2026-11-08**) covers `earlymusicsa.org` and `www.earlymusicsa.org` alongside
`mail.`, `webmail.`, `cpanel.` and the old `earlymusicsa-org.qtz.bhi.mybluehost.me`
staging names. cPanel validates those over HTTP, and the two web names no longer
resolve to that box, so AutoSSL will fail for them and reissue without them.
The `mail.` name still resolves there and should survive — but check webmail
still loads clean shortly after 2026-11-08, because if the renewal fails
outright every mail client starts throwing certificate warnings at once.

## Leaving Bluehost — the runbook

Decided 2026-09-18: the Bluehost account is not being renewed. The site is
already on Render. The mailbox is not, and **the zone is not either** — see the
DNS notes above.

### Progress as of 2026-09-25

Steps 1 to 5 are **done**. What remains is the mailbox and Sundance's DNS.

| | |
|---|---|
| Bluehost lapse date | another month paid 2026-09-24, so ~2026-10-24 |
| Registrar | **APlus.net**, access in hand |
| Domain renewal | paid 2026-09-24, not at risk |
| Cloudflare | **active** — `elle.ns.cloudflare.com`, `renan.ns.cloudflare.com` |
| Proxy status | all 13 records grey-clouded and verified answering real IPs |
| DNSSEC | confirmed off (no DS, no DNSKEY, checked at two resolvers) |
| HostNexus | cancelled — a fourth service nobody needed |
| Leslie | emailed 2026-09-25 for her client settings and the address list |

**Cloudflare was verified before and after the nameserver switch**, by querying
its nameservers directly: apex to Render, `mail`/`webmail` to
`162.241.253.117`, `imap`/`smtp` as CNAMEs to `mail`, MX at priority 10, SPF
intact, DKIM 411 characters ending `IDAQAB;`. No Cloudflare proxy addresses
anywhere. Both zones served identical answers through the cutover, so no mail
was at risk at any point.

**Bluehost now has exactly one job left: the earlymusicsa mailbox.** Both static
sites have left it (see the Sundance and Carolynn Heil sections below).

**Leslie's mailbox may be nearly empty.** Her working address is
`lprovence@sbcglobal.net`; the `@earlymusicsa.org` mailbox appears to have been
created around 2026-09-02, so step 7 may have almost nothing to port and the
POP3-versus-IMAP question may not matter. Her settings photo settles it.

**The plan: Cloudflare for DNS (free), Purelymail for the mail ($10/year).**

Purelymail prices flat per account, not per mailbox — `leslie@`, `volunteer@`
and anything else all fit in the $10. It does real IMAP, POP3 and SMTP, so
Leslie keeps the mail client she already has and still sends *as*
`leslie@earlymusicsa.org`. That last part is why a free forwarding service was
rejected: forwarding delivers her mail but makes every reply come from a Gmail
address, and she should not have to explain that to people.

Known trade, in their own words on their site: small operation, no 24/7 support,
and occasionally an obscure receiving server will block their mail for a day or
two. **If a bounce ever appears months from now, read that sentence again before
assuming the configuration is broken.**

### Order matters, and this order is not negotiable

**1. Know when the Bluehost account lapses.** The mailbox is deleted with the
account, so step 6 has to finish before that date.

**Another month was paid on 2026-09-24, so the floor is roughly 2026-10-24.**
Still to confirm: whether that is a **recurring monthly subscription** or a single
month bought outright. Recurring means there is no cliff — the mail stays alive
until somebody deliberately cancels, which is the safest arrangement available
here. A one-off month means a hard stop in late October. Check which it is before
relying on either.

> **Watch 2026-11-08 if this runs past late October.** That is when the cert
> expires (see AutoSSL above), and Leslie is living in webmail until step 9. A
> failed renewal would start throwing certificate warnings at her mid-migration,
> and she will read that as the mail breaking again. Finishing before then avoids
> the question; extending into November means warning her first.

**2. Registrar access — resolved.** Nothing below is possible without it,
**Resolved 2026-09-24: the domain is managed through APlus.net, and access is in
hand.** That confirms the whois rather than contradicting it — APlus.net is a
Hostopia brand, which is why the registrar reads **Hostopia Canada Corp**, a
wholesale registrar resold under other companies' names. This was expected to be
the step most likely to stall; it is not in the way.

The nameserver change in step 4 happens **in APlus.net's control panel, not
Bluehost's.** Bluehost's DNS screens will keep showing the old zone and offering to
edit it; that is the hosting account's copy and changing it there does nothing once
the nameservers have moved.

The domain is flagged `client transfer prohibited`. That lock blocks a *transfer*
to another registrar, not a nameserver change, so it is not in the way either — and
there is no need to transfer the domain at all here.

**The domain renewal was paid on 2026-09-24**, so the registration itself is not at
risk and nothing below is racing it. Keep the two clocks separate: the **domain** is
paid at APlus.net and safe, while the **Bluehost hosting** is a different bill on a
different schedule and is what holds the mailbox. Cancelling Bluehost at step 10
does not touch the domain.

**3. Add the zone to Cloudflare while Bluehost is still answering.** Cloudflare
imports the records by scanning the live zone. Do this *before* cancelling
anything or the import comes back empty and every record has to be retyped from
memory. Compare what it imported against the DNS notes above and fix by hand
whatever it missed.

**4. Change the nameservers at the registrar to Cloudflare's.** Wait until
Cloudflare says the zone is active. At this point **nothing has actually
moved** — the site is still on Render, the mail is still on Bluehost. Only the
machine answering DNS questions has changed. Verify the site loads and mail
still arrives before going further. This step alone removes the single point of
failure and it is safe to stop here for weeks.

**5. Open the Purelymail account and add the domain.** $10/year, flat, from
purelymail.com/signup. Adding `earlymusicsa.org` produces **seven DNS records**
on their Add New Domain page: MX, SPF, a domain-ownership TXT, three DKIM
records (they rotate between three signing keys), and DMARC. **Take them from
that page and nowhere else** — the ownership value is unique to the account and
cannot be guessed, and they say plainly they cannot add the records for you.

Because there are seven of them, **do this after the zone is on Cloudflare**, or
they get entered twice: once in Bluehost's cPanel Zone Editor and again in
Cloudflare a week later.

Add six of the seven and **leave the MX record until step 7**. Ownership, SPF and
DKIM are all safe to add early — MX is the one that moves live mail. Hold DMARC
until after the switch too: a reject policy published before SPF and DKIM are
actually in use can bounce good mail.

**6. Port the old mail across — before MX moves, not after.** This is the step
with a deadline: everything in the Bluehost mailbox dies with the account, and
Leslie's mail was not downloading, so assume no copy exists anywhere else.

Purelymail has a **mail porting tool** in the account portal that pulls over IMAP
from the old host. It works perfectly well while MX still points at Bluehost —
that is the whole point of doing it now. Point it at `mail.earlymusicsa.org`,
port 993, SSL, full address as the username. Folders and Sent come too, which a
POP3 grab would silently have left behind.

> **First confirm her client is not POP3 with delete-from-server.** The porting
> tool can only copy what is still on the server. If cPanel's default left her on
> POP3 with deletion on, years of mail exist **only on her hard drive** and the
> tool will happily port a nearly empty mailbox. In that case use Thunderbird and
> drag the local folders across instead. A screenshot of her account settings
> answers this before it matters.

Thunderbird with both accounts connected does the same job by hand if the tool
struggles, and `imapsync` does it unattended for a large mailbox.

**7. Create a User for every address, then switch MX.** Get the real list from
cPanel → Email Accounts rather than guessing; any address without a matching
User starts bouncing the moment MX moves. Watch for `volunteer@` — the site's
contact form sends as that address. Then add the MX record, send a test from an
outside account, and confirm it lands.

> **Do not add a catch-all routing rule.** Purelymail's routing rules take
> priority over real mailboxes: a `*@earlymusicsa.org` rule would match Leslie's
> address too, redirect her mail away, and leave her inbox permanently empty
> while everything appears configured correctly. If a catch-all is wanted later,
> use a Sieve filter, which can copy rather than redirect.

**8. Delete the Bluehost SPF, add Purelymail's DMARC.** The old record,
`v=spf1 ip4:162.241.253.117 a mx include:websitewelcome.com ~all`, authorises a
server the group will no longer control, and the old DKIM key at
`default._domainkey` is likewise dead. Remove both once mail is flowing.

**9. Re-point the mail clients.** Leslie's settings change one more time — this
is why she was warned:

```
Incoming   imap.purelymail.com   993   SSL/TLS
Outgoing   smtp.purelymail.com   465   SSL/TLS   (or 587 STARTTLS)
Username   the full address
```

If two-factor authentication is switched on for the account, mail clients need an
**App Password**, not the account password. That applies to the contact form too.

**10. Only now, cancel Bluehost.** Leave several days after step 7 and watch that
mail keeps arriving across the gap.

### The Purelymail records, as issued 2026-09-25

Account exists; domain added. These came from Purelymail's Add New Domain page.
`@` means the bare domain.

| Type | Name | Value | When |
|---|---|---|---|
| TXT | `@` | `purelymail_ownership_proof=e81e0e20cc543da7dddfad6d3c2632121c3020ddde7fe973ad0ee490ccc0874a8a2e80a669f9f957a005ed043cdc4b14fa774d45a58b6c98b375bb4a6a6c552f` | now — verifies the domain |
| CNAME | `purelymail1._domainkey` | `key1.dkimroot.purelymail.com` | any time, harmless |
| CNAME | `purelymail2._domainkey` | `key2.dkimroot.purelymail.com` | any time, harmless |
| CNAME | `purelymail3._domainkey` | `key3.dkimroot.purelymail.com` | any time, harmless |
| MX | `@` | `mailserver.purelymail.com`, priority 10 | **the switch** — edit the existing MX, never add a second |
| TXT (SPF) | `@` | merge, see below | with the MX switch |
| CNAME | `_dmarc` | `dmarcroot.purelymail.com` | after mail is confirmed flowing |
| CNAME | `autoconfig` | `autoconfig.purelymail.com` | after the switch — replaces the Bluehost A record |
| SRV | `_autodiscover._tcp` | `0 0 443 autodiscover.purelymail.com` | after the switch — replaces the cPanel SRV |

**2026-09-25: the MX was switched early and reverted.** It pointed at
`mailserver.purelymail.com` for a short window before the ownership TXT was in
place, so Purelymail had not verified the domain and was likely refusing mail.
It was set back to `mail.earlymusicsa.org` and confirmed live at Cloudflare,
1.1.1.1 and 8.8.8.8. If Leslie reports a bounce from that night, this is why —
the sender needs to resend. **Order next time: ownership TXT → Check DNS records
→ create users → only then the MX.**

**One SPF record only.** Adding Purelymail's as a second TXT breaks SPF for both.
During the changeover, edit the existing one to authorise both senders:

```
v=spf1 ip4:162.241.253.117 a mx include:websitewelcome.com include:_spf.purelymail.com ~all
```

Once Bluehost is cancelled, cut it to `v=spf1 include:_spf.purelymail.com ~all`.

**Before the MX switch:** create a Purelymail user for every address (at least
`leslie@` and `volunteer@`), and tell Leslie that new mail will stop appearing in
the `:2096` webmail and arrive in Purelymail's webmail instead. Her old mail stays
on Bluehost, reachable for porting, until the account is cancelled.

**Blocked on the Claude side as of 2026-09-25:** `api.cloudflare.com` is denied by
the environment's network policy and no `CLOUDFLARE_API_TOKEN` is set. With both
added to the *EarlyMusicSa email* environment (and a fresh session), every
Cloudflare row above can be done by Claude directly.

### The contact form keeps working

This is the quiet win of paying for real mail hosting. `mailer.js` sends the
submission and contact notifications over SMTP as
`volunteer@earlymusicsa.org` — a real mailbox before, and a real mailbox after.
No code change and no new mechanism: point the four environment variables in
Render's dashboard at Purelymail instead. If the account has two-factor
authentication on, SMTP_PASS must be an App Password, not the account password.

```bash
SMTP_HOST=smtp.purelymail.com
SMTP_PORT=587          # STARTTLS; 465 for TLS from the first byte
SMTP_USER=volunteer@earlymusicsa.org
SMTP_PASS=<set in Render's environment settings — never committed>
MAIL_FROM=volunteer@earlymusicsa.org
```

`MAIL_FROM` must stay an address Purelymail is allowed to send as, or the mail
is dropped as a forgery. Create that User in Purelymail even if nobody reads it.

If the switchover leaves a gap, nothing breaks: with any SMTP variable missing
`mailConfigured()` is false, notifications stop, and the queue on /admin.html is
still the record. That is by design.

### sundancefirearms.com is moving to Render

It sits on the same Bluehost account and its zone is delegated to the same
nameservers, so **step 3 and step 4 have to be done for it as well** or the
domain resolves to nothing.

**Live on Render as of 2026-09-25: https://sundancefirearms.onrender.com**
The site was pulled out of cPanel (`public_html/website_ecdc3156`) and lives at
**`aloysiusb/sundancefirearms`** (public, `main`), deployed as a Render
static site — plain HTML, CSS, jQuery and images, no PHP, no WordPress, no
database, so no build step. All 21 local asset references in `index.html` were
checked and resolve on a case-sensitive filesystem, so the mixed-case filenames
(`AR-15-1.jpg`) will not break the move.

Three things were dropped from the capture, all orphaned from `index.html`:

- **`vp/`** — an entirely unrelated site, "Paintings and Jewelry Examples for
  Virginia Payson", that was being served under `sundancefirearms.com`. Nothing
  linked to it and the ~20 images it referenced were not on the server, so it
  had been broken for some time. The two HTML files are still in the cPanel
  capture if anyone ever wants them; they are useless without the images.
- The WOWSlider demo pages (`wowslider.html`, `-howto`, `-iframe`).
- `images/mandala-sundance-firearms.psd`, a Photoshop source on a public server.

**It may have mail after all — check before cancelling.** The note here used to
say it needs no mail of its own, on the strength of the site publishing a Gmail
address (`sundancefirearmsllc@gmail.com`). That is still what the site shows, but
the zone tells a different story, measured 2026-09-24:

| Type | Value |
|---|---|
| NS | `ns1.bluehost.com`, `ns2.bluehost.com` |
| A | `162.241.253.117` — the same cPanel box as the mail |
| MX | `0 mail.sundancefirearms.com`, `10 sundancefirearms.com` |
| TXT | `v=spf1 ip4:162.241.253.117 a mx include:websitewelcome.com ~all` |

Someone configured mail for this domain. It may be nothing but a cPanel default,
but **look in cPanel → Email Accounts filtered to `sundancefirearms.com` before
the account is cancelled.** A real mailbox there dies with Bluehost exactly as
Leslie's would.

**Three deploys failed before it worked, for one reason.** The Render service
had `publishPath` set to `build` while the site sat at the repo root, so every
deploy reported "the GitHub repository is empty". Service type, branch and build
command were all correct from the start; only that one field was wrong. The site
now lives in `build/` to match it. If the service is ever recreated, set the
publish directory to `.` and keep the files at the root instead.

**The registrar is unknown.** Nameservers say Bluehost answers DNS, which does not
say who the name is registered with — Bluehost resells, and GoDaddy was the other
guess. Settle it at `lookup.icann.org` and write the answer here; the nameserver
change in step 4 happens wherever that turns out to be.

### carolynnheilinteriors — also off Bluehost

**Live on Render as of 2026-09-25: https://carolynn-heil.onrender.com**

The third site on that cPanel account (`public_html/website_c0f50c30`), recovered
the same night and pushed to **`aloysiusb/CarolynnHeil`** (`main`). Plain HTML and
images, no build step. Kept as portfolio work rather than as a client's live
site — the designer and the client are no longer in contact, so nothing here is
waiting on her.

**The homepage was nearly the wrong file.** The archive held three candidates:
`index.html` (a Coming Soon placeholder), `index_bk.html`, and `CH-index` with no
extension. The last two are the same page apart from one line — `index_bk.html`
carries `<meta name="robots" content="noindex, nofollow">`, which marks it as the
staging copy. `CH-index` was the intended production homepage and is now
`index.html`; the placeholder is kept as `coming-soon.html`.

**Two pages referenced across the site do not exist:** `about.html` (linked from
every page) and `golden-section-palette.html` (footer). Their links are commented
out rather than deleted — restoring them is a matter of removing the comment
markers.

**Two carousel images on the Hallam Residence page were broken and are fixed.**
`HalWilliams2017-0741_2.jpg` was referenced with an underscore where the file uses
a dot; `HalWilliams2017-0748.jpg` ("Guest Bath") is not in the archive at all and
its entry was removed. `HalWilliams2017-0684.jpg` was unused and is another view
of the primary bedroom, so it now fills the gap — its caption was written from the
photograph and is the only copy on the site not by the original author.

`settings.html` is a colour picker that drives the palette across every page. It
was reachable only by typing the URL and is now linked from the footer,
deliberately kept.

**Every page carries `noindex`,** and `robots.txt` serves `Disallow: /`. The site
is reachable by link and stays out of search results, which is what portfolio work
of somebody else's business should do.

## Telling somebody

Submissions and contact messages land in the database and wait. That only works
if a volunteer remembers to look, which is a poor thing to rely on — a concert
submitted in good time can sit unseen until its date has passed. `mailer.js`
sends a short note the moment something arrives.

```bash
SMTP_HOST=mail.example.com
SMTP_PORT=587          # STARTTLS; 465 for TLS from the first byte
SMTP_USER=volunteer@earlymusicsa.org
SMTP_PASS=...
MAIL_FROM=volunteer@earlymusicsa.org
MAIL_TO=one@example.org, two@example.org    # comma-separated, one RCPT each
```

**Optional by design.** With any of those missing, `mailConfigured()` is false,
nothing is sent, and the site behaves exactly as it did before. The queue on
/admin.html is still the record; email is a convenience laid on top of it. The
server says which state it is in at boot.

**SMTP rather than a provider's HTTP API.** SMTP is universal, so this works
with the mailbox that already exists on the domain: no new account, no API key,
and no DNS records to add next to the ones carrying the group's real mail
(see the DNS notes — that zone is not to be experimented with). Any sending
service speaks SMTP too, so switching is four variables, not a rewrite.

### Two things that must stay true

**A failure must never reach the visitor.** `notify()` is fire-and-forget: it
never throws and never delays the response. Whatever prompted it is already
stored by the time it runs, so a mail server that is down, slow, or holding a
mistyped password costs a log line and nothing else. There is a test that
submits a form against a dead mail host and asserts a 201 comes back
immediately.

**The password only crosses TLS.** On 587 the client insists STARTTLS is
offered, upgrades, and starts the conversation again on the encrypted socket;
on 465 it is encrypted from the first byte. The single exception is a host on
loopback, which is how `test-mail.mjs` holds a real SMTP conversation with a
fake server — nothing leaves the machine, so there is nothing to protect. That
exception is deliberately keyed to the address rather than a flag, so there is
no setting anybody could switch on against a real server.

### The client

Hand-written, since the project takes no dependencies. Worth knowing if you
touch it: a reply can run to several lines and ends at the first line with a
*space* after the code, not a hyphen; AUTH PLAIN is used when the server offers
it and AUTH LOGIN otherwise; each recipient needs its own RCPT TO; a body line
starting with a dot must be doubled or the message ends early there; and a
non-ASCII subject needs RFC 2047 or it arrives as mojibake. All five have tests,
against a fake server that speaks both AUTH dialects and can be told to refuse.

## Spam, and why there is no CAPTCHA

Three layers, none of which asks a visitor to prove anything.

**A honeypot** on both forms — a field no person sees. Anything filling it gets
a cheerful 200 and is stored nowhere, so a bot learns nothing from the reply.
It is answered *before* the rate limiter for the same reason.

**Heuristics** in , matched against the fake-conference spam that
was already reaching the old site. They only ever *flag*; they never reject. A
flagged submission is called out in the queue and in the notification email,
because a real concert can trip them.

**Moderation** is the actual defence. Nothing reaches the site without a
volunteer approving it, so spam that gets through costs ten seconds.

A CAPTCHA was considered and rejected. It taxes the genuine submitter — an
elderly concert organiser listing a recital is precisely the person who gets
stuck on one — and it buys little when nothing publishes unreviewed.

### The cap

What that left open was volume, which  closes: 10 submissions an
hour and 30 a day per visitor, 5 and 15 for the contact form. Generous, because
a venue listing a whole season in one sitting is a real thing; the daily figure
is what actually stops a flood.

Three things to keep true if you touch it:

- **A refused request must not be counted.** Otherwise somebody hammering the
  form keeps pushing their own window forward and is locked out for ever.
- **The visitor is identified by , else the *rightmost*
   entry** — that list is one a caller can prepend to, so the
  leftmost value is whatever they claimed. Taking the left one would let anybody
  lock anybody else out.
- **A refusal explains itself.** Somebody who has genuinely filled in several
  events gets a real message saying when to come back and that nothing was lost,
  not a bare 429.

Counting is in memory, so a restart forgets it. That is deliberate: this exists
to stop a flood, not to keep a ledger.

## Conventions

Per the global rules: CSS-first styling, never JS-computed. **Every value the
design depends on is a custom property on `:root`** — the planned style-editing
page should write only those properties, never rules. That page should reuse the
shared 🎨 Style panel from `The-Lemmon-Dociere` rather than a bespoke one, and
persist server-side (Express + `node:sqlite`), not to `localStorage`.

Two constants in `build.js` deliberately mirror CSS values and must be kept in
step: `THUMB` (matches `--thumb-size`) and the `sizes` attribute it feeds.
`sizes` is parsed by the HTML parser, so it cannot use `var()`.
