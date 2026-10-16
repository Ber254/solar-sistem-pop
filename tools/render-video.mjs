#!/usr/bin/env node
// Exportador a vídeo: carga el HTML TAL CUAL con Playwright + un reloj virtual inyectado (addInitScript),
// avanza la simulación en pasos de 1/fps y envía cada fotograma a ffmpeg por stdin (sin PNG en disco).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, TOOLS, die, parseArgs, hasBin, loadPlaywright, launchArgs } from './lib/common.mjs';

const USAGE = `Uso: node tools/render-video.mjs [opciones]
  --width <px>      ancho (1920)            --height <px>   alto (1080)
  --fps <n>         fotogramas/s (30)       --duration <s>  duración en s (1200)
  --seed <n>        semilla del azar (1)    --crf <n>       calidad (h264:18, hevc:22, vp9:30)
  --format <f>      h264 (mp4, por defecto) | hevc (mp4 H.265) | vp9 (webm)
  --out <fichero>   salida (dist/video/sistema-solar.<ext>)
  --resume          continúa un render interrumpido (mismos parámetros)
  --src <html>      HTML de origen (index.html)
  --capture <m>     canvas (por defecto; sin interfaz) | page (toda la página, con HUD)
  --fade <s>        fundido a negro al inicio y al final (2; 0 = sin fundido)
  --no-autopilot    sin autopiloto de cámara
  --segment <s>     duración de cada tramo codificado (60); permite --resume
  --frame-hashes <fichero>   guarda el SHA-256 de cada fotograma capturado (comprobar reproducibilidad)
  --lib <fichero>   three.min.js local (por defecto el de dist/wallpaper/libs o tools/.cache)`;
const A = parseArgs(process.argv.slice(2), {
  width: { def: 1920, type: 'number' }, height: { def: 1080, type: 'number' }, fps: { def: 30, type: 'number' }, duration: { def: 1200, type: 'number' },
  seed: { def: 1, type: 'number' }, crf: { def: null, type: 'number' }, format: { def: 'h264', type: 'string' }, out: { def: null, type: 'string' },
  resume: { def: false, type: 'boolean' }, src: { def: 'index.html', type: 'string' }, capture: { def: 'canvas', type: 'string' },
  fade: { def: 2, type: 'number' }, autopilot: { def: true, type: 'boolean' }, segment: { def: 60, type: 'number' },
  'frame-hashes': { def: null, type: 'string' }, lib: { def: null, type: 'string' },
}, USAGE);

/* ---- formatos ---- */
const FORMATS = {
  h264: { ext: 'mp4', enc: 'libx264', args: crf => ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf ?? 18), '-pix_fmt', 'yuv420p'] },
  hevc: { ext: 'mp4', enc: 'libx265', args: crf => ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf ?? 22), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'] },
  vp9: { ext: 'webm', enc: 'libvpx-vp9', args: crf => ['-c:v', 'libvpx-vp9', '-crf', String(crf ?? 30), '-b:v', '0', '-pix_fmt', 'yuv420p', '-row-mt', '1'] },
};
const ALIAS = { mp4: 'h264', 'mp4-h264': 'h264', 'mp4-hevc': 'hevc', h265: 'hevc', webm: 'vp9', 'webm-vp9': 'vp9' };
const fmtKey = ALIAS[A.format] || A.format, F = FORMATS[fmtKey];
if (!F) die(`Formato desconocido: ${A.format}. Usa h264, hevc o vp9.\n\n${USAGE}`);
if (!['canvas', 'page'].includes(A.capture)) die('--capture debe ser canvas o page');

/* ---- dependencias: se comprueban ANTES de hacer nada; no se instala nada ---- */
if (!hasBin('ffmpeg')) die(`ffmpeg no está instalado (o no está en el PATH). Este script NO instala nada por sí mismo.
Instálalo tú y vuelve a ejecutar:
  Windows:  winget install Gyan.FFmpeg      (o https://www.gyan.dev/ffmpeg/builds/)
  macOS:    brew install ffmpeg
  Linux:    sudo apt install ffmpeg         (o el gestor de tu distribución)`, 2);
const enc = spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout?.toString() || '';
if (!enc.includes(F.enc)) die(`Tu ffmpeg no incluye el codificador ${F.enc} necesario para --format ${fmtKey}. Instala una build completa de ffmpeg o elige otro formato.`, 2);
const pw = await loadPlaywright();

