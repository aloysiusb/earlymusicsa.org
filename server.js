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
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { boundaryOf, parseMultipart, sniffImage } from './multipart.js';
import {
  openDb, validateSubmission, insertSubmission, listSubmissions,
  reviewSubmission, validateStyle, setStyle, getStyles, clearStyle, stylesAsCss,
  validateMessage, insertMessage, listMessages, markMessageHandled, geocode,
  validateEventPatch, setEventEdit, getEventEdits, clearEventEdit, applyEventPatch,
  approvedEvents,
} from './db.js';

const ROOT = path.resolve('dist');
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY = 256 * 1024;
const MAX_UPLOAD = 8 * 1024 * 1024;

// Uploads live beside the database, which on Render is the persistent disk.
const UPLOAD_DIR = process.env.UPLOAD_DIR
  || path.join(path.dirname(process.env.DB_PATH || '.'), 'uploads');

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

/**
 * Set on every response. Render only applies a blueprint `headers:` block to
 * static sites, so a web service has to send its own.
 */
const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
};

const json = (res, status, body) => {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
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

/* --------------------------------------------------------------- rebuild -- */

/**
 * Regenerate the static pages.
 *
 * This matters on a host where the database lives on a disk that is only
 * mounted at run time: the deploy-time build cannot see it, so an approved
 * event would never reach a page. Rebuilding here closes that gap. Images are
 * left alone, which is most of the build time.
 *
 * Runs are serialised, and a request arriving mid-build queues exactly one
 * more rather than piling up.
 */
let building = false;
let queued = false;

function rebuild(reason = '') {
  if (building) { queued = true; return; }
  building = true;
  const started = Date.now();
  execFile(process.execPath, ['build.js', '--skip-media'], { cwd: process.cwd() }, (err, stdout) => {
    building = false;
    if (err) console.error(`rebuild failed${reason ? ` (${reason})` : ''}:`, err.message);
    else console.log(`rebuilt in ${Date.now() - started}ms${reason ? ` — ${reason}` : ''}`);
    if (queued) { queued = false; rebuild('queued'); }
  });
}

/* ------------------------------------------------------------ form reply -- */

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sendPage = (res, status, html) => {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
};

/**
 * The reply a plain form post gets. The contact form has to work with
 * JavaScript off, which means the server owes the browser a real page rather
 * than a JSON blob.
 */
function thanksPage(errors = [], kind = 'message') {
  const ok = errors.length === 0;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ok ? 'Thank you' : 'Please check the form'} &ndash; Early Music San Antonio</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Raleway:wght@300;400;500;700;800&display=swap">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="site-banner">
  <div class="container header-inner">
    <a class="site-logo" href="/"><img src="/media/Early-Music-SA-Logo-wt.png"
      alt="Early Music San Antonio" width="205" height="150"></a>
  </div>
</header>
<main class="site-main">
  <div class="container page-header"><h1 class="page-title">${ok ? 'Thank you' : 'Please check the form'}</h1></div>
  <div class="container content">
    <div class="primary wide">
      <div class="page-prose">
        ${ok
          ? (kind === 'event'
            ? '<p>Thank you — your event has been sent for review. A volunteer will '
              + 'check it over, and once approved it will appear in the listings.</p>'
            : '<p>Your message has been sent to the volunteers who look after this site. '
              + 'We read everything, though it may take a few days to reply.</p>')
          : `<ul>${errors.map((e) => `<li>${escHtml(e)}</li>`).join('')}</ul>`}
        <p><a href="/contact.html">Back to the contact page</a> &nbsp;
           <a href="/">Back to the events</a></p>
      </div>
    </div>
  </div>
</main>
<footer class="site-footer"><div class="container">
  <p>Copyright ${new Date().getFullYear()} &mdash; Early Music San Antonio. All rights reserved.</p>
</div></footer>
</body>
</html>
`;
}

function readBuffer(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const readBody = (req, max) => readBuffer(req, max).then((b) => b.toString('utf8'));

/**
 * The archive the edit screen works over: the exported events plus anything
 * approved through the queue. Read fresh each time rather than cached, so an
 * approval is editable straight away.
 */
function loadArchive() {
  const exported = JSON.parse(readFileSync('data/events.json', 'utf8')).events;
  return [...exported, ...approvedEvents(db)];
}

/**
 * Save an uploaded image beside the database, which on Render is the persistent
 * disk — so an upload survives a deploy exactly as a submission does.
 *
 * The file is identified by its leading bytes, not by what the browser claimed
 * and not by the extension: a .jpg can contain anything. The stored name is one
 * we generate, so nothing a submitter types reaches the filesystem.
 */
async function saveUpload(file) {
  const kind = sniffImage(file.data);
  if (!kind) return { error: 'That file did not look like a JPEG, PNG, GIF or WebP image.' };
  if (file.data.length > MAX_UPLOAD) {
    return { error: `Images need to be under ${Math.round(MAX_UPLOAD / 1024 / 1024)}MB.` };
  }
  const name = `${randomUUID()}.${kind.ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, name), file.data);
  return { url: `/uploads/${name}` };
}

