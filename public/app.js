/* =============================================================================
 * TLDW — public/app.js  (framework-free, no build step)
 * -----------------------------------------------------------------------------
 * Frontend logic: take a pasted YouTube URL, pull out the 11-char video id,
 * POST it to the Worker (/api/summarize), and render TL;DR / Key Points /
 * Cheat Sheet cards with friendly loading + error states.
 *
 * SHARED CONTRACT (must agree with src/worker.js):
 *   POST /api/summarize   body: { "videoId": "<11-char id>" }
 *   200  -> { tldr: string, keyPoints: string[], cheatSheet: string[], cached: boolean }
 *   400  -> { error: "invalid_id" }
 *   422  -> { error: "no_transcript" }
 *   429  -> { error: "rate_limited" }
 *   502  -> { error: "summary_failed" }
 *   500  -> { error: "server_error" }
 *
 * -----------------------------------------------------------------------------
 * DOM CONTRACT — these ids/classes MUST exist in public/index.html (keep in sync):
 *
 *   #summarize-form    <form>     wraps the input + button (so Enter submits)
 *   #url-input         <input>    the YouTube link text field
 *   #summarize-btn     <button type="submit">  the big primary button
 *
 *   #error             inline error area (single node; aria-live, hidden by default)
 *
 *   #loading           loading container (hidden by default)
 *   #status-text       rotating status line (aria-live="polite")
 *
 *   #results           results container (hidden by default)
 *   #cached-pill       subtle "loaded instantly" pill (hidden unless cached)
 *   #reset-btn         "Summarize another" button/link
 *
 *   #tldr-text         <p>  TL;DR paragraph
 *   #keypoints-list    <ul> Key Points list (we fill <li> children)
 *   #cheatsheet-list   <ul> Cheat Sheet list (we fill <li> children)
 *
 *   Copy buttons (one per card). Each names the content element it copies:
 *   .copy-btn[data-target="tldr-text"]        copies the TL;DR text
 *   .copy-btn[data-target="keypoints-list"]   copies the Key Points (one bullet/line)
 *   .copy-btn[data-target="cheatsheet-list"]  copies the Cheat Sheet (one bullet/line)
 *
 *   Visibility is toggled with the `hidden` attribute — style.css makes
 *   [hidden] resolve to display:none (with !important so it beats flex layouts).
 * ===========================================================================*/

