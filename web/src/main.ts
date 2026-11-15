// The page: a Start button, then the game module (/crashott.wasm, built by tools/wasm_runtime.sh)
// on a pool of game-thread workers (host/worker.ts), drawn by the WebGPU executor (gpu/executor.ts)
// once the game's recorder registers its control block.
//
// Query parameters: env=KEY=VALUE (repeatable) for the game's environment.
import { C_INTS, C_POOL, C_TID, FD_MAX, FD_SZ, INITIAL_PAGES, MAX_PAGES, POOL, S_IDLE, S_MAIN, type BootConfig, type ToPage } from './host/proto';
import { Executor } from './gpu/executor';

const statusEl = document.getElementById('status') as HTMLDivElement;
const startEl = document.getElementById('start') as HTMLDivElement;
const stageEl = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const play = document.getElementById('play') as HTMLButtonElement;
const q = new URLSearchParams(location.search);

const status = (s: string) => { statusEl.textContent = s; };
const log = (s: string) => console.log(s);
const fail = (s: string) => { console.error(s); status(s); };

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

async function start() {
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

play.onclick = () => {
  play.disabled = true;
  start().catch(e => { fail(String(e?.message ?? e)); play.disabled = false; });
};