/* ---- parámetros derivados ---- */
const W = Math.round(A.width / 2) * 2, H = Math.round(A.height / 2) * 2;       // yuv420p exige dimensiones pares
const fps = A.fps, dtMs = 1000 / fps, total = Math.round(A.duration * fps);
if (total < 1) die('--duration demasiado corta');
const out = path.resolve(ROOT, A.out || `dist/video/sistema-solar.${F.ext}`);
if (path.extname(out).slice(1) !== F.ext) die(`La extensión de --out debe ser .${F.ext} para --format ${fmtKey}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const stem = path.basename(out, path.extname(out)), partsDir = path.join(path.dirname(out), `.${stem}.parts`), progPath = path.join(path.dirname(out), `.${stem}.progress.json`);
const srcPath = path.resolve(ROOT, A.src); if (!fs.existsSync(srcPath)) die(`No existe ${srcPath}`);
const segFrames = Math.max(1, Math.round(A.segment * fps)), nSeg = Math.ceil(total / segFrames), fadeFrames = Math.round(A.fade * fps);
const srcHash = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex').slice(0, 16);
const sig = crypto.createHash('sha256').update(JSON.stringify({ W, H, fps, total, seed: A.seed, fmtKey, crf: A.crf, capture: A.capture, autopilot: A.autopilot, fadeFrames, segFrames, srcHash })).digest('hex');

let startSeg = 0;
if (A.resume && fs.existsSync(progPath)) {
  const p = JSON.parse(fs.readFileSync(progPath, 'utf8'));
  if (p.sig !== sig) die('--resume: los parámetros (o el HTML) han cambiado desde el render interrumpido. Usa los mismos o borra el render anterior.');
  startSeg = p.done; for (let i = 0; i < startSeg; i++) if (!fs.existsSync(path.join(partsDir, `part_${String(i).padStart(4, '0')}.${F.ext}`))) { startSeg = i; break; }
  console.log(`Reanudando: ${startSeg}/${nSeg} tramos ya codificados.`);
} else { fs.rmSync(partsDir, { recursive: true, force: true }); fs.rmSync(progPath, { force: true }); }
fs.mkdirSync(partsDir, { recursive: true });

/* ---- navegador con reloj virtual ---- */
const libCands = [A.lib, path.join(ROOT, 'dist/wallpaper/libs/three.min.js'), path.join(TOOLS, '.cache/three.min.js')].filter(Boolean);
const libFile = libCands.find(f => fs.existsSync(f));
const browser = await pw.chromium.launch({ args: launchArgs() });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', e => console.error('[página] error:', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('[página] consola:', m.text()); });
if (libFile) await page.route(/three(\.min)?\.js(\?.*)?$/, r => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(libFile) }));
else console.warn('AVISO: no hay copia local de three.min.js; se usará la CDN (hace falta internet). Ejecuta antes build-wallpaper.mjs o usa --lib.');
const read = f => fs.readFileSync(path.join(TOOLS, 'inject', f), 'utf8');
await page.addInitScript({ content: `window.__VSEED=${A.seed >>> 0};window.__WP_CFG=${JSON.stringify({ autopilot: A.autopilot })};\n${read('virtual-clock.js')}\n${read('autopilot.js')}` });
await page.goto(pathToFileURL(srcPath).href);
await page.waitForFunction(() => window.__solar && window.__vclock, null, { timeout: 60000 });
const dim = await page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height]; });
if (dim[0] !== W || dim[1] !== H) die(`El canvas mide ${dim[0]}x${dim[1]} y se pidió ${W}x${H}. (devicePixelRatio ≠ 1 o la página limita el tamaño.)`);

/* ---- avance rápido de los tramos ya codificados (misma secuencia de pasos, sin capturar) ---- */
if (startSeg > 0) {
  let left = startSeg * segFrames; const t0 = Date.now();
  while (left > 0) { const n = Math.min(left, 120); await page.evaluate(([n, d]) => window.__vclock.run(n, d), [n, dtMs]); left -= n; process.stdout.write(`\rReproduciendo hasta el punto de reanudación… ${(100 * (1 - left / (startSeg * segFrames))).toFixed(0)} %`); }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

/* ---- render por tramos → ffmpeg por stdin ---- */
const hashes = A['frame-hashes'] && startSeg === 0 ? [] : null;
if (A['frame-hashes'] && startSeg > 0) console.warn('AVISO: con --resume no se guardan los hashes de los tramos anteriores.');
async function capture() {
  if (A.capture === 'canvas') { const r = await page.evaluate(d => window.__vclock.stepAndCapture(d, 'image/png'), dtMs); return Buffer.from(r.url.slice(r.url.indexOf(',') + 1), 'base64'); }
  await page.evaluate(d => window.__vclock.step(d), dtMs);
  await page.evaluate(() => new Promise(res => window.__vclock.nativeRaf(() => res())));
  return await page.screenshot({ type: 'png' });
}
let current = null, interrupted = false;
process.on('SIGINT', () => { interrupted = true; console.log('\nInterrumpido. Vuelve a ejecutar el mismo comando con --resume para continuar.'); try { current?.kill('SIGKILL'); } catch (e) {} browser.close().finally(() => process.exit(130)); });

const startTime = Date.now(); let captured = 0; const startFrame = startSeg * segFrames;
const fmtT = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ' h ' : '') + (h || m ? String(m).padStart(h ? 2 : 1, '0') + ' min ' : '') + (s % 60) + ' s'; };
let lastPrint = 0;
for (let seg = startSeg; seg < nSeg; seg++) {
  const n = Math.min(segFrames, total - seg * segFrames), partTmp = path.join(partsDir, `part_${String(seg).padStart(4, '0')}.tmp.${F.ext}`), part = path.join(partsDir, `part_${String(seg).padStart(4, '0')}.${F.ext}`);
  const filters = [];
  if (fadeFrames > 0) {            // fundido a negro: entrada en el primer tramo y salida en el último
    if (seg === 0) filters.push(`fade=in:0:${Math.min(fadeFrames, n)}`);
    if (seg === nSeg - 1) filters.push(`fade=out:${Math.max(0, n - fadeFrames)}:${Math.min(fadeFrames, n)}`);
  }
  const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    ...(filters.length ? ['-vf', filters.join(',')] : []), ...F.args(A.crf), '-g', String(fps * 2), '-r', String(fps), '-an', ...(F.ext === 'mp4' ? ['-movflags', '+faststart'] : []), partTmp], { stdio: ['pipe', 'inherit', 'inherit'] });
  current = ff; const done = new Promise(res => ff.on('close', c => res(c))); ff.stdin.on('error', () => {});
  for (let i = 0; i < n; i++) {
    const png = await capture();
    if (hashes) hashes.push(crypto.createHash('sha256').update(png).digest('hex'));
    if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
    captured++;
    const now = Date.now();
    if (now - lastPrint > 1000 || (seg === nSeg - 1 && i === n - 1)) {
      lastPrint = now; const f = startFrame + captured, rate = captured / ((now - startTime) / 1000), eta = (total - f) / rate;
      process.stdout.write(`\r[${(100 * f / total).toFixed(1).padStart(5)} %] fotograma ${f}/${total} · ${rate.toFixed(1)} fps de render · quedan ~${fmtT(eta)}   `);
    }
  }
  ff.stdin.end(); const code = await done;
  if (code !== 0) die(`ffmpeg terminó con código ${code} en el tramo ${seg}.`);
  fs.renameSync(partTmp, part);
  fs.writeFileSync(progPath, JSON.stringify({ sig, done: seg + 1, nSeg, total }) + '\n');
}
console.log();
await browser.close();
if (hashes) fs.writeFileSync(path.resolve(ROOT, A['frame-hashes']), JSON.stringify(hashes));

/* ---- unir los tramos (sin recodificar) ---- */
const list = path.join(partsDir, 'list.txt');
fs.writeFileSync(list, Array.from({ length: nSeg }, (_, i) => `file 'part_${String(i).padStart(4, '0')}.${F.ext}'`).join('\n') + '\n');
const cat = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(F.ext === 'mp4' ? ['-movflags', '+faststart'] : []), out], { stdio: 'inherit' });
if (cat.status !== 0) die('ffmpeg no pudo unir los tramos.');
fs.rmSync(partsDir, { recursive: true, force: true }); fs.rmSync(progPath, { force: true });
console.log(`Listo: ${path.relative(ROOT, out)}  (${W}x${H}, ${fps} fps, ${A.duration} s, ${fmtKey}, semilla ${A.seed})`);
