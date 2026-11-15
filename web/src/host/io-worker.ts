// The I/O worker: the game's writable files ("/userdata": saves, settings, caches) in the browser's
// storage (OPFS "userdata/"), so a player's saves stay in their browser, as GTA San Andreas web's.
// OPFS's directory calls are asynchronous and the game's file calls are not: each game-thread worker
// sends a request on its MessagePort and waits on its reply word (Atomics.wait) until this worker
// has done it (fs.ts ioCall). File bytes go straight between the files and the wasm memory.
//
// Page -> worker: { t: 'init', memory } then one { t: 'port', port } per game worker; 'ready' back once
//                 the saves of an older build (the local server's out/userdata) are imported.
// Game worker -> worker (on its port): IoRequest; the answer in its reply block:
//   Int32Array [0] state (0 pending, 1 done), [1] result (IO_*), [2] value (bytes, or the JSON's length)
//   and, from byte 16, a JSON answer (stat, list) of at most IO_TEXT bytes.

import { IO_EACCES, IO_EEXIST, IO_EIO, IO_ENOENT, IO_ENOTEMPTY, IO_OK, IO_TEXT_AT, type IoRequest } from './io-proto';

let memory: WebAssembly.Memory | null = null;
let root: FileSystemDirectoryHandle | null = null;
const handles = new Map<string, FileSystemSyncAccessHandle>();  // open files, by OPFS path
let scratch = new Uint8Array(1 << 20);
// one request at a time: the handles are shared by every request
let queue: Promise<void> = Promise.resolve();

class IoError extends Error { constructor(public code: number) { super(String(code)); } }

/** "userdata/a/b" -> ["a", "b"] */
const parts = (p: string) => p.split('/').filter(Boolean).slice(1);

