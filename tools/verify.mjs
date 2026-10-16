#!/usr/bin/env node
// Verificación del paquete y del exportador (7 comprobaciones). Requiere haber ejecutado build-wallpaper.mjs.
//   node tools/verify.mjs [--skip-video]
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, TOOLS, loadPlaywright, launchArgs } from './lib/common.mjs';

const skipVideo = process.argv.includes('--skip-video');
const SRC = path.join(ROOT, 'index.html'), DIST = path.join(ROOT, 'dist/wallpaper/index.html'), LIB = path.join(ROOT, 'dist/wallpaper/libs/three.min.js');
const results = []; const ok = (n, pass, detail) => { results.push({ n, pass }); console.log(`${pass ? '✔' : '✘'} ${n}\n    ${detail}`); };
const git = a => execSync('git ' + a, { cwd: ROOT }).toString();
const pw = await loadPlaywright(), lib = fs.readFileSync(LIB);
const browser = await pw.chromium.launch({ args: launchArgs() });
const newPage = async (opts = {}) => { const ctx = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1, ...opts }); const p = await ctx.newPage(); return { ctx, p }; };

/* (1) archivos previos intactos */
{
  const st = git('status --porcelain=v1 -uall').split('\n').filter(Boolean);
  const bad = st.filter(l => !(l.startsWith('?? ') && /^(tools|wallpaper)\//.test(l.slice(3))));
  const tracked = git('ls-files').split('\n').filter(Boolean);
  const changed = git('diff HEAD --name-status').split('\n').filter(Boolean);       // cambios (staged o no) en archivos versionados
  const idx = ['index.html'].filter(f => git(`hash-object ${f}`).trim() !== git(`rev-parse HEAD:${f}`).trim());
  ok('1. git status: archivos previos intactos', bad.length === 0 && changed.length === 0 && idx.length === 0,
    `${tracked.length} archivos versionados: git diff HEAD → ${changed.length} cambios; hash de index.html (raíz) y index.html distinto de HEAD: ${idx.length}; entradas de git status fuera de tools/ y wallpaper/: ${bad.length} ${bad.length ? JSON.stringify(bad) : ''} (dist/ está en .gitignore)`);
}

/* (2) copia en dist/: sin errores y sin internet; (6) interfaz oculta */
{
  const { ctx, p } = await newPage(), errs = [], reqs = [];
  p.on('console', m => { if (['error', 'warning'].includes(m.type())) errs.push(m.text()); }); p.on('pageerror', e => errs.push('pageerror ' + e.message));
  p.on('request', r => reqs.push(r.url()));
  await p.goto(pathToFileURL(DIST).href); await p.waitForFunction(() => window.__solar, null, { timeout: 30000 }); await p.waitForTimeout(3000);
  const nonLocal = reqs.filter(u => !/^(file|data|blob):/.test(u));
  ok('2. dist/ sin errores de consola y sin peticiones a internet', errs.length === 0 && nonLocal.length === 0, `${reqs.length} peticiones (todas file:/data:/blob:), externas: ${nonLocal.length}, errores/avisos de consola: ${errs.length} ${errs.join(' | ')}`);
  const vis = await p.evaluate(() => ['#hud', '#fleet', '#hint', '#tip'].map(s => [s, getComputedStyle(document.querySelector(s)).display]));
  const hidden = vis.every(v => v[1] === 'none');
  await p.evaluate(() => window.livelyPropertyListener('showUI', true)); await p.waitForTimeout(200);
  const shown = await p.evaluate(() => getComputedStyle(document.querySelector('#hud')).display !== 'none' && getComputedStyle(document.querySelector('#fleet')).display !== 'none');
  await p.evaluate(() => window.livelyPropertyListener('showUI', false));
  const again = await p.evaluate(() => getComputedStyle(document.querySelector('#hud')).display === 'none');
  ok('6. interfaz oculta en la copia (y opción para mostrarla)', hidden && shown && again, `display: ${vis.map(v => v.join('=')).join(', ')}; showUI=true → visible: ${shown}; showUI=false → oculta: ${again}`);
  await ctx.close();
}

/* (3) reloj virtual: la Tierra da una vuelta en 60 s virtuales exactos (HTML ORIGINAL, sin tocarlo) */
{
  const { ctx, p } = await newPage();
  await p.route(/three\.min\.js/, r => r.fulfill({ contentType: 'application/javascript', body: lib }));
  await p.addInitScript({ content: 'window.__VSEED=1;\n' + fs.readFileSync(path.join(TOOLS, 'inject/virtual-clock.js'), 'utf8') });
  await p.goto(pathToFileURL(SRC).href); await p.waitForFunction(() => window.__solar && window.__vclock);
  const r = await p.evaluate(() => { window.__vclock.step(1000 / 30); const a0 = window.__solar.earthAngle(), t0 = window.__vclock.now(); window.__vclock.run(1800, 1000 / 30); return { dA: window.__solar.earthAngle() - a0, dT: window.__vclock.now() - t0 }; });
  const err = Math.abs(r.dA - 2 * Math.PI);
  ok('3. reloj virtual: una vuelta de la Tierra = 60 s virtuales exactos', err < 1e-9 && Math.abs(r.dT - 60000) < 1e-6, `1800 pasos de 1/30 s → Δt virtual = ${r.dT.toFixed(6)} ms, Δángulo = ${r.dA.toFixed(12)} rad (2π = ${(2 * Math.PI).toFixed(12)}), error = ${err.toExponential(2)} rad`);
  await ctx.close();
}

/* (5) el limitador de FPS no cambia la velocidad de la simulación; + visibilidad y DPR */
{
  const measure = async (fps, direct) => {
    const { ctx, p } = await newPage(); await p.goto(pathToFileURL(DIST).href); await p.waitForFunction(() => window.__solar);
    await p.evaluate(([f, d]) => { if (d) window.__WP_CFG.fps = f; else window.livelyPropertyListener('fps', f); window.livelyPropertyListener('autopilot', false); }, [fps, direct]); await p.waitForTimeout(1500);
    const r = await p.evaluate(() => new Promise(res => { const a0 = window.__solar.earthAngle(), t0 = performance.now(), d0 = window.__WP.stats().delivered; setTimeout(() => res({ dA: window.__solar.earthAngle() - a0, secs: (performance.now() - t0) / 1000, fr: window.__WP.stats().delivered - d0 }), 10000); }));
    await ctx.close(); return { fps, radPerSec: r.dA / r.secs, realFps: r.fr / r.secs };
  };
  // límites por debajo de lo que rinde el equipo (WebGL por software en el CI): 6 y 12 FPS fijados en CFG, y 15 por la propiedad de Lively
  const lim = [await measure(6, true), await measure(12, true), await measure(15, false)], expected = 2 * Math.PI / 60;
  ok('5. limitador de FPS no cambia la velocidad de la simulación', lim.every(x => Math.abs(x.radPerSec / expected - 1) < 0.03 && Math.abs(x.realFps / x.fps - 1) < 0.1),
    lim.map(x => `límite ${x.fps} → ${x.realFps.toFixed(1)} fotogramas/s reales, ${x.radPerSec.toFixed(4)} rad/s (esperado ${expected.toFixed(4)}, desvío ${(100 * Math.abs(x.radPerSec / expected - 1)).toFixed(2)} %)`).join('  |  '));

  const { ctx, p } = await newPage({ deviceScaleFactor: 3 }); await p.goto(pathToFileURL(DIST).href); await p.waitForFunction(() => window.__solar); await p.waitForTimeout(800);
  const dpr1 = await p.evaluate(() => [window.devicePixelRatio, document.getElementById('scene').width]);
  await p.evaluate(() => window.livelyPropertyListener('quality', 3)); await p.waitForTimeout(500);
  const dpr2 = await p.evaluate(() => [window.devicePixelRatio, document.getElementById('scene').width]);
  ok('   (extra) tope de devicePixelRatio', dpr1[0] === 1.5 && dpr1[1] === 480 && dpr2[0] === 2 && dpr2[1] === 640, `pantalla ×3: por defecto dpr=${dpr1[0]} (canvas ${dpr1[1]} px de 320 css); calidad «Máxima» → dpr=${dpr2[0]} (canvas ${dpr2[1]} px)`);
  // pausa por visibilidad sin saltos
  await p.evaluate(() => window.livelyPropertyListener('autopilot', false));
  const hid = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms)), set = v => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); };
    await sleep(500); const a0 = window.__solar.earthAngle(), d0 = window.__WP.stats().delivered; set('hidden'); await sleep(4000);
    const a1 = window.__solar.earthAngle(), d1 = window.__WP.stats().delivered; set('visible'); await sleep(1000);
    const a2 = window.__solar.earthAngle(), d2 = window.__WP.stats().delivered; return { hiddenFrames: d1 - d0, hiddenAngle: a1 - a0, afterAngle: a2 - a1, afterFrames: d2 - d1, rate: 2 * Math.PI / 60 };
  });
  ok('   (extra) pausa en «hidden» y reanudación sin salto', hid.hiddenFrames <= 1 && hid.hiddenAngle < hid.rate * 0.3 && hid.afterAngle < hid.rate * 1.6, `oculto 4 s → ${hid.hiddenFrames} fotogramas y ${hid.hiddenAngle.toFixed(4)} rad avanzados; 1 s tras reanudar → ${hid.afterAngle.toFixed(4)} rad (≈ ${hid.rate.toFixed(4)} esperados, sin los 4 s de salto)`);
  await ctx.close();
}

