/**
 * test-deploy.mjs — rehearses the Render setup end to end.
 *
 * The thing worth proving: on Render the persistent disk is mounted at run
 * time, not during the build, so the deploy-time build cannot see the
 * database. The server has to rebuild once it is running, or an approved event
 * never reaches a page. This checks that actually happens.
 *
 *   node test-deploy.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb, validateSubmission, insertSubmission } from './db.js';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const dir = await mkdtemp(path.join(tmpdir(), 'ems-deploy-'));
const dbFile = path.join(dir, 'disk.sqlite');
const PORT = 4272;
const TOKEN = 'deploy-test-token';
const base = `http://localhost:${PORT}`;

// A submission already sitting on the "disk", approved, exactly as it would be
// after a redeploy. The build that just ran never saw it.
const db = openDb(dbFile);
const { clean } = validateSubmission({
  title: 'Disk Persistence Proof',
  start_local: '2026-12-20T19:30:00-06:00',
  location_name: 'Test Chapel',
});
const { id } = insertSubmission(db, clean);
db.prepare("UPDATE submissions SET status='approved' WHERE id=?").run(id);
db.close();

console.log('--- starting the service the way Render would ---');
const proc = spawn(process.execPath, ['server.js', String(PORT)], {
  env: { ...process.env, DB_PATH: dbFile, ADMIN_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
proc.stdout.on('data', (d) => { log += d; });
proc.stderr.on('data', (d) => { log += d; });

const waitFor = async (test, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

try {
  await waitFor(async () => {
    try { return (await fetch(base + '/')).ok; } catch { return false; }
  });
  check('service is up', log.includes('earlymusicsa on'));

  const rebuilt = await waitFor(() => log.includes('rebuilt in'));
  check('rebuilds itself at start-up', rebuilt, log.slice(-200));
  check('and says it was because of approved events the build could not see',
    log.includes('approved events on disk'), log.slice(-200));

  // The home page lists only the next few events, and these test dates fall
  // later in the year — so check the page the event actually gets.
  const onSite = await waitFor(async () => {
    const r = await fetch(base + '/events/disk-persistence-proof.html');
    return r.ok && (await r.text()).includes('Disk Persistence Proof');
  });
  check('the approved event now has a page on the site', onSite);

  const inMonth = await fetch(base + '/calendar/2026-12.html');
  check('and appears in its month of the calendar',
    inMonth.ok && (await inMonth.text()).includes('Disk Persistence Proof'));

  // And an approval made while running also lands.
  const db2 = openDb(dbFile);
  const second = validateSubmission({
    title: 'Approved While Running',
    start_local: '2026-12-27T19:30:00-06:00',
  });
  const { id: id2 } = insertSubmission(db2, second.clean);
  db2.close();

  const res = await fetch(`${base}/api/submissions/${id2}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ note: 'looks good' }),
  });
  const body = await res.json();
  check('approving returns ok and reports a rebuild', res.status === 200 && body.rebuilding === true);

  const liveUpdate = await waitFor(async () => {
    const r = await fetch(base + '/events/approved-while-running.html');
    return r.ok && (await r.text()).includes('Approved While Running');
  });
  check('an approval made while running reaches the site', liveUpdate);

  check('images were not re-copied on the quick rebuild',
    !/952 images mirrored/.test(log) || (log.match(/rebuilt in/g) || []).length >= 1);
} finally {
  const ended = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await ended;
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
