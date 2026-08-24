#!/usr/bin/env node
/**
 * server.js — serves the built site and the two things that need to be live:
 * event submissions awaiting moderation, and the style tokens.
 *
 * node:http and node:sqlite, no dependencies, following the wall-family
 * pattern. Everything public is still the static output of build.js; this only
 * adds what a static file cannot do.
 *
 *   node server.js [port]
 *
 * Admin routes require an ADMIN_TOKEN environment variable and the same value
 * in an X-Admin-Token header. With no ADMIN_TOKEN set, admin routes refuse
 * every request rather than falling open.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  openDb, validateSubmission, insertSubmission, listSubmissions,
  reviewSubmission, validateStyle, setStyle, getStyles, clearStyle, stylesAsCss,
} from './db.js';

const ROOT = path.resolve('dist');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY = 256 * 1024;

const db = openDb();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

/** Constant-time compare that does not leak length. */
function tokenOk(supplied) {
  if (!ADMIN_TOKEN || !supplied) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) {
    timingSafeEqual(a, a); // spend comparable time
    return false;
  }
  return timingSafeEqual(a, b);
}

const isAdmin = (req) => tokenOk(req.headers['x-admin-token']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Accepts JSON or a plain form post, so the form works without script. */
function parseBody(raw, contentType = '') {
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return null; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/* ---------------------------------------------------------------- routes -- */

async function handleApi(req, res, url) {
  const { pathname } = url;

  // --- public: the style tokens the pages apply ------------------------
  if (req.method === 'GET' && pathname === '/style-overrides.css') {
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(stylesAsCss(db));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/style') {
    json(res, 200, { styles: getStyles(db) });
    return true;
  }

  // --- public: submit an event -----------------------------------------
  if (req.method === 'POST' && pathname === '/api/submit') {
    let raw;
    try { raw = await readBody(req); } catch {
      json(res, 413, { ok: false, errors: ['That submission was too large.'] });
      return true;
    }
    const body = parseBody(raw, req.headers['content-type'] || '');
    if (!body) { json(res, 400, { ok: false, errors: ['Could not read that submission.'] }); return true; }

    // Honeypot: a field no person sees, so anything filling it is a bot.
    // Accepted silently, so the bot has nothing to learn from the response.
    if (String(body.website_url || '').trim()) {
      json(res, 200, { ok: true, id: null });
      return true;
    }

    const { clean, errors } = validateSubmission(body);
    if (errors.length) { json(res, 400, { ok: false, errors }); return true; }

    const { id, spamReasons } = insertSubmission(db, clean);
    json(res, 201, {
      ok: true,
      id,
      flagged: spamReasons.length > 0,
      message: 'Thank you — your event has been sent for review.',
    });
    return true;
  }

  // --- everything below is admin only ----------------------------------
  if (pathname.startsWith('/api/')) {
    if (!isAdmin(req)) {
      json(res, 401, {
        ok: false,
        errors: [ADMIN_TOKEN
          ? 'Not authorised.'
          : 'No ADMIN_TOKEN is set on the server, so admin routes are closed.'],
      });
      return true;
    }
  }

  if (req.method === 'GET' && pathname === '/api/submissions') {
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      json(res, 400, { ok: false, errors: ['Unknown status.'] });
      return true;
    }
    json(res, 200, { ok: true, submissions: listSubmissions(db, status) });
    return true;
  }

  const review = pathname.match(/^\/api\/submissions\/(\d+)\/(approve|reject)$/);
  if (req.method === 'POST' && review) {
    const body = parseBody(await readBody(req), req.headers['content-type'] || '') || {};
    const status = review[2] === 'approve' ? 'approved' : 'rejected';
    const ok = reviewSubmission(db, Number(review[1]), status, body.note || null);
    json(res, ok ? 200 : 404, ok
      ? { ok: true, id: Number(review[1]), status }
      : { ok: false, errors: ['No submission with that id.'] });
    return true;
  }

  if (req.method === 'PUT' && pathname === '/api/style') {
    const body = parseBody(await readBody(req), req.headers['content-type'] || '') || {};
    const styles = body.styles && typeof body.styles === 'object' ? body.styles : body;
    const errors = [];
    for (const [k, v] of Object.entries(styles)) {
      const err = validateStyle(k, String(v));
      if (err) errors.push(err);
    }
    if (errors.length) { json(res, 400, { ok: false, errors }); return true; }
    for (const [k, v] of Object.entries(styles)) setStyle(db, k, String(v));
    json(res, 200, { ok: true, styles: getStyles(db) });
    return true;
  }

  const del = pathname.match(/^\/api\/style\/(--[a-z0-9-]+)$/);
  if (req.method === 'DELETE' && del) {
    json(res, 200, { ok: true, removed: clearStyle(db, del[1]) });
    return true;
  }

  return false;
}

/* ---------------------------------------------------------------- static -- */

async function serveStatic(req, res, url) {
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      .end('<h1>Page not found</h1><p><a href="/">Back to the events</a></p>');
    return;
  }

  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}media${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate',
  });
  createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ main -- */

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (await handleApi(req, res, url)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { ok: false, errors: ['Method not allowed.'] });
      return;
    }
    await serveStatic(req, res, url);
  } catch (err) {
    const ref = randomUUID().slice(0, 8);
    console.error(`[${ref}]`, err);
    json(res, 500, { ok: false, errors: [`Something went wrong. Reference ${ref}.`] });
  }
}).listen(PORT, () => {
  console.log(`earlymusicsa on http://localhost:${PORT}`);
  console.log(`  serving ${ROOT}`);
  console.log(`  database ${process.env.DB_PATH || 'earlymusicsa.sqlite'}`);
  console.log(ADMIN_TOKEN
    ? '  admin routes enabled'
    : '  admin routes CLOSED — set ADMIN_TOKEN to enable them');
});
