// Headless runner: out/web/crashott.wasm under Node, without a page.
//
//   node tools/run-node.mjs --game DIR [--userdata DIR] [--timeout S] [-e KEY=VALUE ...] [-- runtime args]
//
// Adapted from GTA San Andreas web's tools/run-node.mjs (the same author's project): one shared
// memory, a pool of workers that each instantiate the module and park until they get the process
// entry (_start) or a thread from wasi thread-spawn. File I/O is synchronous node:fs in the calling
// worker, with the descriptor table in shared memory so every thread sees the same files.
// No renderer, no audio, no input yet. /game is the game folder (read-only by convention),
// /userdata the folder saves and caches go to.
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Guest threads plus guest fibers (runtime/platform_wasm.cpp: a fiber is a thread).
const POOL = 48;
// Linear memory: 1 GB at start (the runtime's part, tools/wasm_runtime.sh INITIAL_MB), up to 4 GB
// (guest address == linear address).
const INITIAL_PAGES = 16384, MAX_PAGES = 65536;
// Native stack of each worker: the recompiled code nests one host frame per guest call.
const STACK_MB = 64;
// ctl (Int32Array): [0] next tid, [1] exit flag, [2] exit code, [3] sleep word, then 4 per pool slot: state, tid, arg
const C_TID = 0, C_EXIT = 1, C_CODE = 2, C_SLEEP = 3, C_POOL = 4;
const C_END = C_POOL + 4 * POOL;
const S_NONE = 0, S_IDLE = 3, S_CLAIM = 1, S_RUN = 2, S_MAIN = 4;
// fd table: FD_MAX entries of FD_SZ bytes: i32 kind, i32 host fd, f64 position, i32 append, path (UTF-8, NUL ended)
const FD_MAX = 1024, FD_SZ = 1024, FD_PATH = 24;
const K_FREE = 0, K_FILE = 1, K_DIR = 2, K_BUSY = -1;
const PREOPENS = ['/game', '/userdata'];   // fds 3 and 4
const E = { SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, IO: 29 };

