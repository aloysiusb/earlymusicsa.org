#!/usr/bin/env node
/**
 * build.js — turn data/events.json into a static site in dist/.
 *
 * Everything the old EventON install did with 50 scripts is done here at build
 * time instead: the listings, the month grids, the per-event pages and the
 * .ics files are all plain HTML written once. The published site ships no
 * JavaScript at all — expand-in-place is <details>, and the calendar is a
 * table that degrades to a list on narrow screens via CSS.
 *
 *   node build.js
 */

import { mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const OUT = 'dist';
const SITE_NAME = 'Early Music San Antonio';
const TAGLINE = "Concerts of Medieval, Renaissance and Baroque music in and around San Antonio.";
const TZ = 'America/Chicago';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ------------------------------------------------------------------ util -- */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Strip anything we did not put there ourselves out of imported description HTML. */
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

/**
 * Point at the locally mirrored copy of an image rather than the WordPress
 * upload it came from — the whole point is that the new site does not depend
 * on the old one still being up. Same filename transform scrape.js used.
 * Falls back to the remote URL if the mirror is missing.
 */
function localImage(url, depth) {
  if (!url) return '';
  const name = decodeURIComponent(url.split('/').pop()).replace(/[^\w.\-]/g, '_');
  return existsSync(path.join('media', name)) ? `${'../'.repeat(depth)}media/${name}` : url;
}

/** Event dates are stored as ISO with a fixed offset — read the parts directly
 *  rather than going through Date, which would re-interpret them locally. */
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
  const suffix = p.hour < 12 ? 'am' : 'pm';
  return p.minute ? `${h12}:${String(p.minute).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

function timeRange(ev) {
  const s = parts(ev.start), e = parts(ev.end);
  if (!s) return 'Date to be announced';
  if (ev.allDay) return 'All day';
  // EventON writes 23:59 to mean "no end time given" — don't show that.
  if (!e || (e.hour === 23 && e.minute === 59)) return formatTime(s);
  return `${formatTime(s)} – ${formatTime(e)}`;
}

const longDate = (p) => p ? `${DOW[p.weekday]}, ${MONTHS[p.month - 1]} ${p.day}, ${p.year}` : 'Date to be announced';

/* ------------------------------------------------------------------ shell -- */

const NAV = [
  ['', 'Upcoming'],
  ['calendar/', 'Calendar'],
  ['archive/', 'Past Events'],
  ['submit.html', 'Submit an Event'],
  ['about.html', 'About'],
  ['contact.html', 'Contact'],
];

function page({ title, current = '', depth = 0, head = '', body }) {
  const root = depth ? '../'.repeat(depth) : '';
  const nav = NAV.map(([href, label]) => {
    const to = href === '' ? root || './' : root + href;
    const active = href === current ? ' aria-current="page"' : '';
    return `<li><a href="${esc(to)}"${active}>${esc(label)}</a></li>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(SITE_NAME)}</title>
<meta name="description" content="${esc(TAGLINE)}">
<link rel="stylesheet" href="${esc(root)}style.css">
${head}</head>
<body>
<header class="site-header">
  <div class="wrap">
    <p class="site-title"><a href="${esc(root || './')}">${esc(SITE_NAME)}</a></p>
    <nav class="site-nav" aria-label="Main"><ul>${nav}</ul></nav>
  </div>
</header>
<main class="wrap" id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>${esc(SITE_NAME)} is maintained by volunteers to help audiences find early
    music performances in the San Antonio area. Listings are free.</p>
    <p><a href="${esc(root)}submit.html">Submit an event</a> ·
       <a href="${esc(root)}contact.html">Contact</a></p>
  </div>
</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ cards -- */

