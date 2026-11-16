// Crash's fur colour (the start page's "Crash's colour"): the textures of Crash's model are recoloured
// on their way to the GPU, in the executor's texture uploads (executor.ts copyUpload). Nothing else
// changes: the videos are other textures, and every other texture goes to the GPU untouched.
//
// - A texture is Crash's when its base level (the renderer's decoded host texels, rows without padding)
//   hashes to one of CRASH_TEXTURES' keys (with its size and format); the lower levels of the same
//   texture follow it (the renderer uploads level 0 first). Only textures of a key's size and format
//   are hashed, and only with a colour other than the original picked.
// - Only the fur changes: saturated orange texels (skin, jeans, shoes, eyes and the rest keep their
//   colour), mapped to the chosen colour with their brightness relative to the fur's base colour kept.
//   BC1-BC3 textures: the colour endpoints of each block (the texels between them follow); 8-bit RGBA /
//   BGRA: every texel. In place, in the upload ring's shared memory, before the batch copies it to the GPU.
// - In a level Crash is a 256-colour texture (8-bit indices, R8) drawn through a 256x1 palette (the
//   game's pal*fp shaders): the draws that sample his index texture get his palette recoloured instead
//   (executor.ts crashPalette; the palettes' last uploads are kept for that). The in-engine cutscenes
//   draw him from a full-colour texture, recoloured as it is uploaded.
// - ?texdump=1: every texture's base level (and the R8 ones, and the 256x1 palettes) is kept (key,
//   size, format, texels) for tools that look for the keys (window.crashTexDump(), F9 saves them all);
//   nothing is recoloured meanwhile.

/** `mp`: the online co-op's colour of the same name (crashott-pc's online/mp_colors.cpp, CRASH_MP_COLOR):
 *  in a session the game paints every player's Crash itself, the same on every machine, and the
 *  recolouring here stays off. */
export interface FurColor { id: string; name: string; rgb: [number, number, number]; mp: string }

/** The colours offered, the original first. */
export const FUR_COLORS: FurColor[] = [
  { id: 'original', name: 'Original orange', rgb: [0, 0, 0], mp: 'orange' },
  { id: 'blue', name: 'Ocean blue', rgb: [40, 110, 230], mp: 'blue' },
  { id: 'green', name: 'Jungle green', rgb: [60, 170, 60], mp: 'green' },
  { id: 'purple', name: 'Purple', rgb: [130, 60, 200], mp: 'purple' },
  { id: 'red', name: 'Crimson', rgb: [190, 20, 40], mp: 'red' },
  { id: 'pink', name: 'Bubblegum pink', rgb: [240, 90, 170], mp: 'pink' },
  { id: 'gold', name: 'Gold', rgb: [235, 180, 30], mp: 'yellow' },
  { id: 'teal', name: 'Teal', rgb: [20, 170, 160], mp: 'cyan' },
  { id: 'white', name: 'Polar white', rgb: [235, 235, 240], mp: 'white' },
  { id: 'black', name: 'Carbon black', rgb: [45, 45, 52], mp: 'black' },
];

/** Crash's textures, found with ?texdump=1: key (hashKey), size, DXGI format, and whether the texels
 *  hold blue in the red channel (the fetch constant's swizzle swaps them back after sampling). R8 ones
 *  are 256-colour index textures (their palettes, bytes B G R A, are recoloured instead). */
const CRASH_TEXTURES: { key: number; width: number; height: number; dxgi: number; swapRB: boolean }[] = [
  { key: 0x6a10dfa7, width: 512, height: 512, dxgi: 28, swapRB: true },   // full colour: the in-engine cutscenes
  { key: 0x80ef1ef8, width: 256, height: 256, dxgi: 61, swapRB: true },   // 256 colours: in game
];
const R8 = 61;

// The fur's base colour in Crash's textures (the colour the chosen one replaces at the same brightness):
// the median of its fur texels (hue 12-24 degrees, saturation 0.8-0.9).
const FUR_BASE: [number, number, number] = [230, 95, 20];

const BC = new Map<number, number>([[71, 8], [72, 8], [74, 16], [75, 16], [77, 16], [78, 16]]);   // DXGI -> bytes per block
const RGBA = new Set([28, 29]), BGRA = new Set([87, 91]);

