/**
 * @lab/design — shared client behavior.
 *
 * Three things, and deliberately only three: the theme toggle, scroll reveals,
 * and obfuscated-address links. Everything here is progressive enhancement —
 * if this file fails to load, every page still renders complete and readable.
 * That is a hard rule of the lab, not a nicety.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- theme ------------------------------------------------------------
     Persisted, unlike the old site. Someone who chose light once should not
     have to choose it again on every subdomain — so we write to localStorage
     under a lab-wide key and read it in the inline head script. */
  const THEME_KEY = 'lab.theme';

  function currentTheme() {
    return root.getAttribute('data-theme')
      || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }

  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    btn.addEventListener('click', () => {
      const next = currentTheme() === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
      btn.setAttribute('aria-label', `Switch to ${next === 'light' ? 'dark' : 'light'} theme`);
    });
  }

  /* --- reveals ----------------------------------------------------------
     Elements marked [data-reveal] fade up as they enter. The pending class is
     added by JS so no-JS users never see hidden content. A failsafe timer
     reveals everything if the observer never fires (background tabs, odd
     viewport math) — content visibility must never depend on a callback. */
  const targets = document.querySelectorAll('[data-reveal]');

  if (reduced || !('IntersectionObserver' in window)) {
    // Nothing to do: content is already visible in its natural state.
  } else if (targets.length) {
    for (const el of targets) el.classList.add('reveal-pending');

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });

    for (const el of targets) {
      // Anything already on screen at load reveals immediately — no fade-in
      // on content the visitor is already looking at.
      if (el.getBoundingClientRect().top < innerHeight) el.classList.add('is-visible');
      else io.observe(el);
    }

    setTimeout(() => {
      for (const el of targets) el.classList.add('is-visible');
    }, 1200);
  }

  /* --- addresses --------------------------------------------------------
     Contact links carry a base64 href in [data-e] rather than a scrapable
     plaintext address. Decoded at runtime; the markup never contains it. */
  for (const el of document.querySelectorAll('[data-e]')) {
    try {
      el.setAttribute('href', atob(el.getAttribute('data-e')));
    } catch { /* leave the link inert rather than broken */ }
  }

  /* --- ticker -----------------------------------------------------------
     The crawl needs its content duplicated to loop seamlessly. Doing it here
     rather than in markup keeps the HTML honest — the doctrine appears once
     in the source, which is what a screen reader and a scraper should see. */
  const track = document.querySelector('[data-ticker]');
  if (track && !reduced) {
    const run = track.firstElementChild;
    if (run) track.appendChild(run.cloneNode(true));
  }
})();

/**
 * Spoken-phrase parsing, in plain JavaScript.
 *
 * This file runs in two places: the Worker (for /api/parse and the MCP tool)
 * and the browser (the listener in site.js). It is plain JS so build.mjs can
 * inline the identical file into the browser bundle; the types are in
 * parse.core.d.ts. Keep it dependency-free and ES2020 at most.
 *
 * A "book" is a list of phrases to match against: `{ phrase, aliases, to }`,
 * where `to` is whatever the caller wants back (a slug, a URL, 'maker').
 */

var WAKE_WORDS = ['hey', 'ok', 'okay', 'hi'];

/** Lower-case, strip punctuation, collapse whitespace. What a recogniser hears, flattened. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Hey Camera" → "camera". The keyword is the phrase without its wake word. */
function keywordOf(phrase) {
  var words = normalize(phrase).split(' ');
  while (words.length > 1 && WAKE_WORDS.indexOf(words[0]) !== -1) words.shift();
  return words.join(' ');
}

/** Every spelling a book entry answers to, longest first so "chat gpt" beats "chat". */
function keywordsOf(entry) {
  var all = [keywordOf(entry.phrase)].concat((entry.aliases || []).map(normalize));
  var seen = {};
  return all
    .filter(function (k) {
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    })
    .sort(function (a, b) {
      return b.length - a.length;
    });
}

function startsWithWord(text, word) {
  return text === word || text.indexOf(word + ' ') === 0;
}

/**
 * The part of the transcript after the *last* wake word. Recognisers run on,
 * so "um so hey claude" should parse as "claude", and a phrase said twice
 * should parse as the second one.
 */
function afterWakeWord(text) {
  var words = normalize(text).split(' ');
  var at = -1;
  for (var i = 0; i < words.length - 1; i++) {
    if (WAKE_WORDS.indexOf(words[i]) !== -1) at = i;
  }
  if (at === -1) return null;
  return words.slice(at + 1).join(' ');
}

