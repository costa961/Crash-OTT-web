// The page: a Start button, then the game module (/crashott.wasm, built by tools/wasm_runtime.sh)
// on a pool of game-thread workers (host/worker.ts), drawn by the WebGPU executor (gpu/executor.ts)
// once the game's recorder registers its control block.
//
// Query parameters: env=KEY=VALUE (repeatable) for the game's environment.
import { C_INTS, C_POOL, C_TID, FD_MAX, FD_SZ, INITIAL_PAGES, MAX_PAGES, POOL, S_IDLE, S_MAIN, type BootConfig, type ToPage } from './host/proto';
import { IO_REPLY_BYTES } from './host/io-proto';
import { Executor } from './gpu/executor';
import { FUR_COLORS } from './gpu/recolor';
import { ACTIONS, attachInput, DEFAULT_BINDINGS, DEFAULT_PAD, keyboardPlayer, keyName, loadBindings, loadPadBindings, PAD_ACTIONS, padButtonName,
  RESERVED_KEYS, saveBindings, savePadBindings, setKeyboardPlayer, type Action, type GameInput, type PadAction } from './input';
import { exportSaves, importSaves } from './saves';
import { attachNet, listHosts, type GameNet } from './net';
import { cacheState, fmtBytes, LANGUAGES } from './host/gamecache';
import type { FromDownload } from './host/download-worker';

const statusEl = document.getElementById('status') as HTMLDivElement;
const startEl = document.getElementById('start') as HTMLDivElement;
const stageEl = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const play = document.getElementById('play') as HTMLButtonElement;
const q = new URLSearchParams(location.search);

const status = (s: string) => { statusEl.textContent = s; };
// The log: the console, and a buffer the start page's "Download logs" saves to a file (to report a
// problem, as GTA San Andreas web's). The session's log is also kept in the browser's storage every
// few seconds (OPFS "logs/session.txt"), so after a problem a reload of the page still has it: the
// download is the previous session's log, then this one's.
const lines: string[] = [];
let logDirty = false;
const keep = (s: string) => {
  lines.push(`${(performance.now() / 1000).toFixed(3).padStart(10)} ${s}`);
  if (lines.length > 200000) lines.splice(0, 50000);
  logDirty = true;
};
const log = (s: string) => { console.log(s); keep(s); };
const fail = (s: string) => { console.error(s); keep(s); status(s); };
const SESSION_LOG = 'session.txt', LOG_KEEP = 50000;
let previousLog = '';
async function logDir(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle('logs', { create: true });
}
// the previous session's log, then this session's from now on
const logReady = (async () => {
  try {
    const dir = await logDir();
    previousLog = await (await (await dir.getFileHandle(SESSION_LOG, { create: true })).getFile()).text();
  } catch { /* no storage: this session's log only */ }
})();
setInterval(async () => {
  if (!logDirty) return;
  logDirty = false;
  try {
    await logReady;
    const w = await (await (await logDir()).getFileHandle(SESSION_LOG, { create: true })).createWritable();
    await w.write(`${new Date().toISOString()} ${navigator.userAgent}\n${location.href}\n\n${lines.slice(-LOG_KEEP).join('\n')}\n`);
    await w.close();
  } catch { /* no storage */ }
}, 3000);
async function downloadLog(name = 'crashott-log') {
  await logReady;
  const current = `${navigator.userAgent}\n${location.href}\n\n${lines.join('\n')}\n`;
  const text = previousLog
    ? `===== previous session =====\n${previousLog}\n===== this session =====\n${current}`
    : current;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
(document.getElementById('logs') as HTMLButtonElement).onclick = () => void downloadLog();

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

// Crash's colour: remembered in this browser; the executor recolours his textures (gpu/recolor.ts)
// from the start (the videos keep theirs). Picked before Start: the textures are recoloured as they load.
const furSwatches = document.getElementById('furSwatches') as HTMLDivElement;
const furName = document.getElementById('furName') as HTMLElement;
let furColor = 'original';
try { furColor = localStorage.getItem('crashott-fur') ?? 'original'; } catch { /* no storage */ }
if (!FUR_COLORS.some(c => c.id === furColor)) furColor = 'original';
for (const c of FUR_COLORS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.title = c.name;
  b.setAttribute('aria-label', c.name);
  b.style.setProperty('--c', c.id === 'original' ? '#f28c28' : `rgb(${c.rgb.join(',')})`);
  b.onclick = () => {
    furColor = c.id;
    try { localStorage.setItem('crashott-fur', furColor); } catch { /* no storage */ }
    showFur();
  };
  b.dataset.id = c.id;
  furSwatches.append(b);
}
function showFur() {
  furSwatches.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.id === furColor)));
  furName.textContent = FUR_COLORS.find(c => c.id === furColor)!.name;
}
showFur();

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

