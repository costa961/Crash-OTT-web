// The WebGPU executor: replays the command ring of the game's recorder (runtime/gpu_web/rhi_webgpu.cpp,
// contract in runtime/gpu_web/webgpu_proto.h) on the page's main thread, once per animation frame.
//
// - The upload ring is mirrored in one GPU buffer: at every WG_SUBMIT / WG_PRESENT the ranges the game
//   wrote since the previous one are copied there (queue.writeBuffer) before the batch is submitted, and
//   the record's fence goes back to the game, which then reuses those ranges.
// - Draw shaders are WGSL from the translator (runtime/gpu_web/shader_translator_wgsl.cpp): group 0 =
//   system constants, vertex / pixel float constants, effect constants (dynamic offsets into the ring)
//   and the ring as vertex data; group 1 = texture N at binding N, its sampler at 32 + N.
// - The built-in passes' HLSL is replaced by passes.ts's WGSL of the same name.
import { formatOf, renderTargetFormatOf, type FormatInfo } from './formats';
import { CLEAR_COLOR_PS, DEPTH_COPY_PS, DRAW_PS, FULLSCREEN_VS, PASS_PS } from './passes';

// webgpu_proto.h
const WG_MAGIC = 0x43475757, WG_VERSION = 1;
const CTL = { cmdRing: 2, cmdSize: 3, uploadRing: 4, uploadSize: 5, attached: 6, canvasWidth: 7, canvasHeight: 8, presentFormat: 9,
  features: 10, writePos: 12, readPos: 13, fence: 14, presented: 15 } as const;
const OP = { PAD: 0, CREATE_TEXTURE: 1, DESTROY: 2, CREATE_BUFFER: 3, COPY_UPLOAD: 4, COPY_TEXTURE: 5, CLEAR_COLOR: 6, CLEAR_DS: 7,
  CREATE_SHADER: 8, CREATE_DRAW_PIPELINE: 9, CREATE_PASS_PIPELINE: 10, DRAW: 11, DRAW_PASS: 12, SUBMIT: 13, PRESENT: 14, RESIZE: 15 } as const;
const TEX_BACKBUFFER = 1, TEX_NULL = 2;
const WG_FEATURE_BC = 1;
const LANG_WGSL = 0;
const USAGE_RENDER_TARGET = 2, USAGE_DEPTH_STENCIL = 4;

// The group 0 binding sizes (the translator's structs, padded): system constants, float constants,
// effect constants.
const SYSTEM_BYTES = 1024, CONSTS_BYTES = 4096, EFFECTS_BYTES = 256;
const RING_PAD = 64 * 1024;

const COMPARE: GPUCompareFunction[] = ['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'];
const STENCIL_OP: GPUStencilOperation[] = ['keep', 'zero', 'replace', 'increment-clamp', 'decrement-clamp', 'invert', 'increment-wrap', 'decrement-wrap'];
const TOPOLOGY: GPUPrimitiveTopology[] = ['point-list', 'line-list', 'line-strip', 'triangle-list', 'triangle-strip'];
const CULL: GPUCullMode[] = ['none', 'front', 'back'];

function blendFactor(f: number, alpha: boolean): GPUBlendFactor {
  switch (f) {
    case 0: return 'zero';
    case 1: return 'one';
    case 4: return alpha ? 'src-alpha' : 'src';
    case 5: return alpha ? 'one-minus-src-alpha' : 'one-minus-src';
    case 6: return 'src-alpha';
    case 7: return 'one-minus-src-alpha';
    case 8: return alpha ? 'dst-alpha' : 'dst';
    case 9: return alpha ? 'one-minus-dst-alpha' : 'one-minus-dst';
    case 10: return 'dst-alpha';
    case 11: return 'one-minus-dst-alpha';
    case 12: return 'constant';
    case 13: return 'one-minus-constant';
    case 14: return 'constant';
    case 15: return 'one-minus-constant';
    case 16: return alpha ? 'one' : 'src-alpha-saturated';
    default: return 'one';
  }
}
const BLEND_OP: GPUBlendOperation[] = ['add', 'subtract', 'min', 'max', 'reverse-subtract'];

interface Tex { texture: GPUTexture; info: FormatInfo; dxgi: number; renderDxgi: number; width: number; height: number; levels: number;
  views: Map<string, GPUTextureView>; gen?: number; }
interface Shader { module: GPUShaderModule | null; name: string; stage: number; textures: number[]; outputs: number[]; }
interface DrawPipe { pipeline: GPURenderPipeline | null; group1: GPUBindGroupLayout; textures: number[]; colorCount: number; colorFormats: number[];
  depthFormat: number; }
interface PassPipe { pipeline: GPURenderPipeline | null; name: string; constantBytes: number; textureCount: number; samplers: GPUSampler[]; }

export interface ExecutorOptions {
  device: GPUDevice;
  context: GPUCanvasContext;
  canvas: HTMLCanvasElement;
  memory: WebAssembly.Memory;
  ctlPtr: number;
  log: (s: string) => void;
}

export class Executor {
  private dev: GPUDevice;
  private ctx: GPUCanvasContext;
  private mem: WebAssembly.Memory;
  private ctlPtr: number;
  private log: (s: string) => void;
  private features: Set<string>;
  private ring!: GPUBuffer;
  private group0Layout!: GPUBindGroupLayout;
  private group0!: GPUBindGroup;
  private res = new Map<number, unknown>();
  private enc: GPUCommandEncoder | null = null;
  private pass: GPURenderPassEncoder | null = null;
  private passKey = '';
  private passSize = [0, 0];
  private backView: GPUTextureView | null = null;
  private nullTex!: Tex;
  private samplers = new Map<string, GPUSampler>();
  private group1Layouts = new Map<string, GPUBindGroupLayout>();
  private clearPipes = new Map<string, GPURenderPipeline>();
  private warned = new Set<string>();
  private stats = { frames: 0, draws: 0, skipped: 0, passes: 0, errors: 0 };
  private presentFormat: GPUTextureFormat;
  private running = true;
  private emptyFs: GPUShaderModule | null = null;
  private presentLogs = 0;
  /** Depth textures sampled by draws, as r32float copies (WebGPU can't bind a depth view where the
   *  translated shaders sample a filterable float texture): texture id -> copy, made again when the
   *  depth changed (Tex.gen: it was a depth attachment or cleared since). */
  private depthCopies = new Map<number, { gen: number; texture: GPUTexture; view: GPUTextureView }>();
  private depthCopyPipe: GPURenderPipeline | null = null;
  /** ?offscreen=1 (tools/shot.mjs): the back buffer is a texture of our own, read back twice a second
   *  into a 2D canvas over the WebGPU one. Headless Chrome on SwiftShader can't allocate a canvas swap
   *  chain at all; a real browser never needs this. */
  private offscreen: { texture: GPUTexture; view: GPUTextureView; canvas: HTMLCanvasElement; busy: boolean; last: number } | null = null;
  /** ?skip=draw,pass,copy,upload,clear: record kinds not executed (bisecting a GPU problem) */
  private skip = new Set((new URLSearchParams(location.search).get('skip') ?? '').split(',').filter(Boolean));

