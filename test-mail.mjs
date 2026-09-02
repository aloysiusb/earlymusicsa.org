/**
 * test-mail.mjs — proves the notification mail actually goes out.
 *
 * The thing worth proving: this is a hand-written SMTP client, so the whole
 * conversation has to be right — greeting, EHLO, AUTH in either dialect, one
 * RCPT per recipient, dot-stuffing, and a clean QUIT. It runs against a fake
 * mail server here rather than a real one, so the test needs no account, no
 * network and no credentials.
 *
 * Equally worth proving: when the mail server misbehaves, the visitor never
 * finds out. A refused login must not cost somebody their thank-you page.
 *
 *   node test-mail.mjs
 */

import net from 'node:net';
import {
  buildMessage, dotStuff, encodeHeader, mailConfig, mailConfigured,
  sendMail, submissionNotice, messageNotice, notify,
} from './mailer.js';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('--- notification email ---');

/* ------------------------------------------------------------ a fake MTA -- */

/**
 * Speaks just enough SMTP to be convincing, and records everything it was
 * told. `mode` lets a test make it behave badly.
 */
function fakeServer({ mode = 'plain' } = {}) {
  const log = { commands: [], recipients: [], body: '', from: '' };
  let inData = false;

  const server = net.createServer((sock) => {
    sock.write('220 fake.example.com ESMTP ready\r\n');
    let buf = '';

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);

        if (inData) {
          if (line === '.') { inData = false; sock.write('250 2.0.0 Queued\r\n'); }
          // A real receiver undoes the dot-stuffing, which is what makes this a
          // round trip rather than a check that we doubled something.
          else log.body += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }

        log.commands.push(line.split(' ')[0].toUpperCase());
        const up = line.toUpperCase();

        if (up.startsWith('EHLO')) {
          const auth = mode === 'login' ? 'AUTH LOGIN' : 'AUTH PLAIN LOGIN';
          sock.write(`250-fake.example.com\r\n250-PIPELINING\r\n250 ${auth}\r\n`);
        } else if (up.startsWith('AUTH PLAIN')) {
          sock.write(mode === 'badpass' ? '535 5.7.8 Bad credentials\r\n' : '235 2.7.0 Accepted\r\n');
        } else if (up === 'AUTH LOGIN') {
          sock.write('334 VXNlcm5hbWU6\r\n');
        } else if (up.startsWith('MAIL FROM')) {
          log.from = line.slice(line.indexOf('<') + 1, line.lastIndexOf('>'));
          sock.write('250 2.1.0 Sender ok\r\n');
        } else if (up.startsWith('RCPT TO')) {
          log.recipients.push(line.slice(line.indexOf('<') + 1, line.lastIndexOf('>')));
          sock.write('250 2.1.5 Recipient ok\r\n');
        } else if (up === 'DATA') {
          inData = true;
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (up === 'QUIT') {
          sock.write('221 2.0.0 Bye\r\n');
          sock.end();
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // a base64 AUTH LOGIN step
          log.commands[log.commands.length - 1] = 'B64';
          sock.write(log.commands.filter((c) => c === 'B64').length === 1
            ? '334 UGFzc3dvcmQ6\r\n'
            : (mode === 'badpass' ? '535 5.7.8 Bad credentials\r\n' : '235 2.7.0 Accepted\r\n'));
        } else {
          sock.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    sock.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, log, port: server.address().port }));
  });
}

const cfgFor = (port) => ({
  host: '127.0.0.1', port, user: 'volunteer@earlymusicsa.org', pass: 'hunter2',
  from: 'volunteer@earlymusicsa.org',
  to: ['one@example.org', 'two@example.org'],
  site: 'https://www.earlymusicsa.org',
});

/* ------------------------------------------------------- shaping the note -- */

check('a plain ASCII subject is left alone',
  encodeHeader('New event submitted: Bach & Beer') === 'New event submitted: Bach & Beer');
check('an accented subject is encoded, not mangled',
  encodeHeader('Membra Jesu nostri — Buxtehude').startsWith('=?UTF-8?B?'));
check('a line starting with a dot is doubled',
  dotStuff('one\n.two\nthree').includes('\r\n..two\r\n'),
  JSON.stringify(dotStuff('one\n.two\nthree')));
check('line breaks become CRLF', !/[^\r]\n/.test(dotStuff('a\nb\nc')));

const msg = buildMessage({
  from: 'a@b.c', to: ['x@y.z', 'p@q.r'], subject: 'Hello', text: 'Body here.',
});
check('both recipients appear in the To header', msg.includes('To: x@y.z, p@q.r'));
check('the message declares UTF-8', msg.includes('Content-Type: text/plain; charset=utf-8'));
check('it is marked auto-generated', msg.includes('Auto-Submitted: auto-generated'));
check('headers are separated from the body by a blank line', msg.includes('\r\n\r\nBody here.'));

