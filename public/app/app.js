/* =============================================================================
 * Gistly — mobile app logic (public/app/app.js)  · framework-free, no build step
 * -----------------------------------------------------------------------------
 * A small screen state-machine (welcome → home → loading → result, plus history)
 * wired to the real Gistly Worker:  POST /api/summarize  { videoId }
 *   200 -> { tldr, keyPoints, cheatSheet, title, channel, cached }
 *   4xx/5xx -> { error: "<code>" }   (invalid_id|no_transcript|rate_limited|daily_cap|...)
 *
 * History + favorites live in localStorage (per-device, available offline).
 * Shared YouTube links arrive via the manifest share_target or a ?url=/?v= deep
 * link and summarize immediately.
 * ===========================================================================*/
(function () {
  'use strict';

  // ---- config ---------------------------------------------------------------
  var API = '/api/summarize';
  var STATUS_MESSAGES = [
    'Grabbing the transcript…',
    'Reading the whole video…',
    'Pulling out the good stuff…',
    'Almost done…'
  ];
  var ERROR_MESSAGES = {
    invalid_id:    "Hmm, that doesn't look like a YouTube link — double-check and try again.",
    no_transcript: "This video doesn't have a transcript we can read — try a different one.",
    rate_limited:  'Whoa, slow down a sec — try again in a minute.',
    daily_cap:     "We've hit today's free limit — please check back tomorrow.",
    generic:       'Something went wrong on our end. Give it another try.'
  };
  // Suggested example videos (real — they summarize through the live backend).
  var CHIPS = [
    { id: 'arj7oStGLkU', label: 'Procrastination' },
    { id: 'eIho2S0ZahI', label: 'Speaking tips' },
    { id: 'qp0HIF3SfI4', label: 'Start with Why' }
  ];

  // ---- storage --------------------------------------------------------------
  var LS_HISTORY = 'gistly_history', LS_FAVS = 'gistly_favs', LS_ONBOARDED = 'gistly_onboarded';
  function load(key, fb) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  var savedHistory = load(LS_HISTORY, []); // array of summary objects, most-recent first
  var favs = load(LS_FAVS, {});            // { videoId: true }

  // ---- state ----------------------------------------------------------------
  var els = {};
  var screens = ['welcome', 'home', 'loading', 'result', 'history'];
  var current = null;       // summary object on the result screen
  var statusTimer = null;
  var inflight = null;      // token identifying the in-flight request (ignore stale)
  var currentAbort = null;  // AbortController for the in-flight request (cancel/timeout)
  var sheetPrevFocus = null;// element to restore focus to when the share sheet closes
  var autoPasteTried = false;

  // ---- helpers --------------------------------------------------------------
  function byId(id) { return document.getElementById(id); }
  function thumbUrl(id) { return 'https://img.youtube.com/vi/' + id + '/hqdefault.jpg'; }

  function parseId(raw) {
    var s = (raw || '').trim();
    if (!s) return null;
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    var pats = [
      /[?&]v=([A-Za-z0-9_-]{11})/,
      /youtu\.be\/([A-Za-z0-9_-]{11})/,
      /\/shorts\/([A-Za-z0-9_-]{11})/,
      /\/embed\/([A-Za-z0-9_-]{11})/,
      /\/live\/([A-Za-z0-9_-]{11})/,
      /\/v\/([A-Za-z0-9_-]{11})/
    ];
    for (var i = 0; i < pats.length; i++) { var m = s.match(pats[i]); if (m) return m[1]; }
    var tail = s.match(/\/([A-Za-z0-9_-]{11})(?:[?&\/#]|$)/);
    return tail ? tail[1] : null;
  }

  function relTime(ts) {
    if (!ts) return 'Just now';
    var diff = Date.now() - ts, m = 60000, h = 3600000, d = 86400000;
    if (diff < m) return 'Just now';
    if (diff < h) return Math.floor(diff / m) + 'm ago';
    if (diff < d) return Math.floor(diff / h) + 'h ago';
    if (diff < 2 * d) return 'Yesterday';
    if (diff < 7 * d) return Math.floor(diff / d) + 'd ago';
    try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }

  function heart(active, size, outline) {
    size = size || 20;
    if (active) return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.2C.6 9 1.6 5.5 4.8 4.7 7 4.1 9 5 12 8c3-3 5-3.9 7.2-3.3C22.4 5.5 23.4 9 22 11.8 19.5 16.4 12 21 12 21z" fill="var(--acc)"></path></svg>';
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 20s-6.8-4.2-9.2-8.5C1.5 9 2.4 6.1 5.1 5.4 7 4.9 8.9 5.8 12 8.7c3.1-2.9 5-3.8 6.9-3.3 2.7.7 3.6 3.6 2.3 6.1C18.8 15.8 12 20 12 20z" stroke="' + (outline || 'var(--soft)') + '" stroke-width="1.7" stroke-linejoin="round"></path></svg>';
  }

  function showScreen(name) {
    screens.forEach(function (s) { var el = els['screen_' + s]; if (el) el.hidden = (s !== name); });
    try { els.app.scrollTop = 0; window.scrollTo(0, 0); } catch (e) {}
  }

  // ---- favorites + history --------------------------------------------------
  function isFav(id) { return !!favs[id]; }
  function setFav(id, val) { if (val) favs[id] = true; else delete favs[id]; save(LS_FAVS, favs); }
  // Paint a favorite toggle button: heart icon + accessible pressed state/label.
  function paintFav(btn, id, size, outline) {
    var on = isFav(id);
    btn.innerHTML = heart(on, size, outline);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
  }
  function saveToHistory(s) {
    savedHistory = savedHistory.filter(function (h) { return h.videoId !== s.videoId; });
    savedHistory.unshift(s);
    if (savedHistory.length > 50) savedHistory = savedHistory.slice(0, 50);
    save(LS_HISTORY, savedHistory);
  }

  // ---- copy -----------------------------------------------------------------
  function bullets(arr) { return (arr || []).map(function (x) { return '• ' + x; }).join('\n'); }
  function summaryText(s, which) {
    if (which === 'tldr') return s.tldr || '';
    if (which === 'points') return bullets(s.keyPoints);
    if (which === 'cheat') return bullets(s.cheatSheet);
    return (s.title ? s.title + '\n\n' : '') +
      'TL;DR\n' + (s.tldr || '') +
      '\n\nKey Points\n' + bullets(s.keyPoints) +
      '\n\nCheat Sheet\n' + bullets(s.cheatSheet);
  }
  function doCopy(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return; } } catch (e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  }
  function flashCopy(btn, normal) {
    btn.textContent = '✓ Copied'; btn.classList.add('is-copied');
    clearTimeout(btn._t); btn._t = setTimeout(function () { btn.textContent = normal; btn.classList.remove('is-copied'); }, 1600);
  }

  // ---- loading status rotation ----------------------------------------------
  function startStatus() {
    var i = 0; els.load_msg.textContent = STATUS_MESSAGES[0]; stopStatus();
    statusTimer = setInterval(function () {
      i = Math.min(i + 1, STATUS_MESSAGES.length - 1);
      els.load_msg.textContent = STATUS_MESSAGES[i];
    }, 1800);
  }
  function stopStatus() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

  // ---- the core flow --------------------------------------------------------
  function showNudge(msg, isError) {
    els.home_nudge.textContent = msg;
    els.home_nudge.classList.toggle('is-error', !!isError);
    els.home_nudge.hidden = false;
  }
  function hideNudge() { els.home_nudge.hidden = true; }

  function submitFromHome() {
    var v = (els.home_input.value || '').trim();
    if (!v) { showNudge('Paste a link first — tap the box above.', false); return; }
    var id = parseId(v);
    if (!id) { showNudge(ERROR_MESSAGES.invalid_id, true); return; }
    summarize(id);
  }

  function summarize(id) {
    save(LS_ONBOARDED, true);
    hideNudge();
    stopStatus();
    els.load_thumb.hidden = false;
    els.load_thumb_img.src = thumbUrl(id);
    showScreen('loading');
    startStatus();

    var token = {}; inflight = token;
    var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    currentAbort = ac;
    var timer = setTimeout(function () { if (ac) { try { ac.abort(); } catch (e) {} } }, 30000); // bail out if it hangs
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId: id }), signal: ac ? ac.signal : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; })
          .then(function (b) { return { ok: res.ok, status: res.status, body: b }; });
      })
      .then(function (r) {
        if (inflight !== token) return; // a newer request superseded this one
        if (r.ok) {
          var d = r.body || {};
          var s = {
            videoId: id,
            title: d.title || null,
            channel: d.channel || null,
            tldr: d.tldr || '',
            keyPoints: d.keyPoints || [],
            cheatSheet: d.cheatSheet || [],
            ts: Date.now()
          };
          saveToHistory(s);
          renderResult(s);
          showScreen('result');
        } else {
          onError(r.status, r.body && r.body.error);
        }
      })
      .catch(function () { if (inflight === token) onError(0, null); }) // network / timeout(abort) -> generic
      .then(function () { clearTimeout(timer); if (inflight === token) stopStatus(); });
  }

  function onError(status, code) {
    var msg;
    if (code === 'no_transcript' || status === 422) msg = ERROR_MESSAGES.no_transcript;
    else if (code === 'invalid_id' || status === 400) msg = ERROR_MESSAGES.invalid_id;
    else if (code === 'daily_cap') msg = ERROR_MESSAGES.daily_cap; // shares 429 with rate_limited — match code first
    else if (code === 'rate_limited' || status === 429) msg = ERROR_MESSAGES.rate_limited;
    else msg = ERROR_MESSAGES.generic;
    showScreen('home');
    showNudge(msg, true);
  }

  // ---- result rendering -----------------------------------------------------
  function renderResult(s) {
    current = s;
    els.result_thumb_img.src = thumbUrl(s.videoId);
    els.result_title.textContent = s.title || 'YouTube video';
    els.result_meta.textContent = s.channel || 'YouTube';
    els.result_tldr.textContent = s.tldr || '';
    fillBullets(els.result_points, s.keyPoints, 'dot');
    fillBullets(els.result_cheat, s.cheatSheet, 'check');
    paintFav(els.result_fav, s.videoId, 20);
    resetCopy();
  }
  function fillBullets(ul, arr, type) {
    ul.textContent = '';
    (arr || []).forEach(function (x) {
      var li = document.createElement('li');
      var mark = document.createElement('span');
      if (type === 'check') { mark.className = 'check'; mark.textContent = '✓'; }
      else { mark.className = 'dot'; }
      var t = document.createElement('span'); t.className = 'b-text'; t.textContent = x;
      li.appendChild(mark); li.appendChild(t); ul.appendChild(li);
    });
  }
  function resetCopy() {
    [els.copy_tldr, els.copy_points, els.copy_cheat].forEach(function (b) {
      if (b) { clearTimeout(b._t); b.textContent = 'Copy'; b.classList.remove('is-copied'); }
    });
  }

  // ---- share-out sheet ------------------------------------------------------
  function sheetKeydown(e) { if (e.key === 'Escape') { e.preventDefault(); closeShareOut(); } }
  function openShareOut() {
    if (!current) return;
    els.shareout_tag.textContent = (current.title ? current.title + ' · ' : '') + 'TL;DR';
    els.shareout_tldr.textContent = current.tldr || '';
    els.shareout.hidden = false;
    sheetPrevFocus = document.activeElement;
    var sheet = els.shareout.querySelector('.sheet'); if (sheet) sheet.setAttribute('aria-modal', 'true');
    document.addEventListener('keydown', sheetKeydown);
    setTimeout(function () { try { els.shareout_copy.focus(); } catch (e) {} }, 0);
  }
  function closeShareOut() {
    els.shareout.hidden = true;
    document.removeEventListener('keydown', sheetKeydown);
    if (sheetPrevFocus && sheetPrevFocus.focus) { try { sheetPrevFocus.focus(); } catch (e) {} }
  }
  function shareOut() {
    if (!current) return;
    var text = summaryText(current, 'all');
    if (navigator.share) { navigator.share({ title: current.title || 'Gistly summary', text: text }).catch(function () {}); return; }
    doCopy(text);
    var b = els.shareout_share, orig = 'Share'; b.textContent = '✓ Copied';
    clearTimeout(b._t); b._t = setTimeout(function () { b.textContent = orig; }, 1600);
  }

  // ---- history --------------------------------------------------------------
  function openHistory() { els.history_search.value = ''; renderHistory(''); showScreen('history'); }
  function renderHistory(q) {
    q = (q || '').toLowerCase();
    var list = savedHistory.filter(function (h) {
      if (!q) return true;
      return ((h.title || '') + ' ' + (h.channel || '') + ' ' + (h.tldr || '')).toLowerCase().indexOf(q) > -1;
    });
    els.history_list.textContent = '';
    if (list.length === 0) {
      els.history_empty.hidden = false;
      els.history_empty.textContent = savedHistory.length === 0
        ? 'No summaries yet — your gists will show up here.'
        : 'No summaries match “' + els.history_search.value + '”.';
      return;
    }
    els.history_empty.hidden = true;
    list.forEach(function (h) {
      var item = document.createElement('div'); item.className = 'history-item';

      var open = document.createElement('button'); open.className = 'history-open'; open.type = 'button';
      var thumb = document.createElement('div'); thumb.className = 'thumb';
      var img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.src = thumbUrl(h.videoId); thumb.appendChild(img);
      var info = document.createElement('div'); info.className = 'info';
      var t = document.createElement('div'); t.className = 'h-title'; t.textContent = h.title || 'YouTube video';
      var sn = document.createElement('div'); sn.className = 'h-snip'; sn.textContent = h.tldr || '';
      var tm = document.createElement('div'); tm.className = 'h-time'; tm.textContent = relTime(h.ts);
      info.appendChild(t); info.appendChild(sn); info.appendChild(tm);
      open.appendChild(thumb); open.appendChild(info);
      open.addEventListener('click', function () { renderResult(h); showScreen('result'); });

      var favBtn = document.createElement('button'); favBtn.className = 'history-fav'; favBtn.type = 'button';
      favBtn.setAttribute('aria-label', 'Favorite');
      paintFav(favBtn, h.videoId, 18, 'var(--faint)');
      favBtn.addEventListener('click', function () {
        setFav(h.videoId, !isFav(h.videoId));
        paintFav(favBtn, h.videoId, 18, 'var(--faint)');
      });

      item.appendChild(open); item.appendChild(favBtn);
      els.history_list.appendChild(item);
    });
  }

  // ---- chips ----------------------------------------------------------------
  function renderChips() {
    els.home_chips.textContent = '';
    CHIPS.forEach(function (c) {
      var b = document.createElement('button'); b.className = 'chip'; b.type = 'button';
      b.innerHTML = '<svg width="8" height="8" viewBox="0 0 12 12" aria-hidden="true"><polygon points="2.6,1.6 10,6 2.6,10.4" fill="currentColor"></polygon></svg>';
      var span = document.createElement('span'); span.textContent = c.label; b.appendChild(span);
      b.addEventListener('click', function () { els.home_input.value = ''; summarize(c.id); });
      els.home_chips.appendChild(b);
    });
  }

  // ---- clipboard one-tap paste (best-effort, where the browser allows it) ----
  function maybeAutoPaste() {
    if (autoPasteTried || els.home_input.value) return;
    autoPasteTried = true;
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (txt) {
          if (txt && !els.home_input.value && parseId(txt)) { els.home_input.value = txt.trim(); hideNudge(); }
        }).catch(function () {});
      }
    } catch (e) {}
  }

  // ---- shared-link / deep-link intake --------------------------------------
  function checkDeepLink() {
    try {
      var p = new URLSearchParams(location.search);
      var cand = p.get('url') || p.get('text') || p.get('v') || '';
      var id = parseId(cand);
      if (id) {
        try { window.history.replaceState(null, '', location.pathname); } catch (e) {}
        return id;
      }
    } catch (e) {}
    return null;
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
    }
  }

  // ---- wire-up --------------------------------------------------------------
  function wire() {
    els.welcome_start.addEventListener('click', function () { save(LS_ONBOARDED, true); showScreen('home'); setTimeout(function () { els.home_input.focus(); }, 60); });
    els.home_history_btn.addEventListener('click', openHistory);
    els.home_submit.addEventListener('click', submitFromHome);
    els.home_input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitFromHome(); } });
    els.home_input.addEventListener('input', hideNudge);
    els.home_paste.addEventListener('click', function (e) { if (e.target !== els.home_input) els.home_input.focus(); maybeAutoPaste(); });
    els.home_input.addEventListener('focus', maybeAutoPaste);

    els.result_back.addEventListener('click', function () { showScreen('home'); });
    els.result_again.addEventListener('click', function () { els.home_input.value = ''; autoPasteTried = false; current = null; showScreen('home'); setTimeout(function () { els.home_input.focus(); }, 60); });
    els.result_fav.addEventListener('click', function () { if (!current) return; setFav(current.videoId, !isFav(current.videoId)); paintFav(els.result_fav, current.videoId, 20); });
    els.result_share.addEventListener('click', openShareOut);
    els.copy_tldr.addEventListener('click', function () { if (current) { doCopy(summaryText(current, 'tldr')); flashCopy(els.copy_tldr, 'Copy'); } });
    els.copy_points.addEventListener('click', function () { if (current) { doCopy(summaryText(current, 'points')); flashCopy(els.copy_points, 'Copy'); } });
    els.copy_cheat.addEventListener('click', function () { if (current) { doCopy(summaryText(current, 'cheat')); flashCopy(els.copy_cheat, 'Copy'); } });

    els.shareout.addEventListener('click', function (e) { if (e.target === els.shareout) closeShareOut(); });
    els.shareout_copy.addEventListener('click', function () { if (current) { doCopy(summaryText(current, 'all')); flashCopy(els.shareout_copy, 'Copy as text'); } });
    els.shareout_share.addEventListener('click', shareOut);
    els.shareout_close.addEventListener('click', closeShareOut);
    els.load_cancel.addEventListener('click', function () { inflight = null; stopStatus(); if (currentAbort) { try { currentAbort.abort(); } catch (e) {} } showScreen('home'); });

    els.history_back.addEventListener('click', function () { showScreen('home'); });
    els.history_search.addEventListener('input', function () { renderHistory(els.history_search.value); });
  }

  function init() {
    els.app = byId('app');
    screens.forEach(function (s) { els['screen_' + s] = byId('screen-' + s); });
    els.welcome_start = byId('welcome-start');
    els.home_history_btn = byId('home-history-btn');
    els.home_input = byId('home-input');
    els.home_paste = byId('home-paste');
    els.home_submit = byId('home-submit');
    els.home_nudge = byId('home-nudge');
    els.home_chips = byId('home-chips');
    els.load_thumb = byId('load-thumb');
    els.load_thumb_img = byId('load-thumb-img');
    els.load_msg = byId('load-msg');
    els.load_cancel = byId('load-cancel');
    els.result_back = byId('result-back');
    els.result_fav = byId('result-fav');
    els.result_share = byId('result-share');
    els.result_thumb_img = byId('result-thumb-img');
    els.result_title = byId('result-title');
    els.result_meta = byId('result-meta');
    els.copy_tldr = byId('copy-tldr');
    els.result_tldr = byId('result-tldr');
    els.copy_points = byId('copy-points');
    els.result_points = byId('result-points');
    els.copy_cheat = byId('copy-cheat');
    els.result_cheat = byId('result-cheat');
    els.result_again = byId('result-again');
    els.shareout = byId('shareout');
    els.shareout_tag = byId('shareout-tag');
    els.shareout_tldr = byId('shareout-tldr');
    els.shareout_copy = byId('shareout-copy');
    els.shareout_share = byId('shareout-share');
    els.shareout_close = byId('shareout-close');
    els.history_back = byId('history-back');
    els.history_search = byId('history-search');
    els.history_list = byId('history-list');
    els.history_empty = byId('history-empty');

    renderChips();
    wire();
    registerSW();

    var id = checkDeepLink();
    if (id) { save(LS_ONBOARDED, true); summarize(id); }
    else if (load(LS_ONBOARDED, false)) showScreen('home');
    else showScreen('welcome');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // expose for lightweight testing (harmless in the browser)
  if (typeof window !== 'undefined') window.parseId = parseId;
})();
