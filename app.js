import { THEMED } from './packs.js';
import { Memory } from './memory.js';

// ---------------------------------------------------------------- Rules of the game

const WORD_VALUE = 100;
const DOUBLE_VALUE = 200;
const SPEED_BONUS = 1000;
/** The speed bonus needs at least one correct word per this many seconds of the round. */
const SPEED_BONUS_SECONDS_PER_WORD = 8;
const MIN_DURATION = 30;
const MAX_DURATION = 300;
const DURATION_STEP = 15;
const RECOMMENDED_DURATION = 90;
const URGENT_SECONDS = 10;
const EVERYTHING_ID = 'everything';

export const dollars = n => '$' + n.toLocaleString('en-US');
export const formatTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const RULES = [
  'Pick one player to be the GUESSER. Turn the phone away from them!',
  'Everyone else sees the word. Together, build a question whose answer is that word, taking turns, ONE WORD each.',
  'When the question is ready, slam the red BUZZER. Now the guesser may answer.',
  'Right answer? Tap CORRECT for $100. Wrong? Keep building the question, or SKIP the word.',
  'Words are worth DOUBLE in the last 10 seconds. Average a word every 8 seconds for a $1,000 bonus!',
];

// ---------------------------------------------------------------- Word packs

const isUnlocked = pack => pack.price === 0 || prefs.unlocked.includes(pack.id);

/** The mixed pack draws from every unlocked themed pack (the easy Kids pack excluded). */
function everything() {
  const words = THEMED.filter(p => p.id !== 'kids' && isUnlocked(p)).flatMap(p => p.words);
  return { id: EVERYTHING_ID, name: 'Everything', emoji: '🎲', price: 0, words: [...new Set(words)] };
}
const allPacks = () => [everything(), ...THEMED];
/** The chosen pack if it is playable, otherwise the mixed pack. */
const chosenPack = () => allPacks().find(p => p.id === prefs.pack && isUnlocked(p)) ?? everything();

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- Saved progress (this browser only)

const STORE_KEY = 'wordchain';
const prefs = {
  pack: EVERYTHING_ID,
  duration: RECOMMENDED_DURATION,
  record: true,
  firstRunDone: false,
  memoryPromptDismissed: false,
  bank: 0,
  unlocked: [],
  best: {},
  ...loadPrefs(),
};
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* private mode: progress lasts this visit */ }
}

// ---------------------------------------------------------------- Sound

const memory = new Memory();

/** Every effect the game plays; ducks: false keeps it at full volume while a memory is filmed. */
const SOUNDS = {
  tick: { file: 'tick', volume: 0.8 },
  tickUrgent: { file: 'tick', rate: 1.3 },
  buzz: { file: 'buzz', ducks: false },
  correct: { file: 'correct' },
  wrong: { file: 'wrong' },
  skip: { file: 'skip' },
  beep: { file: 'beep' },
  go: { file: 'go' },
  timesup: { file: 'timesup' },
  tap: { file: 'tap' },
  fanfare: { file: 'fanfare' },
  unlock: { file: 'unlock' },
};
/** Game sounds play this quietly while a memory is filmed, so the mic hears the players instead. */
const RECORDING_SFX_GAIN = 0.25;

const audio = new (window.AudioContext || window.webkitAudioContext)();
const buffers = {};
for (const file of new Set(Object.values(SOUNDS).map(s => s.file))) {
  fetch(`sounds/${file}.wav`)
    .then(r => r.arrayBuffer())
    .then(b => audio.decodeAudioData(b))
    .then(buf => { buffers[file] = buf; })
    .catch(() => {});
}
// Browsers only start audio from a user gesture.
for (const ev of ['pointerdown', 'touchend', 'keydown']) {
  document.addEventListener(ev, () => { if (audio.state !== 'running') audio.resume(); }, { capture: true });
}

function play(name) {
  const def = SOUNDS[name];
  const buf = buffers[def.file];
  if (!buf) return;
  const src = audio.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = def.rate ?? 1;
  const gain = audio.createGain();
  const duck = def.ducks !== false && memory.recording ? RECORDING_SFX_GAIN : 1;
  gain.gain.value = (def.volume ?? 1) * duck;
  src.connect(gain).connect(audio.destination);
  src.start();
}

const vibrate = ms => navigator.vibrate?.(ms);

// ---------------------------------------------------------------- Screen on during play

