// Opens the page in headless Chrome (WebGPU on SwiftShader), presses Start, and saves screenshots
// and the console log: a look at the game without a screen. Adapted from GTA San Andreas web's
// tools/shot.mjs (same author); runs in its browser image (Playwright's Chromium), with the server
// (tools/serve.mjs) reachable at --url.
//   node tools/shot.mjs --url http://crashott-serve:8080/ --out out/shots --at 20,40,60
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(process.env.NODE_PATH + '/')('playwright');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const url = opt('--url', 'http://crashott-serve:8080/'), out = opt('--out', 'out/shots');
const at = opt('--at', '30').split(',').map(Number), query = opt('--q', '');
fs.mkdirSync(out, { recursive: true });
const logFile = fs.createWriteStream(path.join(out, 'console.log'));
const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=vulkan', `--unsafely-treat-insecure-origin-as-secure=${new URL(url).origin}`,
  '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader',
  '--disable-vulkan-surface', '--ignore-gpu-blocklist', ...(process.env.CHROME_LOG ? ['--enable-logging=stderr', '--v=0'] : [])] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', m => logFile.write(m.text() + '\n'));
page.on('pageerror', e => logFile.write(`PAGEERROR ${e.stack ?? e}\n`));
// SwiftShader can't allocate a WebGPU canvas swap chain here: the page draws offscreen and shows
// the frames through a 2D canvas (web/src/gpu/executor.ts, ?offscreen=1)
await page.goto(`${url}?offscreen=1${query ? `&${query}` : ''}`);
console.log('webgpu adapter:', await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  return a ? JSON.stringify({ vendor: a.info?.vendor, arch: a.info?.architecture, features: [...a.features].join(' ') }) : 'none';
}));
await page.click('#play');
const t0 = Date.now();
for (const s of at) {
  await new Promise(r => setTimeout(r, Math.max(0, s * 1000 - (Date.now() - t0))));
  const f = path.join(out, `t${s}.png`);
  await page.screenshot({ path: f });
  console.log(`screenshot ${f}: ${await page.evaluate(() => document.getElementById('status')?.textContent ?? '')}`);
}
await browser.close();
logFile.end();
