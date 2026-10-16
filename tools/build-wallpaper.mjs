#!/usr/bin/env node
// Genera dist/wallpaper/ (copia modificada del HTML + libs locales + wallpaper.js + metadatos de Lively)
// y dist/SistemaSolarPop.zip. NUNCA escribe en el HTML original ni en ningún archivo existente.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, TOOLS, die, parseArgs, hasBin, loadPlaywright, launchArgs, download, untgzFile, makeZip, walk } from './lib/common.mjs';

const USAGE = `Uso: node tools/build-wallpaper.mjs [opciones]
  --src <html>     HTML de origen (por defecto index.html)
  --out <dir>      carpeta de salida (por defecto dist)
  --no-images      no generar thumbnail/preview con Playwright
  --fps <n>        FPS por defecto del paquete (15-60, por defecto 30)
  --dpr <n>        tope de devicePixelRatio por defecto (por defecto 1.5)
  --no-autopilot   autopiloto desactivado por defecto
  --show-ui        interfaz visible por defecto`;
const A = parseArgs(process.argv.slice(2), {
  src: { def: 'index.html', type: 'string' }, out: { def: 'dist', type: 'string' },
  images: { def: true, type: 'boolean' }, fps: { def: 30, type: 'number' }, dpr: { def: 1.5, type: 'number' },
  autopilot: { def: true, type: 'boolean' }, 'show-ui': { def: false, type: 'boolean' },
}, USAGE);

const srcPath = path.resolve(ROOT, A.src);
if (!fs.existsSync(srcPath)) die(`No existe el HTML de origen: ${srcPath}`);
const outRoot = path.resolve(ROOT, A.out), wpDir = path.join(outRoot, 'wallpaper'), libDir = path.join(wpDir, 'libs');
if (wpDir === path.dirname(srcPath) || srcPath.startsWith(wpDir + path.sep)) die('La salida no puede contener al HTML original.');
fs.rmSync(wpDir, { recursive: true, force: true }); fs.mkdirSync(libDir, { recursive: true });
const cacheDir = path.join(TOOLS, '.cache'); fs.mkdirSync(cacheDir, { recursive: true });

let html = fs.readFileSync(srcPath, 'utf8');
console.log(`Origen: ${path.relative(ROOT, srcPath)} (solo lectura)`);