let wakeLock = null;
let wantAwake = false;
async function keepAwake(on) {
  wantAwake = on;
  if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not allowed here; the screen may dim */ }
  } else if (!on && wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => { if (wantAwake) keepAwake(true); });

// ---------------------------------------------------------------- DOM helpers

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const text = (cls, content, style = '') => h('div', { class: cls, style }, content);

function button(label, onClick, { cls = '', height = 64, size = 30, sound = 'tap' } = {}) {
  return h('button', {
    class: `btn ${cls}`,
    style: `--h:${height}px;--size:${size}px`,
    onclick: () => { if (sound) play(sound); onClick(); },
  }, label);
}

function link(label, onClick) {
  return h('button', { class: 'link', onclick: () => { play('tap'); onClick(); } }, label);
}

/** Dimmed scrim with a gold-framed tile; tapping outside calls onDismiss when given. */
function dialog(onDismiss, ...kids) {
  const card = h('div', { class: 'tile gold-frame dialog', onclick: e => e.stopPropagation() }, ...kids);
  return h('div', { class: 'scrim', onclick: () => onDismiss?.() }, card);
}

/** Shrinks a single-line element until it fits its parent's width. */
function fitText(el, max, min) {
  let size = max;
  el.style.fontSize = size + 'px';
  const avail = el.parentElement.clientWidth;
  while (size > min && el.offsetWidth > avail) {
    size -= 2;
    el.style.fontSize = size + 'px';
  }
}

const app = document.getElementById('app');
let current = null;

/** Replaces the screen; cleanup runs when the next screen takes over. */
function mount(cls, kids, { cleanup, awake = false } = {}) {
  current?.cleanup?.();
  const el = h('section', { class: `screen ${cls}` }, h('div', { class: 'col' }, ...kids));
  app.replaceChildren(el);
  current = { el, cleanup };
  keepAwake(awake);
  return el;
}

// ---------------------------------------------------------------- App state

let firstRun = !prefs.firstRunDone;

function goHome() {
  memory.discard();
  showHome();
}

function startRound() {
  const round = {
    pack: firstRun ? everything() : chosenPack(),
    duration: firstRun ? RECOMMENDED_DURATION : prefs.duration,
    // Read by the memory every frame to burn the clock and word into the video.
    phase: 'ready',
    secondsLeft: 0,
    word: '',
    total: 0,
  };
  round.secondsLeft = round.duration;
  memory.discard();
  if (prefs.record && !firstRun) memory.start(round);
  showCountdown(round);
}

// ---------------------------------------------------------------- Home

