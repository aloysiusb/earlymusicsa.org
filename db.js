/**
 * db.js — SQLite storage, following the wall-family pattern: node:sqlite,
 * no dependencies, schema created on open so there is no migration step.
 *
 * Two things live here, and only two:
 *   submissions   events sent in through the public form, awaiting moderation
 *   style_settings  the design tokens the style-editing page writes
 *
 * The event archive itself stays in data/events.json — it is the export of a
 * site that no longer changes, and belongs in git where it is diffable and
 * backed up. Only things that change at runtime need a database.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'earlymusicsa.sqlite');

export function openDb(file = DB_PATH) {
  const db = new DatabaseSync(file);

  // WAL lets a build read the database while the server is writing to it.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      status         TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at     TEXT NOT NULL,
      reviewed_at    TEXT,
      review_note    TEXT,

      title          TEXT NOT NULL,
      description    TEXT,
      start_local    TEXT NOT NULL,   -- ISO 8601 with offset, e.g. 2026-09-11T19:30:00-05:00
      end_local      TEXT,
      all_day        INTEGER NOT NULL DEFAULT 0,

      location_name    TEXT,
      location_address TEXT,
      organizer_name   TEXT,
      performers       TEXT,
      tickets          TEXT,
      website          TEXT,
      image_url        TEXT,

      submitter_name  TEXT,
      submitter_email TEXT,
      spam_reasons    TEXT             -- populated by the same heuristics scrape.js uses
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_status
      ON submissions(status, start_local);

    -- Messages from the Contact page. Kept rather than emailed onward: the
    -- site has no mail credentials, and a volunteer reading a queue is the
    -- same job as reading an inbox.
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL,
      first_name  TEXT,
      last_name   TEXT,
      email       TEXT NOT NULL,
      message     TEXT,
      handled     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_handled ON messages(handled, created_at);

    CREATE TABLE IF NOT EXISTS style_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Every style change is kept, so a bad edit can be walked back.
    CREATE TABLE IF NOT EXISTS style_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_style_history_key ON style_history(key);
  `);

  return db;
}

/* ------------------------------------------------------------ submissions -- */

/** Only these may be written by the public form. */
export const SUBMISSION_FIELDS = [
  'title', 'description', 'start_local', 'end_local', 'all_day',
  'location_name', 'location_address', 'organizer_name', 'performers',
  'tickets', 'website', 'image_url', 'submitter_name', 'submitter_email',
];

const LIMITS = {
  title: 200, description: 5000, start_local: 40, end_local: 40,
  location_name: 200, location_address: 300, organizer_name: 200,
  performers: 1000, tickets: 300, website: 500, image_url: 500,
  submitter_name: 120, submitter_email: 200,
};

/** The same patterns scrape.js uses — the old form was farmed by conference spam. */
const SPAM_ORGANIZER = /inovine|inscitech|intelli global|pages conferences|scientific (summits|meetings|conference)|research connects|vartus|innovating skin science/i;
const SPAM_TITLE = /\b(conference|congress|summit|webinar|expo)\b|dermatolog|neuroscien|nursing|oncolog|pharma/i;
const FOREIGN = /netherlands|japan|switzerland|germany|italy|france|czechia|hungary|australia|prague|zurich|zürich/i;

export function spamReasons(sub) {
  const out = [];
  if (SPAM_ORGANIZER.test(sub.organizer_name || '')) out.push('organizer-pattern');
  if (SPAM_TITLE.test(sub.title || '')) out.push('title-pattern');
  if (FOREIGN.test(sub.location_name || '')) out.push('non-local-venue');
  return out;
}

const SITE_TZ = 'America/Chicago';

/**
 * A browser's datetime-local field gives "2026-09-11T19:30" with no offset.
 * Stored as-is, Date.parse would read it in the server's zone — UTC on Render —
 * putting every submitted event five or six hours out. Stamp the offset San
 * Antonio actually had on that date, so the stored value means what the person
 * typed.
 */
