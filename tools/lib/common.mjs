// Utilidades compartidas por build-wallpaper.mjs, render-video.mjs y verify.mjs (sin dependencias).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync, execSync } from 'node:child_process';

export const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(TOOLS, '..');

export function die(msg, code = 1) { console.error('\n' + msg + '\n'); process.exit(code); }

/** Parser mínimo: --clave valor | --clave=valor | --flag | --no-flag. `spec` = { clave: { def, type, help } } */
export function parseArgs(argv, spec, usage = '') {
  const out = {}; for (const [k, v] of Object.entries(spec)) out[k] = v.def;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--help' || a === '-h') { console.log(usage); process.exit(0); }
    if (!a.startsWith('--')) die(`Argumento inesperado: ${a}\n\n${usage}`);
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    let neg = false;
    if (!(k in spec) && k.startsWith('no-') && (k.slice(3) in spec)) { k = k.slice(3); neg = true; }
    if (!(k in spec)) die(`Opción desconocida: --${k}\n\n${usage}`);
    const s = spec[k];
    if (s.type === 'boolean') { out[k] = !neg; continue; }
    if (v === undefined) { v = argv[++i]; if (v === undefined) die(`Falta el valor de --${k}`); }
    out[k] = s.type === 'number' ? Number(v) : v;
    if (s.type === 'number' && !Number.isFinite(out[k])) die(`--${k} debe ser un número (recibido "${v}")`);
  }
  return out;
}

/** ¿Existe el binario en el PATH? */
export function hasBin(name, args = ['-version']) {
  const r = spawnSync(name, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

const PW_HELP = `Playwright (Chromium) no está instalado o no se encuentra. Este script NO instala nada por sí mismo.
Para instalarlo tú:
    cd tools && npm install playwright && npx playwright install chromium
Si ya lo tienes en otro sitio, indica su carpeta con la variable PLAYWRIGHT_MODULE_PATH
(p. ej. PLAYWRIGHT_MODULE_PATH=/ruta/a/node_modules/playwright).`;

export async function loadPlaywright() {
  const tries = [];
  try { return pick(await import('playwright')); } catch (e) { tries.push('import playwright'); }
  const req = createRequire(import.meta.url);
  const cands = [process.env.PLAYWRIGHT_MODULE_PATH];
  try { cands.push(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright')); } catch (e) { /* sin npm */ }
  for (const c of cands.filter(Boolean)) { try { return pick(req(c)); } catch (e) { tries.push(c); } }
  die(PW_HELP);
  function pick(m) { return m.chromium ? m : (m.default || m); }
}

export function launchArgs() { return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']; }

/** Descarga con fetch y, si falla (p. ej. proxy), con curl. */
export async function download(url) {
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch(url, { signal: ctl.signal }); clearTimeout(to);
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  } catch (e) { /* probar curl */ }
  const r = spawnSync('curl', ['-fsSL', '--max-time', '60', url], { maxBuffer: 256 * 1024 * 1024 });
  if (!r.error && r.status === 0 && r.stdout.length) return r.stdout;
  throw new Error('no se pudo descargar ' + url);
}

/** Extrae un fichero de un .tgz (tar mínimo en memoria). */
export function untgzFile(tgz, wanted) {
  const tar = zlib.gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length;) {
    const hdr = tar.subarray(off, off + 512); if (hdr.every(b => b === 0)) break;
    const str = (a, b) => hdr.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100), size = parseInt(str(124, 136).trim() || '0', 8);
    if (name === wanted) return Buffer.from(tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** ZIP sin dependencias (deflate). entries: [{ name, data: Buffer }] */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
export function makeZip(entries) {
  const DOS_TIME = 0, DOS_DATE = ((2025 - 1980) << 9) | (1 << 5) | 1;   // fecha fija → zip reproducible
  const local = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), raw = e.data, def = zlib.deflateRawSync(raw, { level: 9 });
    const useDef = def.length < raw.length, body = useDef ? def : raw, crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useDef ? 8 : 0, 8);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, body);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useDef ? 8 : 0, 10);
    ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

export function walk(dir, base = dir) {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...walk(p, base)); else out.push({ name: path.relative(base, p).split(path.sep).join('/'), data: fs.readFileSync(p) });
  }
  return out;
}
