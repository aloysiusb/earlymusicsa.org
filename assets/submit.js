/* The Submit page's interactive parts, mirroring EventON's form:
 *   - All Day / No end time / repeating checkboxes reveal and hide fields
 *   - picking a saved venue fills the address and shows its map
 *   - a venue we have never listed is looked up, and gets a map too
 *
 * The form still submits and validates without any of this. Everything here
 * only makes it easier to fill in.
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var form = $('#submit-form');
  if (!form) return;

  /* ------------------------------------------------- show and hide fields -- */

  function toggle(checkboxId, rowSelector, hideWhenChecked) {
    var box = $('#' + checkboxId);
    var rows = document.querySelectorAll(rowSelector);
    if (!box) return;
    var apply = function () {
      Array.prototype.forEach.call(rows, function (r) {
        r.hidden = hideWhenChecked ? box.checked : !box.checked;
      });
    };
    box.addEventListener('change', apply);
    apply();
  }

  // An all-day event has no clock times; "no end time" drops the end entirely.
  toggle('all_day', '[data-when="timed"]', true);
  toggle('no_end_time', '[data-when="has-end"]', true);
  toggle('repeating', '[data-when="repeating"]', false);

  /* ----------------------------------------------------------------- venue -- */

  var venueSelect = $('#venue_select');
  var venueName = $('#location_name');
  var venueAddr = $('#location_address');
  var latField = $('#location_lat');
  var lonField = $('#location_lon');
  var mapBox = $('#venue-map');
  var mapNote = $('#venue-map-note');

  // Saved venues and their coordinates, written into the page by build.js.
  var VENUES = window.EMSA_VENUES || {};

  var TILE = 256, ZOOM = 15, COLS = 3, ROWS = 3;

  function lonToTileX(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z); }
  function latToTileY(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  /* Draw the map as a grid of tile images the browser composites — the same
     approach the event pages use. No iframe, so nothing can quietly fail to
     render inside one. */
  function drawMap(lat, lon, label) {
    if (!mapBox) return;
    var cx = lonToTileX(lon, ZOOM), cy = latToTileY(lat, ZOOM);
    var x0 = Math.floor(cx) - (COLS >> 1), y0 = Math.floor(cy) - (ROWS >> 1);
    var imgs = '';
    for (var dy = 0; dy < ROWS; dy++) {
      for (var dx = 0; dx < COLS; dx++) {
        imgs += '<img alt="" width="' + TILE + '" height="' + TILE + '" loading="lazy" src="'
          + '/api/tile/' + ZOOM + '/' + (x0 + dx) + '/' + (y0 + dy) + '.png">';
      }
    }
    mapBox.innerHTML =
      '<div class="staticmap">' +
        '<div class="staticmap-plane" style="left:calc(50% - ' + ((cx - x0) * TILE).toFixed(1) +
          'px);top:calc(50% - ' + ((cy - y0) * TILE).toFixed(1) + 'px)">' + imgs + '</div>' +
        '<span class="staticmap-pin"></span>' +
        '<a class="staticmap-credit" href="https://www.openstreetmap.org/copyright" ' +
          'target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>' +
      '</div>';
    mapBox.hidden = false;
    if (mapNote) {
      mapNote.textContent = label ? 'Found: ' + label : '';
      mapNote.hidden = !label;
    }
    if (latField) latField.value = lat;
    if (lonField) lonField.value = lon;
  }

  function clearMap(note) {
    if (mapBox) { mapBox.hidden = true; mapBox.innerHTML = ''; }
    if (latField) latField.value = '';
    if (lonField) lonField.value = '';
    if (mapNote) { mapNote.textContent = note || ''; mapNote.hidden = !note; }
  }

  // Choosing a saved venue fills everything in, including its known position.
  if (venueSelect) {
    venueSelect.addEventListener('change', function () {
      var v = VENUES[venueSelect.value];
      if (!v) { if (venueSelect.value === '') clearMap(''); return; }
      venueName.value = v.name;
      venueAddr.value = v.address || '';
      if (v.lat) drawMap(v.lat, v.lon, '');
      else clearMap('We do not have a position for this venue yet.');
    });
  }

  /* A venue we have not listed before: ask the server to look it up. This is
     what replaces the old site's Google Maps embed, which needed an API key
     with billing attached and had stopped working. */
  var lookupBtn = $('#venue-lookup');
  if (lookupBtn) {
    lookupBtn.addEventListener('click', function () {
      var q = [venueName.value, venueAddr.value].filter(Boolean).join(', ').trim();
      if (q.length < 4) { clearMap('Type a venue name or address first.'); return; }
      lookupBtn.disabled = true;
      if (mapNote) { mapNote.textContent = 'Looking it up…'; mapNote.hidden = false; }
      fetch('/api/geocode?q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          lookupBtn.disabled = false;
          if (d && d.ok) drawMap(d.lat, d.lon, d.label);
          else clearMap('We could not find that address. You can still submit — a volunteer will sort it out.');
        })
        .catch(function () {
          lookupBtn.disabled = false;
          clearMap('The lookup did not respond. You can still submit the event.');
        });
    });
  }

  /* ------------------------------------------------------------ event type -- */

  // 113 categories is a lot to scroll past; let people filter them.
  var typeFilter = $('#type-filter');
  if (typeFilter) {
    typeFilter.addEventListener('input', function () {
      var q = typeFilter.value.toLowerCase();
      Array.prototype.forEach.call(document.querySelectorAll('.type-option'), function (el) {
        el.hidden = q ? el.textContent.toLowerCase().indexOf(q) === -1 : false;
      });
    });
  }
})();
