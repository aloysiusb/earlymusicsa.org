#!/usr/bin/env node
/**
 * build.js — turn data/events.json into a static site in dist/.
 *
 * Currently focused on the home page, which is being matched to the live
 * WordPress site's appearance before the rest of the pages are styled.
 *
 *   node build.js          # everything
 *   node build.js --home   # just the home page (fast, for styling work)
 */

import { mkdir, readFile, writeFile, copyFile, cp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tilePlan, tileFile, TILE, TILE_DIR } from './tiles.js';

const OUT = 'dist';
const SITE_NAME = 'Early Music San Antonio';
const TAGLINE = 'The audience-based information site for San Antonio’s Early Music scene';
const TZ = 'America/Chicago';
const HOME_ONLY = process.argv.includes('--home');

/**
 * Skip re-copying the 952 mirrored images when they are already in place.
 * Used for the rebuild that runs after a submission is approved — the pages
 * change, the images do not, and copying 47 MB again would be most of the work.
 */
const SKIP_MEDIA = process.argv.includes('--skip-media');

/** How many events the home page lists before "Show More Events". */
const HOME_LIMIT = 3;

/**
 * The live EventON card shows only title, image, date and time — venue and
 * blurb appear once the card is opened. Flip this on to surface them in the
 * collapsed card instead.
 */
const CARD_DETAILS = false;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const LOGO = 'Early-Music-SA-Logo-wt.png';

/** Event thumbnail box, in CSS pixels. Keep in step with --thumb-size. */
const THUMB = 140;

/** Past-events tile box. Keep in step with --tile-height and the column count. */
const TILE_W = 357;
const TILE_H = 436;

/* ------------------------------------------------------------------ util -- */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const ALLOWED = /^<\/?(p|br|em|strong|i|b|ul|ol|li|a|h3|h4|blockquote)(\s[^>]*)?>$/i;
function sanitize(html) {
  return String(html || '').replace(/<[^>]+>/g, (tag) => {
    if (!ALLOWED.test(tag)) return '';
    if (/^<a\s/i.test(tag)) {
      const href = tag.match(/href=["']([^"']*)["']/i)?.[1] || '';
      if (!/^https?:\/\//i.test(href)) return '';
      return `<a href="${esc(href)}" rel="noopener nofollow">`;
    }
    return tag.replace(/\s[^>]*/, '');
  });
}

/** First N characters of the description, cut on a word boundary. */
function excerpt(text, max = 150) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, s.lastIndexOf(' ', max)) + '…';
}

/* ----------------------------------------------------------------- images -- */

/** scrape.js mirrors uploads under media/ using this filename transform. */
const mediaName = (url) =>
  decodeURIComponent(String(url).split('/').pop()).replace(/[^\w.\-]/g, '_');

const mirrored = (url) => url && existsSync(path.join('media', mediaName(url)));

function localImage(url, depth) {
  if (!url) return '';
  return mirrored(url) ? `${'../'.repeat(depth)}media/${mediaName(url)}` : url;
}

/**
 * Build a responsive <img>. WordPress had already generated resized copies of
 * every upload and scrape.js mirrored them, so the browser gets a real srcset
 * and downloads a 300px file for a 140px slot instead of a 1400px original.
 */
function responsiveImg(ev, { sizes, depth, className = '', cover = null, eager = false }) {
  if (!ev.image) return '';
  const variants = (ev.imageVariants || []).filter((v) => mirrored(v.url));
  const src = localImage(ev.image, depth);

  // Most of these uploads are wide banners — 1400x400 is typical. When one is
  // cropped to `cover` a box that is squarer or taller than it, the file has to
  // be wide enough to cover the box's *height*, not its width. Asking for the
  // box width alone picks a 400x127 file for a 436px-tall tile and stretches it
  // four times over.
  if (cover && ev.imageWidth && ev.imageHeight) {
    const [boxW, boxH] = cover;
    sizes = `${Math.round(Math.max(boxW, boxH * (ev.imageWidth / ev.imageHeight)))}px`;
  }
  const srcset = variants.length
    ? ` srcset="${variants.map((v) => `${localImage(v.url, depth)} ${v.width}w`).join(', ')}"`
    : '';
  // For a square crop the intrinsic ratio would fight object-fit, so only
  // publish real dimensions when the image is shown at its own aspect ratio.
  const dims = !cover && ev.imageWidth
    ? ` width="${ev.imageWidth}" height="${ev.imageHeight}"` : '';
  // Above-the-fold images load eagerly and get fetch priority; everything
  // further down the page waits until it is needed.
  const load = eager
    ? ' fetchpriority="high" decoding="async"'
    : ' loading="lazy" decoding="async"';
  return `<img src="${esc(src)}"${srcset} sizes="${esc(sizes)}"`
    + ` alt="${esc(ev.imageAlt || '')}"${load}`
    + `${dims}${className ? ` class="${className}"` : ''}>`;
}

/* ------------------------------------------------------------------ dates -- */

function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return {
    year: +y, month: +mo, day: +d, hour: +h, minute: +mi,
    ymd: `${y}-${mo}-${d}`,
    weekday: new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay(),
  };
}