/**
 * Strip the verbs people put in front of a brief — "make me an app that can
 * help me…" — so the brief reads as what the app is for. Conservative: when
 * the strip would leave nothing, keep the original.
 */
function briefOf(rest) {
  var text = normalize(rest);
  var stripped = text
    .replace(/^(please |can you |could you |i want you to |i need you to )+/, '')
    .replace(/^(create|make|build|give|design|write)( me| us)?( an?| the| a new| a little| a small| a quick)?( app| tool| page| thing| site| helper)?( that| which| to| for| so)?( can| will| would| could)?(( allow| let| help)( me| us)( to)?)?\b\s*/, '')
    .trim();
  return stripped || text;
}

/**
 * Parse one transcript against a book.
 *
 * Returns { kind: 'open', to, heard } when a phrase matched, { kind: 'make',
 * brief, heard } when the maker was addressed, or { kind: 'none', heard }.
 * Earlier book entries win ties, so callers put personal phrases before the
 * built-in ones — a person who says "Hey Camera" should mean their own camera
 * phrase if they made one.
 */
function parseCommand(transcript, book) {
  var heard = normalize(transcript);
  var rest = afterWakeWord(heard);
  if (rest === null || !rest) return { kind: 'none', heard: heard };

  var best = null;
  for (var i = 0; i < book.length; i++) {
    var entry = book[i];
    var keywords = keywordsOf(entry);
    for (var k = 0; k < keywords.length; k++) {
      var keyword = keywords[k];
      if (!startsWithWord(rest, keyword)) continue;
      if (!best || keyword.length > best.keyword.length) best = { entry: entry, keyword: keyword };
      break;
    }
  }

  if (!best) return { kind: 'none', heard: heard };

  if (best.entry.to === 'maker') {
    var tail = rest.slice(best.keyword.length).trim();
    return { kind: 'make', brief: briefOf(tail), heard: heard };
  }
  return { kind: 'open', to: best.entry.to, heard: heard };
}

var DAY_WORDS = {
  three: 3, '3': 3,
  seven: 7, '7': 7, week: 7,
  fourteen: 14, '14': 14, 'two weeks': 14, fortnight: 14,
  thirty: 30, '30': 30, month: 30,
};

/**
 * "Delete it in 3, 7, 14 or 30 days?" — what the answer meant, or null. Only
 * the four offered values come back: "ten days" is not an answer to the
 * question, and guessing the nearest one would be a surprise later.
 */
function parseDays(text) {
  var heard = ' ' + normalize(text) + ' ';
  var keys = Object.keys(DAY_WORDS).sort(function (a, b) {
    return b.length - a.length;
  });
  for (var i = 0; i < keys.length; i++) {
    if (heard.indexOf(' ' + keys[i] + ' ') !== -1) return DAY_WORDS[keys[i]];
  }
  return null;
}

/* hey.pflantzer.com — progressive enhancement.
 *
 * Every page works with this file absent: phrases are links, the maker is a
 * form, a made app is HTML. What this adds is the part a page cannot do
 * without script — hearing — plus the things that live only in this browser:
 * personal phrases, the list of apps made here, pictures, ticked boxes.
 *
 * `parseCommand`, `parseDays` and friends come from parse.core.js, which
 * build.mjs inlines above this file. Same code the Worker runs.
 */
