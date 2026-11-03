// ---------- reminder helper (service worker) ----------
// The phone keeps this small file running in the background, even when the
// planner is closed. Its only job: show a reminder when Supabase sends one,
// and open the planner when the reminder is tapped.
// It also asks the website whether each file changed (instead of trusting the
// browser's 10-minute copy), so an upload shows up on the next load without
// Ctrl+Shift+R. Every file it fetches is kept as a copy, and with no internet
// the copy is used, so Lodestar still opens offline. Online, the copy is never used.

// Change this line whenever the site's safety settings (_headers) change: the browser only
// re-fetches the helper, with the new settings, when this file's text changes.
var HELPER_VERSION = '2026-11-03d';
var FILES = 'lodestar-files';
// outside files the app needs to open: the sign-in library and the fonts (not Supabase data)
var OTHER_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Save the files Lodestar needs to open as soon as the helper arrives, so it works
// offline after just one visit (not only after the second).
var CORE = ['./', 'styles.css', 'app.js', 'storage.js', 'sw.js', 'icon.svg', 'apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.min.js'];
self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(FILES).then(function(c){
    // one at a time, and a file that fails doesn't stop the rest
    return CORE.reduce(function(chain, url){
      return chain.then(function(){ return c.add(new Request(url, { cache: 'no-cache' })).catch(function(){}); });
    }, Promise.resolve());
  }));
});
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url);
  var ours = url.origin === location.origin;
  if(e.request.method !== 'GET' || !(ours || OTHER_HOSTS.indexOf(url.hostname) !== -1)) return;
  e.respondWith(fetch(e.request, ours ? { cache: 'no-cache' } : undefined).then(function(res){
    if(res.ok){
      var copy = res.clone();
      caches.open(FILES).then(function(c){ return c.put(e.request, copy); });
    }
    return res;
  }).catch(function(err){
    // Offline: use the copy from last time. ignoreSearch: any ?query bits; ignoreVary: iPhone
    // asks for pages slightly differently offline, and the site's "Vary" label would make the
    // copy count as not matching. Opening the app always falls back to the saved home page.
    var loose = { ignoreSearch: true, ignoreVary: true };
    return caches.match(e.request, loose).then(function(hit){
      if(hit) return hit;
      if(e.request.mode === 'navigate') return caches.match('./', loose).then(function(home){ if(home) return home; throw err; });
      throw err;
    });
  }));
});

self.addEventListener('push', function(e){
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) { data = { body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Lodestar', {
    body: data.body || '',
    tag: data.tag // the same block won't stack up twice
  }));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(function(wins){
    if(wins.length) return wins[0].focus();
    return self.clients.openWindow('./');
  }));
});