/* ---- 1. Dependencias externas (CDN) → libs/ locales, reescritas SOLO en la copia ---- */
const extRe = /(<script\b[^>]*?\bsrc\s*=\s*["']|<link\b[^>]*?\bhref\s*=\s*["'])(https?:\/\/[^"']+)(["'])/gi;
const externals = [...new Set([...html.matchAll(extRe)].map(m => m[2]))];
async function fetchLib(url) {
  const base = path.basename(new URL(url).pathname), cached = path.join(cacheDir, base);
  if (fs.existsSync(cached)) { console.log(`  · ${base}: caché (tools/.cache)`); return fs.readFileSync(cached); }
  const tries = [url];
  const m = url.match(/\/ajax\/libs\/([^/]+)\/([^/]+)\/(.+)$/);                // cdnjs: /ajax/libs/<lib>/<ver>/<fichero>
  let npmTarball = null;
  if (m) {
    const npmName = m[1] === 'three.js' ? 'three' : m[1], ver = m[1] === 'three.js' && /^r\d+$/.test(m[2]) ? `0.${m[2].slice(1)}.0` : m[2];
    const file = m[1] === 'three.js' ? `build/${m[3]}` : m[3];
    tries.push(`https://cdn.jsdelivr.net/npm/${npmName}@${ver}/${file}`, `https://unpkg.com/${npmName}@${ver}/${file}`);
    npmTarball = { url: `https://registry.npmjs.org/${npmName}/-/${npmName}-${ver}.tgz`, file: `package/${file}` };
  }
  for (const u of tries) { try { const b = await download(u); console.log(`  · ${base}: descargado de ${new URL(u).host}`); fs.writeFileSync(cached, b); return b; } catch (e) { console.log(`  · ${new URL(u).host} no disponible`); } }
  if (npmTarball) { try { const b = untgzFile(await download(npmTarball.url), npmTarball.file); if (b) { console.log(`  · ${base}: extraído del paquete npm (mismo archivo de la versión publicada)`); fs.writeFileSync(cached, b); return b; } } catch (e) { /* abajo */ } }
  die(`No pude descargar ${url}.\nDescárgalo a mano y guárdalo como tools/.cache/${base}; el build lo usará.`);
}
const libMap = {};
if (externals.length) console.log(`Dependencias externas detectadas: ${externals.length}`);
for (const url of externals) {
  const base = path.basename(new URL(url).pathname); let name = base, n = 1;
  while (Object.values(libMap).includes(name)) name = `${n++}_${base}`;
  fs.writeFileSync(path.join(libDir, name), await fetchLib(url)); libMap[url] = name;
  html = html.split(url).join(`libs/${name}`);
}
const leftover = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
if (leftover.length) console.warn('AVISO: quedan URLs externas (no scripts/hojas de estilo): ' + leftover.join(', '));

/* ---- 2. Interfaz: elementos raíz del <body> que no son canvas ni script ---- */
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || '';
const uiSelectors = [...body.matchAll(/<(div|aside|nav|header|footer|section|button)\b[^>]*\bid\s*=\s*["']([\w-]+)["']/gi)]
  .filter(m => { // solo los de primer nivel (no anidados): se mira la indentación 0 de la etiqueta de apertura
    const idx = m.index; return idx === 0 || body[idx - 1] === '\n';
  }).map(m => '#' + m[2]);

/* ---- 3. wallpaper.js = configuración + autopilot.js + wallpaper.js; se enlaza antes de cualquier otro script ---- */
const cfg = { fps: Math.max(15, Math.min(60, A.fps)), dprMax: A.dpr, autopilot: A.autopilot, showUI: A['show-ui'], uiSelectors };
const inj = fs.readFileSync(path.join(TOOLS, 'inject/autopilot.js'), 'utf8'), wp = fs.readFileSync(path.join(TOOLS, 'inject/wallpaper.js'), 'utf8');
fs.writeFileSync(path.join(wpDir, 'wallpaper.js'),
  `/* Generado por tools/build-wallpaper.mjs a partir de tools/inject/{autopilot,wallpaper}.js — no editar aquí. */\n(function (d) { var c = window.__WP_CFG = window.__WP_CFG || {}; for (var k in d) if (!(k in c)) c[k] = d[k]; })(${JSON.stringify(cfg)});\n${inj}\n${wp}\n`);
if (!/<head[^>]*>/i.test(html)) die('El HTML no tiene <head>; no puedo inyectar wallpaper.js antes de otros scripts.');
const tag = '\n<script src="wallpaper.js"></script>';   // primer script del documento (tras el <meta charset>, que debe ir al principio)
html = /<meta[^>]*charset[^>]*>/i.test(html) && html.search(/<meta[^>]*charset[^>]*>/i) < html.search(/<script\b/i)
  ? html.replace(/<meta[^>]*charset[^>]*>/i, m => m + tag) : html.replace(/<head[^>]*>/i, m => m + tag);
fs.writeFileSync(path.join(wpDir, 'index.html'), html);

/* ---- 4. Metadatos de Lively (plantillas en wallpaper/) ---- */
for (const f of ['LivelyInfo.json', 'LivelyProperties.json']) fs.copyFileSync(path.join(ROOT, 'wallpaper', f), path.join(wpDir, f));
const props = JSON.parse(fs.readFileSync(path.join(wpDir, 'LivelyProperties.json'), 'utf8'));   // los valores por defecto del build mandan
props.fps.value = cfg.fps; props.autopilot.value = cfg.autopilot; props.showUI.value = cfg.showUI;
props.quality.value = Math.max(0, [0.75, 1, 1.5, 2].findIndex(v => v >= cfg.dprMax));
fs.writeFileSync(path.join(wpDir, 'LivelyProperties.json'), JSON.stringify(props, null, 2) + '\n');

/* ---- 5. thumbnail y preview con Playwright ---- */
async function makeImages() {
  const pw = await loadPlaywright(), browser = await pw.chromium.launch({ args: launchArgs() });
  const external = [];
  const open = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 }), page = await ctx.newPage();
    await page.route('**/*', r => { const u = r.request().url(); if (/^(file|data|blob):/.test(u)) r.continue(); else { external.push(u); r.abort(); } });
    await page.goto(pathToFileURL(path.join(wpDir, 'index.html')).href);
    await page.waitForFunction(() => window.__solar, null, { timeout: 30000 });
    await page.evaluate(() => window.livelyPropertyListener('speed', 4));   // más movimiento en las capturas
    return { page, ctx };
  };
  let t = await open(800, 450); await t.page.waitForTimeout(3500);
  fs.writeFileSync(path.join(wpDir, 'thumbnail.jpg'), await t.page.screenshot({ type: 'jpeg', quality: 88 })); await t.ctx.close();
  const p = await open(480, 270); await p.page.waitForTimeout(2500);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-prev-')), N = 36;
  for (let i = 0; i < N; i++) { fs.writeFileSync(path.join(tmp, `f${String(i).padStart(3, '0')}.jpg`), await p.page.screenshot({ type: 'jpeg', quality: 80 })); await p.page.waitForTimeout(250); }
  await p.ctx.close(); await browser.close();
  fs.copyFileSync(path.join(tmp, `f${String(N >> 1).padStart(3, '0')}.jpg`), path.join(wpDir, 'preview.jpg'));
  if (hasBin('ffmpeg')) {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '8', '-i', path.join(tmp, 'f%03d.jpg'), '-filter_complex', '[0:v]split[a][b];[b]palettegen=max_colors=96[p];[a][p]paletteuse=dither=bayer', path.join(wpDir, 'preview.gif')]);
    if (r.status !== 0) console.warn('AVISO: ffmpeg no pudo crear preview.gif; se usa preview.jpg');
  } else console.warn('AVISO: ffmpeg no está instalado → solo preview.jpg (sin GIF).');
  fs.rmSync(tmp, { recursive: true, force: true });
  if (external.length) die('La copia intentó hacer peticiones externas:\n' + external.join('\n'));
}
if (A.images) await makeImages(); else console.log('Imágenes omitidas (--no-images).');
const info = JSON.parse(fs.readFileSync(path.join(wpDir, 'LivelyInfo.json'), 'utf8'));
if (!fs.existsSync(path.join(wpDir, 'thumbnail.jpg'))) delete info.Thumbnail;
if (!fs.existsSync(path.join(wpDir, 'preview.gif'))) { if (fs.existsSync(path.join(wpDir, 'preview.jpg'))) info.Preview = 'preview.jpg'; else delete info.Preview; }
fs.writeFileSync(path.join(wpDir, 'LivelyInfo.json'), JSON.stringify(info, null, 2) + '\n');

/* ---- 6. ZIP listo para arrastrar a Lively (los ficheros van en la raíz del zip) ---- */
const zipPath = path.join(outRoot, 'SistemaSolarPop.zip'), entries = walk(wpDir);
fs.writeFileSync(zipPath, makeZip(entries));
console.log(`\nListo:\n  ${path.relative(ROOT, wpDir)}/   (${entries.length} ficheros)\n  ${path.relative(ROOT, zipPath)}   (${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB)`);