export function withSiteOffset(local) {
  if (!local) return local;
  if (/[+-]\d{2}:\d{2}$/.test(local)) return local;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?$/.exec(local);
  if (!m) return local;
  const approx = new Date(`${m[1]}:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: SITE_TZ, timeZoneName: 'longOffset' })
    .formatToParts(approx).find((p) => p.type === 'timeZoneName').value;
  return `${m[1]}:00${name.replace('GMT', '') || '+00:00'}`;
}

/** Trim, cap, and reject anything that is not a real submission. */
export function validateSubmission(raw) {
  const clean = {};
  for (const f of SUBMISSION_FIELDS) {
    let v = raw[f];
    if (v === undefined || v === null) v = '';
    if (f === 'all_day') { clean[f] = v === true || v === 'on' || v === '1' ? 1 : 0; continue; }
    v = String(v).replace(/\s+/g, ' ').trim().slice(0, LIMITS[f] ?? 500);
    clean[f] = v;
  }

  const errors = [];
  if (!clean.title) errors.push('An event name is required.');
  if (!clean.start_local) errors.push('A start date and time is required.');
  else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(clean.start_local)) {
    errors.push('The start date and time is not in a format we recognise.');
  }
  if (clean.end_local && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(clean.end_local)) {
    errors.push('The end date and time is not in a format we recognise.');
  }
  for (const f of ['website', 'image_url']) {
    if (clean[f] && !/^https?:\/\//i.test(clean[f])) {
      errors.push('Links must start with http:// or https://');
      break;
    }
  }
  if (clean.submitter_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean.submitter_email)) {
    errors.push('That email address does not look right.');
  }

  clean.start_local = withSiteOffset(clean.start_local);
  clean.end_local = withSiteOffset(clean.end_local);
  if (clean.end_local && Date.parse(clean.end_local) < Date.parse(clean.start_local)) {
    errors.push('The end time is before the start time.');
  }
  return { clean, errors };
}

export function insertSubmission(db, clean) {
  const reasons = spamReasons(clean);
  const cols = [...SUBMISSION_FIELDS, 'created_at', 'spam_reasons'];
  const stmt = db.prepare(
    `INSERT INTO submissions (${cols.join(', ')})
     VALUES (${cols.map(() => '?').join(', ')})`,
  );
  const values = [
    ...SUBMISSION_FIELDS.map((f) => clean[f]),
    new Date().toISOString(),
    reasons.length ? reasons.join(',') : null,
  ];
  const info = stmt.run(...values);
  return { id: Number(info.lastInsertRowid), spamReasons: reasons };
}

export const listSubmissions = (db, status = 'pending') =>
  db.prepare('SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC').all(status);

export function reviewSubmission(db, id, status, note = null) {
  const info = db.prepare(
    'UPDATE submissions SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ?',
  ).run(status, new Date().toISOString(), note, id);
  return info.changes > 0;
}

/**
 * Approved submissions, shaped like the records in data/events.json so
 * build.js can merge them straight into the listings.
 */
export function approvedEvents(db) {
  return listSubmissions(db, 'approved').map((s) => ({
    id: `sub-${s.id}`,
    slug: slugify(s.title) || `submission-${s.id}`,
    title: s.title,
    status: 'publish',
    start: s.start_local,
    end: s.end_local || null,
    startUnix: Math.floor(Date.parse(s.start_local) / 1000),
    endUnix: s.end_local ? Math.floor(Date.parse(s.end_local) / 1000) : null,
    allDay: !!s.all_day,
    instances: null,
    color: null,
    textTone: 'light',
    location: s.location_name
      ? { id: null, name: s.location_name, rawName: s.location_name,
          address: s.location_address || '', lat: null, lon: null }
      : null,
    organizer: s.organizer_name ? { id: null, name: s.organizer_name } : null,
    types: [],
    description: s.description ? `<p>${escapeHtml(s.description)}</p>` : '',
    descriptionText: s.description || '',
    image: s.image_url || '',
    imageAlt: '',
    imageWidth: null,
    imageHeight: null,
    imageVariants: null,
    website: s.website || '',
    performers: s.performers || '',
    tickets: s.tickets || '',
    sourceUrl: '',
    submitted: true,
  }));
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Matches build.js's expectations for a URL-safe slug. */
const slugify = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim()
  .replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

/* --------------------------------------------------------------- messages -- */

const MESSAGE_LIMITS = { first_name: 120, last_name: 120, email: 200, message: 5000 };

export function validateMessage(raw) {
  const clean = {};
  for (const f of Object.keys(MESSAGE_LIMITS)) {
    clean[f] = String(raw[f] ?? '').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_LIMITS[f]);
  }
  // The message keeps its line breaks; only the single-line fields collapse.
  clean.message = String(raw.message ?? '').replace(/\r\n/g, '\n').trim().slice(0, MESSAGE_LIMITS.message);

  const errors = [];
  if (!clean.email) errors.push('An email address is required, so we can reply.');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean.email)) {
    errors.push('That email address does not look right.');
  }
  if (!clean.message) errors.push('Please write a message.');
  return { clean, errors };
}

export function insertMessage(db, clean) {
  const info = db.prepare(
    `INSERT INTO messages (created_at, first_name, last_name, email, message)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(new Date().toISOString(), clean.first_name, clean.last_name, clean.email, clean.message);
  return Number(info.lastInsertRowid);
}

export const listMessages = (db, handled = 0) =>
  db.prepare('SELECT * FROM messages WHERE handled = ? ORDER BY created_at DESC').all(handled);

export const markMessageHandled = (db, id) =>
  db.prepare('UPDATE messages SET handled = 1 WHERE id = ?').run(id).changes > 0;

/* --------------------------------------------------------------- settings -- */

/** Only real custom-property names, so nothing can inject arbitrary CSS. */
export const STYLE_KEY = /^--[a-z][a-z0-9-]{0,48}$/;

/** No braces, semicolons, or url() — a value is a value, not a rule. */
export const STYLE_VALUE = /^[^{};<>]{1,120}$/;

export function validateStyle(key, value) {
  if (!STYLE_KEY.test(key)) return `"${key}" is not a valid custom property name.`;
  if (typeof value !== 'string' || !STYLE_VALUE.test(value)) {
    return `The value for "${key}" is not allowed.`;
  }
  if (/url\s*\(|expression|javascript:/i.test(value)) {
    return `The value for "${key}" is not allowed.`;
  }
  return null;
}

export function setStyle(db, key, value) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO style_settings (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, now);
  db.prepare('INSERT INTO style_history (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, now);
}

export const getStyles = (db) =>
  Object.fromEntries(db.prepare('SELECT key, value FROM style_settings ORDER BY key').all()
    .map((r) => [r.key, r.value]));

export function clearStyle(db, key) {
  return db.prepare('DELETE FROM style_settings WHERE key = ?').run(key).changes > 0;
}

/** The stored tokens as a stylesheet, for the site to load after style.css. */
export function stylesAsCss(db) {
  const rows = Object.entries(getStyles(db));
  if (!rows.length) return '/* no style overrides set */\n';
  return `:root{\n${rows.map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`;
}