  constructor(o: ExecutorOptions) {
    this.dev = o.device; this.ctx = o.context; this.mem = o.memory; this.ctlPtr = o.ctlPtr; this.log = o.log;
    this.features = new Set(o.device.features);
    // The browser's own canvas format (bgra8unorm on most desktops, rgba8unorm on Linux / Android):
    // the other one may not be presentable (headless SwiftShader lost the device with it).
    // ?canvas=rgba8unorm overrides it: headless Chrome on SwiftShader reports bgra8unorm but can't
    // allocate such a swap chain (tools/shot.mjs passes it).
    const asked = new URLSearchParams(location.search).get('canvas');
    this.presentFormat = asked === 'rgba8unorm' || asked === 'bgra8unorm' ? asked : navigator.gpu.getPreferredCanvasFormat();
    const ctl = this.ctl();
    if (ctl.u32[0] !== WG_MAGIC || ctl.u32[1] !== WG_VERSION) throw new Error(`gpu: control block 0x${o.ctlPtr.toString(16)} has a wrong magic or version`);
    if (new URLSearchParams(location.search).get('offscreen') === '1') {
      this.presentFormat = 'rgba8unorm';
      const texture = this.dev.createTexture({ size: [o.canvas.width, o.canvas.height], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, label: 'offscreen back buffer' });
      const canvas = document.createElement('canvas');
      canvas.width = o.canvas.width; canvas.height = o.canvas.height;
      canvas.style.cssText = o.canvas.style.cssText || 'width:100%;height:100%;object-fit:contain;display:block';
      o.canvas.replaceWith(canvas);
      this.offscreen = { texture, view: texture.createView(), canvas, busy: false, last: 0 };
    } else {
      this.ctx.configure({ device: this.dev, format: this.presentFormat, alphaMode: 'opaque' });
    }
    const uploadSize = ctl.u32[CTL.uploadSize];
    this.ring = this.dev.createBuffer({ size: uploadSize + RING_PAD,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_SRC, label: 'upload ring' });
    const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.group0Layout = this.dev.createBindGroupLayout({ label: 'draw group 0', entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 3, visibility: both, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ] });
    this.group0 = this.dev.createBindGroup({ layout: this.group0Layout, entries: [
      { binding: 0, resource: { buffer: this.ring, size: SYSTEM_BYTES } },
      { binding: 1, resource: { buffer: this.ring, size: CONSTS_BYTES } },
      { binding: 2, resource: { buffer: this.ring, size: CONSTS_BYTES } },
      { binding: 3, resource: { buffer: this.ring, size: EFFECTS_BYTES } },
      { binding: 4, resource: { buffer: this.ring, size: uploadSize } },
    ] });
    const nullTexture = this.dev.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.dev.queue.writeTexture({ texture: nullTexture }, new Uint8Array(4), { bytesPerRow: 4 }, [1, 1]);
    this.nullTex = { texture: nullTexture, info: formatOf(28, this.features)!, dxgi: 28, renderDxgi: 28, width: 1, height: 1, levels: 1, views: new Map() };
    this.res.set(TEX_NULL, this.nullTex);
    this.dev.onuncapturederror = ev => {
      if (this.stats.errors++ < 20) this.log(`[webgpu] ${ev.error.message}`);
    };
    // The game may start recording now.
    ctl.i32[CTL.canvasWidth] = o.canvas.width;
    ctl.i32[CTL.canvasHeight] = o.canvas.height;
    ctl.i32[CTL.presentFormat] = this.presentFormat === 'rgba8unorm' ? 28 : 87;
    ctl.i32[CTL.features] = this.features.has('texture-compression-bc') ? WG_FEATURE_BC : 0;
    Atomics.store(ctl.i32, CTL.attached, 1);
    Atomics.notify(ctl.i32, CTL.attached);
    this.log(`[webgpu] executor attached: ring ${uploadSize >> 20} MB, features ${[...this.features].join(' ')}`);
    const frame = () => { if (!this.running) return; this.run(10); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    setInterval(() => {
      const s = this.stats;
      this.log(`[webgpu] ${s.frames} frames, ${s.draws} draws (${s.skipped} skipped), ${s.passes} passes, ${s.errors} errors`);
    }, 5000);
  }

  /** Frames presented so far (the page's FPS counter). */
  get framesPresented(): number { return this.stats.frames; }

  stop() {
    this.running = false;
    Atomics.store(this.ctl().i32, CTL.attached, 0);
  }

  private ctl() {
    const b = this.mem.buffer as unknown as ArrayBuffer;
    return { u32: new Uint32Array(b, this.ctlPtr, 16), i32: new Int32Array(b, this.ctlPtr, 16) };
  }

  private warn(key: string, s: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(`[webgpu] ${s}`);
  }