/** An online co-op session chosen on the start page (runtime/mp_web.cpp): host, or join a host's address. */
interface MpChoice { role: 'host' | 'join'; name: string; join?: string }

async function start(audio: AudioContext, mp?: MpChoice) {
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
  if (mp) {
    env.CRASHOTT_MP = mp.role;
    // Crash's colour: the session's own (each player's Crash, the same on every machine; the host gives
    // a colour already taken the next free one), not the executor's recolouring
    env.CRASH_MP_COLOR ??= FUR_COLORS.find(c => c.id === furColor)?.mp ?? 'orange';
    env.CRASHOTT_MP_NAME = mp.name;
    if (mp.join) env.CRASHOTT_MP_JOIN = mp.join;
    // a client waits for the host's level at the main menu: straight there
    if (mp.role === 'join') env.CRASH_SKIP_INTROS = '1';
  }
  if (optSkip.checked) env.CRASH_SKIP_INTROS ??= '1';
  for (const [k, v] of Object.entries(graphicsEnv(loadGraphics()))) env[k] ??= v;
  // the screen's size in pixels: the "Screen's" aspect ratio (crashott-pc's settings::MonitorSize)
  env.CRASH_MONITOR ??= `${Math.round(screen.width * devicePixelRatio)}x${Math.round(screen.height * devicePixelRatio)}`;
  const cfg: BootConfig = { args: ['crashott', '--game', '/game', '--userdata', '/userdata'], env };
  let ready = 0, executor: Executor | null = null;
  const t0 = performance.now();
  // The saves in the browser's storage: the I/O worker (host/io-worker.ts), ready once it has copied
  // the saves of an older build from the local server.
  await navigator.storage.persist?.().catch(() => false);
  const io = new Worker(new URL('./host/io-worker.js', import.meta.url), { type: 'module', name: 'io' });
  await new Promise<void>((resolve, reject) => {
    io.onerror = e => reject(new Error(`I/O worker: ${e.message}`));
    io.onmessage = (ev: MessageEvent<{ t: 'ready' } | { t: 'log'; line: string }>) => {
      if (ev.data.t === 'log') log(ev.data.line);
      else resolve();
    };
    io.postMessage({ t: 'init', memory });
  });
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
            try {
              executor = new Executor({ device, context, canvas, memory, ctlPtr: m.ctl, log, furColor: mp ? 'original' : furColor });
              startFps(() => executor?.framesPresented ?? 0);
              followCanvasSize(executor);
            }
            catch (e) { fail(String(e)); }
            break;
          case 'input': gameInput = attachInput(memory, m.block, log, { skipPrompt: document.getElementById('skip') }); break;
          case 'net': if (mp) startMpPanel(attachNet(memory, m.block, log, { name: mp.name, hosting: mp.role === 'host' }), mp); break;
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
      const channel = new MessageChannel();
      io.postMessage({ t: 'port', port: channel.port2 }, [channel.port2]);
      worker.postMessage({ mod, memory, ctl: ctlBuf, fdt, slot, cfg, ioPort: channel.port1, ioReply: new SharedArrayBuffer(IO_REPLY_BYTES) },
        [channel.port1]);
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

// ---- the start page's switches, remembered in this browser ----
function rememberedSwitch(id: string, key: string): HTMLInputElement {
  const el = document.getElementById(id) as HTMLInputElement;
  try { el.checked = localStorage.getItem(key) === '1'; } catch { /* no storage */ }
  el.onchange = () => { try { localStorage.setItem(key, el.checked ? '1' : '0'); } catch { /* no storage */ } };
  return el;
}
// no logo videos, no title screen: straight to the main menu (crashott-pc's settings/direct_boot.cpp)
const optSkip = rememberedSwitch('optSkip', 'crashott-skip-intros');
// 60 fps instead of the original 30 (crashott-pc's frame limit, gpu::SetFrameLimit); the Graphics
// dialog has the same switch
const opt60 = rememberedSwitch('opt60', 'crashott-60fps');
const opt60g = document.getElementById('opt60g') as HTMLInputElement;
opt60g.checked = opt60.checked;
opt60.addEventListener('change', () => { opt60g.checked = opt60.checked; });
opt60g.onchange = () => {
  opt60.checked = opt60g.checked;
  try { localStorage.setItem('crashott-60fps', opt60.checked ? '1' : '0'); } catch { /* no storage */ }
  sendLive();
};

// The game's input (input.ts), once it runs: the in-game options panel pauses it and sends it options.
let gameInput: GameInput | null = null;

// ---- the canvas at the page's size in pixels (full screen: the screen's resolution) ----
function followCanvasSize(executor: Executor) {
  const MAX = 3840 * 2160;
  const resize = (w: number, h: number) => {
    const scale = Math.min(1, Math.sqrt(MAX / Math.max(1, w * h)));   // at most 4K worth of pixels
    executor.resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  };
  new ResizeObserver(entries => {
    const e = entries[entries.length - 1];
    const box = e.devicePixelContentBoxSize?.[0];
    if (box) resize(box.inlineSize, box.blockSize);
    else resize(e.contentRect.width * devicePixelRatio, e.contentRect.height * devicePixelRatio);
  }).observe(canvas);
}

// ---- full screen: F, or a double-click on the game ----
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void stageEl.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
/** A key typed into a field of the page's (the report's note): not one of the page's shortcuts. */
const typing = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select');
window.addEventListener('keydown', e => {
  if (e.code === 'KeyF' && !e.repeat && !stageEl.hidden && !typing(e)) { e.preventDefault(); toggleFullscreen(); }
});
stageEl.addEventListener('dblclick', toggleFullscreen);

// ---- Controls: the keyboard bindings (input.ts), remembered in this browser ----
const controlsDlg = document.getElementById('controlsDlg') as HTMLDialogElement;
const keytable = document.getElementById('keytable') as HTMLDivElement;
let bindings = loadBindings();
let waiting: { action: Action; button: HTMLButtonElement } | null = null;
function drawControls() {
  keytable.replaceChildren();
  for (const [action, label] of ACTIONS) {
    const name = document.createElement('span');
    name.textContent = label;
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = keyName(bindings[action]);
    button.onclick = () => {
      if (waiting) waiting.button.classList.remove('waiting');
      waiting = { action, button };
      button.classList.add('waiting');
      button.textContent = 'press a key...';
    };
    keytable.append(name, button);
  }
}
controlsDlg.addEventListener('keydown', e => {
  if (!waiting) return;
  e.preventDefault();
  e.stopPropagation();
  const { action } = waiting;
  waiting = null;
  if (e.code !== 'Escape' || action === 'start') {
    if (RESERVED_KEYS.has(e.code)) { drawControls(); return; }
    // a key bound elsewhere moves here: the other input gets this one's old key
    const old = bindings[action];
    for (const [a] of ACTIONS) if (a !== action && bindings[a] === e.code) bindings[a] = old;
    bindings[action] = e.code;
    saveBindings(bindings);
  }
  drawControls();
});
controlsDlg.addEventListener('cancel', e => { if (waiting) { e.preventDefault(); waiting = null; drawControls(); } });
(document.getElementById('controlsBtn') as HTMLButtonElement).onclick = () => {
  bindings = loadBindings(); padBindings = loadPadBindings(); drawControls(); drawPad(); controlsDlg.showModal();
};
(document.getElementById('keysReset') as HTMLButtonElement).onclick = () => {
  if (padTab) { padBindings = { ...DEFAULT_PAD }; savePadBindings(padBindings); drawPad(); }
  else { bindings = { ...DEFAULT_BINDINGS }; saveBindings(bindings); drawControls(); }
};
(document.getElementById('keysDone') as HTMLButtonElement).onclick = () => controlsDlg.close();
controlsDlg.addEventListener('close', () => { padWaiting = null; });

// the gamepad's buttons (input.ts PAD_ACTIONS): click an input, press the button for it
const padtable = document.getElementById('padtable') as HTMLDivElement;
const padNote = document.getElementById('padNote') as HTMLParagraphElement;
const tabKeys = document.getElementById('tabKeys') as HTMLButtonElement, tabPad = document.getElementById('tabPad') as HTMLButtonElement;
let padTab = false;
const showTab = (pad: boolean) => {
  padTab = pad;
  tabKeys.classList.toggle('active', !pad); tabPad.classList.toggle('active', pad);
  (document.getElementById('keysPane') as HTMLDivElement).hidden = pad;
  (document.getElementById('padPane') as HTMLDivElement).hidden = !pad;
  waiting = null; padWaiting = null; drawControls(); drawPad();
};
tabKeys.onclick = () => showTab(false);
// local co-op: which player the keyboard plays (input.ts keyboardPlayer); read when the game starts
const kbPlayerSel = document.getElementById('optKbPlayer') as HTMLSelectElement;
kbPlayerSel.value = String(keyboardPlayer());
kbPlayerSel.onchange = () => setKeyboardPlayer(kbPlayerSel.value === '2' ? 2 : 1);
tabPad.onclick = () => showTab(true);
let padBindings = loadPadBindings();
let padWaiting: { action: PadAction; held: Set<number> } | null = null;
function drawPad() {
  padtable.replaceChildren();
  for (const [action, label] of PAD_ACTIONS) {
    const name = document.createElement('span');
    name.textContent = label;
    const button = document.createElement('button');
    button.className = 'secondary';
    const isWaiting = padWaiting?.action === action;
    button.textContent = isWaiting ? 'press a button...' : padButtonName(padBindings[action]);
    button.classList.toggle('waiting', isWaiting);
    button.onclick = () => {
      // the buttons already down (the one that clicked, on some pads) don't count
      padWaiting = { action, held: new Set(pressedButtons()) };
      drawPad();
      requestAnimationFrame(pollPad);
    };
    padtable.append(name, button);
  }
  const pads = (navigator.getGamepads?.() ?? []).filter(g => g?.connected);
  padNote.textContent = pads.length
    ? `Gamepad: ${pads[0]!.id}. Click an input, then press the gamepad button for it (Esc cancels). The sticks stay as they are.`
    : 'No gamepad found: connect one and press a button on it. Click an input, then press the gamepad button for it (Esc cancels).';
}
function pressedButtons(): number[] {
  const g = (navigator.getGamepads?.() ?? []).find(p => p?.connected);
  const out: number[] = [];
  g?.buttons.forEach((b, i) => { if (i < 16 && (b.pressed || b.value > 0.5)) out.push(i); });
  return out;
}
function pollPad() {
  if (!padWaiting || !controlsDlg.open) return;
  const now = pressedButtons();
  for (const h of [...padWaiting.held]) if (!now.includes(h)) padWaiting.held.delete(h);
  const pressed = now.find(i => !padWaiting!.held.has(i));
  if (pressed === undefined) { requestAnimationFrame(pollPad); return; }
  const { action } = padWaiting;
  padWaiting = null;
  // a button bound elsewhere moves here: the other input gets this one's old button
  const old = padBindings[action];
  for (const [a] of PAD_ACTIONS) if (a !== action && padBindings[a] === pressed) padBindings[a] = old;
  padBindings[action] = pressed;
  savePadBindings(padBindings);
  drawPad();
}
window.addEventListener('gamepadconnected', () => { if (controlsDlg.open) drawPad(); });
controlsDlg.addEventListener('keydown', e => {
  if (padWaiting && e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); padWaiting = null; drawPad(); }
}, true);

