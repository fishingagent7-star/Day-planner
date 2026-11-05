(function(){

  var DEFAULT_TAGS = [
    { name:"School", color:"#3a5a49" },
    { name:"Study", color:"#4a6fa5" },
    { name:"Training", color:"#b5562f" },
    { name:"Fishing", color:"#2f7a8c" },
    { name:"DIY", color:"#8a6d3b" },
    { name:"Personal", color:"#7a4a8c" }
  ];
  var TAGS = DEFAULT_TAGS.map(function(t){ return {name:t.name, color:t.color}; });
  var blocks = [];
  var saveTimer = null;
  var catSaveTimer = null;
  var consCache = {};      // dateKey -> {total, done}
  var consLoaded = false;
  var consLoadPromise = null;
  var consLoading = false;
  var consLoadError = '';
  var compactionRunning = false;
  var historyStack = [];
  var redoStack = [];
  var lastSnapshot = null;

  function uid(){ return Math.random().toString(36).slice(2,9); }

  // Claude's storage can throw when a key doesn't exist yet. For keys that are
  // allowed to be missing, treat that as "nothing there" instead of an error.
  function safeGet(key){
    return window.storage.get(key).catch(function(){ return null; });
  }

  // Build a "YYYY-MM-DD" string from a date's LOCAL calendar day, never UTC.
  // toISOString() converts to UTC first, which silently shifts the date by
  // a day for any timezone that isn't UTC+0 — that was the source of the
  // recurring-block/wrong-day bug.
  function localDateStr(date){
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function weekDates(){
    var d = new Date();
    var day = d.getDay();
    var mondayOffset = day === 0 ? -6 : 1 - day;
    var monday = new Date(d);
    monday.setDate(d.getDate() + mondayOffset);
    var dates = [];
    for(var i=0;i<7;i++){
      var dt = new Date(monday);
      dt.setDate(monday.getDate()+i);
      dates.push(dt);
    }
    return dates;
  }

  var DATES = weekDates();
  var activeIndex = 0;
  (function(){
    var todayStr = new Date().toDateString();
    for(var i=0;i<DATES.length;i++){
      if(DATES[i].toDateString() === todayStr){ activeIndex = i; break; }
    }
  })();

  function dateKey(date){
    return 'plan:' + localDateStr(date);
  }

  function recurAppliedKey(date){
    return 'recurapplied:' + localDateStr(date);
  }

  var recurringRules = []; // { id, templateName, weekdays:[0-6] }
  // Like templates: 'ok' only once we really know what's stored. While 'loading' or
  // 'failed', adding and removing rules is paused so a failed read can't wipe them.
  var recurringState = 'loading';

  function loadRecurringRules(){
    return loadProtected('recurring').then(function(text){
      recurringRules = text ? JSON.parse(text) : []; // a parse error counts as a failed read
      recurringState = 'ok';
    }).catch(function(){
      recurringState = 'failed';
    });
  }

  function recurringReady(){
    if(recurringState === 'ok') return true;
    setTemplateStatus(recurringState === 'loading'
      ? 'Still loading your recurring rules — try again in a moment.'
      : 'Your recurring rules didn’t load, so changes are paused to keep them safe. Reload to try again.');
    return false;
  }

  function saveRecurringRules(){
    if(recurringState !== 'ok') return Promise.resolve(); // never save over rules that didn't load
    return window.storage.set('recurring', JSON.stringify(recurringRules)).catch(function(){});
  }

  function applyRecurringTo(arr, date){
    var weekday = date.getDay();
    var matching = recurringRules.filter(function(r){ return r.weekdays.indexOf(weekday) !== -1; });
    if(matching.length === 0) return Promise.resolve();

    return safeGet(recurAppliedKey(date)).then(function(res){
      var applied = [];
      if(res && res.value){
        try{ applied = JSON.parse(res.value); }catch(e){ applied = []; }
      }
      var toApply = matching.filter(function(r){ return applied.indexOf(r.id) === -1; });
      if(toApply.length === 0) return Promise.resolve();

      toApply.forEach(function(r){
        var tpl = templates[r.templateName];
        if(!tpl) return;
        tpl.forEach(function(t){
          arr.push({
            id: uid(),
            time: t.time,
            title: t.title,
            notes: t.notes || '',
            tags: (t.tags || []).slice(),
            done: false,
            duration: t.duration || 30
          });
        });
        applied.push(r.id);
      });
      arr.sort(function(a,b){ return timeToMinutes(a.time) - timeToMinutes(b.time); });
      return window.storage.set(dateKey(date), JSON.stringify(arr)).then(function(){
        return window.storage.set(recurAppliedKey(date), JSON.stringify(applied));
      }).catch(function(){});
    }).catch(function(){});
  }

  function sortBlocksInPlace(){
    blocks.sort(function(a,b){ return timeToMinutes(a.time) - timeToMinutes(b.time); });
  }

  function defaultBlocks(){
    return [
      { id: uid(), time:"07:00", title:"Wake up", notes:"", tags:[], done:false, duration:30 },
      { id: uid(), time:"08:30", title:"School starts", notes:"", tags:["School"], done:false, duration:390 },
      { id: uid(), time:"16:00", title:"Study block", notes:"", tags:["Study"], done:false, duration:60 }
    ];
  }


  function tagColor(name){
    var hash = 0;
    for(var i=0;i<name.length;i++){
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    var hue = Math.abs(hash) % 360;
    return 'hsla(' + hue + ', 55%, 50%, 0.09)';
  }

  function colorForCategory(name){
    var found = TAGS.find(function(t){ return t.name === name; });
    return found ? found.color : '#b9b2a0';
  }

  function timeToMinutes(t){
    var parts = t.split(':');
    var h = parseInt(parts[0],10) || 0;
    var m = parseInt(parts[1],10) || 0;
    return h*60 + m;
  }

  function minutesToTime(mins){
    mins = Math.round(mins/5)*5;
    var h = Math.floor(mins/60) % 24;
    var m = mins % 60;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  }

  var toastTimer = null;
  function setStatus(text, ms){
    var el = document.getElementById('toast');
    if(!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){
      el.classList.remove('show');
    }, ms || 1800);
  }

  function updateLastSaved(){
    var el = document.getElementById('status');
    if(!el) return;
    var now = new Date();
    var h = now.getHours();
    var m = String(now.getMinutes()).padStart(2,'0');
    var ampm = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    el.textContent = 'Last saved ' + h12 + ':' + m + ' ' + ampm;
  }

  // ---------- persistence ----------

  // Read a key that must never be mistaken for "empty" when the read fails (otherwise the
  // next save would overwrite the real data with nothing). Resolves with the saved text, or
  // null when nothing is saved yet; rejects if it still can't be read after three tries.
  // Some storage throws for a missing key, so a failed read asks the key list, which doesn't.
  function loadProtected(key, attempt){
    attempt = attempt || 0;
    return window.storage.get(key).then(function(res){
      return res && res.value ? res.value : null;
    }).catch(function(){
      return window.storage.list(key).then(function(l){
        if(l && l.keys && l.keys.indexOf(key) !== -1) throw new Error(key + ' exists but could not be read');
        return null;
      });
    }).catch(function(err){
      if(attempt >= 2) throw err;
      return new Promise(function(r){ setTimeout(r, 800 * (attempt + 1)); }).then(function(){
        return loadProtected(key, attempt + 1);
      });
    });
  }

  // Like templates: 'ok' only once we really know what's stored. While 'loading' or
  // 'failed', the category editor is replaced by a message so nothing can be saved over them.
  var categoriesState = 'loading';

  function loadCategories(){
    return loadProtected('categories').then(function(text){
      if(text){
        // a parse error counts as a failed read
        TAGS = JSON.parse(text).map(function(t, i){
          // migrate old plain-string format to {name,color}
          if(typeof t === 'string'){
            var fallback = DEFAULT_TAGS[i % DEFAULT_TAGS.length].color;
            return { name: t, color: fallback };
          }
          return t;
        });
      }
      categoriesState = 'ok';
      renderCatManager();
    }).catch(function(){
      categoriesState = 'failed';
      renderCatManager();
    });
  }

  function saveCategories(){
    if(categoriesState !== 'ok') return; // never save over categories that didn't load
    clearTimeout(catSaveTimer);
    catSaveTimer = setTimeout(function(){
      window.storage.set('categories', JSON.stringify(TAGS)).catch(function(){});
    }, 250);
  }

  var loadSeq = 0; // each loadDay call gets a number; only the newest one may touch the screen

  // The logo screen fades out once settings (colours) and the first day are both on screen,
  // and it has shown for at least 2 seconds. It only exists on a fresh start: coming back
  // to the app from the background doesn't reload the page, so it doesn't show again.
  var splashParts = {};
  function splashReady(part){
    splashParts[part] = true;
    if(part !== 'timeout' && !(splashParts.settings && splashParts.day && splashParts.shown)) return;
    var s = document.getElementById('splash');
    if(!s) return;
    s.classList.add('gone');
    setTimeout(function(){ s.remove(); maybeTour(); }, 500);
  }

  // ---------- noticing a streak, gently ----------
  // When ticking a block makes today a good day, and that's 2 or more good days in a row,
  // a short note says so. Never a warning about breaking it: kind to missed days.
  function todayIsGood(){
    var v = consCache[dateKey(new Date())];
    return !!(v && v.total > 0 && v.done / v.total >= settings.goodDay);
  }
  function streakNote(){
    if(!consLoaded || consLoading) return; // the history isn't all counted yet
    var n = computeStreaks().current;
    if(n < 2) return;
    var text = n === 7 ? 'A whole week of good days in a row ✦'
      : n === 30 ? '30 good days in a row. That’s a month ✦'
      : n === 100 ? '100 good days in a row. Incredible ✦'
      : n + ' good days in a row ✦';
    setStatus(text, 3500);
  }

  // ---------- a little star when a block is ticked ----------
  // A tiny gold Lodestar star pops out of the checkbox, twinkles and floats up as it fades.
  // Plays even with "reduce motion" on: the owner asked for gentle animations like this.
  function tickStar(r){
    if(!document.body.animate) return;
    var star = document.createElement('span');
    star.className = 'tick-star';
    star.setAttribute('aria-hidden', 'true');
    // the darker gold edge keeps it visible on light themes too
    star.innerHTML = '<svg width="24" height="24" viewBox="-1 -1 22 22"><path d="M10 0 Q12.5 7.5 20 10 Q12.5 12.5 10 20 Q7.5 12.5 0 10 Q7.5 7.5 10 0 Z" fill="#f2d27a" stroke="#b8860b" stroke-width="1"/></svg>';
    star.style.left = (r.left + r.width / 2 - 12) + 'px';
    star.style.top = (r.top + r.height / 2 - 12) + 'px';
    document.body.appendChild(star);
    var drift = (Math.random() * 16 - 8).toFixed(0);
    star.animate([
      { transform: 'translate(0px, 0px) scale(0.2) rotate(0deg)', opacity: 0 },
      { transform: 'translate(0px, -6px) scale(1.3) rotate(8deg)', opacity: 1, offset: 0.2 },
      { transform: 'translate(' + (drift / 2) + 'px, -22px) scale(1) rotate(15deg)', opacity: 1, offset: 0.5 },
      { transform: 'translate(' + drift + 'px, -46px) scale(0.6) rotate(25deg)', opacity: 0 }
    ], { duration: 1100, easing: 'ease-out', fill: 'forwards' }).onfinish = function(){ star.remove(); };
  }

  // ---------- welcome tour ----------
  // Shown once per account (settings.tourDone), after the logo screen; replay from Settings.
  // Each step lights up one real part of the page; a step whose part is hidden is left out.
  var TOUR = [
    { title: 'Welcome to Lodestar', text: 'Plan your day in simple time blocks, and watch your own night sky fill with stars as you go. This takes about 30 seconds.' },
    { el: '#addBtn', title: 'Add a block', text: 'Tap here to add something to your day: a time, a title, and how long it takes. You can also save a whole day as a template.' },
    { el: '.block', title: 'Tick it off', text: 'Done? Tick it. Finish half of your blocks and it counts as a good day. You can change that in Settings.' },
    { el: '#nightSkyBlock', title: 'Your night sky', text: 'Every good day lights a star. Fill all 88 constellations. Missed days never take a star away.' },
    { el: '#moreBtn', title: 'Make it yours', text: 'This menu holds Templates, Summary and Settings: themes, categories, repeating days, reminders and backups.' }
  ];
  var tourBox = null, tourSteps = [], tourAt = 0, settingsLoaded = false;

  // Only once someone is signed in, their settings have loaded, and the logo screen has gone:
  // never over the sign-in screen, and never from settings that failed to load.
  function maybeTour(){
    if(settingsLoaded && !settings.tourDone && !document.getElementById('splash') && document.getElementById('signIn').hidden) startTour();
  }

  function startTour(){
    if(tourBox) return;
    tourSteps = TOUR.filter(function(s){
      var el = s.el && document.querySelector(s.el);
      return !s.el || (el && el.offsetParent !== null);
    });
    tourBox = document.createElement('div');
    tourBox.className = 'tour';
    tourBox.innerHTML = '<div class="tour-dim"></div><div class="tour-ring"></div>' +
      '<div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle">' +
      '<div class="tour-top"><svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 0 Q12.5 7.5 20 10 Q12.5 12.5 10 20 Q7.5 12.5 0 10 Q7.5 7.5 10 0 Z" fill="#f2d27a"/></svg><span class="tour-count"></span></div>' +
      '<h2 id="tourTitle"></h2><p></p><div class="tour-dots" aria-hidden="true"></div>' +
      '<div class="tour-actions"><button type="button" class="tour-skip">Skip tour</button>' +
      '<span><button type="button" class="tour-back">Back</button><button type="button" class="tour-next"></button></span></div></div>';
    document.body.appendChild(tourBox);
    tourBox.querySelector('.tour-skip').addEventListener('click', endTour);
    tourBox.querySelector('.tour-back').addEventListener('click', function(){ showTourStep(tourAt - 1); });
    tourBox.querySelector('.tour-next').addEventListener('click', function(){
      if(tourAt === tourSteps.length - 1) endTour(); else showTourStep(tourAt + 1);
    });
    document.addEventListener('keydown', tourKey);
    window.addEventListener('resize', placeTour);
    window.addEventListener('scroll', placeTour, true);
    showTourStep(0);
  }

  function tourKey(e){ if(e.key === 'Escape') endTour(); }

  function showTourStep(i){
    tourAt = i;
    var s = tourSteps[i], last = i === tourSteps.length - 1;
    tourBox.querySelector('#tourTitle').textContent = s.title;
    tourBox.querySelector('.tour-card p').textContent = s.text;
    tourBox.querySelector('.tour-count').textContent = 'Step ' + (i + 1) + ' of ' + tourSteps.length;
    tourBox.querySelector('.tour-dots').innerHTML = tourSteps.map(function(_, n){ return '<span' + (n === i ? ' class="on"' : '') + '></span>'; }).join('');
    tourBox.querySelector('.tour-back').hidden = i === 0;
    var next = tourBox.querySelector('.tour-next');
    next.textContent = i === 0 ? 'Show me' : last ? 'Finish' : 'Next';
    // bring the part near the top of the screen, leaving room for the card underneath
    if(s.el) window.scrollBy(0, document.querySelector(s.el).getBoundingClientRect().top - 90);
    placeTour();
    next.focus({ preventScroll: true });
  }

  // Put the gold ring around this step's part, and the card just below it (or above, if there's no room).
  function placeTour(){
    if(!tourBox) return;
    var s = tourSteps[tourAt], ring = tourBox.querySelector('.tour-ring'), card = tourBox.querySelector('.tour-card');
    var el = s.el && document.querySelector(s.el);
    tourBox.classList.toggle('shade', !el); // the welcome step dims the whole page
    ring.hidden = !el;
    if(!el){ card.style.top = Math.max(16, (window.innerHeight - card.offsetHeight) / 2) + 'px'; return; }
    var r = el.getBoundingClientRect(), pad = 6;
    ring.style.left = (r.left - pad) + 'px';
    ring.style.top = (r.top - pad) + 'px';
    ring.style.width = (r.width + pad * 2) + 'px';
    ring.style.height = (r.height + pad * 2) + 'px';
    var below = r.bottom + pad + 14, h = card.offsetHeight;
    card.style.top = Math.max(16, below + h < window.innerHeight - 16 ? below : r.top - pad - 14 - h) + 'px';
  }

  function endTour(){
    if(!tourBox) return;
    tourBox.remove();
    tourBox = null;
    document.removeEventListener('keydown', tourKey);
    window.removeEventListener('resize', placeTour);
    window.removeEventListener('scroll', placeTour, true);
    if(!settings.tourDone){ settings.tourDone = true; saveSettings(); }
  }
  setTimeout(function(){ splashReady('shown'); }, 2000); // the logo is on screen by now, so 2s of it
  setTimeout(function(){ splashReady('timeout'); }, 10000); // never stay stuck on the logo

  function loadDay(){
    var date = DATES[activeIndex];
    var mySeq = ++loadSeq;
    var arr = [];
    flushSaves(); // write any pending edit to the day we're leaving, right now

    function show(list){
      if(mySeq !== loadSeq) return; // the user has already moved on to another day
      blocks = list;
      historyStack = [];
      redoStack = [];
      lastSnapshot = null;
      renderDay();
      splashReady('day');
    }

    safeGet(dateKey(date)).then(function(res){
      if(res && res.value){
        try{ arr = JSON.parse(res.value); }catch(e){ arr = []; }
      } else {
        arr = (date.toDateString() === new Date().toDateString()) ? defaultBlocks() : [];
      }
      return applyRecurringTo(arr, date);
    }).then(function(){
      show(arr);
    }).catch(function(){
      show([]);
    });
  }

  var hasUnsavedChanges = false;
  var pendingSaves = {}; // day key -> JSON taken at the moment of the edit

  function saveDay(){
    hasUnsavedChanges = true;
    // snapshot now, under the day that's on screen now, so switching days
    // before the timer fires can't send the wrong content to the wrong day
    pendingSaves[dateKey(DATES[activeIndex])] = JSON.stringify(blocks);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, 350);
  }

  function flushSaves(){
    clearTimeout(saveTimer);
    var jobs = pendingSaves;
    var keys = Object.keys(jobs);
    if(!keys.length) return Promise.resolve();
    pendingSaves = {};
    var failed = false;

    return keys.reduce(function(chain, k){
      return chain.then(function(){
        return window.storage.set(k, jobs[k]).catch(function(){
          failed = true;
          if(!(k in pendingSaves)) pendingSaves[k] = jobs[k]; // keep it so it gets retried
        });
      });
    }, Promise.resolve()).then(function(){
      if(failed){
        setStatus('Could not save');
      } else if(Object.keys(pendingSaves).length === 0){
        updateLastSaved();
        hasUnsavedChanges = false;
      }
    });
  }

  window.addEventListener('beforeunload', function(e){
    flushSaves(); // best effort: start writing anything still waiting
    if(hasUnsavedChanges){
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- rendering ----------

  function renderTabs(){
    var wrap = document.getElementById('dayTabs');
    wrap.innerHTML = '';
    DATES.forEach(function(d, i){
      var btn = document.createElement('button');
      btn.className = 'daytab' + (i === activeIndex ? ' active' : '') + (d.toDateString() === new Date().toDateString() ? ' today' : '');
      btn.textContent = d.toLocaleDateString(undefined, {weekday:'short', day:'numeric'});
      btn.addEventListener('click', function(){
        if(i === activeIndex) return;
        activeIndex = i;
        renderTabs();
        loadDay();
      });
      wrap.appendChild(btn);
    });
  }

  function renderCatManager(){
    var wrap = document.getElementById('catManager');
    wrap.innerHTML = '';
    if(categoriesState !== 'ok'){
      wrap.textContent = categoriesState === 'loading'
        ? 'Loading your categories…'
        : 'Your categories didn’t load, so editing them is paused to keep them safe. Reload to try again.';
      return;
    }
    TAGS.forEach(function(cat){
      var chip = document.createElement('span');
      chip.className = 'cat-chip';
      chip.style.background = cat.color;
      chip.style.color = '#fff';
      chip.style.borderColor = cat.color;

      var label = document.createElement('span');
      label.textContent = cat.name;
      chip.appendChild(label);

      var colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = cat.color;
      colorInput.className = 'cat-color-input';
      colorInput.title = 'Change color';
      colorInput.addEventListener('input', function(e){
        cat.color = e.target.value;
        saveCategories();
        renderCatManager();
        renderDay();
      });
      chip.appendChild(colorInput);

      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = '\u00d7';
      x.addEventListener('click', function(){
        TAGS = TAGS.filter(function(t){ return t.name !== cat.name; });
        blocks.forEach(function(b){ b.tags = b.tags.filter(function(t){ return t !== cat.name; }); });
        saveCategories();
        saveDay();
        renderCatManager();
        renderDay();
      });
      chip.appendChild(x);
      wrap.appendChild(chip);
    });

    var addWrap = document.createElement('span');
    addWrap.className = 'cat-add';
    var input = document.createElement('input');
    input.placeholder = 'New category';
    var colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.value = '#3a5a49';
    colorPicker.className = 'cat-color-input';
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '+';
    function submit(){
      var val = input.value.trim();
      if(!val) return;
      if(!TAGS.some(function(t){ return t.name === val; })){
        TAGS.push({ name: val, color: colorPicker.value });
        saveCategories();
        renderCatManager();
        renderDay();
      }
      input.value = '';
    }
    addBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); submit(); } });
    addWrap.appendChild(input);
    addWrap.appendChild(colorPicker);
    addWrap.appendChild(addBtn);
    wrap.appendChild(addWrap);
  }

  // The "now" line: only on today's tab. If a block is in progress, the line crosses it
  // at how far through it you are and the block is highlighted. Otherwise it sits in the
  // gap between the blocks before and after the current time.
  function makeNowLine(label){
    var line = document.createElement('div');
    line.className = 'now-line';
    if(label){
      var l = document.createElement('span');
      l.className = 'now-label';
      l.textContent = label;
      line.appendChild(l);
    }
    return line;
  }

  function updateNowLine(){
    var track = document.getElementById('track');
    if(!track) return;
    Array.prototype.forEach.call(track.querySelectorAll('.now-line'), function(n){ n.remove(); });
    Array.prototype.forEach.call(track.querySelectorAll('.block.current'), function(n){ n.classList.remove('current'); });

    if(!blocks.length) return;
    var now = new Date();
    if(DATES[activeIndex].toDateString() !== now.toDateString()) return;

    var nowMin = now.getHours() * 60 + now.getMinutes();
    var rows = track.querySelectorAll('.block');
    if(rows.length !== blocks.length) return; // list is mid-redraw; the next update will catch up

    for(var i = 0; i < blocks.length; i++){
      var start = timeToMinutes(blocks[i].time);
      var end = start + (blocks[i].duration || 30);
      if(nowMin >= start && nowMin < end){
        var pct = ((nowMin + now.getSeconds() / 60) - start) / (end - start) * 100;
        var inside = makeNowLine(null);
        inside.classList.add('inside');
        inside.style.top = Math.min(100, Math.max(0, pct)) + '%';
        rows[i].classList.add('current');
        rows[i].appendChild(inside);
        return;
      }
    }

    var label = now.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
    var line = makeNowLine(label);
    for(var j = 0; j < blocks.length; j++){
      if(timeToMinutes(blocks[j].time) > nowMin){
        var gap = rows[j].previousElementSibling;
        track.insertBefore(line, (gap && gap.classList.contains('insert-gap')) ? gap : rows[j]);
        return;
      }
    }
    track.appendChild(line); // later than every block
  }

  setInterval(updateNowLine, 30000);

  function makeInsertGap(index){
    var gap = document.createElement('div');
    gap.className = 'insert-gap';
    var line = document.createElement('div');
    line.className = 'insert-line';
    gap.appendChild(line);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'insert-btn';
    btn.textContent = '+';
    btn.title = 'Insert block here';
    btn.addEventListener('click', function(){
      insertBlockAt(index);
    });
    gap.appendChild(btn);
    return gap;
  }

  function closeAllCopyPopovers(){
    var pops = document.querySelectorAll('.copy-to-popover');
    for(var i = 0; i < pops.length; i++){ pops[i].remove(); }
  }

  function openCopyToPopover(anchorBtn, block){
    var row = anchorBtn.closest('.block');
    if(!row) return;

    var pop = document.createElement('div');
    pop.className = 'copy-to-popover';

    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    var defaultDate = new Date(DATES[activeIndex]);
    defaultDate.setDate(defaultDate.getDate() + 1);
    dateInput.value = localDateStr(defaultDate);
    pop.appendChild(dateInput);

    var actions = document.createElement('div');
    actions.className = 'copy-to-actions';

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'primary';
    confirmBtn.textContent = 'Copy';
    confirmBtn.addEventListener('click', function(){
      if(!dateInput.value) return;
      copyBlockToDate(block, dateInput.value);
      pop.remove();
    });

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function(){ pop.remove(); });

    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    pop.appendChild(actions);

    row.appendChild(pop);

    setTimeout(function(){
      document.addEventListener('click', function outsideClick(e){
        if(!pop.contains(e.target) && e.target !== anchorBtn){
          pop.remove();
          document.removeEventListener('click', outsideClick);
        }
      });
    }, 0);
  }

  function copyBlockToDate(block, isoDateStr){
    var targetKey = 'plan:' + isoDateStr;
    flushSaves().then(function(){ return safeGet(targetKey); }).then(function(res){
      var targetBlocks = [];
      if(res && res.value){
        try{ targetBlocks = JSON.parse(res.value); }catch(e){ targetBlocks = []; }
      }
      targetBlocks.push({
        id: uid(),
        time: block.time,
        title: block.title,
        notes: block.notes || '',
        tags: (block.tags || []).slice(),
        done: false,
        duration: block.duration || 30
      });
      targetBlocks.sort(function(a,b){ return timeToMinutes(a.time) - timeToMinutes(b.time); });
      return window.storage.set(targetKey, JSON.stringify(targetBlocks));
    }).then(function(){
      setStatus('Copied to ' + isoDateStr);
      refreshConsistency();
      if(dateKey(DATES[activeIndex]) === targetKey){
        loadDay();
      }
    }).catch(function(){
      setStatus('Could not copy block');
    });
  }

  function insertBlockAt(index){
    var prev = index > 0 ? blocks[index - 1] : null;
    var next = index < blocks.length ? blocks[index] : null;
    var time;
    if(prev && next){
      time = minutesToTime(Math.round((timeToMinutes(prev.time) + timeToMinutes(next.time)) / 2));
    } else if(prev){
      time = minutesToTime(timeToMinutes(prev.time) + (prev.duration || 30));
    } else if(next){
      time = minutesToTime(Math.max(0, timeToMinutes(next.time) - 30));
    } else {
      time = "12:00";
    }
    var newId = uid();
    blocks.splice(index, 0, { id: newId, time: time, title:"", notes:"", tags:[], done:false, duration:30 });
    saveDay();
    renderDay();
    focusBlockTitle(newId);
  }

  function renderMiniTimeline(){
    var el = document.getElementById('miniTimeline');
    el.innerHTML = '';

    if(blocks.length === 0){
      var empty = document.createElement('div');
      empty.className = 'mini-timeline-empty';
      empty.textContent = 'Nothing planned yet';
      el.appendChild(empty);
      return;
    }

    var minStart = Math.min.apply(null, blocks.map(function(b){ return timeToMinutes(b.time); }));
    var maxEnd = Math.max.apply(null, blocks.map(function(b){ return timeToMinutes(b.time) + (b.duration || 30); }));
    var range = Math.max(1, maxEnd - minStart);

    blocks.forEach(function(b){
      var start = timeToMinutes(b.time);
      var dur = b.duration || 30;
      var seg = document.createElement('div');
      seg.className = 'mini-timeline-seg';
      seg.style.left = ((start - minStart) / range * 100) + '%';
      seg.style.width = Math.max(0.6, (dur / range * 100)) + '%';
      var catName = (b.tags && b.tags.length) ? b.tags[0] : null;
      seg.style.background = catName ? colorForCategory(catName) : '#b9b2a0';

      var tooltip = document.getElementById('miniTooltip');
      seg.addEventListener('mouseenter', function(){
        tooltip.textContent = (b.title || 'Untitled') + ' \u00b7 ' + b.time;
        var rect = seg.getBoundingClientRect();
        tooltip.style.left = (rect.left + rect.width / 2) + 'px';
        tooltip.style.top = rect.top + 'px';
        tooltip.classList.add('show');
      });
      seg.addEventListener('mouseleave', function(){
        tooltip.classList.remove('show');
      });

      seg.addEventListener('click', function(){
        var target = document.querySelector('.block[data-id="' + b.id + '"]');
        if(target){
          target.scrollIntoView({ behavior:'smooth', block:'center' });
          target.style.transition = 'box-shadow 0.2s ease';
          target.style.boxShadow = '0 0 0 2px var(--accent)';
          setTimeout(function(){ target.style.boxShadow = ''; }, 900);
        }
      });
      el.appendChild(seg);
    });
  }

  function renderDay(){
    var track = document.getElementById('track');

    // history checkpoint: compare current state to last recorded snapshot
    var currentSnapshot = JSON.stringify(blocks);
    if(lastSnapshot !== null && lastSnapshot !== currentSnapshot){
      historyStack.push(lastSnapshot);
      if(historyStack.length > 50) historyStack.shift();
      redoStack = [];
    }
    lastSnapshot = currentSnapshot;
    updateUndoRedoButtons();

    // FLIP: capture old positions before we rebuild the DOM
    var oldRects = {};
    Array.prototype.forEach.call(track.querySelectorAll('.block'), function(el){
      oldRects[el.dataset.id] = el.getBoundingClientRect();
    });

    // keep the page from collapsing (and the browser jumping to the top)
    // while the list is briefly empty during the rebuild
    var savedScrollY = window.scrollY;
    track.style.minHeight = track.offsetHeight + 'px';
    function restoreScroll(){
      track.style.minHeight = '';
      window.scrollTo(0, savedScrollY);
    }

    track.innerHTML = '';

    var d = DATES[activeIndex];
    document.getElementById('dateHeading').textContent = d.toLocaleDateString(undefined, {weekday:'long', month:'long', day:'numeric'});

    var doneCount = blocks.filter(function(b){ return b.done; }).length;
    var totalCount = blocks.length;
    var pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
    document.getElementById('dayProgressFill').style.width = pct + '%';
    document.getElementById('dayProgressLabel').textContent = totalCount > 0
      ? (doneCount + ' / ' + totalCount)
      : 'No blocks';

    renderMiniTimeline();

    // keep the consistency grid in step with the day being edited
    var consKey = dateKey(DATES[activeIndex]);
    if(blocks.length > 0){
      consCache[consKey] = { total: blocks.length, done: doneCount };
    } else {
      delete consCache[consKey];
    }
    if(consLoaded) renderConsistency();

    if(blocks.length === 0){
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'A fresh day. Tap + Add block to plan your first thing.';
      track.appendChild(empty);
      restoreScroll();
      return;
    }

    // detect overlapping blocks (same day, times that intersect)
    var conflictIds = {};
    for(var i = 0; i < blocks.length; i++){
      var aStart = timeToMinutes(blocks[i].time);
      var aEnd = aStart + (blocks[i].duration || 30);
      for(var j = i + 1; j < blocks.length; j++){
        var bStart = timeToMinutes(blocks[j].time);
        var bEnd = bStart + (blocks[j].duration || 30);
        if(aStart < bEnd && bStart < aEnd){
          conflictIds[blocks[i].id] = true;
          conflictIds[blocks[j].id] = true;
        }
      }
    }

    blocks.forEach(function(b, idx){
      track.appendChild(makeInsertGap(idx));

      var row = document.createElement('div');
      row.className = 'block' + (b.done ? ' done' : '') + (conflictIds[b.id] ? ' conflict' : '');
      row.draggable = true;
      row.dataset.id = b.id;

      if(b.tags.length > 0){
        row.style.backgroundColor = tagColor(b.tags[0]);
      }

      row.addEventListener('dragstart', function(e){
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', b.id);
      });
      row.addEventListener('dragend', function(){
        row.classList.remove('dragging');
        Array.prototype.forEach.call(track.querySelectorAll('.block'), function(el){
          el.classList.remove('drag-over');
        });
      });
      row.addEventListener('dragover', function(e){
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', function(){
        row.classList.remove('drag-over');
      });
      row.addEventListener('drop', function(e){
        e.preventDefault();
        row.classList.remove('drag-over');
        var draggedId = e.dataTransfer.getData('text/plain');
        if(!draggedId || draggedId === b.id) return;
        var fromIdx = blocks.findIndex(function(x){ return x.id === draggedId; });
        var toIdx = blocks.findIndex(function(x){ return x.id === b.id; });
        if(fromIdx === -1 || toIdx === -1) return;
        var moved = blocks.splice(fromIdx, 1)[0];
        blocks.splice(toIdx, 0, moved);
        saveDay();
        renderDay();
      });

      var handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '\u2807';
      handle.setAttribute('aria-hidden', 'true');
      row.appendChild(handle);

      var check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'check';
      check.checked = !!b.done;
      check.addEventListener('change', function(e){
        b.done = e.target.checked;
        if(b.done) tickStar(e.target.getBoundingClientRect()); // measured now, before the redraw replaces the box
        var wasGood = todayIsGood();
        saveDay();
        renderDay(); // this updates today's done count
        if(b.done && !wasGood && todayIsGood()) streakNote();
      });
      row.appendChild(check);

      var timeCol = document.createElement('div');
      timeCol.className = 'time-col';
      var timeInput = document.createElement('input');
      timeInput.type = 'time';
      timeInput.step = 300;
      timeInput.value = b.time;
      // Browsers send "change" after each typed digit (12:0|3 before the 0 of 30), so save
      // straight away but only redraw (which closes the box) once the person leaves it.
      timeInput.addEventListener('change', function(e){
        if(!e.target.value) return;
        b.time = e.target.value;
        saveDay();
        timeInput.dataset.changed = '1';
      });
      timeInput.addEventListener('blur', function(){ if(timeInput.dataset.changed) renderDay(); });
      timeCol.appendChild(timeInput);

      if(b.duration == null) b.duration = 30;
      var durRow = document.createElement('div');
      durRow.className = 'duration-row';

      var durDown = document.createElement('button');
      durDown.type = 'button';
      durDown.className = 'dur-step';
      durDown.textContent = '\u2212';
      durDown.addEventListener('click', function(){
        b.duration = Math.max(5, b.duration - 5);
        saveDay();
        renderDay();
      });

      var durInput = document.createElement('input');
      durInput.type = 'number';
      durInput.min = 5;
      durInput.step = 5;
      durInput.value = b.duration;
      durInput.addEventListener('change', function(e){
        var v = parseInt(e.target.value, 10);
        b.duration = (isNaN(v) || v < 5) ? 5 : v;
        saveDay();
        renderDay();
      });

      var durUp = document.createElement('button');
      durUp.type = 'button';
      durUp.className = 'dur-step';
      durUp.textContent = '+';
      durUp.addEventListener('click', function(){
        b.duration = b.duration + 5;
        saveDay();
        renderDay();
      });

      var durLabel = document.createElement('span');
      durLabel.textContent = 'min';

      durRow.appendChild(durDown);
      durRow.appendChild(durUp);
      durRow.appendChild(durInput);
      durRow.appendChild(durLabel);
      timeCol.appendChild(durRow);

      var endTimeRow = document.createElement('div');
      endTimeRow.className = 'end-time-row';
      var endArrow = document.createElement('span');
      endArrow.textContent = '\u2192';
      endArrow.className = 'end-arrow';
      var endTimeInput = document.createElement('input');
      endTimeInput.type = 'time';
      endTimeInput.step = 300;
      endTimeInput.className = 'end-time-input';
      endTimeInput.value = minutesToTime(timeToMinutes(b.time) + b.duration);
      endTimeInput.addEventListener('change', function(e){
        if(!e.target.value) return;
        var startMin = timeToMinutes(b.time);
        var endMin = timeToMinutes(e.target.value);
        var newDuration = endMin - startMin;
        if(newDuration <= 0) newDuration += 24 * 60; // end time rolled past midnight
        b.duration = Math.max(5, newDuration);
        saveDay();
        endTimeInput.dataset.changed = '1';
      });
      endTimeInput.addEventListener('blur', function(){ if(endTimeInput.dataset.changed) renderDay(); }); // same as the start time
      endTimeRow.appendChild(endArrow);
      endTimeRow.appendChild(endTimeInput);
      timeCol.appendChild(endTimeRow);

      row.appendChild(timeCol);

      var content = document.createElement('div');
      content.className = 'content';

      var titleInput = document.createElement('input');
      titleInput.className = 'title';
      titleInput.type = 'text';
      titleInput.placeholder = 'What are you doing?';
      titleInput.value = b.title;
      titleInput.addEventListener('input', function(e){
        b.title = e.target.value;
        saveDay();
      });
      content.appendChild(titleInput);

      var notes = document.createElement('textarea');
      notes.rows = 1;
      notes.placeholder = 'Notes (optional)';
      notes.value = b.notes || '';
      notes.style.overflow = 'hidden';
      notes.addEventListener('input', function(e){
        b.notes = e.target.value;
        e.target.style.height = 'auto';
        e.target.style.height = e.target.scrollHeight + 'px';
        saveDay();
      });
      content.appendChild(notes);

      var tagRow = document.createElement('div');
      tagRow.className = 'tag-row';
      TAGS.forEach(function(cat){
        var tag = document.createElement('span');
        var isOn = b.tags.indexOf(cat.name) !== -1;
        tag.className = 'tag' + (isOn ? ' on' : '');
        if(isOn){
          tag.style.background = cat.color;
          tag.style.borderColor = cat.color;
          tag.style.color = '#fff';
        }
        tag.textContent = cat.name;
        tag.addEventListener('click', function(){
          var idx = b.tags.indexOf(cat.name);
          if(idx !== -1){ b.tags.splice(idx,1); } else { b.tags.push(cat.name); }
          saveDay();
          renderDay();
        });
        tagRow.appendChild(tag);
      });
      content.appendChild(tagRow);

      if(conflictIds[b.id]){
        var badge = document.createElement('span');
        badge.className = 'conflict-badge';
        badge.textContent = '\u26a0 Overlaps another block';
        content.appendChild(badge);
      }

      row.appendChild(content);

      var dupBtn = document.createElement('button');
      dupBtn.type = 'button';
      dupBtn.className = 'remove-btn';
      dupBtn.textContent = '\u29c9';
      dupBtn.title = 'Duplicate block';
      dupBtn.setAttribute('aria-label', 'Duplicate block');
      dupBtn.addEventListener('click', function(){
        var copyIdx = blocks.findIndex(function(x){ return x.id === b.id; });
        var copy = JSON.parse(JSON.stringify(b));
        copy.id = uid();
        copy.done = false;
        blocks.splice(copyIdx + 1, 0, copy);
        saveDay();
        renderDay();
      });
      row.appendChild(dupBtn);

      var copyToBtn = document.createElement('button');
      copyToBtn.type = 'button';
      copyToBtn.className = 'remove-btn copy-to-btn';
      copyToBtn.textContent = '\u2192';
      copyToBtn.title = 'Copy to another day';
      copyToBtn.setAttribute('aria-label', 'Copy to another day');
      copyToBtn.addEventListener('click', function(e){
        e.stopPropagation();
        closeAllCopyPopovers();
        openCopyToPopover(copyToBtn, b);
      });
      row.appendChild(copyToBtn);

      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '\u00d7';
      removeBtn.setAttribute('aria-label', 'Remove block');
      removeBtn.addEventListener('click', function(){
        blocks = blocks.filter(function(x){ return x.id !== b.id; });
        saveDay();
        renderDay();
      });
      row.appendChild(removeBtn);

      track.appendChild(row);
    });
    track.appendChild(makeInsertGap(blocks.length));

    updateNowLine();

    // auto-size all notes fields to their content now that they're in the live DOM
    Array.prototype.forEach.call(track.querySelectorAll('.content textarea'), function(ta){
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    });

    // FLIP: play the transform delta from old to new position
    Array.prototype.forEach.call(track.querySelectorAll('.block'), function(el){
      var oldRect = oldRects[el.dataset.id];
      if(!oldRect) return;
      var newRect = el.getBoundingClientRect();
      var dy = oldRect.top - newRect.top;
      if(Math.abs(dy) < 1) return;
      el.style.transition = 'none';
      el.style.transform = 'translateY(' + dy + 'px)';
      requestAnimationFrame(function(){
        el.style.transition = 'transform 0.22s ease';
        el.style.transform = '';
      });
    });

    restoreScroll();
  }

  // ---------- actions ----------

  function addBlock(){
    var last = blocks.length ? blocks[blocks.length-1] : null;
    var nextTime = last ? minutesToTime(timeToMinutes(last.time) + 30) : "12:00";
    var newId = uid();
    blocks.push({ id: newId, time: nextTime, title:"", notes:"", tags:[], done:false, duration:30 });
    saveDay();
    renderDay();
    focusBlockTitle(newId);
  }

  function focusBlockTitle(blockId){
    setTimeout(function(){
      var row = document.querySelector('.block[data-id="' + blockId + '"]');
      if(row){
        var titleField = row.querySelector('.title');
        if(titleField) titleField.focus();
      }
    }, 0);
  }

  function sortBlocks(){
    blocks.sort(function(a,b){ return timeToMinutes(a.time) - timeToMinutes(b.time); });
    saveDay();
    renderDay();
  }

  document.getElementById('addBtn').addEventListener('click', addBlock);
  document.getElementById('addBtn2').addEventListener('click', addBlock);
  document.getElementById('sortBtn').addEventListener('click', sortBlocks);

  var clearBtn = document.getElementById('clearBtn');
  var clearArmed = false;
  var clearArmTimer = null;
  clearBtn.addEventListener('click', function(){
    if(!clearArmed){
      clearArmed = true;
      clearBtn.textContent = 'Click again to confirm';
      clearBtn.classList.add('armed');
      clearArmTimer = setTimeout(function(){
        clearArmed = false;
        clearBtn.textContent = 'Clear day';
        clearBtn.classList.remove('armed');
      }, 3000);
      return;
    }
    clearTimeout(clearArmTimer);
    clearArmed = false;
    clearBtn.textContent = 'Clear day';
    clearBtn.classList.remove('armed');
    if(blocks.length > 0){
      historyStack.push(JSON.stringify(blocks));
      if(historyStack.length > 50) historyStack.shift();
      redoStack = [];
    }
    blocks = [];
    lastSnapshot = JSON.stringify(blocks);
    saveDay();
    renderDay();
    updateUndoRedoButtons();
  });

  var saveTemplateBtn = document.getElementById('saveTemplateBtn');
  var applyTemplateBtn = document.getElementById('applyTemplateBtn');
  var deleteTemplateBtn = document.getElementById('deleteTemplateBtn');
  var templateNameInput = document.getElementById('templateNameInput');
  var templateSelect = document.getElementById('templateSelect');
  var templateStatusEl = document.getElementById('templateStatus');

  var templates = {}; // { name: [ {time,title,notes,tags} ] }
  // 'ok' only once we really know what's stored. While it's 'loading' or 'failed',
  // saving/deleting templates is paused so a failed read can never cause the
  // (empty-looking) list to overwrite the real one.
  var templatesState = 'loading';

  function templatesReady(){
    if(templatesState === 'ok') return true;
    setTemplateStatus(templatesState === 'loading'
      ? 'Still loading your templates \u2014 try again in a moment.'
      : 'Your templates didn\'t load, so saving is paused to protect them. Reload to try again.');
    return false;
  }

  function setTemplateStatus(text){
    templateStatusEl.textContent = text;
  }

  function saveTemplatesToStorage(){
    return window.storage.set('templates', JSON.stringify(templates)).catch(function(){
      setTemplateStatus('Could not save template');
    });
  }

  function renderTemplateSelect(){
    var names = Object.keys(templates);
    var prevSelected = templateSelect.value;
    templateSelect.innerHTML = '';
    if(names.length === 0){
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No templates yet';
      templateSelect.appendChild(opt);
      return;
    }
    names.forEach(function(name){
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + ' (' + templates[name].length + ')';
      templateSelect.appendChild(opt);
    });
    if(names.indexOf(prevSelected) !== -1){
      templateSelect.value = prevSelected;
    }
  }

  function loadTemplates(attempt){
    attempt = attempt || 0;
    return window.storage.get('templates').then(function(res){
      var parsed = {};
      if(res && res.value){ parsed = JSON.parse(res.value) || {}; } // a parse error counts as a failure
      templates = parsed;
      templatesState = 'ok';
      renderTemplateSelect();
    }).catch(function(){
      // The read failed. That's either "nothing saved yet" (some storage throws for a
      // missing key) or a real hiccup. Ask the key list, which doesn't throw for missing keys.
      return window.storage.list('templates').then(function(l){
        var exists = !!(l && l.keys && l.keys.indexOf('templates') !== -1);
        if(!exists){
          templates = {};
          templatesState = 'ok';
          renderTemplateSelect();
          return;
        }
        throw new Error('templates exist but could not be read');
      });
    }).catch(function(){
      if(attempt < 2){
        return new Promise(function(r){ setTimeout(r, 800 * (attempt + 1)); }).then(function(){
          return loadTemplates(attempt + 1);
        });
      }
      templatesState = 'failed';
      renderTemplateSelect();
      templatesReady(); // shows the explanation
    });
  }

  saveTemplateBtn.addEventListener('click', function(){
    if(!templatesReady()) return;
    var name = templateNameInput.value.trim();
    if(!name){
      setTemplateStatus('Give the template a name first');
      return;
    }
    if(blocks.length === 0){
      setTemplateStatus('Nothing to save on this day yet');
      return;
    }
    templates[name] = blocks.map(function(b){
      return { time: b.time, title: b.title, notes: b.notes, tags: b.tags.slice(), duration: b.duration || 30 };
    });
    saveTemplatesToStorage().then(function(){
      renderTemplateSelect();
      templateSelect.value = name;
      templateNameInput.value = '';
      setTemplateStatus('Saved "' + name + '"');
    });
  });

  applyTemplateBtn.addEventListener('click', function(){
    var name = templateSelect.value;
    if(!name || !templates[name]){
      setTemplateStatus('No template selected');
      return;
    }
    templates[name].forEach(function(t){
      blocks.push({
        id: uid(),
        time: t.time,
        title: t.title,
        notes: t.notes,
        tags: t.tags.slice(),
        done: false,
        duration: t.duration || 30
      });
    });
    sortBlocks();
    saveDay();
    renderDay();
    setTemplateStatus('Applied "' + name + '"');
  });

  var deleteArmed = false;
  var deleteArmTimer = null;
  deleteTemplateBtn.addEventListener('click', function(){
    if(!templatesReady()) return;
    var name = templateSelect.value;
    if(!name || !templates[name]){
      setTemplateStatus('No template selected');
      return;
    }
    if(!deleteArmed){
      deleteArmed = true;
      deleteTemplateBtn.textContent = 'Click again to confirm';
      deleteTemplateBtn.classList.add('armed');
      deleteArmTimer = setTimeout(function(){
        deleteArmed = false;
        deleteTemplateBtn.textContent = 'Delete template';
        deleteTemplateBtn.classList.remove('armed');
      }, 3000);
      return;
    }
    clearTimeout(deleteArmTimer);
    deleteArmed = false;
    deleteTemplateBtn.textContent = 'Delete template';
    deleteTemplateBtn.classList.remove('armed');
    delete templates[name];
    saveTemplatesToStorage().then(function(){
      renderTemplateSelect();
      setTemplateStatus('Deleted "' + name + '"');
    });
  });

  renderTabs();
  loadCategories();
  Promise.all([loadRecurringRules(), loadTemplates()]).then(loadDay);
  refreshCompactStatus();
  setTimeout(maybeCompactOldDays, 5000);

  var undoBtn = document.getElementById('undoBtn');
  var redoBtn = document.getElementById('redoBtn');

  var copyYesterdayBtn = document.getElementById('copyYesterdayBtn');
  copyYesterdayBtn.addEventListener('click', function(){
    var current = DATES[activeIndex];
    var prevDate = new Date(current);
    prevDate.setDate(current.getDate() - 1);
    flushSaves().then(function(){ return safeGet(dateKey(prevDate)); }).then(function(res){
      if(!res || !res.value){
        setStatus('No data found for the previous day');
        return;
      }
      var prevBlocks;
      try{ prevBlocks = JSON.parse(res.value); }catch(e){ return; }
      if(!prevBlocks.length){
        setStatus('Previous day was empty');
        return;
      }
      prevBlocks.forEach(function(t){
        blocks.push({
          id: uid(),
          time: t.time,
          title: t.title,
          notes: t.notes || '',
          tags: (t.tags || []).slice(),
          done: false,
          duration: t.duration || 30
        });
      });
      sortBlocksInPlace();
      saveDay();
      renderDay();
    }).catch(function(){
      setStatus('Could not load previous day');
    });
  });

  // ---------- more menu ----------
  var moreBtn = document.getElementById('moreBtn');
  var moreMenu = document.getElementById('moreMenu');

  moreBtn.addEventListener('click', function(e){
    e.stopPropagation();
    var open = moreMenu.style.display !== 'none';
    moreMenu.style.display = open ? 'none' : 'flex';
  });

  // close the dropdown after picking any item inside it, but let the
  // item's own click handler (already attached elsewhere) run first
  moreMenu.addEventListener('click', function(e){
    if(e.target.tagName === 'BUTTON' && e.target.id !== 'clearBtn'){
      setTimeout(function(){ moreMenu.style.display = 'none'; }, 0);
    }
  });

  document.addEventListener('click', function(e){
    if(moreMenu.style.display !== 'none' && !moreMenu.contains(e.target) && e.target !== moreBtn){
      moreMenu.style.display = 'none';
    }
  });
  // the T key (today's tab has a gold outline, so there's no button for it)
  function goToToday(){
    var todayStr = new Date().toDateString();
    var idx = DATES.findIndex(function(d){ return d.toDateString() === todayStr; });
    if(idx === -1 || idx === activeIndex) return;
    activeIndex = idx;
    renderTabs();
    loadDay();
  }

  function updateUndoRedoButtons(){
    undoBtn.disabled = historyStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function undo(){
    if(historyStack.length === 0) return;
    redoStack.push(JSON.stringify(blocks));
    var prev = historyStack.pop();
    blocks = JSON.parse(prev);
    lastSnapshot = prev;
    saveDay();
    renderDay();
  }

  function redo(){
    if(redoStack.length === 0) return;
    historyStack.push(JSON.stringify(blocks));
    var next = redoStack.pop();
    blocks = JSON.parse(next);
    lastSnapshot = next;
    saveDay();
    renderDay();
  }

  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  document.addEventListener('keydown', function(e){
    var tag = document.activeElement ? document.activeElement.tagName : '';
    if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var mod = e.ctrlKey || e.metaKey;
    if(mod){
      var key = e.key.toLowerCase();
      if(key === 'z' && !e.shiftKey){
        e.preventDefault();
        undo();
      } else if((key === 'z' && e.shiftKey) || key === 'y'){
        e.preventDefault();
        redo();
      }
      return;
    }
    if(e.key.toLowerCase() === 'n'){
      e.preventDefault();
      addBlock();
    } else if(e.key.toLowerCase() === 's'){
      e.preventDefault();
      sortBlocks();
    } else if(e.key.toLowerCase() === 't'){
      e.preventDefault();
      goToToday();
    } else if(e.key === ','){
      e.preventDefault();
      document.getElementById('settingsToggle').click();
    } else if(e.key === 'Escape'){
      var panelIds = ['templatesPanel','settingsPanel','summaryPanel'];
      var toggleIds = ['templatesToggle','settingsToggle','summaryToggle'];
      var closedSomething = false;
      panelIds.forEach(function(id, i){
        var p = document.getElementById(id);
        if(p && p.style.display !== 'none'){
          p.style.display = 'none';
          var t = document.getElementById(toggleIds[i]);
          if(t) t.classList.remove('toggle-active');
          closedSomething = true;
        }
      });
      var menu = document.getElementById('moreMenu');
      if(menu && menu.style.display !== 'none'){
        menu.style.display = 'none';
        closedSomething = true;
      }
      if(closedSomething) e.preventDefault();
    } else if(e.key === 'ArrowLeft'){
      e.preventDefault();
      if(activeIndex > 0){
        activeIndex--;
        renderTabs();
        loadDay();
      }
    } else if(e.key === 'ArrowRight'){
      e.preventDefault();
      if(activeIndex < DATES.length - 1){
        activeIndex++;
        renderTabs();
        loadDay();
      }
    }
  });

  var templatesToggle = document.getElementById('templatesToggle');
  var templatesPanel = document.getElementById('templatesPanel');

  templatesToggle.addEventListener('click', function(){
    var open = templatesPanel.style.display !== 'none';
    templatesPanel.style.display = open ? 'none' : 'block';
    templatesToggle.classList.toggle('toggle-active', !open);
    if(!open){
      settingsPanelRef().style.display = 'none';
      document.getElementById('summaryPanel').style.display = 'none';
      document.getElementById('summaryToggle').classList.remove('toggle-active');
      document.getElementById('settingsToggle').classList.remove('toggle-active');
    }
  });

  function settingsPanelRef(){ return document.getElementById('settingsPanel'); }

  // ---------- recurring blocks ----------
  var recurTemplateSelect = document.getElementById('recurTemplateSelect');
  var recurWeekdayPicker = document.getElementById('recurWeekdayPicker');
  var addRecurBtn = document.getElementById('addRecurBtn');
  var recurList = document.getElementById('recurList');

  var WEEKDAY_LABELS = ['S','M','T','W','T','F','S']; // index matches Date.getDay(): 0=Sun..6=Sat
  var selectedWeekdays = [1,2,3,4,5]; // default Mon-Fri

  function renderWeekdayPicker(){
    recurWeekdayPicker.innerHTML = '';
    WEEKDAY_LABELS.forEach(function(label, i){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'weekday-btn' + (selectedWeekdays.indexOf(i) !== -1 ? ' on' : '');
      btn.textContent = label;
      btn.addEventListener('click', function(){
        var idx = selectedWeekdays.indexOf(i);
        if(idx !== -1){ selectedWeekdays.splice(idx,1); } else { selectedWeekdays.push(i); }
        renderWeekdayPicker();
      });
      recurWeekdayPicker.appendChild(btn);
    });
  }

  function weekdayNamesFor(days){
    return days.slice().sort().map(function(i){ return WEEKDAY_LABELS[i]; }).join(' ');
  }

  function renderRecurTemplateSelect(){
    var names = Object.keys(templates);
    recurTemplateSelect.innerHTML = '';
    if(names.length === 0){
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No templates saved yet';
      recurTemplateSelect.appendChild(opt);
      return;
    }
    names.forEach(function(name){
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      recurTemplateSelect.appendChild(opt);
    });
  }

  function renderRecurList(){
    recurList.innerHTML = '';
    if(recurringRules.length === 0){
      var empty = document.createElement('p');
      empty.className = 'sub';
      empty.style.margin = '4px 0';
      empty.textContent = 'No repeating templates yet.';
      recurList.appendChild(empty);
      return;
    }
    recurringRules.forEach(function(r){
      var row = document.createElement('div');
      row.className = 'recur-row';
      var info = document.createElement('span');
      info.className = 'recur-info';
      info.textContent = r.templateName;
      var days = document.createElement('span');
      days.className = 'recur-days';
      days.textContent = weekdayNamesFor(r.weekdays);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Remove';
      del.addEventListener('click', function(){
        if(!recurringReady()) return;
        recurringRules = recurringRules.filter(function(x){ return x.id !== r.id; });
        saveRecurringRules().then(renderRecurList);
      });
      row.appendChild(info);
      row.appendChild(days);
      row.appendChild(del);
      recurList.appendChild(row);
    });
  }

  addRecurBtn.addEventListener('click', function(){
    if(!recurringReady()) return;
    var name = recurTemplateSelect.value;
    if(!name){
      setTemplateStatus('Save a template first, then come back here');
      return;
    }
    if(selectedWeekdays.length === 0) return;
    recurringRules.push({
      id: uid(),
      templateName: name,
      weekdays: selectedWeekdays.slice()
    });
    saveRecurringRules().then(function(){
      renderRecurList();
    });
  });

  // Recurring lives in Settings → Recurring; refreshed each time Settings opens (templates may have changed)
  function showRecurring(){
    renderWeekdayPicker();
    renderRecurTemplateSelect();
    renderRecurList();
  }

  // ---------- settings ----------
  var DEFAULT_SETTINGS = { bg:'#f6f4ee', accent:'#3a5a49', font:'serif', theme:'original', showProgress:true, showMiniTimeline:true, dark:false, quickAdd:false, showConsistency:true, showNightSky:true, goodDay:0.5, followSun:false, remindMinutes:5 };
  // Ready-made looks. Picking one fills in the colour settings below (the font stays
  // whatever you chose); the rest of each look is CSS in styles.css, switched on by <body data-theme="...">.
  var THEMES = {
    original:  { bg:'#f6f4ee', accent:'#3a5a49', dark:false },
    daybreak:  { bg:'#f3f5fa', accent:'#2c4a7c', dark:false },
    twilight:  { bg:'#efeaf2', accent:'#6a4f96', dark:false },
    deepspace: { bg:'#121a2e', accent:'#f2d27a', dark:true  },
    nebula:    { bg:'#1a1428', accent:'#c99ae8', dark:true  }
  };
  // "Darken at sunset" pairs each light theme with a dark one (and back again for the toggle)
  var NIGHT_THEME = { original:'deepspace', daybreak:'deepspace', twilight:'nebula' };
  var DAY_THEME = { deepspace:'daybreak', nebula:'twilight' };
  var FONTS = {
    serif:   "Georgia, 'Iowan Old Style', serif",
    sans:    "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    modern:  "'DM Sans', -apple-system, 'Segoe UI', sans-serif",
    rounded: "Nunito, 'Trebuchet MS', sans-serif",
    sturdy:  "'Trebuchet MS', Verdana, sans-serif",
    big:     "Verdana, Geneva, sans-serif"
  };
  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var settingsToggle = document.getElementById('settingsToggle');
  var settingsPanel = document.getElementById('settingsPanel');
  var bgColorInput = document.getElementById('bgColorInput');
  var accentColorInput = document.getElementById('accentColorInput');
  var fontSelect = document.getElementById('fontSelect');
  var themeSelect = document.getElementById('themeSelect');
  var resetAppearanceBtn = document.getElementById('resetAppearanceBtn');
  var darkModeBtn = document.getElementById('darkModeBtn');
  var showProgressToggle = document.getElementById('showProgressToggle');
  var showMiniTimelineToggle = document.getElementById('showMiniTimelineToggle');
  var quickAddToggle = document.getElementById('quickAddToggle');
  var showConsistencyToggle = document.getElementById('showConsistencyToggle');
  var showNightSkyToggle = document.getElementById('showNightSkyToggle');
  var goodDaySelect = document.getElementById('goodDaySelect');
  var followSunToggle = document.getElementById('followSunToggle');

  // ---------- day and night colours ----------
  // The Original look's light and dark colours. Dark mode uses the dark set;
  // "Darken at sunset" switches to it at sunset (gliding over 5 seconds) and back at sunrise.
  var LIGHT = { '--ink':'#1f2a24', '--ink-soft':'#5b6b60', '--line':'#d9d4c6', '--line-strong':'#b9b2a0', '--surface':'#ffffff', '--surface-alt':'#fbfaf6' };
  var DARK  = { '--ink':'#eceae4', '--ink-soft':'#a9a89f', '--line':'#3a3d38', '--line-strong':'#54574f', '--surface':'#2a2d28', '--surface-alt':'#262924' };

  // Today's sunrise and sunset, in minutes after local midnight (NOAA's sun formula).
  // The city comes from the device's time zone, so no location permission is needed.
  // shortcut: Australian capitals and Auckland only; elsewhere gets an even ~6am-6pm sun (equator at
  // the clock's own longitude). Add zones if overseas people join.
  var SUN_CITIES = {
    'Australia/Sydney': [-33.87, 151.21], 'Australia/Melbourne': [-37.81, 144.96], 'Australia/Brisbane': [-27.47, 153.03],
    'Australia/Adelaide': [-34.93, 138.60], 'Australia/Perth': [-31.95, 115.86], 'Australia/Hobart': [-42.88, 147.33],
    'Australia/Darwin': [-12.46, 130.84], 'Pacific/Auckland': [-36.85, 174.76]
  };
  var sunCity = SUN_CITIES[Intl.DateTimeFormat().resolvedOptions().timeZone] || [0, -new Date().getTimezoneOffset() / 4];
  function sunTimes(date){
    var LAT = sunCity[0], LNG = sunCity[1], rad = Math.PI / 180;
    var dayOfYear = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(date.getFullYear(), 0, 0)) / 86400000);
    var g = 2 * Math.PI / 365 * (dayOfYear - 1);
    var eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(LAT * rad) * Math.cos(decl)) - Math.tan(LAT * rad) * Math.tan(decl)) / rad;
    var tz = -date.getTimezoneOffset(); // the device's minutes ahead of UTC, daylight saving included
    return { rise: 720 - 4 * (LNG + ha) - eqTime + tz, set: 720 - 4 * (LNG - ha) - eqTime + tz };
  }

  function isNight(now){
    var sun = sunTimes(now), m = now.getHours() * 60 + now.getMinutes();
    return m < sun.rise || m >= sun.set;
  }

  var wasNight = null, sunSwitchTimer = null;
  function applyColours(){
    var root = document.documentElement.style;
    var night = settings.followSun ? isNight(new Date()) : !!settings.dark;
    var switched = settings.followSun && wasNight !== null && night !== wasNight;
    if(switched){
      // the sun has just set or risen while the planner is open: glide over 5 seconds
      document.body.classList.add('sun-switch');
      clearTimeout(sunSwitchTimer);
      sunSwitchTimer = setTimeout(function(){ document.body.classList.remove('sun-switch'); }, 5500);
    }
    wasNight = night;
    var colours = night ? DARK : LIGHT;
    Object.keys(colours).forEach(function(k){ root.setProperty(k, colours[k]); });
    // after sunset, a light theme hands over to its dark partner
    var nightTheme = settings.followSun && night && NIGHT_THEME[settings.theme];
    document.body.dataset.theme = nightTheme || settings.theme;
    var accent = nightTheme ? THEMES[nightTheme].accent : settings.accent;
    root.setProperty('--paper', nightTheme ? THEMES[nightTheme].bg : settings.bg);
    root.setProperty('--accent', accent);
    root.setProperty('--accent-soft', accent + '22');
  }
  // check every minute whether the sun has set or risen while the planner stays open
  setInterval(function(){ if(settings.followSun) applyColours(); }, 60000);

  function applySettings(){
    applyColours();
    followSunToggle.checked = !!settings.followSun;
    document.documentElement.style.setProperty('--font-body', FONTS[settings.font] || FONTS.serif);
    themeSelect.value = settings.theme;
    bgColorInput.value = settings.bg;
    accentColorInput.value = settings.accent;
    fontSelect.value = settings.font;
    showProgressToggle.checked = settings.showProgress;
    showMiniTimelineToggle.checked = settings.showMiniTimeline;
    document.querySelector('.day-progress').style.display = settings.showProgress ? 'flex' : 'none';
    document.getElementById('miniTimeline').style.display = settings.showMiniTimeline ? 'block' : 'none';
    darkModeBtn.classList.toggle('toggle-active', !!settings.dark);
    darkModeBtn.textContent = settings.dark ? 'Light mode' : 'Dark mode';
    quickAddToggle.checked = !!settings.quickAdd;
    showConsistencyToggle.checked = !!settings.showConsistency;
    document.getElementById('consistencyBlock').style.display = settings.showConsistency ? 'block' : 'none';
    showNightSkyToggle.checked = !!settings.showNightSky;
    goodDaySelect.value = String(settings.goodDay);
    document.getElementById('remindMinutesSelect').value = String(settings.remindMinutes);
    document.getElementById('nightSkyBlock').style.display = settings.showNightSky ? 'block' : 'none';
    if(settings.showConsistency || settings.showNightSky){ // both are drawn from the same day-by-day history
      if(!consLoaded){ loadConsistencyCache(); } else { renderConsistency(); }
    }
    document.getElementById('quickAddRow').style.display = settings.quickAdd ? 'flex' : 'none';
  }

  function saveSettings(){
    window.storage.set('settings', JSON.stringify(settings)).catch(function(){});
  }

  function loadSettings(){
    window.storage.get('settings').then(function(res){
      if(res && res.value){
        try{ settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(res.value)); }catch(e){}
        // the old numbered themes are gone; anyone still on one goes back to Original
        if(!THEMES[settings.theme]) Object.assign(settings, THEMES.original, { theme: 'original' });
        // so is the old green-black Dark mode; it becomes Deep Space
        if(settings.theme === 'original' && settings.dark) Object.assign(settings, THEMES.deepspace, { theme: 'deepspace' });
      }
      applySettings();
      settingsLoaded = true; // really read (or really nothing saved yet), not a failed read
      maybeTour();
    }).catch(function(){
      applySettings();
    }).then(function(){
      splashReady('settings');
    });
  }

  bgColorInput.addEventListener('input', function(e){
    settings.bg = e.target.value;
    applySettings();
    saveSettings();
  });
  accentColorInput.addEventListener('input', function(e){
    settings.accent = e.target.value;
    applySettings();
    saveSettings();
  });
  fontSelect.addEventListener('change', function(e){
    settings.font = e.target.value;
    applySettings();
    saveSettings();
  });
  themeSelect.addEventListener('change', function(e){
    Object.assign(settings, THEMES[e.target.value], { theme: e.target.value });
    if(THEMES[e.target.value].dark) settings.followSun = false; // a dark theme has nothing to darken
    applySettings();
    saveSettings();
  });
  resetAppearanceBtn.addEventListener('click', function(){
    settings = Object.assign({}, DEFAULT_SETTINGS);
    applySettings();
    saveSettings();
  });

  darkModeBtn.addEventListener('click', function(){
    // swap to the current theme's dark (or light) partner
    var next = (settings.dark ? DAY_THEME : NIGHT_THEME)[settings.theme] || 'original';
    Object.assign(settings, THEMES[next], { theme: next });
    settings.followSun = false; // choosing dark or light by hand switches off the sunset fade
    applySettings();
    saveSettings();
  });

  followSunToggle.addEventListener('change', function(e){
    // the switch goes from a light theme to its dark partner, so a dark theme swaps to its light one
    var day = DAY_THEME[settings.theme] || settings.theme;
    if(e.target.checked) Object.assign(settings, THEMES[day], { theme: day }); // also undoes the Dark mode button
    settings.followSun = e.target.checked;
    applySettings();
    saveSettings();
  });

  showNightSkyToggle.addEventListener('change', function(e){
    settings.showNightSky = e.target.checked;
    applySettings();
    saveSettings();
  });

  goodDaySelect.addEventListener('change', function(e){
    settings.goodDay = parseFloat(e.target.value);
    applySettings();
    saveSettings();
  });

  // how early reminders come; saved with the settings, so every device (and the sender) uses it
  var remindMinutesSelect = document.getElementById('remindMinutesSelect');
  remindMinutesSelect.addEventListener('change', function(e){
    settings.remindMinutes = parseInt(e.target.value, 10);
    applySettings();
    saveSettings();
    if(remindersOn) showReminders(true);
  });

  showConsistencyToggle.addEventListener('change', function(e){
    settings.showConsistency = e.target.checked;
    applySettings();
    saveSettings();
  });

  quickAddToggle.addEventListener('change', function(e){
    settings.quickAdd = e.target.checked;
    applySettings();
    saveSettings();
  });

  // ---------- reminders (push notifications) ----------
  // Turning reminders on gives this device a "reminder address" (a push
  // subscription) and saves it as pushsub:<id>. Supabase reads those and
  // sends "starts in 5 minutes", even when the planner is closed.
  // Safe to be public; its secret partner lives only in Supabase.
  var VAPID_PUBLIC_KEY = 'BKmSxA_KM7us5n5hMKCGJ4uBhWc48VQNcII6_m82ZR6DS2LonguENn-wh28GT3LVxSpgpIbbVE5nTOaU8qr2KKM';
  var remindersBtn = document.getElementById('remindersBtn');
  var remindersStatus = document.getElementById('remindersStatus');
  var pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var remindersOn = false;

  function showReminders(on, note){
    remindersOn = on;
    remindersBtn.textContent = on ? 'Turn off reminders' : 'Turn on reminders';
    remindersStatus.textContent = note || (on ? 'On for this device, ' + settings.remindMinutes + ' minutes before each block' : '');
  }
  // The same device always gets the same key, so turning on twice doesn't save it twice.
  function pushKey(sub){
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint)).then(function(h){
      return 'pushsub:' + Array.from(new Uint8Array(h).slice(0, 8)).map(function(b){ return b.toString(16).padStart(2, '0'); }).join('');
    });
  }
  function keyBytes(b64){
    var s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, function(c){ return c.charCodeAt(0); });
  }
  function currentSub(){
    return navigator.serviceWorker.register('sw.js').then(function(reg){ return reg.pushManager.getSubscription(); });
  }

  // the helper also keeps the app's files fresh, so start it for everyone
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function(){});
  if(pushOk && Notification.permission === 'granted'){
    currentSub().then(function(sub){ showReminders(!!sub); }).catch(function(){});
  }

  remindersBtn.addEventListener('click', function(){
    if(!pushOk){
      showReminders(false, 'On iPhone, open the planner from your Home Screen, then turn reminders on there.');
      return;
    }
    remindersBtn.disabled = true;
    var job;
    if(remindersOn){
      // Forget the address first, so Supabase stops sending, then switch it off.
      job = currentSub().then(function(sub){
        if(!sub) return;
        return pushKey(sub).then(function(k){ return window.storage.delete(k); }).then(function(){ return sub.unsubscribe(); });
      }).then(function(){ showReminders(false); });
    } else {
      // Asking must happen straight away on the tap, or iPhone won't show the question.
      job = Notification.requestPermission().then(function(answer){
        if(answer !== 'granted') throw new Error('Notifications are blocked. Allow them for the planner in your phone’s Settings, then try again.');
        return navigator.serviceWorker.register('sw.js');
      }).then(function(){
        return navigator.serviceWorker.ready;
      }).then(function(reg){
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
      }).then(function(sub){
        var value = JSON.stringify({ sub: sub.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, minutes: 5 });
        return pushKey(sub).then(function(k){ return window.storage.set(k, value); });
      }).then(function(){ showReminders(true); });
    }
    job.catch(function(err){
      showReminders(remindersOn, (err && err.message) || 'That didn’t work. Please try again.');
    }).then(function(){ remindersBtn.disabled = false; });
  });

  // ---------- quick add (type-to-add) ----------
  function parseQuickAdd(text){
    var remaining = text;
    var time = null;
    var duration = null;

    // match a time like 4pm, 4:30pm, 16:00, 9 am
    var timeMatch = remaining.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if(timeMatch && (timeMatch[3] || timeMatch[2] || parseInt(timeMatch[1],10) <= 23)){
      var hour = parseInt(timeMatch[1], 10);
      var min = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      var ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
      if(ampm === 'pm' && hour < 12) hour += 12;
      if(ampm === 'am' && hour === 12) hour = 0;
      if(hour <= 23 && min <= 59){
        time = String(hour).padStart(2,'0') + ':' + String(min).padStart(2,'0');
        remaining = remaining.slice(0, timeMatch.index) + remaining.slice(timeMatch.index + timeMatch[0].length);
      }
    }

    // match a duration like 90m, 1h, 1h30m, 2 hours, 45 min
    var durMatch = remaining.match(/\b(\d+)\s*h(?:ours?|rs?)?\s*(\d+)?\s*m?(?:in)?\b|\b(\d+)\s*m(?:in(?:utes?)?)?\b/i);
    if(durMatch){
      if(durMatch[1]){
        duration = parseInt(durMatch[1], 10) * 60 + (durMatch[2] ? parseInt(durMatch[2], 10) : 0);
      } else if(durMatch[3]){
        duration = parseInt(durMatch[3], 10);
      }
      remaining = remaining.slice(0, durMatch.index) + remaining.slice(durMatch.index + durMatch[0].length);
    }

    var title = remaining.replace(/\b(at|for)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if(!title) title = text.trim();

    return {
      title: title,
      time: time || (function(){ var d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(Math.round(d.getMinutes()/5)*5 % 60).padStart(2,'0'); })(),
      duration: duration || 30
    };
  }

  var quickAddInput = document.getElementById('quickAddInput');
  var quickAddBtn = document.getElementById('quickAddBtn');

  function submitQuickAdd(){
    var text = quickAddInput.value.trim();
    if(!text) return;
    var parsed = parseQuickAdd(text);
    blocks.push({
      id: uid(),
      time: parsed.time,
      title: parsed.title,
      notes: '',
      tags: [],
      done: false,
      duration: parsed.duration
    });
    sortBlocksInPlace();
    saveDay();
    renderDay();
    quickAddInput.value = '';
    quickAddInput.focus();
  }

  quickAddBtn.addEventListener('click', submitQuickAdd);
  quickAddInput.addEventListener('keydown', function(e){
    if(e.key === 'Enter'){
      e.preventDefault();
      submitQuickAdd();
    }
  });

  showProgressToggle.addEventListener('change', function(e){
    settings.showProgress = e.target.checked;
    applySettings();
    saveSettings();
  });
  showMiniTimelineToggle.addEventListener('change', function(e){
    settings.showMiniTimeline = e.target.checked;
    applySettings();
    saveSettings();
  });

  // ---------- export / import ----------
  var exportBtn = document.getElementById('exportBtn');
  var importBtn = document.getElementById('importBtn');
  var importFile = document.getElementById('importFile');
  var importStatus = document.getElementById('importStatus');

  exportBtn.addEventListener('click', function(){
    importStatus.textContent = 'Gathering data…';
    flushSaves().then(function(){
      return Promise.all([window.storage.list('plan:'), window.storage.list('recurapplied:')]);
    }).then(function(lists){
      var res = lists[0];
      var keys = (res && res.keys) ? res.keys : [];
      // safety net: always include the currently visible week's keys too,
      // in case list() misses something or returns partial results
      DATES.forEach(function(d){
        var k = dateKey(d);
        if(keys.indexOf(k) === -1) keys.push(k);
      });
      function readSequentially(ks, idx, acc){
        if(idx >= ks.length) return Promise.resolve(acc);
        return window.storage.get(ks[idx]).then(function(r){
          acc.push({ key: ks[idx], value: r ? r.value : null });
        }).catch(function(){
          acc.push({ key: ks[idx], value: null });
        }).then(function(){
          return readSequentially(ks, idx + 1, acc);
        });
      }
      // also which recurring rules each day already got, so a restore doesn't add them twice
      var appliedKeys = (lists[1] && lists[1].keys) ? lists[1].keys : [];
      return readSequentially(keys.concat(appliedKeys), 0, []);
    }).then(function(dayEntries){
      return Promise.all([
        window.storage.get('categories').catch(function(){ return null; }),
        window.storage.get('templates').catch(function(){ return null; }),
        window.storage.get('settings').catch(function(){ return null; }),
        window.storage.get('consindex').catch(function(){ return null; }),
        window.storage.get('recurring').catch(function(){ return null; })
      ]).then(function(extras){
        var backup = {
          exportedAt: new Date().toISOString(),
          days: {},
          recurapplied: {},
          categories: extras[0] ? extras[0].value : null,
          templates: extras[1] ? extras[1].value : null,
          settings: extras[2] ? extras[2].value : null,
          consindex: extras[3] ? extras[3].value : null,
          recurring: extras[4] ? extras[4].value : null
        };
        dayEntries.forEach(function(e){
          if(!e.value) return;
          if(e.key.indexOf('recurapplied:') === 0) backup.recurapplied[e.key] = e.value;
          else backup.days[e.key] = e.value;
        });
        var dayCount = Object.keys(backup.days).length;
        var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'day-planner-backup-' + localDateStr(new Date()) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        importStatus.textContent = 'Backup downloaded — ' + dayCount + ' day' + (dayCount === 1 ? '' : 's') + ' included';
        // old-day tidying only switches on after a backup exists; it starts at the next visit
        window.storage.set('lastexport', new Date().toISOString()).then(function(){
          setCompactStatus('Backup saved. Old days will be tidied the next time you open the app.');
        }).catch(function(){});
      });
    }).catch(function(err){
      importStatus.textContent = 'Could not export: ' + (err && err.message ? err.message : 'unknown error');
    });
  });

  importBtn.addEventListener('click', function(){
    importFile.click();
  });

  importFile.addEventListener('change', function(e){
    var file = e.target.files[0];
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(evt){
      var data;
      try{ data = JSON.parse(evt.target.result); }catch(err){
        importStatus.textContent = 'Invalid backup file';
        return;
      }
      // the backup is about to replace saved days: drop any edit still waiting to be written
      pendingSaves = {};
      clearTimeout(saveTimer);
      var dayKeys = data.days ? Object.keys(data.days) : [];
      importStatus.textContent = 'Restoring ' + dayKeys.length + ' day' + (dayKeys.length === 1 ? '' : 's') + '…';
      var succeeded = 0, failed = 0;

      function writeSequentially(keys, idx){
        if(idx >= keys.length) return Promise.resolve();
        var k = keys[idx];
        return window.storage.set(k, data.days[k]).then(function(r){
          if(r) succeeded++; else failed++;
        }).catch(function(){
          failed++;
        }).then(function(){
          importStatus.textContent = 'Restoring… ' + (idx + 1) + '/' + keys.length;
          return writeSequentially(keys, idx + 1);
        });
      }

      // which recurring rules each day already got (older backups don't have this)
      var applied = data.recurapplied || {};
      var appliedKeys = Object.keys(applied);
      function writeApplied(idx){
        if(idx >= appliedKeys.length) return Promise.resolve();
        return window.storage.set(appliedKeys[idx], applied[appliedKeys[idx]]).catch(function(){}).then(function(){
          return writeApplied(idx + 1);
        });
      }

      writeSequentially(dayKeys, 0).then(function(){
        return writeApplied(0);
      }).then(function(){
        var extraWrites = [];
        if(data.recurring) extraWrites.push(window.storage.set('recurring', data.recurring).catch(function(){}));
        if(data.categories) extraWrites.push(window.storage.set('categories', data.categories).catch(function(){}));
        if(data.templates) extraWrites.push(window.storage.set('templates', data.templates).catch(function(){}));
        if(data.settings) extraWrites.push(window.storage.set('settings', data.settings).catch(function(){}));
        if(data.consindex){
          extraWrites.push(safeGet('consindex').then(function(r){
            var cur = {}, inc = {};
            try{ cur = (r && r.value) ? (JSON.parse(r.value) || {}) : {}; }catch(e){ cur = {}; }
            try{ inc = JSON.parse(data.consindex) || {}; }catch(e){ inc = {}; }
            Object.keys(inc).forEach(function(k){ if(!(k in cur)) cur[k] = inc[k]; });
            return window.storage.set('consindex', JSON.stringify(cur));
          }).catch(function(){}));
        }
        return Promise.all(extraWrites);
      }).then(function(){
        importStatus.textContent = 'Restored ' + succeeded + '/' + dayKeys.length + ' days — reloading…';
        Promise.all([
          loadCategories(),
          loadSettings(),
          Promise.all([loadRecurringRules(), loadTemplates()]).then(loadDay) // the day needs both, as at start-up
        ]).then(function(){
          refreshConsistency();
          importStatus.textContent = failed > 0
            ? (succeeded + '/' + dayKeys.length + ' days restored, ' + failed + ' failed')
            : 'Restore complete (' + succeeded + ' days)';
        }).catch(function(){
          importStatus.textContent = 'Restore complete (' + succeeded + ' days)';
        });
      });
    };
    reader.readAsText(file);
    importFile.value = '';
  });

  // Settings tabs: show the chosen tab's settings, hide the rest.
  settingsPanel.querySelectorAll('.set-tabs button').forEach(function(tabBtn){
    tabBtn.addEventListener('click', function(){
      settingsPanel.querySelectorAll('.set-tabs button').forEach(function(b){
        b.setAttribute('aria-selected', b === tabBtn ? 'true' : 'false');
      });
      settingsPanel.querySelectorAll('.set-tab').forEach(function(tab){
        tab.hidden = tab.dataset.tab !== tabBtn.dataset.tab;
      });
    });
  });

  document.getElementById('replayTourBtn').addEventListener('click', function(){
    settingsToggle.click(); // close Settings so the tour can point at the page
    window.scrollTo(0, 0);
    startTour();
  });

  settingsToggle.addEventListener('click', function(){
    var open = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = open ? 'none' : 'block';
    settingsToggle.classList.toggle('toggle-active', !open);
    if(!open){
      templatesPanel.style.display = 'none';
      templatesToggle.classList.remove('toggle-active');
      var sp = document.getElementById('summaryPanel');
      if(sp) sp.style.display = 'none';
      var st = document.getElementById('summaryToggle');
      if(st) st.classList.remove('toggle-active');
      showRecurring();
    }
  });

  loadSettings();

  // ---------- week summary ----------
  var summaryToggle = document.getElementById('summaryToggle');
  var summaryPanel = document.getElementById('summaryPanel');
  var summaryContent = document.getElementById('summaryContent');
  var summaryLoaded = false;

  function formatMinutes(mins){
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if(h === 0) return m + 'm';
    if(m === 0) return h + 'h';
    return h + 'h ' + m + 'm';
  }

  function buildSummary(){
    var fetches = DATES.map(function(d){
      return window.storage.get(dateKey(d)).then(function(res){
        if(res && res.value){
          try{ return JSON.parse(res.value); }catch(e){ return []; }
        }
        return [];
      }).catch(function(){ return []; });
    });

    Promise.all(fetches).then(function(allDays){
      var totalBlocks = 0, doneBlocks = 0;
      var catMinutes = {}; // name -> minutes
      var dayTotals = allDays.map(function(dayBlocks){
        var segs = {}; // name -> minutes, for this day
        var dayTotal = 0;
        dayBlocks.forEach(function(b){
          totalBlocks++;
          if(b.done) doneBlocks++;
          var dur = b.duration || 30;
          if(b.tags && b.tags.length){
            b.tags.forEach(function(t){
              catMinutes[t] = (catMinutes[t] || 0) + dur;
              segs[t] = (segs[t] || 0) + dur;
            });
          } else {
            catMinutes['Untagged'] = (catMinutes['Untagged'] || 0) + dur;
            segs['Untagged'] = (segs['Untagged'] || 0) + dur;
          }
          dayTotal += dur;
        });
        return { segs: segs, total: dayTotal };
      });

      summaryContent.innerHTML = '';

      // completion
      var pct = totalBlocks > 0 ? Math.round((doneBlocks / totalBlocks) * 100) : 0;
      var compTitle = document.createElement('p');
      compTitle.className = 'summary-row-title';
      compTitle.textContent = doneBlocks + ' of ' + totalBlocks + ' blocks done this week (' + pct + '%)';
      summaryContent.appendChild(compTitle);

      var bar = document.createElement('div');
      bar.className = 'completion-bar';
      var fill = document.createElement('div');
      fill.className = 'completion-fill';
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      summaryContent.appendChild(bar);

      // category totals
      var catTitle = document.createElement('p');
      catTitle.className = 'summary-row-title';
      catTitle.textContent = 'Time by category';
      summaryContent.appendChild(catTitle);

      function colorFor(name){
        var found = TAGS.find(function(t){ return t.name === name; });
        return found ? found.color : '#b9b2a0';
      }

      var sortedCats = Object.keys(catMinutes).sort(function(a,b){ return catMinutes[b] - catMinutes[a]; });
      if(sortedCats.length === 0){
        var none = document.createElement('p');
        none.className = 'summary-row-title';
        none.textContent = 'No blocks logged yet this week.';
        summaryContent.appendChild(none);
      }
      sortedCats.forEach(function(name){
        var row = document.createElement('div');
        row.className = 'cat-total-row';
        var dot = document.createElement('span');
        dot.className = 'cat-dot';
        dot.style.background = colorFor(name);
        var label = document.createElement('span');
        label.className = 'cat-total-name';
        label.textContent = name;
        var val = document.createElement('span');
        val.textContent = formatMinutes(catMinutes[name]);
        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(val);
        summaryContent.appendChild(row);
      });

      // per-day mini bars
      var maxTotal = Math.max.apply(null, dayTotals.map(function(d){ return d.total; }).concat([1]));
      var weekBars = document.createElement('div');
      weekBars.className = 'week-bars';
      dayTotals.forEach(function(d){
        var col = document.createElement('div');
        col.className = 'week-bar-col';
        col.style.height = (maxTotal > 0 ? Math.max(4, (d.total / maxTotal) * 100) : 4) + '%';
        var segNames = Object.keys(d.segs);
        segNames.forEach(function(name){
          var seg = document.createElement('div');
          seg.className = 'week-bar-seg';
          seg.style.background = colorFor(name);
          seg.style.height = ((d.segs[name] / d.total) * 100) + '%';
          col.appendChild(seg);
        });
        weekBars.appendChild(col);
      });
      summaryContent.appendChild(weekBars);

      var labels = document.createElement('div');
      labels.className = 'week-bar-labels';
      DATES.forEach(function(d){
        var lbl = document.createElement('span');
        lbl.textContent = d.toLocaleDateString(undefined, {weekday:'narrow'});
        labels.appendChild(lbl);
      });
      summaryContent.appendChild(labels);

    });
  }

  // ---------- consistency grid (last 12 weeks, completion rate) ----------
  function consLevelOpacity(pct){
    if(pct <= 0) return 0.18;
    if(pct <= 33) return 0.4;
    if(pct <= 66) return 0.65;
    if(pct < 100) return 0.85;
    return 1;
  }

  // Old days are stored as a tiny summary ('consindex': date -> [done, total]),
  // so the grid needs one read for them plus the handful of recent full days.
  function loadConsistencyCache(){
    consLoaded = true; // prevents duplicate loads while this one runs
    consLoading = true;
    consLoadError = '';
    renderConsistency();

    consLoadPromise = safeGet('consindex').then(function(res){
      var index = {};
      if(res && res.value){
        try{ index = JSON.parse(res.value) || {}; }catch(e){ index = {}; }
      }
      Object.keys(index).forEach(function(ds){
        var v = index[ds];
        if(v && v.length === 2) consCache['plan:' + ds] = { done: v[0], total: v[1] };
      });
      renderConsistency(); // the summarised history is already enough to draw most of the grid
      // Supabase storage can read every day in one request; otherwise read them one by one below
      if(window.storage.getAll) return window.storage.getAll('plan:').then(function(all){
        Object.keys(all).forEach(function(k){
          if(consCache[k]) return;
          try{
            var arr = JSON.parse(all[k]);
            consCache[k] = { total: arr.length, done: arr.filter(function(b){ return b.done; }).length };
          }catch(e){}
        });
        return { keys: [] }; // nothing left to read one by one
      });
      return window.storage.list('plan:');
    }).then(function(res){
      // only days still stored in full and not already covered by the summary; every year,
      // not just this one, because the night sky counts all the good days you've ever had
      var keys = ((res && res.keys) ? res.keys : []).filter(function(k){ return !consCache[k]; });

      function readNext(i){
        if(i >= keys.length) return Promise.resolve();
        return window.storage.get(keys[i]).then(function(r){
          if(r && r.value){
            try{
              var arr = JSON.parse(r.value);
              consCache[keys[i]] = { total: arr.length, done: arr.filter(function(b){ return b.done; }).length };
            }catch(e){}
          }
        }).catch(function(){}).then(function(){
          if((i + 1) % 30 === 0) renderConsistency(); // show progress while old days are still unsummarised
          return readNext(i + 1);
        });
      }
      return readNext(0);
    }).then(function(){
      consLoading = false;
      renderConsistency();
    }).catch(function(e){
      consLoading = false;
      consLoaded = false; // so toggling the grid off and on tries again
      consLoadError = (e && e.message) ? e.message : 'unknown error';
      renderConsistency();
    });
    return consLoadPromise;
  }

  // ---------- tidying old days ----------
  // Days older than 14 days are reduced to [done, total] in 'consindex' and the
  // full day is deleted. Only runs once the user has exported a backup. Each
  // batch is written to the summary BEFORE its days are deleted, and re-running
  // is harmless (a day's entry is replaced, never added to).
  var KEEP_DETAIL_DAYS = 14;

  function setCompactStatus(text){
    var el = document.getElementById('compactStatus');
    if(el) el.textContent = text;
  }

  function refreshCompactStatus(){
    return Promise.all([safeGet('lastexport'), safeGet('consindex')]).then(function(r){
      var on = !!(r[0] && r[0].value);
      var n = 0;
      if(r[1] && r[1].value){
        try{ n = Object.keys(JSON.parse(r[1].value) || {}).length; }catch(e){}
      }
      setCompactStatus(on
        ? 'Old-day tidying is on: days older than ' + KEEP_DETAIL_DAYS + ' days are kept as a summary only.'
            + (n ? ' (' + n + ' earlier days summarised so far.)' : '')
        : 'Old-day tidying is off. Export a backup, then reopen the app to switch it on.');
    });
  }

  function maybeCompactOldDays(){
    if(compactionRunning) return Promise.resolve();
    compactionRunning = true;

    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - KEEP_DETAIL_DAYS);
    var cutoffStr = localDateStr(cutoff);
    var tidied = 0;
    var totalOld = 0;

    return safeGet('lastexport').then(function(res){
      if(!(res && res.value)) return; // no backup yet: do nothing

      return (consLoadPromise || Promise.resolve()).then(function(){
        return window.storage.list('plan:');
      }).then(function(listRes){
        var old = ((listRes && listRes.keys) ? listRes.keys : []).filter(function(k){
          return /^plan:\d{4}-\d{2}-\d{2}$/.test(k) && k.slice(5) < cutoffStr;
        });
        totalOld = old.length;
        if(!old.length) return;
        setCompactStatus('Tidying old days\u2026 0 of ' + totalOld);

        return safeGet('consindex').then(function(r){
          var index = {};
          if(r && r.value){
            try{ index = JSON.parse(r.value) || {}; }catch(e){ index = {}; }
          }

          function deleteSeq(keys, i){
            if(i >= keys.length) return Promise.resolve();
            return window.storage.delete(keys[i]).catch(function(){}).then(function(){
              tidied++;
              setCompactStatus('Tidying old days\u2026 ' + tidied + ' of ' + totalOld);
              return deleteSeq(keys, i + 1);
            });
          }

          function processChunk(start){
            if(start >= old.length) return Promise.resolve();
            var keys = old.slice(start, start + 25);
            var counted = [];

            function countNext(i){
              if(i >= keys.length) return Promise.resolve();
              var k = keys[i];
              var cached = consCache[k];
              if(cached){
                index[k.slice(5)] = [cached.done, cached.total];
                counted.push(k);
                return countNext(i + 1);
              }
              return window.storage.get(k).then(function(rr){
                if(!rr || !rr.value) return;
                var arr = JSON.parse(rr.value);
                if(!Array.isArray(arr)) return;
                index[k.slice(5)] = [arr.filter(function(b){ return b.done; }).length, arr.length];
                counted.push(k);
              }).catch(function(){ /* unreadable day: leave it alone */ }).then(function(){
                return countNext(i + 1);
              });
            }

            return countNext(0).then(function(){
              if(!counted.length) return;
              // summary first; only delete if it was really saved
              return window.storage.set('consindex', JSON.stringify(index)).then(function(ok){
                if(!ok) throw new Error('summary not saved');
                return deleteSeq(counted, 0);
              });
            }).then(function(){ return processChunk(start + 25); });
          }

          return processChunk(0);
        });
      });
    }).then(function(){
      compactionRunning = false;
      if(tidied > 0) setStatus('Tidied ' + tidied + ' old day' + (tidied === 1 ? '' : 's'));
      return refreshCompactStatus();
    }).catch(function(e){
      compactionRunning = false; // anything unsummarised simply stays as it was
      return refreshCompactStatus().then(function(){
        var el = document.getElementById('compactStatus');
        if(el) el.textContent += ' (Last tidy attempt stopped early: ' + ((e && e.message) ? e.message : 'unknown error') + '.)';
      });
    });
  }

  // re-read everything (used after bulk changes like import or copy-to-day)
  function refreshConsistency(){
    consCache = {};
    consLoaded = false;
    if(settings.showConsistency || settings.showNightSky) loadConsistencyCache();
  }

  // every day of the current calendar year, Jan 1 to Dec 31
  function consCells(){
    var y = new Date().getFullYear();
    var cells = [];
    for(var d = new Date(y, 0, 1); d.getFullYear() === y; d.setDate(d.getDate() + 1)){
      cells.push(new Date(d));
    }
    return cells;
  }

  // A day counts toward the streak when enough of what was planned got done
  // (half by default; "A good day is" in Settings can raise it).
  // Today can't break a streak until it's over (it only adds to it once you're past half).
  function dayNum(ds){
    var p = ds.split('-');
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }

  function computeStreaks(){
    var ok = {};
    Object.keys(consCache).forEach(function(k){
      var v = consCache[k];
      if(v && v.total > 0 && v.done / v.total >= settings.goodDay) ok[dayNum(k.slice(5))] = true;
    });

    var nums = Object.keys(ok).map(Number).sort(function(a, b){ return a - b; });
    var best = 0, run = 0, prev = null;
    nums.forEach(function(n){
      run = (prev !== null && n === prev + 1) ? run + 1 : 1;
      if(run > best) best = run;
      prev = n;
    });

    var cursor = dayNum(localDateStr(new Date()));
    if(!ok[cursor]) cursor--;
    var current = 0;
    while(ok[cursor]){ current++; cursor--; }
    return { current: current, best: best };
  }

  // ---------- night sky ----------
  // Every good day lights one star. Constellations fill in order, smallest
  // first; a finished one moves to its own spot in the sky. Nothing is saved:
  // the sky is worked out from the same history as the consistency grid, so it
  // can't drift out of step between devices.
  // It counts every good day ever (a lifetime sky), so nothing earned is taken away.

  // Star positions are 0–100 inside each constellation's box, listed in the
  // order they light up; the third number is brightness. Lines join two stars.
  var CONSTELLATIONS = [
    { name:'Southern Cross',
      stars:[[55,92,1],[20,45,.9],[50,8,.85],[82,38,.7],[66,62,.5]],
      lines:[[0,2],[1,3]] },
    { name:'Orion',
      stars:[[25,20,1],[75,85,1],[70,25,.8],[32,88,.7],[50,50,.8],[40,52,.75],[60,47,.7],[48,6,.5]],
      lines:[[7,0],[7,2],[0,5],[2,6],[5,4],[4,6],[5,3],[6,1]] },
    { name:'Canis Major',
      stars:[[45,25,1],[25,15,.7],[50,45,.5],[55,62,.8],[45,85,.85],[75,75,.6],[30,72,.5]],
      lines:[[1,0],[0,2],[2,3],[3,4],[3,5],[4,6]] },
    { name:'Leo',
      stars:[[70,75,1],[65,55,.6],[55,40,.8],[60,25,.5],[72,15,.5],[82,22,.6],[30,45,.6],[10,60,.8],[30,62,.5]],
      lines:[[0,1],[1,2],[2,3],[3,4],[4,5],[2,6],[6,7],[7,8],[8,0]] },
    { name:'Scorpius',
      stars:[[15,10,.7],[12,22,.8],[14,35,.6],[30,30,.6],[38,38,1],[45,47,.6],[50,58,.7],[52,70,.6],[55,80,.6],[65,88,.6],[78,90,.7],[88,82,.6],[90,70,.6],[84,62,.9],[80,58,.6]],
      lines:[[0,1],[1,2],[1,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,13],[13,14]] },
    // The other 83 official constellations, smallest first, drawn from real star positions
    // (d3-celestial data, Copyright (c) 2015 Olaf Frohn, BSD 3-clause licence).
    { name:'Canis Minor', stars:[[9,92,1],[91,8,0.7]], lines:[[0,1]] },
    { name:'Canes Venatici', stars:[[92,20,0.54],[8,80,0.45]], lines:[[0,1]] },
    { name:'Octans', stars:[[27,8,0.6],[18,38,0.55],[82,92,0.53]], lines:[[1,2],[0,1],[0,2]] },
    { name:'Triangulum Australe', stars:[[8,81,0.82],[59,19,0.71],[92,77,0.71]], lines:[[0,1],[1,2],[0,2]] },
    { name:'Circinus', stars:[[81,92,0.67],[29,8,0.56],[19,15,0.51]], lines:[[0,1],[0,2]] },
    { name:'Pictor', stars:[[20,92,0.66],[74,46,0.51],[80,8,0.59]], lines:[[0,1],[1,2]] },
    { name:'Telescopium', stars:[[16,8,0.63],[10,92,0.56],[90,8,0.51]], lines:[[0,2],[0,1]] },
    { name:'Antlia', stars:[[35,35,0.54],[92,61,0.51],[8,65,0.5]], lines:[[0,1],[0,2]] },
    { name:'Fornax', stars:[[8,41,0.59],[37,59,0.52],[92,43,0.49]], lines:[[0,1],[1,2]] },
    { name:'Equuleus', stars:[[38,92,0.58],[44,10,0.51],[62,8,0.49]], lines:[[0,1],[1,2]] },
    { name:'Coma Berenices', stars:[[12,12,0.54],[13,92,0.53],[88,8,0.53]], lines:[[0,1],[0,2]] },
    { name:'Triangulum', stars:[[35,8,0.69],[90,92,0.64],[10,25,0.57]], lines:[[0,1],[0,2],[1,2]] },
    { name:'Apus', stars:[[92,65,0.59],[27,51,0.49],[8,35,0.54],[18,54,0.59]], lines:[[0,1],[1,2],[2,3]] },
    { name:'Mensa', stars:[[9,70,0.45],[52,92,0.45],[91,70,0.45],[89,8,0.45]], lines:[[0,1],[1,2],[2,3]] },
    { name:'Reticulum', stars:[[28,56,0.65],[78,92,0.59],[22,8,0.52],[56,39,0.5]], lines:[[0,2],[2,3],[1,3],[0,1]] },
    { name:'Norma', stars:[[38,92,0.57],[16,49,0.51],[84,77,0.49],[76,8,0.48]], lines:[[1,3],[0,1],[0,2],[2,3]] },
    { name:'Caelum', stars:[[64,64,0.52],[79,92,0.45],[62,22,0.45],[21,8,0.5]], lines:[[0,1],[0,2],[2,3]] },
    { name:'Pyxis', stars:[[82,92,0.78],[34,59,0.57],[29,45,0.61],[18,8,0.57]], lines:[[0,1],[1,2],[2,3]] },
    { name:'Sculptor', stars:[[8,39,0.53],[68,31,0.5],[92,49,0.52],[79,69,0.52]], lines:[[0,1],[1,2],[2,3]] },
    { name:'Scutum', stars:[[57,38,0.59],[31,8,0.54],[69,92,0.49],[42,45,0.49]], lines:[[0,1],[1,3],[2,3],[0,2]] },
    { name:'Sextans', stars:[[58,15,0.51],[92,85,0.45],[10,36,0.45],[8,18,0.45]], lines:[[0,1],[1,2],[2,3]] },
    { name:'Sagitta', stars:[[8,31,0.63],[59,49,0.61],[92,59,0.52],[88,69,0.52]], lines:[[1,2],[0,1],[1,3]] },
    { name:'Aries', stars:[[71,50,0.81],[90,67,0.73],[8,23,0.62],[92,77,0.58]], lines:[[0,2],[0,1],[1,3]] },
    { name:'Chamaeleon', stars:[[92,49,0.56],[41,44,0.56],[11,45,0.46],[8,55,0.54],[37,56,0.45]], lines:[[0,1],[1,4],[3,4],[2,3],[1,2]] },
    { name:'Volans', stars:[[37,31,0.6],[8,38,0.57],[52,50,0.53],[92,69,0.6],[90,48,0.57]], lines:[[0,1],[0,2],[2,4],[3,4],[2,3],[1,2]] },
    { name:'Indus', stars:[[92,12,0.68],[45,53,0.52],[8,68,0.52],[69,88,0.61],[82,44,0.51]], lines:[[0,4],[3,4],[2,3],[1,2],[0,1]] },
    { name:'Microscopium', stars:[[55,8,0.49],[30,8,0.48],[28,69,0.47],[72,19,0.46],[71,92,0.45]], lines:[[3,4],[2,4],[1,2],[0,1],[0,3]] },
    { name:'Columba', stars:[[79,17,0.73],[60,30,0.68],[92,29,0.59],[8,13,0.59],[48,87,0.57]], lines:[[1,3],[0,1],[0,2],[1,4]] },
    { name:'Corvus', stars:[[64,18,0.74],[29,8,0.7],[20,79,0.73],[77,70,0.69],[80,92,0.57]], lines:[[3,4],[0,3],[0,1],[1,2],[2,3]] },
    { name:'Delphinus', stars:[[60,35,0.61],[51,12,0.6],[78,92,0.57],[35,26,0.52],[22,8,0.45]], lines:[[0,2],[0,1],[1,4],[3,4],[0,3]] },
    { name:'Cancer', stars:[[72,92,0.63],[42,54,0.58],[28,81,0.54],[44,40,0.49],[41,8,0.57]], lines:[[1,2],[1,3],[3,4],[0,1]] },
    { name:'Vulpecula', stars:[[73,50,0.52],[38,54,0.5],[28,31,0.49],[8,30,0.51],[92,70,0.48]], lines:[[0,4],[0,1],[1,2],[2,3]] },
    { name:'Leo Minor', stars:[[8,54,0.6],[36,43,0.55],[57,50,0.51],[92,42,0.51],[37,58,0.48]], lines:[[2,4],[0,4],[0,1],[1,2],[2,3]] },
    { name:'Cassiopeia', stars:[[51,48,0.79],[66,76,0.78],[92,55,0.78],[27,51,0.73],[8,24,0.65]], lines:[[3,4],[0,3],[0,1],[1,2]] },
    { name:'Hydrus', stars:[[80,92,0.71],[20,76,0.66],[39,42,0.56],[47,43,0.56],[60,38,0.49],[60,8,0.71]], lines:[[0,1],[1,2],[2,3],[3,4],[4,5]] },
    { name:'Musca', stars:[[31,44,0.73],[20,32,0.69],[8,76,0.62],[37,81,0.59],[53,30,0.56],[92,19,0.61]], lines:[[4,5],[0,4],[0,1],[1,2],[2,3],[0,3]] },
    { name:'Tucana', stars:[[92,47,0.71],[54,30,0.57],[8,60,0.53],[17,68,0.54],[80,70,0.51],[29,70,0.51]], lines:[[0,1],[1,2],[2,3],[3,5],[4,5],[0,4]] },
    { name:'Dorado', stars:[[70,27,0.65],[23,71,0.6],[90,8,0.54],[19,92,0.53],[10,77,0.49],[43,40,0.48]], lines:[[0,2],[0,1],[1,3],[3,4],[1,4],[1,5],[0,5]] },
    { name:'Horologium', stars:[[15,8,0.59],[82,38,0.45],[85,46,0.45],[82,54,0.45],[69,74,0.45],[71,92,0.45]], lines:[[0,1],[1,2],[2,3],[3,4],[4,5]] },
    { name:'Phoenix', stars:[[76,12,0.76],[33,37,0.65],[8,18,0.64],[92,35,0.58],[32,88,0.58],[9,53,0.58]], lines:[[0,1],[1,2],[2,5],[4,5],[1,4],[1,3],[0,3]] },
    { name:'Libra', stars:[[47,8,0.74],[73,36,0.72],[59,73,0.66],[29,31,0.58],[29,85,0.62],[27,92,0.61]], lines:[[1,2],[0,1],[0,3],[3,4],[4,5],[1,3]] },
    { name:'Lyra', stars:[[77,18,1],[59,32,0.53],[46,84,0.63],[23,92,0.66],[35,41,0.54],[59,8,0.5]], lines:[[1,5],[0,5],[0,1],[1,4],[3,4],[2,3],[1,2]] },
    { name:'Ara', stars:[[27,8,0.71],[37,52,0.71],[66,33,0.56],[66,56,0.68],[73,80,0.6],[33,92,0.62],[37,58,0.65]], lines:[[5,6],[4,5],[3,4],[2,3],[0,2],[0,1]] },
    { name:'Corona Borealis', stars:[[75,73,0.78],[92,45,0.61],[55,78,0.59],[79,20,0.55],[37,80,0.5],[17,71,0.55],[8,36,0.45]], lines:[[1,3],[0,1],[0,2],[2,4],[4,5],[5,6]] },
    { name:'Lynx', stars:[[8,90,0.67],[11,83,0.59],[24,70,0.57],[44,67,0.54],[71,47,0.5],[78,18,0.53],[92,10,0.52]], lines:[[5,6],[4,5],[3,4],[2,3],[1,2],[0,1]] },
    { name:'Ursa Minor', stars:[[45,8,0.81],[39,25,0.53],[37,46,0.54],[47,66,0.54],[63,80,0.8],[55,92,0.69],[38,74,0.46]], lines:[[3,6],[5,6],[4,5],[3,4],[2,3],[1,2],[0,1]] },
    { name:'Vela', stars:[[92,54,0.84],[61,36,0.78],[48,26,0.62],[21,33,0.59],[8,60,0.73],[36,72,0.63],[52,73,0.75],[69,74,0.82]], lines:[[6,7],[5,6],[4,5],[3,4],[2,3],[1,2],[0,1]] },
    { name:'Corona Austrina', stars:[[9,21,0.56],[8,39,0.56],[16,11,0.54],[12,53,0.5],[25,72,0.48],[35,11,0.47],[55,89,0.45],[92,77,0.5]], lines:[[2,5],[0,2],[0,1],[1,3],[3,4],[4,6],[6,7]] },
    { name:'Piscis Austrinus', stars:[[8,48,0.91],[28,33,0.55],[11,63,0.55],[65,65,0.51],[39,61,0.54],[92,67,0.53],[15,65,0.51],[90,55,0.45]], lines:[[0,1],[0,2],[2,6],[4,6],[3,4],[3,5],[5,7],[3,7],[1,3]] },
    { name:'Aquila', stars:[[37,31,0.96],[42,23,0.72],[86,8,0.69],[64,56,0.65],[86,92,0.64],[32,42,0.6],[14,74,0.66],[35,66,0.59]], lines:[[0,1],[0,5],[5,6],[6,7],[3,7],[2,3],[0,2],[0,3],[3,4]] },
    { name:'Camelopardalis', stars:[[40,69,0.57],[45,50,0.54],[42,92,0.52],[62,32,0.5],[66,51,0.52],[79,67,0.54],[21,36,0.48],[23,8,0.5]], lines:[[0,2],[0,1],[1,3],[3,4],[4,5],[1,6],[6,7]] },
    { name:'Grus', stars:[[63,59,0.84],[32,59,0.8],[28,83,0.63],[43,41,0.56],[18,92,0.56],[82,8,0.69],[68,19,0.51],[57,28,0.48],[44,40,0.57]], lines:[[2,4],[1,2],[1,3],[0,3],[0,1],[7,8],[6,7],[5,6]] },
    { name:'Crater', stars:[[63,40,0.62],[92,63,0.56],[55,58,0.56],[74,91,0.51],[25,63,0.48],[55,16,0.47],[36,9,0.49],[57,65,0.45],[8,56,0.45]], lines:[[5,6],[0,5],[0,1],[1,3],[3,7],[2,7],[2,4],[4,8],[0,2]] },
    { name:'Monoceros', stars:[[82,71,0.6],[92,69,0.57],[51,52,0.55],[8,59,0.53],[29,79,0.58],[68,43,0.51],[85,37,0.52],[79,29,0.51],[73,21,0.49]], lines:[[3,4],[2,3],[0,2],[0,1],[2,5],[5,6],[6,7],[7,8]] },
    { name:'Cygnus', stars:[[40,36,0.9],[51,53,0.78],[34,72,0.75],[72,37,0.71],[13,82,0.66],[79,15,0.6],[84,8,0.59],[67,70,0.58],[87,92,0.68]], lines:[[2,4],[1,2],[1,3],[3,5],[5,6],[0,1],[1,7],[7,8]] },
    { name:'Auriga', stars:[[56,36,1],[32,38,0.82],[30,63,0.73],[51,92,0.85],[70,76,0.73],[65,43,0.69],[63,51,0.67],[65,51,0.61],[35,8,0.6]], lines:[[0,1],[0,6],[4,6],[3,4],[2,3],[1,2],[1,8],[0,8],[0,5],[5,7]] },
    { name:'Lacerta', stars:[[46,19,0.6],[47,34,0.53],[53,8,0.52],[36,54,0.51],[46,61,0.51],[64,80,0.51],[62,92,0.55],[56,41,0.5],[52,24,0.5]], lines:[[0,2],[0,1],[1,7],[4,7],[3,4],[1,3],[1,8],[2,8],[4,5],[5,6]] },
    { name:'Pavo', stars:[[23,21,0.82],[24,58,0.64],[37,54,0.62],[44,79,0.57],[66,74,0.57],[92,56,0.62],[8,61,0.54],[68,39,0.54],[85,49,0.53],[81,39,0.53]], lines:[[0,1],[1,2],[2,7],[7,9],[8,9],[5,8],[4,5],[3,4],[1,3],[1,6]] },
    { name:'Capricornus', stars:[[8,37,0.71],[15,39,0.61],[28,60,0.6],[59,77,0.56],[64,71,0.55],[31,39,0.54],[46,40,0.56],[92,23,0.53],[88,31,0.68],[80,43,0.48]], lines:[[7,8],[8,9],[4,9],[3,4],[2,3],[0,2],[0,1],[1,5],[5,6],[6,7]] },
    { name:'Cepheus', stars:[[58,71,0.76],[51,41,0.66],[22,8,0.66],[73,71,0.64],[21,55,0.63],[25,86,0.56],[34,88,0.64],[31,92,0.55],[47,86,0.54],[79,64,0.54]], lines:[[3,9],[0,3],[0,8],[7,8],[6,7],[5,6],[4,5],[2,4],[1,2],[0,1],[1,4]] },
    { name:'Puppis', stars:[[23,92,0.84],[26,66,0.78],[20,13,0.71],[28,8,0.55],[34,15,0.65],[42,21,0.59],[35,18,0.52],[38,28,0.58],[45,27,0.49],[56,56,0.72],[80,81,0.67]], lines:[[9,10],[8,9],[5,8],[4,5],[3,4],[2,3],[1,2],[0,1],[4,6],[6,7],[7,8]] },
    { name:'Lepus', stars:[[55,50,0.74],[83,41,0.66],[92,78,0.67],[61,67,0.71],[35,33,0.62],[39,77,0.62],[22,29,0.6],[30,68,0.6],[74,23,0.54],[83,22,0.53],[8,34,0.49]], lines:[[6,10],[4,6],[0,4],[0,1],[1,2],[2,3],[3,5],[5,7],[1,9],[1,8]] },
    { name:'Lupus', stars:[[85,73,0.77],[74,52,0.73],[55,39,0.66],[44,42,0.71],[54,58,0.65],[61,92,0.64],[21,30,0.64],[56,20,0.62],[57,72,0.54],[15,24,0.54],[39,11,0.49],[28,8,0.57]], lines:[[10,11],[7,10],[2,7],[1,2],[0,1],[0,5],[5,8],[4,8],[3,4],[3,6],[6,9],[2,3]] },
    { name:'Taurus', stars:[[47,46,0.95],[8,31,0.69],[51,48,0.64],[57,49,0.61],[68,57,0.64],[55,44,0.6],[51,39,0.63],[17,12,0.85],[90,63,0.6],[92,65,0.62],[67,73,0.58],[85,88,0.54]], lines:[[0,1],[0,2],[2,3],[3,5],[5,6],[6,7],[3,4],[4,8],[8,10],[8,9],[9,11]] },
    { name:'Gemini', stars:[[8,26,0.91],[19,11,0.86],[16,31,0.56],[30,52,0.63],[32,74,0.62],[45,58,0.57],[71,75,0.82],[64,89,0.65],[39,18,0.52],[64,39,0.68],[84,49,0.71],[92,48,0.65]], lines:[[10,11],[9,10],[8,9],[1,8],[0,1],[0,2],[2,3],[3,5],[5,6],[6,7],[3,4]] },
    { name:'Boötes', stars:[[56,79,1],[42,62,0.77],[67,81,0.73],[29,48,0.63],[36,33,0.63],[48,38,0.69],[48,55,0.62],[43,92,0.6],[54,21,0.55],[51,8,0.57],[71,83,0.51],[55,8,0.51]], lines:[[2,10],[0,2],[0,6],[5,6],[4,5],[3,4],[1,3],[0,1],[0,7],[5,8],[8,11],[9,11],[8,9]] },
    { name:'Virgo', stars:[[46,70,0.93],[23,61,0.56],[10,61,0.59],[53,60,0.52],[65,52,0.72],[42,51,0.64],[59,44,0.64],[56,30,0.71],[75,51,0.58],[89,47,0.62],[92,37,0.57],[30,47,0.54],[8,46,0.6]], lines:[[9,10],[8,9],[4,8],[3,4],[0,3],[0,1],[1,2],[6,7],[4,6],[3,5],[5,11],[11,12]] },
    { name:'Cetus', stars:[[78,79,0.81],[47,73,0.63],[92,60,0.62],[65,62,0.63],[57,57,0.62],[43,61,0.6],[30,47,0.45],[20,40,0.56],[18,35,0.63],[8,33,0.75],[9,23,0.48],[17,21,0.54],[25,24,0.53],[22,30,0.47]], lines:[[8,13],[12,13],[11,12],[10,11],[9,10],[8,9],[7,8],[6,7],[5,6],[1,5],[0,1],[0,2],[2,3],[3,4],[4,5]] },
    { name:'Serpens', stars:[[54,79,0.76],[44,79,0.63],[35,70,0.65],[33,67,0.48],[25,58,0.66],[8,46,0.5],[88,43,0.73],[86,46,0.6],[76,59,0.72],[92,36,0.59],[87,29,0.61],[83,28,0.59],[86,24,0.56],[89,21,0.51]], lines:[[10,13],[12,13],[11,12],[10,11],[9,10],[6,9],[6,7],[7,8],[0,1],[1,2],[2,3],[3,4],[4,5]] },
    { name:'Pegasus', stars:[[15,25,0.8],[48,31,0.76],[47,60,0.75],[8,58,0.71],[59,27,0.7],[55,39,0.63],[57,42,0.57],[77,37,0.6],[57,67,0.55],[60,70,0.64],[77,81,0.63],[92,71,0.76],[88,35,0.55],[74,19,0.54]], lines:[[4,13],[1,4],[0,1],[0,3],[2,3],[2,8],[8,9],[9,10],[10,11],[1,2],[1,5],[5,6],[6,7],[7,12]] },
    { name:'Aquarius', stars:[[70,42,0.7],[53,31,0.7],[46,33,0.59],[42,31,0.61],[39,31,0.57],[31,45,0.6],[48,46,0.55],[53,57,0.54],[19,49,0.52],[24,72,0.61],[17,70,0.57],[89,49,0.48],[92,50,0.6],[44,28,0.47],[8,67,0.47]], lines:[[11,12],[0,11],[0,1],[1,2],[2,3],[3,4],[4,5],[5,8],[8,9],[0,7],[1,6],[3,13],[8,10],[8,14]] },
    { name:'Draco', stars:[[16,89,0.78],[26,89,0.72],[20,77,0.6],[10,46,0.68],[8,36,0.59],[24,43,0.54],[36,59,0.67],[47,68,0.72],[25,40,0.62],[55,74,0.57],[65,71,0.66],[80,49,0.61],[85,24,0.59],[92,11,0.59],[26,82,0.47]], lines:[[0,2],[0,1],[1,14],[2,14],[2,3],[3,5],[5,6],[6,7],[7,9],[9,10],[10,11],[11,12],[12,13],[5,8],[3,4]] },
    { name:'Centaurus', stars:[[38,76,0.98],[45,59,0.78],[28,80,0.89],[66,50,0.79],[38,45,0.74],[39,34,0.63],[39,32,0.64],[29,20,0.8],[19,36,0.77],[52,19,0.72],[8,38,0.67],[71,53,0.58],[78,56,0.74],[92,71,0.58],[76,60,0.57],[84,81,0.45]], lines:[[12,13],[11,12],[3,11],[1,3],[1,4],[4,5],[5,6],[6,7],[7,8],[8,10],[6,9],[1,2],[0,1],[11,14],[14,15]] },
    { name:'Ophiuchus', stars:[[36,8,0.8],[32,25,0.72],[48,63,0.76],[64,54,0.75],[54,15,0.67],[43,82,0.66],[73,43,0.66],[75,41,0.72],[30,28,0.6],[25,53,0.65],[67,30,0.59],[66,65,0.54],[41,92,0.54],[68,69,0.54],[69,72,0.51],[68,79,0.5]], lines:[[8,9],[1,8],[0,1],[0,4],[4,10],[7,10],[6,7],[3,6],[2,3],[3,4],[3,11],[11,13],[13,14],[14,15],[1,2],[2,5],[5,12]] },
    { name:'Carina', stars:[[83,53,1],[35,69,0.85],[92,34,0.67],[25,70,0.66],[17,62,0.72],[18,56,0.65],[21,55,0.64],[34,49,0.78],[47,51,0.83],[43,42,0.82],[57,30,0.84],[57,41,0.63],[11,52,0.6],[8,54,0.58],[11,60,0.5],[8,57,0.5],[10,59,0.45]], lines:[[0,2],[0,1],[1,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,11],[10,11],[9,10],[7,9],[4,14],[14,16],[15,16],[13,15],[12,13],[5,12]] },
    { name:'Hercules', stars:[[71,72,0.72],[44,92,0.72],[63,47,0.71],[61,28,0.63],[45,34,0.67],[77,78,0.6],[53,49,0.58],[44,64,0.68],[27,56,0.64],[21,51,0.61],[15,52,0.59],[65,19,0.55],[71,8,0.58],[41,33,0.55],[24,31,0.59],[76,11,0.54],[85,16,0.5]], lines:[[0,5],[0,2],[2,3],[3,11],[11,12],[12,15],[15,16],[2,6],[3,4],[13,14],[4,13],[4,6],[6,7],[7,8],[8,9],[9,10],[0,1]] },
    { name:'Andromeda', stars:[[8,30,0.8],[32,51,0.8],[47,64,0.66],[63,68,0.8],[39,45,0.59],[47,68,0.53],[42,81,0.56],[48,57,0.53],[75,31,0.54],[92,30,0.62],[73,29,0.55],[74,23,0.59],[36,83,0.52],[42,39,0.51],[35,23,0.54],[23,17,0.62],[70,24,0.45]], lines:[[0,1],[1,2],[2,3],[6,12],[5,6],[2,5],[2,7],[7,8],[8,9],[8,10],[10,11],[1,4],[4,13],[13,14],[14,15],[10,16]] },
    { name:'Hydra', stars:[[83,38,0.81],[81,33,0.58],[86,31,0.58],[89,28,0.68],[90,28,0.64],[79,41,0.56],[77,40,0.62],[75,42,0.59],[71,42,0.68],[65,53,0.63],[92,28,0.55],[63,55,0.54],[45,52,0.69],[30,60,0.66],[90,28,0.53],[91,30,0.53],[92,30,0.52],[8,72,0.52]], lines:[[4,14],[14,15],[15,16],[10,16],[4,10],[3,4],[2,3],[1,2],[0,1],[0,5],[5,6],[6,7],[7,8],[8,9],[9,11],[11,12],[12,13],[13,17]] },
    { name:'Ursa Major', stars:[[29,30,0.84],[21,28,0.78],[8,33,0.83],[39,32,0.65],[56,26,0.83],[56,36,0.77],[43,39,0.76],[75,21,0.61],[89,19,0.65],[43,50,0.61],[53,57,0.69],[69,62,0.68],[70,59,0.64],[49,78,0.63],[72,29,0.6],[49,81,0.6],[74,38,0.5],[80,41,0.67],[92,44,0.68],[91,46,0.62]], lines:[[3,4],[4,5],[5,6],[3,6],[0,3],[0,1],[1,2],[6,9],[9,13],[13,15],[9,10],[10,11],[10,12],[4,7],[7,8],[8,14],[5,14],[5,16],[16,17],[17,18],[17,19]] },
    { name:'Pisces', stars:[[24,51,0.62],[17,62,0.54],[8,74,0.59],[12,73,0.5],[19,69,0.52],[33,41,0.49],[32,34,0.49],[34,23,0.51],[30,29,0.48],[24,68,0.47],[32,65,0.45],[36,65,0.54],[43,65,0.52],[65,67,0.57],[74,69,0.55],[79,67,0.54],[71,73,0.46],[73,76,0.51],[81,77,0.46],[85,73,0.61],[92,72,0.51],[83,69,0.45]], lines:[[6,7],[7,8],[6,8],[5,6],[0,5],[0,1],[1,2],[2,3],[3,4],[4,9],[9,10],[10,11],[11,12],[12,13],[13,14],[14,15],[15,21],[19,21],[18,19],[17,18],[16,17],[14,16],[19,20]] },
    { name:'Perseus', stars:[[37,30,0.84],[47,17,0.7],[53,8,0.6],[52,20,0.58],[45,31,0.56],[46,47,0.6],[47,61,0.8],[59,31,0.56],[92,18,0.57],[30,36,0.53],[26,37,0.69],[24,55,0.6],[15,63,0.7],[11,36,0.57],[12,77,0.57],[14,92,0.71],[22,91,0.59],[8,33,0.56],[14,27,0.54],[45,65,0.5],[49,68,0.65],[54,65,0.49],[53,60,0.45]], lines:[[15,16],[14,15],[12,14],[11,12],[10,11],[9,10],[0,9],[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,19],[19,20],[20,21],[21,22],[6,22],[17,18],[13,17],[10,13],[4,7],[7,8]] },
    { name:'Sagittarius', stars:[[73,63,0.84],[49,48,0.74],[76,50,0.72],[72,36,0.71],[85,52,0.69],[76,70,0.68],[60,40,0.67],[54,38,0.8],[47,42,0.65],[48,25,0.6],[45,23,0.7],[53,23,0.63],[83,24,0.59],[37,80,0.57],[39,92,0.57],[41,35,0.47],[55,28,0.47],[39,17,0.46],[36,14,0.58],[36,8,0.51],[35,33,0.45],[27,35,0.5],[15,40,0.49],[15,66,0.53],[20,86,0.56]], lines:[[0,5],[0,2],[2,3],[3,12],[13,14],[1,13],[1,6],[3,6],[23,24],[22,23],[21,22],[20,21],[15,20],[7,15],[6,7],[2,6],[2,4],[0,4],[0,1],[1,8],[7,8],[7,9],[9,10],[10,17],[17,18],[18,19],[9,11],[11,16],[7,16]] },
    { name:'Eridanus', stars:[[80,92,1],[78,80,0.61],[73,79,0.62],[71,72,0.54],[69,60,0.56],[64,60,0.7],[59,63,0.54],[54,59,0.5],[51,53,0.55],[43,51,0.62],[41,51,0.57],[37,47,0.59],[51,36,0.54],[55,34,0.54],[60,34,0.61],[65,37,0.56],[71,30,0.51],[72,24,0.54],[68,16,0.58],[55,17,0.6],[52,18,0.63],[51,21,0.52],[47,23,0.69],[42,13,0.57],[32,8,0.58],[28,8,0.57],[20,11,0.72]], lines:[[25,26],[24,25],[23,24],[22,23],[21,22],[20,21],[19,20],[18,19],[17,18],[16,17],[15,16],[14,15],[13,14],[12,13],[11,12],[10,11],[9,10],[8,9],[7,8],[6,7],[5,6],[4,5],[3,4],[2,3],[1,2],[0,1]] }
  ];
  // Where finished constellations sit, as [left, top] of a 110px box.
  var SKY_SLOTS = [[70, 40], [70, 215], [820, 40], [820, 215]];
  var skyTodayGood = null; // was today a good day at the last redraw? (null = not drawn yet)

  // Count the good days up to today, and whether today is one of them.
  function skyProgress(){
    var today = localDateStr(new Date());
    var good = Object.keys(consCache).filter(function(k){
      var v = consCache[k];
      return k.slice(5) <= today && v && v.total > 0 && v.done / v.total >= settings.goodDay;
    });
    return { stars: good.length, todayGood: good.indexOf('plan:' + today) !== -1 };
  }

  function svgEl(tag, attrs, parent){
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for(var k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e);
    return e;
  }

  // Draw one constellation in a square box [left, top, size] with its first `lit` stars lit.
  function drawConstellation(con, box, lit, small, freshIndex, parent){
    var complete = lit >= con.stars.length;
    function pt(st){ return [box[0] + st[0] / 100 * box[2], box[1] + st[1] / 100 * box[2]]; }
    con.lines.forEach(function(ln){
      if(ln[0] >= lit || ln[1] >= lit) return;
      var a = pt(con.stars[ln[0]]), b = pt(con.stars[ln[1]]);
      svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], 'class': 'sky-link' + (complete ? ' complete' : '') }, parent);
    });
    con.stars.forEach(function(st, i){
      var p = pt(st);
      if(i < lit){
        // today just became a good day: a soft ring of light spreads out from its new star
        if(i === freshIndex) svgEl('circle', { cx: p[0], cy: p[1], r: 10, 'class': 'sky-burst' }, parent);
        svgEl('circle', { cx: p[0], cy: p[1], r: small ? 2 + st[2] * 2.5 : 4 + st[2] * 5, filter: 'url(#skyGlow)',
          'class': 'sky-star' + (i === freshIndex ? ' fresh' : '') }, parent);
      } else if(!small){
        svgEl('circle', { cx: p[0], cy: p[1], r: 4, 'class': 'sky-slot' }, parent);
      }
    });
  }

  // ---------- sky colours through the day ----------
  // The sky follows Sydney's real sunrise and sunset (sunTimes): a pale glow at dawn,
  // calm deep blue by day, pink and orange at sunset, full dark at night. It never gets
  // light enough to hide the gold stars; only the faint background stars dim by day.
  var SKY_LOOKS = {
    night:  { top:'#0a1230', mid:'#16244a', bot:'#23365f', glow:'#23365f', glowA:0,    bg:1 },
    dawn:   { top:'#13224f', mid:'#3b5590', bot:'#9fb2d6', glow:'#f6c9a8', glowA:0.55, bg:0.45 },
    midday: { top:'#1f3a74', mid:'#2c4f8f', bot:'#4a6faa', glow:'#bcd2ff', glowA:0.22, bg:0.2 },
    sunset: { top:'#141c46', mid:'#4a3a78', bot:'#c8746a', glow:'#f4a46a', glowA:0.6,  bg:0.55 }
  };
  function mixColour(a, b, t){
    var x = [1, 3, 5].map(function(i){ return parseInt(a.slice(i, i + 2), 16); });
    var y = [1, 3, 5].map(function(i){ return parseInt(b.slice(i, i + 2), 16); });
    return 'rgb(' + x.map(function(v, i){ return Math.round(v + (y[i] - v) * t); }).join(',') + ')';
  }
  function tintSky(){
    var now = new Date(), sun = sunTimes(now), m = now.getHours() * 60 + now.getMinutes();
    // key moments in minutes after midnight; the colours blend between them. Real twilight is
    // short: the glow is gone ~40 minutes after sunset (and starts ~40 before sunrise).
    var keys = [[0, 'night'], [sun.rise - 40, 'night'], [sun.rise + 10, 'dawn'], [sun.rise + 150, 'midday'],
                [sun.set - 90, 'midday'], [sun.set, 'sunset'], [sun.set + 40, 'night'], [1440, 'night']];
    var i = 0;
    while(i < keys.length - 2 && m > keys[i + 1][0]) i++;
    var A = SKY_LOOKS[keys[i][1]], B = SKY_LOOKS[keys[i + 1][1]];
    var t = Math.min(1, Math.max(0, (m - keys[i][0]) / ((keys[i + 1][0] - keys[i][0]) || 1)));
    document.getElementById('skyTop').setAttribute('stop-color', mixColour(A.top, B.top, t));
    document.getElementById('skyMid').setAttribute('stop-color', mixColour(A.mid, B.mid, t));
    document.getElementById('skyBot').setAttribute('stop-color', mixColour(A.bot, B.bot, t));
    var glow = mixColour(A.glow, B.glow, t), glowA = A.glowA + (B.glowA - A.glowA) * t;
    document.getElementById('skyGlowIn').setAttribute('stop-color', glow);
    document.getElementById('skyGlowIn').setAttribute('stop-opacity', glowA.toFixed(2));
    document.getElementById('skyGlowOut').setAttribute('stop-color', glow);
    document.getElementById('skyBg').setAttribute('opacity', (A.bg + (B.bg - A.bg) * t).toFixed(2));
  }
  setInterval(function(){ if(settings.showNightSky) tintSky(); }, 60000);

  // After sunset, a quiet line under the sky notices how today went. Always kind:
  // a day that didn't go to plan gets "tomorrow's a fresh sky", never a telling-off.
  function eveningNote(){
    var now = new Date();
    if(now.getHours() * 60 + now.getMinutes() < sunTimes(now).set) return '';
    var v = consCache[dateKey(now)];
    if(!v || !v.total) return '';
    var text = v.done === v.total ? 'Every block done today ✦'
      : v.done / v.total >= settings.goodDay ? v.done + ' of ' + v.total + ' done today. A good day.'
      : v.done > 0 ? v.done + ' of ' + v.total + ' done today. Tomorrow’s a fresh sky.'
      : 'Rest counts too. Tomorrow’s a fresh sky.';
    return '<span class="sky-evening">' + text + '</span>';
  }

  function renderNightSky(){
    if(!settings.showNightSky) return;
    tintSky();
    var bg = document.getElementById('skyBg');
    if(!bg.firstChild){
      // fixed pseudo-random background stars, so the sky looks the same every time
      var seed = 7;
      var rnd = function(){ seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for(var i = 0; i < 110; i++){
        var s = svgEl('circle', { cx: (rnd() * 1000).toFixed(1), cy: (rnd() * 380).toFixed(1), r: (0.6 + rnd() * 1.2).toFixed(2), 'class': 'sky-bg' }, bg);
        s.setAttribute('opacity', (0.25 + rnd() * 0.5).toFixed(2));
        if(i % 4 === 0){ s.classList.add('sky-twinkle'); s.style.animationDelay = (rnd() * 3.6).toFixed(2) + 's'; }
      }
    }

    var p = skyProgress();
    // today has just become a good day (not while history is still loading at start-up)
    var pop = !consLoading && skyTodayGood === false && p.todayGood;
    if(!consLoading) skyTodayGood = p.todayGood;

    // Fill the constellations in order. One finished by today's star stays in
    // the middle for today, so you get to see it complete.
    var left = p.stars, focus = 0, collected = [];
    while(focus < CONSTELLATIONS.length - 1 && left >= CONSTELLATIONS[focus].stars.length){
      if(left === CONSTELLATIONS[focus].stars.length && p.todayGood) break;
      left -= CONSTELLATIONS[focus].stars.length;
      collected.push(focus);
      focus++;
    }
    var con = CONSTELLATIONS[focus];
    var lit = Math.min(left, con.stars.length);

    var g = document.getElementById('skyCons');
    g.textContent = '';
    // the sky has room for the latest four; the collection grid below shows them all
    collected.slice(-SKY_SLOTS.length).forEach(function(ci, n){
      var slot = SKY_SLOTS[n];
      drawConstellation(CONSTELLATIONS[ci], [slot[0], slot[1], 110], Infinity, true, -1, g);
      svgEl('text', { x: slot[0] + 55, y: slot[1] + 130, 'class': 'sky-name' }, g).textContent = CONSTELLATIONS[ci].name;
    });
    drawConstellation(con, [355, 30, 290], lit, false, pop ? lit - 1 : -1, g);

    var done = collected.length + (lit >= con.stars.length ? 1 : 0); // a finished one counts straight away
    var goal = { 0.5: 'half', 0.75: 'three quarters', 1: 'all' }[settings.goodDay] || 'half';
    var line = lit < con.stars.length ? '<b>' + con.name + '</b> · ' + lit + ' of ' + con.stars.length + ' stars'
      : focus === CONSTELLATIONS.length - 1 ? '<b>Your sky is complete!</b> All 88 constellations collected.'
      : '<b>' + con.name + ' complete!</b> It joins your sky tomorrow.';
    document.getElementById('nightSkyCaption').innerHTML = line +
      '<span class="sky-hint"> · Tap to open</span>' + eveningNote() +
      '<span class="sky-more"> · ' + done + ' of ' + CONSTELLATIONS.length + ' collected' +
      '<br>A star for every day you finish ' + goal + ' of your blocks.' +
      (consLoading ? ' Counting your days…' : '') + '</span>';
    skyState = { collected: done, focus: focus, lit: lit };
    renderCollection();
  }

  // The collection: every constellation as a small tile under the open sky. Collected
  // ones glow with their name, the one in progress shows its lit stars, the rest are
  // faint outlines to look forward to. Only drawn while the sky is open.
  var skyState = null, collectionDrawn = '';
  function renderCollection(){
    var wrap = document.getElementById('skyCollection');
    if(!skyState || !skyBlock.classList.contains('open')) return;
    var sig = skyState.collected + ':' + skyState.focus + ':' + skyState.lit;
    if(sig === collectionDrawn) return; // nothing changed since last time
    collectionDrawn = sig;
    wrap.textContent = '';
    CONSTELLATIONS.forEach(function(con, i){
      var got = i < skyState.collected, now = i === skyState.focus && !got;
      var tile = document.createElement('div');
      tile.className = 'sky-tile' + (got ? ' got' : now ? ' now' : '');
      var svg = svgEl('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' }, tile);
      drawConstellation(con, [8, 8, 84], got ? Infinity : now ? skyState.lit : 0, true, -1, svg);
      if(!got && !now) drawConstellation(con, [8, 8, 84], Infinity, true, -1, svg); // faint outline (CSS dims it)
      var label = document.createElement('span');
      label.textContent = con.name + (now ? ' · ' + skyState.lit + '/' + con.stars.length : '');
      tile.appendChild(label);
      wrap.appendChild(tile);
    });
  }

  // Tap (or Enter / Space) opens the full sky; again closes it back to a strip.
  // CSS can't animate to a natural height, so measure both heights and slide between them.
  // The slide plays even with "reduce motion" on: the owner asked for it, and it's a small, gentle movement.
  var skyBlock = document.getElementById('nightSkyBlock');
  var skySvg = document.getElementById('nightSky');
  var skyCol = document.getElementById('skyCollection');
  function toggleSky(){
    if(skyCol.getAnimations) skyCol.getAnimations().forEach(function(a){ a.cancel(); });
    skyCol.style.display = ''; skyCol.style.overflow = '';
    var from = skySvg.getBoundingClientRect().height, colFrom = skyCol.offsetHeight;
    var opening = skyBlock.classList.toggle('open');
    skyBlock.setAttribute('aria-expanded', opening);
    renderCollection();
    var to = skySvg.getBoundingClientRect().height, colTo = skyCol.offsetHeight;
    if(!skySvg.animate) return;
    var slide = { duration: 400, easing: 'ease-in-out' };
    skySvg.animate([{ height: from + 'px' }, { height: to + 'px' }], slide);
    // the collection slides and fades with it; while closing it stays shown until the slide ends
    if(!opening) skyCol.style.display = 'grid';
    skyCol.style.overflow = 'hidden';
    skyCol.animate([
      { height: colFrom + 'px', marginTop: opening ? '0px' : '12px', opacity: opening ? 0 : 1 },
      { height: colTo + 'px', marginTop: opening ? '12px' : '0px', opacity: opening ? 1 : 0 }
    ], slide).finished.then(function(){ skyCol.style.display = ''; skyCol.style.overflow = ''; }, function(){});
  }
  skyBlock.addEventListener('click', toggleSky);
  // browsing the collection shouldn't close the sky
  document.getElementById('skyCollection').addEventListener('click', function(e){ e.stopPropagation(); });

  // ---------- shooting stars and satellites ----------
  // Every 7–13 seconds something small happens. In the sky: usually a quick shooting
  // star, sometimes a slow satellite (one at a time).
  // Spots and directions are random, so it's different every time. Nothing runs
  // while the tab is hidden.
  var skyFx = document.getElementById('skyFx');
  var satelliteCrossing = false;
  function skyEvent(){
    setTimeout(skyEvent, 7000 + Math.random() * 6000);
    if(!settings.showNightSky || document.hidden || !skyFx.animate) return;
    var open = skyBlock.classList.contains('open');
    var top = open ? 30 : 165, bottom = open ? 320 : 215; // closed, only a thin middle band of the picture shows
    if(!cometShowing && Math.random() < 1 / 50){ comet(open, top, bottom); return; } // rare: about once every 8 minutes
    if(!satelliteCrossing && Math.random() < 0.25){ satellite(open, top, bottom); return; }
    var x = 150 + Math.random() * 700, y = top + Math.random() * (bottom - top);
    // open: any direction; closed: mostly sideways, or it would cross the thin strip in a blink
    var angle = open ? Math.random() * 360 : (Math.random() < 0.5 ? 0 : 180) + Math.random() * 60 - 30;
    var g = svgEl('g', { transform: 'translate(' + x.toFixed(0) + ' ' + y.toFixed(0) + ') rotate(' + angle.toFixed(0) + ')' }, skyFx);
    var streak = svgEl('g', {}, g);
    svgEl('rect', { x: -90, y: -1, width: 90, height: 2, rx: 1, fill: 'url(#meteorGrad)' }, streak);
    svgEl('circle', { r: 1.8, fill: '#ffffff' }, streak);
    streak.animate([
      { transform: 'translateX(0px)', opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { opacity: 1, offset: 0.7 },
      { transform: 'translateX(220px)', opacity: 0 }
    ], { duration: 900, easing: 'ease-in', fill: 'forwards' }); // stays gone at the end, or it snaps back to the start while the trail fades
    // like a real one, it leaves a faint glowing trail that lingers for a moment after it's gone
    // (drawn on with a dash rather than stretched, because Safari stretches SVG from the wrong spot)
    var trail = svgEl('line', { x1: 0, y1: 0, x2: 220, y2: 0, stroke: '#fff6d8', 'stroke-width': 1.2, 'stroke-dasharray': '220 220', 'stroke-dashoffset': 220, 'class': 'meteor-trail' }, g);
    trail.animate([
      { strokeDashoffset: 220, opacity: 0, easing: 'ease-in' },
      { strokeDashoffset: 0, opacity: 0.3, offset: 0.33 },
      { strokeDashoffset: 0, opacity: 0 }
    ], { duration: 2700, fill: 'forwards' }).onfinish = function(){ g.remove(); };
  }

  // A rare comet: a soft glowing head with a long faint tail. Real comets barely move,
  // so it fades in, drifts a tiny way over about half a minute, and fades out.
  var cometShowing = false;
  function comet(open, top, bottom){
    cometShowing = true;
    // closed: tail nearly level so it fits the strip; open: any angle
    var angle = open ? Math.random() * 360 : (Math.random() < 0.5 ? 0 : 180) + Math.random() * 16 - 8;
    var x = 250 + Math.random() * 500, y = top + 10 + Math.random() * Math.max(0, bottom - top - 20);
    var g = svgEl('g', { transform: 'translate(' + x.toFixed(0) + ' ' + y.toFixed(0) + ') rotate(' + angle.toFixed(0) + ') scale(1.5)' }, skyFx);
    var body = svgEl('g', {}, g);
    // the tail fans out behind the head (meteorGrad goes from clear to bright, so the bright end is at the head)
    svgEl('path', { d: 'M-170 -9 Q-80 -4 0 -1.5 L0 1.5 Q-80 4 -170 9 Z', fill: 'url(#meteorGrad)', opacity: 0.55 }, body);
    svgEl('path', { d: 'M-130 -16 Q-60 -6 0 0', fill: 'none', stroke: '#bcd2ff', 'stroke-opacity': 0.3, 'stroke-width': 1.2 }, body); // the faint blue ion tail
    svgEl('circle', { r: 4, fill: '#fffbe8', filter: 'url(#skyGlow)' }, body);
    body.animate([
      { transform: 'translateX(0px)', opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { opacity: 1, offset: 0.8 },
      { transform: 'translateX(30px)', opacity: 0 }
    ], { duration: 30000, easing: 'linear' }).onfinish = function(){ g.remove(); cometShowing = false; };
  }
  function satellite(open, top, bottom){
    satelliteCrossing = true;
    // closed: nearly level, so it stays in the visible strip; open: any direction
    var deg = open ? Math.random() * 360 : (Math.random() < 0.5 ? 0 : 180) + Math.random() * 12 - 6;
    var dx = Math.cos(deg * Math.PI / 180), dy = Math.sin(deg * Math.PI / 180);
    var cx = 300 + Math.random() * 400, cy = top + Math.random() * (bottom - top);
    var dot = svgEl('circle', { cx: (cx - dx * 600).toFixed(0), cy: (cy - dy * 600).toFixed(0), r: 1.6, fill: '#e9eef7' }, skyFx);
    dot.animate([
      { transform: 'translate(0px, 0px)', opacity: 0 },
      { opacity: 0.9, offset: 0.1 },
      { opacity: 0.9, offset: 0.9 },
      { transform: 'translate(' + (dx * 1200).toFixed(0) + 'px, ' + (dy * 1200).toFixed(0) + 'px)', opacity: 0 }
    ], { duration: 20000 }).onfinish = function(){ dot.remove(); satelliteCrossing = false; };
  }

  setTimeout(skyEvent, 4000);
  skyBlock.addEventListener('keydown', function(e){
    if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggleSky(); }
  });

  function renderConsistency(){
    renderNightSky(); // the sky is drawn from the same history, so it redraws whenever the grid would
    var wrap = document.getElementById('consistencyBlock');
    if(!wrap || !settings.showConsistency) return;

    // remember scroll position so ticking a block doesn't snap the grid back
    var prevScroller = wrap.querySelector('.consistency-scroll');
    var prevLeft = prevScroller ? prevScroller.scrollLeft : null;
    var wrapScrollY = window.scrollY;
    wrap.style.minHeight = wrap.offsetHeight + 'px';
    wrap.innerHTML = '';

    var cells = consCells();
    var year = cells[0].getFullYear();
    // Monday-first: how many empty slots come before Jan 1 in the first column
    var offset = (cells[0].getDay() + 6) % 7;
    var weekCount = Math.floor((offset + cells.length - 1) / 7) + 1;

    var endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    var selectedStr = DATES[activeIndex].toDateString();

    var totalDone = 0;
    cells.forEach(function(dt){
      var r = consCache[dateKey(dt)];
      if(r && dt <= endOfToday) totalDone += r.done;
    });

    var head = document.createElement('div');
    head.className = 'cons-head';

    var title = document.createElement('p');
    title.className = 'summary-row-title';
    title.textContent = totalDone + ' block' + (totalDone === 1 ? '' : 's') + ' completed in ' + year
      + (consLoading ? ' \u00b7 loading history\u2026' : '');
    head.appendChild(title);

    var st = computeStreaks();
    var streak = document.createElement('p');
    streak.className = 'summary-row-title cons-streak';
    streak.title = 'A day counts when you finish at least half of what you planned. Today can\'t break a streak until it\'s over.';
    streak.innerHTML = '';
    var cur = document.createElement('strong');
    cur.textContent = st.current + (st.current === 1 ? ' day' : ' days');
    streak.appendChild(document.createTextNode('Streak: '));
    streak.appendChild(cur);
    streak.appendChild(document.createTextNode(' \u00b7 best ' + st.best));
    head.appendChild(streak);
    wrap.appendChild(head);

    if(consLoadError){
      var note = document.createElement('p');
      note.className = 'summary-row-title cons-note';
      note.textContent = 'Couldn\'t load all history (' + consLoadError + '). Toggle the grid off and on to retry.';
      wrap.appendChild(note);
    }

    var scroller = document.createElement('div');
    scroller.className = 'consistency-scroll';
    var grid = document.createElement('div');
    grid.className = 'consistency-grid';
    grid.style.gridTemplateColumns = '28px repeat(' + weekCount + ', minmax(9px, 1fr))';
    grid.style.minWidth = (30 + weekCount * 11) + 'px';

    // month labels: one above the week that holds the 1st of each month
    for(var m = 0; m < 12; m++){
      var first = new Date(year, m, 1);
      var dayIndex = Math.round((first - cells[0]) / 86400000);
      var col = Math.floor((offset + dayIndex) / 7);
      var el = document.createElement('div');
      el.className = 'cons-month';
      el.textContent = first.toLocaleDateString(undefined, {month:'short'});
      // grid lines: label column is line 1, weeks start at line 2, last line is weekCount + 2
      el.style.gridColumn = (col + 2) + ' / ' + Math.min(col + 5, weekCount + 2);
      grid.appendChild(el);
    }

    // day labels on the side (Mon / Wed / Fri)
    [[0,'Mon'],[2,'Wed'],[4,'Fri']].forEach(function(pair){
      var el = document.createElement('div');
      el.className = 'cons-daylabel';
      el.textContent = pair[1];
      el.style.gridRow = String(pair[0] + 2);
      grid.appendChild(el);
    });

    var selectedCell = null;
    cells.forEach(function(dt, i){
      var pos = offset + i;
      var cell = document.createElement('div');
      cell.className = 'cons-cell';
      cell.style.gridColumn = String(Math.floor(pos / 7) + 2);
      cell.style.gridRow = String((pos % 7) + 2);

      var label = dt.toLocaleDateString(undefined, {weekday:'short', day:'numeric', month:'short', year:'numeric'});
      if(dt > endOfToday){
        cell.classList.add('future');
        cell.title = label;
      } else {
        var r = consCache[dateKey(dt)];
        if(r && r.total > 0){
          var pct = Math.round((r.done / r.total) * 100);
          var fill = document.createElement('div');
          fill.className = 'cons-fill';
          fill.style.opacity = consLevelOpacity(pct);
          cell.appendChild(fill);
          cell.title = label + ' \u2014 ' + r.done + ' of ' + r.total + ' done';
        } else {
          cell.title = label + ' \u2014 nothing planned';
        }
      }
      // the outlined square follows whichever day tab is selected
      if(dt.toDateString() === selectedStr){
        cell.classList.add('selected');
        selectedCell = cell;
      }
      grid.appendChild(cell);
    });

    scroller.appendChild(grid);
    wrap.appendChild(scroller);

    // first draw: on narrow screens that scroll sideways, bring today into view
    if(prevLeft !== null){
      scroller.scrollLeft = prevLeft;
    } else if(selectedCell){
      var offsetLeft = selectedCell.getBoundingClientRect().left - grid.getBoundingClientRect().left;
      scroller.scrollLeft = Math.max(0, offsetLeft - scroller.clientWidth * 0.6);
    }

    wrap.style.minHeight = '';
    window.scrollTo(0, wrapScrollY);
  }

  summaryToggle.addEventListener('click', function(){
    var open = summaryPanel.style.display !== 'none';
    summaryPanel.style.display = open ? 'none' : 'block';
    summaryToggle.classList.toggle('toggle-active', !open);
    if(!open){
      templatesPanel.style.display = 'none';
      templatesToggle.classList.remove('toggle-active');
      settingsPanelRef().style.display = 'none';
      document.getElementById('settingsToggle').classList.remove('toggle-active');
      buildSummary();
    }
  });

})();