function showHome() {
  let el;
  const bankValue = text('anton pop', dollars(prefs.bank), 'font-size:26px');
  const grid = h('div', { class: 'pack-grid' });

  function renderGrid() {
    const selected = chosenPack().id;
    grid.replaceChildren(...allPacks().map(pack => {
      const open = isUnlocked(pack);
      return h('button', {
        class: `tile pack${pack.id === selected ? ' selected' : ''}${open ? '' : ' locked'}`,
        onclick: () => {
          play('tap');
          if (open) { prefs.pack = pack.id; savePrefs(); renderGrid(); } else el.append(unlockDialog(pack));
        },
      },
      text('emoji', pack.emoji),
      text('name', pack.name.toUpperCase()),
      open
        ? text('meta dim', `${pack.words.length} WORDS`)
        : text('meta gold', `🔒 ${dollars(pack.price)}`));
    }));
  }

  function unlockDialog(pack) {
    const close = () => d.remove();
    const canAfford = prefs.bank >= pack.price;
    const d = dialog(close,
      text('', pack.emoji, 'font-size:44px'),
      text('anton gold', pack.name.toUpperCase(), 'font-size:34px'),
      text('bebas dim', `${pack.words.length} WORDS`, 'font-size:16px;letter-spacing:3px'),
      canAfford
        ? [
          button(`UNLOCK FOR ${dollars(pack.price)}`, () => {
            prefs.bank -= pack.price;
            prefs.unlocked = [...prefs.unlocked, pack.id];
            prefs.pack = pack.id;
            savePrefs();
            close();
            bankValue.textContent = dollars(prefs.bank);
            renderGrid();
          }, { height: 62, size: 26, sound: 'unlock' }),
          link('NOT NOW', close),
        ]
        : [
          text('bebas', `COSTS ${dollars(pack.price)}`, 'font-size:22px;letter-spacing:3px'),
          text('bebas red', `YOU NEED ${dollars(pack.price - prefs.bank)} MORE`, 'font-size:18px;letter-spacing:3px'),
          button('KEEP EARNING', close, { height: 60, size: 26 }),
        ]);
    return d;
  }

  const timeValue = text('anton', formatTime(prefs.duration), 'font-size:52px;line-height:1.15');
  const recommended = text('bebas gold', '', 'font-size:16px;letter-spacing:3px;min-height:18px');
  const minus = h('button', { class: 'round-btn', onclick: () => step(-DURATION_STEP) }, '–');
  const plus = h('button', { class: 'round-btn', onclick: () => step(DURATION_STEP) }, '+');
  function renderDuration() {
    timeValue.textContent = formatTime(prefs.duration);
    recommended.textContent = prefs.duration === RECOMMENDED_DURATION ? 'RECOMMENDED' : '';
    minus.disabled = prefs.duration <= MIN_DURATION;
    plus.disabled = prefs.duration >= MAX_DURATION;
  }
  function step(delta) {
    play('tap');
    prefs.duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, prefs.duration + delta));
    savePrefs();
    renderDuration();
  }

  const toggle = h('button', {
    class: 'toggle-row',
    onclick: async () => {
      play('tap');
      prefs.record = prefs.record ? false : await memory.requestPermission();
      savePrefs();
      renderToggle();
    },
  }, text('', '🎥', 'font-size:20px;text-shadow:none'), h('span', {}, 'SAVE A MEMORY'), h('div', { class: 'switch' }));
  function renderToggle() {
    toggle.classList.toggle('on', prefs.record);
    toggle.classList.toggle('off', !prefs.record);
  }

  async function play_(withMemory) {
    prefs.record = withMemory ? await memory.requestPermission() : false;
    savePrefs();
    showRules();
  }

  function memoryPrompt() {
    let dontShowAgain = true;
    const box = text('check-box on', '✓');
    const done = withMemory => {
      prefs.memoryPromptDismissed = dontShowAgain;
      savePrefs();
      d.remove();
      play_(withMemory);
    };
    const d = dialog(null,
      text('', '🎥', 'font-size:44px'),
      text('anton gold', 'MAKE A MEMORY?', 'font-size:34px'),
      text('body-text',
        'Word Chain can film your team with the front camera while you play. When the round ends you get ' +
        'a replay with the clock and the words on it, ready to share.'),
      text('body-text',
        'It uses the camera and microphone only during the round, and nothing leaves your phone unless you share it.'),
      h('button', {
        class: 'check-row',
        onclick: () => {
          play('tap');
          dontShowAgain = !dontShowAgain;
          box.classList.toggle('on', dontShowAgain);
          box.textContent = dontShowAgain ? '✓' : '';
        },
      }, box, "DON'T SHOW THIS AGAIN"),
      button('YES, FILM US', () => done(true), { height: 62, size: 28 }),
      link('PLAY WITHOUT A MEMORY', () => done(false)));
    return d;
  }

  function tour() {
    const row = (icon, words) => h('div', { class: 'tour-row' }, text('icon', icon), text('body-text', words, 'flex:1'));
    const d = dialog(null,
      text('anton gold', 'WELCOME TO THE STUDIO', 'font-size:32px'),
      row('🎲', 'Pick a word pack. Cash you win here unlocks more packs.'),
      row('⏱', 'Set the round length. 1:30 is the sweet spot.'),
      row('🎥', 'Save a memory: film your team with the front camera and share the replay.'),
      button('GOT IT', () => {
        firstRun = false;
        prefs.firstRunDone = true;
        savePrefs();
        d.remove();
      }, { height: 62, size: 28 }));
    return d;
  }

  el = mount('home', [
    text('anton gold', 'WORD CHAIN', 'font-size:60px;letter-spacing:4px;margin-top:14px;line-height:1.15'),
    text('bebas', 'THE PARTY GAME SHOW', 'font-size:22px;letter-spacing:5px'),
    h('div', { class: 'bank-chip', style: 'margin-top:10px' }, text('bebas gold', 'BANK', 'font-size:18px;letter-spacing:4px'), bankValue),
    text('label', 'CHOOSE A WORD PACK', 'margin-top:10px'),
    grid,
    text('label', 'ROUND LENGTH'),
    h('div', { class: 'stepper' }, minus, h('div', { class: 'value' }, timeValue, recommended), plus),
    toggle,
    h('div', { style: 'width:100%;margin:8px 0 16px' }, button('PLAY', () => {
      if (!prefs.memoryPromptDismissed && Memory.supported()) el.append(memoryPrompt());
      else play_(prefs.record);
    }, { height: 74, size: 40 })),
  ]);
  renderGrid();
  renderDuration();
  renderToggle();
  if (!Memory.supported()) toggle.hidden = true;
  if (firstRun) el.append(tour());
}

