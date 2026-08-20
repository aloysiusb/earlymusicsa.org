#!/usr/bin/env node
/**
 * scrape.js — one-time export of earlymusicsa.org's EventON content to clean JSON.
 *
 * The WordPress REST API gives us the post record (title, description, taxonomy
 * slugs) but EventON keeps dates, times and venues in postmeta that is never
 * exposed over REST. Those only exist in the rendered page, as a `data-time`
 * pair of UTC unix timestamps plus `data-location_*` attributes. So: one REST
 * sweep for the records, then one page fetch per event for the timing.
 *
 * Event pages are cached under cache/ so re-runs cost nothing. Delete cache/ to
 * force a fresh pull.
 *
 *   node scrape.js            # events + venues + organizers -> data/
 *   node scrape.js --images   # also download every featured image -> media/
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SITE = 'https://earlymusicsa.org';
const TZ = 'America/Chicago';
const CONCURRENCY = 4;
const WANT_IMAGES = process.argv.includes('--images');

/* ------------------------------------------------------------------ text --
 * The source data has two layers of damage: HTML entities (sometimes double
 * encoded, e.g. `&amp;amp;`) and cp1252 mojibake from an old migration, which
 * is why the location list contains both `Mission ConcepciÃ³n` and
 * `St. Maryâ€™s University`.
 */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', hellip: '…',
  ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“',
  rdquo: '”', middot: '·', bull: '•', eacute: 'é', egrave: 'è',
  uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', ntilde: 'ñ', oacute: 'ó',
  aacute: 'á', iacute: 'í', uacute: 'ú', deg: '°', copy: '©', reg: '®',
};

