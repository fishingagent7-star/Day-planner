// ---------- reminder helper (service worker) ----------
// The phone keeps this small file running in the background, even when the
// planner is closed. Its only job: show a reminder when Supabase sends one,
// and open the planner when the reminder is tapped.
// It doesn't save copies of the app's files, so updates still arrive normally.

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
