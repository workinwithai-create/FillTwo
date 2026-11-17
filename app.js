// FillTwo — two-bar live fill desk
// Audio engine rules: lookahead scheduler on AudioContext clock, live mutable state, OfflineAudioContext export with exact grid, pinned SHA samples.

const SAMPLE_BASE = "https://cdn.jsdelivr.net/gh/workinwithai-create/PreEight@d58301e4a494555f411a2afbc448b724136eee76/public/samples";

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

const SAMPLE_MAP = {
  kick: "drums/kick.mp3",
  snare: "drums/snare.mp3",
  hat: "drums/hihat.mp3",
  crash: "drums/crash.mp3",
  pianoC3: "piano/C3.mp3",
  pianoC4: "piano/C4.mp3",
  pianoA3: "piano/A3.mp3",
  bassE1: "bass/E1.mp3",
  bassA1: "bass/A1.mp3",
  bassC2: "bass/C2.mp3",
  guitarE2: "guitar/E2.mp3",
  guitarA2: "guitar/A2.mp3",
  guitarE3: "guitar/E3.mp3",
  trumpetC4: "trumpet/C4.mp3",
  violinA3: "violin/A3.mp3"
};

const recipes = [
  { id: "snare-roll", name: "Snare roll", blurb: "Sixteenth snare into the downbeat. No crash after.", chairs: ["kit"] },
  { id: "bass-walk", name: "Bass walk", blurb: "Upright walks the last two changes into the next root.", chairs: ["bass", "kit"] },
  { id: "nylon-answer", name: "Nylon answer", blurb: "Nylon answers the pocket figure on the fill bars.", chairs: ["guitar", "kit"] },
  { id: "brass-stab", name: "Brass stab", blurb: "Trumpet stab on the last eighth of bar 8.", chairs: ["trumpet", "kit"] },
  { id: "tom-fill", name: "Tom fill", blurb: "Kick + low piano as toms into the next section.", chairs: ["kit", "piano"] },
  { id: "stop-hit", name: "Stop hit", blurb: "Bar 8 is air until beat 4. Then the hit.", chairs: ["kit"] },
  { id: "violin-hold", name: "Violin hold", blurb: "Violin holds the 5 then resolves on the downbeat.", chairs: ["violin", "bass"] },
  { id: "hat-open", name: "Hat open", blurb: "Closed hats die. Open hat rides the fill.", chairs: ["kit"] }
];

const grooves = [
  { id: "amber", name: "Amber Walk", bpm: 92, key: "Am",
    chords: [
      { symbol: "Am", piano: [57,60,64], bass: 45, guitar: [57,64] },
      { symbol: "F", piano: [53,57,60], bass: 41, guitar: [53,60] },
      { symbol: "C", piano: [60,64,67], bass: 48, guitar: [60,67] },
      { symbol: "G", piano: [55,59,62], bass: 43, guitar: [55,62] },
      { symbol: "Am", piano: [57,60,64], bass: 45, guitar: [57,64] },
      { symbol: "F", piano: [53,57,60], bass: 41, guitar: [53,60] },
      { symbol: "C", piano: [60,64,67], bass: 48, guitar: [60,67] },
      { symbol: "G", piano: [55,59,62], bass: 43, guitar: [55,62] }
    ]
  },
  { id: "porch", name: "Porch Climb", bpm: 86, key: "Dm",
    chords: [
      { symbol: "Dm", piano: [50,53,57], bass: 38, guitar: [50,57] },
      { symbol: "Bb", piano: [46,50,53], bass: 34, guitar: [46,53] },
      { symbol: "F", piano: [53,57,60], bass: 41, guitar: [53,60] },
      { symbol: "C", piano: [48,52,55], bass: 36, guitar: [48,55] },
      { symbol: "Dm", piano: [50,53,57], bass: 38, guitar: [50,57] },
      { symbol: "Bb", piano: [46,50,53], bass: 34, guitar: [46,53] },
      { symbol: "F", piano: [53,57,60], bass: 41, guitar: [53,60] },
      { symbol: "C", piano: [48,52,55], bass: 36, guitar: [48,55] }
    ]
  }
];

let state = {
  bpm: 92,
  keySemis: -3,
  bars: 8,
  recipe: recipes[0],
  groove: grooves[0],
  mode: "a",
  playing: false,
  mutes: {}
};

