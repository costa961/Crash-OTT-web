// The AudioWorklet: plays the game's ring of interleaved stereo floats (runtime/audio_device_web.cpp,
// WebAudio) straight from the shared wasm memory. Pads with silence when the game is behind.

// AudioWorkletGlobalScope (not in the DOM typings)
declare const registerProcessor: (name: string, ctor: unknown) => void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown); }

// WebAudio's fields, in 32-bit words
const W = { capacity: 3, samples: 4, attached: 5, write: 6, read: 7, underruns: 8 } as const;

class CrashAudio extends AudioWorkletProcessor {
  private u32: Uint32Array;
  private i32: Int32Array;
  private f32: Float32Array;
  private capacity: number;
  private base: number;

  constructor(options: { processorOptions: { buffer: SharedArrayBuffer; ring: number } }) {
    super();
    const { buffer, ring } = options.processorOptions;
    this.u32 = new Uint32Array(buffer, ring, 16);
    this.i32 = new Int32Array(buffer, ring, 16);
    this.capacity = this.u32[W.capacity];
    this.f32 = new Float32Array(buffer, this.u32[W.samples], this.capacity * 2);
    this.base = 0;
    Atomics.store(this.i32, W.attached, 1);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0], left = out[0], right = out[1] ?? out[0], n = left.length;
    const write = Atomics.load(this.i32, W.write) >>> 0;
    let read = Atomics.load(this.i32, W.read) >>> 0;
    const avail = (write - read) >>> 0;
    const take = Math.min(avail, n);
    for (let i = 0; i < take; i++) {
      const at = ((read + i) & (this.capacity - 1)) * 2;
      left[i] = this.f32[at];
      right[i] = this.f32[at + 1];
    }
    for (let i = take; i < n; i++) { left[i] = 0; right[i] = 0; }
    if (take < n && avail > 0) Atomics.add(this.i32, W.underruns, 1);
    read = (read + take) >>> 0;
    Atomics.store(this.i32, W.read, read | 0);
    void this.base;
    return true;
  }
}

registerProcessor('crash-audio', CrashAudio);