/**
 * Accepts JSON or a plain form post, so the forms work without script.
 *
 * Repeated names are joined rather than overwritten — the submit form's event
 * type checkboxes all post as `event_types`, and Object.fromEntries would keep
 * only the last one ticked.
 */
function parseBody(raw, contentType = '') {
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw || '{}');
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) parsed[k] = v.join(',');
      }
      return parsed;
    } catch { return null; }
  }
  const params = new URLSearchParams(raw);
  const out = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all.join(',') : all[0];
  }
  return out;
}

/* ---------------------------------------------------------------- routes -- */

async function handleApi(req, res, url) {
  const { pathname } = url;

  // --- public: the style tokens the pages apply ------------------------
  if (req.method === 'GET' && pathname === '/style-overrides.css') {
    res.writeHead(200, {
      ...BASE_HEADERS,
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
    const type = req.headers['content-type'] || '';
    const boundary = boundaryOf(type);

    let body;
    let upload = null;
    try {
      if (boundary) {
        // A form carrying a file: read as bytes and allow the larger cap.
        const parsed = parseMultipart(await readBuffer(req, MAX_UPLOAD + 256 * 1024), boundary);
        body = parsed.fields;
        const picked = parsed.files.find((f) => f.field === 'image_file');
        if (picked) {
          const saved = await saveUpload(picked);
          if (saved.error) {
            if (!type.includes('application/json')) { sendPage(res, 400, thanksPage([saved.error])); return true; }
            json(res, 400, { ok: false, errors: [saved.error] });
            return true;
          }
          upload = saved.url;
        }
      } else {
        body = parseBody(await readBody(req), type);
      }
    } catch {
      json(res, 413, { ok: false, errors: ['That submission was too large.'] });
      return true;
    }
    if (!body) { json(res, 400, { ok: false, errors: ['Could not read that submission.'] }); return true; }

    // An uploaded file wins over a typed link, since it is the more deliberate
    // of the two.
    if (upload) body.image_url = upload;

    // Honeypot: a field no person sees, so anything filling it is a bot.
    // Accepted silently, so the bot has nothing to learn from the response.
    if (String(body.website_url || '').trim()) {
      if (!(req.headers['content-type'] || '').includes('application/json')) {
        sendPage(res, 200, thanksPage([], 'event'));
        return true;
      }
      json(res, 200, { ok: true, id: null });
      return true;
    }

    const wantsHtml = !(req.headers['content-type'] || '').includes('application/json');
    const { clean, errors } = validateSubmission(body);
    if (errors.length) {
      if (wantsHtml) { sendPage(res, 400, thanksPage(errors)); return true; }
      json(res, 400, { ok: false, errors });
      return true;
    }

    const { id, spamReasons } = insertSubmission(db, clean);
    if (wantsHtml) { sendPage(res, 200, thanksPage([], 'event')); return true; }
    json(res, 201, {
      ok: true,
      id,
      flagged: spamReasons.length > 0,
      message: 'Thank you — your event has been sent for review.',
    });
    return true;
  }

  /* --- public: an uploaded image -----------------------------------------
   * Served from the disk beside the database. The name is one we generated and
   * the type comes from the extension we chose, never from anything the
   * submitter supplied.
   */
  const uploadReq = pathname.match(/^\/uploads\/([0-9a-f-]{36}\.(jpg|png|gif|webp))$/);
  if (req.method === 'GET' && uploadReq) {
    const file = path.join(UPLOAD_DIR, uploadReq[1]);
    if (!existsSync(file)) { res.writeHead(404, BASE_HEADERS).end(); return true; }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
    return true;
  }

  /* --- public: map tiles -------------------------------------------------
   * Serves a mirrored tile if we have it, and fetches then keeps it if we do
   * not. A visitor's browser therefore only ever talks to this domain, and a
   * venue looked up on the submit form has its tiles mirrored from then on, so
   * the public pages get them for free on the next build.
   */
  const tileReq = pathname.match(/^\/api\/tile\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
  if (req.method === 'GET' && tileReq) {
    const [, z, x, y] = tileReq;
    const file = path.join('media', 'tiles', `${z}-${x}-${y}.png`);
    const headers = {
      ...BASE_HEADERS,
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
    };
    if (existsSync(file)) {
      res.writeHead(200, headers);
      createReadStream(file).pipe(res);
      return true;
    }
    try {
      const upstream = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
        headers: { 'user-agent': 'earlymusicsa.org map tiles (static site)' },
      });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const buf = Buffer.from(await upstream.arrayBuffer());
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, buf);
      res.writeHead(200, headers);
      res.end(buf);
    } catch {
      res.writeHead(404, BASE_HEADERS).end();
    }
    return true;
  }

  // --- public: look up a venue so the submit form can show its map --------
  if (req.method === 'GET' && pathname === '/api/geocode') {
    const q = url.searchParams.get('q') || '';
    const found = await geocode(db, q);
    json(res, 200, found ? { ok: true, ...found } : { ok: false });
    return true;
  }

  // --- public: contact ---------------------------------------------------
  if (req.method === 'POST' && pathname === '/api/contact') {
    let raw;
    try { raw = await readBody(req); } catch {
      json(res, 413, { ok: false, errors: ['That message was too long.'] });
      return true;
    }
    const type = req.headers['content-type'] || '';
    const body = parseBody(raw, type);
    const wantsHtml = !type.includes('application/json');
    if (!body) { json(res, 400, { ok: false, errors: ['Could not read that message.'] }); return true; }

    if (String(body.website_url || '').trim()) {
      // Honeypot — accepted quietly, stored nowhere.
      if (wantsHtml) { sendPage(res, 200, thanksPage()); return true; }
      json(res, 200, { ok: true, id: null });
      return true;
    }

    const { clean, errors } = validateMessage(body);
    if (errors.length) {
      if (wantsHtml) { sendPage(res, 400, thanksPage(errors)); return true; }
      json(res, 400, { ok: false, errors });
      return true;
    }

    const id = insertMessage(db, clean);
    if (wantsHtml) { sendPage(res, 200, thanksPage()); return true; }
    json(res, 201, { ok: true, id, message: 'Thank you — your message has been sent.' });
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

  if (req.method === 'GET' && pathname === '/api/messages') {
    json(res, 200, { ok: true, messages: listMessages(db, 0) });
    return true;
  }

  const handled = pathname.match(/^\/api\/messages\/(\d+)\/handled$/);
  if (req.method === 'POST' && handled) {
    const done = markMessageHandled(db, Number(handled[1]));
    json(res, done ? 200 : 404, done ? { ok: true } : { ok: false, errors: ['No message with that id.'] });
    return true;
  }


  /* --- admin: the event archive ------------------------------------------
   * Edits are overrides. data/events.json is never rewritten, so the export
   * stays diffable and a re-scrape cannot be clobbered by an edit.
   */
  if (req.method === 'GET' && pathname === '/api/events') {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const edits = getEventEdits(db);
    const all = loadArchive();
    const matched = all
      .filter((ev) => !q
        || ev.title.toLowerCase().includes(q)
        || (ev.location?.name || '').toLowerCase().includes(q)
        || (ev.organizer?.name || '').toLowerCase().includes(q)
        || String(ev.start || '').startsWith(q))
      .sort((a, b) => (b.startUnix ?? 0) - (a.startUnix ?? 0));

    json(res, 200, {
      ok: true,
      total: matched.length,
      events: matched.slice(0, 60).map((ev) => {
        const merged = applyEventPatch(ev, edits.get(String(ev.id)));
        return {
          id: ev.id,
          title: merged.title,
          start: merged.start,
          venue: merged.location?.name || '',
          edited: edits.has(String(ev.id)),
          hidden: !!merged.hidden,
        };
      }),
    });
    return true;
  }

  const oneEvent = pathname.match(/^\/api\/events\/([\w.-]+)$/);
  if (oneEvent) {
    const id = oneEvent[1];
    const original = loadArchive().find((ev) => String(ev.id) === id);
    if (!original) { json(res, 404, { ok: false, errors: ['No event with that id.'] }); return true; }
    const edits = getEventEdits(db);

    if (req.method === 'GET') {
      json(res, 200, {
        ok: true,
        patch: edits.get(id) || {},
        event: applyEventPatch(original, edits.get(id)),
        original,
      });
      return true;
    }

    if (req.method === 'PUT') {
      const body = parseBody(await readBody(req), req.headers['content-type'] || '') || {};
      const { clean, errors } = validateEventPatch(body.patch || body);
      if (errors.length) { json(res, 400, { ok: false, errors }); return true; }
      setEventEdit(db, id, clean);
      rebuild(`edited event ${id}`);
      json(res, 200, { ok: true, patch: clean, event: applyEventPatch(original, clean), rebuilding: true });
      return true;
    }

    if (req.method === 'DELETE') {
      const removed = clearEventEdit(db, id);
      if (removed) rebuild(`reverted event ${id}`);
      json(res, 200, { ok: true, reverted: removed, event: original, rebuilding: removed });
      return true;
    }
  }

  const review = pathname.match(/^\/api\/submissions\/(\d+)\/(approve|reject)$/);
  if (req.method === 'POST' && review) {
    const body = parseBody(await readBody(req), req.headers['content-type'] || '') || {};
    const status = review[2] === 'approve' ? 'approved' : 'rejected';
    const ok = reviewSubmission(db, Number(review[1]), status, body.note || null);
    // An approval changes what the listings should show, so regenerate them.
    if (ok && status === 'approved') rebuild(`approved submission ${review[1]}`);
    json(res, ok ? 200 : 404, ok
      ? { ok: true, id: Number(review[1]), status, rebuilding: status === 'approved' }
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
  if (!file.startsWith(ROOT)) { res.writeHead(403, BASE_HEADERS).end('Forbidden'); return; }

  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    res.writeHead(404, { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8' })
      .end('<h1>Page not found</h1><p><a href="/">Back to the events</a></p>');
    return;
  }

  const ext = path.extname(file);
  res.writeHead(200, {
    ...BASE_HEADERS,
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

  // The deploy-time build runs before the disk is mounted, so anything already
  // approved is missing from the pages this process is about to serve.
  if (!existsSync(ROOT)) rebuild('no dist/ yet');
  else if (listSubmissions(db, 'approved').length) rebuild('approved events on disk');
});
