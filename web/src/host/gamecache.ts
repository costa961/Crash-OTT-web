// The game files in the browser's storage (OPFS "game/"), downloaded once from the local server
// (download-worker.ts) and then read by the game-thread workers without the network (fs.ts).
// Only the files the game reads are kept: the executable, the common archives, the archive of the
// language picked on the start page and the shaders (the other languages' archives stay on the server). "game/.complete.json" lists the
// files fully written, with the size and mtime the server gave them: a file changed on the server
// is downloaded again.

export const CACHE_DIR = 'game';
export const COMPLETE = '.complete.json';
export const MANIFEST_URL = '/fs-manifest';

export interface GameFile { p: string; s: number; m: number }

/** The game's languages (crashott-pc's settings.cpp): id (its archive is <id>.rcf) and name. */
export const LANGUAGES: [string, string][] = [['english', 'English'], ['italian', 'Italiano'], ['french', 'Français'],
  ['german', 'Deutsch'], ['spanish', 'Español'], ['dutch', 'Nederlands']];

export function wantedFiles(files: GameFile[], language: string): GameFile[] {
  const archive = `${language.toLowerCase()}.rcf`;
  const common = /^(default\.xex|default\.rcf|sound\d\.rcf|shaders\/.+)$/i;
  return files.filter(f => common.test(f.p) || f.p.toLowerCase() === archive);
}

/** OPFS's file name for a game path (one flat folder: "/" -> "__") */
export const cacheName = (p: string) => p.toLowerCase().replace(/\//g, '__');

export async function cacheDir(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR, { create: true });
}

export async function readComplete(dir: FileSystemDirectoryHandle): Promise<Record<string, GameFile>> {
  try {
    const text = await (await (await dir.getFileHandle(COMPLETE)).getFile()).text();
    return JSON.parse(text) as Record<string, GameFile>;
  } catch {
    return {};
  }
}

export async function writeComplete(dir: FileSystemDirectoryHandle, complete: Record<string, GameFile>): Promise<void> {
  const h = await (await dir.getFileHandle(COMPLETE, { create: true })).createWritable();
  await h.write(JSON.stringify(complete));
  await h.close();
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

/** What is downloaded of what the server has: bytes, and whether all of it is. */
export async function cacheState(language: string): Promise<{ have: number; total: number; files: GameFile[] }> {
  const r = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`the list of game files did not load (HTTP ${r.status})`);
  const files = wantedFiles(((await r.json()) as { files: GameFile[] }).files, language);
  const complete = await readComplete(await cacheDir());
  let have = 0, total = 0;
  for (const f of files) {
    total += f.s;
    const c = complete[cacheName(f.p)];
    if (c && c.s === f.s && c.m === f.m) have += f.s;
  }
  return { have, total, files };
}
