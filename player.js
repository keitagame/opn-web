'use strict';

/* ============================================================
   OPN Deck — main thread controller
   Handles: file loading (.vgm / .vgz), gzip decompression,
   VGM parsing, AudioWorklet lifecycle, transport UI, scope draw,
   and per-channel activity visualization (derived from the parsed
   event stream, sampled against current playback position).
   ============================================================ */

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  rack: document.getElementById('rack'),
  metaTitle: document.getElementById('metaTitle'),
  metaGame: document.getElementById('metaGame'),
  metaSystem: document.getElementById('metaSystem'),
  metaAuthor: document.getElementById('metaAuthor'),
  metaClock: document.getElementById('metaClock'),
  scopeCanvas: document.getElementById('scopeCanvas'),
  channelsGrid: document.getElementById('channelsGrid'),
  btnPlay: document.getElementById('btnPlay'),
  btnStop: document.getElementById('btnStop'),
  btnLoop: document.getElementById('btnLoop'),
  btnLoad: document.getElementById('btnLoad'),
  seekBar: document.getElementById('seekBar'),
  timeCurrent: document.getElementById('timeCurrent'),
  timeTotal: document.getElementById('timeTotal'),
  volBar: document.getElementById('volBar'),
  statusText: document.getElementById('statusText'),
};

const CHANNEL_DEFS = [
  { id: 'fm0', label: 'FM 1', group: 'fm' },
  { id: 'fm1', label: 'FM 2', group: 'fm' },
  { id: 'fm2', label: 'FM 3', group: 'fm' },
  { id: 'ssg0', label: 'SSG 1', group: 'ssg' },
  { id: 'ssg1', label: 'SSG 2', group: 'ssg' },
  { id: 'ssg2', label: 'SSG 3', group: 'ssg' },
];

const state = {
  audioCtx: null,
  workletNode: null,
  gainNode: null,
  analyser: null,
  vgm: null,           // parsed VGMParser instance
  loaded: false,
  playing: false,
  loopEnabled: true,
  totalSamples: 0,
  vgmRate: 44100,
  seeking: false,
  channelState: {},    // id -> { active: bool, level: 0..1, lastEventSample }
  animHandle: null,
  currentPositionSample: 0,
};

// ---------- UI: channel cells ----------

function buildChannelCells() {
  els.channelsGrid.innerHTML = '';
  for (const def of CHANNEL_DEFS) {
    const cell = document.createElement('div');
    cell.className = `chan-cell ${def.group}`;
    cell.innerHTML = `
      <div class="chan-label">${def.label}</div>
      <div class="chan-led ${def.group}" data-led="${def.id}"></div>
      <div class="chan-bar-track"><div class="chan-bar-fill" data-bar="${def.id}"></div></div>
    `;
    els.channelsGrid.appendChild(cell);
    state.channelState[def.id] = { active: false, level: 0, decay: 0 };
  }
}


// ---------- File loading ----------

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  setStatus(`読み込み中: ${file.name}`);
  try {
    const buf = await file.arrayBuffer();
    let bytes = new Uint8Array(buf);

    // .vgz is gzip-compressed VGM
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (isGzip || /\.vgz$/i.test(file.name)) {
      bytes = await gunzip(bytes);
    }

    const parser = new VGMParser(bytes.buffer);
    state.vgm = parser;
    state.totalSamples = parser.totalSamples;

    if (!parser.header.ym2203Clock) {
      setStatus('警告: このVGMにYM2203データが見つかりません。無音になる可能性があります。');
    } else {
      setStatus(`読み込み完了: ${file.name}`);
    }

    //populateMeta(parser, file.name);
    await ensureAudio();
    await sendLoadToWorklet(parser);
    await togglePlay();
    els.rack.hidden = false;
    state.loaded = true;
    updateSeekRange();
   
  } catch (err) {
    console.error(err);
    setStatus(`エラー: ${err.message}`);
  }
}

// Minimal gzip decompression using DecompressionStream when available,
// falling back to an error message otherwise (all modern browsers support it).
async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('このブラウザは.vgzの展開に対応していません(DecompressionStream非対応)');
  }
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

function populateMeta(parser, filename) {
  const gd3 = parser.gd3;
  els.metaTitle.textContent = (gd3 && (gd3.trackNameEn || gd3.trackNameJp)) || filename;
  els.metaGame.textContent = (gd3 && (gd3.gameNameEn || gd3.gameNameJp)) || '—';
  els.metaSystem.textContent = (gd3 && (gd3.systemNameEn || gd3.systemNameJp)) || 'YM2203 (OPN)';
  els.metaAuthor.textContent = (gd3 && (gd3.authorEn || gd3.authorJp)) || '—';
  const clk = parser.header.ym2203Clock;
  els.metaClock.textContent = clk ? `${(clk / 1000000).toFixed(4)} MHz` : '不明';
}

