// ---------- storage (the "drawer") ----------
// Inside Claude, Claude gives the app window.storage to save data in.
// Everywhere else the drawer is online, at Supabase, so laptop and phone
// share the same days. It has the same four functions (get, set, delete,
// list), so the rest of the app doesn't know the difference.
// Each person signs in, and Supabase's lock rules (row level security) only
// let them read and write their own rows in the planner_items table.
if(!window.storage){
  (function(){
    // Both are safe to be public: the lock rules protect the data, not these.
    // Never put the "secret" / service_role key here.
    var SUPABASE_URL = 'https://mkhqwzkjgglppmwrdvsv.supabase.co';
    var SUPABASE_KEY = 'sb_publishable_9RRZJUsKv0doBzTR1hsziA_hH4fdRsa';
    var TABLE = 'planner_items';

    var box = document.getElementById('signIn');
    var form = document.getElementById('signInForm');
    var emailInput = document.getElementById('signInEmail');
    var passwordInput = document.getElementById('signInPassword');
    var msg = document.getElementById('signInMsg');
    function say(text){ msg.textContent = text; }
    function problem(err){ return isOffline(err) ? 'You’re offline. Connect to the internet, then try again.' : err.message; }

    // Every drawer call waits here until someone is signed in.
    var userId = null;
    var signedIn;
    var ready = new Promise(function(resolve){ signedIn = resolve; });

    var client = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

    if(!client){
      // The Supabase script didn't load, usually because there's no internet.
      box.hidden = false;
      say('Can’t reach the planner’s server. Check your internet connection, then reload.');
    } else {
      // Fires once at start-up (already signed in or not) and again after signing in.
      client.auth.onAuthStateChange(function(event, session){
        if(session && !userId){
          useAccount(session.user.id);
        } else if(!session && !userId){
          // offline and the sign-in couldn't be checked: carry on as the last person, from this device's copy
          var last = null;
          try{ last = localStorage.getItem('lodestar:lastUser'); }catch(e){}
          if(!navigator.onLine && last) useAccount(last);
          else box.hidden = false;
        }
      });

      // The screen is in one of two modes: signing in (the usual) or creating an account.
      var creating = false;
      function setMode(c){
        creating = c;
        document.getElementById('signInBtn').textContent = c ? 'Create account' : 'Sign in';
        document.getElementById('signInIntro').textContent = c ? 'Make an account with your email and a password (at least 6 characters).' : 'Sign in to see your days on any device.';
        document.getElementById('signInSwitchText').textContent = c ? 'Already have an account?' : 'New here?';
        document.getElementById('signInSwitch').textContent = c ? 'Sign in' : 'Create an account';
        passwordInput.autocomplete = c ? 'new-password' : 'current-password';
        document.getElementById('forgotLine').hidden = c;
        // the terms say 13+, so creating an account asks (required only while it's showing)
        document.getElementById('ageLine').hidden = !c;
        document.getElementById('ageCheck').required = c;
        say('');
      }
      document.getElementById('signInSwitch').addEventListener('click', function(){ setMode(!creating); });

      // Spam guard: Cloudflare Turnstile gives a one-use pass proving a person is here, which
      // Supabase checks. false = still checking. If Turnstile didn't load, try without; Supabase decides.
      function captcha(){
        var token;
        try{ token = turnstile.getResponse(); }catch(e){ return undefined; } // not loaded, or no widget

        if(!token){ say('One moment, checking you’re not a robot… then try again.'); return false; }
        turnstile.reset(); // each pass works once, so fetch a fresh one for next time
        return token;
      }

      // Forgot password: Supabase emails a link back to this page. Opening it signs the
      // person in and fires PASSWORD_RECOVERY, which turns this screen into "choose a new password".
      document.getElementById('forgotBtn').addEventListener('click', function(){
        var email = emailInput.value.trim();
        if(!email){ say('Type your email above first, then tap Forgot password.'); emailInput.focus(); return; }
        var token = captcha();
        if(token === false) return;
        say('Sending…');
        client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname, captchaToken: token })
          .then(function(res){ say(res.error ? problem(res.error) : 'If there’s an account for that email, a link to choose a new password is on its way.'); });
      });
      var resetting = false;
      client.auth.onAuthStateChange(function(event){
        if(event !== 'PASSWORD_RECOVERY') return;
        resetting = true;
        emailInput.required = false;
        emailInput.parentNode.hidden = true;
        document.getElementById('signInSwitchText').parentNode.hidden = true;
        document.getElementById('forgotLine').hidden = true;
        document.getElementById('signInIntro').textContent = 'Choose a new password (at least 6 characters).';
        document.getElementById('signInBtn').textContent = 'Save new password';
        passwordInput.autocomplete = 'new-password';
        passwordInput.value = '';
        say('');
        box.hidden = false;
      });

      form.addEventListener('submit', function(e){
        e.preventDefault();
        var email = emailInput.value.trim(), password = passwordInput.value;
        if(resetting){
          say('Saving…');
          client.auth.updateUser({ password: password }).then(function(res){
            if(res.error){ say(problem(res.error)); return; }
            resetting = false;
            box.hidden = true;
          });
          return;
        }
        var token = captcha();
        if(token === false) return;
        if(!creating){
          say('Signing in…');
          client.auth.signInWithPassword({ email: email, password: password, options: { captchaToken: token } })
            .then(function(res){ if(res.error) say(problem(res.error)); });
          return;
        }
        say('Creating your account…');
        // the confirmation email links back to this page, wherever it's hosted
        client.auth.signUp({ email: email, password: password, options: { emailRedirectTo: location.origin + location.pathname, captchaToken: token } })
          .then(function(res){
            if(res.error) say(problem(res.error));
            else if(!res.data.session){ setMode(false); say('Almost done: check your email and tap the confirmation link, then sign in here.'); }
          });
      });

      document.getElementById('signOutBtn').addEventListener('click', function(){
        // send any waiting offline changes first; signing out clears this device's copy
        sync().then(function(){
          if(Object.keys(outbox).length && !confirm('Some changes haven’t synced yet, because you’re offline. Sign out anyway and lose them?')) return;
          clearLocal();
          return client.auth.signOut().then(function(){ location.reload(); });
        });
      });

      // Delete my account: Supabase's delete_my_account() removes this person's planner
      // rows and their login. Typing DELETE first, because it can't be undone.
      var deleteBox = document.getElementById('deleteAccountBox');
      var deleteMsg = document.getElementById('deleteAccountMsg');
      document.getElementById('deleteAccountBtn').addEventListener('click', function(){
        deleteBox.hidden = !deleteBox.hidden;
      });
      document.getElementById('deleteAccountConfirm').addEventListener('click', function(){
        if(document.getElementById('deleteAccountInput').value.trim().toUpperCase() !== 'DELETE'){
          deleteMsg.textContent = 'Type DELETE in the box first.';
          return;
        }
        deleteMsg.textContent = 'Deleting…';
        client.rpc('delete_my_account').then(function(res){
          if(res.error){ deleteMsg.textContent = 'That didn’t work: ' + res.error.message; return; }
          // best effort: stop this device's reminders too, then leave
          var stopPush = navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then(function(reg){
            return reg && reg.pushManager.getSubscription().then(function(sub){ return sub && sub.unsubscribe(); });
          }).catch(function(){}) : Promise.resolve();
          clearLocal();
          return stopPush.then(function(){ return client.auth.signOut(); }).catch(function(){}).then(function(){ location.reload(); });
        });
      });
    }

    // Turns a Supabase reply into its data, or into an error for the app's .catch.
    function check(res){
      if(res.error) throw res.error;
      return res.data;
    }

    // ---------- talking to Supabase ----------
    function rawGet(key){
      return client.from(TABLE).select('value').eq('key', key).maybeSingle().then(check);
    }
    function rawSet(key, value){
      return client.from(TABLE).upsert({ user_id: userId, key: key, value: value, updated_at: new Date().toISOString() }).then(check);
    }
    function rawDelete(key){
      return client.from(TABLE).delete().eq('key', key).then(check);
    }
    // shortcut: returns at most 1000 keys (Supabase's default page size); page with .range() if anyone could have more.
    function rawList(prefix){
      var pattern = (prefix || '').replace(/[\\%_]/g, '\\$&') + '%'; // % and _ are wildcards in "like"
      return client.from(TABLE).select('key').like('key', pattern).then(check).then(function(rows){
        return rows.map(function(r){ return r.key; });
      });
    }

    // ---------- this device's offline copy ----------
    // The device keeps a copy of everything it reads or saves (copy), what the key lists
    // looked like (lists), and changes made while offline (outbox), in localStorage, per
    // account. Online, Supabase is always asked first; the copy is only used offline.
    // An outbox change is "blind" when the device never had a copy of that key: it might
    // not know what's really saved, so when it syncs it's merged in, never written over.
    var copy = {}, lists = {}, outbox = {}, syncing = null;
    function slot(name){ return 'lodestar:' + userId + ':' + name; }
    function loadLocal(name){ try{ return JSON.parse(localStorage.getItem(slot(name))) || {}; }catch(e){ return {}; } }
    function saveLocal(){
      try{
        localStorage.setItem(slot('copy'), JSON.stringify(copy));
        localStorage.setItem(slot('lists'), JSON.stringify(lists));
        localStorage.setItem(slot('outbox'), JSON.stringify(outbox));
      }catch(e){ /* storage full or blocked: offline use just won't have the newest copy */ }
    }
    function clearLocal(){
      try{
        ['copy', 'lists', 'outbox'].forEach(function(n){ localStorage.removeItem(slot(n)); });
        localStorage.removeItem('lodestar:lastUser');
      }catch(e){}
    }
    function useAccount(id){
      userId = id;
      try{ localStorage.setItem('lodestar:lastUser', id); }catch(e){}
      copy = loadLocal('copy'); lists = loadLocal('lists'); outbox = loadLocal('outbox');
      box.hidden = resetting; // a password-reset link keeps the "new password" screen up
      signedIn();
      showNote();
      sync();
    }
    // a failure from having no internet (as opposed to Supabase saying no)
    function isOffline(err){
      return !navigator.onLine || /fetch|network|load failed|timed? ?out/i.test((err && err.message) || String(err));
    }
    // Ask Supabase only when there's internet. Offline, its sign-in check retries for ~20s before
    // failing, which made every read (e.g. changing days) that slow.
    function server(ask){ return navigator.onLine ? ask() : Promise.reject(new Error('offline')); }

    // The small note at the top: offline, or still sending changes.
    function showNote(){
      var el = document.getElementById('offlineNote');
      if(!el) return;
      var text = !navigator.onLine ? 'Offline. Changes will sync when you’re back online.'
        : Object.keys(outbox).length ? 'Syncing your changes…' : '';
      el.textContent = text;
      el.hidden = !text;
    }

    // Each waiting change remembers what the device had before it (base), so syncing can apply
    // only what was changed here and keep changes made on other devices meanwhile.
    function queue(key, value){
      var old = outbox[key];
      outbox[key] = old ? { value: value, blind: old.blind, base: old.base }
        : { value: value, blind: !(key in copy), base: key in copy ? copy[key] : null };
      saveLocal();
      showNote();
      if(navigator.onLine) setTimeout(sync, 0); // e.g. a newer change to a key that was still waiting
    }

    function same(x, y){ return JSON.stringify(x) === JSON.stringify(y); }
    function parse(text){ try{ return JSON.parse(text); }catch(e){ return undefined; } }

    // A day: start from what's saved now, then apply this device's changes block by block.
    function mergeDay(saved, local, base){
      var result = saved.slice();
      var baseById = {};
      (base || []).forEach(function(b){ baseById[b.id] = b; });
      local.forEach(function(blk){
        var before = baseById[blk.id], i = result.findIndex(function(s){ return s.id === blk.id; });
        if(!before){
          // added here (or the device never saw this day): add it unless it's already there
          var dupe = i !== -1 || result.some(function(s){ return s.time === blk.time && s.title === blk.title; });
          if(!dupe) result.push(blk);
        } else if(!same(blk, before) && i !== -1){
          result[i] = blk; // changed here (ticked, renamed…): this device's version
        } // a block deleted elsewhere stays deleted
      });
      (base || []).forEach(function(b){
        // deleted here: remove it, unless another device changed it meanwhile
        if(local.some(function(l){ return l.id === b.id; })) return;
        var i = result.findIndex(function(s){ return s.id === b.id; });
        if(i !== -1 && same(result[i], b)) result.splice(i, 1);
      });
      return result.sort(function(x, y){ return String(x.time).localeCompare(String(y.time)); });
    }

    // What a waiting change becomes when it meets what's really saved now.
    function mergeChange(key, entry, saved){
      var local = entry.value;
      if(!entry.blind && saved === entry.base) return local; // nothing changed elsewhere: send ours as is
      if(local === null) return entry.blind ? saved : null;  // deleted here
      if(saved == null) return local;
      var a = parse(saved), b = parse(local), base = entry.blind ? null : parse(entry.base);
      if(a === undefined || b === undefined) return entry.blind ? saved : local;
      if(Array.isArray(a) && Array.isArray(b)){
        if(key.indexOf('plan:') === 0) return JSON.stringify(mergeDay(a, b, Array.isArray(base) ? base : null));
        // other lists (applied rules, categories…): keep everything, no doubles
        b.forEach(function(v){ if(!a.some(function(x){ return same(x, v); })) a.push(v); });
        return JSON.stringify(a);
      }
      if(a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)){
        // settings, templates…: field by field, only the fields changed here. If this device never
        // had them, its values may just be defaults, so what's saved wins.
        if(entry.blind) return saved;
        Object.keys(b).forEach(function(k){ if(!base || !same(b[k], base[k])) a[k] = b[k]; });
        if(base) Object.keys(base).forEach(function(k){ if(!(k in b) && same(a[k], base[k])) delete a[k]; });
        return JSON.stringify(a);
      }
      return entry.blind ? saved : local;
    }

    // Send the outbox, one change at a time. Stops at the first failure and tries again later.
    function sync(){
      if(syncing) return syncing;
      if(!userId || !navigator.onLine || !Object.keys(outbox).length){ showNote(); return Promise.resolve(); }
      syncing = Object.keys(outbox).reduce(function(chain, key){
        return chain.then(function(){
          var entry = outbox[key];
          if(!entry) return;
          return rawGet(key).then(function(row){ return mergeChange(key, entry, row ? row.value : null); }).then(function(v){
            return (v === null ? rawDelete(key) : rawSet(key, v)).then(function(){
              if(outbox[key] === entry) delete outbox[key];
              else if(outbox[key]){ outbox[key].base = v; outbox[key].blind = false; } // a newer change made meanwhile stays queued, now based on what was just sent
              if(v === null) delete copy[key]; else copy[key] = v;
              saveLocal();
            });
          });
        });
      }, Promise.resolve()).catch(function(){}).then(function(){ syncing = null; showNote(); });
      return syncing;
    }
    window.addEventListener('online', function(){ sync(); });
    // another tab of Lodestar changed the device's copy: pick it up, so neither tab overwrites the other's waiting changes
    window.addEventListener('storage', function(e){
      if(!userId || !e.key || e.key.indexOf('lodestar:' + userId + ':') !== 0) return;
      copy = loadLocal('copy'); lists = loadLocal('lists'); outbox = loadLocal('outbox');
      showNote();
    });
    window.addEventListener('offline', showNote);
    setInterval(function(){ if(Object.keys(outbox).length) sync(); }, 30000);

    window.storage = {
      // Read one saved value. Gives back null if nothing is saved there.
      // Offline: this device's copy, or an error if it never had one.
      get: function(key){
        return ready.then(function(){
          if(key in outbox) return outbox[key].value === null ? null : { key: key, value: outbox[key].value }; // a change still waiting to send is the newest
          return server(function(){ return rawGet(key); }).then(function(row){
            if(row) copy[key] = row.value; else delete copy[key];
            saveLocal();
            return row ? { key: key, value: row.value } : null;
          }, function(err){
            if(isOffline(err) && key in copy) return { key: key, value: copy[key] };
            throw err;
          });
        });
      },
      // Save one value (always text), replacing any old one. Gives back
      // something "truthy" so the app knows the save worked. Offline it's queued.
      set: function(key, value){
        return ready.then(function(){
          var send = navigator.onLine && !(key in outbox) ? rawSet(key, value) : Promise.reject(new Error('offline'));
          return send.then(function(){
            copy[key] = value;
            saveLocal();
          }, function(err){
            if(!isOffline(err) && !(key in outbox)) throw err;
            queue(key, value);
            copy[key] = value;
            saveLocal();
          }).then(function(){ return { key: key, value: value }; });
        });
      },
      // Remove one saved value. Offline it's queued.
      delete: function(key){
        return ready.then(function(){
          var send = navigator.onLine && !(key in outbox) ? rawDelete(key) : Promise.reject(new Error('offline'));
          return send.then(function(){
            delete copy[key];
            saveLocal();
          }, function(err){
            if(!isOffline(err) && !(key in outbox)) throw err;
            queue(key, null);
            delete copy[key];
            saveLocal();
          }).then(function(){ return true; });
        });
      },
      // Read every saved value whose key starts with `prefix`, in ONE request (instead of one
      // per key). Gives back { key: value }. Offline: this device's copies.
      // shortcut: like list(), at most 1000 rows; page with .range() if anyone could have more.
      getAll: function(prefix){
        prefix = prefix || '';
        var pattern = prefix.replace(/[\\%_]/g, '\\$&') + '%';
        return ready.then(function(){
          return server(function(){ return client.from(TABLE).select('key, value').like('key', pattern).then(check); }).then(function(rows){
            var out = {};
            rows.forEach(function(r){ out[r.key] = r.value; copy[r.key] = r.value; });
            lists[prefix] = rows.map(function(r){ return r.key; });
            saveLocal();
            return out;
          }, function(err){
            if(!isOffline(err)) throw err;
            var out = {};
            Object.keys(copy).forEach(function(k){ if(k.indexOf(prefix) === 0) out[k] = copy[k]; });
            return out;
          });
        }).then(function(out){
          // changes still waiting to send are the newest
          Object.keys(outbox).forEach(function(k){
            if(k.indexOf(prefix) !== 0) return;
            if(outbox[k].value === null) delete out[k]; else out[k] = outbox[k].value;
          });
          return out;
        });
      },
      // Find every saved key that starts with `prefix` (e.g. 'plan:' = all days).
      // Offline: the last list this device saw, plus anything it has a copy of.
      list: function(prefix){
        prefix = prefix || '';
        return ready.then(function(){
          return server(function(){ return rawList(prefix); }).then(function(keys){
            lists[prefix] = keys;
            saveLocal();
            return keys;
          }, function(err){
            if(!isOffline(err)) throw err;
            return (lists[prefix] || []).concat(Object.keys(copy).filter(function(k){ return k.indexOf(prefix) === 0; }));
          });
        }).then(function(keys){
          // changes still waiting to send count too
          Object.keys(outbox).forEach(function(k){
            if(k.indexOf(prefix) !== 0) return;
            if(outbox[k].value === null) keys = keys.filter(function(x){ return x !== k; });
            else if(keys.indexOf(k) === -1) keys.push(k);
          });
          return { keys: keys.filter(function(k, i){ return keys.indexOf(k) === i; }) };
        });
      }
    };
  })();
}