function formatTime(p) {
  if (!p) return '';
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

function timeRange(ev) {
  const s = parts(ev.start), e = parts(ev.end);
  if (!s) return 'Date to be announced';
  if (ev.allDay) return 'All day';
  // EventON writes 23:59 to mean "no end time was given".
  if (!e || (e.hour === 23 && e.minute === 59)) return formatTime(s);
  return `${formatTime(s)} - ${formatTime(e)}`;
}

const longDate = (p) => p
  ? `${DOW[p.weekday]}, ${MONTHS[p.month - 1]} ${p.day}, ${p.year}`
  : 'Date to be announced';

/**
 * Each event carries its own card colour, which rides in as a custom property
 * so it is a local override of the same token the rest of the design uses.
 *
 * The text stays white. EventON's clrW/clrD classes only choose a text colour
 * when the calendar runs in `etttc_auto` mode; this site runs `etttc_custom`,
 * which pins every card's text to white regardless. `textTone` is still
 * exported in the data — set CARD_TEXT_AUTO to honour it and get dark text on
 * the pale cards, at the cost of not matching the live site.
 */
const CARD_TEXT_AUTO = false;

function cardVars(ev) {
  const bits = [];
  if (ev.color) bits.push(`--card-bg:${ev.color}`);
  if (CARD_TEXT_AUTO && ev.textTone === 'dark') bits.push('--card-text:var(--card-text-dark)');
  return bits.length ? ` style="${bits.join(';')}"` : '';
}

/** "(GMT-05:00)", read off the stored offset so it follows daylight saving. */
function tzLabel(iso) {
  const m = /([+-]\d{2}:\d{2})$/.exec(iso || '');
  return m ? `(GMT${m[1]})` : '';
}

/* ------------------------------------------------------------------ shell -- */

const NAV = [
  ['', 'Home'],
  ['about.html', 'About'],
  ['archive/', 'Past Events'],
  ['submit.html', 'Submit Event'],
  ['calendar/', 'Calendar'],
  ['contact.html', 'Contact Us'],
];

function page({ title, current = '', depth = 0, head = '', body }) {
  const root = depth ? '../'.repeat(depth) : '';
  const nav = NAV.map(([href, label]) => {
    const to = href === '' ? root || './' : root + href;
    return `<li><a href="${esc(to)}"${href === current ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`;
  }).join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} &ndash; ${esc(SITE_NAME)}</title>
<meta name="description" content="${esc(TAGLINE)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;500;700;800&display=swap">
<link rel="stylesheet" href="${esc(root)}style.css">
<!-- Design tokens saved from the style editor. Served by the server; harmless
     404 on a purely static deploy, where the defaults simply stand. -->
<link rel="stylesheet" href="/style-overrides.css">
${head}</head>
<body>

<header class="site-banner">
  <div class="container header-inner">
    <a class="site-logo" href="${esc(root || './')}">
      <img src="${esc(root)}media/${LOGO}" alt="${esc(SITE_NAME)}" width="205" height="150">
    </a>
    <input type="checkbox" id="nav-toggle" class="nav-toggle">
    <label for="nav-toggle" class="nav-toggle-label" aria-label="Menu"><span></span></label>
    <nav class="main-nav" aria-label="Main">
      <ul>
        ${nav}
      </ul>
    </nav>
  </div>
</header>

<main class="site-main">
${body}
</main>

<script>
/* The detail panel opens, closes and locks page scrolling entirely in CSS,
   through :target and :has(). Two things CSS cannot do are handled here.
 *
 * The map tiles inside a panel carry data-src rather than src. A panel starts
 * display:none, and an image in a display:none container is never fetched —
 * loading="lazy" does not help, it simply never fires. So the tiles are filled
 * in when their panel opens. A year page holds a dozen panels; loading every
 * map up front would be a couple of megabytes nobody asked for.
 *
 * With JavaScript off there is no map in the panel, but the event's own page
 * carries the same map with a plain src, so the information is never lost. */
function showMaps() {
  var open = document.querySelector('.event-modal:target');
  if (!open) return;
  open.querySelectorAll('[data-src]').forEach(function (el) {
    el.src = el.getAttribute('data-src');
    el.removeAttribute('data-src');
  });
}
addEventListener('hashchange', showMaps);
// :target does not resolve while the document is still parsing, so arriving on
// a link straight to an open panel needs the load event too, not just this call.
addEventListener('DOMContentLoaded', showMaps);
showMaps();

/* Clicking a map opens a bigger one you can zoom and drag.

   The link works on its own -- it goes to Google Maps in a new tab -- so this
   only upgrades it, and only for maps built with a key. The iframe's src is
   set at the moment of opening, never before: until somebody asks for a map,
   this site makes no request to Google at all. */
var mapbox = null;

function closeMapbox() {
  if (!mapbox || mapbox.hidden) return;
  mapbox.hidden = true;
  mapbox.querySelector('iframe').removeAttribute('src');   // stop the map
  document.documentElement.classList.remove('mapbox-open');
  if (mapbox.returnTo) { mapbox.returnTo.focus(); mapbox.returnTo = null; }
}

function openMapbox(link) {
  if (!mapbox) {
    mapbox = document.createElement('div');
    mapbox.className = 'mapbox';
    mapbox.hidden = true;
    mapbox.innerHTML =
      '<div class="mapbox-scrim"></div>' +
      '<div class="mapbox-frame" role="dialog" aria-modal="true" aria-label="Map">' +
        '<p class="mapbox-head"><span class="mapbox-title"></span>' +
        '<button type="button" class="mapbox-close" aria-label="Close the map">&times;</button></p>' +
        '<iframe class="mapbox-map" title="Map" allowfullscreen ' +
        'referrerpolicy="no-referrer-when-downgrade"></iframe>' +
        '<p class="mapbox-foot"></p>' +
      '</div>';
    document.body.appendChild(mapbox);
    mapbox.querySelector('.mapbox-scrim').addEventListener('click', closeMapbox);
    mapbox.querySelector('.mapbox-close').addEventListener('click', closeMapbox);
  }

  mapbox.querySelector('.mapbox-title').textContent = link.dataset.place || 'Map';
  mapbox.querySelector('.mapbox-foot').innerHTML =
    '<a href="' + link.getAttribute('href') + '" target="_blank" rel="noopener">Open in Google Maps</a>';
  mapbox.querySelector('iframe').src = link.dataset.embed;
  mapbox.hidden = false;
  mapbox.returnTo = link;
  document.documentElement.classList.add('mapbox-open');
  mapbox.querySelector('.mapbox-close').focus();
}

addEventListener('click', function (e) {
  var link = e.target.closest && e.target.closest('.staticmap-open[data-embed]');
  if (!link) return;
  // Let a middle-click or a modified click open Google Maps in a tab, the way
  // any other link would.
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openMapbox(link);
});

addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (mapbox && !mapbox.hidden) { closeMapbox(); return; }   // the map first
  if (!location.hash) return;
  // Clearing the hash is what actually closes the panel: :target is not
  // recomputed by replaceState, so tidying the URL alone left the panel open.
  // Clear it first, then tidy, which leaves no stray '#' behind.
  location.hash = '';
  history.replaceState(null, '', location.pathname + location.search);
});
</script>

<footer class="site-footer">
  <div class="container">
    <p>Copyright ${new Date().getFullYear()} &mdash; ${esc(SITE_NAME)}. All rights reserved.</p>
  </div>
</footer>

</body>
</html>
`;
}

/* ------------------------------------------------------------------ cards -- */

function eventCard(ev, depth, { eager = false, modal = true } = {}) {
  const p = parts(ev.start);
  // Opening the detail panel is a link to its :target id, so it works with
  // JavaScript off, gets a shareable URL, and Back closes it.
  const href = modal
    ? `#${modalId(ev)}`
    : `${'../'.repeat(depth)}events/${esc(ev.slug)}.html`;
  const thumb = ev.image
    // `sizes` is parsed by the HTML parser, not CSS — it takes a plain length,
    // never a var(). Keep this in step with --thumb-size in style.css.
    ? `<div class="event-thumb">${responsiveImg(ev, { sizes: '140px', depth, cover: [THUMB, THUMB], eager })}</div>`
    : '';

  const venue = [ev.location?.name, ev.organizer?.name].filter(Boolean).join(' &middot; ');

  return `<article class="event-card"${cardVars(ev)}>
  <a class="card-hit" href="${href}" aria-label="${esc(ev.title)} &mdash; details"></a>
  <h2 class="event-title"><a href="${href}">${esc(ev.title)}</a></h2>
  <div class="event-inner">
    ${thumb}
    <div class="event-date">
      ${p ? `<span class="year">${p.year}</span>
      <span class="day">${String(p.day).padStart(2, '0')}</span>
      <span class="month">${MONTHS[p.month - 1].slice(0, 3)}</span>` : '<span class="day">TBA</span>'}
    </div>
    <div class="event-info">
      <p class="event-time">${esc(timeRange(ev))}${p
        ? `<span class="event-tz">${esc(tzLabel(ev.start))}</span>` : ''}</p>
      ${CARD_DETAILS && venue ? `<p class="event-venue">${venue}</p>` : ''}
      ${CARD_DETAILS && ev.descriptionText ? `<p class="event-summary">${esc(excerpt(ev.descriptionText))}</p>` : ''}
    </div>
  </div>
</article>`;
}

