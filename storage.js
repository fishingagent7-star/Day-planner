// ---------- storage (the "drawer") ----------
// Inside Claude, Claude gives the app window.storage to save data in.
// In a normal browser it doesn't exist, so we make our own with the same
// four functions (get, set, delete, list), saving into the browser's
// built-in localStorage. The rest of the app doesn't know the difference.
// Later, this is the one place to swap in a real online database.
if(!window.storage){
  (function(){
    // Every key we save starts with this, so our data doesn't mix with
    // anything else the browser has saved.
    var PREFIX = 'dayplanner:';

    window.storage = {
      // Read one saved value. Gives back null if nothing is saved there.
      get: function(key){
        return new Promise(function(resolve){
          var value = localStorage.getItem(PREFIX + key);
          resolve(value === null ? null : { key: key, value: value });
        });
      },
      // Save one value (always text). Gives back something "truthy" so the
      // app knows the save worked. If the browser refuses (for example it's
      // full), the error goes to the app's .catch and it shows "Could not save".
      set: function(key, value){
        return new Promise(function(resolve){
          localStorage.setItem(PREFIX + key, value);
          resolve({ key: key, value: value });
        });
      },
      // Remove one saved value.
      delete: function(key){
        return new Promise(function(resolve){
          localStorage.removeItem(PREFIX + key);
          resolve(true);
        });
      },
      // Find every saved key that starts with `prefix` (e.g. 'plan:' = all days).
      list: function(prefix){
        return new Promise(function(resolve){
          var keys = [];
          for(var i = 0; i < localStorage.length; i++){
            var k = localStorage.key(i);
            if(k.indexOf(PREFIX + (prefix || '')) === 0) keys.push(k.slice(PREFIX.length));
          }
          resolve({ keys: keys });
        });
      }
    };
  })();
}
