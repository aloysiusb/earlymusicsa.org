/* Volunteer tools: the moderation queue, the message queue, and the style
 * editor. This is the one part of the site that genuinely needs JavaScript —
 * everything the public sees is still static HTML.
 *
 * The admin token is held in sessionStorage (this tab only) unless the
 * volunteer ticks "keep me signed in", and is never written into the page.
 */
(function () {
  'use strict';

  var KEY = 'emsa_admin_token';
  var token = sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || '';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  /* ------------------------------------------------------------- requests -- */

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'x-admin-token': token }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { signOut('That token was not accepted.'); throw new Error('unauthorised'); }
      return res.json().catch(function () { return {}; });
    });
  }

  /* --------------------------------------------------------------- signin -- */

  function showTools() {
    $('signin').hidden = true;
    $('tools').hidden = false;
    $('signout').hidden = false;
    $('who').textContent = 'signed in';
    loadEvents();
    loadMessages();
    loadStyle();
  }

  function signOut(why) {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
    token = '';
    $('tools').hidden = true;
    $('signout').hidden = true;
    $('who').textContent = '';
    $('signin').hidden = false;
    if (why) { $('signin-error').textContent = why; $('signin-error').hidden = false; }
  }

  $('signin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    token = $('token').value.trim();
    if (!token) return;
    // A cheap round trip proves the token before showing anything.
    fetch('/api/submissions', { headers: { 'x-admin-token': token } }).then(function (res) {
      if (!res.ok) { signOut('That token was not accepted.'); return; }
      ($('remember').checked ? localStorage : sessionStorage).setItem(KEY, token);
      $('signin-error').hidden = true;
      $('token').value = '';
      showTools();
    });
  });

  $('signout').addEventListener('click', function () { signOut(''); });

  /* ----------------------------------------------------------------- tabs -- */

  Array.prototype.forEach.call(document.querySelectorAll('.admin-tabs button'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.admin-tabs button'), function (b) {
        b.setAttribute('aria-selected', String(b === btn));
      });
      Array.prototype.forEach.call(document.querySelectorAll('.admin-panel'), function (p) {
        p.hidden = p.id !== btn.dataset.panel;
      });
    });
  });

  /* ------------------------------------------------------------ moderation -- */

  function fieldRow(label, value) {
    if (!value) return '';
    return '<div class="row"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function loadEvents() {
    api('/api/submissions?status=pending').then(function (data) {
      var list = data.submissions || [];
      $('c-events').textContent = list.length;
      if (!list.length) {
        $('events-list').innerHTML = '<p class="muted">Nothing waiting. All caught up.</p>';
        return;
      }
      $('events-list').innerHTML = list.map(function (s) {
        var flags = s.spam_reasons
          ? '<p class="flag">Flagged as possible spam: ' + esc(s.spam_reasons.replace(/,/g, ', ')) +
            '. Read it before approving.</p>'
          : '';
        return '<article class="queue-item" data-id="' + s.id + '">' +
          '<h3>' + esc(s.title) + '</h3>' + flags +
          '<dl class="rows">' +
            fieldRow('Starts', s.start_local) +
            fieldRow('Ends', s.end_local) +
            fieldRow('Venue', [s.location_name, s.location_address].filter(Boolean).join(', ')) +
            fieldRow('Presented by', s.organizer_name) +
            fieldRow('Performers', s.performers) +
            fieldRow('Tickets', s.tickets) +
            fieldRow('Website', s.website) +
            fieldRow('Description', s.description) +
            fieldRow('Submitted by', [s.submitter_name, s.submitter_email].filter(Boolean).join(' — ')) +
            fieldRow('Received', new Date(s.created_at).toLocaleString()) +
          '</dl>' +
          '<p class="queue-actions">' +
            '<button class="form-submit" data-act="approve">Approve and publish</button> ' +
            '<button class="ghost danger" data-act="reject">Reject</button>' +
            '<span class="status"></span>' +
          '</p>' +
        '</article>';
      }).join('');
    });
  }

  $('events-list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var item = btn.closest('.queue-item');
    var status = item.querySelector('.status');
    var act = btn.dataset.act;
    if (act === 'reject' && !confirm('Reject "' + item.querySelector('h3').textContent + '"?')) return;

    Array.prototype.forEach.call(item.querySelectorAll('button'), function (b) { b.disabled = true; });
    status.textContent = act === 'approve' ? 'Publishing…' : 'Rejecting…';

    api('/api/submissions/' + item.dataset.id + '/' + act, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(function (r) {
      if (!r.ok) { status.textContent = 'Did not work — try again.'; return; }
      item.classList.add('done');
      status.textContent = act === 'approve' ? 'Published. The site is rebuilding.' : 'Rejected.';
      setTimeout(loadEvents, act === 'approve' ? 7000 : 600);
    });
  });

  /* -------------------------------------------------------------- messages -- */

  function loadMessages() {
    api('/api/messages').then(function (data) {
      var list = data.messages || [];
      $('c-messages').textContent = list.length;
      if (!list.length) {
        $('messages-list').innerHTML = '<p class="muted">No unread messages.</p>';
        return;
      }
      $('messages-list').innerHTML = list.map(function (m) {
        var name = [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Someone';
        return '<article class="queue-item" data-id="' + m.id + '">' +
          '<h3>' + esc(name) + ' &lt;' + esc(m.email) + '&gt;</h3>' +
          '<p class="when">' + esc(new Date(m.created_at).toLocaleString()) + '</p>' +
          '<p class="message-body">' + esc(m.message).replace(/\n/g, '<br>') + '</p>' +
          '<p class="queue-actions">' +
            '<a class="ghost" href="mailto:' + encodeURIComponent(m.email) + '">Reply by email</a> ' +
            '<button class="ghost" data-act="handled">Mark as dealt with</button>' +
            '<span class="status"></span>' +
          '</p>' +
        '</article>';
      }).join('');
    });
  }

  $('messages-list').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act="handled"]');
    if (!btn) return;
    var item = btn.closest('.queue-item');
    api('/api/messages/' + item.dataset.id + '/handled', { method: 'POST' }).then(function () {
      item.classList.add('done');
      setTimeout(loadMessages, 500);
    });
  });

  /* ----------------------------------------------------------------- style -- */

  // Grouped the way someone thinks about the site, not the way the CSS is
  // organised. Every entry is a real custom property in style.css.
  var STYLE_GROUPS = [
    ['Colours', [
      ['--gold', 'Heading gold', 'color'],
      ['--gold-deep', 'Footer bar', 'color'],
      ['--page-title-color', 'Page title gold', 'color'],
      ['--card-bg', 'Event card (default)', 'color'],
      ['--card-text', 'Text on event cards', 'color'],
      ['--form-accent', 'Buttons', 'color'],
      ['--page-bg', 'Page background', 'color'],
      ['--ink', 'Body text', 'color'],
    ]],
    ['Type', [
      ['--text-size', 'Body text size', 'text'],
      ['--page-title-size', 'Page title size', 'text'],
      ['--card-title-size', 'Event title size', 'text'],
      ['--nav-size', 'Menu size', 'text'],
    ]],
    ['Layout', [
      ['--container', 'Content width', 'text'],
      ['--card-radius', 'Card corner rounding', 'text'],
      ['--tile-radius', 'Past-event tile rounding', 'text'],
      ['--banner-height', 'Header banner height', 'text'],
      ['--thumb-size', 'Card thumbnail size', 'text'],
    ]],
  ];

  var saved = {};        // what the server has
  var computedNow = {};  // what the page currently renders

  function currentValue(name) {
    if (saved[name] != null) return saved[name];
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function loadStyle() {
    fetch('/api/style').then(function (r) { return r.json(); }).then(function (d) {
      saved = d.styles || {};
      renderStyle();
    });
  }

  function renderStyle() {
    $('style-groups').innerHTML = STYLE_GROUPS.map(function (g) {
      return '<section class="style-group"><h3>' + esc(g[0]) + '</h3>' +
        g[1].map(function (row) {
          var name = row[0], label = row[1], kind = row[2];
          var val = currentValue(name);
          computedNow[name] = val;
          var input = kind === 'color'
            ? '<input type="color" data-token="' + name + '" value="' + esc(toHex(val)) + '">' +
              '<input type="text" class="hex" data-token="' + name + '" value="' + esc(val) + '" spellcheck="false">'
            : '<input type="text" data-token="' + name + '" value="' + esc(val) + '" spellcheck="false">';
          return '<label class="style-row"><span>' + esc(label) + '</span>' + input +
            '<code>' + esc(name) + '</code></label>';
        }).join('') +
      '</section>';
    }).join('');
  }

  // A colour input only accepts #rrggbb, so anything else shows as its
  // computed colour rather than silently becoming black.
  function toHex(v) {
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    var probe = document.createElement('span');
    probe.style.color = v;
    document.body.appendChild(probe);
    var rgb = getComputedStyle(probe).color.match(/\d+/g);
    document.body.removeChild(probe);
    if (!rgb) return '#000000';
    return '#' + rgb.slice(0, 3).map(function (n) {
      return ('0' + parseInt(n, 10).toString(16)).slice(-2);
    }).join('');
  }

  // Live preview: typing updates the page immediately; Save persists it.
  $('style-groups').addEventListener('input', function (e) {
    var el = e.target.closest('[data-token]');
    if (!el) return;
    var name = el.dataset.token;
    document.documentElement.style.setProperty(name, el.value);
    var partner = $('style-groups').querySelector(
      (el.type === 'color' ? 'input.hex' : 'input[type=color]') + '[data-token="' + name + '"]');
    if (partner) partner.value = el.type === 'color' ? el.value : toHex(el.value);
    $('style-saved').hidden = true;
  });

  $('style-save').addEventListener('click', function () {
    var styles = {};
    Array.prototype.forEach.call($('style-groups').querySelectorAll('[data-token]'), function (el) {
      if (el.type === 'color') return; // the text field beside it is authoritative
      styles[el.dataset.token] = el.value.trim();
    });
    api('/api/style', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ styles: styles }),
    }).then(function (r) {
      if (!r.ok) { alert((r.errors || ['Could not save.']).join('\n')); return; }
      saved = r.styles || {};
      $('style-saved').hidden = false;
    });
  });

  $('style-reset').addEventListener('click', function () {
    Object.keys(computedNow).forEach(function (name) {
      document.documentElement.style.removeProperty(name);
    });
    renderStyle();
    $('style-saved').hidden = true;
  });

  /* ------------------------------------------------------------------ boot -- */

  if (token) {
    fetch('/api/submissions', { headers: { 'x-admin-token': token } }).then(function (res) {
      if (res.ok) showTools(); else signOut('');
    }).catch(function () { signOut(''); });
  }
})();