(function () {
  'use strict';

  var PHRASES_KEY = 'hey.phrases';
  var APPS_KEY = 'hey.apps';
  var SPEAK_KEY = 'hey.speak';

  var store = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  var dataEl = document.getElementById('hey-data');
  var data = null;
  try {
    data = dataEl ? JSON.parse(dataEl.textContent) : null;
  } catch (e) {
    data = null;
  }

  var ua = navigator.userAgent || '';
  var platform = /iPhone|iPad|iPod/i.test(ua) ? 'ios' : /Android/i.test(ua) ? 'android' : 'other';

  /* -- saying things back -------------------------------------------------- */

  var speakToggle = document.querySelector('[data-speak]');
  if (speakToggle) {
    speakToggle.checked = store.get(SPEAK_KEY, true) !== false;
    speakToggle.addEventListener('change', function () {
      store.set(SPEAK_KEY, speakToggle.checked);
    });
  }

  function say(text) {
    if (!('speechSynthesis' in window)) return;
    if (store.get(SPEAK_KEY, true) === false) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = navigator.language || 'en-US';
      speechSynthesis.speak(u);
    } catch (e) {
      /* a phone that will not talk is not an error */
    }
  }

  /* -- personal phrases ---------------------------------------------------- */

  function personalPhrases() {
    var list = store.get(PHRASES_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter(function (p) {
      return p && typeof p.phrase === 'string' && typeof p.url === 'string' && /^https?:\/\//i.test(p.url);
    });
  }

  function addPhrase(phrase, url) {
    var list = personalPhrases().filter(function (p) {
      return keywordOf(p.phrase) !== keywordOf(phrase);
    });
    list.unshift({ phrase: phrase.trim(), url: url.trim() });
    return store.set(PHRASES_KEY, list.slice(0, 50));
  }

  function removePhrase(phrase) {
    store.set(
      PHRASES_KEY,
      personalPhrases().filter(function (p) {
        return p.phrase !== phrase;
      }),
    );
  }

  var personalList = document.querySelector('[data-personal-list]');
  var personalForm = document.querySelector('[data-personal-form]');

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      node.appendChild(c);
    });
    return node;
  }

  function renderPersonal() {
    if (!personalList) return;
    personalList.innerHTML = '';
    var list = personalPhrases();
    if (list.length === 0) {
      personalList.appendChild(el('li', { class: 'empty mono', text: 'No phrases of your own yet.' }));
      return;
    }
    list.forEach(function (p) {
      var remove = el('button', { type: 'button', class: 'btn btn--ghost phrase-remove', text: 'remove' });
      remove.addEventListener('click', function () {
        removePhrase(p.phrase);
        renderPersonal();
      });
      var host = p.url.replace(/^https?:\/\//i, '').split('/')[0];
      personalList.appendChild(
        el('li', { class: 'phrase' }, [
          el('div', { class: 'phrase-say' }, [
            el('span', { class: 'phrase-text', text: '“' + p.phrase + '”' }),
            el('span', { class: 'mono phrase-name', text: 'opens ' + host }),
          ]),
          el('p', { class: 'phrase-actions' }, [
            el('a', { class: 'btn btn--line', href: p.url, text: 'Open' }),
            remove,
          ]),
        ]),
      );
    });
  }

  if (personalForm) {
    personalForm.hidden = false;
    var personalEmpty = document.querySelector('[data-personal-empty]');
    if (personalEmpty) personalEmpty.remove();
    renderPersonal();
    personalForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var phrase = personalForm.elements.phrase.value.trim();
      var url = personalForm.elements.url.value.trim();
      if (!phrase || !/^https?:\/\//i.test(url)) return;
      if (!/^(hey|ok|okay|hi)\b/i.test(phrase)) phrase = 'Hey ' + phrase;
      addPhrase(phrase, url);
      personalForm.reset();
      renderPersonal();
      say('Added ' + phrase);
    });
  }

  /* -- the book the listener parses against -------------------------------- */

  function book() {
    var entries = personalPhrases().map(function (p) {
      return { phrase: p.phrase, aliases: [], to: { kind: 'url', url: p.url, name: keywordOf(p.phrase) } };
    });
    if (data && data.maker) entries.push({ phrase: data.maker.phrase, aliases: data.maker.aliases, to: 'maker' });
    if (data && data.targets) {
      data.targets.forEach(function (t) {
        entries.push({ phrase: t.phrase, aliases: t.aliases, to: { kind: 'target', target: t, name: t.name } });
      });
    }
    return entries;
  }

  function hrefOf(to) {
    if (to.kind === 'url') return { href: to.url, web: null };
    var t = to.target;
    var deep = platform === 'ios' ? t.ios : platform === 'android' ? t.android : null;
    return { href: deep || t.web, web: deep && t.web && deep !== t.web ? t.web : null };
  }

  /* Deep links fail silently when the app is not installed. If the page is
     still visible a moment later, nothing opened: fall back to the web. */
  function go(link) {
    if (!link.href) return false;
    location.href = link.href;
    if (link.web) {
      setTimeout(function () {
        if (!document.hidden) location.href = link.web;
      }, 1600);
    }
    return true;
  }

  /* -- the listener -------------------------------------------------------- */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micButton = document.querySelector('[data-listen]');
  var statusEl = document.querySelector('[data-status]');
  var heardEl = document.querySelector('[data-heard]');
  var makePanel = document.querySelector('[data-make-panel]');
  var makeHeard = document.querySelector('[data-make-heard]');
  var makeForm = document.querySelector('[data-make-form]');

  var wanted = false; // the person wants us listening
  var rec = null;
  var mode = 'command'; // or 'days'
  var pendingBrief = '';
  var onDays = null; // page-specific handler for a chosen number of days

  function status(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function showHeard(text) {
    if (!heardEl) return;
    heardEl.hidden = !text;
    heardEl.textContent = text;
  }

  function stopListening() {
    wanted = false;
    if (micButton) {
      micButton.setAttribute('aria-pressed', 'false');
      micButton.querySelector('.mic-label').textContent = 'Tap, then talk';
    }
    if (rec) {
      try {
        rec.stop();
      } catch (e) {
        /* already stopped */
      }
    }
  }

  function startListening() {
    if (!SR) return;
    wanted = true;
    if (micButton) {
      micButton.setAttribute('aria-pressed', 'true');
      micButton.querySelector('.mic-label').textContent = 'Listening…';
    }
    status(mode === 'days' ? 'Say three, seven, fourteen or thirty.' : 'Say “Hey Claude”, “Hey GPT”, or “Hey Maker, …”');
    spin();
  }

  function spin() {
    if (!wanted) return;
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    // iOS stops after each utterance whatever we ask; Android will run on.
    rec.continuous = platform !== 'ios';
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = function (event) {
      var last = event.results[event.results.length - 1];
      if (!last) return;
      var text = last[0].transcript;
      showHeard(text);
      if (last.isFinal) handle(text);
    };
    rec.onerror = function (event) {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopListening();
        status('The microphone is blocked for this site. Allow it in the browser’s site settings, then tap again.');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        status('Could not hear (' + event.error + '). Still listening.');
      }
    };
    rec.onend = function () {
      // Recognisers end on silence; restart while the person still wants us.
      if (wanted) setTimeout(spin, 250);
    };
    try {
      rec.start();
    } catch (e) {
      stopListening();
      status('Could not start listening in this browser.');
    }
  }

  function handle(text) {
    if (mode === 'days') {
      var d = parseDays(text);
      if (d) {
        chooseDays(d);
      } else if (/\b(cancel|never mind|stop|forget it)\b/i.test(text)) {
        cancelAsk();
      } else {
        status('Three, seven, fourteen or thirty days?');
      }
      return;
    }

    var cmd = parseCommand(text, book());
    if (cmd.kind === 'open') {
      var link = hrefOf(cmd.to);
      if (!link.href) {
        status(cmd.to.name + ' can only be opened from a phone.');
        return;
      }
      status('Opening ' + cmd.to.name + '…');
      say('Opening ' + cmd.to.name);
      stopListening();
      setTimeout(function () {
        go(link);
      }, 350);
    } else if (cmd.kind === 'make') {
      askDays(cmd.brief);
    } else {
      status('Heard “' + cmd.heard + '” — no phrase matched. Try “Hey Claude”.');
    }
  }

  /* -- the maker's one question -------------------------------------------- */

  function askDays(brief) {
    pendingBrief = brief;
    mode = 'days';
    if (makePanel) {
      makePanel.hidden = false;
      if (makeHeard) makeHeard.textContent = brief || 'an app';
      makePanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    status('Delete it in how many days? Say three, seven, fourteen or thirty.');
    say('Delete it in 3, 7, 14, or 30 days?');
    if (!wanted) startListening();
  }

  function cancelAsk() {
    mode = 'command';
    pendingBrief = '';
    if (makePanel) makePanel.hidden = true;
    status('Cancelled. Still listening.');
  }

  function chooseDays(days) {
    stopListening();
    if (onDays) {
      onDays(days);
      return;
    }
    if (!makeForm) return;
    makeForm.elements.brief.value = pendingBrief;
    var radio = makeForm.querySelector('input[name="days"][value="' + days + '"]');
    if (radio) radio.checked = true;
    status('Making it. Gone in ' + days + ' days.');
    say('Making it. It will delete itself in ' + days + ' days.');
    makeForm.submit();
  }

  document.querySelectorAll('[data-make-days]').forEach(function (button) {
    button.addEventListener('click', function () {
      chooseDays(Number(button.getAttribute('data-make-days')));
    });
  });
  var cancelButton = document.querySelector('[data-make-cancel]');
  if (cancelButton) cancelButton.addEventListener('click', cancelAsk);

  if (micButton) {
    if (SR) {
      micButton.disabled = false;
      status('Tap the microphone, then say “Hey Claude”, “Hey GPT”, or “Hey Maker, …”');
      micButton.addEventListener('click', function () {
        if (wanted) stopListening();
        else startListening();
      });
      // Nothing useful happens to a listener in a background tab except a
      // permission prompt nobody sees.
      document.addEventListener('visibilitychange', function () {
        if (document.hidden && wanted) stopListening();
      });
    } else {
      status('This browser cannot hear. On a phone use Safari (iPhone) or Chrome (Android); the phrases below still work with a tap.');
    }
  }

  /* -- apps made on this device -------------------------------------------- */

  function myApps() {
    var list = store.get(APPS_KEY, []);
    if (!Array.isArray(list)) return [];
    var now = Date.now();
    return list.filter(function (a) {
      return a && a.id && a.url && (!a.expiresAt || Date.parse(a.expiresAt) > now);
    });
  }

  function rememberApp(app) {
    var list = myApps().filter(function (a) {
      return a.id !== app.id;
    });
    list.unshift({ id: app.id, name: app.name, url: app.url, expiresAt: app.expiresAt });
    store.set(APPS_KEY, list.slice(0, 30));
  }

  function forgetApp(id) {
    store.set(
      APPS_KEY,
      myApps().filter(function (a) {
        return a.id !== id;
      }),
    );
  }

  var myAppsBox = document.querySelector('[data-my-apps]');
  var myAppsList = document.querySelector('[data-my-apps-list]');
  if (myAppsBox && myAppsList) {
    var apps = myApps();
    if (apps.length) {
      myAppsBox.hidden = false;
      apps.forEach(function (a) {
        var when = a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : '';
        myAppsList.appendChild(
          el('li', {}, [
            el('a', { href: a.url, text: a.name || 'App' }),
            el('span', { class: 'mono', text: when ? 'deletes ' + when : '' }),
          ]),
        );
      });
    }
  }

  /* -- a made app's page --------------------------------------------------- */

  var appRoot = document.querySelector('[data-app]');
  if (appRoot && data && data.app) {
    var appId = data.app.id;

    if (data.owner) rememberApp(data.app);

    // "Hey <name>" opens this app from now on, from this browser.
    var addPhraseButton = document.querySelector('[data-add-phrase]');
    if (addPhraseButton) {
      var phrase = addPhraseButton.getAttribute('data-add-phrase');
      var already = personalPhrases().some(function (p) {
        return p.url === data.app.url;
      });
      if (already) addPhraseButton.textContent = '“' + phrase + '” is in your phrases';
      addPhraseButton.addEventListener('click', function () {
        if (addPhrase(phrase, data.app.url)) {
          addPhraseButton.textContent = 'Added. Say “' + phrase + '” on the front page.';
          say('Added. Say ' + phrase + ' to open it.');
        }
      });
    }

    var deleteForm = document.querySelector('[data-delete-form]');
    if (deleteForm) {
      deleteForm.addEventListener('submit', function (event) {
        if (!confirm('Delete this app now? Its link stops working immediately.')) event.preventDefault();
        else forgetApp(appId);
      });
    }

    // Keep-row: mark the current answer and, right after making, ask aloud.
    var askStatus = document.querySelector('[data-ask-status]');
    var keepButtons = document.querySelectorAll('[data-keep]');
    onDays = function (days) {
      var button = document.querySelector('[data-keep="' + days + '"]');
      if (!button) return;
      say('Deleting in ' + days + ' days.');
      button.form.submit();
    };
    if (appRoot.hasAttribute('data-ask-days') && SR && keepButtons.length) {
      mode = 'days';
      statusEl = askStatus;
      status('Delete it in how many days? Say three, seven, fourteen or thirty, or tap one.');
      say('Made. Delete it in 3, 7, 14, or 30 days?');
      // Starting the microphone needs a gesture on most phones; the one that
      // submitted the form usually still counts. If it does not, the buttons are right there.
      try {
        startListening();
      } catch (e) {
        /* the buttons are right there */
      }
      history.replaceState(null, '', location.pathname);
    }

    // Checklist: ticks stay ticked on this device.
    document.querySelectorAll('[data-checklist]').forEach(function (block, blockIndex) {
      var key = 'hey.app.' + appId + '.checks.' + blockIndex;
      var ticked = store.get(key, []);
      block.querySelectorAll('[data-check]').forEach(function (box) {
        var i = Number(box.getAttribute('data-check'));
        box.checked = ticked.indexOf(i) !== -1;
        box.addEventListener('change', function () {
          var now = store.get(key, []).filter(function (n) {
            return n !== i;
          });
          if (box.checked) now.push(i);
          store.set(key, now);
        });
      });
    });

    // Flashcards: shuffle and hide-all.
    document.querySelectorAll('[data-flashcards]').forEach(function (block) {
      var actions = block.querySelector('[data-flash-actions]');
      var list = block.querySelector('.cards');
      if (!actions || !list) return;
      actions.hidden = false;
      actions.querySelector('[data-shuffle]').addEventListener('click', function () {
        var items = Array.prototype.slice.call(list.children);
        for (var i = items.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = items[i];
          items[i] = items[j];
          items[j] = t;
        }
        items.forEach(function (item) {
          item.querySelector('details').open = false;
          list.appendChild(item);
        });
      });
      actions.querySelector('[data-hide-all]').addEventListener('click', function () {
        list.querySelectorAll('details').forEach(function (d) {
          d.open = false;
        });
      });
    });

    // Timer.
    document.querySelectorAll('[data-timer]').forEach(function (block) {
      var minutes = Number(block.getAttribute('data-timer')) || 1;
      var face = block.querySelector('[data-timer-face]');
      var actions = block.querySelector('[data-timer-actions]');
      var nojs = block.querySelector('[data-timer-nojs]');
      var startButton = block.querySelector('[data-timer-start]');
      var resetButton = block.querySelector('[data-timer-reset]');
      if (!face || !actions) return;
      actions.hidden = false;
      if (nojs) nojs.hidden = true;

      var remaining = minutes * 60;
      var tick = null;

      function paint() {
        var m = Math.floor(remaining / 60);
        var s = remaining % 60;
        face.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      }
      function stop() {
        if (tick) clearInterval(tick);
        tick = null;
        startButton.textContent = remaining === minutes * 60 ? 'Start' : 'Resume';
      }
      startButton.addEventListener('click', function () {
        if (tick) {
          stop();
          startButton.textContent = 'Resume';
          return;
        }
        block.classList.remove('is-done');
        startButton.textContent = 'Pause';
        tick = setInterval(function () {
          remaining -= 1;
          paint();
          if (remaining <= 0) {
            stop();
            block.classList.add('is-done');
            startButton.textContent = 'Start';
            remaining = minutes * 60;
            say('Time.');
            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
          }
        }, 1000);
      });
      resetButton.addEventListener('click', function () {
        stop();
        remaining = minutes * 60;
        block.classList.remove('is-done');
        startButton.textContent = 'Start';
        paint();
      });
      paint();
    });

    // Photos: kept in this browser, shrunk so a few of them fit.
    document.querySelectorAll('[data-photos]').forEach(function (block, blockIndex) {
      var key = 'hey.app.' + appId + '.photos.' + blockIndex;
      var saved = store.get(key, {});

      function show(slot, dataUrl) {
        var li = block.querySelector('[data-slot="' + slot + '"]');
        if (!li) return;
        var old = li.querySelector('img');
        if (old) old.remove();
        var oldRemove = li.querySelector('.photo-remove');
        if (oldRemove) oldRemove.remove();
        if (!dataUrl) {
          li.classList.remove('has-photo');
          return;
        }
        var img = el('img', { src: dataUrl, alt: 'Photo ' + (slot + 1) });
        var remove = el('button', { type: 'button', class: 'photo-remove', text: 'remove' });
        remove.addEventListener('click', function () {
          delete saved[slot];
          store.set(key, saved);
          show(slot, null);
        });
        li.classList.add('has-photo');
        li.appendChild(img);
        li.appendChild(remove);
      }

      Object.keys(saved).forEach(function (slot) {
        show(Number(slot), saved[slot]);
      });

      block.querySelectorAll('[data-photo-input]').forEach(function (input) {
        var slot = Number(input.getAttribute('data-photo-input'));
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (!file) return;
          shrink(file, 1024, function (dataUrl) {
            saved[slot] = dataUrl;
            if (!store.set(key, saved)) {
              say('This browser is out of room for pictures.');
              delete saved[slot];
              return;
            }
            show(slot, dataUrl);
          });
        });
      });
    });
  }

  function shrink(file, max, done) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, max / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      done(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
})();