const sub = submissionNotice(
  { title: 'Bach & Beer', start_local: '2026-09-11T19:30', location_name: 'Redeemer', submitter_email: 'a@b.c' },
  { site: 'https://www.earlymusicsa.org' },
);
check('the submission notice names the event', sub.subject === 'New event submitted: Bach & Beer');
check('and links to the admin page', sub.text.includes('/admin.html'));
check('and says it is not live yet', /not on the site/i.test(sub.text));
check('an empty field is left out rather than shown blank', !sub.text.includes('Performers:'));

const flagged = submissionNotice({ title: 'X', spam_reasons: 'too many links' }, { site: 's' });
check('a flagged submission says so', /flagged as possible spam/i.test(flagged.text));

const note = messageNotice({ first_name: 'Ada', last_name: 'L', email: 'ada@x.org', message: 'Hello there' },
  { site: 'https://www.earlymusicsa.org' });
check('the message notice names the sender', note.subject === 'Message from Ada L');
check('and carries their address for a reply', note.text.includes('ada@x.org'));

/* ----------------------------------------------------------- not set up -- */

check('with nothing configured, mail is off', !mailConfigured(mailConfig({})));
check('half-configured still counts as off',
  !mailConfigured(mailConfig({ SMTP_HOST: 'h', SMTP_USER: 'u' })));
check('MAIL_TO splits into several recipients',
  mailConfig({ MAIL_TO: 'a@x.org, b@y.org' }).to.length === 2);
const skipped = await sendMail({ subject: 's', text: 't' }, mailConfig({}));
check('sending without configuration is skipped, not an error', skipped.skipped === true);

/* ------------------------------------------------------ the real thing --- */

{
  const { server, log, port } = await fakeServer({ mode: 'plain' });
  const result = await sendMail(
    { subject: 'New event submitted: Café Zimmermann', text: 'Line one\n.dotted line\nLine three' },
    cfgFor(port),
  );
  server.close();

  check('the send reports success', result.ok === true, JSON.stringify(result));
  check('it reports both recipients', result.recipients === 2);
  check('the conversation is in the right order',
    log.commands.join(' ').startsWith('EHLO AUTH MAIL RCPT RCPT DATA'), log.commands.join(' '));
  check('AUTH PLAIN was used when offered', log.commands.includes('AUTH'));
  check('one RCPT per recipient', log.recipients.length === 2, log.recipients.join(', '));
  check('both addresses were given to the server',
    log.recipients.join(',') === 'one@example.org,two@example.org', log.recipients.join(','));
  check('the sender is the configured one', log.from === 'volunteer@earlymusicsa.org', log.from);
  check('it said QUIT rather than dropping the connection', log.commands.includes('QUIT'));
  check('the accented subject arrived encoded', /Subject: =\?UTF-8\?B\?/.test(log.body));
  check('the dotted line survived the round trip', log.body.includes('\n.dotted line'),
    JSON.stringify(log.body.slice(-120)));
  check('the body is not truncated at the dot', log.body.includes('Line three'));
}

/* ------------------------------------------------------ the other dialect -- */

{
  const { server, log, port } = await fakeServer({ mode: 'login' });
  const result = await sendMail({ subject: 'Hello', text: 'Body' }, cfgFor(port));
  server.close();
  check('AUTH LOGIN works where PLAIN is not offered', result.ok === true, JSON.stringify(result));
  check('the login was done in two base64 steps',
    log.commands.filter((c) => c === 'B64').length === 2, log.commands.join(' '));
}

/* -------------------------------------------------------- when it fails --- */

{
  const { server, port } = await fakeServer({ mode: 'badpass' });
  let threw = null;
  await sendMail({ subject: 'Hello', text: 'Body' }, cfgFor(port)).catch((e) => { threw = e; });
  server.close();
  check('a refused password is an error, not a silent success', threw !== null);
  check('and the error says what was refused', threw && /password refused/i.test(threw.message),
    threw && threw.message);
}

{
  // Nothing listening at all — the visitor must never see this.
  const cfg = { ...cfgFor(1), host: '127.0.0.1', port: 1 };
  let threw = null;
  try {
    notify({ subject: 'Hello', text: 'Body' }, cfg);           // deliberately not awaited
    await new Promise((r) => setTimeout(r, 600));
  } catch (e) { threw = e; }
  check('notify() swallows a dead mail server rather than throwing', threw === null,
    threw && threw.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
