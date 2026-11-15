// The game's files for a worker. Paths are "<root>/<relative path>":
// - "game" (read-only): the copy downloaded into the browser's storage when there is one (gamecache.ts,
//   opened by the worker before the game starts), else the local server's file API (tools/serve.mjs)
//   with synchronous XHRs, through a cache of 1 MB blocks per worker (the .rcf archives are read in
//   many small pieces);
// - "userdata" (saves, settings, caches): the browser's storage, through the I/O worker (io-worker.ts),
//   which this worker waits for on its reply block.

import { IO_EACCES, IO_EEXIST, IO_ENOENT, IO_ENOTEMPTY, IO_OK, IO_TEXT_AT, type IoRequest } from './io-proto';

export class FsError extends Error {
  constructor(public code: 'ENOENT' | 'EEXIST' | 'EACCES' | 'ENOTEMPTY' | 'EIO') { super(code); }
}

export interface Stat { type: 'file' | 'dir'; size: number; mtimeMs: number; ino: number; }
export interface DirEntry { name: string; type: 'file' | 'dir'; size: number; }

const BLOCK = 1 << 20;
const CACHE_BLOCKS = 64;

// ---- the local server (game files not downloaded) ----

function url(p: string, query = ''): string {
  return `/fs/${p.split('/').map(encodeURIComponent).join('/')}${query}`;
}

function request(method: string, p: string, query = '', body?: Uint8Array, headers: Record<string, string> = {}, binary = false): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  xhr.open(method, url(p, query), false);
  if (binary) xhr.responseType = 'arraybuffer';
  for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
  // XHR can't send a view of shared memory: a copy
  xhr.send(body ? body.slice() : null);
  if (xhr.status >= 200 && xhr.status < 300) return xhr;
  throw new FsError(xhr.status === 404 ? 'ENOENT' : xhr.status === 409 ? 'EEXIST' : xhr.status === 403 ? 'EACCES' : 'EIO');
}

const blocks = new Map<string, Uint8Array>();  // "<path>#<block>" -> bytes, insertion order = age
const sizes = new Map<string, number>();

function readRange(p: string, pos: number, len: number): Uint8Array {
  const xhr = request('GET', p, '', undefined, { Range: `bytes=${pos}-${pos + len - 1}` }, true);
  return new Uint8Array(xhr.response as ArrayBuffer);
}

// ---- the game files downloaded into the browser's storage ----

interface Local { h: FileSystemSyncAccessHandle; size: number; mtime: number; ino: number }
const local = new Map<string, Local>();
let scratch = new Uint8Array(1 << 20);