  /** Replays records for up to `budgetMs`, stopping after a present once the budget is spent. */
  run(budgetMs: number) {
    const t0 = performance.now();
    const ctl = this.ctl();
    const ringAddr = ctl.u32[CTL.cmdRing], ringSize = ctl.u32[CTL.cmdSize];
    const buf = this.mem.buffer as unknown as ArrayBuffer;
    const u32 = new Uint32Array(buf), f32 = new Float32Array(buf), i32 = new Int32Array(buf), u8 = new Uint8Array(buf);
    let read = ctl.u32[CTL.readPos];
    // The canvas's texture is only valid in the task that got it: a batch (the records up to a
    // WG_SUBMIT / WG_PRESENT) is never split across two animation frames. Find the last boundary.
    this.backView = null;
    const write = Atomics.load(ctl.i32, CTL.writePos) >>> 0;
    let end = read;
    for (let p = read; p !== write;) {
      const a = ringAddr + (p & (ringSize - 1));
      const op = u32[a >> 2] & 0xFFFF, size = u32[(a >> 2) + 1];
      if (!size) break;
      p = (p + size) >>> 0;
      if (op === OP.SUBMIT || op === OP.PRESENT) end = p;
    }
    for (;;) {
      if (read === end) break;
      const at = ringAddr + (read & (ringSize - 1));
      const op = u32[at >> 2] & 0xFFFF, size = u32[(at >> 2) + 1];
      const w = (at >> 2) + 2;   // first payload word
      let presented = false;
      try {
        presented = this.record(op, w, size - 8, u32, f32, i32, u8);
      } catch (e) {
        this.warn(`op${op}:${String(e)}`, `record ${op} failed: ${String(e)}`);
      }
      read = (read + size) >>> 0;
      Atomics.store(ctl.i32, CTL.readPos, read | 0);
      Atomics.notify(ctl.i32, CTL.readPos);
      if (presented && performance.now() - t0 > budgetMs) break;
    }
  }

  private str(u8: Uint8Array, byte: number, len: number): string {
    return new TextDecoder().decode(u8.slice(byte, byte + len));
  }

  private record(op: number, w: number, bytes: number, u32: Uint32Array, f32: Float32Array, i32: Int32Array, u8: Uint8Array): boolean {
    switch (op) {
      case OP.PAD: return false;
      case OP.CREATE_TEXTURE: this.createTexture(u32[w], u32[w + 1], u32[w + 2], u32[w + 3], u32[w + 4], u32[w + 5], u32[w + 6]); return false;
      case OP.DESTROY: {
        const r = this.res.get(u32[w]) as Tex | undefined;
        if (r && 'texture' in r) { this.endPass(); r.texture.destroy(); }
        const copy = this.depthCopies.get(u32[w]);
        if (copy) { copy.texture.destroy(); this.depthCopies.delete(u32[w]); }
        this.res.delete(u32[w]);
        return false;
      }
      case OP.CREATE_BUFFER: this.res.set(u32[w], { address: u32[w + 1], size: u32[w + 2] }); return false;
      case OP.COPY_UPLOAD: if (this.skip.has('upload')) return false; this.copyUpload(u32[w], u32[w + 1], u32[w + 2], u32[w + 3], u32[w + 4], u32[w + 5]); return false;
      case OP.COPY_TEXTURE: if (this.skip.has('copy')) return false; this.copyTexture(u32[w], u32[w + 1], u32[w + 2] ? [i32[w + 3], i32[w + 4], i32[w + 5], i32[w + 6]] : null); return false;
      case OP.CLEAR_COLOR:
      case OP.CLEAR_DS:
        if (this.skip.has('clear')) return false;
        this.clear(op === OP.CLEAR_DS, u32[w], [f32[w + 1], f32[w + 2], f32[w + 3], f32[w + 4]], f32[w + 5], u32[w + 6],
          u32[w + 7] ? [i32[w + 8], i32[w + 9], i32[w + 10], i32[w + 11]] : null);
        return false;
      case OP.CREATE_SHADER: {
        const nameBytes = u32[w + 4], srcBytes = u32[w + 5], base = (w + 6) * 4;
        const name = this.str(u8, base, nameBytes), src = this.str(u8, base + ((nameBytes + 3) & ~3), srcBytes);
        this.createShader(u32[w], u32[w + 1], u32[w + 2], u32[w + 3], name, src);
        return false;
      }
      case OP.CREATE_DRAW_PIPELINE: this.createDrawPipeline(u32, i32, f32, w); return false;
      case OP.CREATE_PASS_PIPELINE: this.createPassPipeline(u32, u8, w); return false;
      case OP.DRAW: if (this.skip.has('draw')) return false; this.draw(u32, f32, i32, u8, w); return false;
      case OP.DRAW_PASS: if (this.skip.has('pass')) return false; this.drawPass(u32, f32, i32, w); return false;
      case OP.SUBMIT:
      case OP.PRESENT: {
        this.submit(u32, w);
        if (op === OP.PRESENT) {
          this.backView = null;
          this.showOffscreen();
          this.stats.frames++;
          const ctl = this.ctl();
          Atomics.add(ctl.i32, CTL.presented, 1);
          return true;
        }
        return false;
      }
      case OP.RESIZE: return false;
      default:
        this.warn(`op${op}`, `unknown record ${op} (${bytes} bytes)`);
        return false;
    }
  }

  // ---- resources ----
  private createTexture(id: number, width: number, height: number, levels: number, dxgi: number, renderDxgi: number, usage: number) {
    // A render target's format may differ (renderTargetFormatOf: 8-bit snorm without texture-formats-tier1).
    const fmtOf = usage & USAGE_RENDER_TARGET ? renderTargetFormatOf : formatOf;
    const info = fmtOf(dxgi, this.features);
    if (!info) { this.warn(`fmt${dxgi}`, `texture format DXGI ${dxgi} has no WebGPU equivalent here`); return; }
    const render = renderDxgi ? fmtOf(renderDxgi, this.features) : null;
    let flags = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
    if (usage & (USAGE_RENDER_TARGET | USAGE_DEPTH_STENCIL)) flags |= GPUTextureUsage.RENDER_ATTACHMENT;
    // A BC texture's size rounds up to whole blocks at level 0 (WebGPU requires it).
    const w = info.block > 1 ? Math.ceil(width / 4) * 4 : width, h = info.block > 1 ? Math.ceil(height / 4) * 4 : height;
    const viewFormats = render && render.format !== info.format ? [render.format] : [];
    const texture = this.dev.createTexture({ size: [Math.max(1, w), Math.max(1, h)], mipLevelCount: Math.max(1, levels), format: info.format, usage: flags,
      viewFormats, label: `tex ${id}` });
    this.res.set(id, { texture, info, dxgi, renderDxgi: renderDxgi || dxgi, width: Math.max(1, width), height: Math.max(1, height),
      levels: Math.max(1, levels), views: new Map() } satisfies Tex);
  }

  private tex(id: number): Tex | null {
    if (id === 0) return null;
    return (this.res.get(id) as Tex | undefined) ?? null;
  }