// ---- Graphics: anti-aliasing and crashott-pc's shader options, remembered in this browser ----
// and the lighting remaster (crashott-pc's settings.h [lighting]), all off by default
// and the internal resolution and aspect ratio (crashott-pc's settings.h [video])
interface Graphics { res: string; aspect: string; aa: string; mb: number; dof: number; sh: number; ssao: string; gi: boolean; giI: number; contact: boolean; soft: boolean }
const GRAPHICS_DEFAULT: Graphics = { res: '720', aspect: 'auto', aa: 'off', mb: 100, dof: 100, sh: 100, ssao: 'off', gi: false, giI: 100, contact: false, soft: false };
/** The options as the game reads them (runtime/main_wasm.cpp ApplyGraphicsOptions), with the 60 FPS switch. */
function graphicsEnv(g: Graphics): Record<string, string> {
  return {
    CRASHOTT_RESOLUTION: g.res, CRASHOTT_ASPECT: g.aspect, CRASHOTT_AA: g.aa,
    CRASHOTT_MOTION_BLUR: String(g.mb), CRASHOTT_DEPTH_OF_FIELD: String(g.dof), CRASHOTT_SHADOW_SOFTNESS: String(g.sh),
    CRASHOTT_SSAO: g.ssao, CRASHOTT_GI: g.gi ? '1' : '0', CRASHOTT_GI_INTENSITY: String(g.giI),
    CRASHOTT_CONTACT_SHADOWS: g.contact ? '1' : '0', CRASHOTT_SOFT_SHADOWS: g.soft ? '1' : '0',
    CRASHOTT_FPS: opt60.checked ? '60' : '30',
  };
}
// Presets: everything but the aspect ratio and the 60 FPS mode (the screen's and the player's to choose).
// Low: integrated GPUs (720p, cheap effects); Medium: 720p with the lighting remaster's cheaper parts;
// High: 1080p with all of it. Any change by hand makes it "Custom".
const PRESETS: Record<string, Omit<Graphics, 'aspect'>> = {
  original: { res: '720', aa: 'off', mb: 100, dof: 100, sh: 100, ssao: 'off', gi: false, giI: 100, contact: false, soft: false },
  low: { res: '720', aa: 'fxaa', mb: 100, dof: 100, sh: 100, ssao: 'off', gi: false, giI: 100, contact: false, soft: true },
  medium: { res: '720', aa: 'smaa', mb: 100, dof: 100, sh: 100, ssao: 'low', gi: false, giI: 100, contact: true, soft: true },
  high: { res: '1080', aa: 'smaa', mb: 100, dof: 100, sh: 100, ssao: 'high', gi: true, giI: 100, contact: true, soft: true },
};
function presetOf(g: Graphics): string {
  for (const [name, p] of Object.entries(PRESETS))
    if ((Object.keys(p) as (keyof typeof p)[]).every(k => p[k] === g[k])) return name;
  return 'custom';
}
function loadGraphics(): Graphics {
  try { return { ...GRAPHICS_DEFAULT, ...JSON.parse(localStorage.getItem('crashott-graphics') ?? '{}') as Partial<Graphics> }; }
  catch { return { ...GRAPHICS_DEFAULT }; }
}
const graphicsDlg = document.getElementById('graphicsDlg') as HTMLDialogElement;
const presetSel = document.getElementById('optPreset') as HTMLSelectElement;
const gfxEls = {
  res: document.getElementById('optRes') as HTMLSelectElement,
  aspect: document.getElementById('optAspect') as HTMLSelectElement,
  aa: document.getElementById('optAa') as HTMLSelectElement,
  mb: [document.getElementById('optMb') as HTMLInputElement, document.getElementById('mbVal') as HTMLOutputElement],
  dof: [document.getElementById('optDof') as HTMLInputElement, document.getElementById('dofVal') as HTMLOutputElement],
  sh: [document.getElementById('optSh') as HTMLInputElement, document.getElementById('shVal') as HTMLOutputElement],
  giI: [document.getElementById('optGiI') as HTMLInputElement, document.getElementById('giVal') as HTMLOutputElement],
  ssao: document.getElementById('optSsao') as HTMLSelectElement,
  gi: document.getElementById('optGi') as HTMLInputElement,
  contact: document.getElementById('optContact') as HTMLInputElement,
  soft: document.getElementById('optSoft') as HTMLInputElement,
} as const;
const PERCENTS = ['mb', 'dof', 'sh', 'giI'] as const;
const SWITCHES = ['gi', 'contact', 'soft'] as const;
function showGraphics(g: Graphics) {
  gfxEls.res.value = g.res;
  gfxEls.aspect.value = g.aspect;
  gfxEls.aa.value = g.aa;
  gfxEls.ssao.value = g.ssao;
  for (const k of PERCENTS) { gfxEls[k][0].value = String(g[k]); gfxEls[k][1].value = `${g[k]}%`; }
  for (const k of SWITCHES) gfxEls[k].checked = g[k];
  gfxEls.giI[0].disabled = !g.gi;
  presetSel.value = presetOf(g);
}
function storeGraphics() {
  const g: Graphics = {
    res: gfxEls.res.value, aspect: gfxEls.aspect.value, aa: gfxEls.aa.value, mb: Number(gfxEls.mb[0].value), dof: Number(gfxEls.dof[0].value), sh: Number(gfxEls.sh[0].value),
    ssao: gfxEls.ssao.value, gi: gfxEls.gi.checked, giI: Number(gfxEls.giI[0].value), contact: gfxEls.contact.checked, soft: gfxEls.soft.checked,
  };
  try { localStorage.setItem('crashott-graphics', JSON.stringify(g)); } catch { /* no storage */ }
  showGraphics(g);
  sendLive();
}
/** In game (the panel open with F2): the options to the game, applied when the panel closes. */
let live = false;
function sendLive() {
  if (live && gameInput) gameInput.sendOptions(graphicsEnv(loadGraphics()));
}
presetSel.onchange = () => {
  const p = PRESETS[presetSel.value];
  if (!p) return;
  showGraphics({ ...p, aspect: gfxEls.aspect.value });
  storeGraphics();
};
gfxEls.res.onchange = gfxEls.aspect.onchange = gfxEls.aa.onchange = gfxEls.ssao.onchange = storeGraphics;
for (const k of PERCENTS) gfxEls[k][0].oninput = storeGraphics;
for (const k of SWITCHES) gfxEls[k].onchange = storeGraphics;
(document.getElementById('graphicsBtn') as HTMLButtonElement).onclick = () => { showGraphics(loadGraphics()); graphicsDlg.showModal(); };
// F2 in game: the same dialog over the game, which is paused while it is open
const gfxNote = document.getElementById('gfxNote') as HTMLParagraphElement;
const gfxNoteText = gfxNote.textContent ?? '';
window.addEventListener('keydown', e => {
  if (e.code !== 'F2' || e.repeat || !gameInput || stageEl.hidden) return;
  e.preventDefault();
  if (graphicsDlg.open) { graphicsDlg.close(); return; }
  live = true;
  gameInput.setPaused(true);
  showGraphics(loadGraphics());
  opt60g.checked = opt60.checked;
  gfxNote.textContent = 'The game is paused. Changes apply when you close this panel (Done, Esc or F2).';
  graphicsDlg.showModal();
});
graphicsDlg.addEventListener('close', () => {
  if (!live) return;
  live = false;
  gfxNote.textContent = gfxNoteText;
  gameInput?.setPaused(false);
  canvas.focus?.();
});
// ---- F8 in game: report a problem (a mark with a note in the log, and the log saved to a file) ----
// The game goes on (online co-op: the others play on); its keys stay off while the dialog is open.
const reportDlg = document.getElementById('reportDlg') as HTMLDialogElement;
const reportNote = document.getElementById('reportNote') as HTMLTextAreaElement;
let reportOpen = false;
let reportMarks = 0;
window.addEventListener('keydown', e => {
  if (e.code !== 'F8' || e.repeat || !gameInput || stageEl.hidden || reportOpen) return;
  e.preventDefault();
  reportOpen = true;
  gameInput.setBlocked(true);
  reportNote.value = '';
  reportDlg.showModal();
  reportNote.focus();
});
reportDlg.addEventListener('close', () => {
  reportOpen = false;
  gameInput?.setBlocked(false);
  canvas.focus?.();
});
(document.getElementById('reportCancel') as HTMLButtonElement).onclick = () => reportDlg.close();
(document.getElementById('reportSave') as HTMLButtonElement).onclick = () => {
  const note = reportNote.value.trim().replace(/\s+/g, ' ');
  log(`[report] ${++reportMarks} at ${new Date().toISOString()}: ${note || '(no note)'}`);
  reportDlg.close();
  void downloadLog('crashott-report');
};

