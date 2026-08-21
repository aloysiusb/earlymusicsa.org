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

import { mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const OUT = 'dist';
const SITE_NAME = 'Early Music San Antonio';
const TAGLINE = 'The audience-based information site for San Antonio’s Early Music scene';
const TZ = 'America/Chicago';
const HOME_ONLY = process.argv.includes('--home');

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
function responsiveImg(ev, { sizes, depth, className = '', square = 0, eager = false }) {
  if (!ev.image) return '';
  const variants = (ev.imageVariants || []).filter((v) => mirrored(v.url));
  const src = localImage(ev.image, depth);

  // Most of these uploads are wide banners (1400x400 is typical). Cropping one
  // into a square box means the browser needs a file wide enough to cover the
  // box's *height*, so ask for width x aspect-ratio — otherwise `sizes: 140px`
  // picks a 300x86 file and it gets upscaled into the 140px square.
  if (square && ev.imageWidth && ev.imageHeight) {
    sizes = `${Math.round(square * Math.max(1, ev.imageWidth / ev.imageHeight))}px`;
  }
  const srcset = variants.length
    ? ` srcset="${variants.map((v) => `${localImage(v.url, depth)} ${v.width}w`).join(', ')}"`
    : '';
  // For a square crop the intrinsic ratio would fight object-fit, so only
  // publish real dimensions when the image is shown at its own aspect ratio.
  const dims = !square && ev.imageWidth
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
   through :target and :has(). This handles the two things CSS cannot: closing
   on Escape, and loading a panel's map only once that panel is opened. */
(function () {
  function loadMap() {
    var open = document.querySelector('.event-modal:target');
    if (!open) return;
    open.querySelectorAll('iframe[data-src]').forEach(function (f) {
      f.src = f.getAttribute('data-src');
      f.removeAttribute('data-src');
    });
  }
  addEventListener('hashchange', loadMap);
  loadMap();
  addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  });
})();
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
    ? `<div class="event-thumb">${responsiveImg(ev, { sizes: '140px', depth, square: THUMB, eager })}</div>`
    : '';

  const venue = [ev.location?.name, ev.organizer?.name].filter(Boolean).join(' &middot; ');

  return `<article class="event-card">
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
function mapPanel(loc) {
  if (!loc?.lat) return '';
  const d = 0.005;
  const bbox = [loc.lon - d, loc.lat - d, loc.lon + d, loc.lat + d].map((n) => n.toFixed(6)).join(',');
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${loc.lat},${loc.lon}`;
  // Held in data-src so a page full of closed panels makes no map requests at
  // all — `loading="lazy"` does not help here, because a hidden iframe still
  // fetches. The script swaps it in when its panel opens. Without JavaScript
  // the map is skipped and the "Get directions" link carries the same info.
  return `<section class="panel panel-map">
      <iframe data-src="${esc(src)}" title="Map showing ${esc(loc.name)}"
        referrerpolicy="no-referrer-when-downgrade"></iframe>
    </section>`;
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
    <div class="modal-head">
      <h2 class="modal-title" id="${id}-t">${esc(ev.title)}</h2>
      <div class="event-inner">
        ${ev.image ? `<div class="event-thumb">${responsiveImg(ev, { sizes: '140px', depth, square: THUMB })}</div>` : ''}
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
      ${mapPanel(loc)}
      ${location}
      ${pair(performers, learnMore)}
      ${tickets}
    </div>
  </div>
</div>`;
}

const modalId = (ev) => `ev-${ev.id}-${ev.instance || 0}`;

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
  const live = events.filter((e) => !e.suspectedSpam);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await copyFile('assets/style.css', path.join(OUT, 'style.css'));

  // Mirror the images in so nothing on the built site points at WordPress.
  let copied = 0;
  if (existsSync('media')) {
    await mkdir(path.join(OUT, 'media'), { recursive: true });
    for (const name of await readdir('media')) {
      await copyFile(path.join('media', name), path.join(OUT, 'media', name));
      copied++;
    }
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
  for (const [i, ym] of months.entries()) {
    const [y, m] = ym.split('-').map(Number);
    const prev = months[i - 1], next = months[i + 1];
    const label = (s) => `${MONTHS[+s.split('-')[1] - 1]} ${s.split('-')[0]}`;
    const inMonth = dated.filter((e) => parts(e.start).ymd.startsWith(ym));
    await write(`calendar/${ym}.html`, page({
      title: `${MONTHS[m - 1]} ${y}`, current: 'calendar/', depth: 1,
      body: `<div class="container content">
  <div class="primary">
    <h1 class="site-heading">${MONTHS[m - 1]} ${y}</h1>
    <p style="margin:0 0 20px">
      ${prev ? `<a href="${prev}.html">&larr; ${label(prev)}</a>` : ''}
      ${next ? ` &nbsp; <a href="${next}.html">${label(next)} &rarr;</a>` : ''}
    </p>
    <div class="event-list">${inMonth.map((e) => eventCard(e, 1)).join('\n')}</div>
  </div>
  <aside class="sidebar">${calendarWidget(y, m, byDay, 1)}</aside>
