/**
 * mailer.js — a small SMTP client, so the site can tell somebody that
 * something arrived.
 *
 * Submissions and contact messages land in the database and wait there. That
 * only works if a volunteer remembers to look, which is a poor thing to rely
 * on: a concert submitted in good time can sit unseen until its date has
 * passed. This sends a short note the moment something lands.
 *
 * SMTP rather than a provider's HTTP API, for one reason: SMTP is universal.
 * It works with the mailbox that already exists on the domain, which means no
 * new account, no API key, and no DNS records to add next to the ones carrying
 * the group's real mail. If a sending service is preferred later they all speak
 * SMTP too — four environment variables, not a change of code.
 *
 * No dependencies, following the rest of this project.
 *
 *   SMTP_HOST   mail.example.com
 *   SMTP_PORT   587 (STARTTLS) or 465 (TLS from the first byte)
 *   SMTP_USER   the mailbox
 *   SMTP_PASS   its password
 *   MAIL_FROM   who it comes from — usually the same mailbox
 *   MAIL_TO     who to tell, comma-separated for more than one
 *
 * With any of those missing nothing is sent and nothing breaks: the site
 * behaves exactly as it did before, and the queue is still the record.
 */

import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const LOOPBACK = /^(127\.|::1$|localhost$)/i;
const CONNECT_TIMEOUT = 10000;
const REPLY_TIMEOUT = 20000;

export function mailConfig(env = process.env) {
  return {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || env.SMTP_USER || '',
    to: (env.MAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
    site: env.SITE_URL || 'https://www.earlymusicsa.org',
  };
}

export const mailConfigured = (cfg = mailConfig()) =>
  Boolean(cfg.host && cfg.user && cfg.pass && cfg.from && cfg.to.length);

/* ------------------------------------------------------------- the note -- */

/** RFC 2047, so a subject with an accent in it does not arrive as mojibake. */
export function encodeHeader(value) {
  const s = String(value ?? '');
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * A body line beginning with a dot would end the message early, so SMTP wants
 * it doubled. Line breaks become CRLF while we are here.
 */
export const dotStuff = (body) =>
  String(body ?? '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');

export function buildMessage({ from, to, subject, text }) {
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@earlymusicsa.org>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',   // keeps it out of other people's autoresponders
  ];
  return `${headers.join('\r\n')}\r\n\r\n${dotStuff(text)}`;
}

/* ----------------------------------------------------------- the client -- */

/**
 * Wraps a socket so replies can be awaited one at a time.
 *
 * A reply can run to several lines: "250-PIPELINING" continues, "250 OK" ends
 * it. Reading stops at the first line with a space rather than a hyphen after
 * the code.
 */
function reader(socket) {
  let buffer = '';
  let waiting = null;

  const settle = () => {
    if (!waiting) return;
    const lines = buffer.split('\r\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last || !/^\d{3} /.test(last)) return;
    const reply = buffer;
    buffer = '';
    const { resolve, timer } = waiting;
    waiting = null;
    clearTimeout(timer);
    resolve({ code: Number(last.slice(0, 3)), text: reply.trim() });
  };

  const fail = (err) => {
    if (!waiting) return;
    const { reject, timer } = waiting;
    waiting = null;
    clearTimeout(timer);
    reject(err);
  };

  socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); settle(); });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('the mail server closed the connection')));

  return {
    read(what) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`timed out waiting for ${what}`)), REPLY_TIMEOUT);
        waiting = { resolve, reject, timer };
        settle();
      });
    },
    detach() { socket.removeAllListeners('data'); socket.removeAllListeners('close'); },
  };
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const socket = cfg.port === 465
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    const fail = (err) => reject(err);
    socket.once('error', fail);
    socket.setTimeout(CONNECT_TIMEOUT, () =>
      socket.destroy(new Error(`could not reach ${cfg.host}:${cfg.port} in time`)));
    socket.once(cfg.port === 465 ? 'secureConnect' : 'connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      resolve(socket);
    });
  });
}

/** Raise a plain connection to TLS in place, for port 587. */
function upgrade(socket, cfg) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: cfg.host }, () => {
      secure.removeListener('error', reject);
      resolve(secure);
    });
    secure.once('error', reject);
  });
}