// ---------------------------------------------------------------- Rules

function showRules() {
  mount('rules-screen', [
    h('div', { class: 'spacer' }),
    firstRun
      ? [
        text('anton gold', 'WORD CHAIN', 'font-size:54px;letter-spacing:4px'),
        text('bebas', "HERE'S HOW TO PLAY", 'font-size:22px;letter-spacing:5px'),
      ]
      : text('anton gold', 'HOW TO PLAY', 'font-size:48px;letter-spacing:3px'),
    h('div', { class: 'tile gold-frame rules', style: 'margin-top:20px' },
      RULES.map((rule, i) => h('div', { class: 'rule' }, text('n', String(i + 1)), text('body-text', rule, 'flex:1')))),
    h('div', { style: 'width:100%;margin-top:28px' },
      button(firstRun ? "I'M READY!" : "LET'S PLAY", startRound, { height: 70, size: 34 })),
    firstRun ? null : link('BACK', showHome),
    h('div', { class: 'spacer' }),
  ]);
}

// ---------------------------------------------------------------- Countdown

function showCountdown(round) {
  const timers = [];
  let done = false;
  let n = 5;
  let num = text('anton count-num', '5');
  const setN = v => {
    n = v;
    const fresh = text(`anton count-num${v > 0 ? '' : ' gold'}`, v > 0 ? String(v) : 'GO!');
    num.replaceWith(fresh);
    num = fresh;
  };
  const finish = () => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    showGame(round);
  };
  const el = mount('countdown', [
    text('bebas gold', 'GET READY', 'font-size:30px;letter-spacing:6px'),
    num,
    text('bebas dim', 'TAP TO SKIP', 'position:absolute;bottom:calc(36px + env(safe-area-inset-bottom));font-size:20px;letter-spacing:4px'),
  ], { cleanup: () => timers.forEach(clearTimeout), awake: true });
  el.addEventListener('click', () => { if (n > 0) play('go'); finish(); });
  play('beep');
  for (let i = 4; i >= 1; i--) timers.push(setTimeout(() => { setN(i); play('beep'); }, (5 - i) * 1000));
  timers.push(setTimeout(() => { setN(0); play('go'); }, 5000));
  timers.push(setTimeout(finish, 5800));
}

// ---------------------------------------------------------------- Game