/** A 32-bit hash of the rows of a level (rowBytes of each rowPitch), with its size and format. */
export function hashKey(src: Uint8Array, rowPitch: number, rowBytes: number, rows: number, width: number, height: number, dxgi: number): number {
  let h = (0x811c9dc5 ^ width ^ (height << 12) ^ (dxgi << 24)) >>> 0;
  const words = new Uint32Array(src.buffer, src.byteOffset, (src.byteLength >> 2));
  const rowWords = rowBytes >> 2, pitchWords = rowPitch >> 2;
  for (let y = 0; y < rows; y++) {
    const base = y * pitchWords;
    for (let x = 0; x < rowWords; x++) h = Math.imul(h ^ words[base + x], 0x01000193) >>> 0;
  }
  return (h ^ (h >>> 16)) >>> 0;
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** How much of the fur colour a colour is (0..1): orange hues, saturated enough not to be skin. */
function furWeight(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 24 || r !== max) return 0;
  const sat = (max - min) / max;
  const hue = 60 * (g - b) / (max - min || 1);   // red is max: -60..60 degrees
  const s = Math.min(1, Math.max(0, (sat - 0.45) / 0.2));
  // the shoes, the tongue and the gums are red (under 6 degrees), the skin a pale 30-50
  const hLow = Math.min(1, Math.max(0, (hue - 6) / 6)), hHigh = Math.min(1, Math.max(0, (40 - hue) / 8));
  return s * Math.min(hLow, hHigh);
}

export class Recolor {
  private target: [number, number, number] | null = null;
  private wanted = new Map<string, true>();   // "w x h x dxgi" of the keys, to hash only those textures
  private keys = new Map<number, boolean>();   // key -> swapRB
  /** texture id -> its red and blue swapped (its lower levels follow its base level) */
  private textures = new Map<number, boolean>();
  private dumping = new URLSearchParams(location.search).get('texdump') === '1';
  private dump = new Map<number, { key: number; width: number; height: number; dxgi: number; rowBytes: number; data: Uint8Array }>();
  /** a cache of the recoloured endpoint / texel colours (565 or RGB -> recoloured) */
  private cache = new Map<number, number>();
  /** Crash's index textures (R8) -> their palettes' channel order (swapRB) */
  private indexTextures = new Map<number, boolean>();
  /** the last upload of each 256x1 texture (the palettes), kept while an index texture is wanted */
  private palettes = new Map<number, Uint8Array>();
  private paletteLogged = false;
  private wantsIndices = false;