export async function sendMail({ subject, text }, cfg = mailConfig()) {
  if (!mailConfigured(cfg)) return { ok: false, skipped: true, reason: 'mail is not configured' };

  const me = 'earlymusicsa.org';
  let socket = await connect(cfg);
  let io = reader(socket);

  /** Say something, and insist on one of the codes that means it went well. */
  const say = async (text_, expect, what) => {
    if (text_ !== null) socket.write(`${text_}\r\n`);
    const reply = await io.read(what);
    if (!expect.includes(reply.code)) throw new Error(`${what} refused: ${reply.text}`);
    return reply;
  };

  try {
    await say(null, [220], 'the greeting');

    // The password must go over TLS. The one exception is a server on this
    // machine, which is how the tests hold a real conversation with a fake mail
    // server -- nothing crosses a wire, so there is nothing to protect. Anything
    // else, including a mistyped host, gets no password without TLS.
    if (cfg.port !== 465 && !LOOPBACK.test(cfg.host)) {
      const first = await say(`EHLO ${me}`, [250], 'EHLO');
      if (!/STARTTLS/i.test(first.text)) {
        throw new Error(`${cfg.host} does not offer STARTTLS, so the password cannot be sent safely`);
      }
      await say('STARTTLS', [220], 'STARTTLS');
      // The password must not cross in the clear, so the conversation starts
      // again on the encrypted socket.
      io.detach();
      socket = await upgrade(socket, cfg);
      io = reader(socket);
    }

    const hello = await say(`EHLO ${me}`, [250], 'EHLO');

    if (/AUTH[ =][^\r\n]*PLAIN/i.test(hello.text)) {
      await say(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, [235], 'the password');
    } else {
      await say('AUTH LOGIN', [334], 'the login prompt');
      await say(b64(cfg.user), [334], 'the mailbox name');
      await say(b64(cfg.pass), [235], 'the password');
    }

    await say(`MAIL FROM:<${cfg.from}>`, [250], 'the sender');
    for (const addr of cfg.to) {
      await say(`RCPT TO:<${addr}>`, [250, 251], `the recipient ${addr}`);
    }
    await say('DATA', [354], 'DATA');
    await say(`${buildMessage({ ...cfg, subject, text })}\r\n.`, [250], 'the message');
    await say('QUIT', [221, 250], 'QUIT').catch(() => {});   // a rude goodbye is harmless

    return { ok: true, recipients: cfg.to.length };
  } finally {
    io.detach();
    socket.destroy();
  }
}

/* ---------------------------------------------------------- the notices -- */

const line = (label, value) => (value ? `${label}: ${value}\n` : '');

export function submissionNotice(s, cfg = mailConfig()) {
  const flagged = s.spam_reasons
    ? `\nFlagged as possible spam (${s.spam_reasons}). That is a guess, not a\nverdict — read it before deciding.\n`
    : '';
  return {
    subject: `New event submitted: ${s.title}`,
    text: `Somebody has submitted an event. It is waiting to be approved — until
then it is not on the site.

${line('Event', s.title)}${line('Starts', s.start_local)}${line('Ends', s.end_local)
    }${line('Venue', [s.location_name, s.location_address].filter(Boolean).join(', '))
    }${line('Presented by', s.organizer_name)}${line('Performers', s.performers)
    }${line('Tickets', s.tickets)}${line('Website', s.website)
    }${line('Sent by', [s.submitter_name, s.submitter_email].filter(Boolean).join(' — '))}${flagged}${
  s.description ? `\n${s.description}\n` : ''}
Approve or reject it here:
${cfg.site}/admin.html
`,
  };
}

export function messageNotice(m, cfg = mailConfig()) {
  const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Someone';
  return {
    subject: `Message from ${name}`,
    text: `${name} <${m.email}> wrote in through the Contact page.

${m.message}

Reply to them directly at ${m.email}, or read it here:
${cfg.site}/admin.html
`,
  };
}

/**
 * Tell somebody, without ever making that their problem.
 *
 * Whatever prompted this is already safely stored by the time it runs. If the
 * mail server is down, slow, or the password was mistyped, the visitor must
 * still get their thank-you page — so this never throws and never delays the
 * reply. A failure is logged; the queue on /admin.html remains the record.
 */
export function notify(notice, cfg = mailConfig()) {
  if (!mailConfigured(cfg)) return;
  sendMail(notice, cfg)
    .then((r) => { if (r.ok) console.log(`  emailed ${r.recipients} recipient(s): ${notice.subject}`); })
    .catch((err) => console.warn(`  could not send the notification (${err.message})`));
}