</div>`,
    }));
  }

  const focusYm = `${focusDate.year}-${String(focusDate.month).padStart(2, '0')}`;
  const calLanding = months.includes(focusYm) ? focusYm : months[months.length - 1];
  await write('calendar/index.html', page({
    title: 'Calendar', current: 'calendar/', depth: 1,
    head: `<meta http-equiv="refresh" content="0; url=${calLanding}.html">\n`,
    body: `<div class="container content"><div class="primary">
  <h1 class="site-heading">Calendar</h1>
  <p><a href="${calLanding}.html">Go to ${MONTHS[+calLanding.split('-')[1] - 1]} ${calLanding.split('-')[0]} &rarr;</a></p>
</div></div>`,
  }));

  // --- archive ----------------------------------------------------------
  const years = [...new Set(past.map((e) => parts(e.start).year))].sort((a, b) => b - a);
  const yearNav = (cur) => `<p style="margin:0 0 20px">${years
    .map((y) => `<a href="${y}.html"${y === cur ? ' aria-current="page"' : ''}>${y}</a>`)
    .join(' &nbsp; ')}</p>`;

  for (const y of years) {
    const list = past.filter((e) => parts(e.start).year === y);
    await write(`archive/${y}.html`, page({
      title: `${y} Events`, current: 'archive/', depth: 1,
      body: `<div class="container content">
  <div class="primary">
    <h1 class="site-heading">${y}</h1>
    ${yearNav(y)}
    <div class="event-list">${list.map((e) => eventCard(e, 1)).join('\n')}</div>
  </div>
  <aside class="sidebar">${calendarWidget(y, 12, byDay, 1)}</aside>
</div>`,
    }));
  }

  await write('archive/index.html', page({
    title: 'Past Events', current: 'archive/', depth: 1,
    body: `<div class="container content">
  <div class="primary">
    <h1 class="site-heading">Past Events</h1>
    <p>${past.length} events listed since ${years[years.length - 1]}.</p>
    ${yearNav(null)}
    ${undated.length ? `<h2 class="section-heading">Undated listings</h2>
    <div class="event-list">${undated.map((e) => eventCard(e, 1)).join('\n')}</div>` : ''}
  </div>
  <aside class="sidebar">${calendarWidget(focusDate.year, focusDate.month, byDay, 1)}</aside>
</div>`,
  }));

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
  const simplePage = (file, title, current, inner) => write(file, page({
    title, current,
    body: `<div class="container page-header">
  <h1 class="page-title">${esc(title)}</h1>
</div>
<div class="container content">
  <div class="primary">
    ${inner}
  </div>
  <aside class="sidebar">${calendarWidget(focusDate.year, focusDate.month, byDay, 0)}</aside>
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

  await simplePage('submit.html', 'Submit Your Event', 'submit.html', `
  <p>Listings are free. We list concerts of Medieval, Renaissance and Baroque
  music in and around San Antonio.</p>
  <p><em>The submission form is not wired up yet &mdash; it needs the small
  moderation server described in CLAUDE.md. In the meantime please
  <a href="contact.html">get in touch</a> with the event name, date and time,
  venue, performers, ticket details and a link.</em></p>`);

  await simplePage('contact.html', 'Contact Us', 'contact.html', `
  <p><em>Contact details still to be filled in &mdash; the old site used a
  WPForms form that posted into WordPress.</em></p>`);

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
}

main().catch((err) => { console.error(err); process.exit(1); });
