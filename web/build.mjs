// Bundles the page (TypeScript) with esbuild into web/dist: the page and the game-thread worker,
// index.html beside them (as GTA San Andreas web's web/build.mjs).
//   node web/build.mjs [--watch]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: { 'main': 'src/main.ts', 'host/worker': 'src/host/worker.ts', 'host/download-worker': 'src/host/download-worker.ts',
    'audio-worklet': 'src/audio-worklet.ts' },
  absWorkingDir: HERE, outdir: DIST, bundle: true, format: 'esm', target: ['chrome131'], sourcemap: true,
  minify: !watch, logLevel: 'info',
};
fs.mkdirSync(DIST, { recursive: true });
fs.copyFileSync(path.join(HERE, 'index.html'), path.join(DIST, 'index.html'));
if (watch) await (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
