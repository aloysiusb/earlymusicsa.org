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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;700;800&display=swap">
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

${body}

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

function eventCard(ev, depth, { eager = false } = {}) {
  const p = parts(ev.start);
  const href = `${'../'.repeat(depth)}events/${esc(ev.slug)}.html`;
  const thumb = ev.image
    // `sizes` is parsed by the HTML parser, not CSS — it takes a plain length,
    // never a var(). Keep this in step with --thumb-size in style.css.
    ? `<div class="event-thumb">${responsiveImg(ev, { sizes: '140px', depth, square: THUMB, eager })}</div>`
    : '';

  const venue = [ev.location?.name, ev.organizer?.name].filter(Boolean).join(' &middot; ');

  return `<article class="event-card">
  <h2 class="event-title"><a href="${href}">${esc(ev.title)}</a></h2>
  <div class="event-inner">
    ${thumb}
    <div class="event-date">
      ${p ? `<span class="year">${p.year}</span>
      <span class="day">${p.day}</span>
      <span class="month">${MONTHS[p.month - 1].slice(0, 3)}</span>` : '<span class="day">TBA</span>'}
    </div>
    <div class="event-info">
      <p class="event-time">${esc(timeRange(ev))}</p>
      ${CARD_DETAILS && venue ? `<p class="event-venue">${venue}</p>` : ''}
      ${CARD_DETAILS && ev.descriptionText ? `<p class="event-summary">${esc(excerpt(ev.descriptionText))}</p>` : ''}
    </div>
  </div>
</article>`;
}

/* --------------------------------------------------------- sidebar widget -- */

function calendarWidget(year, month, byDay, depth) {
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

  return `<div class="cal-widget">
  <h2 class="cal-widget-title">Events Calendar</h2>
  <div class="cal-buttons">
    <a class="cal-button" href="${root}calendar/">Jump Months</a>
    <a class="cal-button" href="${root}calendar/">Current Month</a>
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
</div>`;
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

  const dated = live.filter((e) => e.start).sort((a, b) => a.startUnix - b.startUnix);
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
  <main class="primary">
    <h1 class="page-title">Upcoming Events</h1>
    <div class="event-list">
${shown.length
      ? shown.map((e, i) => eventCard(e, 0, { eager: i < 2 })).join('\n')
      : '<p>No upcoming events are listed just now. Please check back soon.</p>'}
    </div>
    ${upcoming.length > HOME_LIMIT || past.length
      ? '<a class="show-more" href="archive/">Show More Events</a>' : ''}
  </main>
  <aside class="sidebar">
${calendarWidget(focusDate.year, focusDate.month, byDay, 0)}
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
  <main class="primary">
    <h1 class="page-title">${MONTHS[m - 1]} ${y}</h1>
    <p style="margin:0 0 20px">
      ${prev ? `<a href="${prev}.html">&larr; ${label(prev)}</a>` : ''}
      ${next ? ` &nbsp; <a href="${next}.html">${label(next)} &rarr;</a>` : ''}
    </p>
    <div class="event-list">${inMonth.map((e) => eventCard(e, 1)).join('\n')}</div>
  </main>
  <aside class="sidebar">${calendarWidget(y, m, byDay, 1)}</aside>
</div>`,
    }));
  }

  const focusYm = `${focusDate.year}-${String(focusDate.month).padStart(2, '0')}`;
  const calLanding = months.includes(focusYm) ? focusYm : months[months.length - 1];
  await write('calendar/index.html', page({
    title: 'Calendar', current: 'calendar/', depth: 1,
    head: `<meta http-equiv="refresh" content="0; url=${calLanding}.html">\n`,
    body: `<div class="container content"><main class="primary">
  <h1 class="page-title">Calendar</h1>
  <p><a href="${calLanding}.html">Go to ${MONTHS[+calLanding.split('-')[1] - 1]} ${calLanding.split('-')[0]} &rarr;</a></p>
</main></div>`,
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
  <main class="primary">
    <h1 class="page-title">${y}</h1>
    ${yearNav(y)}
    <div class="event-list">${list.map((e) => eventCard(e, 1)).join('\n')}</div>
  </main>
  <aside class="sidebar">${calendarWidget(y, 12, byDay, 1)}</aside>
</div>`,
    }));
  }

  await write('archive/index.html', page({
    title: 'Past Events', current: 'archive/', depth: 1,
    body: `<div class="container content">
  <main class="primary">
    <h1 class="page-title">Past Events</h1>
    <p>${past.length} events listed since ${years[years.length - 1]}.</p>
    ${yearNav(null)}
    ${undated.length ? `<h2 class="cal-widget-title">Undated listings</h2>
    <div class="event-list">${undated.map((e) => eventCard(e, 1)).join('\n')}</div>` : ''}
  </main>
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
  <main class="primary">
    <p style="margin:30px 0 0"><a href="../">&larr; All events</a></p>
    <h1 class="page-title">${esc(ev.title)}</h1>
    ${ev.image ? `<p>${responsiveImg(ev, { sizes: '(max-width: 782px) 100vw, 700px', depth: 1 })}</p>` : ''}
    ${sanitize(ev.description) || '<p>No description was provided for this event.</p>'}
    <dl>${facts.map(([k, v]) => `<dt><strong>${k}</strong></dt><dd style="margin:0 0 10px">${v}</dd>`).join('')}</dl>
    <p>
      ${ev.website ? `<a href="${esc(ev.website)}" rel="noopener">Event website</a> &nbsp; ` : ''}
      ${p ? `<a href="${esc(ev.slug)}.ics">Add to calendar</a>` : ''}
    </p>
  </main>
  <aside class="sidebar">${calendarWidget(p?.year || focusDate.year, p?.month || focusDate.month, byDay, 1)}</aside>
</div>`,
    }));

    const ics = icsFor(ev);
    if (ics) await writeFile(path.join(OUT, 'events', `${ev.slug}.ics`), ics);
  }

  // --- static pages -----------------------------------------------------
  const simplePage = (file, title, current, inner) => write(file, page({
    title, current,
    body: `<div class="container content"><main class="primary">
  <h1 class="page-title">${esc(title)}</h1>
  ${inner}
</main></div>`,
  }));

  await simplePage('about.html', 'About', 'about.html', `
  <p>${esc(SITE_NAME)} is maintained by volunteers who seek to expand audience
  awareness of performances in the San Antonio area. We believe many people
  would like to hear early music but have not always been aware of what is
  happening &mdash; and that the more people know, the more the audience grows,
  which helps everyone: performers, audiences, and the community.</p>
  <p>If you have an event of Medieval, Renaissance or Baroque music you would
  like listed, please <a href="submit.html">send it to us</a>. Listings are free.</p>
  <p>If you are scheduling events, you can reach a larger audience by checking
  this site for open dates.</p>`);

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

  const remote = [...(await readFile(path.join(OUT, 'index.html'), 'utf8'))
    .matchAll(/(?:src|url\()="?(https?:[^")\s]+)/g)]
    .filter((m) => !m[1].includes('fonts.googleapis') && !m[1].includes('fonts.gstatic'));
  if (remote.length) console.warn(`  WARNING: ${remote.length} remote asset(s) on the home page`);
}

main().catch((err) => { console.error(err); process.exit(1); });