// ---------- Audio graph ----------

async function ensureAudio() {
  if (state.audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  await ctx.audioWorklet.addModule('vgm-worklet-bundle.js');

  const node = new AudioWorkletNode(ctx, 'vgm-player-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { vgmSampleRate: 44100 },
  });

  const gain = ctx.createGain();
  gain.gain.value = (parseInt(els.volBar.value, 10) / 100) ** 1.6;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  node.connect(gain);
  gain.connect(analyser);
  analyser.connect(ctx.destination);

  node.port.onmessage = (e) => handleWorkletMessage(e.data);

  state.audioCtx = ctx;
  state.workletNode = node;
  state.gainNode = gain;
  state.analyser = analyser;
}

function sendLoadToWorklet(parser) {
  return new Promise((resolve) => {
    const onMsg = (e) => {
      if (e.data.type === 'loaded') {
        state.workletNode.port.removeEventListener('message', onMsg);
        resolve();
      }
    };
    // We can't removeEventListener on onmessage-assigned port easily across browsers,
    // so use addEventListener style + keep main handler too.
    state.workletNode.port.addEventListener('message', onMsg);
    state.workletNode.port.start && state.workletNode.port.start();

    state.workletNode.port.postMessage({
      type: 'load',
      events: parser.events,
      totalSamples: parser.totalSamples,
      loopSampleOffset: parser.loopSampleOffset,
      clock: parser.header.ym2203Clock || 3993600,
    });
  });
}

function handleWorkletMessage(msg) {
  switch (msg.type) {
    case 'position':
      state.currentPositionSample = msg.sample;
      if (!state.seeking) updateSeekUI();
      break;
    case 'ended':
      state.playing = false;
      updatePlayButtonUI();
      setStatus('再生終了');
      break;
    case 'looped':
      setStatus('ループ再生中');
      break;
    default:
      break;
  }
}

// ---------- Transport controls ----------


async function togglePlay() {
  if (!state.loaded) return;
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();

  state.playing = !state.playing;
  state.workletNode.port.postMessage({ type: state.playing ? 'play' : 'pause' });
  updatePlayButtonUI();
  setStatus(state.playing ? '再生中' : '一時停止');
}

function stopPlayback() {
  if (!state.loaded) return;
  state.playing = false;
  state.workletNode.port.postMessage({ type: 'stop' });
  state.currentPositionSample = 0;
  updatePlayButtonUI();
  updateSeekUI();
  setStatus('停止');
  resetChannelVisuals();
}

function toggleLoop() {
  state.loopEnabled = !state.loopEnabled;
  els.btnLoop.setAttribute('aria-pressed', String(state.loopEnabled));
  if (state.workletNode) {
    state.workletNode.port.postMessage({ type: 'setLoop', value: state.loopEnabled });
  }
}

function updatePlayButtonUI() {
  els.btnPlay.classList.toggle('is-playing', state.playing);
  els.btnPlay.querySelector('.icon-play').hidden = state.playing;
  els.btnPlay.querySelector('.icon-pause').hidden = !state.playing;
}

// ---------- Seek bar ----------

function updateSeekRange() {
  els.seekBar.min = 0;
  els.seekBar.max = state.totalSamples || 1000;
  els.timeTotal.textContent = samplesToTime(state.totalSamples);
}

function updateSeekUI() {
  if (!state.seeking) {
    els.seekBar.value = state.currentPositionSample;
  }
  els.timeCurrent.textContent = samplesToTime(state.currentPositionSample);
}

