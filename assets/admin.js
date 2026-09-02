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
  var qs = function (sel, root) { return (root || document).querySelector(sel); };
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
    searchEvents();
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


  /* ------------------------------------------------------- editing events -- */

  // The fields an editor may change, and how to show each one.
  var EDIT_FIELDS = [
    ['title', 'Event name', 'text'],
    ['start', 'Starts', 'datetime-local'],
    ['end', 'Ends', 'datetime-local'],
    ['subtitle', 'Sub title', 'text'],
    ['description', 'Description', 'textarea'],
    ['performers', 'Performers', 'text'],
    ['locationName', 'Venue', 'text'],
    ['locationAddress', 'Venue address', 'text'],
    ['organizerName', 'Presented by', 'text'],
    ['tickets', 'Ticket information', 'text'],
    ['website', 'Website', 'text'],
    ['image', 'Image link', 'text'],
    ['color', 'Event colour', 'color'],
  ];

  var searchTimer = null;

  function searchEvents() {
    var q = $('event-search').value.trim();
    api('/api/events?q=' + encodeURIComponent(q)).then(function (d) {
      var list = d.events || [];
      $('event-count').textContent = d.total
        ? d.total + ' event' + (d.total === 1 ? '' : 's') +
          (d.total > list.length ? ' — showing the first ' + list.length : '')
        : 'Nothing matched.';
      $('event-results').innerHTML = list.map(function (e) {
        return '<article class="queue-item compact" data-id="' + esc(e.id) + '">' +
          '<h3>' + esc(e.title) + '</h3>' +
          '<p class="when">' + esc((e.start || 'no date').slice(0, 16).replace('T', ' ')) +
            (e.venue ? ' · ' + esc(e.venue) : '') +
            (e.edited ? ' <span class="tag">edited</span>' : '') +
            (e.hidden ? ' <span class="tag warn">hidden</span>' : '') + '</p>' +
          '<p class="queue-actions"><button class="ghost" data-act="edit">Edit</button></p>' +
        '</article>';
      }).join('');
    });
  }

  $('event-search').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchEvents, 250);
  });

  $('event-results').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act="edit"]');
    if (!btn) return;
    openEditor(btn.closest('.queue-item').dataset.id);
  });

  // A datetime-local input wants "2026-09-11T19:30" with no offset.
  function forInput(iso) { return iso ? String(iso).slice(0, 16) : ''; }

  function openEditor(id) {
    api('/api/events/' + encodeURIComponent(id)).then(function (d) {
      if (!d.ok) return;
      var ev = d.event, patch = d.patch || {}, original = d.original || d.event;
      // Read a field out of whichever listing is asked for: the merged one fills
      // the boxes, the original is what each box is compared against on save.
      var read = function (src, key) {
        if (key === 'locationName') return (src.location && src.location.name) || '';
        if (key === 'locationAddress') return (src.location && src.location.address) || '';
        if (key === 'organizerName') return (src.organizer && src.organizer.name) || '';
        if (key === 'start' || key === 'end') return forInput(src[key]);
        return src[key] == null ? '' : String(src[key]);
      };

      var rows = EDIT_FIELDS.map(function (f) {
        var key = f[0], label = f[1], kind = f[2];
        var v = read(ev, key);
        var o = ' data-orig="' + esc(read(original, key)) + '"';
        var changed = key in patch ? ' changed' : '';
        var input;
        if (kind === 'textarea') {
          input = '<textarea data-field="' + key + '"' + o + ' rows="5">' + esc(v) + '</textarea>';
        } else if (kind === 'color') {
          input = '<span class="colour-row">' +
            '<input type="color" value="' + esc(v || '#b3d1db') + '">' +
            '<input type="text" data-field="' + key + '" data-hex="1"' + o +
              ' value="' + esc(v) + '" placeholder="unset">' +
            '</span>';
        } else {
          input = '<input type="' + kind + '" data-field="' + key + '"' + o + ' value="' + esc(v) + '">';
        }
        return '<p class="field' + changed + '"><label>' + esc(label) + '</label>' + input + '</p>';
      }).join('');

      $('event-editor').innerHTML =
        '<div class="editor-card" data-id="' + esc(id) + '">' +
          '<h3>Editing: ' + esc(ev.title) + '</h3>' +
          '<p class="muted">Anything left alone keeps following the original listing.</p>' +
          '<div class="site-form form-evo">' + rows +
            '<p class="field checkbox"><input type="checkbox" data-field="hidden"' +
              (ev.hidden ? ' checked' : '') + '> <label>Hide this event from the site</label></p>' +
          '</div>' +
          '<p class="queue-actions">' +
            '<button class="form-submit" data-act="save">Save and rebuild</button> ' +
            '<button class="ghost" data-act="revert">Undo all edits to this event</button> ' +
            '<button class="ghost" data-act="close">Close</button>' +
            '<span class="status"></span>' +
          '</p>' +
        '</div>';
      $('event-editor').hidden = false;
      $('event-editor').scrollIntoView({ block: 'start' });

      var colour = qs('#event-editor input[type="color"]');
      var hex = qs('#event-editor input[data-hex]');
      if (colour && hex) {
        colour.addEventListener('input', function () { hex.value = colour.value; });
        hex.addEventListener('input', function () {
          if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) colour.value = hex.value;
        });
      }
    });
  }

  $('event-editor').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var card = btn.closest('.editor-card');
    var id = card.dataset.id;
    var status = card.querySelector('.status');

    if (btn.dataset.act === 'close') {
      $('event-editor').hidden = true;
      $('event-editor').innerHTML = '';
      return;
    }

    if (btn.dataset.act === 'revert') {
      if (!confirm('Undo every edit to this event and go back to the original listing?')) return;
      status.textContent = 'Reverting…';
      api('/api/events/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
        status.textContent = 'Reverted. The site is rebuilding.';
        setTimeout(function () { searchEvents(); openEditor(id); }, 1200);
      });
      return;
    }

    // Only fields that differ from the original listing become overrides, so
    // an untouched box keeps following the original instead of being frozen at
    // today's value. Emptying a box that had something in it clears the field.
    var patch = {};
    Array.prototype.forEach.call(card.querySelectorAll('[data-field]'), function (el) {
      var key = el.dataset.field;
      if (el.type === 'checkbox') { if (el.checked) patch[key] = true; return; }
      var v = el.value.trim();
      if (v !== (el.dataset.orig || '')) patch[key] = v;
    });

    status.textContent = 'Saving…';
    api('/api/events/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: patch }),
    }).then(function (r) {
      if (!r.ok) { status.textContent = (r.errors || ['Could not save.']).join(' '); return; }
      status.textContent = 'Saved. The site is rebuilding.';
      setTimeout(searchEvents, 1200);
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