  constructor(colorId: string, private log: (s: string) => void) {
    const c = FUR_COLORS.find(f => f.id === colorId);
    if (c && c.id !== 'original') { this.target = c.rgb; log(`[recolor] Crash's colour: ${c.name}`); }
    for (const t of CRASH_TEXTURES) { this.keys.set(t.key, t.swapRB); this.wanted.set(`${t.width}x${t.height}x${t.dxgi}`, true); }
    this.wantsIndices = CRASH_TEXTURES.some(t => t.dxgi === R8);
    if (this.dumping) {
      (window as unknown as { crashTexDump?: () => unknown }).crashTexDump = () => [...this.dump.values()];
      // F9: the dump as one file (a JSON line of the textures, then their texels back to back)
      window.addEventListener('keydown', e => {
        if (e.code !== 'F9') return;
        e.preventDefault();
        const list = [...this.dump.values()];
        const meta = list.map(({ key, width, height, dxgi, rowBytes, data }) => ({ key, width, height, dxgi, rowBytes, bytes: data.length }));
        const blob = new Blob([JSON.stringify(meta) + '\n', ...list.map(t => t.data as BlobPart)], { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'crashott-texdump.bin';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        log(`[texdump] ${list.length} textures saved (${(blob.size / 1048576).toFixed(1)} MB)`);
      });
    }
  }

  get active(): boolean { return this.dumping || (this.target !== null && this.keys.size > 0); }

  forget(id: number) { this.textures.delete(id); this.indexTextures.delete(id); this.palettes.delete(id); }

  get hasIndexTextures(): boolean { return this.indexTextures.size > 0; }
  isIndexTexture(id: number) { return this.indexTextures.has(id); }

  /** Palette `id` (its last upload) recoloured for a draw of Crash's index texture: its content's
   *  key and its texels (as uploaded, 256 x 4 bytes), or null when there is none or nothing changes. */
  recolorPalette(id: number, swapRB = true): { key: number; data: Uint8Array } | null {
    const src = this.palettes.get(id);
    if (!src || !this.target) return null;
    const key = hashKey(src, 1024, 1024, 1, 256, 1, swapRB ? 1 : 0);
    const data = src.slice();
    this.recolorTexels(data, 1024, 256, 1, swapRB);
    if (!this.paletteLogged) { this.paletteLogged = true; this.log(`[recolor] Crash's palette (tex ${id}) recoloured`); }
    return { key, data };
  }

  /** A level of texture `id` in the upload ring (`src`: from its first row, rowPitch apart). */
  upload(id: number, level: number, src: Uint8Array, rowPitch: number, width: number, height: number, dxgi: number) {
    const blockBytes = BC.get(dxgi);
    const pixel = RGBA.has(dxgi) || BGRA.has(dxgi);
    // the dump also keeps the 8-bit index textures (R8) and the 256x1 palettes they are drawn through
    if (this.dumping && level === 0 && dxgi === 61 && width >= 128 && height >= 128) {
      const key = hashKey(src, rowPitch, width & ~3, height, width, height, dxgi);
      if (!this.dump.has(key) && this.dump.size < 1000) {
        const data = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) data.set(src.subarray(y * rowPitch, y * rowPitch + width), y * width);
        this.dump.set(key, { key, width, height, dxgi, rowBytes: width, data });
      }
      return;
    }
    if (this.dumping && level === 0 && pixel && width === 256 && height === 1) {
      const key = hashKey(src, rowPitch, 1024, 1, width, height, dxgi);
      if (!this.dump.has(key) && this.dump.size < 1000) this.dump.set(key, { key, width, height, dxgi, rowBytes: 1024, data: src.slice(0, 1024) });
      return;
    }
    if (level === 0) this.indexTextures.delete(id);
    // Crash's 256-colour texture: its palette is recoloured at its draws (recolorPalette)
    if (dxgi === R8) {
      if (level !== 0 || !this.target || !this.wanted.has(`${width}x${height}x${dxgi}`) || width & 3) return;
      const key = hashKey(src, rowPitch, width, height, width, height, dxgi);
      const swapRB = this.keys.get(key);
      if (swapRB === undefined) return;
      this.indexTextures.set(id, swapRB);
      this.log(`[recolor] Crash's 256-colour texture 0x${key.toString(16)} (tex ${id}) found`);
      return;
    }
    // the palettes (256x1), kept while one of Crash's index textures is wanted
    if (pixel && width === 256 && height === 1 && level === 0 && this.target && this.wantsIndices) {
      let kept = this.palettes.get(id);
      if (!kept) this.palettes.set(id, kept = new Uint8Array(1024));
      kept.set(src.subarray(0, 1024));
      return;
    }
    if (!blockBytes && !pixel) { if (level === 0) this.textures.delete(id); return; }
    const rowBytes = blockBytes ? Math.ceil(width / 4) * blockBytes : width * 4;
    const rows = blockBytes ? Math.ceil(height / 4) : height;
    if (level === 0) {
      this.textures.delete(id);
      if (this.dumping) {
        if (width >= 128 && height >= 128 && this.dump.size < 1000) {
          const key = hashKey(src, rowPitch, rowBytes, rows, width, height, dxgi);
          if (!this.dump.has(key)) {
            const data = new Uint8Array(rowBytes * rows);
            for (let y = 0; y < rows; y++) data.set(src.subarray(y * rowPitch, y * rowPitch + rowBytes), y * rowBytes);
            this.dump.set(key, { key, width, height, dxgi, rowBytes, data });
          }
        }
        return;
      }
      if (!this.target || !this.wanted.has(`${width}x${height}x${dxgi}`)) return;
      const key = hashKey(src, rowPitch, rowBytes, rows, width, height, dxgi);
      const swapRB = this.keys.get(key);
      if (swapRB === undefined) return;
      this.textures.set(id, swapRB);
      this.log(`[recolor] Crash's texture 0x${key.toString(16)} (tex ${id}) recoloured`);
    } else if (!this.textures.has(id)) return;
    const swapRB = this.textures.get(id)!;
    if (blockBytes) this.recolorBlocks(src, rowPitch, rowBytes, rows, blockBytes, blockBytes === 8, swapRB);
    else this.recolorTexels(src, rowPitch, width, height, BGRA.has(dxgi) !== swapRB);
  }

  /** The recoloured colour of r, g, b (0..255), packed 0xRRGGBB. */
  private recolor(r: number, g: number, b: number): number {
    const w = furWeight(r, g, b);
    if (w === 0) return (r << 16) | (g << 8) | b;
    const t = this.target!;
    const k = luma(r, g, b) / luma(FUR_BASE[0], FUR_BASE[1], FUR_BASE[2]);
    const mix = (c: number, n: number) => Math.max(0, Math.min(255, Math.round(c + (n - c) * w)));
    return (mix(r, t[0] * k) << 16) | (mix(g, t[1] * k) << 8) | mix(b, t[2] * k);
  }

  /** A 565 colour (red in the high bits, or blue with swapRB) recoloured. */
  private recolor565(c: number, swapRB: boolean): number {
    const cacheKey = swapRB ? c | 0x10000 : c;
    let out = this.cache.get(cacheKey);
    if (out === undefined) {
      const hi = c >> 11, g6 = (c >> 5) & 63, lo = c & 31;
      const x = (hi << 3) | (hi >> 2), y = (lo << 3) | (lo >> 2), g = (g6 << 2) | (g6 >> 4);
      const rgb = swapRB ? this.recolor(y, g, x) : this.recolor(x, g, y);
      const q = (v: number, max: number) => Math.floor((v * max + 127) / 255);
      const r = q((rgb >> 16) & 255, 31), b = q(rgb & 255, 31);
      out = ((swapRB ? b : r) << 11) | (q((rgb >> 8) & 255, 63) << 5) | (swapRB ? r : b);
      this.cache.set(cacheKey, out);
    }
    return out;
  }

  /** BC1 (8-byte blocks: endpoints at 0, indices at 4) or BC2 / BC3 (16-byte blocks: the colour block at 8). */
  private recolorBlocks(src: Uint8Array, rowPitch: number, rowBytes: number, rows: number, blockBytes: number, bc1: boolean, swapRB: boolean) {
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const colorAt = blockBytes - 8;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < rowBytes; x += blockBytes) {
        const o = y * rowPitch + x + colorAt;
        const c0 = view.getUint16(o, true), c1 = view.getUint16(o + 2, true);
        let n0 = this.recolor565(c0, swapRB), n1 = this.recolor565(c1, swapRB);
        if (n0 === c0 && n1 === c1) continue;
        let indices = view.getUint32(o + 4, true);
        // BC1: c0 > c1 is the 4-colour mode, otherwise 3 colours and transparent: keep the block's mode
        if (bc1) {
          const four = c0 > c1;
          if (four && n0 < n1) { [n0, n1] = [n1, n0]; indices ^= 0x55555555; }   // 0<->1, 2<->3
          else if (four && n0 === n1) indices = 0;                                    // one colour
          else if (!four && n0 > n1) {
            [n0, n1] = [n1, n0];
            // 0<->1 (2: the middle, 3: transparent stay)
            let swapped = 0;
            for (let i = 0; i < 16; i++) { const v = (indices >>> (2 * i)) & 3; swapped |= (v < 2 ? v ^ 1 : v) << (2 * i); }
            indices = swapped >>> 0;
          }
        }
        view.setUint16(o, n0, true); view.setUint16(o + 2, n1, true); view.setUint32(o + 4, indices, true);
      }
    }
  }

  private recolorTexels(src: Uint8Array, rowPitch: number, width: number, height: number, bgra: boolean) {
    const ri = bgra ? 2 : 0, bi = bgra ? 0 : 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0, o = y * rowPitch; x < width; x++, o += 4) {
        const r = src[o + ri], g = src[o + 1], b = src[o + bi];
        const key = (r << 16) | (g << 8) | b;
        let out = this.cache.get(key | 0x1000000);
        if (out === undefined) { out = this.recolor(r, g, b); this.cache.set(key | 0x1000000, out); }
        if (out === key) continue;
        src[o + ri] = out >> 16; src[o + 1] = (out >> 8) & 255; src[o + bi] = out & 255;
      }
    }
  }
}