if (isMainThread) {
  const argv = process.argv.slice(2), env = {}, rtArgs = [];
  let game = null, userdata = path.join(ROOT, 'out', 'userdata'), timeout = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--game') game = argv[++i];
    else if (a === '--userdata') userdata = argv[++i];
    else if (a === '--timeout') timeout = Number(argv[++i]);
    else if (a === '-e') { const [k, ...v] = argv[++i].split('='); env[k] = v.join('='); }
    else if (a === '--') { rtArgs.push(...argv.slice(i + 1)); break; }
    else { console.error(`run-node: unknown argument ${a}`); process.exit(2); }
  }
  if (!game || !fs.existsSync(path.join(game, 'default.xex'))) {
    console.error('run-node: --game must be the extracted game folder (with default.xex)'); process.exit(2);
  }
  fs.mkdirSync(userdata, { recursive: true });
  const mod = await WebAssembly.compile(fs.readFileSync(path.join(ROOT, 'out/web/crashott.wasm')));
  const memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: MAX_PAGES, shared: true });
  const ctl = new SharedArrayBuffer(4 * C_END);
  const fdt = new SharedArrayBuffer(FD_MAX * FD_SZ);
  const cfg = { args: ['crashott', '--game', '/game', '--userdata', '/userdata', ...rtArgs], env,
    hostRoots: [path.resolve(game), path.resolve(userdata)] };
  const ctlI = new Int32Array(ctl);
  ctlI[C_TID] = 1;
  const t0 = Date.now();
  const workers = [];
  for (let s = 0; s < POOL; s++) {
    const w = new Worker(fileURLToPath(import.meta.url),
      { workerData: { mod, memory, ctl, fdt, slot: s, cfg }, resourceLimits: { stackSizeMb: STACK_MB } });
    w.on('message', m => {
      if (m.t === 'exit') {
        console.error(`\nrun-node: exit ${m.code} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        process.exit(m.code);
      }
    });
    w.on('error', e => { console.error(`run-node: worker ${s} failed:`, e); process.exit(134); });
    workers.push(w);
  }
  // start the process once every worker is parked
  while (workers.length && ctlI.slice(C_POOL, C_END).filter((v, k) => k % 4 === 0 && v === S_IDLE).length < POOL)
    await new Promise(r => setTimeout(r, 20));
  console.error(`run-node: ${POOL} workers ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, starting`);
  Atomics.store(ctlI, C_POOL, S_MAIN); Atomics.notify(ctlI, C_POOL);
  if (timeout > 0) setTimeout(() => {
    console.error(`\nrun-node: timeout after ${timeout} s, linear memory ${(memory.buffer.byteLength / 1048576).toFixed(0)} MB`);
    process.exit(124);
  }, timeout * 1000);
} else {
  const { mod, memory, ctl: ctlBuf, fdt: fdtBuf, slot, cfg } = workerData;
  const ctl = new Int32Array(ctlBuf);
  const fdI = new Int32Array(fdtBuf), fdF = new Float64Array(fdtBuf), fdU = new Uint8Array(fdtBuf);
  const te = new TextEncoder(), td = new TextDecoder();
  const u8 = () => new Uint8Array(memory.buffer);
  const dv = () => new DataView(memory.buffer);
  let tid = 0, blockedMs = 0;
  class ProcExit { constructor(code) { this.code = code; } }

  // ---- descriptor table ----
  const fdKind = fd => fdI[fd * FD_SZ / 4];
  const fdHost = fd => fdI[fd * FD_SZ / 4 + 1];
  const fdPos = fd => fdF[fd * FD_SZ / 8 + 1];
  const setPos = (fd, p) => { fdF[fd * FD_SZ / 8 + 1] = p; };
  const fdAppend = fd => fdI[fd * FD_SZ / 4 + 4];
  const fdPath = fd => { const b = fd * FD_SZ + FD_PATH; let e = b; while (fdU[e]) e++; return td.decode(fdU.slice(b, e)); };
  function fdAlloc(kind, host, hostPath, append) {
    for (let fd = 5; fd < FD_MAX; fd++) {
      if (Atomics.compareExchange(fdI, fd * FD_SZ / 4, K_FREE, K_BUSY) !== K_FREE) continue;
      fdI[fd * FD_SZ / 4 + 1] = host; setPos(fd, 0); fdI[fd * FD_SZ / 4 + 4] = append ? 1 : 0;
      const p = te.encode(hostPath); fdU.set(p.subarray(0, FD_SZ - FD_PATH - 1), fd * FD_SZ + FD_PATH); fdU[fd * FD_SZ + FD_PATH + Math.min(p.length, FD_SZ - FD_PATH - 1)] = 0;
      Atomics.store(fdI, fd * FD_SZ / 4, kind);
      return fd;
    }
    return -1;
  }
  const fdFree = fd => Atomics.store(fdI, fd * FD_SZ / 4, K_FREE);
  // preopens are fds 3, 4 (set up by every worker, the same values)
  PREOPENS.forEach((_, k) => {
    const fd = 3 + k, p = te.encode(cfg.hostRoots[k]);
    fdI[fd * FD_SZ / 4 + 1] = -1; fdU.set(p, fd * FD_SZ + FD_PATH); fdU[fd * FD_SZ + FD_PATH + p.length] = 0;
    fdI[fd * FD_SZ / 4] = K_DIR;
  });
  const isDir = fd => fd >= 3 && fd < FD_MAX && fdKind(fd) === K_DIR;
  const isFile = fd => fd >= 5 && fd < FD_MAX && fdKind(fd) === K_FILE;

  const errno = e => ({ ENOENT: E.NOENT, EEXIST: E.EXIST, EISDIR: E.ISDIR, ENOTDIR: E.NOTDIR, EACCES: E.ACCES,
    EPERM: E.ACCES, ENOTEMPTY: E.NOTEMPTY, EBADF: E.BADF, EINVAL: E.INVAL })[e?.code] ?? E.IO;
  const str = (p, l) => td.decode(u8().slice(p, p + l));
  // a guest path under a directory fd -> host path; a component that does not
  // exist as spelled is looked up case-insensitively (Windows names)
  function resolve(dfd, rel) {
    let cur = fdPath(dfd);
    for (const part of rel.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { cur = path.dirname(cur); continue; }
      let next = path.join(cur, part);
      if (!fs.existsSync(next)) {
        try { const hit = fs.readdirSync(cur).find(n => n.toLowerCase() === part.toLowerCase()); if (hit) next = path.join(cur, hit); } catch {}
      }
      cur = next;
    }
    return cur;
  }
  const FT = st => st.isDirectory() ? 3 : st.isFile() ? 4 : 0;
  function writeStat(p, st) {
    const d = dv();
    d.setBigUint64(p, BigInt(st.dev), true); d.setBigUint64(p + 8, BigInt(st.ino), true);
    d.setUint8(p + 16, FT(st)); d.setBigUint64(p + 24, BigInt(st.nlink), true); d.setBigUint64(p + 32, BigInt(st.size), true);
    for (const [o, t] of [[40, st.atimeMs], [48, st.mtimeMs], [56, st.ctimeMs]]) d.setBigUint64(p + o, BigInt(Math.round(t * 1e6)), true);
  }
  function iovs(iov, n) {
    const d = dv(), out = [];
    for (let i = 0; i < n; i++) out.push([d.getUint32(iov + 8 * i, true), d.getUint32(iov + 8 * i + 4, true)]);
    return out;
  }
  function readAt(fd, iov, n, pos, pr) {
    let t = 0;
    for (const [b, l] of iovs(iov, n)) {
      if (!l) continue;
      const k = fs.readSync(fdHost(fd), u8(), b, l, pos + t);
      t += k; if (k < l) break;
    }
    dv().setUint32(pr, t, true);
    return t;
  }
  function writeAt(fd, iov, n, pos, pw) {
    let t = 0;
    for (const [b, l] of iovs(iov, n)) { if (l) t += fs.writeSync(fdHost(fd), u8(), b, l, pos + t); }
    dv().setUint32(pw, t, true);
    return t;
  }
  const outBuf = { 1: '', 2: '' };
  function stdOut(fd, iov, n, pw) {
    let t = 0;
    for (const [b, l] of iovs(iov, n)) { outBuf[fd] += td.decode(u8().slice(b, b + l)); t += l; }
    let k;
    while ((k = outBuf[fd].indexOf('\n')) >= 0) { fs.writeSync(2, `${outBuf[fd].slice(0, k)}\n`); outBuf[fd] = outBuf[fd].slice(k + 1); }
    dv().setUint32(pw, t, true);
    return E.SUCCESS;
  }
  const guard = f => (...a) => { try { return f(...a); } catch (e) { if (e instanceof ProcExit) throw e; return errno(e); } };
  const sleepMs = ms => { if (ms > 0) { const t0 = performance.now(); Atomics.wait(ctl, C_SLEEP, 0, ms); blockedMs += performance.now() - t0; } };

  const argv = cfg.args.map(s => te.encode(`${s}\0`));
  const envv = Object.entries(cfg.env).map(([k, v]) => te.encode(`${k}=${v}\0`));
  const sizes = (l, pc, ps) => { dv().setUint32(pc, l.length, true); dv().setUint32(ps, l.reduce((a, b) => a + b.length, 0), true); return 0; };
  const fill = (l, pv, pb) => { let o = pb; l.forEach((b, i) => { dv().setUint32(pv + 4 * i, o, true); u8().set(b, o); o += b.length; }); return 0; };
  const T0 = performance.timeOrigin;

  const wasi = {
    args_sizes_get: (pc, ps) => sizes(argv, pc, ps),
    args_get: (pv, pb) => fill(argv, pv, pb),
    environ_sizes_get: (pc, ps) => sizes(envv, pc, ps),
    environ_get: (pv, pb) => fill(envv, pv, pb),
    clock_res_get: (_id, p) => { dv().setBigUint64(p, 1000n, true); return 0; },
    clock_time_get: (_id, _prec, p) => { dv().setBigUint64(p, BigInt(Math.round((T0 + performance.now()) * 1e3)) * 1000n, true); return 0; },
    random_get: (p, n) => { u8().set(crypto.randomBytes(n), p); return 0; },
    sched_yield: () => 0,
    proc_exit: code => { throw new ProcExit(code); },
    proc_raise: () => E.NOSYS,
    poll_oneoff: (inp, outp, n, pn) => {
      const d = dv(), now = BigInt(Math.round((T0 + performance.now()) * 1e3)) * 1000n; let wait = -1n;
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
    fd_write: guard((fd, iov, n, pw) => {
      if (fd === 1 || fd === 2) return stdOut(fd, iov, n, pw);
      if (!isFile(fd)) return E.BADF;
      const pos = fdAppend(fd) ? fs.fstatSync(fdHost(fd)).size : fdPos(fd);
      setPos(fd, pos + writeAt(fd, iov, n, pos, pw)); return 0;
    }),
    fd_pwrite: guard((fd, iov, n, off, pw) => isFile(fd) ? (writeAt(fd, iov, n, Number(off), pw), 0) : E.BADF),
    fd_read: guard((fd, iov, n, pr) => {
      if (fd === 0) { dv().setUint32(pr, 0, true); return 0; }
      if (!isFile(fd)) return isDir(fd) ? E.ISDIR : E.BADF;
      setPos(fd, fdPos(fd) + readAt(fd, iov, n, fdPos(fd), pr)); return 0;
    }),
    fd_pread: guard((fd, iov, n, off, pr) => isFile(fd) ? (readAt(fd, iov, n, Number(off), pr), 0) : E.BADF),
    fd_seek: guard((fd, off, wh, p) => {
      if (!isFile(fd)) return E.BADF;
      const base = wh === 0 ? 0 : wh === 1 ? fdPos(fd) : fs.fstatSync(fdHost(fd)).size;
      const np = base + Number(off);
      if (np < 0) return E.INVAL;
      setPos(fd, np); dv().setBigUint64(p, BigInt(np), true); return 0;
    }),
    fd_tell: (fd, p) => isFile(fd) ? (dv().setBigUint64(p, BigInt(fdPos(fd)), true), 0) : E.BADF,
    fd_close: guard(fd => {
      if (fd <= 4) return 0;
      const k = fdKind(fd);
      if (k === K_FILE) fs.closeSync(fdHost(fd));
      else if (k !== K_DIR) return E.BADF;
      fdFree(fd); return 0;
    }),
    fd_sync: guard(fd => (isFile(fd) && fs.fsyncSync(fdHost(fd)), 0)),
    fd_datasync: guard(fd => (isFile(fd) && fs.fsyncSync(fdHost(fd)), 0)),
    fd_fdstat_get: (fd, p) => {
      const d = dv();
      const ft = fd <= 2 ? 2 : isDir(fd) ? 3 : isFile(fd) ? 4 : -1;
      if (ft < 0) return E.BADF;
      d.setUint8(p, ft); d.setUint16(p + 2, 0, true);
      d.setBigUint64(p + 8, 0x1FFFFFFFn, true); d.setBigUint64(p + 16, 0x1FFFFFFFn, true); return 0;
    },
    fd_fdstat_set_flags: () => 0,
    fd_fdstat_set_rights: () => 0,
    fd_filestat_get: guard((fd, p) => {
      if (isFile(fd)) { writeStat(p, fs.fstatSync(fdHost(fd))); return 0; }
      if (isDir(fd)) { writeStat(p, fs.statSync(fdPath(fd))); return 0; }
      return E.BADF;
    }),
    fd_filestat_set_size: guard((fd, sz) => isFile(fd) ? (fs.ftruncateSync(fdHost(fd), Number(sz)), 0) : E.BADF),
    fd_filestat_set_times: () => 0,
    fd_advise: () => 0,
    fd_allocate: () => 0,
    fd_prestat_get: (fd, p) => {
      if (fd < 3 || fd >= 3 + PREOPENS.length) return E.BADF;
      dv().setUint8(p, 0); dv().setUint32(p + 4, te.encode(PREOPENS[fd - 3]).length, true); return 0;
    },
    fd_prestat_dir_name: (fd, p, l) => {
      if (fd < 3 || fd >= 3 + PREOPENS.length) return E.BADF;
      u8().set(te.encode(PREOPENS[fd - 3]).subarray(0, l), p); return 0;
    },
    fd_readdir: guard((fd, buf, len, cookie, pu) => {
      if (!isDir(fd)) return E.BADF;
      const dir = fdPath(fd), names = fs.readdirSync(dir), d = dv();
      let o = 0;
      for (let i = Number(cookie); i < names.length && o < len; i++) {
        let st = null; try { st = fs.statSync(path.join(dir, names[i])); } catch {}
        const nm = te.encode(names[i]), ent = new Uint8Array(24 + nm.length), ed = new DataView(ent.buffer);
        ed.setBigUint64(0, BigInt(i + 1), true); ed.setBigUint64(8, BigInt(st ? st.ino : 0), true);
        ed.setUint32(16, nm.length, true); ed.setUint8(20, st ? FT(st) : 0); ent.set(nm, 24);
        const k = Math.min(ent.length, len - o);
        u8().set(ent.subarray(0, k), buf + o); o += k;
      }
      d.setUint32(pu, o, true); return 0;
    }),
    fd_renumber: () => E.NOSYS,
    path_open: guard((dfd, _dfl, p, pl, of, rb, _ri, ff, pfd) => {
      if (!isDir(dfd)) return E.BADF;
      const hp = resolve(dfd, str(p, pl));
      const creat = of & 1, wantDir = of & 2, excl = of & 4, trunc = of & 8;
      let st = null; try { st = fs.statSync(hp); } catch {}
      if (st?.isDirectory()) {
        if (trunc || (rb & 0x40n && !wantDir)) return E.ISDIR;
        const fd = fdAlloc(K_DIR, -1, hp, 0); if (fd < 0) return E.IO;
        dv().setUint32(pfd, fd, true); return 0;
      }
      if (wantDir) return st ? E.NOTDIR : E.NOENT;
      if (!st && !creat) return E.NOENT;
      if (st && creat && excl) return E.EXIST;
      const write = (rb & 0x40n) !== 0n || trunc || creat;
      let flags = write ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
      if (creat) flags |= fs.constants.O_CREAT;
      if (excl) flags |= fs.constants.O_EXCL;
      if (trunc) flags |= fs.constants.O_TRUNC;
      const h = fs.openSync(hp, flags, 0o644);
      const fd = fdAlloc(K_FILE, h, hp, ff & 1); if (fd < 0) { fs.closeSync(h); return E.IO; }
      dv().setUint32(pfd, fd, true); return 0;
    }),
    path_filestat_get: guard((dfd, _fl, p, pl, out) => {
      if (!isDir(dfd)) return E.BADF;
      writeStat(out, fs.statSync(resolve(dfd, str(p, pl)))); return 0;
    }),
    path_filestat_set_times: () => 0,
    path_create_directory: guard((dfd, p, pl) => (fs.mkdirSync(resolve(dfd, str(p, pl))), 0)),
    path_remove_directory: guard((dfd, p, pl) => (fs.rmdirSync(resolve(dfd, str(p, pl))), 0)),
    path_unlink_file: guard((dfd, p, pl) => (fs.unlinkSync(resolve(dfd, str(p, pl))), 0)),
    path_rename: guard((a, ap, al, b, bp, bl) => (fs.renameSync(resolve(a, str(ap, al)), resolve(b, str(bp, bl))), 0)),
    path_link: () => E.NOSYS, path_symlink: () => E.NOSYS, path_readlink: () => E.NOSYS,
    sock_accept: () => E.NOSYS, sock_recv: () => E.NOSYS, sock_send: () => E.NOSYS, sock_shutdown: () => E.NOSYS,
  };

  function threadSpawn(arg) {
    const t = Atomics.add(ctl, C_TID, 1);
    for (let s = 1; s < POOL; s++) {
      const i = C_POOL + 4 * s;
      if (Atomics.compareExchange(ctl, i, S_IDLE, S_CLAIM) === S_IDLE) {
        ctl[i + 1] = t; ctl[i + 2] = arg;
        Atomics.store(ctl, i, S_RUN); Atomics.notify(ctl, i);
        return t;
      }
    }
    fs.writeSync(2, `run-node: no pool worker for thread ${t} (at most ${POOL - 1})\n`);
    return -6;
  }
  Error.stackTraceLimit = 100;
  const host = {
    register: () => 0,
    // The WebGPU recorder's control block (runtime/gpu_web/webgpu_proto.h): no page here, so it
    // stays detached and the recorder drops its records.
    gpu_register: () => 0,
    input_register: () => {},   // no controllers here: every pad reads as connected with nothing pressed
    now_ms: () => T0 + performance.now(),
    blocked_ms: () => blockedMs,
  };
  const imports = { env: { memory }, wasi_snapshot_preview1: wasi, wasi: { 'thread-spawn': threadSpawn }, crashott: host };
  for (const im of WebAssembly.Module.imports(mod)) {
    const ns = (imports[im.module] ??= {});
    if (im.kind === 'function' && !(im.name in ns))
      ns[im.name] = (...a) => { fs.writeSync(2, `run-node: unimplemented import ${im.module}.${im.name}(${a.join(',')})\n`); return E.NOSYS; };
  }
  const ex = (await WebAssembly.instantiate(mod, imports)).exports;
  const { parentPort } = await import('node:worker_threads');
  const exit = code => { Atomics.store(ctl, C_CODE, code); Atomics.store(ctl, C_EXIT, 1); parentPort.postMessage({ t: 'exit', code }); };
  const i = C_POOL + 4 * slot;
  Atomics.store(ctl, i, S_IDLE);
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
      fs.writeSync(2, `\nrun-node: TRAP in thread ${tid}: ${x}\n${x?.stack ?? ''}\n`);
      exit(134); break;
    }
    Atomics.store(ctl, i, S_IDLE);
  }
}