/**
 * The Past Events card: a tall tile with the image filling it and the text
 * over the top. Same data as eventCard, different shape.
 */
function eventTile(ev, depth, { eager = false } = {}) {
  const p = parts(ev.start);

  // These are wide banners (1400x400 is typical) going into a tall tile, so
  // cropping to fill would throw away most of each picture. Show the whole
  // image instead, over a blurred, enlarged copy of itself — the surround
  // takes its colour from the photo, and nothing is cut off. Both layers are
  // the same file, so it is still one request.
  const photo = ev.image
    ? `<span class="tile-photo">
      ${responsiveImg(ev, { depth, cover: [TILE_W, TILE_H], eager, className: 'tile-photo-back' })}
      ${responsiveImg(ev, { depth, cover: [TILE_W, TILE_H], eager, className: 'tile-photo-front' })}
    </span>`
    : '';

  return `<article class="event-tile">
  <a class="tile-inner" href="#${modalId(ev)}"${cardVars(ev)}>
    ${photo}
    <div class="tile-body">
      <h2 class="tile-title">${esc(ev.title)}</h2>
      <div class="tile-meta">
        <span class="event-date">
          ${p ? `<span class="year">${p.year}</span>
          <span class="day">${String(p.day).padStart(2, '0')}</span>
          <span class="month">${MONTHS[p.month - 1].slice(0, 3)}</span>` : '<span class="day">TBA</span>'}
        </span>
        <span class="event-time">${esc(timeRange(ev))}</span>
      </div>
    </div>
  </a>
</article>`;
}

/* ------------------------------------------------------------------ modal -- */

/** Small inline icons, so the panel headings read like the live card's. */
const ICON = {
  details: '<path d="M4 4h16v16H4z" fill="none"/><path d="M6 7h12M6 12h12M6 17h8"/>',
  location: '<path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  performers: '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  ticket: '<path d="M3 9V7h18v2a2 2 0 0 0 0 4v2H3v-2a2 2 0 0 0 0-4z"/>',
};

const icon = (name) => `<svg class="panel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
  + ` stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const panel = (name, heading, inner, cls = '') =>
  `<section class="panel ${cls}">
      <h3 class="panel-title">${icon(name)}${esc(heading)}</h3>
      ${inner}
    </section>`;

/**
 * A map that works without an API key. The live site's Google embed is
 * currently erroring ("This page didn't load Google Maps correctly"), which
 * needs a key with billing enabled; OpenStreetMap needs neither, and EventON
 * already geocoded every venue so the coordinates come free.
 */
function mapPanel(loc, depth, { defer = false } = {}) {
  if (!loc?.lat) return '';

  // Built from tiles mirrored by tiles.js and served from our own domain.
  //
  // This was an OpenStreetMap iframe. That handed every visitor's map to a
  // third party: the embed loads its own code and tiles, and if any of that is
  // slow or blocked the map is a grey box we cannot see into or fix. Composing
  // the tiles ourselves means the map is just images — it renders or it
  // obviously does not, it needs no script, and it makes no outside request.
  const plan = tilePlan(loc.lat, loc.lon);
  const missing = plan.tiles.filter((t) => !existsSync(path.join(TILE_DIR, tileFile(t))));
  if (missing.length) return '';   // run `node tiles.js` and it appears

  const root = '../'.repeat(depth);
  const imgs = plan.tiles.map((t) =>
    `<img ${defer ? 'data-src' : 'src'}="${root}media/tiles/${tileFile(t)}" alt=""`
    + ` width="${TILE}" height="${TILE}">`).join('');

  // The static map is the map. Clicking it opens a larger, zoomable Google one
  // -- as a plain link to Google Maps, which the script upgrades to a panel on
  // the page when a key was set at build time. With no key, no script, or no
  // network to Google, the link still goes somewhere useful.
  const embed = embedMapUrl(loc);
  const zoomable = embed ? ` data-embed="${esc(embed)}"` : '';

  // Three layers, and each one is a working map on its own.
  //
  // The mirrored tiles paint first, from our own domain, with no script and no
  // outside request -- so there is a map before anything third-party is asked
  // for, and still a map if Google never answers. Google's own map then loads
  // over them and takes the interaction. The button sits above both, because an
  // iframe swallows clicks and the reader still needs a way to a bigger view.
  //
  // Inside a detail panel the iframe carries data-src rather than src: a panel
  // is display:none until opened, and an iframe with a src loads regardless,
  // which would mean a Google request for every event on the page.
  const srcAttr = defer ? 'data-src' : 'src';
  const frame = embed
    ? `<iframe class="staticmap-live" ${srcAttr}="${esc(embed)}" title="Map of ${esc(loc.name)}"
           loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>`
    : '';

  return `<section class="panel panel-map">
      <div class="staticmap${embed ? ' has-live' : ''}">
        <div class="staticmap-plane" style="left:calc(50% - ${plan.px.toFixed(1)}px);top:calc(50% - ${plan.py.toFixed(1)}px)">${imgs}</div>
        <span class="staticmap-pin" aria-hidden="true"></span>
        ${frame}
        <span class="staticmap-label">${esc(loc.name)}</span>
        <a class="staticmap-open" href="${esc(placeUrl(loc))}" target="_blank" rel="noopener"${zoomable}
           data-place="${esc(loc.name)}" aria-label="Open a larger map of ${esc(loc.name)}">
          <span class="staticmap-zoom">Larger map</span>
        </a>
        <a class="staticmap-credit" href="${embed
          ? 'https://www.google.com/maps'
          : 'https://www.openstreetmap.org/copyright'}"
           target="_blank" rel="noopener">${embed ? 'Google Maps' : '&copy; OpenStreetMap contributors'}</a>
      </div>
    </section>`;
}

/**
 * The Google Maps Embed API key, read at build time.
 *
 * It is optional on purpose. Without it the maps stay exactly as they are and
 * clicking one opens Google Maps in a new tab, so a plain static build with no
 * secrets set still produces a complete site. Set GOOGLE_MAPS_KEY on the server
 * (Render -> Environment) to get the zoomable map on the page instead.
 *
 * The key is public once the page ships -- that is unavoidable for a map embed
 * and is why it must be restricted, by HTTP referrer and to the Embed API, in
 * the Google console. Restricting it is what protects it, not hiding it.
 */
const MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';

/** Where a venue is, in words Google can search for. */
const placeQuery = (loc) => [loc?.name, loc?.address].filter(Boolean).join(', ');

/** The plain Google Maps page for a venue -- no key needed. */
const placeUrl = (loc) => (loc?.lat
  ? `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lon}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeQuery(loc))}`);

/**
 * The embeddable map for a venue, or '' when no key is set.
 *
 * `q` is the address so the map shows the venue's own place card, while
 * `center` holds the view to the coordinates EventON geocoded, which are the
 * authoritative ones. If the address is missing, the coordinates do both jobs.
 */
