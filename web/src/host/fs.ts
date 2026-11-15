// The game's files for a worker, through the local server's file API (tools/serve.mjs) with
// synchronous XHRs (allowed in workers). Paths are "<root>/<relative path>", root "game" (read-only)
// or "userdata". Reads of the game's files go through a cache of 1 MB blocks per worker: the .rcf
// archives are read in many small pieces.

export class FsError extends Error {
  constructor(public code: 'ENOENT' | 'EEXIST' | 'EACCES' | 'ENOTEMPTY' | 'EIO') { super(code); }
}

export interface Stat { type: 'file' | 'dir'; size: number; mtimeMs: number; ino: number; }
export interface DirEntry { name: string; type: 'file' | 'dir'; size: number; }

const BLOCK = 1 << 20;
const CACHE_BLOCKS = 64;

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

export function stat(p: string): Stat {
  return JSON.parse(request('GET', p, '?op=stat').responseText) as Stat;
}

export function list(p: string): DirEntry[] {
  return JSON.parse(request('GET', p, '?op=list').responseText) as DirEntry[];
}

function readRange(p: string, pos: number, len: number): Uint8Array {
  const xhr = request('GET', p, '', undefined, { Range: `bytes=${pos}-${pos + len - 1}` }, true);
  return new Uint8Array(xhr.response as ArrayBuffer);
}

/** Reads up to dst.length bytes at pos; returns the count (short at the end of the file). */
export function read(p: string, pos: number, dst: Uint8Array): number {
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

export function write(p: string, pos: number, data: Uint8Array): void {
  request('PUT', p, `?op=write&pos=${pos}`, data);
}

export function truncate(p: string, size: number): void { request('POST', p, `?op=truncate&size=${size}`); }
export function mkdir(p: string): void { request('POST', p, '?op=mkdir'); }
export function unlink(p: string): void { request('POST', p, '?op=unlink'); }
export function rmdir(p: string): void { request('POST', p, '?op=rmdir'); }
export function rename(from: string, to: string): void { request('POST', from, `?op=rename&to=${encodeURIComponent(to)}`); }