function eventCard(ev, depth, { open = false } = {}) {
  const p = parts(ev.start);
  const root = '../'.repeat(depth);
  const chip = p
    ? `<span class="month">${MONTHS[p.month - 1].slice(0, 3)}</span>
       <span class="day">${p.day}</span>
       <span class="year">${p.year}</span>`
    : `<span class="month">Date</span><span class="day">TBA</span>`;

  const meta = [timeRange(ev), ev.location?.name, ev.organizer?.name]
    .filter(Boolean).map(esc).join(' <span class="sep">·</span> ');

  const facts = [];
  if (ev.performers) facts.push(['Performers', esc(ev.performers)]);
  if (ev.location?.name) {
    const addr = ev.location.address;
    const maps = addr
      ? ` <a href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(`${ev.location.name} ${addr}`)}" rel="noopener">map</a>`
      : '';
    facts.push(['Venue', esc(ev.location.name) + (addr ? `<br>${esc(addr)}` : '') + maps]);
  }
  if (ev.organizer?.name) facts.push(['Presented by', esc(ev.organizer.name)]);
  if (ev.tickets) facts.push(['Tickets', esc(ev.tickets)]);
  if (p) facts.push(['Date', esc(longDate(p)) + (ev.allDay ? '' : `, ${esc(timeRange(ev))}`)]);

  const actions = [];
  if (ev.website) actions.push(`<a class="button primary" href="${esc(ev.website)}" rel="noopener">Event website</a>`);
  if (p) actions.push(`<a class="button" href="${root}events/${esc(ev.slug)}.ics">Add to calendar</a>`);
  actions.push(`<a class="button" href="${root}events/${esc(ev.slug)}.html">Details</a>`);

  const figure = ev.image
    ? `<div class="event-figure"><img src="${esc(localImage(ev.image, depth))}" alt="" loading="lazy" width="640" height="427"></div>`
    : '';

  return `<details class="event"${open ? ' open' : ''}>
  <summary>
    <span class="date-chip${p ? '' : ' tba'}">${chip}</span>
    <span>
      <h2 class="event-heading">${esc(ev.title)}</h2>
      <p class="event-meta">${meta}</p>
    </span>
    <span class="chevron" aria-hidden="true"></span>
  </summary>
  <div class="event-body${figure ? ' has-image' : ''}">
    ${figure}
    <div class="event-prose">
      ${sanitize(ev.description) || '<p class="empty-note">No description was provided for this event.</p>'}
      <dl class="event-facts">
        ${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('\n        ')}
      </dl>
      <div class="actions">${actions.join('\n        ')}</div>
    </div>
  </div>
</details>`;
}

/* -------------------------------------------------------------- calendar -- */

function monthGrid(year, month, byDay, depth) {
  const root = '../'.repeat(depth);
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<td class="empty"></td>');
  for (let d = 1; d <= days; d++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const list = byDay.get(key) || [];
    const weekday = DOW[new Date(Date.UTC(year, month - 1, d)).getUTCDay()];
    const links = list.map((ev) =>
      `<li><a href="${root}events/${esc(ev.slug)}.html" title="${esc(ev.title)}">${esc(ev.title)}</a></li>`).join('');
    cells.push(`<td class="${list.length ? 'has-events' : ''}">
      <span class="daynum" data-weekday="${weekday}">${d}</span>
      ${links ? `<ul class="day-events">${links}</ul>` : ''}
    </td>`);
  }
  while (cells.length % 7) cells.push('<td class="empty"></td>');

  const rows = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);
  }

  return `<table class="calendar">
  <caption class="visually-hidden">Events in ${MONTHS[month - 1]} ${year}</caption>
  <thead><tr>${DOW.map((d) => `<th scope="col">${d}</th>`).join('')}</tr></thead>
  <tbody>${rows.join('\n')}</tbody>
</table>`;
}

/* ------------------------------------------------------------------- ics -- */

