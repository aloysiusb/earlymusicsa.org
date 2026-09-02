/**
 * test-edits.mjs — proves the event edit mode end to end.
 *
 * The thing worth proving: an edit is an *override*. data/events.json is never
 * rewritten, so the export stays exactly as it came off the old site and any
 * edit can be undone. This walks the whole loop a volunteer walks — search,
 * open, change, save, see it on the page, hide, revert — and checks the export
 * is untouched at every step.
 *
 *   node test-edits.mjs
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const dir = await mkdtemp(path.join(tmpdir(), 'ems-edits-'));
const dbFile = path.join(dir, 'disk.sqlite');
const PORT = await freePort();
const TOKEN = 'edit-test-token';
const base = `http://localhost:${PORT}`;
const H = { 'x-admin-token': TOKEN, 'content-type': 'application/json' };
const get = (p) => fetch(base + p, { headers: H }).then((r) => r.json());
const put = (p, body) => fetch(base + p, { method: 'PUT', headers: H, body: JSON.stringify(body) })
  .then((r) => r.json());

console.log('--- editing archived events ---');
const proc = spawn(process.execPath, ['server.js', String(PORT)], {
  env: { ...process.env, DB_PATH: dbFile, ADMIN_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', () => {});
proc.stderr.on('data', () => {});

const waitFor = async (test, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await test()) return true; } catch { /* not up yet */ }
    await wait(400);
  }
  return false;
};

// The export as it sits on disk, so we can prove it never changes.
const exportBefore = await readFile('data/events.json', 'utf8');

try {
  check('service is up', await waitFor(() => fetch(base + '/').then((r) => r.ok)));
  await waitFor(async () => (await get('/api/events?q=')).total > 0);

  /* --- finding an event ------------------------------------------------- */

  const all = await get('/api/events?q=');
  check('search returns the archive', all.total > 300, `total=${all.total}`);
  check('the list is capped so the page stays quick', all.events.length <= 60, String(all.events.length));

  const target = all.events.find((e) => e.start && e.start > '2026-01') || all.events[0];
  const id = target.id;

  const one = await get(`/api/events/${id}`);
  check('an event comes back with its original alongside', !!one.event && !!one.original);
  check('and carries no edit yet', Object.keys(one.patch).length === 0, JSON.stringify(one.patch));

  const byTitle = await get(`/api/events?q=${encodeURIComponent(one.original.title.slice(0, 12))}`);
  check('search finds it by title', byTitle.events.some((e) => e.id === id));

  /* --- making an edit --------------------------------------------------- */

  const NEW = 'Edit mode proof ' + Date.now();
  const saved = await put(`/api/events/${id}`, { patch: { title: NEW, subtitle: 'a test subtitle' } });
  check('the edit is accepted', saved.ok === true, JSON.stringify(saved.errors || saved));
  check('the merged event carries it', saved.event.title === NEW, saved.event.title);

  const listed = (await get('/api/events?q=')).events.find((e) => e.id === id);
  check('the list shows the edited title', listed && listed.title === NEW, listed && listed.title);
  check('and marks the event as edited', listed && listed.edited === true);

  const reopened = await get(`/api/events/${id}`);
  check('reopening shows only the fields that changed',
    Object.keys(reopened.patch).sort().join() === 'subtitle,title', JSON.stringify(reopened.patch));
  check('the original listing is still the original', reopened.original.title !== NEW);

  /* --- and it reaches the site ------------------------------------------ */

  const url = `/events/${one.original.slug}.html`;
  check('the edit reaches the event page',
    await waitFor(() => fetch(base + url).then((r) => r.ok ? r.text() : '').then((t) => t.includes(NEW))));

  const month = `/calendar/${String(one.original.start).slice(0, 7)}.html`;
  const cal = await fetch(base + month).then((r) => (r.ok ? r.text() : ''));
  if (cal) check('and the month it falls in', cal.includes(NEW));

  /* --- what it refuses -------------------------------------------------- */

  check('an event with no name is refused',
    (await put(`/api/events/${id}`, { patch: { title: '' } })).ok === false);
  check('a colour that is not a hex value is refused',
    (await put(`/api/events/${id}`, { patch: { color: 'blue' } })).ok === false);
  check('an end before the start is refused',
    (await put(`/api/events/${id}`, { patch: { start: '2026-05-02T19:30', end: '2026-05-01T19:30' } })).ok === false);
  check('a link that is not a link is refused',
    (await put(`/api/events/${id}`, { patch: { website: 'javascript:alert(1)' } })).ok === false);
  check('an unknown field is dropped rather than stored',
    !('slug' in (await put(`/api/events/${id}`, { patch: { title: NEW, slug: 'hijacked' } })).patch));

  const noToken = await fetch(`${base}/api/events`).then((r) => r.status);
  check('the whole thing needs the admin token', noToken === 401, `status=${noToken}`);

  /* --- prose typed as prose --------------------------------------------- */

  const prose = await put(`/api/events/${id}`, {
    patch: { title: NEW, description: 'Bach & Beer\n\nA night out.' },
  });
  check('plain prose becomes paragraphs, with the ampersand escaped',
    prose.patch.description === '<p>Bach &amp; Beer</p>\n<p>A night out.</p>', prose.patch.description);

  /* --- hiding ----------------------------------------------------------- */

  await put(`/api/events/${id}`, { patch: { title: NEW, hidden: true } });
  check('a hidden event leaves the site',
    await waitFor(() => fetch(base + url).then((r) => r.status === 404)));

  /* --- undoing ---------------------------------------------------------- */

  const rev = await fetch(`${base}/api/events/${id}`, { method: 'DELETE', headers: H })
    .then((r) => r.json());
  check('reverting reports success', rev.ok && rev.reverted, JSON.stringify(rev));

  const back = await get(`/api/events/${id}`);
  check('the edit is gone', Object.keys(back.patch).length === 0, JSON.stringify(back.patch));
  check('the event is its old self again', back.event.title === one.original.title, back.event.title);
  check('and its page is back',
    await waitFor(() => fetch(base + url).then((r) => r.ok)));

  /* --- the export was never touched ------------------------------------- */

  check('data/events.json is byte for byte what it was',
    (await readFile('data/events.json', 'utf8')) === exportBefore);
} finally {
  proc.kill();
  // Windows keeps the SQLite side files open for a moment after the process
  // goes, and a temp directory left behind is not worth failing a test run over.
  await wait(500);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