  /** view: 0 default (sampled), 1 depth, 2 stencil, 3 render (the render view's format) */
  private view(t: Tex, kind: number): GPUTextureView {
    const key = String(kind);
    let v = t.views.get(key);
    if (!v) {
      if (kind === 1) v = t.texture.createView({ aspect: 'depth-only' });
      else if (kind === 2) v = t.texture.createView({ aspect: 'stencil-only' });
      else if (kind === 3) {
        const render = renderTargetFormatOf(t.renderDxgi, this.features);
        v = t.texture.createView({ format: render?.format ?? t.info.format, baseMipLevel: 0, mipLevelCount: 1 });
      } else v = t.texture.createView();
      t.views.set(key, v);
    }
    return v;
  }

  private backBufferView(): GPUTextureView {
    if (this.offscreen) return this.offscreen.view;
    if (!this.backView) this.backView = this.ctx.getCurrentTexture().createView();
    return this.backView;
  }

  /** ?offscreen=1: the back buffer to the 2D canvas, at most twice a second. */
  private showOffscreen() {
    const o = this.offscreen;
    if (!o || o.busy || performance.now() - o.last < 500) return;
    o.busy = true; o.last = performance.now();
    const w = o.canvas.width, h = o.canvas.height, bpr = Math.ceil(w * 4 / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: o.texture }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    this.dev.queue.submit([enc.finish()]);
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const src = new Uint8Array(buf.getMappedRange()), img = new ImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      o.canvas.getContext('2d')!.putImageData(img, 0, 0);
      buf.destroy(); o.busy = false;
    }, () => { buf.destroy(); o.busy = false; });
  }

  private encoder(): GPUCommandEncoder {
    if (!this.enc) this.enc = this.dev.createCommandEncoder();
    return this.enc;
  }

  private endPass() {
    if (this.pass) { this.pass.end(); this.pass = null; this.passKey = ''; }
  }

  private copyUpload(id: number, level: number, offset: number, rowPitch: number, width: number, height: number) {
    const t = this.tex(id);
    if (!t) return;
    this.endPass();
    const b = t.info.block;
    const w = Math.ceil(width / b) * b, h = Math.ceil(height / b) * b;
    this.encoder().copyBufferToTexture({ buffer: this.ring, offset, bytesPerRow: rowPitch, rowsPerImage: h / b },
      { texture: t.texture, mipLevel: level }, [w, h]);
  }

  private copyTexture(dst: number, src: number, rect: number[] | null) {
    const d = this.tex(dst), s = this.tex(src);
    if (!d || !s) return;
    this.endPass();
    const x = rect ? Math.max(0, rect[0]) : 0, y = rect ? Math.max(0, rect[1]) : 0;
    const w = Math.min(rect ? rect[2] - x : s.width, s.width - x, d.width - x), h = Math.min(rect ? rect[3] - y : s.height, s.height - y, d.height - y);
    if (w <= 0 || h <= 0) return;
    if (s.info.format !== d.info.format && s.info.format.replace('-srgb', '') !== d.info.format.replace('-srgb', '')) {
      this.warn(`copy${s.dxgi}-${d.dxgi}`, `copy between formats ${s.info.format} and ${d.info.format} skipped`);
      return;
    }
    if (s.info.depth) { this.warn('copydepth', 'depth texture copies are not supported by WebGPU: skipped'); return; }
    this.encoder().copyTextureToTexture({ texture: s.texture, origin: [x, y] }, { texture: d.texture, origin: [x, y] }, [w, h]);
  }

  private clear(depthStencil: boolean, id: number, color: number[], depth: number, stencil: number, rect: number[] | null) {
    const t = id === TEX_BACKBUFFER ? null : this.tex(id);
    if (id !== TEX_BACKBUFFER && !t) return;
    this.endPass();
    const width = t ? t.width : this.ctx.canvas.width, height = t ? t.height : this.ctx.canvas.height;
    const full = !rect || (rect[0] <= 0 && rect[1] <= 0 && rect[2] >= width && rect[3] >= height);
    const enc = this.encoder();
    if (depthStencil && t) {
      t.gen = (t.gen ?? 0) + 1;
      const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
        view: this.view(t, 0), depthLoadOp: full ? 'clear' : 'load', depthStoreOp: 'store', depthClearValue: depth,
        ...(t.info.stencil ? { stencilLoadOp: full ? 'clear' : 'load', stencilStoreOp: 'store', stencilClearValue: stencil } : {}),
      } as GPURenderPassDepthStencilAttachment });
      if (!full) {
        const pipe = this.clearPipeline('ds', t.info.format);
        const r = this.clampRect(rect!, width, height);
        if (r) {
          pass.setPipeline(pipe);
          pass.setViewport(0, 0, width, height, depth, depth);
          pass.setScissorRect(r[0], r[1], r[2], r[3]);
          pass.setStencilReference(stencil);
          pass.draw(3);
        }
      }
      pass.end();
      return;
    }
    const view = t ? this.view(t, 3) : this.backBufferView();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: full ? 'clear' : 'load', storeOp: 'store',
      clearValue: { r: color[0], g: color[1], b: color[2], a: color[3] } }] });
    if (!full) {
      const fmt = t ? (renderTargetFormatOf(t.renderDxgi, this.features)?.format ?? t.info.format) : this.presentFormat;
      const r = this.clampRect(rect!, width, height);
      if (r) {
        pass.setPipeline(this.clearPipeline('color', fmt));
        pass.setBlendConstant({ r: color[0], g: color[1], b: color[2], a: color[3] });
        pass.setScissorRect(r[0], r[1], r[2], r[3]);
        pass.draw(3);
      }
    }
    pass.end();
  }

  private clampRect(rect: number[], width: number, height: number): number[] | null {
    const x = Math.max(0, Math.min(rect[0], width)), y = Math.max(0, Math.min(rect[1], height));
    const r = Math.max(x, Math.min(rect[2], width)), b = Math.max(y, Math.min(rect[3], height));
    return r > x && b > y ? [x, y, r - x, b - y] : null;
  }

  private clearPipeline(kind: 'color' | 'ds', format: GPUTextureFormat): GPURenderPipeline {
    const key = `${kind}:${format}`;
    let p = this.clearPipes.get(key);
    if (!p) {
      const vs = this.dev.createShaderModule({ code: FULLSCREEN_VS });
      if (kind === 'color') {
        p = this.dev.createRenderPipeline({ layout: 'auto', vertex: { module: vs, entryPoint: 'main' },
          fragment: { module: this.dev.createShaderModule({ code: CLEAR_COLOR_PS }), entryPoint: 'main', targets: [{ format,
            blend: { color: { srcFactor: 'constant', dstFactor: 'zero' }, alpha: { srcFactor: 'constant', dstFactor: 'zero' } } }] } });
      } else {
        const stencil = format.includes('stencil');
        p = this.dev.createRenderPipeline({ layout: 'auto', vertex: { module: vs, entryPoint: 'main' },
          depthStencil: { format, depthWriteEnabled: true, depthCompare: 'always',
            ...(stencil ? { stencilFront: { compare: 'always', passOp: 'replace' }, stencilBack: { compare: 'always', passOp: 'replace' },
              stencilWriteMask: 0xFF } : {}) } });
      }
      this.clearPipes.set(key, p);
    }
    return p;
  }

  // ---- shaders and pipelines ----
  private createShader(id: number, stage: number, layout: number, lang: number, name: string, src: string) {
    let code: string | null = lang === LANG_WGSL ? src : null;
    if (!code && layout === 0 && DRAW_PS[name]) code = DRAW_PS[name];
    if (!code) {
      this.warn(`shader:${name}`, `shader ${name} has no WGSL (skipped)`);
      this.res.set(id, { module: null, name, stage, textures: [], outputs: [] } satisfies Shader);
      return;
    }
    const textures = [...code.matchAll(/@group\(1\)\s*@binding\((\d+)\)\s*var\s+\w+\s*:\s*texture/g)].map(m => Number(m[1]));
    const outputs = stage === 1 ? [...code.matchAll(/@location\((\d+)\)\s*color/g)].map(m => Number(m[1])) : [];
    if (stage === 1 && DRAW_PS[name]) outputs.push(0);
    const module = this.dev.createShaderModule({ code, label: name });
    module.getCompilationInfo().then(info => {
      for (const m of info.messages) if (m.type === 'error') this.warn(`compile:${name}`, `${name}: ${m.lineNum}:${m.linePos} ${m.message}`);
    });
    this.res.set(id, { module, name, stage, textures, outputs } satisfies Shader);
  }

  private group1Layout(textures: number[]): GPUBindGroupLayout {
    const key = textures.join(',');
    let l = this.group1Layouts.get(key);
    if (!l) {
      const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
      const entries: GPUBindGroupLayoutEntry[] = [];
      for (const n of textures) {
        entries.push({ binding: n, visibility: both, texture: { sampleType: 'float' } });
        entries.push({ binding: 32 + n, visibility: both, sampler: { type: 'filtering' } });
      }
      l = this.dev.createBindGroupLayout({ entries, label: `group 1 [${key}]` });
      this.group1Layouts.set(key, l);
    }
    return l;
  }

  private createDrawPipeline(u32: Uint32Array, i32: Int32Array, f32: Float32Array, w: number) {
    const id = u32[w], vs = this.res.get(u32[w + 1]) as Shader | undefined, ps = this.res.get(u32[w + 2]) as Shader | undefined;
    const colorFormats = [u32[w + 4], u32[w + 5], u32[w + 6], u32[w + 7]], depthFormat = u32[w + 8], colorCount = u32[w + 9];
    const blend = [u32[w + 10], u32[w + 11], u32[w + 12], u32[w + 13]], colorMask = u32[w + 14], depthControl = u32[w + 15];
    const stencilMasks = u32[w + 16], depthBias = i32[w + 17], slopeBias = f32[w + 18];
    const cull = u32[w + 19], topology = u32[w + 20], depthClip = u32[w + 21];
    const textures = [...new Set([...(vs?.textures ?? []), ...(ps?.textures ?? [])])].sort((a, b) => a - b);
    const group1 = this.group1Layout(textures);
    const entry: DrawPipe = { pipeline: null, group1, textures, colorCount, colorFormats, depthFormat };
    this.res.set(id, entry);
    if (!vs?.module || (ps && !ps.module)) return;
    const targets: (GPUColorTargetState | null)[] = [];
    for (let i = 0; i < colorCount; i++) {
      const fmt = colorFormats[i] ? renderTargetFormatOf(colorFormats[i], this.features) : null;
      if (!fmt) { targets.push(null); continue; }
      const c = blend[i];
      const cs = c & 0x1F, co = (c >> 5) & 7, cd = (c >> 8) & 0x1F, as = (c >> 16) & 0x1F, ao = (c >> 21) & 7, ad = (c >> 24) & 0x1F;
      const enabled = !(cs === 1 && cd === 0 && co === 0 && as === 1 && ad === 0 && ao === 0);
      const writes = ps?.outputs.includes(i) ?? false;
      targets.push({ format: fmt.format, writeMask: writes ? (colorMask >> (4 * i)) & 0xF : 0,
        blend: enabled ? { color: { srcFactor: blendFactor(cs, false), dstFactor: blendFactor(cd, false), operation: BLEND_OP[co] ?? 'add' },
          alpha: { srcFactor: blendFactor(as, true), dstFactor: blendFactor(ad, true), operation: BLEND_OP[ao] ?? 'add' } } : undefined });
    }
    let depthStencil: GPUDepthStencilState | undefined;
    if (depthFormat) {
      const fmt = formatOf(depthFormat, this.features)!;
      const depthTest = (depthControl >> 1) & 1, depthWrite = (depthControl >> 2) & 1, stencilTest = depthControl & 1;
      const face = (cmp: number, fail: number, pass: number, zfail: number): GPUStencilFaceState => stencilTest
        ? { compare: COMPARE[cmp], failOp: STENCIL_OP[fail], passOp: STENCIL_OP[pass], depthFailOp: STENCIL_OP[zfail] }
        : { compare: 'always', failOp: 'keep', passOp: 'keep', depthFailOp: 'keep' };
      const front = face((depthControl >> 8) & 7, (depthControl >> 11) & 7, (depthControl >> 14) & 7, (depthControl >> 17) & 7);
      const back = (depthControl >> 7) & 1 ? face((depthControl >> 20) & 7, (depthControl >> 23) & 7, (depthControl >> 26) & 7, (depthControl >> 29) & 7) : front;
      depthStencil = { format: fmt.format, depthWriteEnabled: depthTest ? !!depthWrite : false,
        depthCompare: depthTest ? COMPARE[(depthControl >> 4) & 7] : 'always',
        ...(fmt.stencil ? { stencilFront: front, stencilBack: back, stencilReadMask: (stencilMasks >> 8) & 0xFF,
          stencilWriteMask: stencilTest ? (stencilMasks >> 16) & 0xFF : 0 } : {}),
        depthBias, depthBiasSlopeScale: slopeBias };
    }
    const strip = topology === 2 || topology === 4;
    // No pixel shader: depth only. With colour targets bound (and nothing written to them), WebGPU
    // still wants a fragment stage for them: an empty one, every write mask 0. With no attachment at
    // all there is nothing to draw (the draw is skipped).
    if (!depthStencil && !targets.some(t => t)) return;
    let fragment: GPUFragmentState | undefined;
    if (ps?.module) fragment = { module: ps.module, entryPoint: 'main', targets };
    else if (targets.some(t => t)) {
      this.emptyFs ??= this.dev.createShaderModule({ code: '@fragment fn main() {}', label: 'empty fragment' });
      fragment = { module: this.emptyFs, entryPoint: 'main', targets: targets.map(t => t ? { ...t, writeMask: 0, blend: undefined } : null) };
    }
    try {
      // Used at once; if the error scope then says it is invalid (a shader that doesn't compile) it is
      // dropped, so it can cost one frame at most instead of invalidating every frame's command buffer.
      // (Waiting for the scope before using it would be cleaner, but neither popErrorScope nor
      // createRenderPipelineAsync settled on headless SwiftShader.)
      const label = `${vs.name} + ${ps?.name ?? 'depth only'}`;
      this.dev.pushErrorScope('validation');
      const pipeline = this.dev.createRenderPipeline({
        label,
        layout: this.dev.createPipelineLayout({ bindGroupLayouts: [this.group0Layout, group1] }),
        vertex: { module: vs.module, entryPoint: 'main' },
        fragment,
        primitive: { topology: TOPOLOGY[topology] ?? 'triangle-list', stripIndexFormat: strip ? 'uint32' : undefined,
          cullMode: CULL[cull] ?? 'none', frontFace: 'cw',
          unclippedDepth: !depthClip && this.features.has('depth-clip-control') ? true : undefined },
        depthStencil,
      });
      entry.pipeline = pipeline;
      this.dev.popErrorScope().then(err => {
        if (!err) return;
        entry.pipeline = null;
        this.warn(`pipe:${label}`, `pipeline ${label} failed, its draws are skipped: ${err.message}`);
      }, () => {});
    } catch (e) {
      this.warn(`pipe:${vs.name}:${ps?.name}`, `pipeline ${vs.name} + ${ps?.name}: ${String(e)}`);
    }
  }

  private sampler(bytes: Uint8Array): GPUSampler {
    const key = Array.from(bytes).join(',');
    let s = this.samplers.get(key);
    if (!s) {
      const f = (v: number): GPUFilterMode => v === 1 ? 'linear' : 'nearest';
      const a = (v: number): GPUAddressMode => v === 0 ? 'repeat' : v === 1 ? 'mirror-repeat' : 'clamp-to-edge';
      const lod = new Float32Array(bytes.buffer.slice(bytes.byteOffset + 8, bytes.byteOffset + 16));
      const aniso = bytes[3] > 1 ? Math.min(16, bytes[3]) : 1;
      s = this.dev.createSampler({
        minFilter: aniso > 1 ? 'linear' : f(bytes[0]), magFilter: aniso > 1 ? 'linear' : f(bytes[1]), mipmapFilter: aniso > 1 ? 'linear' : f(bytes[2]),
        maxAnisotropy: aniso, addressModeU: a(bytes[4]), addressModeV: a(bytes[5]), addressModeW: a(bytes[6]),
        lodMinClamp: Math.max(0, lod[0]), lodMaxClamp: Math.max(Math.max(0, lod[0]), Math.min(lod[1], 32)),
      });
      this.samplers.set(key, s);
    }
    return s;
  }

  private createPassPipeline(u32: Uint32Array, u8: Uint8Array, w: number) {
    const id = u32[w], targets = [u32[w + 1], u32[w + 2], u32[w + 3], u32[w + 4]], targetCount = u32[w + 5], blend = u32[w + 6];
    const textureCount = u32[w + 7], constantBytes = u32[w + 9];
    const samplerBytes = [u8.slice((w + 10) * 4, (w + 10) * 4 + 16), u8.slice((w + 14) * 4, (w + 14) * 4 + 16)];
    const samplerCount = u32[w + 18], nameBytes = u32[w + 19];
    const name = this.str(u8, (w + 22) * 4, nameBytes);
    const entry: PassPipe = { pipeline: null, name, constantBytes, textureCount, samplers: samplerBytes.slice(0, samplerCount).map(b => this.sampler(b)) };
    this.res.set(id, entry);
    const code = PASS_PS[name];
    if (!code) { this.warn(`pass:${name}`, `pass ${name} has no WGSL (skipped)`); return; }
    const formats: GPUColorTargetState[] = [];
    for (let i = 0; i < targetCount; i++) {
      const fmt = targets[i] === 87 ? this.presentFormat : renderTargetFormatOf(targets[i], this.features)?.format;
      if (!fmt) return;
      formats.push({ format: fmt, blend: blend === 1 ? { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'zero', dstFactor: 'one' } } : undefined });
    }
    entry.pipeline = this.dev.createRenderPipeline({ label: name, layout: 'auto',
      vertex: { module: this.dev.createShaderModule({ code: FULLSCREEN_VS }), entryPoint: 'main' },
      fragment: { module: this.dev.createShaderModule({ code, label: name }), entryPoint: 'main', targets: formats } });
  }

  // ---- draws ----
  private beginPass(colors: number[], colorCount: number, depth: number): [number, number] | null {
    const key = `${colors.slice(0, colorCount).join(',')}|${depth}`;
    if (this.pass && key === this.passKey) return this.passSize as [number, number];
    this.endPass();
    const colorAttachments: (GPURenderPassColorAttachment | null)[] = [];
    let width = 0, height = 0;
    for (let i = 0; i < colorCount; i++) {
      const id = colors[i];
      if (!id) { colorAttachments.push(null); continue; }
      if (id === TEX_BACKBUFFER) {
        colorAttachments.push({ view: this.backBufferView(), loadOp: 'load', storeOp: 'store' });
        width = this.ctx.canvas.width; height = this.ctx.canvas.height;
        continue;
      }
      const t = this.tex(id);
      if (!t) return null;
      colorAttachments.push({ view: this.view(t, 3), loadOp: 'load', storeOp: 'store' });
      width = t.width; height = t.height;
    }
    let depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (depth) {
      const t = this.tex(depth);
      if (!t) return null;
      t.gen = (t.gen ?? 0) + 1;   // its depth may change in this pass (depthCopies)
      depthStencilAttachment = { view: this.view(t, 0), depthLoadOp: 'load', depthStoreOp: 'store',
        ...(t.info.stencil ? { stencilLoadOp: 'load', stencilStoreOp: 'store' } : {}) } as GPURenderPassDepthStencilAttachment;
      if (!width) { width = t.width; height = t.height; }
    }
    if (!width) return null;
    this.pass = this.encoder().beginRenderPass({ colorAttachments, depthStencilAttachment });
    this.passKey = key;
    this.passSize = [width, height];
    return [width, height];
  }

  /** systemConstants: the draw's system constants in the upload ring, when it has some: a viewport
   *  outside the target (allowed in Vulkan, not in WebGPU) is then clamped and the difference put into
   *  the vertex transform (xe_system.ndc_scale / ndc_offset), so every vertex lands where the original
   *  viewport would have put it. */
  private viewportAndScissor(pass: GPURenderPassEncoder, f32: Float32Array, i32: Int32Array, vw: number, sw: number, size: [number, number],
                             systemConstants = -1): boolean {
    const [W, H] = size;
    let x = f32[vw], y = f32[vw + 1], w = f32[vw + 2], h = f32[vw + 3];
    const minD = Math.min(1, Math.max(0, f32[vw + 4])), maxD = Math.min(1, Math.max(0, f32[vw + 5]));
    if (x < 0 || y < 0 || x + w > W || y + h > H) {
      const r = Math.min(W, x + w), b = Math.min(H, y + h);
      const x2 = Math.max(0, x), y2 = Math.max(0, y), w2 = r - x2, h2 = b - y2;
      if (w2 > 0 && h2 > 0 && systemConstants >= 0) {
        // pixel = x + (ndc + 1) w / 2 must equal x2 + (ndc' + 1) w2 / 2 (y: from the top, ndc up)
        const sx = w / w2, ox = (2 * (x - x2) + w - w2) / w2;
        const sy = h / h2, oy = 1 - 2 * (y - y2) / h2 - h / h2;
        const sys = new Float32Array(this.mem.buffer as unknown as ArrayBuffer, this.ctl().u32[CTL.uploadRing] + systemConstants, 8);
        // clip' = clip * S + O * w, applied after the shader's clip * ndc_scale + ndc_offset * w
        sys[4] = sys[4] * sx + ox; sys[5] = sys[5] * sy + oy;
        sys[0] *= sx; sys[1] *= sy;
      } else if (w2 > 0 && h2 > 0) {
        this.warn('viewport', `a viewport outside its target (${x},${y} ${w}x${h} in ${W}x${H}) was clamped`);
      }
      x = x2; y = y2; w = w2; h = h2;
    }
    if (w <= 0 || h <= 0) return false;
    pass.setViewport(x, y, w, h, minD, maxD);
    const r = this.clampRect([i32[sw], i32[sw + 1], i32[sw + 2], i32[sw + 3]], W, H);
    if (!r) return false;
    pass.setScissorRect(r[0], r[1], r[2], r[3]);
    return true;
  }

  private draw(u32: Uint32Array, f32: Float32Array, i32: Int32Array, u8: Uint8Array, w: number) {
    this.stats.draws++;
    const pipe = this.res.get(u32[w]) as DrawPipe | undefined;
    if (!pipe?.pipeline) { this.stats.skipped++; return; }
    const colors = [u32[w + 1], u32[w + 2], u32[w + 3], u32[w + 4]], colorCount = u32[w + 5], depth = u32[w + 6];
    const textureCount = u32[w + 30], bw = w + 31;
    // Depth textures it samples: their r32float copies, made (outside the render pass) before it opens.
    for (const n of pipe.textures) {
      if (n >= textureCount) continue;
      const t = this.tex(u32[bw + 6 * n]);
      if (t?.info.depth && u32[bw + 6 * n + 1] !== 2) this.depthCopy(u32[bw + 6 * n], t);
    }
    const size = this.beginPass(colors, colorCount, depth);
    if (!size) { this.stats.skipped++; return; }
    const pass = this.pass!;
    if (!this.viewportAndScissor(pass, f32, i32, w + 7, w + 13, size, u32[w + 22])) { this.stats.skipped++; return; }
    pass.setPipeline(pipe.pipeline);
    pass.setBlendConstant({ r: f32[w + 17], g: f32[w + 18], b: f32[w + 19], a: f32[w + 20] });
    pass.setStencilReference(u32[w + 21] & 0xFF);
    pass.setBindGroup(0, this.group0, [u32[w + 22], u32[w + 23], u32[w + 24], u32[w + 25]]);
    const entries: GPUBindGroupEntry[] = [];
    for (const n of pipe.textures) {
      const b = bw + 6 * n;
      const t = n < textureCount ? this.tex(u32[b]) : null;
      const kind = n < textureCount ? u32[b + 1] : 0;
      // Depth and stencil views need other binding types: sampled as the null texture for now. So are
      // 32-bit float textures without float32-filterable: one invalid bind group loses the whole frame.
      const unfilterable = !!t && /32float/.test(t.info.format) && !this.features.has('float32-filterable');
      let resource: GPUTextureView;
      if (t?.info.depth && kind !== 2 && this.depthCopies.has(u32[b])) resource = this.depthCopies.get(u32[b])!.view;
      else if (t && !t.info.depth && kind === 0 && !unfilterable) resource = this.view(t, 0);
      else {
        if (t) this.warn(`view:${t.info.format}:${kind}`, `a draw samples a ${t.info.format} texture (view ${kind}) it can't bind here: the null texture instead`);
        resource = this.view(this.nullTex, 0);
      }
      entries.push({ binding: n, resource });
      entries.push({ binding: 32 + n, resource: this.sampler(u8.slice((b + 2) * 4, (b + 2) * 4 + 16)) });
    }
    if (pipe.textures.length) pass.setBindGroup(1, this.dev.createBindGroup({ layout: pipe.group1, entries }));
    pass.setIndexBuffer(this.ring, 'uint32');
    pass.drawIndexed(u32[w + 29], 1, u32[w + 28]);
  }

  /** Depth texture `id` -> its r32float copy (depthCopies), unless the copy is up to date. */
  private depthCopy(id: number, t: Tex) {
    let c = this.depthCopies.get(id);
    if (c && c.gen === (t.gen ?? 0)) return;
    if (!this.features.has('float32-filterable')) {
      this.warn('depthcopy', 'depth textures sampled by draws need float32-filterable: the null texture instead');
      return;
    }
    if (!c || c.texture.width !== t.width || c.texture.height !== t.height) {
      c?.texture.destroy();
      const texture = this.dev.createTexture({ size: [t.width, t.height], format: 'r32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: `depth copy ${id}` });
      c = { gen: -1, texture, view: texture.createView() };
      this.depthCopies.set(id, c);
    }
    this.depthCopyPipe ??= this.dev.createRenderPipeline({ label: 'depth copy', layout: 'auto',
      vertex: { module: this.dev.createShaderModule({ code: FULLSCREEN_VS }), entryPoint: 'main' },
      fragment: { module: this.dev.createShaderModule({ code: DEPTH_COPY_PS }), entryPoint: 'main', targets: [{ format: 'r32float' }] } });
    this.endPass();
    const pass = this.encoder().beginRenderPass({ colorAttachments: [{ view: c.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.depthCopyPipe);
    pass.setBindGroup(0, this.dev.createBindGroup({ layout: this.depthCopyPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.view(t, 1) }] }));
    pass.draw(3);
    pass.end();
    c.gen = t.gen ?? 0;
  }

  private drawPass(u32: Uint32Array, f32: Float32Array, i32: Int32Array, w: number) {
    this.stats.passes++;
    const pipe = this.res.get(u32[w]) as PassPipe | undefined;
    if (pipe && (this.skip.has(pipe.name) || (this.skip.has('canvas') && u32[w + 1] === TEX_BACKBUFFER))) return;
    if (!pipe?.pipeline) { this.warn(`passnopipe:${pipe?.name ?? u32[w]}`, `pass ${pipe?.name ?? `#${u32[w]}`} skipped: no pipeline`); return; }
    const targets = [u32[w + 1], u32[w + 2], u32[w + 3], u32[w + 4]], targetCount = u32[w + 5];
    const size = this.beginPass(targets, targetCount, 0);
    if (!size) { this.warn(`passnotarget:${pipe.name}`, `pass ${pipe.name} skipped: target ${targets.slice(0, targetCount).join(',')} missing`); return; }
    const pass = this.pass!;
    if (!this.viewportAndScissor(pass, f32, i32, w + 6, w + 12, size)) {
      this.warn(`passview:${pipe.name}`, `pass ${pipe.name} skipped: viewport ${Array.from(f32.subarray(w + 6, w + 12)).join(',')} scissor ${Array.from(i32.subarray(w + 12, w + 16)).join(',')} in ${size.join('x')}`);
      return;
    }
    const constants = u32[w + 19], constantBytes = u32[w + 20], vertexCount = u32[w + 21], textureCount = u32[w + 22];
    const layout = pipe.pipeline.getBindGroupLayout(0);
    const entries: GPUBindGroupEntry[] = [];
    if (pipe.constantBytes) entries.push({ binding: 0, resource: { buffer: this.ring, offset: constants, size: Math.max(16, Math.ceil(pipe.constantBytes / 16) * 16) } });
    const code = PASS_PS[pipe.name] ?? '';
    for (let i = 0; i < textureCount; i++) {
      if (!code.includes(`@binding(${1 + i})`)) continue;
      const b = w + 23 + 6 * i, t = this.tex(u32[b]) ?? this.nullTex, kind = u32[b + 1];
      entries.push({ binding: 1 + i, resource: this.view(t, kind === 1 ? 1 : kind === 2 ? 2 : 0) });
    }
    if (code.includes('@binding(9)') && pipe.samplers[0]) entries.push({ binding: 9, resource: pipe.samplers[0] });
    if (code.includes('@binding(10)') && pipe.samplers[1]) entries.push({ binding: 10, resource: pipe.samplers[1] });
    if (pipe.name === 'present' && this.presentLogs++ < 6) {
      const src = this.tex(u32[w + 23]);
      const cf = new Float32Array(this.mem.buffer as unknown as ArrayBuffer, this.ctl().u32[CTL.uploadRing] + constants, 12);
      const cu = new Uint32Array(cf.buffer, cf.byteOffset, 12);
      this.log(`[webgpu] present #${this.stats.frames}: source tex ${u32[w + 23]} ${src ? `${src.info.format} ${src.width}x${src.height}` : '(missing)'}, ` +
        `uvScale ${cf[0].toFixed(3)},${cf[1].toFixed(3)} target ${cf[2]}x${cf[3]} flags ${cu[4]} swizzle 0x${cu[5].toString(16)} origin ${cf[6]},${cf[7]} ` +
        `gamma ${cf[8]} saturation ${cf[9]}, ${constantBytes} constant bytes`);
    }
    pass.setPipeline(pipe.pipeline);
    pass.setBindGroup(0, this.dev.createBindGroup({ layout, entries }));
    pass.draw(vertexCount || 3);
  }

  private submit(u32: Uint32Array, w: number) {
    this.endPass();
    const fence = u32[w], syncCount = u32[w + 2];
    const ctl = this.ctl();
    const uploadRing = ctl.u32[CTL.uploadRing];
    const buf = this.mem.buffer as unknown as ArrayBuffer;
    for (let i = 0; i < syncCount && i < 2; i++) {
      const off = u32[w + 3 + 2 * i], len = u32[w + 4 + 2 * i];
      if (len) this.dev.queue.writeBuffer(this.ring, off, new Uint8Array(buf, uploadRing + off, (len + 3) & ~3));
    }
    if (this.enc) { this.dev.queue.submit([this.enc.finish()]); this.enc = null; }
    Atomics.store(ctl.i32, CTL.fence, fence | 0);
    Atomics.notify(ctl.i32, CTL.fence);
  }
}
