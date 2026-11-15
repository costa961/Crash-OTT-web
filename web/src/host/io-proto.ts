// The game-thread workers' requests to the I/O worker (io-worker.ts) and their answers (fs.ts ioCall).
// A module of its own, with no side effect, so both bundles can import it.

export interface IoRequest {
  op: 'stat' | 'list' | 'read' | 'write' | 'truncate' | 'mkdir' | 'unlink' | 'rmdir' | 'rename';
  path: string; to?: string; pos?: number; addr?: number; len?: number; size?: number; reply: SharedArrayBuffer;
}

export const IO_OK = 0, IO_ENOENT = 1, IO_EEXIST = 2, IO_ENOTEMPTY = 3, IO_EIO = 4, IO_EACCES = 5;
/** A reply block: Int32Array [0] state (0 pending, 1 done), [1] result (IO_*), [2] value (bytes, or the
 *  JSON's length), then from IO_TEXT_AT the JSON answer of a stat or a list. */
export const IO_REPLY_BYTES = 16 + 256 * 1024, IO_TEXT_AT = 16;
