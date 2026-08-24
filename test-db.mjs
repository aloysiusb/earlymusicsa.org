/**
 * test-db.mjs — exercises the storage layer and the HTTP routes end to end.
 * Uses a throwaway database, so it never touches the real one.
 *
 *   node test-db.mjs
 */

import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  openDb, validateSubmission, insertSubmission, listSubmissions,
  reviewSubmission, approvedEvents, validateStyle, setStyle, getStyles, stylesAsCss,
} from './db.js';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const dir = await mkdtemp(path.join(tmpdir(), 'ems-test-'));
const dbFile = path.join(dir, 'test.sqlite');

console.log('--- storage ---');
const db = openDb(dbFile);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all().map((r) => r.name);
check('schema created', tables.includes('submissions') && tables.includes('style_settings'),
  tables.join(','));

// --- validation ---
check('rejects a submission with no title',
  validateSubmission({ start_local: '2026-10-01T19:30:00-05:00' }).errors.length > 0);
check('rejects a bad date',
  validateSubmission({ title: 'X', start_local: 'next tuesday' }).errors.length > 0);
check('rejects a non-http link',
  validateSubmission({ title: 'X', start_local: '2026-10-01T19:30', website: 'javascript:alert(1)' })
    .errors.length > 0);
check('caps an over-long title',
  validateSubmission({ title: 'a'.repeat(500), start_local: '2026-10-01T19:30' })
    .clean.title.length === 200);

const good = validateSubmission({
  title: 'A Recital of Lute Songs',
  start_local: '2026-10-01T19:30:00-05:00',
  end_local: '2026-10-01T21:00:00-05:00',
  location_name: 'St. Mark\'s Episcopal Church',
  location_address: '315 East Pecan St., San Antonio, TX',
  organizer_name: 'Test Organizer',
  performers: 'A lutenist',
  tickets: 'Free',
  website: 'https://example.org/concert',
  submitter_email: 'someone@example.org',
  description: 'An evening of Dowland.',
});
check('accepts a good submission', good.errors.length === 0, good.errors.join('; '));

const { id } = insertSubmission(db, good.clean);
check('insert returns an id', Number.isInteger(id) && id > 0);
check('appears in the pending queue', listSubmissions(db, 'pending').length === 1);

// --- spam heuristics ---
const spam = validateSubmission({
  title: '5th International Conference on Dermatology',
  start_local: '2026-10-01T09:00:00-05:00',
  organizer_name: 'Inovine Scientific Meetings',
  location_name: 'Zurich, Switzerland',
});
const spamRow = insertSubmission(db, spam.clean);
check('flags conference spam', spamRow.spamReasons.length === 3, spamRow.spamReasons.join(','));
check('flagged spam still queues rather than vanishing',
  listSubmissions(db, 'pending').length === 2);

// --- moderation ---
check('approve works', reviewSubmission(db, id, 'approved'));
check('approving removes it from pending', listSubmissions(db, 'pending').length === 1);
check('rejecting an unknown id reports failure', reviewSubmission(db, 9999, 'rejected') === false);

const [ev] = approvedEvents(db);
check('approved event has a slug', ev.slug === 'a-recital-of-lute-songs', ev.slug);
check('approved event has usable times',
  ev.startUnix > 0 && ev.endUnix > ev.startUnix);
check('approved event carries the venue', ev.location?.name.startsWith('St. Mark'));

// --- style tokens ---
check('rejects a key that is not a custom property', !!validateStyle('color', 'red'));
check('rejects a value containing a rule', !!validateStyle('--gold', 'red;} body{display:none'));
check('rejects url()', !!validateStyle('--banner-image', 'url(http://evil/x.png)'));
check('accepts a normal token', validateStyle('--gold', '#b8860b') === null);

setStyle(db, '--gold', '#b8860b');
setStyle(db, '--card-bg', '#cfe3ea');
setStyle(db, '--gold', '#a07800'); // overwrite
check('setting is stored and updated', getStyles(db)['--gold'] === '#a07800');
check('history keeps both values',
  db.prepare('SELECT COUNT(*) c FROM style_history WHERE key = ?').get('--gold').c === 2);

const css = stylesAsCss(db);
check('emits a stylesheet', css.includes(':root{') && css.includes('--gold: #a07800;'), css);
db.close();

// --- HTTP ---
console.log('\n--- http ---');
const port = 4271;
const proc = spawn(process.execPath, ['server.js', String(port)], {
  env: { ...process.env, DB_PATH: dbFile, ADMIN_TOKEN: 'test-token' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 900));

const base = `http://localhost:${port}`;
const post = (p, body, headers = {}) => fetch(base + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

try {
  const bad = await post('/api/submit', { title: '' });
  check('POST /api/submit rejects an empty form', bad.status === 400);

  const ok = await post('/api/submit', {
    title: 'Vespers by Candlelight', start_local: '2026-11-02T19:00:00-05:00',
  });
  check('POST /api/submit accepts a good form', ok.status === 201);

  const honey = await post('/api/submit', {
    title: 'Bot Event', start_local: '2026-11-02T19:00:00-05:00', website_url: 'http://spam',
  });
  const honeyBody = await honey.json();
  check('honeypot is accepted silently without storing', honey.status === 200 && honeyBody.id === null);

  const noAuth = await fetch(`${base}/api/submissions`);
  check('admin route refuses without a token', noAuth.status === 401);

  const wrong = await fetch(`${base}/api/submissions`, { headers: { 'x-admin-token': 'nope' } });
  check('admin route refuses a wrong token', wrong.status === 401);

  const listed = await fetch(`${base}/api/submissions`, { headers: { 'x-admin-token': 'test-token' } });
  const listBody = await listed.json();
  check('admin route lists the queue with the right token',
    listed.status === 200 && listBody.submissions.length >= 2, `got ${listBody.submissions?.length}`);

  const styleNoAuth = await fetch(`${base}/api/style`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ styles: { '--gold': '#fff' } }),
  });
  check('style write refuses without a token', styleNoAuth.status === 401);

  const styleBad = await fetch(`${base}/api/style`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'test-token' },
    body: JSON.stringify({ styles: { '--x': 'red;}body{display:none' } }),
  });
  check('style write rejects an injection attempt', styleBad.status === 400);

  const cssRes = await fetch(`${base}/style-overrides.css`);
  const cssText = await cssRes.text();
  check('serves the overrides stylesheet publicly',
    cssRes.status === 200 && cssText.includes('--gold'), cssText.slice(0, 60));
} finally {
  // Wait for the child to actually exit before tearing down. Killing it and
  // exiting in the same tick trips a libuv assertion on Windows.
  const ended = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await ended;
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
