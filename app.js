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

  function loadRecurringRules(){
    return window.storage.get('recurring').then(function(res){
      if(res && res.value){
        try{ recurringRules = JSON.parse(res.value); }catch(e){ recurringRules = []; }
      }
    }).catch(function(){});
  }

  function saveRecurringRules(){
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

  var proportionalMode = false;

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
  function setStatus(text){
    var el = document.getElementById('toast');
    if(!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){
      el.classList.remove('show');
    }, 1800);
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

  function loadCategories(){
    window.storage.get('categories').then(function(res){
      if(res && res.value){
        try{
          var parsed = JSON.parse(res.value);
          // migrate old plain-string format to {name,color}
          TAGS = parsed.map(function(t, i){
            if(typeof t === 'string'){
              var fallback = DEFAULT_TAGS[i % DEFAULT_TAGS.length].color;
              return { name: t, color: fallback };
            }
            return t;
          });
        }catch(e){ TAGS = DEFAULT_TAGS.slice(); }
      }
      renderCatManager();
    }).catch(function(){
      renderCatManager();
    });
  }

  function saveCategories(){
    clearTimeout(catSaveTimer);
    catSaveTimer = setTimeout(function(){
      window.storage.set('categories', JSON.stringify(TAGS)).catch(function(){});
    }, 250);
  }

  var loadSeq = 0; // each loadDay call gets a number; only the newest one may touch the screen

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
      btn.className = 'daytab' + (i === activeIndex ? ' active' : '');
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
      empty.textContent = 'Nothing planned yet — press N or hit + Add block to get started.';
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

      if(proportionalMode){
        var duration = b.duration || 30;
        var pxPerMin = 1.4;
        var h = Math.max(46, Math.min(320, duration * pxPerMin));
        row.style.minHeight = h + 'px';
      }

      if(b.tags.length > 0){
        row.style.backgroundColor = tagColor(b.tags[0]);
        row.style.setProperty('--cat', colorForCategory(b.tags[0])); // used by the Colour Blocks theme
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
        saveDay();
        renderDay();
      });
      row.appendChild(check);

      var timeCol = document.createElement('div');
      timeCol.className = 'time-col';
      var timeInput = document.createElement('input');
      timeInput.type = 'time';
      timeInput.step = 300;
      timeInput.value = b.time;
      timeInput.addEventListener('change', function(e){
        b.time = e.target.value;
        saveDay();
        renderDay();
      });
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
        var startMin = timeToMinutes(b.time);
        var endMin = timeToMinutes(e.target.value);
        var newDuration = endMin - startMin;
        if(newDuration <= 0) newDuration += 24 * 60; // end time rolled past midnight
        b.duration = Math.max(5, newDuration);
        saveDay();
        renderDay();
      });
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
        deleteTemplateBtn.textContent = 'Delete';
        deleteTemplateBtn.classList.remove('armed');
      }, 3000);
      return;
    }
    clearTimeout(deleteArmTimer);
    deleteArmed = false;
    deleteTemplateBtn.textContent = 'Delete';
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

  var todayBtn = document.getElementById('todayBtn');

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
  todayBtn.addEventListener('click', function(){
    var todayStr = new Date().toDateString();
    var idx = DATES.findIndex(function(d){ return d.toDateString() === todayStr; });
    if(idx === -1 || idx === activeIndex) return;
    activeIndex = idx;
    renderTabs();
    loadDay();
  });

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
      todayBtn.click();
    } else if(e.key === ','){
      e.preventDefault();
      document.getElementById('settingsToggle').click();
    } else if(e.key === 'Escape'){
      var panelIds = ['templatesPanel','categoriesPanel','recurringPanel','settingsPanel','summaryPanel'];
      var toggleIds = ['templatesToggle','categoriesToggle','recurringToggle','settingsToggle','summaryToggle'];
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
  var categoriesToggle = document.getElementById('categoriesToggle');
  var templatesPanel = document.getElementById('templatesPanel');
  var categoriesPanel = document.getElementById('categoriesPanel');

  templatesToggle.addEventListener('click', function(){
    var open = templatesPanel.style.display !== 'none';
    templatesPanel.style.display = open ? 'none' : 'block';
    templatesToggle.classList.toggle('toggle-active', !open);
    if(!open){
      categoriesPanel.style.display = 'none';
      categoriesToggle.classList.remove('toggle-active');
      settingsPanelRef().style.display = 'none';
      document.getElementById('summaryPanel').style.display = 'none';
      document.getElementById('summaryToggle').classList.remove('toggle-active');
      document.getElementById('settingsToggle').classList.remove('toggle-active');
      document.getElementById('recurringPanel').style.display = 'none';
      document.getElementById('recurringToggle').classList.remove('toggle-active');
    }
  });

  categoriesToggle.addEventListener('click', function(){
    var open = categoriesPanel.style.display !== 'none';
    categoriesPanel.style.display = open ? 'none' : 'block';
    categoriesToggle.classList.toggle('toggle-active', !open);
    if(!open){
      templatesPanel.style.display = 'none';
      templatesToggle.classList.remove('toggle-active');
      settingsPanelRef().style.display = 'none';
      document.getElementById('summaryPanel').style.display = 'none';
      document.getElementById('summaryToggle').classList.remove('toggle-active');
      document.getElementById('settingsToggle').classList.remove('toggle-active');
      document.getElementById('recurringPanel').style.display = 'none';
      document.getElementById('recurringToggle').classList.remove('toggle-active');
    }
  });

  function settingsPanelRef(){ return document.getElementById('settingsPanel'); }

  // ---------- recurring blocks ----------
  var recurringToggle = document.getElementById('recurringToggle');
  var recurringPanel = document.getElementById('recurringPanel');
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
      empty.textContent = 'No auto-applied templates yet.';
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

  recurringToggle.addEventListener('click', function(){
    var open = recurringPanel.style.display !== 'none';
    recurringPanel.style.display = open ? 'none' : 'block';
    recurringToggle.classList.toggle('toggle-active', !open);
    if(!open){
      templatesPanel.style.display = 'none';
      templatesToggle.classList.remove('toggle-active');
      categoriesPanel.style.display = 'none';
      categoriesToggle.classList.remove('toggle-active');
      settingsPanelRef().style.display = 'none';
      document.getElementById('settingsToggle').classList.remove('toggle-active');
      var sp = document.getElementById('summaryPanel');
      if(sp) sp.style.display = 'none';
      var st = document.getElementById('summaryToggle');
      if(st) st.classList.remove('toggle-active');
      renderWeekdayPicker();
      renderRecurTemplateSelect();
      renderRecurList();
    }
  });

  var proportionalToggle = document.getElementById('proportionalToggle');
  proportionalToggle.addEventListener('click', function(){
    proportionalMode = !proportionalMode;
    proportionalToggle.classList.toggle('toggle-active', proportionalMode);
    renderDay();
  });

  // ---------- settings ----------
  var DEFAULT_SETTINGS = { bg:'#f6f4ee', accent:'#3a5a49', font:'serif', theme:'original', showProgress:true, showMiniTimeline:true, dark:false, quickAdd:false, showConsistency:true, showNightSky:true, goodDay:0.5, growLook:'sky', followSun:false };
  // Ready-made looks. Picking one fills in the normal settings below; the rest
  // of each look is CSS in styles.css, switched on by <body data-theme="...">.
  var THEMES = {
    original: { bg:'#f6f4ee', accent:'#3a5a49', font:'serif',   dark:false },
    cards:    { bg:'#f6f4ee', accent:'#3a5a49', font:'serif',   dark:false },
    night:    { bg:'#16211b', accent:'#7fb894', font:'serif',   dark:true  },
    lake:     { bg:'#f1f5f8', accent:'#2f5d8a', font:'modern',  dark:false },
    sunrise:  { bg:'#fbf3ec', accent:'#b0532c', font:'rounded', dark:false },
    minimal:  { bg:'#fcfcfb', accent:'#111418', font:'modern',  dark:false },
    blocks:   { bg:'#f6f4ee', accent:'#1f2a24', font:'serif',   dark:false },
    compact:  { bg:'#f6f4ee', accent:'#3a5a49', font:'serif',   dark:false },
    notebook: { bg:'#fdfbf4', accent:'#2b4c7e', font:'serif',   dark:false },
    tackle:   { bg:'#f3eee3', accent:'#1f6f78', font:'sturdy',  dark:false },
    bold:     { bg:'#fffdf7', accent:'#3a5a49', font:'big',     dark:false }
  };
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
  var growLookSelect = document.getElementById('growLookSelect');
  var followSunToggle = document.getElementById('followSunToggle');

  // ---------- day and night colours ----------
  // The Original look's light and dark colours. Dark mode uses the dark set;
  // "Darken at sunset" blends from light to dark as the sun goes down, and back at sunrise.
  var LIGHT = { '--ink':'#1f2a24', '--ink-soft':'#5b6b60', '--line':'#d9d4c6', '--line-strong':'#b9b2a0', '--surface':'#ffffff', '--surface-alt':'#fbfaf6' };
  var DARK  = { '--ink':'#eceae4', '--ink-soft':'#a9a89f', '--line':'#3a3d38', '--line-strong':'#54574f', '--surface':'#2a2d28', '--surface-alt':'#262924' };
  var NIGHT_BG = '#20221f', NIGHT_ACCENT = '#7fb69a';

  // Blend two #rrggbb colours: t = 0 gives a, t = 1 gives b.
  function mixColour(a, b, t){
    if(t <= 0) return a;
    if(t >= 1) return b;
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    return '#' + [16, 8, 0].map(function(s){
      var x = (pa >> s) & 255, y = (pb >> s) & 255;
      return Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    }).join('');
  }

  // Today's sunrise and sunset, in minutes after local midnight (NOAA's sun formula).
  // shortcut: always Sydney's sun; ask for the user's location if other people use the app.
  function sunTimes(date){
    var LAT = -33.87, LNG = 151.21, rad = Math.PI / 180;
    var dayOfYear = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(date.getFullYear(), 0, 0)) / 86400000);
    var g = 2 * Math.PI / 365 * (dayOfYear - 1);
    var eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(LAT * rad) * Math.cos(decl)) - Math.tan(LAT * rad) * Math.tan(decl)) / rad;
    var tz = -date.getTimezoneOffset(); // the device's minutes ahead of UTC, daylight saving included
    return { rise: 720 - 4 * (LNG + ha) - eqTime + tz, set: 720 - 4 * (LNG - ha) - eqTime + tz };
  }

  // How "night" it is right now, from 0 (day) to 1 (night): fades from 30 min before
  // sunset to an hour after, and back from an hour before sunrise to 30 min after.
  function nightAmount(now){
    var sun = sunTimes(now), m = now.getHours() * 60 + now.getMinutes();
    function ramp(from, to){ return Math.min(1, Math.max(0, (m - from) / (to - from))); }
    return m < 720 ? 1 - ramp(sun.rise - 60, sun.rise + 30) : ramp(sun.set - 30, sun.set + 60);
  }

  // WCAG contrast between two #rrggbb colours (1 = none, 21 = black on white).
  function contrast(a, b){
    function lum(hex){
      var c = [1, 3, 5].map(function(i){
        var v = parseInt(hex.substr(i, 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  // Nudge a text colour towards black or white just until it reaches the target contrast.
  function readable(base, extreme, bg, target){
    for(var s = 0; s <= 1; s += 0.05){
      var c = mixColour(base, extreme, s);
      if(contrast(c, bg) >= target) return c;
    }
    return extreme;
  }

  var lastNightText = null, textFlipTimer = null;
  function applyColours(){
    var root = document.documentElement.style;
    var t = settings.followSun ? nightAmount(new Date()) : (settings.dark ? 1 : 0);
    // Backgrounds fade smoothly. Text can't simply fade with them (both would meet in an
    // unreadable middle grey), so it uses whichever of the day or night colours reads better
    // on the background right now, nudged towards black or white when it needs to.
    var paper = settings.followSun ? mixColour(settings.bg, NIGHT_BG, t) : settings.bg;
    var nightText = contrast('#ffffff', paper) > contrast('#000000', paper);
    if(settings.followSun && lastNightText !== null && nightText !== lastNightText){
      // the text is switching between dark and light: cross-fade it over 2 seconds instead of snapping
      document.body.classList.add('text-flip');
      clearTimeout(textFlipTimer);
      textFlipTimer = setTimeout(function(){ document.body.classList.remove('text-flip'); }, 2500);
    }
    lastNightText = nightText;
    var extreme = nightText ? '#ffffff' : '#000000';
    var text = nightText ? DARK : LIGHT;
    Object.keys(LIGHT).forEach(function(k){ root.setProperty(k, mixColour(LIGHT[k], DARK[k], t)); });
    root.setProperty('--ink', readable(text['--ink'], extreme, paper, 4.5));
    root.setProperty('--ink-soft', readable(text['--ink-soft'], extreme, paper, 3.5));
    var accent = settings.followSun ? mixColour(settings.accent, NIGHT_ACCENT, t) : settings.accent;
    root.setProperty('--paper', paper);
    root.setProperty('--accent', accent);
    root.setProperty('--accent-soft', accent + '22');
  }
  // keep the fade moving while the planner stays open
  setInterval(function(){ if(settings.followSun) applyColours(); }, 60000);

  function applySettings(){
    applyColours();
    followSunToggle.checked = !!settings.followSun;
    document.documentElement.style.setProperty('--font-body', FONTS[settings.font] || FONTS.serif);
    document.body.dataset.theme = settings.theme;
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
    growLookSelect.value = settings.growLook;
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
      }
      applySettings();
    }).catch(function(){
      applySettings();
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
    if(e.target.value !== 'original') settings.followSun = false; // other themes have their own colours
    applySettings();
    saveSettings();
  });
  resetAppearanceBtn.addEventListener('click', function(){
    settings = Object.assign({}, DEFAULT_SETTINGS);
    applySettings();
    saveSettings();
  });

  darkModeBtn.addEventListener('click', function(){
    settings.dark = !settings.dark;
    settings.theme = 'original'; // a theme's own colours would clash with plain dark/light mode
    settings.followSun = false;  // choosing dark or light by hand switches off the sunset fade
    if(settings.dark){
      settings.bg = NIGHT_BG;
      settings.accent = NIGHT_ACCENT;
    } else {
      settings.bg = DEFAULT_SETTINGS.bg;
      settings.accent = DEFAULT_SETTINGS.accent;
    }
    applySettings();
    saveSettings();
  });

  followSunToggle.addEventListener('change', function(e){
    // the fade goes between the Original light and dark colours, so start from the Original look
    if(e.target.checked) Object.assign(settings, THEMES.original, { theme: 'original' });
    settings.followSun = e.target.checked;
    applySettings();
    saveSettings();
  });

  showNightSkyToggle.addEventListener('change', function(e){
    settings.showNightSky = e.target.checked;
    applySettings();
    saveSettings();
  });

  growLookSelect.addEventListener('change', function(e){
    settings.growLook = e.target.value;
    applySettings();
    saveSettings();
  });

  goodDaySelect.addEventListener('change', function(e){
    settings.goodDay = parseFloat(e.target.value);
    applySettings();
    saveSettings();
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

  settingsToggle.addEventListener('click', function(){
    var open = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = open ? 'none' : 'block';
    settingsToggle.classList.toggle('toggle-active', !open);
    if(!open){
      templatesPanel.style.display = 'none';
      templatesToggle.classList.remove('toggle-active');
      categoriesPanel.style.display = 'none';
      categoriesToggle.classList.remove('toggle-active');
      var sp = document.getElementById('summaryPanel');
      if(sp) sp.style.display = 'none';
      var st = document.getElementById('summaryToggle');
      if(st) st.classList.remove('toggle-active');
      var rp = document.getElementById('recurringPanel');
      if(rp) rp.style.display = 'none';
      var rt = document.getElementById('recurringToggle');
      if(rt) rt.classList.remove('toggle-active');
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
      return window.storage.list('plan:');
    }).then(function(res){
      var inRange = {};
      consCells().forEach(function(dt){ inRange[dateKey(dt)] = true; });
      // only days still stored in full and not already covered by the summary
      var keys = ((res && res.keys) ? res.keys : []).filter(function(k){ return inRange[k] && !consCache[k]; });

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
  // shortcut: only counts this calendar year's days (all the grid loads); load older summaries too if people want a lifetime sky.

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
      lines:[[0,1],[1,2],[1,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,13],[13,14]] }
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
        svgEl('circle', { cx: p[0], cy: p[1], r: small ? 2 + st[2] * 2.5 : 4 + st[2] * 5, filter: 'url(#skyGlow)',
          'class': 'sky-star' + (i === freshIndex ? ' fresh' : '') }, parent);
      } else if(!small){
        svgEl('circle', { cx: p[0], cy: p[1], r: 4, 'class': 'sky-slot' }, parent);
      }
    });
  }

  // ---------- fish pond ----------
  // Each good day brings the next arrival, in this order. Unlike the sky the
  // pond never restarts: once everything has arrived, another golden fish
  // visits every 10 good days. Positions are in the same 1000×380 box as the sky.
  var POND = [
    { what:'fish', x:420, y:200, c:'#e8834a', d:-1, name:'your first fish' },
    { what:'pad', x:300, y:150, name:'a lily pad' },
    { what:'fish', x:560, y:240, c:'#f2a65a', d:1 },
    { what:'reeds', x:120, y:175, name:'reeds' },
    { what:'fish', x:650, y:170, c:'#e8834a', d:-1 },
    { what:'pad', x:700, y:262, name:'a lily pad' },
    { what:'flower', x:300, y:146, name:'a water lily' },
    { what:'fish', x:350, y:250, c:'#d9643a', d:1 },
    { what:'rocks', x:850, y:252, name:'rocks' },
    { what:'fish', x:500, y:135, c:'#f2a65a', d:-1 },
    { what:'reeds', x:880, y:150, name:'more reeds' },
    { what:'frog', x:700, y:252, name:'a frog' },
    { what:'fish', x:760, y:212, c:'#e8834a', d:1 },
    { what:'pad', x:450, y:302, name:'a lily pad' },
    { what:'fish', x:250, y:212, c:'#f2a65a', d:-1 },
    { what:'dragonfly', x:600, y:80, name:'a dragonfly' },
    { what:'fish', x:580, y:312, c:'#d9643a', d:1 },
    { what:'flower', x:450, y:298, name:'another water lily' },
    { what:'fish', x:380, y:182, c:'#e8834a', d:-1 },
    { what:'pad', x:800, y:172, name:'a lily pad' },
    { what:'fish', x:470, y:262, c:'#f2a65a', d:1 },
    { what:'dragonfly', x:330, y:70, name:'a second dragonfly' },
    { what:'fish', x:680, y:122, c:'#d9643a', d:-1 },
    { what:'fish', x:530, y:200, c:'#f2c14e', d:1, name:'a rare golden fish' }
  ];
  var GOLDEN_SPOTS = [[300, 280, -1], [620, 150, 1], [760, 300, -1]];

  function drawPondItem(it, fresh, parent){
    var g = svgEl('g', { 'class': 'pond-item' + (it.what === 'fish' ? ' pond-fish' : '') + (fresh ? ' fresh' : '') }, parent);
    var x = it.x, y = it.y;
    if(it.what === 'fish'){
      g.style.animationDelay = '-' + ((x * 7) % 50) / 10 + 's'; // fish don't all swim in step
      svgEl('ellipse', { cx: x, cy: y, rx: 16, ry: 8, fill: it.c }, g);
      svgEl('path', { d: 'M' + (x + it.d * -14) + ' ' + y + ' L' + (x + it.d * -27) + ' ' + (y - 8) + ' L' + (x + it.d * -27) + ' ' + (y + 8) + ' Z', fill: it.c }, g);
      svgEl('circle', { cx: x + it.d * 9, cy: y - 2, r: 1.6, fill: '#1f2a24' }, g);
    } else if(it.what === 'pad'){
      svgEl('path', { d: 'M' + x + ' ' + y + ' L' + (x + 29) + ' ' + (y - 4) + ' A30 16 0 1 0 ' + (x + 29) + ' ' + (y + 4) + ' Z', fill: '#5e9e62' }, g);
    } else if(it.what === 'flower'){
      [[0, -7], [7, -2], [4, 6], [-4, 6], [-7, -2]].forEach(function(o){
        svgEl('circle', { cx: x + o[0], cy: y + o[1], r: 6, fill: '#f4b6c8' }, g);
      });
      svgEl('circle', { cx: x, cy: y, r: 3.5, fill: '#f2c14e' }, g);
    } else if(it.what === 'reeds'){
      [[-14, -52], [0, -66], [14, -46]].forEach(function(o){
        svgEl('line', { x1: x + o[0] / 2, y1: y + 30, x2: x + o[0], y2: y + o[1], stroke: '#5e8a4f', 'stroke-width': 3, 'stroke-linecap': 'round' }, g);
        svgEl('ellipse', { cx: x + o[0], cy: y + o[1] + 10, rx: 4, ry: 11, fill: '#8a5a35' }, g);
      });
    } else if(it.what === 'rocks'){
      svgEl('ellipse', { cx: x - 16, cy: y + 4, rx: 22, ry: 13, fill: '#8e938c' }, g);
      svgEl('ellipse', { cx: x + 14, cy: y + 8, rx: 16, ry: 10, fill: '#a3a8a0' }, g);
      svgEl('ellipse', { cx: x + 2, cy: y - 6, rx: 13, ry: 9, fill: '#b5b9b1' }, g);
    } else if(it.what === 'frog'){
      svgEl('ellipse', { cx: x, cy: y, rx: 15, ry: 10, fill: '#6da34d' }, g);
      [-8, 8].forEach(function(dx){
        svgEl('circle', { cx: x + dx, cy: y - 9, r: 5, fill: '#6da34d' }, g);
        svgEl('circle', { cx: x + dx, cy: y - 10, r: 3, fill: '#fbfaf6' }, g);
        svgEl('circle', { cx: x + dx, cy: y - 10, r: 1.4, fill: '#1f2a24' }, g);
      });
    } else if(it.what === 'dragonfly'){
      svgEl('line', { x1: x - 18, y1: y, x2: x + 14, y2: y, stroke: '#2f6f8a', 'stroke-width': 3, 'stroke-linecap': 'round' }, g);
      [[-4, -9], [6, -9], [-4, 9], [6, 9]].forEach(function(o){
        svgEl('ellipse', { cx: x + o[0], cy: y + o[1], rx: 5, ry: 10, fill: '#dff1f7', opacity: 0.75 }, g);
      });
    }
  }

  function drawPond(p, pop){
    var g = document.getElementById('skyCons');
    g.textContent = '';
    svgEl('rect', { width: 1000, height: 380, fill: '#a9cc92' }, g);
    svgEl('ellipse', { cx: 500, cy: 205, rx: 430, ry: 160, fill: '#5f9cb3' }, g);
    svgEl('ellipse', { cx: 500, cy: 200, rx: 410, ry: 142, fill: '#8fc4d5' }, g);
    svgEl('ellipse', { cx: 520, cy: 205, rx: 60, ry: 14, fill: 'none', stroke: '#d8ecf2', 'stroke-width': 2, opacity: 0.7 }, g);

    var arrived = Math.min(p.stars, POND.length);
    for(var i = 0; i < arrived; i++) drawPondItem(POND[i], pop && i === p.stars - 1, g);
    // after everything has arrived, a golden fish visits every 10 good days
    var extra = Math.max(0, Math.min(GOLDEN_SPOTS.length, Math.floor((p.stars - POND.length) / 10)));
    for(var j = 0; j < extra; j++){
      var s = GOLDEN_SPOTS[j];
      drawPondItem({ what: 'fish', x: s[0], y: s[1], c: '#f2c14e', d: s[2] }, pop && j === extra - 1 && (p.stars - POND.length) % 10 === 0, g);
    }

    var goal = { 0.5: 'half', 0.75: 'three quarters', 1: 'all' }[settings.goodDay] || 'half';
    var next = POND[arrived];
    var past = p.stars - POND.length; // good days since everything arrived
    var newest = p.stars <= POND.length ? (POND[p.stars - 1] && (POND[p.stars - 1].name || 'another fish'))
      : (past % 10 === 0 && past / 10 <= GOLDEN_SPOTS.length ? 'a golden fish' : null);
    var line = pop && newest ? '<b>New: ' + newest + '!</b>'
      : '<b>Fish pond</b> · ' + p.stars + ' good day' + (p.stars === 1 ? '' : 's');
    var nextText = next ? ' · Next: ' + (next.name || 'another fish') : ' · A golden fish visits every 10 good days';
    document.getElementById('nightSkyCaption').innerHTML = line + nextText +
      '<span class="sky-hint"> · Tap to open</span>' +
      '<span class="sky-more"><br>Something new arrives every day you finish ' + goal + ' of your blocks.' +
      (consLoading ? ' Counting your days…' : '') + '</span>';
  }

  function renderNightSky(){
    if(!settings.showNightSky) return;
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

    // The pond is another look for the same good days.
    var pond = settings.growLook === 'pond';
    document.getElementById('nightSkyBlock').classList.toggle('pond', pond);
    bg.style.display = pond ? 'none' : '';
    document.getElementById('nightSky').setAttribute('aria-label', pond
      ? 'Your fish pond: something new arrives for each good day'
      : 'Your night sky: one star for each good day');
    if(pond){ drawPond(p, pop); return; }

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
    collected.forEach(function(ci, n){
      var slot = SKY_SLOTS[n];
      drawConstellation(CONSTELLATIONS[ci], [slot[0], slot[1], 110], Infinity, true, -1, g);
      svgEl('text', { x: slot[0] + 55, y: slot[1] + 130, 'class': 'sky-name' }, g).textContent = CONSTELLATIONS[ci].name;
    });
    drawConstellation(con, [355, 30, 290], lit, false, pop ? lit - 1 : -1, g);

    var goal = { 0.5: 'half', 0.75: 'three quarters', 1: 'all' }[settings.goodDay] || 'half';
    var line = lit < con.stars.length ? '<b>' + con.name + '</b> · ' + lit + ' of ' + con.stars.length + ' stars'
      : focus === CONSTELLATIONS.length - 1 ? '<b>' + con.name + ' complete!</b> Every constellation collected. More are coming.'
      : '<b>' + con.name + ' complete!</b> It joins your sky tomorrow.';
    var names = collected.map(function(ci){ return CONSTELLATIONS[ci].name; });
    document.getElementById('nightSkyCaption').innerHTML = line +
      '<span class="sky-hint"> · Tap to open</span>' +
      '<span class="sky-more">' + (names.length ? ' · Collected: ' + names.join(', ') : '') +
      '<br>A star for every day you finish ' + goal + ' of your blocks.' +
      (consLoading ? ' Counting your days…' : '') + '</span>';
  }

  // Tap (or Enter / Space) opens the full sky; again closes it back to a strip.
  // CSS can't animate to a natural height, so measure both heights and slide between them.
  // The slide plays even with "reduce motion" on: the owner asked for it, and it's a small, gentle movement.
  var skyBlock = document.getElementById('nightSkyBlock');
  var skySvg = document.getElementById('nightSky');
  function toggleSky(){
    var from = skySvg.getBoundingClientRect().height;
    skyBlock.setAttribute('aria-expanded', skyBlock.classList.toggle('open'));
    var to = skySvg.getBoundingClientRect().height;
    if(skySvg.animate) skySvg.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 400, easing: 'ease-in-out' });
  }
  skyBlock.addEventListener('click', toggleSky);
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
      categoriesPanel.style.display = 'none';
      categoriesToggle.classList.remove('toggle-active');
      settingsPanelRef().style.display = 'none';
      document.getElementById('settingsToggle').classList.remove('toggle-active');
      var rp2 = document.getElementById('recurringPanel');
      if(rp2) rp2.style.display = 'none';
      var rt2 = document.getElementById('recurringToggle');
      if(rt2) rt2.classList.remove('toggle-active');
      buildSummary();
    }
  });

})();
