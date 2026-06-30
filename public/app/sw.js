/* Gistly app service worker — offline shell + fresh-when-online.
   Bump CACHE whenever the shell files (html/css/js/manifest/icon) change. */
var CACHE = 'gistly-app-v1';
var SHELL = ['./', './index.html', './style.css', './app.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                 // never intercept POST /api/summarize
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // YouTube thumbnails etc. -> straight to network
  if (url.pathname.indexOf('/api/') !== -1) return; // API -> network only

  // Network-first: online users always get the latest code; cache is the offline fallback.
  e.respondWith(
    fetch(req).then(function (res) {
      // Only cache known-good same-origin responses, so a transient 5xx/404 can't
      // pin a broken shell as the offline fallback.
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (m) { return m || caches.match('./index.html'); });
    })
  );
});
