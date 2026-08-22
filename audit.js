#!/usr/bin/env node
/**
 * audit.js — find EventON data the export is dropping.
 *
 * The scraper reads specific attributes out of the cached event pages, which
 * means anything not explicitly looked for is silently lost. `data-colr` (the
 * per-event card colour) was missed that way for days. This walks every cached
 * page, tallies every data-* attribute, detail row and state class EventON
 * emits, and reports which ones the export actually keeps.
 *
 *   node audit.js            # summary
 *   node audit.js --values   # also show sample values for unkept fields
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const CACHE = 'cache';
const SHOW_VALUES = process.argv.includes('--values');

/**
 * Attributes the export reads, and where they end up — plus the ones checked
 * and deliberately skipped, so anything genuinely new stands out. Verified
 * 2026-08-22 across all 419 cached pages.
 */
const KEPT = {
  time: 'start / end / instances',
  colr: 'color',
  locid: 'location.id',
  location_name: 'location.name',
  location_address: 'location.address',
  latlng: 'location.lat / lon',
  event_id: 'id',
  location_url: 'skipped — taxonomy archive link',
  location_type: 'skipped — internal',
  location_status: 'skipped — internal',
  ri: 'skipped — repeat index, handled via /var/ri-N',

  // Checked and found to carry nothing the export needs.
  img: 'skipped — identical to the featured image on all 402 (verified)',
  thumb: 'skipped — same image again',
  bgcolor: 'skipped — duplicate of colr, on the date block',
  bgc: 'skipped — duplicate of colr, on the lightbox',
  bggrad: 'skipped — empty on every event (verified)',
  smon: 'skipped — display string, derived from time',
  syr: 'skipped — display string, derived from time',
  gmtrig: 'skipped — map lazy-load trigger',
  exlk: 'skipped — external-link flag',
  ux_val: 'skipped — click behaviour setting',
  ux_val_mob: 'skipped — click behaviour setting, mobile',
  bub: 'skipped — hover bubble text, empty here',
  gmap_status: 'skipped — null on all 14 that have it',
  d: 'skipped — lightbox loader internals',
  c: 'skipped — lightbox loader internals',
  t: 'skipped — lightbox placeholder text',
  f: 'skipped — lightbox image loader',
  h: 'skipped — lightbox image loader',
  w: 'skipped — lightbox image loader',
  ratio: 'skipped — lightbox image loader',
};

/** Detail rows the export reads. */
const KEPT_ROWS = {
  details: 'description',
  cusF1: 'performers',
  cusF2: 'tickets',
  learnM: 'website',
  time_location: 'location.*',
  time: 'skipped - duplicate of the date block',
  learnmore: 'skipped - wrapper around learnM',
  gmap: 'location.lat / lon',
};

const IGNORE_ATTR = /^(wp-|elementor|jetpack|sharing|nonce|settings|id|type|src|href|width|height|style|class|title|alt|role|aria)/i;

function tally(map, key, value) {
  if (!map.has(key)) map.set(key, { count: 0, samples: new Set() });
  const e = map.get(key);
  e.count++;
  if (value && e.samples.size < 4 && value.length < 70) e.samples.add(value);
}

async function main() {
  const files = (await readdir(CACHE))
    .filter((f) => /^\d+\.html$/.test(f)); // skip the -riN repeat probes

  const attrs = new Map();
  const rows = new Map();
  const stateClasses = new Map();
  const customFields = new Map();

  for (const f of files) {
    const html = await readFile(path.join(CACHE, f), 'utf8');
    const id = f.replace('.html', '');

    // Scope to the event's own card where possible, so sidebar and related
    // events do not pollute the tally.
    const own = html.match(new RegExp(`<div id="event_${id}_0"[\\s\\S]{0,4000}`))?.[0] || html;

    for (const m of own.matchAll(/\sdata-([a-z0-9_]+)=["']([^"']*)["']/gi)) {
      if (IGNORE_ATTR.test(m[1])) continue;
      tally(attrs, m[1].toLowerCase(), m[2]);
    }
    for (const m of html.matchAll(/evo_metarow_([a-zA-Z0-9]+)/g)) {
      tally(rows, m[1], '');
    }
    // The label EventON gives each custom field, so an unread cusF3 is visible.
    for (const m of html.matchAll(/evo_metarow_(cusF\d)[\s\S]{0,400}?<h3[^>]*>([^<]{1,40})<\/h3>/g)) {
      tally(customFields, m[1], m[2].trim());
    }
    const cls = own.match(/class="(eventon_list_event[^"]*)"/)?.[1] || '';
    for (const c of cls.split(/\s+/)) {
      if (/^(eventon_list_event|event|evo_eventtop|event_\d+_\d+)$/.test(c) || !c) continue;
      tally(stateClasses, c, '');
    }
  }

  const report = (title, map, kept) => {
    console.log(`\n=== ${title} ===`);
    const rowsOut = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [name, e] of rowsOut) {
      const mark = kept?.[name] ? `kept -> ${kept[name]}` : 'NOT EXPORTED';
      console.log(`  ${name.padEnd(20)} ${String(e.count).padStart(4)}  ${mark}`);
      if (SHOW_VALUES && !kept?.[name] && e.samples.size) {
        console.log(`      e.g. ${[...e.samples].join(' | ')}`);
      }
    }
  };

  console.log(`Audited ${files.length} cached event pages.`);
  report('data-* attributes on the event card', attrs, KEPT);
  report('detail rows (evo_metarow_*)', rows, KEPT_ROWS);
  report('custom field labels', customFields, {});
  report('state classes on the event card', stateClasses, {});

  const missed = [...attrs.keys()].filter((k) => !KEPT[k]);
  console.log(`\n${missed.length} data attribute(s) not exported: ${missed.join(', ') || 'none'}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