export function useLocal(name: string, h: FileSystemSyncAccessHandle, size: number, mtime: number) {
  local.set(name, { h, size, mtime, ino: local.size + 1000 });
}
const localOf = (p: string) => p.startsWith('game/') ? local.get(p.slice(5).toLowerCase().replace(/\//g, '__')) : undefined;

// ---- userdata, through the I/O worker ----

let ioPort: MessagePort | null = null;
let ioReply: SharedArrayBuffer | null = null;

export function useIo(port: MessagePort, reply: SharedArrayBuffer) {
  ioPort = port;
  ioReply = reply;
}

const isUserData = (p: string) => p === 'userdata' || p.startsWith('userdata/');

/** One request to the I/O worker, waited for. Returns [value, JSON answer]. */
function ioCall(r: Omit<IoRequest, 'reply'>): [number, string] {
  if (!ioPort || !ioReply) throw new FsError('EIO');
  const i32 = new Int32Array(ioReply, 0, 4);
  Atomics.store(i32, 0, 0);
  ioPort.postMessage({ ...r, reply: ioReply });
  while (Atomics.load(i32, 0) === 0) Atomics.wait(i32, 0, 0, 1000);
  const result = i32[1], value = i32[2];
  if (result !== IO_OK) {
    throw new FsError(result === IO_ENOENT ? 'ENOENT' : result === IO_EEXIST ? 'EEXIST' : result === IO_ENOTEMPTY ? 'ENOTEMPTY'
      : result === IO_EACCES ? 'EACCES' : 'EIO');
  }
  const text = r.op === 'stat' || r.op === 'list' ? new TextDecoder().decode(new Uint8Array(ioReply, IO_TEXT_AT, value).slice()) : '';
  return [value, text];
}

// ---- the file calls of worker.ts ----

export function stat(p: string): Stat {
  const l = localOf(p);
  if (l) return { type: 'file', size: l.size, mtimeMs: l.mtime, ino: l.ino };
  if (isUserData(p)) return JSON.parse(ioCall({ op: 'stat', path: p })[1]) as Stat;
  return JSON.parse(request('GET', p, '?op=stat').responseText) as Stat;
}

export function list(p: string): DirEntry[] {
  if (isUserData(p)) return JSON.parse(ioCall({ op: 'list', path: p })[1]) as DirEntry[];
  return JSON.parse(request('GET', p, '?op=list').responseText) as DirEntry[];
}

/** Reads up to dst.length bytes at pos into dst (a view of the wasm memory); returns the count. */
export function read(p: string, pos: number, dst: Uint8Array): number {
  const l = localOf(p);
  if (l) {
    // a sync access handle doesn't read into shared memory: through a buffer of its own
    if (scratch.length < dst.length) scratch = new Uint8Array(dst.length);
    const view = scratch.subarray(0, dst.length);
    const n = l.h.read(view, { at: pos });
    dst.set(view.subarray(0, n));
    return n;
  }
  if (isUserData(p)) return ioCall({ op: 'read', path: p, pos, addr: dst.byteOffset, len: dst.length })[0];
  if (!p.startsWith('game/')) {
    const got = readRange(p, pos, dst.length);
    dst.set(got);
    return got.length;
  }
  let size = sizes.get(p);
  if (size === undefined) { size = stat(p).size; sizes.set(p, size); }
  let done = 0;
  while (done < dst.length && pos + done < size) {
    const at = pos + done, b = Math.floor(at / BLOCK), key = `${p}#${b}`;
    let block = blocks.get(key);
    if (block) { blocks.delete(key); blocks.set(key, block); }
    else {
      block = readRange(p, b * BLOCK, Math.min(BLOCK, size - b * BLOCK));
      blocks.set(key, block);
      if (blocks.size > CACHE_BLOCKS) blocks.delete(blocks.keys().next().value as string);
    }
    const off = at - b * BLOCK, n = Math.min(block.length - off, dst.length - done);
    if (n <= 0) break;
    dst.set(block.subarray(off, off + n), done);
    done += n;
  }
  return done;
}

/** Writes data (a view of the wasm memory) at pos. */
export function write(p: string, pos: number, data: Uint8Array): void {
  if (isUserData(p)) { ioCall({ op: 'write', path: p, pos, addr: data.byteOffset, len: data.length }); return; }
  request('PUT', p, `?op=write&pos=${pos}`, data);
}

export function truncate(p: string, size: number): void {
  if (isUserData(p)) { ioCall({ op: 'truncate', path: p, size }); return; }
  request('POST', p, `?op=truncate&size=${size}`);
}
export function mkdir(p: string): void {
  if (isUserData(p)) { ioCall({ op: 'mkdir', path: p }); return; }
  request('POST', p, '?op=mkdir');
}
export function unlink(p: string): void {
  if (isUserData(p)) { ioCall({ op: 'unlink', path: p }); return; }
  request('POST', p, '?op=unlink');
}
export function rmdir(p: string): void {
  if (isUserData(p)) { ioCall({ op: 'rmdir', path: p }); return; }
  request('POST', p, '?op=rmdir');
}
export function rename(from: string, to: string): void {
  if (isUserData(from)) { ioCall({ op: 'rename', path: from, to }); return; }
  request('POST', from, `?op=rename&to=${encodeURIComponent(to)}`);
}