function icsFor(ev) {
  const stamp = (iso) => {
    const p = parts(iso);
    if (!p) return null;
    // Local time plus a TZID beats trying to hand-roll UTC conversion here.
    return `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`
      + `T${String(p.hour).padStart(2, '0')}${String(p.minute).padStart(2, '0')}00`;
  };
  const start = stamp(ev.start);
  if (!start) return null;
  // 23:59 is EventON's "no end time given". Emitting it would turn a recital
  // into a four-hour block in someone's calendar, so leave DTEND off instead
  // and let the client apply its own default length.
  const endParts = parts(ev.end);
  const end = (endParts && !(endParts.hour === 23 && endParts.minute === 59))
    ? stamp(ev.end) : null;
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  const fold = (line) => line.match(/.{1,73}/g).join('\r\n ');
  const clean = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/[;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');

  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Early Music San Antonio//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:earlymusicsa-${ev.id}@earlymusicsa.org`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=${TZ}:${start}`,
    end ? `DTEND;TZID=${TZ}:${end}` : '',
    fold(`SUMMARY:${clean(ev.title)}`),
    fold(`DESCRIPTION:${clean(ev.descriptionText).slice(0, 900)}`),
    ev.location?.name ? fold(`LOCATION:${clean([ev.location.name, ev.location.address].filter(Boolean).join(', '))}`) : '',
    ev.website ? `URL:${ev.website}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const { events } = JSON.parse(await readFile('data/events.json', 'utf8'));
  const live = events.filter((e) => !e.suspectedSpam);

  await rm(OUT, { recursive: true, force: true });
  for (const d of ['', 'events', 'calendar', 'archive']) {
    await mkdir(path.join(OUT, d), { recursive: true });
  }
  await copyFile('assets/style.css', path.join(OUT, 'style.css'));

  // Copy the mirrored images in so the built site has no dependency on the
  // old WordPress host.
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
  const past = dated.filter((e) => e.endUnix < now).reverse();

  const write = (rel, html) => writeFile(path.join(OUT, rel), html);

  // --- index ------------------------------------------------------------
  await write('index.html', page({
    title: 'Upcoming Events', current: '',
    body: `<div class="page-head">
  <h1>Upcoming events</h1>
  <p>${esc(TAGLINE)} Select any event to see full details.</p>
</div>
<div class="events">
${upcoming.length
      ? upcoming.map((e, i) => eventCard(e, 0, { open: i === 0 })).join('\n')
      : '<p class="empty-note">No upcoming events are listed just now. Please check back soon.</p>'}
</div>`,
  }));

  // --- month pages ------------------------------------------------------
  const byDay = new Map();
  for (const ev of dated) {
    const key = parts(ev.start).ymd;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(ev);
  }
  const months = [...new Set(dated.map((e) => parts(e.start).ymd.slice(0, 7)))].sort();

  for (const [i, ym] of months.entries()) {
    const [y, m] = ym.split('-').map(Number);
    const prev = months[i - 1], next = months[i + 1];
    const label = (s) => `${MONTHS[+s.split('-')[1] - 1]} ${s.split('-')[0]}`;
    await write(`calendar/${ym}.html`, page({
      title: `${MONTHS[m - 1]} ${y}`, current: 'calendar/', depth: 1,
      body: `<div class="page-head"><h1>Calendar</h1></div>
<div class="calendar-head">
  <p>${prev ? `<a href="${prev}.html">← ${label(prev)}</a>` : ''}</p>
  <h2>${MONTHS[m - 1]} ${y}</h2>
  <p>${next ? `<a href="${next}.html">${label(next)} →</a>` : ''}</p>
</div>
${monthGrid(y, m, byDay, 1)}
<p style="margin-top:1.5rem"><a href="../archive/">Browse the full archive by year →</a></p>`,
    }));
  }

  // Landing page for /calendar/ — the month containing the next event.
  const focus = (upcoming[0] && parts(upcoming[0].start).ymd.slice(0, 7))
    || months[months.length - 1];
  await write('calendar/index.html', page({
    title: 'Calendar', current: 'calendar/', depth: 1,
    head: `<meta http-equiv="refresh" content="0; url=${focus}.html">\n`,
    body: `<div class="page-head"><h1>Calendar</h1>
<p><a href="${focus}.html">Go to ${MONTHS[+focus.split('-')[1] - 1]} ${focus.split('-')[0]} →</a></p></div>`,
  }));

  // --- archive by year --------------------------------------------------
  const years = [...new Set(past.map((e) => parts(e.start).year))].sort((a, b) => b - a);
  const yearNav = (cur) => `<nav class="year-nav" aria-label="Archive years">${years
    .map((y) => `<a href="${y}.html"${y === cur ? ' aria-current="page"' : ''}>${y}</a>`).join('')}</nav>`;

  for (const y of years) {
    const list = past.filter((e) => parts(e.start).year === y);
    await write(`archive/${y}.html`, page({
      title: `${y} Events`, current: 'archive/', depth: 1,
      body: `<div class="page-head"><h1>${y}</h1>
<p>${list.length} event${list.length === 1 ? '' : 's'} listed in ${y}.</p></div>
${yearNav(y)}
<div class="events">${list.map((e) => eventCard(e, 1)).join('\n')}</div>`,
    }));
  }

  await write('archive/index.html', page({
    title: 'Past Events', current: 'archive/', depth: 1,
    body: `<div class="page-head"><h1>Past events</h1>
<p>${past.length} events listed since ${years[years.length - 1]}. Choose a year.</p></div>
${yearNav(null)}
${undated.length ? `<h2 style="margin-top:2rem">Undated listings</h2>
<p class="empty-note">These were listed without a date.</p>
<div class="events">${undated.map((e) => eventCard(e, 1)).join('\n')}</div>` : ''}`,
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
    await write(`events/${ev.slug}.html`, page({
      title: ev.title, depth: 1,
      head: `<script type="application/ld+json">${JSON.stringify(ld)}</script>\n`,
      body: `<div class="page-head">
  <p><a href="../">← All events</a></p>
  <h1>${esc(ev.title)}</h1>
  <p>${esc(longDate(p))}${p && !ev.allDay ? ` · ${esc(timeRange(ev))}` : ''}</p>
</div>
<div class="events">${eventCard(ev, 1, { open: true })}</div>`,
    }));

    const ics = icsFor(ev);
    if (ics) await writeFile(path.join(OUT, 'events', `${ev.slug}.ics`), ics);
  }

  // --- static pages -----------------------------------------------------
  await write('about.html', page({
    title: 'About', current: 'about.html',
    body: `<div class="page-head"><h1>About</h1></div>
<div class="measure">
<p>${esc(SITE_NAME)} is maintained by volunteers who seek to expand audience
awareness of performances in the San Antonio area. We believe many people would
like to hear early music but have not always been aware of what is happening —
and that the more people know, the more the audience grows, which helps
everyone: performers, audiences, and the community.</p>
<p>This site is free to use and free to list on. If you have an event of
Medieval, Renaissance or Baroque music you would like listed, please
<a href="submit.html">send it to us</a>.</p>
<p>If you are scheduling events, you can reach a larger audience by checking
this site for open dates.</p>
</div>`,
  }));

  await write('submit.html', page({
    title: 'Submit an Event', current: 'submit.html',
    body: `<div class="page-head"><h1>Submit an event</h1>
<p>Listings are free. We list concerts of Medieval, Renaissance and Baroque
music in and around San Antonio.</p></div>
<div class="measure">
<p class="empty-note">The submission form is not wired up yet — this page is a
placeholder from the static build. It needs the small server described in
CLAUDE.md (submission goes to a moderation queue, a volunteer approves it, and
the next build picks it up).</p>
<p>In the meantime, please <a href="contact.html">get in touch</a> with the
event name, date and time, venue, performers, ticket details and a link.</p>
</div>`,
  }));

  await write('contact.html', page({
    title: 'Contact', current: 'contact.html',
    body: `<div class="page-head"><h1>Contact</h1></div>
<div class="measure">
<p class="empty-note">Contact details still to be filled in — the old site used
a WPForms form that posted into WordPress.</p>
</div>`,
  }));

  console.log(`Built ${OUT}/`);
  console.log(`  ${upcoming.length} upcoming · ${past.length} past · ${undated.length} undated`);
  console.log(`  ${months.length} month pages · ${years.length} archive years · ${live.length} event pages`);
  console.log(`  ${copied} images mirrored locally`);

  const remote = [...(await readFile(path.join(OUT, 'index.html'), 'utf8'))
    .matchAll(/src="(https?:[^"]+)"/g)].length;
  if (remote) console.warn(`  WARNING: ${remote} image(s) still point at a remote host`);
}

main().catch((err) => { console.error(err); process.exit(1); });
