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
          userId = session.user.id;
          box.hidden = true;
          signedIn();
        } else if(!session && !userId){
          box.hidden = false;
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
        say('');
      }
      document.getElementById('signInSwitch').addEventListener('click', function(){ setMode(!creating); });

      form.addEventListener('submit', function(e){
        e.preventDefault();
        var email = emailInput.value.trim(), password = passwordInput.value;
        if(!creating){
          say('Signing in…');
          client.auth.signInWithPassword({ email: email, password: password })
            .then(function(res){ if(res.error) say(res.error.message); });
          return;
        }
        say('Creating your account…');
        // the confirmation email links back to this page, wherever it's hosted
        client.auth.signUp({ email: email, password: password, options: { emailRedirectTo: location.origin + location.pathname } })
          .then(function(res){
            if(res.error) say(res.error.message);
            else if(!res.data.session){ setMode(false); say('Almost done: check your email and tap the confirmation link, then sign in here.'); }
          });
      });

      document.getElementById('signOutBtn').addEventListener('click', function(){
        client.auth.signOut().then(function(){ location.reload(); });
      });
    }

    // Turns a Supabase reply into its data, or into an error for the app's .catch.
    function check(res){
      if(res.error) throw res.error;
      return res.data;
    }

    window.storage = {
      // Read one saved value. Gives back null if nothing is saved there.
      get: function(key){
        return ready.then(function(){
          return client.from(TABLE).select('value').eq('key', key).maybeSingle();
        }).then(check).then(function(row){
          return row ? { key: key, value: row.value } : null;
        });
      },
      // Save one value (always text), replacing any old one. Gives back
      // something "truthy" so the app knows the save worked.
      set: function(key, value){
        return ready.then(function(){
          return client.from(TABLE).upsert({ user_id: userId, key: key, value: value, updated_at: new Date().toISOString() });
        }).then(check).then(function(){
          return { key: key, value: value };
        });
      },
      // Remove one saved value.
      delete: function(key){
        return ready.then(function(){
          return client.from(TABLE).delete().eq('key', key);
        }).then(check).then(function(){
          return true;
        });
      },
      // Find every saved key that starts with `prefix` (e.g. 'plan:' = all days).
      // shortcut: returns at most 1000 keys (Supabase's default page size); page with .range() if anyone could have more.
      list: function(prefix){
        var pattern = (prefix || '').replace(/[\\%_]/g, '\\$&') + '%'; // % and _ are wildcards in "like"
        return ready.then(function(){
          return client.from(TABLE).select('key').like('key', pattern);
        }).then(check).then(function(rows){
          return { keys: rows.map(function(r){ return r.key; }) };
        });
      }
    };
  })();
}