function embedMapUrl(loc) {
  if (!MAPS_KEY || !loc?.lat) return '';
  const q = placeQuery(loc) || `${loc.lat},${loc.lon}`;
  return 'https://www.google.com/maps/embed/v1/place'
    + `?key=${encodeURIComponent(MAPS_KEY)}`
    + `&q=${encodeURIComponent(q)}`
    + `&center=${loc.lat},${loc.lon}`
    + '&zoom=16';
}

const directionsUrl = (loc) => loc?.lat
  ? `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lon}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([loc?.name, loc?.address].filter(Boolean).join(' '))}`;

/** The expanded card, shown by :target — no JavaScript required to open it. */
function eventModal(ev, depth) {
  const p = parts(ev.start);
  const id = modalId(ev);
  const loc = ev.location;

  const figure = ev.image
    ? `<section class="panel panel-figure">${responsiveImg(ev, {
        sizes: '(max-width: 820px) 92vw, 460px', depth })}</section>`
    : '';

  const details = ev.description || ev.descriptionText
    ? panel('details', 'Details', `<div class="panel-prose">${sanitize(ev.description)
        || `<p>${esc(ev.descriptionText)}</p>`}</div>`)
    : '';

  const location = loc?.name
    ? panel('location', 'Location', `<p class="venue-name">${esc(loc.name)}</p>
      ${loc.address ? `<p class="venue-address">${esc(loc.address)}</p>` : ''}
      <p class="panel-actions">
        <a class="pill" href="${esc(directionsUrl(loc))}" target="_blank" rel="noopener">Get directions</a>
        <a class="pill" href="${'../'.repeat(depth)}events/${esc(ev.slug)}.html">Event page</a>
      </p>`)
    : '';

  const performers = ev.performers ? panel('performers', 'Performers', `<p>${esc(ev.performers)}</p>`) : '';
  const learnMore = ev.website
    ? panel('link', 'Learn More',
      `<p><a href="${esc(ev.website)}" target="_blank" rel="noopener">Visit the event website</a></p>`)
    : '';
  const tickets = ev.tickets ? panel('ticket', 'Ticket Information', `<p>${esc(ev.tickets)}</p>`) : '';

  const pair = (a, b) => (a && b) ? `<div class="panel-row">${a}${b}</div>` : (a || b);

  return `<div class="event-modal" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${id}-t">
  <a class="modal-scrim" href="#" tabindex="-1" aria-label="Close"></a>
  <div class="modal-panel">
    <div class="modal-head"${cardVars(ev)}>
      <h2 class="modal-title" id="${id}-t">${esc(ev.title)}</h2>
      <div class="event-inner">
        ${ev.image ? `<div class="event-thumb">${responsiveImg(ev, { sizes: '140px', depth, cover: [THUMB, THUMB] })}</div>` : ''}
        <div class="event-date">
          ${p ? `<span class="year">${p.year}</span>
          <span class="day">${String(p.day).padStart(2, '0')}</span>
          <span class="month">${MONTHS[p.month - 1].slice(0, 3)}</span>` : '<span class="day">TBA</span>'}
        </div>
        <div class="event-info">
          <p class="event-time">${esc(timeRange(ev))}${p
            ? `<span class="event-tz">${esc(tzLabel(ev.start))}</span>` : ''}</p>
        </div>
      </div>
      <a class="modal-close" href="#" aria-label="Close">&times;</a>
    </div>
    <div class="modal-body">
      ${pair(figure, details)}
      ${mapPanel(loc, depth, { defer: true })}
      ${location}
      ${pair(performers, learnMore)}
      ${tickets}
    </div>
  </div>
</div>`;
}

const modalId = (ev) => `ev-${ev.id}-${ev.instance || 0}`;

/* ---------------------------------------------------------- month grid -- */

/**
 * The big calendar on the Calendar page — full width, seven columns, with each
 * event showing in its day as a small chip in that event's own colour. The
 * sidebar widget is a different, smaller thing; see calendarWidget.
 */
function monthGrid(year, month, byDay, depth) {
  const root = '../'.repeat(depth);
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');

  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<p class="calday empty"></p>');

  for (let d = 1; d <= total; d++) {
    const list = byDay.get(`${year}-${pad(month)}-${pad(d)}`) || [];
    const chips = list.map((ev) =>
      `<a class="calday-event" href="#${modalId(ev)}"${cardVars(ev)}
         title="${esc(ev.title)} — ${esc(timeRange(ev))}">${esc(ev.title)}</a>`).join('');
    cells.push(`<p class="calday${list.length ? ' has-events' : ''}">
      <span class="calday-num" data-label="${MONTHS[month-1].slice(0,3)}">${d}</span>
      ${chips ? `<span class="calday-events">${chips}</span>` : ''}
    </p>`);
  }

  return `<div class="cal-daynames cal-daynames-lg" aria-hidden="true">
    ${DOW.map((d) => `<div>${d}</div>`).join('')}
  </div>
  <div class="cal-days-lg">
    ${cells.join('\n    ')}
  </div>`;
}

