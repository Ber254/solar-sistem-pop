/* Reloj virtual y azar con semilla para el exportador de vídeo (se inyecta con page.addInitScript).
 * El tiempo SOLO avanza cuando se llama a __vclock.step(); nada depende del reloj real.
 * Sustituye: performance.now, Date.now / new Date(), requestAnimationFrame / cancelAnimationFrame
 * y Math.random (mulberry32). setTimeout/setInterval NO se virtualizan (la página no los usa).
 */
(function () {
  'use strict';
  const seed = (window.__VSEED === undefined ? 1 : window.__VSEED) >>> 0;
  function mulberry32(a) { return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  Math.random = mulberry32(seed);

  let vnow = 0, nextId = 1, queue = new Map();
  const EPOCH = 1735689600000;                       // 2025-01-01T00:00:00Z fijo
  const nativeRAF = window.requestAnimationFrame.bind(window);
  performance.now = () => vnow;
  const RealDate = Date;
  class VDate extends RealDate { constructor(...a) { if (a.length === 0) super(EPOCH + vnow); else super(...a); } static now() { return EPOCH + vnow; } }
  window.Date = VDate;
  window.requestAnimationFrame = cb => { const id = nextId++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = id => { queue.delete(id); };

  function step(dtMs) {                              // avanza un paso y ejecuta los callbacks pendientes
    vnow += dtMs;
    const cbs = [...queue.values()]; queue.clear();
    for (const cb of cbs) cb(vnow);
    return cbs.length;
  }
  function run(n, dtMs) { for (let i = 0; i < n; i++) step(dtMs); return vnow; }
  function stepAndCapture(dtMs, type) {              // captura en la MISMA tarea: el buffer de WebGL aún es válido
    step(dtMs);
    const c = document.getElementById('scene') || document.querySelector('canvas');
    return { url: c.toDataURL(type || 'image/png'), w: c.width, h: c.height };
  }
  window.__vclock = { step, run, stepAndCapture, now: () => vnow, pending: () => queue.size, nativeRaf: nativeRAF, seed };
})();