function samplesToTime(samples) {
  const totalSec = samples / 44100;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------- Volume ----------

// ---------- Status ----------

function setStatus(text) {
 
}

// ---------- Oscilloscope + channel activity animation loop ----------

function startAnimLoop() {
  if (state.animHandle) cancelAnimationFrame(state.animHandle);
  const canvas = els.scopeCanvas;
  const ctx2d = canvas.getContext('2d');

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const timeData = new Uint8Array(state.analyser ? state.analyser.fftSize : 1024);

  function frame() {
    drawScope(ctx2d, canvas, timeData);
    updateChannelActivity();
    state.animHandle = requestAnimationFrame(frame);
  }
  frame();
}

function drawScope(ctx2d, canvas, timeData) {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  ctx2d.clearRect(0, 0, w, h);

  // grid
  ctx2d.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  for (let x = 0; x <= w; x += w / 8) {
    ctx2d.moveTo(x + 0.5, 0);
    ctx2d.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += h / 4) {
    ctx2d.moveTo(0, y + 0.5);
    ctx2d.lineTo(w, y + 0.5);
  }
  ctx2d.stroke();

  if (!state.analyser) return;
  state.analyser.getByteTimeDomainData(timeData);

  ctx2d.beginPath();
  ctx2d.strokeStyle = state.playing ? '#ff9d2e' : '#5c554a';
  ctx2d.lineWidth = 1.6;
  ctx2d.shadowColor = state.playing ? 'rgba(255,157,46,0.5)' : 'transparent';
  ctx2d.shadowBlur = state.playing ? 6 : 0;

  const step = w / timeData.length;
  for (let i = 0; i < timeData.length; i++) {
    const v = timeData[i] / 128 - 1;
    const y = h / 2 + v * (h / 2) * 0.9;
    const x = i * step;
    if (i === 0) ctx2d.moveTo(x, y);
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
  ctx2d.shadowBlur = 0;

  // center line
  ctx2d.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx2d.beginPath();
  ctx2d.moveTo(0, h / 2 + 0.5);
  ctx2d.lineTo(w, h / 2 + 0.5);
  ctx2d.stroke();
}

// Approximate channel activity by scanning nearby events around current
// playback position (cheap heuristic: look back a small window for key-on
// writes / SSG volume writes per channel, decay LEDs over time).
function updateChannelActivity() {
  if (!state.vgm || !state.playing) {
    return;
  }
  const parser = state.vgm;
  const pos = state.currentPositionSample;
  const windowSamples = 2000; // look-back window

  // Binary-search-ish scan: since events are sorted by sampleOffset, do a
  // linear scan from a cached index for performance.
  if (!state._scanIdx || state._scanIdx > parser.events.length || state._lastPos > pos) {
    state._scanIdx = 0;
  }
  let i = state._scanIdx;
  const touched = {};
  while (i < parser.events.length && parser.events[i].sampleOffset < pos) {
    const ev = parser.events[i];
    if (ev.sampleOffset >= pos - windowSamples && ev.type === 'ym2203') {
      classifyEvent(ev, touched);
    }
    i++;
  }
  state._scanIdx = Math.max(0, i - 200); // keep a small rewind margin
  state._lastPos = pos;

  for (const def of CHANNEL_DEFS) {
    const cs = state.channelState[def.id];
    if (touched[def.id]) {
      cs.level = 1;
      cs.active = true;
    } else {
      cs.level *= 0.90;
      if (cs.level < 0.05) { cs.level = 0; cs.active = false; }
    }
    const led = document.querySelector(`[data-led="${def.id}"]`);
    const bar = document.querySelector(`[data-bar="${def.id}"]`);
    if (led) led.classList.toggle('active', cs.level > 0.15);
    if (bar) bar.style.height = `${Math.round(cs.level * 100)}%`;
  }
}

function classifyEvent(ev, touched) {
  const addr = ev.addr;
  if (addr === 0x28) {
    const ch = ev.data & 0x03;
    if (ch <= 2 && (ev.data & 0xf0)) touched[`fm${ch}`] = true;
    return;
  }
  if (addr >= 0x30 && addr < 0xa0) {
    const ch = addr & 0x03;
    if (ch <= 2) touched[`fm${ch}`] = true;
    return;
  }
  if (addr <= 0x0d) {
    // SSG tone/vol registers: 0,1=ch0 tone 2,3=ch1 tone 4,5=ch2 tone 8,9,10=vol
    if (addr === 0 || addr === 1 || addr === 8) touched.ssg0 = true;
    else if (addr === 2 || addr === 3 || addr === 9) touched.ssg1 = true;
    else if (addr === 4 || addr === 5 || addr === 10) touched.ssg2 = true;
  }
}

function resetChannelVisuals() {
  for (const def of CHANNEL_DEFS) {
    const cs = state.channelState[def.id];
    cs.level = 0; cs.active = false;
    const led = document.querySelector(`[data-led="${def.id}"]`);
    const bar = document.querySelector(`[data-bar="${def.id}"]`);
    if (led) led.classList.remove('active');
    if (bar) bar.style.height = '0%';
  }
}

// Keyboard shortcut: space to play/pause when a file is loaded
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && state.loaded && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    togglePlay();
  }
});