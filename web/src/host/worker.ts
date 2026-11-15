// A game-thread worker: instantiates the module on the shared memory and parks until it gets the
// process entry (_start) or a thread from wasi thread-spawn. The same contract as tools/run-node.mjs
// (which came from GTA San Andreas web's runner), with the files over the local server (fs.ts).
// The descriptor table lives in a SharedArrayBuffer so every thread sees the same files.
import * as fs from './fs';
import { cacheDir, readComplete } from './gamecache';
import { C_POOL, C_TID, FD_MAX, FD_PATH, FD_SZ, K_BUSY, K_DIR, K_FILE, K_FREE, POOL, PREOPENS, S_CLAIM, S_IDLE, S_MAIN, S_RUN,
  type WorkerInit, type ToPage } from './proto';

const E = { SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 };

class ProcExit { constructor(public code: number) {} }

const post = (m: ToPage) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<WorkerInit>) => {
  const { mod, memory, ctl: ctlBuf, fdt: fdtBuf, slot, cfg, ioPort, ioReply } = ev.data;
  fs.useIo(ioPort, ioReply);
  const ctl = new Int32Array(ctlBuf);
  const fdI = new Int32Array(fdtBuf), fdF = new Float64Array(fdtBuf), fdU = new Uint8Array(fdtBuf);
  const te = new TextEncoder(), td = new TextDecoder();
  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);
  let tid = 0;

  // ---- descriptor table: i32 kind, i32 unused, f64 position, i32 append, path ----
  const fdKind = (fd: number) => fdI[fd * FD_SZ / 4];
  const fdPos = (fd: number) => fdF[fd * FD_SZ / 8 + 1];
  const setPos = (fd: number, p: number) => { fdF[fd * FD_SZ / 8 + 1] = p; };
  const fdAppend = (fd: number) => fdI[fd * FD_SZ / 4 + 4];
  const fdPath = (fd: number) => { const b = fd * FD_SZ + FD_PATH; let e = b; while (fdU[e]) e++; return td.decode(fdU.slice(b, e)); };
  function fdAlloc(kind: number, p: string, append: boolean): number {
    for (let fd = 3 + PREOPENS.length; fd < FD_MAX; fd++) {
      if (Atomics.compareExchange(fdI, fd * FD_SZ / 4, K_FREE, K_BUSY) !== K_FREE) continue;
      setPos(fd, 0); fdI[fd * FD_SZ / 4 + 4] = append ? 1 : 0;
      const b = te.encode(p), n = Math.min(b.length, FD_SZ - FD_PATH - 1);
      fdU.set(b.subarray(0, n), fd * FD_SZ + FD_PATH); fdU[fd * FD_SZ + FD_PATH + n] = 0;
      Atomics.store(fdI, fd * FD_SZ / 4, kind);
      return fd;
    }
    return -1;
  }
  const fdFree = (fd: number) => Atomics.store(fdI, fd * FD_SZ / 4, K_FREE);
  // preopens: fds 3.. (every worker writes the same values)
  PREOPENS.forEach((root, k) => {
    const fd = 3 + k, b = te.encode(root);
    fdU.set(b, fd * FD_SZ + FD_PATH); fdU[fd * FD_SZ + FD_PATH + b.length] = 0;
    fdI[fd * FD_SZ / 4] = K_DIR;
  });
  const isDir = (fd: number) => fd >= 3 && fd < FD_MAX && fdKind(fd) === K_DIR;
  const isFile = (fd: number) => fd >= 3 + PREOPENS.length && fd < FD_MAX && fdKind(fd) === K_FILE;

  const errno = (e: unknown) => e instanceof fs.FsError
    ? ({ ENOENT: E.NOENT, EEXIST: E.EXIST, EACCES: E.ACCES, ENOTEMPTY: E.NOTEMPTY, EIO: E.IO })[e.code] : E.IO;
  const str = (p: number, l: number) => td.decode(u8().slice(p, p + l));
  // "<root>/<path>" under a directory descriptor (the server matches names case-insensitively)
  function resolve(dfd: number, rel: string): string {
    const parts = fdPath(dfd).split('/');
    for (const part of rel.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (parts.length > 1) parts.pop(); continue; }
      parts.push(part);
    }
    return parts.join('/');
  }
  const FT = (t: 'file' | 'dir') => t === 'dir' ? 3 : 4;
  function writeStat(p: number, st: fs.Stat) {
    const d = dv();
    d.setBigUint64(p, 1n, true); d.setBigUint64(p + 8, BigInt(st.ino), true);
    d.setUint8(p + 16, FT(st.type)); d.setBigUint64(p + 24, 1n, true); d.setBigUint64(p + 32, BigInt(st.size), true);
    const t = BigInt(Math.round(st.mtimeMs * 1e6));
    for (const o of [40, 48, 56]) d.setBigUint64(p + o, t, true);
  }
  function iovs(iov: number, n: number): [number, number][] {
    const d = dv(), out: [number, number][] = [];
    for (let i = 0; i < n; i++) out.push([d.getUint32(iov + 8 * i, true), d.getUint32(iov + 8 * i + 4, true)]);
    return out;
  }
  function readAt(fd: number, iov: number, n: number, pos: number, pr: number): number {
    let t = 0;
    const p = fdPath(fd);
    for (const [b, l] of iovs(iov, n)) {
      if (!l) continue;
      const k = fs.read(p, pos + t, u8().subarray(b, b + l));
      t += k; if (k < l) break;
    }
    dv().setUint32(pr, t, true);
    return t;
  }
  function writeAt(fd: number, iov: number, n: number, pos: number, pw: number): number {
    let t = 0;
    const p = fdPath(fd);
    for (const [b, l] of iovs(iov, n)) { if (l) { fs.write(p, pos + t, u8().subarray(b, b + l)); t += l; } }
    dv().setUint32(pw, t, true);
    return t;
  }
  const outBuf: Record<number, string> = { 1: '', 2: '' };
  function stdOut(fd: number, iov: number, n: number, pw: number): number {
    let t = 0;
    for (const [b, l] of iovs(iov, n)) { outBuf[fd] += td.decode(u8().slice(b, b + l)); t += l; }
    let k;
    while ((k = outBuf[fd].indexOf('\n')) >= 0) { post({ t: 'log', line: outBuf[fd].slice(0, k), tid }); outBuf[fd] = outBuf[fd].slice(k + 1); }
    dv().setUint32(pw, t, true);
    return E.SUCCESS;
  }
  const guard = <A extends unknown[]>(f: (...a: A) => number) => (...a: A): number => {
    try { return f(...a); } catch (e) { if (e instanceof ProcExit) throw e; return errno(e); }
  };
  const sleepWord = new Int32Array(new SharedArrayBuffer(4));
  const sleepMs = (ms: number) => { if (ms > 0) Atomics.wait(sleepWord, 0, 0, ms); };

  const argv = cfg.args.map(s => te.encode(`${s}\0`));
  const envv = Object.entries(cfg.env).map(([k, v]) => te.encode(`${k}=${v}\0`));
  const sizes = (l: Uint8Array[], pc: number, ps: number) => { dv().setUint32(pc, l.length, true); dv().setUint32(ps, l.reduce((a, b) => a + b.length, 0), true); return 0; };
  const fill = (l: Uint8Array[], pv: number, pb: number) => { let o = pb; l.forEach((b, i) => { dv().setUint32(pv + 4 * i, o, true); u8().set(b, o); o += b.length; }); return 0; };
  const T0 = performance.timeOrigin;
  const nowNs = () => BigInt(Math.round((T0 + performance.now()) * 1e3)) * 1000n;

  const wasi = {
    args_sizes_get: (pc: number, ps: number) => sizes(argv, pc, ps),
    args_get: (pv: number, pb: number) => fill(argv, pv, pb),
    environ_sizes_get: (pc: number, ps: number) => sizes(envv, pc, ps),
    environ_get: (pv: number, pb: number) => fill(envv, pv, pb),
    clock_res_get: (_id: number, p: number) => { dv().setBigUint64(p, 1000n, true); return 0; },
    clock_time_get: (_id: number, _prec: bigint, p: number) => { dv().setBigUint64(p, nowNs(), true); return 0; },
    random_get: (p: number, n: number) => { const b = new Uint8Array(n); crypto.getRandomValues(b); u8().set(b, p); return 0; },
    sched_yield: () => 0,
    proc_exit: (code: number) => { throw new ProcExit(code); },
    proc_raise: () => E.NOSYS,
    poll_oneoff: (inp: number, outp: number, n: number, pn: number) => {
      const d = dv(), now = nowNs(); let wait = -1n;
      for (let i = 0; i < n; i++) {
        const s = inp + 48 * i;
        if (d.getUint8(s + 8) !== 0) continue;
        let t = d.getBigUint64(s + 24, true);
        if (d.getUint16(s + 40, true) & 1) t = t > now ? t - now : 0n;
        if (wait < 0n || t < wait) wait = t;
      }
      if (wait > 0n) sleepMs(Number(wait) / 1e6);
      for (let i = 0; i < n; i++) {
        const s = inp + 48 * i, o = outp + 32 * i;
        d.setBigUint64(o, d.getBigUint64(s, true), true); d.setUint16(o + 8, 0, true); d.setUint8(o + 10, d.getUint8(s + 8));
      }
      d.setUint32(pn, n, true); return 0;
    },
    fd_write: guard((fd: number, iov: number, n: number, pw: number) => {
      if (fd === 1 || fd === 2) return stdOut(fd, iov, n, pw);
      if (!isFile(fd)) return E.BADF;
      const pos = fdAppend(fd) ? fs.stat(fdPath(fd)).size : fdPos(fd);
      setPos(fd, pos + writeAt(fd, iov, n, pos, pw)); return 0;
    }),
    fd_pwrite: guard((fd: number, iov: number, n: number, off: bigint, pw: number) => isFile(fd) ? (writeAt(fd, iov, n, Number(off), pw), 0) : E.BADF),
    fd_read: guard((fd: number, iov: number, n: number, pr: number) => {
      if (fd === 0) { dv().setUint32(pr, 0, true); return 0; }
      if (!isFile(fd)) return isDir(fd) ? E.ISDIR : E.BADF;
      setPos(fd, fdPos(fd) + readAt(fd, iov, n, fdPos(fd), pr)); return 0;
    }),
    fd_pread: guard((fd: number, iov: number, n: number, off: bigint, pr: number) => isFile(fd) ? (readAt(fd, iov, n, Number(off), pr), 0) : E.BADF),
    fd_seek: guard((fd: number, off: bigint, wh: number, p: number) => {
      if (!isFile(fd)) return E.BADF;
      const base = wh === 0 ? 0 : wh === 1 ? fdPos(fd) : fs.stat(fdPath(fd)).size;
      const np = base + Number(off);
      if (np < 0) return E.INVAL;
      setPos(fd, np); dv().setBigUint64(p, BigInt(np), true); return 0;
    }),
    fd_tell: (fd: number, p: number) => isFile(fd) ? (dv().setBigUint64(p, BigInt(fdPos(fd)), true), 0) : E.BADF,
    fd_close: (fd: number) => {
      if (fd < 3 + PREOPENS.length) return 0;
      const k = fdKind(fd);
      if (k !== K_FILE && k !== K_DIR) return E.BADF;
      fdFree(fd); return 0;
    },
    fd_sync: () => 0,
    fd_datasync: () => 0,
    fd_fdstat_get: (fd: number, p: number) => {
      const d = dv();
      const ft = fd <= 2 ? 2 : isDir(fd) ? 3 : isFile(fd) ? 4 : -1;
      if (ft < 0) return E.BADF;
      d.setUint8(p, ft); d.setUint16(p + 2, 0, true);
      d.setBigUint64(p + 8, 0x1FFFFFFFn, true); d.setBigUint64(p + 16, 0x1FFFFFFFn, true); return 0;
    },
    fd_fdstat_set_flags: () => 0,
    fd_fdstat_set_rights: () => 0,
    fd_filestat_get: guard((fd: number, p: number) => {
      if (!isFile(fd) && !isDir(fd)) return E.BADF;
      writeStat(p, fs.stat(fdPath(fd))); return 0;
    }),
    fd_filestat_set_size: guard((fd: number, sz: bigint) => isFile(fd) ? (fs.truncate(fdPath(fd), Number(sz)), 0) : E.BADF),
    fd_filestat_set_times: () => 0,
    fd_advise: () => 0,
    fd_allocate: () => 0,
    fd_prestat_get: (fd: number, p: number) => {
      if (fd < 3 || fd >= 3 + PREOPENS.length) return E.BADF;
      dv().setUint8(p, 0); dv().setUint32(p + 4, te.encode(`/${PREOPENS[fd - 3]}`).length, true); return 0;
    },
    fd_prestat_dir_name: (fd: number, p: number, l: number) => {
      if (fd < 3 || fd >= 3 + PREOPENS.length) return E.BADF;
      u8().set(te.encode(`/${PREOPENS[fd - 3]}`).subarray(0, l), p); return 0;
    },
    fd_readdir: guard((fd: number, buf: number, len: number, cookie: bigint, pu: number) => {
      if (!isDir(fd)) return E.BADF;
      const names = fs.list(fdPath(fd)), d = dv();
      let o = 0;
      for (let i = Number(cookie); i < names.length && o < len; i++) {
        const nm = te.encode(names[i].name), ent = new Uint8Array(24 + nm.length), ed = new DataView(ent.buffer);
        ed.setBigUint64(0, BigInt(i + 1), true); ed.setBigUint64(8, BigInt(i + 1), true);
        ed.setUint32(16, nm.length, true); ed.setUint8(20, FT(names[i].type)); ent.set(nm, 24);
        const k = Math.min(ent.length, len - o);
        u8().set(ent.subarray(0, k), buf + o); o += k;
      }
      d.setUint32(pu, o, true); return 0;
    }),
    fd_renumber: () => E.NOSYS,
    path_open: guard((dfd: number, _dfl: number, p: number, pl: number, of: number, rb: bigint, _ri: bigint, ff: number, pfd: number) => {
      if (!isDir(dfd)) return E.BADF;
      const hp = resolve(dfd, str(p, pl));
      const creat = of & 1, wantDir = of & 2, excl = of & 4, trunc = of & 8;
      let st: fs.Stat | null = null; try { st = fs.stat(hp); } catch {}
      if (st?.type === 'dir') {
        if (trunc || ((rb & 0x40n) && !wantDir)) return E.ISDIR;
        const fd = fdAlloc(K_DIR, hp, false); if (fd < 0) return E.IO;
        dv().setUint32(pfd, fd, true); return 0;
      }
      if (wantDir) return st ? E.NOTDIR : E.NOENT;
      if (!st && !creat) return E.NOENT;
      if (st && creat && excl) return E.EXIST;
      if (hp.startsWith('game/') && (creat || trunc || (rb & 0x40n))) return E.ACCES;
      if (!st || trunc) fs.truncate(hp, 0);
      const fd = fdAlloc(K_FILE, hp, (ff & 1) !== 0); if (fd < 0) return E.IO;
      dv().setUint32(pfd, fd, true); return 0;
    }),
    path_filestat_get: guard((dfd: number, _fl: number, p: number, pl: number, out: number) => {
      if (!isDir(dfd)) return E.BADF;
      writeStat(out, fs.stat(resolve(dfd, str(p, pl)))); return 0;
    }),
    path_filestat_set_times: () => 0,
    path_create_directory: guard((dfd: number, p: number, pl: number) => (fs.mkdir(resolve(dfd, str(p, pl))), 0)),
    path_remove_directory: guard((dfd: number, p: number, pl: number) => (fs.rmdir(resolve(dfd, str(p, pl))), 0)),
    path_unlink_file: guard((dfd: number, p: number, pl: number) => (fs.unlink(resolve(dfd, str(p, pl))), 0)),
    path_rename: guard((a: number, ap: number, al: number, b: number, bp: number, bl: number) => (fs.rename(resolve(a, str(ap, al)), resolve(b, str(bp, bl))), 0)),
    path_link: () => E.NOSYS, path_symlink: () => E.NOSYS, path_readlink: () => E.NOSYS,
    sock_accept: () => E.NOSYS, sock_recv: () => E.NOSYS, sock_send: () => E.NOSYS, sock_shutdown: () => E.NOSYS,
  };

  function threadSpawn(arg: number): number {
    const t = Atomics.add(ctl, C_TID, 1);
    for (let s = 1; s < POOL; s++) {
      const i = C_POOL + 4 * s;
      if (Atomics.compareExchange(ctl, i, S_IDLE, S_CLAIM) === S_IDLE) {
        ctl[i + 1] = t; ctl[i + 2] = arg;
        Atomics.store(ctl, i, S_RUN); Atomics.notify(ctl, i);
        return t;
      }
    }
    post({ t: 'log', line: `[host] no pool worker for thread ${t} (at most ${POOL - 1})`, tid });
    return -6;
  }

  const host = {
    register: () => 0,
    // the page attaches the executor (gpu/executor.ts); 1: the recorder waits for it
    gpu_register: (ctlPtr: number) => { post({ t: 'gpu', ctl: ctlPtr }); return 1; },
    // the controllers' block (runtime/input_wasm.cpp): the page writes it (input.ts)
    input_register: (block: number) => post({ t: 'input', block }),
    net_register: (block: number) => post({ t: 'net', block }),
    // the sound ring (runtime/audio_device_web.cpp): the page's AudioWorklet plays it
    audio_register: (ring: number) => post({ t: 'audio', ring }),
  };
  const imports: Record<string, Record<string, unknown>> = {
    env: { memory }, wasi_snapshot_preview1: wasi, wasi: { 'thread-spawn': threadSpawn }, crashott: host,
  };
  for (const im of WebAssembly.Module.imports(mod)) {
    const ns = (imports[im.module] ??= {});
    if (im.kind === 'function' && !(im.name in ns))
      ns[im.name] = (...a: unknown[]) => { post({ t: 'log', line: `[host] unimplemented import ${im.module}.${im.name}(${a.join(',')})`, tid }); return E.NOSYS; };
  }
  // The game files already in the browser's storage: read-only handles (several workers may hold one).
  try {
    const dir = await cacheDir();
    for (const [name, f] of Object.entries(await readComplete(dir))) {
      const fh = await dir.getFileHandle(name);
      const h = await (fh as unknown as { createSyncAccessHandle(o: { mode: string }): Promise<FileSystemSyncAccessHandle> })
        .createSyncAccessHandle({ mode: 'read-only' });
      fs.useLocal(name, h, f.s, f.m);
    }
  } catch (e) {
    if (slot === 0) post({ t: 'log', line: `[host] game files in the browser's storage not usable: ${String(e)}`, tid });
  }
  const ex = (await WebAssembly.instantiate(mod, imports as WebAssembly.Imports)).exports as unknown as {
    _start(): void; wasi_thread_start(tid: number, arg: number): void;
  };
  const exit = (code: number) => post({ t: 'exit', code });
  const i = C_POOL + 4 * slot;
  Atomics.store(ctl, i, S_IDLE);
  post({ t: 'ready', slot });
  for (;;) {
    let st;
    while ((st = Atomics.load(ctl, i)) === S_IDLE || st === S_CLAIM) Atomics.wait(ctl, i, st);
    try {
      if (st === S_MAIN) {
        try { ex._start(); exit(0); } catch (x) { if (x instanceof ProcExit) exit(x.code); else throw x; }
        break;
      }
      tid = ctl[i + 1];
      try { ex.wasi_thread_start(tid, ctl[i + 2]); } catch (x) { if (x instanceof ProcExit) { exit(x.code); break; } throw x; }
    } catch (x) {
      post({ t: 'trap', tid, message: String(x), stack: (x as Error)?.stack ?? '' });
      exit(134); break;
    }
    Atomics.store(ctl, i, S_IDLE);
  }
};