/** "Jump Months" — every month that has something on, as links. */
function monthJump(months, current, depth) {
  const root = '../'.repeat(depth);
  const byYear = new Map();
  for (const ym of months) {
    const [y, m] = ym.split('-');
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(m);
  }
  const years = [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  return `<details class="cal-jump">
    <summary class="cal-button">Jump Months</summary>
    <div class="cal-jump-panel">
      ${years.map(([y, ms]) => `<div class="cal-jump-year">
        <span class="cal-jump-label">${y}</span>
        ${ms.sort().map((m) => `<a href="${root}calendar/${y}-${m}.html"${
          `${y}-${m}` === current ? ' aria-current="page"' : ''}>${MONTHS[+m - 1].slice(0, 3)}</a>`).join('')}
      </div>`).join('\n      ')}
    </div>
  </details>`;
}

/* --------------------------------------------------------- sidebar widget -- */

function calendarWidget(year, month, byDay, depth, { nextEvent = null } = {}) {
  const root = '../'.repeat(depth);
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');

  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<div class="empty"></div>');
  for (let d = 1; d <= total; d++) {
    const list = byDay.get(`${year}-${pad(month)}-${pad(d)}`) || [];
    cells.push(list.length
      ? `<a class="has-events" href="${root}calendar/${year}-${pad(month)}.html"
         title="${esc(list.map((e) => e.title).join(', '))}">${d}</a>`
      : `<div>${d}</div>`);
  }
  while (cells.length % 7) cells.push('<div class="empty"></div>');

  const shift = (delta) => {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  };

  return `<h2 class="widget-title">Events Calendar</h2>
<div class="cal-widget">
  <div class="cal-buttons">
    <a class="cal-button" href="${root}calendar/">Jump Months</a>
  </div>
  <div class="cal-month-line">
    <span class="cal-month-title">${MONTHS[month - 1]}, ${year}</span>
    <span class="cal-arrows">
      <a href="${root}calendar/${shift(-1)}.html" aria-label="Previous month">&lsaquo;</a>
      <a href="${root}calendar/${shift(1)}.html" aria-label="Next month">&rsaquo;</a>
    </span>
  </div>
  <div class="cal-daynames" aria-hidden="true">
    ${DOW.map((d) => `<div>${d}</div>`).join('')}
  </div>
  <div class="cal-days">
    ${cells.join('\n    ')}
  </div>
</div>
${nextEvent ? `<div class="event-list">${eventCard(nextEvent, depth)}</div>` : ''}`;
}

/* ------------------------------------------------------------------- ics -- */

function icsFor(ev) {
  const stamp = (iso) => {
    const p = parts(iso);
    return p ? `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`
      + `T${String(p.hour).padStart(2, '0')}${String(p.minute).padStart(2, '0')}00` : null;
  };
  const start = stamp(ev.start);
  if (!start) return null;

  const endParts = parts(ev.end);
  const end = (endParts && !(endParts.hour === 23 && endParts.minute === 59)) ? stamp(ev.end) : null;
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  const fold = (line) => line.match(/.{1,73}/g).join('\r\n ');
  const cl = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/[;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');

  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Early Music San Antonio//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:earlymusicsa-${ev.id}@earlymusicsa.org`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=${TZ}:${start}`,
    end ? `DTEND;TZID=${TZ}:${end}` : '',
    fold(`SUMMARY:${cl(ev.title)}`),
    fold(`DESCRIPTION:${cl(ev.descriptionText).slice(0, 900)}`),
    ev.location?.name ? fold(`LOCATION:${cl([ev.location.name, ev.location.address].filter(Boolean).join(', '))}`) : '',
    ev.website ? `URL:${ev.website}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const { events } = JSON.parse(await readFile('data/events.json', 'utf8'));

  // Events approved through the moderation queue join the archive at build
  // time. The database is optional — without it the site still builds, which
  // is what lets Render deploy the public pages as a plain static site.
  let approved = [];
  let edits = new Map();
  let applyPatch = (ev) => ev;
  const dbFile = process.env.DB_PATH || 'earlymusicsa.sqlite';
  if (existsSync(dbFile)) {
    try {
      const { openDb, approvedEvents, getEventEdits, applyEventPatch } = await import('./db.js');
      const db = openDb(dbFile);
      approved = approvedEvents(db);
      edits = getEventEdits(db);
      applyPatch = applyEventPatch;
      db.close();
    } catch (err) {
      console.warn(`  note: could not read ${dbFile} (${err.message}); building without it`);
    }
  }

  // Edits are overrides laid over the export, so data/events.json is never
  // rewritten and any edit can be undone. `hidden` takes an event off the site
  // without deleting anything.
  const live = [...events, ...approved]
    .map((e) => (edits.has(String(e.id)) ? applyPatch(e, edits.get(String(e.id))) : e))
    .filter((e) => !e.suspectedSpam && !e.hidden);

  if (edits.size) console.log(`  ${edits.size} event(s) carry an edit`);

  const keepMedia = SKIP_MEDIA && existsSync(path.join(OUT, 'media'));

  // Clear the generated pages but leave the copied images where they are when
  // this is a quick rebuild.
  if (keepMedia) {
    for (const entry of await readdir(OUT, { withFileTypes: true })) {
      if (entry.name === 'media') continue;
      await rm(path.join(OUT, entry.name), { recursive: true, force: true });
    }
  } else {
    await rm(OUT, { recursive: true, force: true });
  }
  await mkdir(OUT, { recursive: true });
  await copyFile('assets/style.css', path.join(OUT, 'style.css'));
  // The volunteer tools: not linked from the public nav, but served alongside.
  for (const f of ['admin.html', 'admin.css', 'admin.js', 'submit.js']) {
    await copyFile(path.join('assets', f), path.join(OUT, f));
  }

  // Mirror the images in so nothing on the built site points at WordPress.
  let copied = 0;
  if (keepMedia) {
    copied = (await readdir(path.join(OUT, 'media'))).length;
  } else if (existsSync('media')) {
    // Recursive: media/ now holds a tiles/ subdirectory as well as the images.
    await cp('media', path.join(OUT, 'media'), { recursive: true });
    copied = (await readdir(path.join(OUT, 'media'))).length;
  }

  // A repeating event is one record with several dates, and it appears once
  // per date in every listing — which is what the live site does.
  const occurrencesOf = (ev) => (ev.instances || [{
    start: ev.start, end: ev.end, startUnix: ev.startUnix, endUnix: ev.endUnix,
  }]).map((inst, i) => ({ ...ev, ...inst, instance: i }));

  const dated = live.flatMap(occurrencesOf)
    .filter((o) => o.startUnix)
    .sort((a, b) => a.startUnix - b.startUnix);
  const undated = live.filter((e) => !e.start);
  const now = Date.now() / 1000;
  const upcoming = dated.filter((e) => e.endUnix >= now);
  const past = [...dated.filter((e) => e.endUnix < now)].reverse();

  const write = (rel, html) => writeFile(path.join(OUT, rel), html);

  const byDay = new Map();
  for (const ev of dated) {
    const key = parts(ev.start).ymd;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }

  // --- home page --------------------------------------------------------
  const focusDate = parts(upcoming[0]?.start) || parts(dated[dated.length - 1]?.start);
  const shown = upcoming.slice(0, HOME_LIMIT);

  await write('index.html', page({
    title: 'Home', current: '',
    body: `<div class="container content">
  <div class="primary">
    <h1 class="site-heading">${esc(SITE_NAME)}</h1>
    <h2 class="section-heading">Upcoming Events</h2>
    <div class="event-list">
${shown.length
      ? shown.map((e, i) => eventCard(e, 0, { eager: i < 2 })).join('\n')
      : '<p>No upcoming events are listed just now. Please check back soon.</p>'}
    </div>
${shown.map((e) => eventModal(e, 0)).join('\n')}
    ${upcoming.length > HOME_LIMIT || past.length
      ? '<a class="show-more" href="archive/">Show More Events</a>' : ''}
  </div>
  <aside class="sidebar">
${calendarWidget(focusDate.year, focusDate.month, byDay, 0, { nextEvent: upcoming[0] })}
  </aside>
</div>`,
  }));

  if (HOME_ONLY) {
    console.log(`Built ${OUT}/index.html (home only) — ${shown.length} of ${upcoming.length} upcoming shown`);
    return;
  }

  for (const d of ['events', 'calendar', 'archive']) {
    await mkdir(path.join(OUT, d), { recursive: true });
  }

  // --- month pages ------------------------------------------------------
  const months = [...new Set(dated.map((e) => parts(e.start).ymd.slice(0, 7)))].sort();

  // The month the Current Month button goes to: the one holding the next event,
  // or the most recent month if nothing is upcoming.
  const focusYm = `${focusDate.year}-${String(focusDate.month).padStart(2, '0')}`;
  const calLanding = months.includes(focusYm) ? focusYm : months[months.length - 1];
  for (const [i, ym] of months.entries()) {
    const [y, m] = ym.split('-').map(Number);
    const prev = months[i - 1], next = months[i + 1];
    const label = (s) => `${MONTHS[+s.split('-')[1] - 1]} ${s.split('-')[0]}`;
    const inMonth = dated.filter((e) => parts(e.start).ymd.startsWith(ym));
    await write(`calendar/${ym}.html`, page({
      title: 'Calendar of Events', current: 'calendar/', depth: 1,
      body: `<div class="container page-header">
  <h1 class="page-title">Calendar of Events</h1>
</div>
<div class="container content">
  <div class="primary wide">
    <div class="cal-buttons">
      ${monthJump(months, ym, 1)}
      ${ym === calLanding ? '' : `<a class="cal-button" href="${calLanding}.html">Current Month</a>`}
    </div>
    <div class="cal-month-line cal-month-line-lg">
      <span class="cal-month-title">${MONTHS[m - 1]}, ${y}</span>
      <span class="cal-arrows">
        ${prev ? `<a href="${prev}.html" title="${esc(label(prev))}" aria-label="Previous month">&lsaquo;</a>` : ''}
        ${next ? `<a href="${next}.html" title="${esc(label(next))}" aria-label="Next month">&rsaquo;</a>` : ''}
      </span>
    </div>
    ${monthGrid(y, m, byDay, 1)}
    ${inMonth.length ? `<div class="event-list cal-month-list">
      ${inMonth.map((e) => eventCard(e, 1)).join('\n')}
    </div>` : '<p class="pager-note">Nothing listed this month.</p>'}
  </div>
</div>
${inMonth.map((e) => eventModal(e, 1)).join('\n')}`,
    }));
  }

  await write('calendar/index.html', page({
    title: 'Calendar', current: 'calendar/', depth: 1,
    head: `<meta http-equiv="refresh" content="0; url=${calLanding}.html">\n`,
    body: `<div class="container content"><div class="primary">
  <h1 class="site-heading">Calendar</h1>
  <p><a href="${calLanding}.html">Go to ${MONTHS[+calLanding.split('-')[1] - 1]} ${calLanding.split('-')[0]} &rarr;</a></p>
</div></div>`,
  }));

  // --- past events ------------------------------------------------------
  // Full width, no sidebar, a grid of tiles newest-first — matching the live
  // page. It loads 12 at a time there; here "Show More Events" is a link to
  // the next page, which needs no script and gives every page a real URL.
  const years = [...new Set(past.map((e) => parts(e.start).year))].sort((a, b) => b - a);

  const yearJump = (cur) => `<nav class="year-jump" aria-label="Jump to a year">
      ${years.map((y) => `<a href="${y}.html"${y === cur ? ' aria-current="page"' : ''}>${y}</a>`).join('\n      ')}
      ${undated.length ? `<a href="undated.html"${cur === 'undated' ? ' aria-current="page"' : ''}>Undated</a>` : ''}
    </nav>`;

  /** One past-events page: tiles, their detail panels, and the pager. */
  const pastPage = ({ file, title, list, intro, jump, pager }) => write(file, page({
    title, current: 'archive/', depth: 1,
    body: `<div class="container page-header">
  <h1 class="page-title">${esc(title)}</h1>
</div>
<div class="container content">
  <div class="primary wide">
    ${intro ? `<p class="pager-note" style="text-align:left">${intro}</p>` : ''}
    ${jump}
    <div class="event-tiles">
${list.map((e, i) => eventTile(e, 1, { eager: i < 3 })).join('\n')}
    </div>
    ${pager || ''}
  </div>
</div>
${list.map((e) => eventModal(e, 1)).join('\n')}`,
  }));

  const PER_PAGE = 12;
  const pageCount = Math.max(1, Math.ceil(past.length / PER_PAGE));
  const pageFile = (n) => (n === 1 ? 'index.html' : `page-${n}.html`);

  for (let n = 1; n <= pageCount; n++) {
    const list = past.slice((n - 1) * PER_PAGE, n * PER_PAGE);
    const prev = n > 1 ? `<a class="show-more" href="${pageFile(n - 1)}">&larr; Newer</a>` : '';
    const next = n < pageCount ? `<a class="show-more" href="${pageFile(n + 1)}">Show More Events</a>` : '';
    await pastPage({
      file: `archive/${pageFile(n)}`,
      title: 'Past Events',
      list,
      intro: n === 1
        ? `${past.length} events listed since ${years[years.length - 1]}.` : '',
      jump: yearJump(null),
      pager: `<div class="pager">${prev}${next}</div>
    <p class="pager-note">Page ${n} of ${pageCount}</p>`,
    });
  }

  for (const y of years) {
    const list = past.filter((e) => parts(e.start).year === y);
    await pastPage({
      file: `archive/${y}.html`,
      title: `${y} Events`,
      list,
      intro: `${list.length} event${list.length === 1 ? '' : 's'} in ${y}.`,
      jump: yearJump(y),
      pager: `<div class="pager"><a class="show-more" href="./">All past events</a></div>`,
    });
  }

  if (undated.length) {
    await pastPage({
      file: 'archive/undated.html',
      title: 'Undated Listings',
      list: undated,
      intro: 'These events were listed without a date.',
      jump: yearJump('undated'),
      pager: `<div class="pager"><a class="show-more" href="./">All past events</a></div>`,
    });
  }

  // --- one page per event ----------------------------------------------
  for (const ev of live) {
    const p = parts(ev.start);
    const ld = {
      '@context': 'https://schema.org', '@type': 'Event', name: ev.title,
      startDate: ev.start || undefined, endDate: ev.end || undefined,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      description: ev.descriptionText?.slice(0, 500) || undefined,
      image: ev.image || undefined,
      location: ev.location?.name
        ? { '@type': 'Place', name: ev.location.name, address: ev.location.address || undefined }
        : undefined,
      organizer: ev.organizer?.name ? { '@type': 'Organization', name: ev.organizer.name } : undefined,
    };

    const facts = [];
    if (ev.performers) facts.push(['Performers', esc(ev.performers)]);
    if (ev.location?.name) {
      const addr = ev.location.address;
      facts.push(['Venue', esc(ev.location.name) + (addr ? `<br>${esc(addr)}` : '')
        + (addr ? ` <a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(`${ev.location.name} ${addr}`)}" rel="noopener">map</a>` : '')]);
    }
    if (ev.organizer?.name) facts.push(['Presented by', esc(ev.organizer.name)]);
    if (ev.tickets) facts.push(['Tickets', esc(ev.tickets)]);
    if (p) facts.push(['Date', `${esc(longDate(p))}${ev.allDay ? '' : `, ${esc(timeRange(ev))}`}`]);

    await write(`events/${ev.slug}.html`, page({
      title: ev.title, depth: 1,
      head: `<script type="application/ld+json">${JSON.stringify(ld)}</script>\n`,
      body: `<div class="container content">
  <div class="primary">
    <p style="margin:30px 0 0"><a href="../">&larr; All events</a></p>
    <h1 class="site-heading">${esc(ev.title)}</h1>
    ${ev.image ? `<p>${responsiveImg(ev, { sizes: '(max-width: 782px) 100vw, 700px', depth: 1 })}</p>` : ''}
    ${sanitize(ev.description) || '<p>No description was provided for this event.</p>'}
    <dl>${facts.map(([k, v]) => `<dt><strong>${k}</strong></dt><dd style="margin:0 0 10px">${v}</dd>`).join('')}</dl>
    <p>
      ${ev.website ? `<a href="${esc(ev.website)}" rel="noopener">Event website</a> &nbsp; ` : ''}
      ${p ? `<a href="${esc(ev.slug)}.ics">Add to calendar</a>` : ''}
    </p>
    ${mapPanel(ev.location, 1)}
    <p>
    </p>
  </div>
  <aside class="sidebar">${calendarWidget(p?.year || focusDate.year, p?.month || focusDate.month, byDay, 1)}</aside>
</div>`,
    }));

    const ics = icsFor(ev);
    if (ics) await writeFile(path.join(OUT, 'events', `${ev.slug}.ics`), ics);
  }

  // --- static pages -----------------------------------------------------
  // Interior pages keep the sidebar calendar, as the live site does.
  // The page title sits in its own row spanning the container, not inside the
  // article column — which is how the live site fits a long title on one line.
  // `wide` drops the sidebar, which is how the live Submit page is laid out.
  const simplePage = (file, title, current, inner, { wide = false } = {}) => write(file, page({
    title, current,
    body: `<div class="container page-header">
  <h1 class="page-title">${esc(title)}</h1>
</div>
<div class="container content">
  <div class="primary${wide ? ' wide' : ''}">
    ${inner}
  </div>
  ${wide ? '' : `<aside class="sidebar">${calendarWidget(focusDate.year, focusDate.month, byDay, 0)}</aside>`}
</div>`,
  }));

  // Copy lives in seed/pages.json so it can be edited without touching code.
  const pages = JSON.parse(await readFile('seed/pages.json', 'utf8'));
  const about = pages.about;

  const hero = about.hero && {
    image: about.hero.full,
    imageAlt: about.hero.alt,
    imageWidth: about.hero.width,
    imageHeight: about.hero.height,
    imageVariants: about.hero.variants,
  };

  await simplePage('about.html', about.title, 'about.html',
    `${hero ? `<div class="page-hero">${responsiveImg(hero, {
      sizes: '(max-width: 900px) 92vw, 698px', depth: 0, eager: true })}</div>` : ''}
    <div class="page-prose">
      ${about.body.map((p) => `<p>${p}</p>`).join('\n      ')}
    </div>`);

  // Saved venues and organisers come from the real archive, and the venue list
  // carries coordinates so choosing one shows its map straight away.
  const venueRows = JSON.parse(await readFile('data/locations.json', 'utf8'));
  const venueCoords = new Map();
  for (const ev of live) {
    const l = ev.location;
    if (l && l.name && l.lat && !venueCoords.has(l.name)) venueCoords.set(l.name, [l.lat, l.lon]);
  }
  const venues = venueRows.map((l) => {
    const c = venueCoords.get(l.name) || [];
    return {
      name: l.name,
      address: (l.addresses && l.addresses[0]) || '',
      lat: c[0] || null,
      lon: c[1] || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const organisers = JSON.parse(await readFile('data/organizers.json', 'utf8'))
    .map((o) => o.name).filter((n) => !n.includes('@')).sort();

  const types = JSON.parse(await readFile('data/event-types.json', 'utf8'));

  // Field for field in the same order as EventON's own submission form.
  await simplePage('submit.html', 'Submit Your Event', 'submit.html', `
    <div class="page-prose">
      <p>Listings are free. We list concerts of Medieval, Renaissance and
      Baroque music in and around San Antonio. A volunteer checks every
      submission before it appears.</p>
    </div>
    <form class="site-form form-evo" id="submit-form" method="post" action="/api/submit" enctype="multipart/form-data">

      <p class="field">
        <label for="title">Event Name <span class="req">*</span></label>
        <input id="title" name="title" type="text" required maxlength="200">
      </p>

      <p class="field">
        <label for="start_local">Event Start Date/Time <span class="req">*</span></label>
        <input id="start_local" name="start_local" type="datetime-local" required>
      </p>

      <p class="field" data-when="has-end">
        <label for="end_local">Event End Date/Time</label>
        <input id="end_local" name="end_local" type="datetime-local">
      </p>

      <p class="field checkbox">
        <input id="all_day" name="all_day" type="checkbox" value="1">
        <label for="all_day">All Day Event</label>
      </p>
      <p class="field checkbox">
        <input id="no_end_time" name="no_end_time" type="checkbox" value="1">
        <label for="no_end_time">No end time</label>
      </p>
      <p class="field checkbox">
        <input id="repeating" name="repeating" type="checkbox" value="1">
        <label for="repeating">This is a repeating event</label>
      </p>
      <p class="field" data-when="repeating" hidden>
        <label for="repeat_note">When does it repeat?</label>
        <input id="repeat_note" name="repeat_note" type="text" maxlength="300"
               placeholder="e.g. every Friday in October">
        <span class="field-hint">Tell us in your own words and a volunteer will set it up.</span>
      </p>

      <p class="field">
        <label for="subtitle">Event Sub Title</label>
        <input id="subtitle" name="subtitle" type="text" maxlength="200">
      </p>

      <p class="field">
        <label for="description">Event Description</label>
        <textarea id="description" name="description" rows="6" maxlength="5000"></textarea>
      </p>

      <p class="field">
        <label for="performers">Performers</label>
        <input id="performers" name="performers" type="text" maxlength="1000">
      </p>

      <h2 class="form-section">Event Location Fields</h2>
      <p class="field">
        <label for="venue_select">Select a venue we already list</label>
        <select id="venue_select">
          <option value="">Choose a saved venue, or fill in the fields below</option>
          ${venues.map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join('')}
        </select>
      </p>
      <div class="field-row">
        <p class="field">
          <label for="location_name">Venue name</label>
          <input id="location_name" name="location_name" type="text" maxlength="200">
        </p>
        <p class="field">
          <label for="location_address">Venue address</label>
          <input id="location_address" name="location_address" type="text" maxlength="300">
        </p>
      </div>
      <p class="field">
        <button type="button" class="ghost" id="venue-lookup">Show this venue on a map</button>
        <span class="field-hint" id="venue-map-note" hidden></span>
      </p>
      <div class="venue-map" id="venue-map" hidden></div>
      <input type="hidden" id="location_lat" name="location_lat">
      <input type="hidden" id="location_lon" name="location_lon">

      <h2 class="form-section">Tickets and links</h2>
      <p class="field">
        <label for="tickets">Ticket Information</label>
        <input id="tickets" name="tickets" type="text" maxlength="300"
               placeholder="e.g. &#36;30 general, &#36;10 student, or Free">
      </p>
      <p class="field">
        <label for="website">Website</label>
        <input id="website" name="website" type="url" maxlength="500" placeholder="https://">
      </p>
      <p class="field checkbox">
        <input id="link_new_window" name="link_new_window" type="checkbox" value="1">
        <label for="link_new_window">Open in new window</label>
      </p>
      <p class="field">
        <label for="image_file">Event Image</label>
        <input id="image_file" name="image_file" type="file" accept="image/jpeg,image/png,image/gif,image/webp">
        <span class="field-hint">A poster or photo &mdash; JPEG, PNG, GIF or WebP, up to 8MB.</span>
      </p>
      <div class="image-preview" id="image-preview" hidden></div>
      <p class="field">
        <label for="image_url">&hellip; or link to one instead</label>
        <input id="image_url" name="image_url" type="url" maxlength="500" placeholder="https://">
      </p>

      <p class="field">
        <label for="color">Event Colour</label>
        <span class="colour-row">
          <input id="color" name="color" type="color" value="#b3d1db">
          <input id="color_hex" type="text" value="#b3d1db" maxlength="7" spellcheck="false" aria-label="Event colour as a hex value">
        </span>
        <span class="field-hint">The colour of this event card and its mark in the calendar.</span>
      </p>

      <h2 class="form-section">Event Organizer Fields</h2>
      <p class="field">
        <label for="organizer_name">Presented by</label>
        <input id="organizer_name" name="organizer_name" type="text" list="organisers" maxlength="200">
        <datalist id="organisers">${organisers.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>
      </p>

      <h2 class="form-section">Select the Event Type Category</h2>
      <p class="field">
        <label for="type-filter">Filter the list</label>
        <input id="type-filter" type="search" placeholder="Type to narrow ${types.length} categories">
      </p>
      <div class="type-grid">
        ${types.map((t) => `<label class="type-option"><input type="checkbox" name="event_types" value="${esc(t.slug)}"> ${esc(t.name)}</label>`).join('\n        ')}
      </div>

      <h2 class="form-section">About you</h2>
      <div class="field-row">
        <p class="field">
          <label for="submitter_name">Your name</label>
          <input id="submitter_name" name="submitter_name" type="text" maxlength="120">
        </p>
        <p class="field">
          <label for="submitter_email">Your email</label>
          <input id="submitter_email" name="submitter_email" type="email" maxlength="200">
          <span class="field-hint">Only so we can ask if something is unclear.</span>
        </p>
      </div>

      <p class="field honeypot" aria-hidden="true">
        <label for="website_url">Leave this field empty</label>
        <input id="website_url" name="website_url" type="text" tabindex="-1" autocomplete="off">
      </p>
      <p><button class="form-submit" type="submit">Submit event</button></p>
    </form>
    <script>window.EMSA_VENUES = ${JSON.stringify(venues)};</script>
    <script src="submit.js"></script>`, { wide: true });

  // The form posts to the server and works with JavaScript off. The honeypot
  // is a real input, hidden from people but not from bots.
  const contact = pages.contact;
  await simplePage('contact.html', contact.title, 'contact.html', `
    <div class="page-prose">
      ${contact.body.map((p) => `<p>${p}</p>`).join('\n      ')}
    </div>
    <form class="site-form" method="post" action="/api/contact">
      <div class="field-row">
        <p class="field">
          <label for="first_name">First name</label>
          <input id="first_name" name="first_name" type="text" autocomplete="given-name">
        </p>
        <p class="field">
          <label for="last_name">Last name</label>
          <input id="last_name" name="last_name" type="text" autocomplete="family-name">
        </p>
      </div>
      <p class="field">
        <label for="email">Email <span class="req">*</span></label>
        <input id="email" name="email" type="email" required autocomplete="email">
      </p>
      <p class="field">
        <label for="message">Comment or message <span class="req">*</span></label>
        <textarea id="message" name="message" rows="4" required></textarea>
      </p>
      <p class="field honeypot" aria-hidden="true">
        <label for="website_url">Leave this field empty</label>
        <input id="website_url" name="website_url" type="text" tabindex="-1" autocomplete="off">
      </p>
      <p><button class="form-submit" type="submit">Submit</button></p>
    </form>`);

  console.log(`Built ${OUT}/`);
  console.log(`  ${upcoming.length} upcoming · ${past.length} past · ${undated.length} undated`);
  console.log(`  ${months.length} month pages · ${years.length} archive years · ${live.length} event pages`);
  console.log(`  ${copied} images mirrored locally`);

  // Guard against images silently reverting to the old WordPress host. Google
  // Fonts and the OpenStreetMap embeds are meant to be remote, so skip those.
  const home = await readFile(path.join(OUT, 'index.html'), 'utf8');
  const remote = [...home.matchAll(/<img\b[^>]*?\ssrc="(https?:[^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.includes('fonts.g'));
  if (remote.length) {
    console.warn(`  WARNING: ${remote.length} image(s) still load from a remote host`);
    remote.slice(0, 3).forEach((u) => console.warn(`    ${u}`));
  } else {
    console.log('  no images load from earlymusicsa.org');
  }

  // A card opens its detail panel by :target, so the panel has to be on the
  // same page. Linking to one that was never rendered fails silently — the
  // click just does nothing — so check every page rather than trust it.
  const walk = async (dir) => {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...await walk(full));
      else if (entry.name.endsWith('.html')) found.push(full);
    }
    return found;
  };

  let dead = 0;
  const offenders = [];
  for (const file of await walk(OUT)) {
    const html = await readFile(file, 'utf8');
    const links = [...new Set([...html.matchAll(/href="#(ev-[\d-]+)"/g)].map((m) => m[1]))];
    if (!links.length) continue;
    const ids = new Set([...html.matchAll(/id="(ev-[\d-]+)"/g)].map((m) => m[1]));
    const missing = links.filter((l) => !ids.has(l));
    if (missing.length) {
      dead += missing.length;
      offenders.push(`${path.relative(OUT, file)} (${missing.length})`);
    }
  }
  if (dead) {
    console.warn(`  WARNING: ${dead} card(s) link to a detail panel that is not on the page`);
    offenders.slice(0, 5).forEach((o) => console.warn(`    ${o}`));
  } else {
    console.log('  every card opens a panel that exists');
  }

  // Every map must be a working link whether or not a key was set, and the
  // embed must appear only when one was -- a key leaking into a keyless build,
  // or a map that opens nothing, would both be silent failures.
  let maps = 0, embeds = 0, linkless = 0;
  for (const file of await walk(OUT)) {
    if (!file.endsWith('.html')) continue;
    const html = await readFile(file, 'utf8');
    for (const tag of html.match(/<a class="staticmap-open"[^>]*>/g) || []) {
      maps++;
      if (!/href="https:\/\//.test(tag)) linkless++;
      if (tag.includes('data-embed=')) embeds++;
    }
  }
  if (linkless) {
    console.warn(`  WARNING: ${linkless} map(s) link nowhere`);
  } else if (maps) {
    console.log(MAPS_KEY
      ? `  ${maps} maps, all clickable, ${embeds} of them zoomable on the page`
      : `  ${maps} maps, all clickable (set GOOGLE_MAPS_KEY to make them zoomable)`);
  }
  if (!MAPS_KEY && embeds) console.warn(`  WARNING: ${embeds} embed URL(s) built without a key`);
  if (MAPS_KEY && maps !== embeds) console.warn(`  WARNING: ${maps - embeds} map(s) missing their embed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
