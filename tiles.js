#!/usr/bin/env node
/**
 * tiles.js — mirror the OpenStreetMap tiles each venue's map needs.
 *
 * The maps were an OpenStreetMap iframe. That put every visitor's map at the
 * mercy of a third party: the embed loads its own Leaflet and tiles, and when
 * any of that is slow, blocked or rate-limited the map is a grey box, with
 * nothing we can see or fix from our side. It broke in exactly that way.
 *
 * So the tiles are mirrored here instead and served from our own domain, the
 * same as every image on the site. The map becomes a grid of plain <img>s the
 * browser composites — no iframe, no third-party request at page load, and it
 * cannot silently stop working.
 *
 *   node tiles.js          # fetch anything missing
 *   node tiles.js --force  # re-fetch everything
 *
 * Run it after scrape.js, before build.js. Tiles rarely change; this is not
 * something to run often. OSM asks for a real User-Agent and no bulk
 * downloading, which is why this fetches one venue's worth at a time, only
 * what is missing, and stops early once everything is present.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const ZOOM = 15;
export const TILE = 256;
export const COLS = 3;
export const ROWS = 3;
export const TILE_DIR = path.join('media', 'tiles');

const FORCE = process.argv.includes('--force');
const UA = 'earlymusicsa.org map tiles (static site build; contact via earlymusicsa.org)';

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** The tiles a venue's map needs, plus where the pin falls within them. */
export function tilePlan(lat, lon) {
  const cx = lonToTileX(lon, ZOOM);
  const cy = latToTileY(lat, ZOOM);
  const x0 = Math.floor(cx) - (COLS >> 1);
  const y0 = Math.floor(cy) - (ROWS >> 1);
  const tiles = [];
  for (let dy = 0; dy < ROWS; dy++) {
    for (let dx = 0; dx < COLS; dx++) {
      tiles.push({ z: ZOOM, x: x0 + dx, y: y0 + dy });
    }
  }
  return {
    tiles,
    // Pixel offset of the venue inside the assembled grid.
    px: (cx - x0) * TILE,
    py: (cy - y0) * TILE,
  };
}

export const tileFile = (t) => `${t.z}-${t.x}-${t.y}.png`;

async function main() {
  const { events } = JSON.parse(await readFile('data/events.json', 'utf8'));

  // One map per venue, not per event — the same church appears many times.
  const venues = new Map();
  for (const ev of events) {
    const l = ev.location;
    if (!l || !l.lat) continue;
    venues.set(`${l.lat.toFixed(5)},${l.lon.toFixed(5)}`, l);
  }

  const wanted = new Map();
  for (const loc of venues.values()) {
    for (const t of tilePlan(loc.lat, loc.lon).tiles) wanted.set(tileFile(t), t);
  }

  await mkdir(TILE_DIR, { recursive: true });
  const missing = [...wanted.entries()]
    .filter(([name]) => FORCE || !existsSync(path.join(TILE_DIR, name)));

  console.log(`${venues.size} venues · ${wanted.size} tiles · ${missing.length} to fetch`);
  if (!missing.length) { console.log('Nothing to do.'); return; }

  let done = 0, failed = 0;
  for (const [name, t] of missing) {
    try {
      const res = await fetch(`https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`, {
        headers: { 'user-agent': UA },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(path.join(TILE_DIR, name), Buffer.from(await res.arrayBuffer()));
      done++;
    } catch (err) {
      failed++;
      console.warn(`  ${name}: ${err.message}`);
    }
    if (done % 25 === 0) process.stdout.write(`\r  fetched ${done}/${missing.length}`);
    // One request at a time, with a pause. This is someone else's free service.
    await new Promise((r) => setTimeout(r, 120));
  }
  process.stdout.write('\n');
  console.log(`Fetched ${done}${failed ? `, ${failed} failed` : ''}.`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
    || process.argv[1]?.endsWith('tiles.js')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
