// The page: a Start button, then the game module (/crashott.wasm, built by tools/wasm_runtime.sh)
// on a pool of game-thread workers (host/worker.ts), drawn by the WebGPU executor (gpu/executor.ts)
// once the game's recorder registers its control block.
//
// Query parameters: env=KEY=VALUE (repeatable) for the game's environment.
import { C_INTS, C_POOL, C_TID, FD_MAX, FD_SZ, INITIAL_PAGES, MAX_PAGES, POOL, S_IDLE, S_MAIN, type BootConfig, type ToPage } from './host/proto';
import { Executor } from './gpu/executor';
import { attachInput } from './input';
import { cacheState, fmtBytes, LANGUAGES } from './host/gamecache';
import type { FromDownload } from './host/download-worker';

const statusEl = document.getElementById('status') as HTMLDivElement;
const startEl = document.getElementById('start') as HTMLDivElement;
const stageEl = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const play = document.getElementById('play') as HTMLButtonElement;
const q = new URLSearchParams(location.search);

const status = (s: string) => { statusEl.textContent = s; };
// The log: the console, and a buffer the Log button saves to a file (to report a problem).
const lines: string[] = [];
const keep = (s: string) => {
  lines.push(`${(performance.now() / 1000).toFixed(3).padStart(10)} ${s}`);
  if (lines.length > 200000) lines.splice(0, 50000);
};
const log = (s: string) => { console.log(s); keep(s); };
const fail = (s: string) => { console.error(s); keep(s); status(s); };
(document.getElementById('logBtn') as HTMLButtonElement).onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`${navigator.userAgent}\n${location.href}\n\n${lines.join('\n')}\n`], { type: 'text/plain' }));
  a.download = `crashott-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

// The language: remembered in this browser; the game reads it at start (CRASHOTT_LANGUAGE).
const languageSel = document.getElementById('language') as HTMLSelectElement;
for (const [id, name] of LANGUAGES) languageSel.add(new Option(name, id));
let savedLanguage = 'english';
try { savedLanguage = localStorage.getItem('crashott-language') ?? 'english'; } catch { /* no storage */ }
languageSel.value = LANGUAGES.some(([id]) => id === savedLanguage) ? savedLanguage : 'english';
languageSel.onchange = () => {
  try { localStorage.setItem('crashott-language', languageSel.value); } catch { /* no storage */ }
  void showData();
};

async function gpu(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error('This browser has no WebGPU (use a recent Chrome or Edge).');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter.');
  // float32-filterable: the game samples 32-bit float textures (r32f / rg32f) through filtering samplers
  const wanted: GPUFeatureName[] = ['texture-compression-bc', 'depth32float-stencil8', 'depth-clip-control', 'float32-filterable',
    'texture-formats-tier1' as GPUFeatureName];
  const requiredFeatures = wanted.filter(f => adapter.features.has(f));
  const L = adapter.limits;
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits: {
    maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
    maxBufferSize: L.maxBufferSize,
    maxInterStageShaderVariables: L.maxInterStageShaderVariables,
    maxSampledTexturesPerShaderStage: L.maxSampledTexturesPerShaderStage,
    maxSamplersPerShaderStage: L.maxSamplersPerShaderStage,
    maxBindingsPerBindGroup: L.maxBindingsPerBindGroup,
  } });
  device.lost.then(info => fail(`WebGPU device lost: ${info.message}`));
  return device;
}

async function start(audio: AudioContext) {
  if (!crossOriginIsolated) throw new Error('The page is not cross-origin isolated (serve it with tools/serve.mjs).');
  status('Loading the game module...');
  const device = await gpu();
  const context = canvas.getContext('webgpu') as GPUCanvasContext;
  const mod = await WebAssembly.compileStreaming(fetch('/crashott.wasm'));
  const memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: MAX_PAGES, shared: true });
  const ctlBuf = new SharedArrayBuffer(C_INTS * 4), fdt = new SharedArrayBuffer(FD_MAX * FD_SZ);
  const ctl = new Int32Array(ctlBuf);
  ctl[C_TID] = 1;
  const env: Record<string, string> = {};
  for (const kv of q.getAll('env')) { const [k, ...v] = kv.split('='); env[k] = v.join('='); }
  env.CRASHOTT_LANGUAGE ??= languageSel.value;
  const cfg: BootConfig = { args: ['crashott', '--game', '/game', '--userdata', '/userdata'], env };
  let ready = 0, executor: Executor | null = null;
  const t0 = performance.now();
  await new Promise<void>((resolve, reject) => {
    for (let slot = 0; slot < POOL; slot++) {
      const worker = new Worker(new URL('./host/worker.js', import.meta.url), { type: 'module', name: `game ${slot}` });
      worker.onerror = e => reject(new Error(`worker ${slot}: ${e.message}`));
      worker.onmessage = (ev: MessageEvent<ToPage>) => {
        const m = ev.data;
        switch (m.t) {
          case 'ready': if (++ready === POOL) resolve(); break;
          case 'log': log(m.line); break;
          case 'gpu':
            try { executor = new Executor({ device, context, canvas, memory, ctlPtr: m.ctl, log }); }
            catch (e) { fail(String(e)); }
            break;
          case 'input': attachInput(memory, m.block, log); break;
          case 'audio':
            audio.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url)).then(() => {
              const node = new AudioWorkletNode(audio, 'crash-audio', { numberOfInputs: 0, outputChannelCount: [2],
                processorOptions: { buffer: memory.buffer, ring: m.ring } });
              node.connect(audio.destination);
              void audio.resume();
              log(`[audio] AudioWorklet playing at ${audio.sampleRate} Hz`);
            }).catch(e => log(`[audio] no sound: ${String(e)}`));
            break;
          case 'trap': fail(`The game stopped (thread ${m.tid}): ${m.message}`); console.error(m.stack); executor?.stop(); break;
          case 'exit': status(`The game exited (${m.code}).`); executor?.stop(); break;
        }
      };
      worker.postMessage({ mod, memory, ctl: ctlBuf, fdt, slot, cfg });
    }
  });
  log(`[page] ${POOL} workers ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  // every pool slot parked: the process entry goes to slot 0
  if (ctl.slice(C_POOL).filter((v, k) => k % 4 === 0 && v === S_IDLE).length < POOL) log('[page] not every worker is parked yet');
  startEl.hidden = true;
  stageEl.hidden = false;
  status('');
  Atomics.store(ctl, C_POOL, S_MAIN);
  Atomics.notify(ctl, C_POOL);
}