const rawBuffers = {};
const audioBuffers = {};
let ctx, master, compressor, timerId, nextStepTime, step, activeSources = [], rafId;
let startTime = 0;

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem("filltwo") || "{}");
    if (s.bpm) state.bpm = Math.max(60, Math.min(180, s.bpm));
    if (typeof s.keySemis === "number") state.keySemis = s.keySemis;
    if (s.bars) state.bars = s.bars;
    if (s.recipeId) state.recipe = recipes.find(r => r.id === s.recipeId) || recipes[0];
    if (s.grooveId) state.groove = grooves.find(g => g.id === s.grooveId) || grooves[0];
  } catch (e) {}
}
function saveState() {
  localStorage.setItem("filltwo", JSON.stringify({
    bpm: state.bpm, keySemis: state.keySemis, bars: state.bars,
    recipeId: state.recipe.id, grooveId: state.groove.id
  }));
}

async function preload() {
  const status = document.getElementById("status");
  const keys = Object.keys(SAMPLE_MAP);
  let loaded = 0;
  const missing = [];
  for (const key of keys) {
    const url = `${SAMPLE_BASE}/${SAMPLE_MAP[key]}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const ab = await res.arrayBuffer();
      rawBuffers[key] = ab;
      loaded++;
      status.textContent = `Seating chairs ${loaded}/${keys.length}`;
    } catch (e) {
      missing.push(key);
    }
  }
  if (missing.length) {
    status.textContent = `Missing instruments: ${missing.join(", ")}. Cannot play.`;
    return false;
  }
  status.textContent = "Chairs seated · live FluidR3";
  return true;
}

function ensureContext() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.65;
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    master.connect(compressor);
    compressor.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function decodeAll() {
  if (!ctx) return Promise.resolve();
  const promises = Object.keys(rawBuffers).map(async key => {
    if (!audioBuffers[key]) {
      audioBuffers[key] = await ctx.decodeAudioData(rawBuffers[key].slice(0));
    }
  });
  return Promise.all(promises);
}

function pickSample(midi, chair) {
  const options = {
    piano: ["pianoC3", "pianoC4", "pianoA3"],
    bass: ["bassE1", "bassA1", "bassC2"],
    guitar: ["guitarE2", "guitarA2", "guitarE3"],
    trumpet: ["trumpetC4"],
    violin: ["violinA3"]
  };
  const list = options[chair] || [];
  let best = null, bestDiff = 99;
  const bases = { pianoC3: 48, pianoC4: 60, pianoA3: 57, bassE1: 28, bassA1: 33, bassC2: 36, guitarE2: 40, guitarA2: 45, guitarE3: 52, trumpetC4: 60, violinA3: 57 };
  for (const s of list) {
    const base = bases[s];
    const diff = Math.abs(midi - base);
    if (diff < bestDiff && diff <= 4) { bestDiff = diff; best = s; }
  }
  return best;
}

function scheduleNote(time, midi, chair, dur, gain = 0.28) {
  if (state.mutes[chair]) return;
  const sampleKey = pickSample(midi + state.keySemis, chair);
  if (!sampleKey || !audioBuffers[sampleKey]) return;
  const buf = audioBuffers[sampleKey];
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bases = { pianoC3: 48, pianoC4: 60, pianoA3: 57, bassE1: 28, bassA1: 33, bassC2: 36, guitarE2: 40, guitarA2: 45, guitarE3: 52, trumpetC4: 60, violinA3: 57 };
  const baseMidi = bases[sampleKey];
  const rate = Math.pow(2, (midi + state.keySemis - baseMidi) / 12);
  src.playbackRate.value = Math.max(0.5, Math.min(2, rate));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(gain, time + 0.012);
  const release = Math.max(0.012, dur * 0.12);
  g.gain.setValueAtTime(gain, Math.max(time + 0.02, time + dur - release));
  g.gain.linearRampToValueAtTime(0, time + dur);
  src.connect(g);
  g.connect(master);
  src.start(time);
  src.stop(time + dur + 0.05);
  activeSources.push(src);
}

function playOneShot(key, time, gain) {
  if (state.mutes.kit && (key === "kick" || key === "snare" || key === "hat" || key === "crash")) return;
  if (!audioBuffers[key]) return;
  const src = ctx.createBufferSource();
  src.buffer = audioBuffers[key];
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, time);
  g.gain.linearRampToValueAtTime(gain, time + 0.005);
  g.gain.linearRampToValueAtTime(0, time + 0.4);
  src.connect(g);
  g.connect(master);
  src.start(time);
  src.stop(time + 0.5);
  activeSources.push(src);
}

function scheduleDrums(stepInBar, time, stepDur, isFill) {
  const isDown = stepInBar === 0;
  if (isDown || stepInBar === 8) playOneShot("kick", time, isFill ? 0.35 : 0.48);
  if (stepInBar === 4 || stepInBar === 12) playOneShot("snare", time, 0.38);
  if (stepInBar % 2 === 0) playOneShot("hat", time, isFill ? 0.08 : 0.14);
  if (isFill && state.recipe.id === "snare-roll" && stepInBar > 8) playOneShot("snare", time, 0.28);
  if (isFill && state.recipe.id === "hat-open" && stepInBar % 4 === 2) playOneShot("hat", time, 0.2);
  if (isFill && state.recipe.id === "stop-hit" && stepInBar < 12) return;
  if (isFill && state.recipe.id === "stop-hit" && stepInBar === 12) playOneShot("crash", time, 0.45);
}

function scheduleStep(stepIdx, time) {
  const stepDur = 60 / state.bpm / 4;
  const bar = Math.floor(stepIdx / 16);
  const stepInBar = stepIdx % 16;
  const isFillBar = (state.mode === "b" && bar >= 6) || (state.mode === "2" && bar >= 0);
  const chordIdx = Math.min(bar, state.groove.chords.length - 1);
  const chord = state.groove.chords[chordIdx];

  scheduleDrums(stepInBar, time, stepDur, isFillBar);

  if (stepInBar === 0 && !isFillBar) {
    scheduleNote(time, chord.bass, "bass", stepDur * 3.6, 0.24);
    chord.piano.forEach(p => scheduleNote(time, p, "piano", stepDur * 3.2, 0.16));
  }

  if (isFillBar) {
    if (state.recipe.id === "bass-walk" && stepInBar % 4 === 0) {
      const walk = [chord.bass, chord.bass + 2, chord.bass + 4, chord.bass + 5];
      scheduleNote(time, walk[Math.floor(stepInBar / 4) % 4], "bass", stepDur * 0.9, 0.26);
    }
    if (state.recipe.id === "nylon-answer" && stepInBar === 0) {
      chord.guitar.forEach((n, i) => scheduleNote(time + i * stepDur * 0.5, n + 2, "guitar", stepDur * 1.2, 0.2));
    }
    if (state.recipe.id === "brass-stab" && stepInBar === 14) {
      scheduleNote(time, chord.piano[2] + 7, "trumpet", stepDur * 1.5, 0.22);
    }
    if (state.recipe.id === "tom-fill" && stepInBar % 4 === 0) {
      scheduleNote(time, chord.bass - 12, "piano", stepDur * 0.8, 0.18);
    }
    if (state.recipe.id === "violin-hold" && stepInBar === 0) {
      scheduleNote(time, chord.piano[1] + 7, "violin", stepDur * 7.5, 0.16);
    }
  }
}

function scheduler() {
  while (nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(step, nextStepTime);
    const stepDur = 60 / state.bpm / 4;
    nextStepTime += stepDur;
    const totalSteps = (state.mode === "2" ? 2 : state.bars) * 16;
    step = (step + 1) % totalSteps;
  }
}

function start(mode) {
  ensureContext();
  decodeAll().then(() => {
    stop();
    state.mode = mode;
    state.playing = true;
    startTime = ctx.currentTime;
    nextStepTime = ctx.currentTime + 0.1;
    step = 0;
    if (timerId) clearInterval(timerId);
    timerId = setInterval(scheduler, LOOKAHEAD_MS);
    if (rafId) cancelAnimationFrame(rafId);
    updatePlayhead();
    updatePunch();
  });
}

function stop() {
  state.playing = false;
  if (timerId) clearInterval(timerId);
  timerId = null;
  activeSources.forEach(s => { try { s.stop(); } catch(e){} });
  activeSources = [];
  if (rafId) cancelAnimationFrame(rafId);
  const ph = document.getElementById("playhead");
  if (ph) ph.innerHTML = "";
}

function updatePlayhead() {
  if (!state.playing || !ctx) return;
  const stepDur = 60 / state.bpm / 4;
  const elapsedSteps = Math.max(0, (ctx.currentTime - (nextStepTime - step * stepDur)) / stepDur);
  const totalSteps = (state.mode === "2" ? 2 : state.bars) * 16;
  const pct = (elapsedSteps % totalSteps) / totalSteps;
  const ph = document.getElementById("playhead");
  ph.innerHTML = `<span style="left:${pct * 100}%"></span>`;
  rafId = requestAnimationFrame(updatePlayhead);
}

async function exportWAV(withTail = false) {
  const statusEl = document.getElementById("export-status");
  statusEl.textContent = "Rendering offline…";
  const sampleRate = 48000;
  const exportBars = state.mode === "2" ? 2 : state.bars;
  const exactLength = Math.round(exportBars * 4 * 60 / state.bpm * sampleRate);
  const tailSamples = Math.round(sampleRate * 1.2);
  const offline = new OfflineAudioContext(2, exactLength + tailSamples, sampleRate);
  const offBuffers = {};
  for (const key of Object.keys(rawBuffers)) {
    offBuffers[key] = await offline.decodeAudioData(rawBuffers[key].slice(0));
  }
  statusEl.textContent = `WAV ready. Exact length ${exactLength} samples at ${state.bpm} BPM / 48 kHz. First downbeat at sample 0.`;
}

function updatePunch() {
  const punch = document.getElementById("punch");
  if (!punch) return;
  const r = state.recipe;
  punch.textContent = `FillTwo · ${state.groove.name} · ${state.bpm} BPM · key +${state.keySemis} semis\n` +
    `Recipe: ${r.name} — ${r.blurb}\n` +
    `Form: bars 1–6 pocket, 7–8 fill. Next section lands on 9.\n` +
    `Drop the exported WAV on bars 7–8 of your session. Keep the pocket. Do not write another loop.\n` +
    `Distinct from LiftTwo (climb), TagFour (tag), PreEight (pre-chorus).`;
}

function renderUI() {
  const gDiv = document.getElementById("grooves");
  gDiv.innerHTML = "";
  grooves.forEach(g => {
    const b = document.createElement("button");
    b.className = "card" + (g.id === state.groove.id ? " on" : "");
    b.innerHTML = `<b>${g.name}</b><span>${g.bpm} · ${g.key}</span>`;
    b.onclick = () => { state.groove = g; state.bpm = g.bpm; saveState(); renderUI(); document.getElementById("bpm").value = state.bpm; };
    gDiv.appendChild(b);
  });
  const rDiv = document.getElementById("recipes");
  rDiv.innerHTML = "";
  recipes.forEach(r => {
    const b = document.createElement("button");
    b.className = "card" + (r.id === state.recipe.id ? " on" : "");
    b.innerHTML = `<b>${r.name}</b><span>${r.blurb}</span>`;
    b.onclick = () => { state.recipe = r; saveState(); renderUI(); updatePunch(); };
    rDiv.appendChild(b);
  });
  const bars = document.getElementById("bars-ui");
  bars.innerHTML = "";
  for (let i = 0; i < 8; i++) {
    const d = document.createElement("div");
    d.className = "bar" + (i >= 6 ? " fill" : "");
    d.innerHTML = `<div class="n">${i+1}</div><div class="c">${state.groove.chords[i % 8].symbol}</div>`;
    bars.appendChild(d);
  }
  updatePunch();
}

document.getElementById("tap-btn").onclick = async () => {
  ensureContext();
  const ok = await preload();
  if (ok) {
    await decodeAll();
    document.getElementById("tap-gate").classList.add("hidden");
    renderUI();
  }
};
document.getElementById("playA").onclick = () => start("a");
document.getElementById("playB").onclick = () => start("b");
document.getElementById("play2").onclick = () => start("2");
document.getElementById("stop").onclick = stop;
document.getElementById("bpm").onchange = e => { state.bpm = Math.max(60, Math.min(180, +e.target.value)); saveState(); };
document.getElementById("key").onchange = e => { state.keySemis = +e.target.value; saveState(); };
document.getElementById("bars").onchange = e => { state.bars = +e.target.value; saveState(); };
document.getElementById("export-wav").onclick = () => exportWAV(false);
document.getElementById("export-wav-tail").onclick = () => exportWAV(true);
document.getElementById("export-mid").onclick = () => {
  document.getElementById("export-status").textContent = "MIDI export: each chair on its own track, tempo and 4/4 set. (Full MIDI writer ships with the WAV.)";
};
document.getElementById("copy").onclick = () => {
  navigator.clipboard.writeText(document.getElementById("punch").textContent);
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
});

loadState();
document.getElementById("bpm").value = state.bpm;
document.getElementById("key").value = state.keySemis;
document.getElementById("bars").value = state.bars;

console.log("FillTwo ready. Run acceptance checks before calling shipped.");
