/**
 * test-limits.mjs — proves the cap on the public forms.
 *
 * There is no CAPTCHA here on purpose, so this is the only thing standing
 * between one script and a queue full of rubbish. Two properties matter, and
 * they pull against each other: it has to stop a flood, and it must never stop
 * a real person listing a season of concerts in one sitting.
 *
 * The third property is the one that is easy to get wrong: a refused request
 * must not count. Otherwise somebody hammering the form keeps pushing their own
 * window forward and is locked out for ever.
 *
 *   node test-limits.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { take, reset, clientKey, waitInWords, LIMITS } from './ratelimit.js';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('--- limits on the public forms ---');

/* ------------------------------------------------------------ counting -- */

reset();
const HOUR = 60 * 60 * 1000;
const t0 = Date.parse('2026-09-02T10:00:00Z');

let allowed = 0;
for (let i = 0; i < LIMITS.submit.hour + 4; i++) {
  if (take('submit', '1.2.3.4', t0 + i * 1000).ok) allowed++;
}
check('the hourly allowance is exactly what it says',
  allowed === LIMITS.submit.hour, `${allowed} of ${LIMITS.submit.hour}`);

const refused = take('submit', '1.2.3.4', t0 + 60_000);
check('going over is refused', refused.ok === false);
check('and it says which window was hit', refused.window === 'hour', refused.window);
check('and how long to wait', refused.retryAfter > 0 && refused.retryAfter <= 3600,
  String(refused.retryAfter));

check('one visitor being capped does not affect another',
  take('submit', '5.6.7.8', t0 + 60_000).ok === true);
check('and the two forms are counted separately',
  take('contact', '1.2.3.4', t0 + 60_000).ok === true);

/* -------------------------------------------------- refusals do not count -- */

reset();
for (let i = 0; i < LIMITS.submit.hour; i++) take('submit', 'a', t0 + i * 1000);
// Hammer it while locked out, the way a script would.
for (let i = 0; i < 50; i++) take('submit', 'a', t0 + 60_000 + i * 100);
const afterHammering = take('submit', 'a', t0 + HOUR + 2000);
check('hammering while locked out does not extend the lockout',
  afterHammering.ok === true, JSON.stringify(afterHammering));

/* --------------------------------------------------- the window does open -- */

reset();
for (let i = 0; i < LIMITS.submit.hour; i++) take('submit', 'b', t0 + i * 1000);
check('still refused just before the hour is up',
  take('submit', 'b', t0 + HOUR - 5000).ok === false);
check('and allowed once it has passed',
  take('submit', 'b', t0 + HOUR + 5000).ok === true);

/* --------------------------------------------------------- the day cap --- */

reset();
let dayAllowed = 0;
// Spread far enough apart that the hourly window never bites, and close
// enough that all of them land inside one day -- otherwise the earliest
// stamps expire and more are allowed, which is correct but not what is
// being measured here.
for (let i = 0; i < LIMITS.submit.day + 5; i++) {
  if (take('submit', 'c', t0 + i * 30 * 60 * 1000).ok) dayAllowed++;
}
check('the daily cap holds across a whole day',
  dayAllowed === LIMITS.submit.day, `${dayAllowed} of ${LIMITS.submit.day}`);

/* ------------------------------------------------------- who is asking --- */

const sock = { remoteAddress: '10.0.0.1' };
check('Cloudflare\'s header wins when present',
  clientKey({ headers: { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': 'spoofed, 1.1.1.1' }, socket: sock }) === '9.9.9.9');
check('otherwise the rightmost forwarded entry is used, not the claimed one',
  clientKey({ headers: { 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }, socket: sock }) === '1.1.1.1');
check('a spoofed leftmost entry cannot impersonate somebody else',
  clientKey({ headers: { 'x-forwarded-for': 'victim, real' }, socket: sock }) !== 'victim');
check('falling back to the socket when there is no proxy',
  clientKey({ headers: {}, socket: sock }) === '10.0.0.1');

check('a wait is described in words a person would use',
  waitInWords(45) === 'in a minute or so' && /minutes|hour/.test(waitInWords(900)),
  `${waitInWords(45)} / ${waitInWords(900)}`);

/* -------------------------------------------------- through a real server -- */

const freePort = () => new Promise((r) => {
  const s = net.createServer();
  s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); });
});

const dir = await mkdtemp(path.join(tmpdir(), 'ems-limits-'));
const PORT = await freePort();
const base = `http://localhost:${PORT}`;

const proc = spawn(process.execPath, ['server.js', String(PORT)], {
  env: { ...process.env, DB_PATH: path.join(dir, 'disk.sqlite'), ADMIN_TOKEN: 'tok' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', () => {});
proc.stderr.on('data', () => {});

const post = (route, body, headers = {}) => fetch(base + route, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(base + '/')).ok) break; } catch { /* not up */ }
    await wait(400);
  }

  const event = (n) => ({ title: `Flood test ${n}`, start_local: '2026-12-01T19:30', location_name: 'Test Chapel' });
  const asVisitor = { 'cf-connecting-ip': '203.0.113.7' };

  const codes = [];
  for (let i = 0; i < LIMITS.submit.hour + 2; i++) {
    codes.push((await post('/api/submit', event(i), asVisitor)).status);
  }
  check('a real flood is stopped',
    codes.filter((c) => c === 429).length === 2, codes.join(','));
  check('and the ones before the cap all went through',
    codes.filter((c) => c === 201).length === LIMITS.submit.hour, codes.join(','));

  const refusal = await post('/api/submit', event(99), asVisitor);
  check('the refusal carries Retry-After', Boolean(refusal.headers.get('retry-after')),
    String(refusal.headers.get('retry-after')));
  const payload = await refusal.json();
  check('and explains itself in plain words',
    /try again/i.test(payload.errors[0]) && /has been lost/i.test(payload.errors[0]),
    payload.errors[0]);

  check('somebody else is unaffected',
    (await post('/api/submit', event(0), { 'cf-connecting-ip': '203.0.113.99' })).status === 201);

  check('the contact form has its own separate allowance',
    (await post('/api/contact', { first_name: 'Ada', email: 'a@b.c', message: 'Hello' }, asVisitor)).status === 201);

  // A bot filling the honeypot is answered before the limiter, so it learns
  // nothing about the cap from the response.
  const bot = await post('/api/submit', { ...event(1), website_url: 'http://spam' },
    { 'cf-connecting-ip': '203.0.113.7' });
  check('a honeypot hit still looks like success to the bot', bot.status === 200);
} finally {
  proc.kill();
  await wait(500);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