function decodeEntities(s) {
  if (!s) return s;
  let prev;
  do {
    prev = s;
    s = s
      .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
      .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
  } while (s !== prev);
  return s;
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

// Reverse of "UTF-8 bytes decoded as cp1252". Bytes 0x80-0x9F map to distinct
// codepoints in cp1252, so they have to be mapped back explicitly.
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// A UTF-8 continuation byte (0x80-0xBF) rendered through cp1252: 0xA0-0xBF map
// to themselves, 0x80-0x9F to the printable characters above.
const CONT = '[\\u00A0-\\u00BF\\u0080-\\u009F\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021'
  + '\\u02C6\\u2030\\u0160\\u2039\\u0152\\u017D\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013'
  + '\\u2014\\u02DC\\u2122\\u0161\\u203A\\u0153\\u017E\\u0178]';
const MOJIBAKE = new RegExp(
  `[\\u00C2-\\u00DF]${CONT}|[\\u00E0-\\u00EF]${CONT}{2}|[\\u00F0-\\u00F4]${CONT}{3}`, 'g',
);

/**
 * Repair only the damaged runs rather than round-tripping whole strings —
 * descriptions routinely mix `Ã©` with correctly-encoded curly quotes, and a
 * whole-string conversion has to give up on those.
 */
function fixMojibake(s) {
  if (!s || !/[Â-ô]/.test(s)) return s;
  for (let pass = 0; pass < 3; pass++) {
    const next = s.replace(MOJIBAKE, (seq) => {
      const bytes = [];
      for (const ch of seq) {
        const c = ch.codePointAt(0);
        const b = c <= 0xff ? c : CP1252[c];
        if (b === undefined) return seq;
        bytes.push(b);
      }
      const out = Buffer.from(bytes).toString('utf8');
      return out.includes('�') ? seq : out;
    });
    if (next === s) break;
    s = next;
  }
  // A lead byte stranded before ordinary whitespace is what is left of a
  // non-breaking space whose trailing byte was already lost in WordPress.
  return s.replace(/\u00C2(?=[\s\u2028\u2029]|$)/g, '');
}

const stripTags = (h) => (h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');

/** Full clean: entities -> mojibake -> whitespace. For plain-text fields. */
function clean(s) {
  return fixMojibake(decodeEntities(s || ''))
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clean while keeping the inline HTML (for descriptions). */
function cleanHtml(s) {
  return fixMojibake(s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * WordPress sanitize_title_with_dashes. Note it *deletes* punctuation rather
 * than replacing it, so `info@lafollia.org` becomes `infolafollia-org` and
 * `St. Mark's` becomes `st-marks` — replacing with dashes instead would fail
 * to match the taxonomy slugs the REST API hands back.
 */
function slugify(s) {
  return clean(s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Aggressive key used only to spot duplicate venue/organizer records. */
function dedupeKey(s) {
  return clean(s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(the|of|at|on|in|a)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/* ------------------------------------------------------------------ time -- */

function tzOffset(date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName').value;
  return part.replace('GMT', '') || '+00:00';
}

/** Unix seconds -> ISO 8601 with the venue's local offset, e.g. 2026-09-11T19:30:00-05:00 */
function toLocalIso(unix) {
  const d = new Date(unix * 1000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}${tzOffset(d)}`;
}

/* ------------------------------------------------------------------ http -- */

async function fetchText(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'earlymusicsa-migration/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === tries) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

async function cachedPage(id, url) {
  const file = `cache/${id}.html`;
  if (existsSync(file)) return readFile(file, 'utf8');
  const html = await fetchText(url);
  await writeFile(file, html);
  await new Promise((r) => setTimeout(r, 150)); // be polite to the shared host
  return html;
}

/** Run `worker` over `items`, CONCURRENCY at a time, reporting progress. */
async function pool(items, worker, label) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { __error: String(err.message || err) };
      }
      if (++done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r  ${label}: ${done}/${items.length}`);
      }
    }
  }));
  process.stdout.write('\n');
  return results;
}

/* ------------------------------------------------------------------ parse -- */

const attr = (html, name) => {
  const m = html.match(new RegExp(`data-${name}=["']([^"']*)["']`));
  return m ? m[1] : '';
};

/**
 * Pull one EventON detail row. Each row renders as
 *   <div class='evo_metarow_KEY ...'> ... <h3 class='evo_h3'>Label</h3>
 *   <div class='evo_custom_content_in'>VALUE</div>
 * so we slice from the row marker to whichever comes first: the next row, or
 * the end of the card.
 */
function metaRow(html, key) {
  const start = html.indexOf(`evo_metarow_${key}`);
  if (start < 0) return null;
  const rest = html.slice(start);
  const nextRow = rest.slice(20).search(/evo_metarow_/);
  return nextRow > 0 ? rest.slice(0, nextRow + 20) : rest.slice(0, 20000);
}

function customField(html, key) {
  const row = metaRow(html, key);
  if (!row) return null;
  const label = clean(stripTags(row.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] || ''));
  const inner = row.match(/evo_custom_content_in['"][^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  const value = clean(stripTags(inner));
  return value ? { label, value } : null;
}

function learnMoreUrl(html) {
  const row = metaRow(html, 'learnM');
  if (!row) return '';
  const href = row.match(/href=['"]([^'"]+)['"]/)?.[1] || '';
  // These links carry Google Analytics cross-domain junk (`?_gl=...`). Strip it.
  try {
    const u = new URL(decodeEntities(href));
    u.searchParams.delete('_gl');
    if (![...u.searchParams].length) u.search = '';
    return u.toString();
  } catch { return decodeEntities(href); }
}

/**
 * Every instance of this event on the page (a repeating event has several).
 * EventON writes a zero unix timestamp when a record has no date set at all,
 * which renders as 1970 — treat anything before 2000 as "no date".
 */
const EPOCH_FLOOR = 946684800; // 2000-01-01Z

function instances(html, id) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(`event_${id}_(\\d+)`, 'g');
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    const t = html.slice(m.index, m.index + 4000).match(/data-time=["'](\d+)-(\d+)["']/);
    if (!t) continue;
    seen.add(m[1]);
    const start = Number(t[1]);
    if (start < EPOCH_FLOOR) continue;
    out.push({ start, end: Number(t[2]) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------- spam -- */

const SPAM_ORGANIZER = /inovine|inscitech|intelli global|pages conferences|^pages$|scientific (summits|meetings|conference)|research connects|vartus|neuroscience 20|innovating skin science|sia paul|^spectrum$/i;
const SPAM_TITLE = /\b(conference|congress|summit|webinar|expo)\b|dermatolog|neuroscien|nursing|oncolog|pharma/i;
const FOREIGN = /netherlands|japan|switzerland|germany|italy|france|,\s*uk$|^london|czechia|hungary|australia|prague|zurich|zürich/i;

function spamScore(ev) {
  const reasons = [];
  if (ev.organizer && SPAM_ORGANIZER.test(ev.organizer.name)) reasons.push('organizer-pattern');
  if (SPAM_TITLE.test(ev.title)) reasons.push('title-pattern');
  if (ev.location && FOREIGN.test(ev.location.name)) reasons.push('non-local-venue');
  return reasons;
}

/* ------------------------------------------------------------------- main -- */

async function main() {
  await mkdir('cache', { recursive: true });
  await mkdir('data', { recursive: true });

  const masters = JSON.parse(await readFile('seed/masters.json', 'utf8'));
  const aliases = JSON.parse(await readFile('seed/aliases.json', 'utf8'));

  // slug -> {id, name} so we can turn `event_organizer-arts-on-alexander`
  // (all the REST API gives us) back into a display name.
  const bySlug = (pairs, aliasMap) => {
    const map = new Map();
    for (const [id, raw] of pairs) {
      const name = clean(stripTags(raw));
      map.set(slugify(name), { id, name: aliasMap[id] || name, raw: name });
    }
    return map;
  };
  const locBySlug = bySlug(masters.locations, aliases.locations);
  const orgBySlug = bySlug(masters.organizers, aliases.organizers);

  // --- event type names -------------------------------------------------
  console.log('Fetching event types…');
  const typeNames = new Map();
  for (let page = 1; ; page++) {
    const raw = await fetchText(`${SITE}/wp-json/wp/v2/event_type?per_page=100&page=${page}&_fields=id,slug,name`);
    const terms = JSON.parse(raw);
    for (const t of terms) typeNames.set(t.id, { slug: t.slug, name: clean(t.name) });
    if (terms.length < 100) break;
  }
  console.log(`  ${typeNames.size} types`);

  // --- event records ----------------------------------------------------
  console.log('Fetching event records…');
  const records = [];
  const fields = 'id,slug,link,title,content,date,modified,class_list,event_type,status,featured_media';
  for (let page = 1; ; page++) {
    const raw = await fetchText(`${SITE}/wp-json/wp/v2/ajde_events?per_page=100&page=${page}&orderby=id&order=asc&_fields=${fields}`);
    const batch = JSON.parse(raw);
    records.push(...batch);
    if (batch.length < 100) break;
  }
  console.log(`  ${records.length} events`);

  // --- featured image variants -----------------------------------------
  // WordPress already generated a set of resized copies of every upload, so
  // take those rather than shipping one full-size file to every screen. They
  // become the srcset in build.js.
  console.log('Fetching image variants…');
  const mediaIds = [...new Set(records.map((r) => r.featured_media).filter(Boolean))];
  const mediaById = new Map();
  for (let i = 0; i < mediaIds.length; i += 100) {
    const chunk = mediaIds.slice(i, i + 100).join(',');
    const raw = await fetchText(
      `${SITE}/wp-json/wp/v2/media?include=${chunk}&per_page=100&_fields=id,source_url,alt_text,media_details`,
    );
    for (const m of JSON.parse(raw)) {
      const d = m.media_details || {};
      const seen = new Set();
      const variants = Object.values(d.sizes || {})
        .filter((s) => s.source_url && s.width >= 200)
        .filter((s) => !seen.has(s.width) && seen.add(s.width))
        .sort((a, b) => a.width - b.width)
        .map((s) => ({ url: s.source_url, width: s.width, height: s.height }));
      if (d.file && d.width >= 200 && !variants.some((v) => v.width === d.width)) {
        variants.push({ url: m.source_url, width: d.width, height: d.height });
      }
      mediaById.set(m.id, {
        full: m.source_url,
        width: d.width || null,
        height: d.height || null,
        alt: clean(m.alt_text || ''),
        variants: variants.sort((a, b) => a.width - b.width),
      });
    }
  }
  console.log(`  ${mediaById.size} images, ${[...mediaById.values()].reduce((a, m) => a + m.variants.length, 0)} size variants`);

  // --- per-event pages --------------------------------------------------
  console.log('Fetching event pages (cached after first run)…');
  const pages = await pool(records, (r) => cachedPage(r.id, r.link), 'pages');

  // --- assemble ---------------------------------------------------------
  const events = [];
  const problems = [];
  const seenLoc = new Map();
  const seenOrg = new Map();

  records.forEach((rec, i) => {
    const html = pages[i];
    if (!html || html.__error) {
      problems.push({ id: rec.id, slug: rec.slug, issue: 'page fetch failed', detail: html?.__error });
      return;
    }

    const classes = rec.class_list || [];
    const locSlug = classes.find((c) => c.startsWith('event_location-'))?.slice(15) || '';
    const orgSlug = classes.find((c) => c.startsWith('event_organizer-'))?.slice(16) || '';

    const locid = attr(html, 'locid');
    const locNameRaw = clean(stripTags(attr(html, 'location_name')));
    const master = locBySlug.get(locSlug);
    const location = (locid || locNameRaw || master) ? {
      id: locid || master?.id || null,
      name: aliases.locations[locid] || master?.name || locNameRaw,
      rawName: locNameRaw || master?.raw || '',
      address: clean(stripTags(attr(html, 'location_address'))),
    } : null;

    const org = orgBySlug.get(orgSlug);
    const organizer = org ? { id: org.id, name: org.name, rawName: org.raw } : null;

    const inst = instances(html, rec.id);
    if (!inst.length) {
      problems.push({
        id: rec.id, slug: rec.slug, title: clean(rec.title?.rendered || ''),
        issue: 'no date set in EventON', url: rec.link,
      });
    }

    // An all-day event is stored 00:00–23:59 local.
    const allDay = inst.length > 0 && inst.every(({ start, end }) =>
      toLocalIso(start).slice(11, 16) === '00:00' && toLocalIso(end).slice(11, 16) === '23:59');

    const media = mediaById.get(rec.featured_media);
    const descHtml = cleanHtml(decodeEntities(rec.content?.rendered || ''));
    const ev = {
      id: rec.id,
      slug: rec.slug,
      title: clean(rec.title?.rendered || ''),
      status: rec.status,
      start: inst[0] ? toLocalIso(inst[0].start) : null,
      end: inst[0] ? toLocalIso(inst[0].end) : null,
      startUnix: inst[0]?.start ?? null,
      endUnix: inst[0]?.end ?? null,
      allDay,
      repeats: inst.length > 1 ? inst.map(({ start, end }) => ({
        start: toLocalIso(start), end: toLocalIso(end), startUnix: start, endUnix: end,
      })) : null,
      location,
      organizer,
      types: (rec.event_type || []).map((id) => typeNames.get(id)).filter(Boolean),
      description: descHtml,
      descriptionText: clean(stripTags(descHtml)),
      image: media?.full
        || decodeEntities(html.match(/<meta property=["']og:image["'] content=["']([^"']+)["']/)?.[1] || ''),
      imageAlt: media?.alt || '',
      imageWidth: media?.width ?? null,
      imageHeight: media?.height ?? null,
      imageVariants: media?.variants?.length ? media.variants : null,
      website: learnMoreUrl(html),
      sourceUrl: rec.link,
      publishedAt: rec.date,
      modifiedAt: rec.modified,
    };

    for (const key of ['cusF1', 'cusF2', 'cusF3', 'cusF4']) {
      const f = customField(html, key);
      if (!f) continue;
      if (/performer/i.test(f.label)) ev.performers = f.value;
      else if (/ticket/i.test(f.label)) ev.tickets = f.value;
      else (ev.extra ??= {})[f.label] = f.value;
    }

    const reasons = spamScore(ev);
    if (reasons.length) { ev.suspectedSpam = true; ev.spamReasons = reasons; }

    if (location?.id) seenLoc.set(String(location.id), location);
    if (organizer?.id) seenOrg.set(String(organizer.id), organizer);
    events.push(ev);
  });

  events.sort((a, b) => (b.startUnix ?? 0) - (a.startUnix ?? 0));

  // --- venues & organizers, merged by canonical name --------------------
  const collapse = (seen, usedBy) => {
    const out = new Map();
    for (const item of seen.values()) {
      const key = dedupeKey(item.name);
      const entry = out.get(key) || {
        name: item.name, slug: slugify(item.name), sourceIds: [], addresses: [], eventCount: 0,
      };
      if (!entry.sourceIds.includes(item.id)) entry.sourceIds.push(item.id);
      if (item.address && !entry.addresses.includes(item.address)) entry.addresses.push(item.address);
      out.set(key, entry);
    }
    for (const ev of events) {
      const it = usedBy(ev);
      if (!it) continue;
      const entry = out.get(dedupeKey(it.name));
      if (entry) entry.eventCount++;
    }
    return [...out.values()]
      .map((e) => (e.addresses.length ? e : (delete e.addresses, e)))
      .sort((a, b) => b.eventCount - a.eventCount || a.name.localeCompare(b.name));
  };

  const locations = collapse(seenLoc, (ev) => ev.location);
  const organizers = collapse(seenOrg, (ev) => ev.organizer);

  // Near-duplicates the automatic pass could not safely merge.
  const suggestMerges = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = dedupeKey(list[i].name), b = dedupeKey(list[j].name);
        const d = levenshtein(a, b);
        if (d > 0 && d <= Math.max(2, Math.min(a.length, b.length) * 0.18)) {
          out.push({ distance: d, a: list[i].name, b: list[j].name, aEvents: list[i].eventCount, bEvents: list[j].eventCount });
        }
      }
    }
    return out.sort((x, y) => x.distance - y.distance);
  };

  const spam = events.filter((e) => e.suspectedSpam);
  const dated = events.filter((e) => e.startUnix);
  const report = {
    scrapedAt: new Date().toISOString(),
    source: SITE,
    timezone: TZ,
    events: events.length,
    withDates: dated.length,
    suspectedSpam: spam.length,
    locations: locations.length,
    organizers: organizers.length,
    eventTypes: typeNames.size,
    dateRange: dated.length
      ? { earliest: toLocalIso(Math.min(...dated.map((e) => e.startUnix))),
          latest: toLocalIso(Math.max(...dated.map((e) => e.startUnix))) }
      : null,
    withImage: events.filter((e) => e.image).length,
    withPerformers: events.filter((e) => e.performers).length,
    withTickets: events.filter((e) => e.tickets).length,
    withWebsite: events.filter((e) => e.website).length,
    problems,
  };

  const write = (name, data) => writeFile(`data/${name}`, JSON.stringify(data, null, 2) + '\n');
  await write('events.json', { ...report, problems: undefined, events });
  await write('locations.json', locations);
  await write('organizers.json', organizers);
  await write('event-types.json', [...typeNames.values()].sort((a, b) => a.name.localeCompare(b.name)));
  await write('review-merges.json', {
    _note: 'Near-duplicate names the script would not merge on its own. Confirm each, then add the EventON ids to seed/aliases.json and re-run.',
    locations: suggestMerges(locations),
    organizers: suggestMerges(organizers),
  });
  await write('report.json', report);

  if (WANT_IMAGES) {
    await mkdir('media', { recursive: true });
    const urls = [...new Set([
      ...events.flatMap((e) => [e.image, ...(e.imageVariants || []).map((v) => v.url)]),
      // Theme assets the design depends on. The header banner lives on a
      // leftover Bluehost staging domain, so mirroring it matters more than most.
      'https://earlymusicsa.org/wp-content/uploads/2023/07/Early-Music-SA-Logo-wt.png',
      'https://qtz.bhi.mybluehost.me/EarlyMusicSa/wp-content/uploads/2023/08/Giovanni_Pauolo_2000x400.jpg',
    ].filter(Boolean))];
    console.log(`Downloading ${urls.length} images…`);
    await pool(urls, async (url) => {
      const file = `media/${decodeURIComponent(url.split('/').pop()).replace(/[^\w.\-]/g, '_')}`;
      if (existsSync(file)) return;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
    }, 'images');
  }

  console.log('\n--- summary ---');
  for (const [k, v] of Object.entries(report)) {
    if (k === 'problems') continue;
    console.log(`  ${k.padEnd(15)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  if (problems.length) console.log(`  problems        ${problems.length} (see data/report.json)`);
  console.log('\nWrote data/events.json, locations.json, organizers.json, event-types.json, review-merges.json, report.json');
}

main().catch((err) => { console.error(err); process.exit(1); });