async function child(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemHandle | null> {
  try { return await dir.getFileHandle(name); } catch { /* not a file of that name */ }
  try { return await dir.getDirectoryHandle(name); } catch { /* nor a folder */ }
  // the game's names are case-insensitive (as on the console)
  const lower = name.toLowerCase();
  for await (const [n, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) if (n.toLowerCase() === lower) return h;
  return null;
}

/** The handle at `p`, its parent folder and its name (the existing spelling when there is one). */
async function lookup(p: string): Promise<{ parent: FileSystemDirectoryHandle; name: string; handle: FileSystemHandle | null; key: string }> {
  const names = parts(p);
  let dir = root!;
  for (let i = 0; i < names.length - 1; i++) {
    const h = await child(dir, names[i]);
    if (!h || h.kind !== 'directory') throw new IoError(IO_ENOENT);
    dir = h as FileSystemDirectoryHandle;
  }
  if (!names.length) return { parent: root!, name: '', handle: root!, key: '' };
  const handle = await child(dir, names[names.length - 1]);
  const name = handle?.name ?? names[names.length - 1];
  return { parent: dir, name, handle, key: [...names.slice(0, -1), name].join('/').toLowerCase() };
}

async function open(p: string, create: boolean): Promise<FileSystemSyncAccessHandle> {
  const { parent, name, handle, key } = await lookup(p);
  const cached = handles.get(key);
  if (cached) return cached;
  if (handle?.kind === 'directory') throw new IoError(IO_EACCES);
  if (!handle && !create) throw new IoError(IO_ENOENT);
  const fh = handle ? handle as FileSystemFileHandle : await parent.getFileHandle(name, { create: true });
  const h = await fh.createSyncAccessHandle();
  handles.set(key, h);
  return h;
}

function closeUnder(key: string) {
  for (const [k, h] of handles) if (k === key || k.startsWith(`${key}/`)) { h.close(); handles.delete(k); }
}

async function run(r: IoRequest): Promise<{ result: number; value?: number; text?: string }> {
  const mem = () => new Uint8Array(memory!.buffer as unknown as ArrayBuffer);
  switch (r.op) {
    case 'stat': {
      const { handle, key } = await lookup(r.path);
      if (!handle) throw new IoError(IO_ENOENT);
      if (handle.kind === 'directory') return { result: IO_OK, text: JSON.stringify({ type: 'dir', size: 0, mtimeMs: 0, ino: 1 }) };
      const open = handles.get(key);
      const file = open ? null : await (handle as FileSystemFileHandle).getFile();
      const size = open ? open.getSize() : file!.size;
      return { result: IO_OK, text: JSON.stringify({ type: 'file', size, mtimeMs: file?.lastModified ?? Date.now(), ino: 2 }) };
    }
    case 'list': {
      const { handle } = await lookup(r.path);
      if (!handle || handle.kind !== 'directory') throw new IoError(IO_ENOENT);
      const out: { name: string; type: string; size: number }[] = [];
      for await (const [n, h] of (handle as unknown as AsyncIterable<[string, FileSystemHandle]>))
        out.push({ name: n, type: h.kind === 'directory' ? 'dir' : 'file', size: 0 });
      return { result: IO_OK, text: JSON.stringify(out) };
    }
    case 'read': {
      const h = await open(r.path, false);
      const len = r.len!;
      if (scratch.length < len) scratch = new Uint8Array(len);
      const view = scratch.subarray(0, len);
      const n = h.read(view, { at: r.pos! });
      mem().set(view.subarray(0, n), r.addr!);
      return { result: IO_OK, value: n };
    }
    case 'write': {
      const h = await open(r.path, true);
      const n = h.write(mem().slice(r.addr!, r.addr! + r.len!), { at: r.pos! });
      h.flush();
      return { result: IO_OK, value: n };
    }
    case 'truncate': {
      const h = await open(r.path, true);
      h.truncate(r.size!);
      h.flush();
      return { result: IO_OK };
    }
    case 'mkdir': {
      const { parent, name, handle } = await lookup(r.path);
      if (handle) throw new IoError(IO_EEXIST);
      await parent.getDirectoryHandle(name, { create: true });
      return { result: IO_OK };
    }
    case 'unlink':
    case 'rmdir': {
      const { parent, name, handle, key } = await lookup(r.path);
      if (!handle) throw new IoError(IO_ENOENT);
      closeUnder(key);
      try { await parent.removeEntry(name); } catch { throw new IoError(r.op === 'rmdir' ? IO_ENOTEMPTY : IO_EIO); }
      return { result: IO_OK };
    }
    case 'rename': {
      const from = await lookup(r.path);
      if (!from.handle) throw new IoError(IO_ENOENT);
      const to = await lookup(r.to!);
      closeUnder(from.key);
      closeUnder(to.key);
      if (to.handle && to.handle.kind === 'file') await to.parent.removeEntry(to.name);
      await (from.handle as unknown as { move(d: FileSystemDirectoryHandle, n: string): Promise<void> }).move(to.parent, to.name);
      return { result: IO_OK };
    }
  }
}

function answer(r: IoRequest, result: number, value = 0, text?: string) {
  const i32 = new Int32Array(r.reply, 0, 4);
  let v = value;
  if (text !== undefined) {
    const bytes = new TextEncoder().encode(text);
    const room = r.reply.byteLength - IO_TEXT_AT;
    new Uint8Array(r.reply, IO_TEXT_AT, Math.min(bytes.length, room)).set(bytes.subarray(0, room));
    v = Math.min(bytes.length, room);
  }
  i32[1] = result; i32[2] = v;
  Atomics.store(i32, 0, 1);
  Atomics.notify(i32, 0);
}

function serve(port: MessagePort) {
  port.onmessage = (ev: MessageEvent<IoRequest>) => {
    const r = ev.data;
    queue = queue.then(async () => {
      try {
        const res = await run(r);
        answer(r, res.result, res.value, res.text);
      } catch (e) {
        answer(r, e instanceof IoError ? e.code : IO_EIO);
      }
    });
  };
}

/** The saves an older build kept on the local server (out/userdata), copied once. */
async function importFromServer() {
  try {
    if (await child(root!, 'content')) return;
    const walk = async (rel: string, dir: FileSystemDirectoryHandle) => {
      const res = await fetch(`/fs/userdata/${rel}?op=list`, { cache: 'no-store' });
      if (!res.ok) return;
      for (const e of await res.json() as { name: string; type: string }[]) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.type === 'dir') await walk(path, await dir.getDirectoryHandle(e.name, { create: true }));
        else {
          const data = await (await fetch(`/fs/userdata/${path.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' })).arrayBuffer();
          const w = await (await dir.getFileHandle(e.name, { create: true })).createWritable();
          await w.write(data);
          await w.close();
        }
      }
    };
    const res = await fetch('/fs/userdata/content?op=stat', { cache: 'no-store' });
    if (!res.ok) return;
    await walk('content', await root!.getDirectoryHandle('content', { create: true }));
    self.postMessage({ t: 'log', line: '[io] the saves of the local server (out/userdata/content) were copied into the browser' });
  } catch (e) {
    self.postMessage({ t: 'log', line: `[io] the saves of the local server were not copied: ${String(e)}` });
  }
}

self.onmessage = async (ev: MessageEvent<{ t: 'init'; memory: WebAssembly.Memory } | { t: 'port'; port: MessagePort }>) => {
  const m = ev.data;
  if (m.t === 'port') { serve(m.port); return; }
  memory = m.memory;
  root = await (await navigator.storage.getDirectory()).getDirectoryHandle('userdata', { create: true });
  await importFromServer();
  self.postMessage({ t: 'ready' });
};