(function () {
  'use strict';

  // ---- Element handles (resolved once the DOM is ready) ---------------------
  var els = {};

  // ---- Loading status rotation ----------------------------------------------
  var STATUS_MESSAGES = [
    'Grabbing the transcript…',
    'Reading the whole video…',
    'Pulling out the good stuff…',
    'Almost done…'
  ];
  var statusTimer = null; // setInterval handle; null when not rotating

  // ---- Friendly error copy --------------------------------------------------
  var ERROR_MESSAGES = {
    invalid_id:    "Hmm, that doesn't look like a YouTube link — double-check and try again.",
    no_transcript: "This video doesn't have a transcript we can read — try a different one.",
    rate_limited:  'Whoa, slow down a sec — try again in a minute.',
    generic:       'Something went wrong on our end. Give it another try.'
  };

  /* ===========================================================================
   * extractVideoId(input) -> 11-char id | null
   * Robust across every common YouTube URL shape plus a bare id pasted alone:
   *   - bare id:               dQw4w9WgXcQ
   *   - watch:                 youtube.com/watch?v=ID&t=42s   (any param order)
   *   - short link:            youtu.be/ID?t=42
   *   - shorts / embed / live: youtube.com/shorts/ID , /embed/ID , /live/ID
   *   - legacy:                youtube.com/v/ID
   *   - m. / www. / no scheme, extra query params, timestamps — all fine.
   * Strategy: try a bare-id match first, then a set of host-agnostic regexes
   * that just look for the path/param marker followed by the 11-char id.
   * =========================================================================*/
  function extractVideoId(input) {
    if (!input) return null;
    var s = String(input).trim();
    if (!s) return null;

    // 1) A bare 11-char id pasted on its own.
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;

    // 2) Path/param markers, host-agnostic (works with or without scheme/www/m.).
    //    Each pattern captures exactly 11 valid id chars.
    var patterns = [
      /[?&]v=([A-Za-z0-9_-]{11})/,      // watch?v=ID  (also catches &v=ID)
      /youtu\.be\/([A-Za-z0-9_-]{11})/, // youtu.be/ID
      /\/shorts\/([A-Za-z0-9_-]{11})/,  // /shorts/ID
      /\/embed\/([A-Za-z0-9_-]{11})/,   // /embed/ID
      /\/live\/([A-Za-z0-9_-]{11})/,    // /live/ID
      /\/v\/([A-Za-z0-9_-]{11})/        // /v/ID  (legacy)
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = s.match(patterns[i]);
      if (m) return m[1];
    }

    // 3) Last-ditch fallback: any 11-char segment sitting between path/query
    //    delimiters (e.g. an unusual host or trailing slash form).
    var tail = s.match(/\/([A-Za-z0-9_-]{11})(?:[?&\/#]|$)/);
    if (tail) return tail[1];

    return null;
  }

  /* ===========================================================================
   * Small DOM helpers
   * =========================================================================*/
  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  function showError(message) {
    if (els.errorText) els.errorText.textContent = message;
    show(els.errorArea);
  }
  function hideError() {
    hide(els.errorArea);
    if (els.errorText) els.errorText.textContent = '';
  }

  // ---- Loading status rotation ----------------------------------------------
  function startStatusRotation() {
    var idx = 0;
    if (els.statusText) els.statusText.textContent = STATUS_MESSAGES[idx];
    stopStatusRotation(); // never double-stack intervals
    statusTimer = setInterval(function () {
      idx = (idx + 1) % STATUS_MESSAGES.length;
      if (els.statusText) els.statusText.textContent = STATUS_MESSAGES[idx];
    }, 2000); // ~2s per phrase
  }
  function stopStatusRotation() {
    if (statusTimer !== null) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  // ---- Button enable/disable -------------------------------------------------
  function setBusy(busy) {
    if (els.submitBtn) {
      els.submitBtn.disabled = busy;
      els.submitBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  /* ===========================================================================
   * View transitions
   * =========================================================================*/
  function showLoadingView() {
    hideError();
    hide(els.resultsArea);
    show(els.loadingArea);
    startStatusRotation();
  }

  function showResultsView() {
    stopStatusRotation();
    hide(els.loadingArea);
    show(els.resultsArea);
  }

  // Reset back to the input view ("Summarize another").
  function resetView() {
    stopStatusRotation();
    setBusy(false);
    hide(els.loadingArea);
    hide(els.resultsArea);
    hide(els.cachedPill);
    hideError();
    if (els.urlInput) {
      els.urlInput.value = '';
      els.urlInput.focus();
    }
  }

  /* ===========================================================================
   * Render results
   * =========================================================================*/
  function renderResults(data) {
    // TL;DR paragraph.
    if (els.tldrText) els.tldrText.textContent = data.tldr || '';

    // Key Points + Cheat Sheet lists.
    fillList(els.keyPointsList, data.keyPoints);
    fillList(els.cheatSheetList, data.cheatSheet);

    // "Loaded instantly" pill only when the server served from cache.
    if (data.cached === true) { show(els.cachedPill); }
    else { hide(els.cachedPill); }

    showResultsView();
  }

  // Replace the children of a <ul> with one <li> per string item.
  function fillList(ul, items) {
    if (!ul) return;
    ul.textContent = ''; // clear
    var arr = Array.isArray(items) ? items : [];
    for (var i = 0; i < arr.length; i++) {
      var li = document.createElement('li');
      li.textContent = String(arr[i]);
      ul.appendChild(li);
    }
  }

  /* ===========================================================================
   * Copy-to-clipboard (plain text; bullets joined with newlines)
   * =========================================================================*/
  // target is the id of the content element to copy (e.g. "tldr-text",
  // "keypoints-list", "cheatsheet-list" — see the .copy-btn[data-target] contract).
  function textForCopyTarget(target) {
    var el = target ? document.getElementById(target) : null;
    if (!el) return '';
    // Lists -> one bullet per line; paragraphs (and anything else) -> their text.
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      var lines = [];
      var items = el.querySelectorAll('li');
      for (var i = 0; i < items.length; i++) {
        lines.push(items[i].textContent);
      }
      return lines.join('\n');
    }
    return el.textContent || '';
  }

  function flashCopied(btn) {
    if (!btn) return;
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original); // remember the real label once
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1500);
  }

  function handleCopyClick(btn) {
    var target = btn.getAttribute('data-target');
    var text = textForCopyTarget(target);
    if (!text) return;

    // navigator.clipboard is async + needs a secure context; fall back quietly.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { flashCopied(btn); },
        function () { legacyCopy(text, btn); }
      );
    } else {
      legacyCopy(text, btn);
    }
  }

  // Fallback copy for older/insecure contexts (e.g. plain http localhost).
  function legacyCopy(text, btn) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      flashCopied(btn);
    } catch (e) {
      /* nothing else we can do — copy just won't fire */
    }
  }

  /* ===========================================================================
   * Network: POST the bare videoId, map outcomes to friendly messages.
   * =========================================================================*/
  function submit() {
    var raw = els.urlInput ? els.urlInput.value : '';
    var videoId = extractVideoId(raw);

    // Bad link -> friendly inline error, and STOP (no API call).
    if (!videoId) {
      showError(ERROR_MESSAGES.invalid_id);
      return;
    }

    setBusy(true);
    showLoadingView();

    fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: videoId })
    })
      .then(function (res) {
        // Parse JSON defensively — an upstream proxy could return non-JSON.
        return res.json()
          .catch(function () { return {}; })
          .then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.ok) {
          renderResults(r.body || {});
        } else {
          handleApiError(r.status, r.body && r.body.error);
        }
      })
      .catch(function () {
        // Network failure / timeout / CORS — generic friendly message.
        handleApiError(0, null);
      })
      .then(function () {
        // ALWAYS runs (success or failure): re-enable button, stop interval.
        setBusy(false);
        stopStatusRotation();
      });
  }

  // Map HTTP status / error code -> plain-English message, then show error view.
  function handleApiError(status, code) {
    hide(els.loadingArea);
    hide(els.resultsArea);

    var msg;
    if (code === 'no_transcript' || status === 422) {
      msg = ERROR_MESSAGES.no_transcript;
    } else if (code === 'invalid_id' || status === 400) {
      msg = ERROR_MESSAGES.invalid_id;
    } else if (code === 'rate_limited' || status === 429) {
      msg = ERROR_MESSAGES.rate_limited;
    } else {
      // 500 / 502 / network / timeout / anything unexpected.
      msg = ERROR_MESSAGES.generic;
    }

    // The input stays usable (it's still on screen) so retry is one tap away.
    showError(msg);
  }

  /* ===========================================================================
   * Wire up events once the DOM is ready.
   * =========================================================================*/
  function init() {
    els = {
      form:          document.getElementById('summarize-form'),
      urlInput:      document.getElementById('url-input'),
      submitBtn:     document.getElementById('summarize-btn'),
      // index.html uses a single #error node as both the container and the text.
      errorArea:     document.getElementById('error'),
      errorText:     document.getElementById('error'),
      loadingArea:   document.getElementById('loading'),
      statusText:    document.getElementById('status-text'),
      resultsArea:   document.getElementById('results'),
      cachedPill:    document.getElementById('cached-pill'),
      resetBtn:      document.getElementById('reset-btn'),
      tldrText:      document.getElementById('tldr-text'),
      keyPointsList: document.getElementById('keypoints-list'),
      cheatSheetList:document.getElementById('cheatsheet-list')
    };

    // Submit via the form (covers both the button click AND Enter in the input).
    if (els.form) {
      els.form.addEventListener('submit', function (e) {
        e.preventDefault();
        submit();
      });
    } else if (els.submitBtn) {
      // Defensive fallback if index.html isn't wrapped in a <form>.
      els.submitBtn.addEventListener('click', function (e) {
        e.preventDefault();
        submit();
      });
      if (els.urlInput) {
        els.urlInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
      }
    }

    // Clear a stale error as soon as the user starts editing the link.
    if (els.urlInput) {
      els.urlInput.addEventListener('input', function () {
        if (els.errorArea && !els.errorArea.hidden) hideError();
      });
    }

    // "Summarize another".
    if (els.resetBtn) {
      els.resetBtn.addEventListener('click', function (e) {
        e.preventDefault();
        resetView();
      });
    }

    // Copy buttons — delegated so it works no matter how many cards render.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.copy-btn') : null;
      if (btn) { e.preventDefault(); handleCopyClick(btn); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose extractVideoId for any lightweight testing (harmless in the browser).
  if (typeof window !== 'undefined') window.extractVideoId = extractVideoId;
})();
