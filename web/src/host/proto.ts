// The page <-> game-thread worker contract (worker.ts), the same layout as tools/run-node.mjs.

/** Guest threads plus guest fibers (runtime/platform_wasm.cpp: a fiber is a thread). */
export const POOL = 48;
/** ctl (Int32Array): [0] next tid, [1] exit flag, [2] exit code, [3] unused, then 4 per pool slot: state, tid, arg */
export const C_TID = 0, C_EXIT = 1, C_CODE = 2, C_POOL = 4;
export const C_INTS = C_POOL + 4 * POOL;
export const S_NONE = 0, S_CLAIM = 1, S_RUN = 2, S_IDLE = 3, S_MAIN = 4;
/** fd table: FD_MAX entries of FD_SZ bytes: i32 kind, i32 unused, f64 position, i32 append, path (UTF-8, NUL ended) */
export const FD_MAX = 1024, FD_SZ = 1024, FD_PATH = 24;
export const K_FREE = 0, K_FILE = 1, K_DIR = 2, K_BUSY = -1;
/** WASI preopens, fds 3 and 4: the server's roots (tools/serve.mjs) */
export const PREOPENS = ['game', 'userdata'];
/** Linear memory: 1 GB at start (the runtime's part), up to 4 GB (guest address == linear address). */
export const INITIAL_PAGES = 16384, MAX_PAGES = 65536;

export interface BootConfig { args: string[]; env: Record<string, string>; }

export interface WorkerInit {
  mod: WebAssembly.Module;
  memory: WebAssembly.Memory;
  ctl: SharedArrayBuffer;
  fdt: SharedArrayBuffer;
  slot: number;
  cfg: BootConfig;
}

export type ToPage =
  | { t: 'ready'; slot: number }
  | { t: 'log'; line: string; tid: number }
  | { t: 'gpu'; ctl: number }
  | { t: 'input'; block: number }
  | { t: 'trap'; tid: number; message: string; stack: string }
  | { t: 'exit'; code: number };