function showGame(round) {
  const { pack, duration } = round;
  let queue = [];
  const nextWord = () => {
    if (!queue.length) queue = shuffled(pack.words);
    return queue.pop();
  };
  const results = [];
  let buzzed = false;
  let finished = false;
  let timer = null;
  let quit = null;

  round.phase = 'play';
  round.word = nextWord();
  round.secondsLeft = duration;
  const start = performance.now();

  const clock = text('anton gold clock', formatTime(duration));
  const cash = text('anton', '$0', 'font-size:34px');
  const doubleTag = text('bebas double-tag', 'DOUBLE!');
  doubleTag.hidden = true;
  const bar = h('div', { style: 'width:100%' });
  const progress = h('div', { class: 'progress' }, bar);
  const wordTile = h('div', { class: 'tile word-tile' });
  const buzzArea = h('div', { class: 'buzz-area' });
  const topLeft = h('div', { class: 'top-left' },
    h('button', { class: 'close-btn', onclick: () => { play('tap'); confirmQuit(); } }, '✕'));

  memory.ready.then(ok => {
    if (!ok || finished || !memory.stream) return;
    // A small live view of what the memory camera sees.
    const v = h('video', { playsinline: true, autoplay: true });
    v.muted = true;
    v.srcObject = memory.stream;
    topLeft.append(h('div', { class: 'peek' }, v));
    v.play().catch(() => {});
  });

  const col = Math.min(520, window.innerWidth) - 40;
  const buzzSize = Math.round(Math.min(300, col - 16, window.innerHeight * 0.36));
  const buzzHeight = buzzSize + 14;
  buzzArea.style.height = buzzHeight + 'px';

  function setWord() {
    const w = text('anton word', round.word.toUpperCase());
    wordTile.replaceChildren(w);
    fitText(w, 112, 28);
  }

  function renderBuzz() {
    if (!buzzed) {
      buzzArea.replaceChildren(h('button', {
        class: 'buzzer',
        style: `width:${buzzSize}px;height:${buzzSize}px;font-size:${Math.round(buzzSize * 0.27)}px;margin-bottom:14px`,
        onpointerdown: e => {
          e.preventDefault();
          if (buzzed || finished) return;
          buzzed = true;
          play('buzz');
          vibrate(60);
          setTimeout(renderBuzz, 90);
        },
      }, 'BUZZ'));
    } else {
      const bh = Math.round((buzzHeight - 12) / 2 - 6);
      buzzArea.replaceChildren(h('div', { class: 'answer-buttons' },
        button('CORRECT', correct, { cls: 'green', height: bh, size: 46, sound: 'correct' }),
        button('WRONG', () => { buzzed = false; renderBuzz(); }, { cls: 'red', height: bh, size: 46, sound: 'wrong' })));
    }
  }

  function advance() {
    buzzed = false;
    round.word = nextWord();
    setWord();
    renderBuzz();
  }

  function correct() {
    if (finished) return;
    vibrate(40);
    const value = round.secondsLeft <= URGENT_SECONDS ? DOUBLE_VALUE : WORD_VALUE;
    results.push({ word: round.word, correct: true, dollars: value });
    const fresh = text('anton pop', dollars(results.reduce((t, r) => t + r.dollars, 0)), 'font-size:34px;--from:1.5');
    cash.replaceChildren(fresh);
    advance();
  }

  function skip() {
    if (finished) return;
    results.push({ word: round.word, correct: false, dollars: 0 });
    advance();
  }

  function confirmQuit() {
    if (finished || quit) return;
    const close = () => { quit.remove(); quit = null; };
    quit = dialog(close,
      text('anton gold', 'END THE ROUND?', 'font-size:36px'),
      button('KEEP PLAYING', close, { height: 60, size: 26 }),
      button('END ROUND', goHome, { cls: 'red', height: 60, size: 26 }));
    el.append(quit);
  }

  function tick(s) {
    round.secondsLeft = s;
    const urgent = s <= URGENT_SECONDS;
    clock.textContent = formatTime(s);
    clock.classList.toggle('urgent', urgent);
    clock.classList.toggle('gold', !urgent);
    doubleTag.hidden = !urgent;
    progress.classList.toggle('urgent', urgent);
    bar.style.width = (s / duration) * 100 + '%';
    if (s > 0) {
      play(urgent ? 'tickUrgent' : 'tick');
      schedule(s - 1);
    } else {
      end();
    }
  }

  function schedule(s) {
    const target = start + (duration - s) * 1000;
    timer = setTimeout(() => tick(s), Math.max(0, target - performance.now()));
  }

  function end() {
    finished = true;
    round.phase = 'over';
    quit?.remove();
    play('timesup');
    vibrate(300);
    el.append(h('div', { class: 'scrim', style: 'z-index:20' }, text('anton gold count-num', "TIME'S UP!", 'font-size:72px;--from:0.3')));
    timer = setTimeout(() => finishRound(round, results), 1700);
  }

  const el = mount('game', [
    h('div', { class: 'top-bar' }, topLeft, clock,
      h('div', { class: 'top-right' }, text('bebas gold', 'CASH', 'font-size:14px;letter-spacing:3px'), cash), doubleTag),
    h('div', { style: 'height:6px' }),
    progress,
    h('div', { class: 'spacer' }),
    wordTile,
    h('div', { class: 'spacer' }),
    buzzArea,
    h('div', { style: 'height:22px' }),
    h('button', { class: 'skip-btn', onclick: () => { play('skip'); skip(); } }, 'SKIP'),
    h('div', { style: 'height:20px' }),
  ], { cleanup: () => clearTimeout(timer), awake: true });

  setWord();
  renderBuzz();
  schedule(duration - 1);
}

// ---------------------------------------------------------------- Results

function finishRound(round, results) {
  const score = results.filter(r => r.correct).length;
  const earned = results.reduce((t, r) => t + r.dollars, 0);
  const speedBonus = score > 0 && score * SPEED_BONUS_SECONDS_PER_WORD >= round.duration ? SPEED_BONUS : 0;
  const total = earned + speedBonus;
  round.total = total;
  const memoryResult = memory.active ? memory.finish() : null;

  prefs.bank += total;
  const key = `${round.pack.id}_${round.duration}`;
  const previousBest = prefs.best[key] ?? 0;
  const isNewBest = total > previousBest;
  if (isNewBest) prefs.best[key] = total;
  savePrefs();

  showResults({
    results, score, speedBonus, total, isNewBest,
    doubles: results.filter(r => r.dollars === DOUBLE_VALUE).length,
    best: Math.max(previousBest, total),
  }, memoryResult);
}