/* autopiloto: modo directo y modo eventos */
{
  const probe = async mode => {
    const { ctx, p } = await newPage({ viewport: { width: 640, height: 360 } }); await p.addInitScript(`window.__WP_CFG_PRE=1;`);
    await p.goto(pathToFileURL(DIST).href); await p.waitForFunction(() => window.__solar);
    await p.evaluate(m => { window.__WP_CFG.autopilotMode = m; window.livelyPropertyListener('speed', 4); }, mode);
    const s0 = await p.evaluate(() => ({ th: camT.theta, d: camT.dist }));
    let followed = false, released = false, mx = 0; const t0 = Date.now();
    while (Date.now() - t0 < 70000) { await p.waitForTimeout(500); const r = await p.evaluate(() => ({ f: window.__solar.camInfo().follow, mode: window.__AP.st.mode, th: camT.theta, d: camT.dist })); if (r.f) followed = true; else if (followed) { released = true; mx = r; break; } mx = r; }
    const s1 = await p.evaluate(() => ({ th: camT.theta, d: camT.dist, mode: window.__AP.st.mode }));
    await p.evaluate(() => window.livelyPropertyListener('autopilot', false)); await p.waitForTimeout(600); const off = await p.evaluate(() => window.__AP.st.mode); s1.off = off;
    await ctx.close(); return { mode, s0, s1, followed, released };
  };
  const d = await probe('auto');
  ok('   (extra) autopiloto directo: rota, hace zoom y sigue/suelta naves', d.s1.mode === 'direct' && d.s1.off === 'off' && Math.abs(d.s1.th - d.s0.th) > 0.05 && d.followed && d.released, `modo=${d.s1.mode}; con la propiedad autopilot=false → ${d.s1.off}; θ ${d.s0.th.toFixed(2)}→${d.s1.th.toFixed(2)}, dist ${d.s0.d.toFixed(0)}→${d.s1.d.toFixed(0)}; siguió una nave: ${d.followed}; la soltó: ${d.released}`);
  const e = await probe('events');
  ok('   (extra) autopiloto por eventos (alternativa sin acceso a la cámara)', e.s1.mode === 'events' && e.followed && e.released, `modo=${e.s1.mode}; siguió una nave con el botón «Localizar» oculto: ${e.followed}; la soltó con Escape: ${e.released}; θ ${e.s0.th.toFixed(2)}→${e.s1.th.toFixed(2)} (rotación por arrastre sintético: ${Math.abs(e.s1.th - e.s0.th) > 0.05 ? 'sí' : 'no'})`);
}
await browser.close();

