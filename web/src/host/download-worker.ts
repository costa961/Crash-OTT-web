// The download worker: the game files the game reads (gamecache.ts) from the local server into the
// browser's storage, ahead of play, so the game reads them locally (as nfsu2-web-coop-edition's and
// GTA San Andreas web's predownload). Streamed into a sync access handle; a file is listed in
// .complete.json once all of it is written, so a stopped download goes on with the files left.
//
// Page -> worker: { t: 'start' } | { t: 'stop' }
// Worker -> page: { t: 'progress', have, total, file } (at most every 250 ms) | { t: 'done', have, total }
//                 | { t: 'stopped' } | { t: 'error', msg }
import { cacheDir, cacheName, readComplete, writeComplete, MANIFEST_URL, wantedFiles, type GameFile } from './gamecache';

export type ToDownload = { t: 'start'; language: string } | { t: 'stop' };
export type FromDownload =
  | { t: 'progress'; have: number; total: number; file: string }
  | { t: 'done'; have: number; total: number }
  | { t: 'stopped' } | { t: 'error'; msg: string };

const post = (m: FromDownload) => (self as unknown as Worker).postMessage(m);
let abort: AbortController | null = null;

async function download(language: string) {
  abort = new AbortController();
  const r = await fetch(MANIFEST_URL, { cache: 'no-cache', signal: abort.signal });
  if (!r.ok) throw new Error(`the list of game files did not load (HTTP ${r.status})`);
  const files = wantedFiles(((await r.json()) as { files: GameFile[] }).files, language);
  const dir = await cacheDir();
  const complete = await readComplete(dir);
  const total = files.reduce((a, f) => a + f.s, 0);
  let have = 0;
  const todo: GameFile[] = [];
  for (const f of files) {
    const c = complete[cacheName(f.p)];
    if (c && c.s === f.s && c.m === f.m) have += f.s;
    else todo.push(f);
  }
  // biggest last: the small files are ready soonest
  todo.sort((a, b) => a.s - b.s);
  let shown = 0;
  const progress = (file: string, now = false) => {
    const t = performance.now();
    if (now || t - shown >= 250) { shown = t; post({ t: 'progress', have, total, file }); }
  };
  progress('', true);
  for (const f of todo) {
    const name = cacheName(f.p);
    delete complete[name];
    await writeComplete(dir, complete);
    const fh = await dir.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    try {
      h.truncate(0);
      const res = await fetch(`/fs/game/${f.p.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store', signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`${f.p}: HTTP ${res.status}`);
      const reader = res.body.getReader();
      let at = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        h.write(value, { at });
        at += value.length;
        have += value.length;
        progress(f.p);
      }
      if (at !== f.s) throw new Error(`${f.p}: ${at} bytes of ${f.s}`);
      h.flush();
    } finally {
      h.close();
    }
    complete[name] = f;
    await writeComplete(dir, complete);
  }
  post({ t: 'done', have, total });
}

self.onmessage = (ev: MessageEvent<ToDownload>) => {
  if (ev.data.t === 'stop') { abort?.abort(); return; }
  download(ev.data.language).catch(e => {
    if (abort?.signal.aborted) post({ t: 'stopped' });
    else post({ t: 'error', msg: String((e as Error)?.message ?? e) });
  });
};