(document.getElementById('gfxReset') as HTMLButtonElement).onclick = () => { showGraphics(GRAPHICS_DEFAULT); storeGraphics(); };
(document.getElementById('gfxDone') as HTMLButtonElement).onclick = () => graphicsDlg.close();

// ---- the saves: export to a .zip, import from one (saves.ts) ----
const savesText = document.getElementById('savesText') as HTMLParagraphElement;
const savesFile = document.getElementById('savesFile') as HTMLInputElement;
const savesSay = (s: string) => { savesText.hidden = false; savesText.textContent = s; };
(document.getElementById('exportSaves') as HTMLButtonElement).onclick = async () => {
  try {
    const zip = await exportSaves();
    if (!zip) { savesSay('No saves in this browser yet.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip.blob);
    a.download = `crashott-saves-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    savesSay(`Saves exported (${zip.files} file${zip.files === 1 ? '' : 's'}).`);
  } catch (e) { savesSay(`Export failed: ${String((e as Error)?.message ?? e)}`); }
};
(document.getElementById('importSaves') as HTMLButtonElement).onclick = () => savesFile.click();
savesFile.onchange = async () => {
  const file = savesFile.files?.[0];
  savesFile.value = '';
  if (!file) return;
  if (!confirm('Import the saves of this file? Saves of the same name in this browser are replaced.')) return;
  try {
    const n = await importSaves(file);
    savesSay(`Saves imported (${n} file${n === 1 ? '' : 's'}).`);
  } catch (e) { savesSay(`Import failed: ${String((e as Error)?.message ?? e)}`); }
};

// ---- what this browser lacks, said before Start (rather than a failure after it) ----
function compatibility(): string[] {
  const missing: string[] = [];
  if (!('gpu' in navigator)) missing.push('WebGPU');
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') missing.push('cross-origin isolation (serve the page with tools/serve.mjs)');
  // WebAssembly exception handling with exnref (try_table): the module's setjmp/longjmp
  const exnref = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02, 0x01, 0x00,
    0x0a, 0x08, 0x01, 0x06, 0x00, 0x1f, 0x40, 0x00, 0x0b, 0x0b]);
  if (!WebAssembly.validate(exnref)) missing.push('WebAssembly exception handling (exnref)');
  // the browser's file storage (OPFS): game data and saves
  if (typeof navigator.storage?.getDirectory !== 'function') missing.push("the browser's file storage (OPFS)");
  return missing;
}
const compatEl = document.getElementById('compat') as HTMLParagraphElement;
function sayIncompatible(missing: string[]) {
  compatEl.hidden = false;
  compatEl.textContent = `This browser can't run the game: it lacks ${missing.join(', ')}. Use a recent Chrome or Edge.`;
  play.disabled = true;
}
const browserOk = (async () => {
  const missing = compatibility();
  // WebGPU present but no adapter (Firefox off Windows, a blocked GPU): said here too, not after Start
  if (!missing.includes('WebGPU')) {
    try {
      if (!await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) missing.push('a WebGPU adapter (GPU blocked or unsupported)');
    } catch (e) { missing.push(`a WebGPU adapter (${String((e as Error)?.message ?? e)})`); }
  }
  if (missing.length) sayIncompatible(missing);
  return !missing.length;
})();

// ---- the FPS counter (the start page's "FPS counter") ----
const optFps = rememberedSwitch('optFps', 'crashott-fps');
const fpsEl = document.getElementById('fps') as HTMLDivElement;

/** Frames the game presented per second, twice a second (frames(): presented so far). */
function startFps(frames: () => number) {
  if (!optFps.checked) return;
  fpsEl.hidden = false;
  let last = frames(), lastT = performance.now();
  fpsEl.textContent = '-- FPS';
  setInterval(() => {
    const n = frames(), t = performance.now();
    fpsEl.textContent = `${Math.round((n - last) * 1000 / (t - lastT))} FPS`;
    last = n; lastT = t;
  }, 500);
}

// ---- game data in the browser's storage (host/download-worker.ts) ----
const dataText = document.getElementById('dataText') as HTMLParagraphElement;
const dataBar = document.getElementById('dataBar') as HTMLProgressElement;
const downloadBtn = document.getElementById('download') as HTMLButtonElement;
let downloader: Worker | null = null;

async function showData() {
  if (typeof navigator.storage?.getDirectory !== 'function') { dataText.textContent = ''; downloadBtn.hidden = true; return; }
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
    languageSel.disabled = false; dataBar.hidden = true;
    void browserOk.then(ok => { play.disabled = !ok; });
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

function startGame(mp?: MpChoice) {
  play.disabled = true;
  languageSel.disabled = true;
  coopBtn.disabled = true;
  // the saves are the game's now (the I/O worker holds them)
  for (const id of ['exportSaves', 'importSaves']) (document.getElementById(id) as HTMLButtonElement).disabled = true;
  // Created in the click: browsers only let a page start sound from a user gesture.
  const audio = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  start(audio, mp).catch(e => { fail(String(e?.message ?? e)); play.disabled = false; coopBtn.disabled = false; });
}
play.onclick = () => startGame();

// ---- online co-op (net.ts, runtime/mp_web.cpp, tools/netswitch.mjs) ----
const coopBtn = document.getElementById('coopBtn') as HTMLButtonElement;
const coopDlg = document.getElementById('coopDlg') as HTMLDialogElement;
const mpName = document.getElementById('mpName') as HTMLInputElement;
const mpList = document.getElementById('mpList') as HTMLDivElement;
// the session's names: A-Z 0-9, 12 letters (crashott-pc's online/mp_lobby.h)
const cleanName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
try { mpName.value = localStorage.getItem('crashott-mp-name') ?? ''; } catch { /* no storage */ }
mpName.oninput = () => {
  const v = cleanName(mpName.value);
  if (v !== mpName.value) mpName.value = v;
  try { localStorage.setItem('crashott-mp-name', v); } catch { /* no storage */ }
};
const playerName = () => cleanName(mpName.value) || 'PLAYER';
let listTimer = 0;
async function drawHosts() {
  const hosts = await listHosts();
  mpList.replaceChildren();
  if (!hosts.length) {
    const p = document.createElement('p');
    p.className = 'dlgnote';
    p.textContent = 'No session on this server yet. Host one, or wait for a friend to host.';
    mpList.append(p);
    return;
  }
  for (const h of hosts) {
    const row = document.createElement('div');
    row.className = 'host';
    const label = document.createElement('div');
    label.textContent = h.name || 'PLAYER';
    const info = document.createElement('span');
    info.textContent = ` ${h.players || 1}/${h.maxPlayers || 4} players${h.inGame ? ' · in a level (you come in at the next one)' : ''}`;
    label.append(info);
    const join = document.createElement('button');
    join.textContent = 'Join';
    // during a level too: the player waits at the main menu and comes in at the host's next level
    join.disabled = play.disabled;
    join.title = h.inGame ? 'The host is in a level: you wait at the main menu and come in at its next level' : '';
    join.onclick = () => { coopDlg.close(); startGame({ role: 'join', name: playerName(), join: h.ip }); };
    row.append(label, join);
    mpList.append(row);
  }
}
coopBtn.onclick = () => {
  void drawHosts();
  listTimer = window.setInterval(() => void drawHosts(), 2000);
  coopDlg.showModal();
};
coopDlg.addEventListener('close', () => clearInterval(listTimer));
(document.getElementById('coopDone') as HTMLButtonElement).onclick = () => coopDlg.close();
(document.getElementById('mpHost') as HTMLButtonElement).onclick = () => { coopDlg.close(); startGame({ role: 'host', name: playerName() }); };

/** The session's panel over the game (the runtime's status, mp_web.cpp) and the client's menu in a level. */
function startMpPanel(net: GameNet, mp: MpChoice) {
  const panel = document.getElementById('mpPanel') as HTMLDivElement;
  const levelDlg = document.getElementById('mpLevelDlg') as HTMLDialogElement;
  const resumeBtn = document.getElementById('mpResume') as HTMLButtonElement, leaveBtn = document.getElementById('mpLeave') as HTMLButtonElement;
  // the runtime's status still says "menu open" for a moment after Resume / Leave: not opened again meanwhile
  let closedAt = 0;
  const closeLevelMenu = (command: string) => { net.command(command); closedAt = performance.now(); if (levelDlg.open) levelDlg.close(); };
  resumeBtn.onclick = () => closeLevelMenu('resume');
  leaveBtn.onclick = () => closeLevelMenu('leave');
  levelDlg.addEventListener('cancel', e => { e.preventDefault(); closeLevelMenu('resume'); });
  // The menu with the gamepad (it is the page's, not the game's): START or B resume, A presses the button that has
  // the focus, the D-pad or the left stick goes from one button to the other. A button counts once it is let go
  // and pressed again (the START that opened the menu is still held when it shows).
  const pad = loadPadBindings(), keysBound = loadBindings();
  // the keyboard's START / B (the player's keys) resume too; Esc is the dialog's own cancel
  window.addEventListener('keydown', e => {
    if (!levelDlg.open || e.repeat || e.code === 'Escape') return;
    if (e.code === keysBound.start || e.code === keysBound.b) { e.preventDefault(); closeLevelMenu('resume'); }
  });
  let padHeld = new Set<string>(), padLoop = 0;
  const padFrame = () => {
    if (!levelDlg.open) { padLoop = 0; return; }
    const g = (navigator.getGamepads?.() ?? []).find((p): p is Gamepad => !!p && p.connected);
    const now = new Set<string>();
    if (g) {
      const b = (i: number) => !!g.buttons[i]?.pressed;
      if (b(pad.start)) now.add('start');
      if (b(pad.b)) now.add('b');
      if (b(pad.a)) now.add('a');
      if (b(pad.left) || (g.axes[0] ?? 0) < -0.5) now.add('left');
      if (b(pad.right) || (g.axes[0] ?? 0) > 0.5) now.add('right');
    }
    const pressed = (k: string) => now.has(k) && !padHeld.has(k);
    if (pressed('start') || pressed('b')) closeLevelMenu('resume');
    else if (pressed('a')) (document.activeElement === leaveBtn ? leaveBtn : resumeBtn).click();
    else if (pressed('left')) leaveBtn.focus();
    else if (pressed('right')) resumeBtn.focus();
    padHeld = now;
    padLoop = requestAnimationFrame(padFrame);
  };
  const openLevelMenu = () => {
    levelDlg.showModal();
    resumeBtn.focus();
    gameInput?.setBlocked(true);
    // what is held as it opens (the START that opened it) counts only once let go
    padHeld = new Set(['start', 'b', 'a', 'left', 'right']);
    if (!padLoop) padLoop = requestAnimationFrame(padFrame);
  };
  // tests (out/coop.mjs): a command to the session from the console
  (window as unknown as { mpCommand?: (t: string) => void }).mpCommand = t => net.command(t);
  panel.hidden = false;
  panel.textContent = mp.role === 'host' ? 'Online co-op: connecting...' : 'Online co-op: joining...';
  let lastState = '';
  setInterval(() => {
    const s = net.status() as null | { state: string; reason?: string; address?: string; inGame?: boolean; clientInLevel?: boolean;
      levelMenu?: boolean; maxPlayers?: number; players?: { slot: number; name: string; ping: number; me: boolean }[] };
    if (!s) return;
    if (s.state !== lastState) { log(`[mp] session: ${s.state}${s.reason ? ` (${s.reason})` : ''}`); lastState = s.state; }
    const players = s.players ?? [];
    net.announce({ name: mp.name, hosting: s.state === 'hosting', players: players.length, maxPlayers: s.maxPlayers, inGame: s.inGame });
    const head = { hosting: 'Hosting', joining: 'Joining...', joined: 'Joined', failed: 'Not connected', off: 'Session closed', searching: 'Searching...' }[s.state] ?? s.state;
    const lines: string[] = [`<b>Online co-op</b> · ${head}`];
    if (s.state === 'failed' || s.state === 'off') lines.push(s.reason || 'The session ended.');
    // out of the session: its last roster no more (it listed players who were gone)
    if (s.state !== 'failed' && s.state !== 'off') for (const p of players) lines.push(`${p.me ? '<span class="me">' : ''}P${p.slot + 1} ${escapeHtml(p.name)}${p.me ? ' (you)</span>' : ` · ${p.ping} ms`}`);
    if (s.state === 'joined' && !s.clientInLevel) lines.push(s.inGame ? 'The host is in a level: you follow it into the next one.' : 'Waiting for the host to start a level...');
    if (s.state === 'hosting' && players.length < 2) lines.push('Waiting for players (Play online co-op on their start page).');
    panel.innerHTML = lines.join('<br>');
    // a client waiting for the host's level stays at the main menu (the level start is taken there); its menu over a
    // level takes the gamepad (the game sees nothing pressed meanwhile, as crashott-pc's own menu does)
    if (s.levelMenu && !levelDlg.open && performance.now() - closedAt > 1500) openLevelMenu();
    else if (!s.levelMenu && levelDlg.open) levelDlg.close();
    gameInput?.setBlocked((s.state === 'joined' && !s.clientInLevel) || levelDlg.open || reportOpen);
  }, 500);
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