/* (4) misma semilla → fotogramas idénticos, y (7) ffprobe */
if (!skipVideo) {
  const run = (args) => { const r = spawnSync('node', [path.join(TOOLS, 'render-video.mjs'), ...args], { cwd: ROOT, env: process.env, encoding: 'utf8' }); if (r.status !== 0) console.error(r.stdout, r.stderr); return r.status === 0; };
  const T = path.join(ROOT, 'dist/test'); fs.mkdirSync(T, { recursive: true });
  const base = ['--width', '320', '--height', '180', '--fps', '15', '--duration', '10'];
  run([...base, '--seed', '42', '--out', 'dist/test/s1.mp4', '--frame-hashes', 'dist/test/s1.json']); run([...base, '--seed', '42', '--out', 'dist/test/s2.mp4', '--frame-hashes', 'dist/test/s2.json']); run([...base, '--seed', '43', '--out', 'dist/test/s3.mp4', '--frame-hashes', 'dist/test/s3.json']);
  const H = n => JSON.parse(fs.readFileSync(path.join(T, n), 'utf8')), h1 = H('s1.json'), h2 = H('s2.json'), h3 = H('s3.json');
  const md5 = f => execSync(`ffmpeg -v error -i ${f} -f framemd5 -`, { cwd: T }).toString().split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',')[5]).join('');
  const same = h1.length === 150 && h1.every((x, i) => x === h2[i]), diff = h1.filter((x, i) => x !== h3[i]).length, vsame = md5('s1.mp4') === md5('s2.mp4');
  ok('4. dos renders de 10 s con la misma semilla = fotogramas idénticos', same && vsame && diff > 100, `${h1.length} fotogramas capturados: SHA-256 idénticos entre ambos renders: ${same}; fotogramas decodificados de los .mp4 idénticos: ${vsame}; con otra semilla difieren ${diff}/150`);
  run(['--width', '640', '--height', '360', '--fps', '30', '--duration', '20', '--out', 'dist/test/probe20.mp4']);
  const pr = JSON.parse(execSync('ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration -of json dist/test/probe20.mp4', { cwd: ROOT }).toString());
  const s = pr.streams[0], dur = +pr.format.duration;
  ok('7. ffprobe confirma resolución, fps y duración', s.width === 640 && s.height === 360 && s.r_frame_rate === '30/1' && Math.abs(dur - 20) < 0.05 && +s.nb_frames === 600, `${s.codec_name} ${s.width}x${s.height}, ${s.r_frame_rate} fps, ${s.nb_frames} fotogramas, duración ${dur.toFixed(3)} s`);
}
console.log(`\n${results.filter(r => r.pass).length}/${results.length} comprobaciones correctas`);
process.exit(results.every(r => r.pass) ? 0 : 1);
