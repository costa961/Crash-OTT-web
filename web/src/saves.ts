// The saves in the browser's storage (OPFS "userdata/content", host/io-worker.ts) to a .zip file and
// back: a backup the player keeps, or carries to another browser. Only while the game isn't running
// (the start page): the I/O worker holds the files open then.
//
// The .zip is written uncompressed (the saves are small); one made by another tool may be deflated,
// which DecompressionStream reads. Its paths are "content/<title id>/...", as the game's; a .zip of the
// content folder's contents ("<title id>/...") is read too.

const ROOT = 'userdata', SAVES = 'content';

// ---- CRC-32 (the .zip's checksum) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function savesDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create });
    return await root.getDirectoryHandle(SAVES, { create });
  } catch { return null; }
}

type Entries = AsyncIterable<[string, FileSystemHandle]>;

/** Every save file: [path under userdata ("content/..."), bytes]. */
async function listSaves(): Promise<[string, Uint8Array][]> {
  const dir = await savesDir(false);
  const out: [string, Uint8Array][] = [];
  if (!dir) return out;
  const walk = async (d: FileSystemDirectoryHandle, prefix: string) => {
    for await (const [name, h] of d as unknown as Entries) {
      const path = `${prefix}/${name}`;
      if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, path);
      else out.push([path, new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer())]);
    }
  };
  await walk(dir, SAVES);
  return out;
}

/** The saves as a .zip, or null when there are none. */
export async function exportSaves(): Promise<{ blob: Blob; files: number } | null> {
  const files = await listSaves();
  if (!files.length) return null;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [path, data] of files) {
    const name = enc.encode(path), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);  // UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014B50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return { blob: new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' }), files: files.length };
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files of a .zip: [path, bytes] (folders left out). */
async function readZip(buf: ArrayBuffer): Promise<[string, Uint8Array][]> {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--)
    if (v.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a .zip file');
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: [string, Uint8Array][] = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014B50) throw new Error('damaged .zip file');
    const method = v.getUint16(at + 10, true), size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true), extraLen = v.getUint16(at + 30, true), commentLen = v.getUint16(at + 32, true);
    const localAt = v.getUint32(at + 42, true);
    const name = dec.decode(u8.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, '/');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataAt = localAt + 30 + v.getUint16(localAt + 26, true) + v.getUint16(localAt + 28, true);
    const raw = u8.subarray(dataAt, dataAt + size);
    if (method === 0) out.push([name, raw.slice()]);
    else if (method === 8) out.push([name, await inflate(raw)]);
    else throw new Error(`${name}: a compression this page can't read (method ${method})`);
  }
  return out;
}

/** Copies the saves of a .zip into the browser's storage (a file of the same name is replaced). */
export async function importSaves(file: File): Promise<number> {
  const entries = await readZip(await file.arrayBuffer());
  const dir = await savesDir(true);
  if (!dir) throw new Error("the browser's storage isn't available");
  let written = 0;
  for (const [name, data] of entries) {
    let parts = name.split('/').filter(p => p && p !== '.' && p !== '..');
    if (parts[0] === '__MACOSX' || parts.some(p => p.startsWith('._'))) continue;
    if (parts[0]?.toLowerCase() === 'userdata') parts = parts.slice(1);
    if (parts[0]?.toLowerCase() === SAVES) parts = parts.slice(1);
    // the game's saves are content/<title id>/<content type>/<name>/...
    if (parts.length < 2) continue;
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(data as BlobPart);
    await w.close();
    written++;
  }
  if (!written) throw new Error('no saves in this .zip file');
  return written;
}
