/**
 * ratelimit.js — a cap on how often one visitor can use the public forms.
 *
 * There is no CAPTCHA on this site, deliberately: every CAPTCHA is a tax on the
 * genuine submitter, and the elderly concert organiser trying to list a recital
 * is exactly the person who gets stuck on one. The honeypot catches ordinary
 * bots, and nothing reaches the site without a volunteer approving it, so spam
 * that gets through costs ten seconds rather than a problem.
 *
 * What that leaves is volume. Without a cap, one script could put hundreds of
 * submissions into the queue and hundreds of emails into two inboxes, which
 * turns a nuisance into something that has to be cleaned up. This is that cap.
 *
 * Two windows, because they catch different things: a burst in an hour, and a
 * steady drip across a day. Counting is in memory — a restart forgets
 * everything, which is fine. This exists to stop a flood, not to keep a ledger.
 */

/** Fixed windows rather than a rolling log: cheaper, and precision is not the point. */
const WINDOWS = [
  { name: 'hour', ms: 60 * 60 * 1000 },
  { name: 'day', ms: 24 * 60 * 60 * 1000 },
];

export const LIMITS = {
  // A venue listing its whole season in one sitting is a real thing, so the
  // hourly allowance is generous. The daily one is what actually stops a flood.
  submit: { hour: 10, day: 30 },
  contact: { hour: 5, day: 15 },
};

const buckets = new Map();
let lastPrune = 0;

/**
 * Who is asking.
 *
 * Behind Cloudflare and Render there are two proxies between us and the
 * visitor, and `x-forwarded-for` is a list the visitor can prepend to — the
 * leftmost entry is whatever they claimed. Cloudflare's own header is
 * authoritative when present; failing that the *rightmost* forwarded entry is
 * the one our nearest trusted proxy added. The socket address is the last
 * resort, and is what local requests use.
 */
export function clientKey(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();

  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const parts = String(fwd).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

function prune(now) {
  if (now - lastPrune < 60 * 60 * 1000) return;
  lastPrune = now;
  const longest = Math.max(...WINDOWS.map((w) => w.ms));
  for (const [key, entry] of buckets) {
    if (now - entry.newest > longest) buckets.delete(key);
  }
}

/**
 * Record one use and say whether it is allowed.
 *
 * Returns `{ ok }`, and when refused, which window was hit and how long until
 * it opens again — so the visitor can be told something useful rather than
 * just "no".
 */
export function take(action, key, now = Date.now()) {
  const limits = LIMITS[action];
  if (!limits) return { ok: true };

  prune(now);

  const id = `${action}:${key}`;
  const entry = buckets.get(id) || { stamps: [], newest: 0 };
  const longest = Math.max(...WINDOWS.map((w) => w.ms));
  entry.stamps = entry.stamps.filter((t) => now - t < longest);

  for (const w of WINDOWS) {
    const used = entry.stamps.filter((t) => now - t < w.ms).length;
    if (used >= limits[w.name]) {
      // Not recorded: a refused request must not push the window further out,
      // or hammering the form would keep somebody locked out indefinitely.
      const oldest = entry.stamps.filter((t) => now - t < w.ms)[0];
      buckets.set(id, entry);
      return {
        ok: false,
        window: w.name,
        limit: limits[w.name],
        retryAfter: Math.max(1, Math.ceil((oldest + w.ms - now) / 1000)),
      };
    }
  }

  entry.stamps.push(now);
  entry.newest = now;
  buckets.set(id, entry);
  return { ok: true, remaining: limits.hour - entry.stamps.filter((t) => now - t < WINDOWS[0].ms).length };
}

/** Testing seam, and a way to let a restart mean what it says. */
export const reset = () => { buckets.clear(); lastPrune = 0; };

/** How long to wait, in words a person would use. */
export function waitInWords(seconds) {
  if (seconds < 90) return 'in a minute or so';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  return hours <= 1 ? 'in about an hour' : `in about ${hours} hours`;
}