// ---- game data in the browser's storage (host/download-worker.ts) ----
const dataText = document.getElementById('dataText') as HTMLParagraphElement;
const dataBar = document.getElementById('dataBar') as HTMLProgressElement;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;
let downloader: Worker | null = null;

async function showData() {
  try {
    const { have, total } = await cacheState(languageSel.value);
    if (have >= total && total > 0) {
      dataText.textContent = `Game data downloaded (${fmtBytes(total)}): loads run from the browser's storage.`;
      downloadBtn.hidden = true;
    } else {
      dataText.textContent = have
        ? `Game data: ${fmtBytes(have)} of ${fmtBytes(total)} downloaded. Download the rest for faster loads.`
        : `Game data not downloaded: the game reads it from the server (slow loads). Download ${fmtBytes(total)} once for faster ones.`;
      downloadBtn.hidden = false;
      downloadBtn.textContent = have ? 'Resume download' : 'Download game data';
    }
  } catch (e) {
    dataText.textContent = `Game data: ${String((e as Error)?.message ?? e)}`;
  }
}

downloadBtn.onclick = async () => {
  if (downloader) { downloader.postMessage({ t: 'stop' }); return; }
  await navigator.storage.persist?.().catch(() => false);
  // enough room in the browser's storage for what is left?
  try {
    const [{ have, total }, est] = await Promise.all([cacheState(languageSel.value), navigator.storage.estimate()]);
    const free = (est.quota ?? 0) - (est.usage ?? 0);
    if (est.quota && free < total - have) {
      dataText.textContent = `Not enough room in the browser's storage: ${fmtBytes(total - have)} needed, ${fmtBytes(Math.max(0, free))} available.`;
      return;
    }
  } catch { /* no estimate: try anyway */ }
  downloader = new Worker(new URL('./host/download-worker.js', import.meta.url), { type: 'module', name: 'download' });
  play.disabled = true;
  languageSel.disabled = true;
  dataBar.hidden = false;
  downloadBtn.textContent = 'Stop';
  const finish = (text?: string) => {
    downloader?.terminate(); downloader = null;
    play.disabled = false; languageSel.disabled = false; dataBar.hidden = true;
    void showData().then(() => { if (text) dataText.textContent = text; });
  };
  downloader.onmessage = (ev: MessageEvent<FromDownload>) => {
    const m = ev.data;
    if (m.t === 'progress') {
      dataBar.max = m.total; dataBar.value = m.have;
      dataText.textContent = `Downloading ${fmtBytes(m.have)} of ${fmtBytes(m.total)}${m.file ? ` (${m.file})` : ''}...`;
    } else if (m.t === 'done') finish();
    else if (m.t === 'stopped') finish();
    else if (m.t === 'error') finish(`Download failed: ${m.msg}`);
  };
  downloader.postMessage({ t: 'start', language: languageSel.value });
};
void showData();

play.onclick = () => {
  play.disabled = true;
  languageSel.disabled = true;
  // Created in the click: browsers only let a page start sound from a user gesture.
  const audio = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  start(audio).catch(e => { fail(String(e?.message ?? e)); play.disabled = false; });
};