function showResults(sum, memoryResult) {
  let left = false;
  play('fanfare');

  const totalEl = text('anton pop', dollars(sum.total), '--from:0.2;white-space:nowrap');
  const words = sum.score === 1 ? '1 WORD' : `${sum.score} WORDS`;
  const scoreTile = h('div', { class: 'tile gold-frame score-tile' },
    totalEl,
    text('bebas', words + (sum.doubles ? ` · ${sum.doubles} DOUBLE` : ''), 'margin-top:4px'),
    sum.speedBonus ? text('bebas gold', `SPEED BONUS +${dollars(sum.speedBonus)}`) : null,
    text(`bebas ${sum.isNewBest ? 'gold' : 'dim'}`, sum.isNewBest ? '★ NEW BEST! ★' : `BEST: ${dollars(sum.best)}`, 'margin-top:6px;font-size:15px'),
    text('bebas gold', `BANK ${dollars(prefs.bank)}`, 'font-size:15px'));

  const top = h('div', { class: 'results-top' }, scoreTile);
  if (memoryResult) {
    const saving = h('div', { class: 'memory-card saving' }, text('bebas dim', 'SAVING\nMEMORY', 'white-space:pre;font-size:18px;letter-spacing:3px;line-height:24px'));
    top.append(saving);
    memoryResult.then(clip => {
      if (left) return;
      if (!clip) { saving.remove(); return; }
      const card = h('button', { class: 'memory-card', onclick: () => { play('tap'); el.append(playback(clip)); } },
        h('video', { src: clip.url, muted: true, loop: true, autoplay: true, playsinline: true }),
        h('div', { class: 'play-badge' }),
        text('bebas gold', 'MEMORY', 'margin-top:6px;font-size:18px;letter-spacing:4px'));
      const v = card.querySelector('video');
      v.muted = true;
      v.play().catch(() => {});
      saving.replaceWith(card);
    });
  }

  const list = h('div', { class: 'word-list' },
    sum.results.length === 0
      ? text('bebas dim', 'NO WORDS THIS ROUND', 'font-size:22px;letter-spacing:3px;padding-top:20px')
      : sum.results.map(r => h('div', { class: 'result-row' },
        h('span', { class: `w${r.correct ? '' : ' dim'}` }, r.word.toUpperCase()),
        r.correct
          ? [r.dollars === DOUBLE_VALUE ? h('span', { class: 'small red' }, '×2') : null, h('span', { class: 'gold' }, dollars(r.dollars))]
          : h('span', { class: 'small dim' }, 'SKIPPED'))));

  const buttons = firstRun
    ? h('div', { class: 'button-row' }, button('CONTINUE', goHome, { height: 66 }))
    : h('div', { class: 'button-row' },
      h('div', { style: 'flex:1' }, button('HOME', goHome, { cls: 'blue', height: 66 })),
      h('div', { style: 'flex:1.4' }, button('PLAY AGAIN', startRound, { height: 66 })));

  const el = mount('results', [
    text('anton gold', "TIME'S UP!", 'font-size:50px;letter-spacing:3px;margin-top:16px'),
    h('div', { style: 'height:12px' }),
    top,
    list,
    buttons,
    h('div', { style: 'height:16px' }),
  ], { cleanup: () => { left = true; }, awake: true });
  fitText(totalEl, 84, 28);
}

/** Full-screen replay with sound; the word and clock are already burned into the video. */
function playback(clip) {
  const video = h('video', { src: clip.url, loop: true, autoplay: true, playsinline: true });
  const note = text('note', '');
  const close = () => { video.pause(); view.remove(); };
  const view = h('div', { class: 'playback' },
    video,
    h('button', { class: 'close-btn', onclick: () => { play('tap'); close(); } }, '✕'),
    h('div', { class: 'bar' },
      button('SHARE MEMORY', async () => { note.textContent = await memory.share(clip); }, { height: 64, size: 30 }),
      note));
  video.play().catch(() => {});
  return view;
}

// ---------------------------------------------------------------- Start

if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

await Promise.all([document.fonts.load('40px Anton'), document.fonts.load('40px Bebas')]).catch(() => {});
if (firstRun) showRules(); else showHome();
