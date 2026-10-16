/* wallpaper.js — se inyecta en la COPIA del HTML, antes de cualquier otro script.
 * (build-wallpaper.mjs antepone una línea de configuración y el contenido de autopilot.js.)
 *
 *  1. Oculta la interfaz por CSS (opción para mostrarla).
 *  2. Reloj propio + limitador de FPS sobre requestAnimationFrame. La simulación se mueve con el
 *     tiempo real que recibe cada fotograma, así que saltarse fotogramas NO cambia su velocidad.
 *  3. Pausa con document.visibilityState === 'hidden' y reanuda sin salto: el tiempo transcurrido
 *     oculto (o congelado) se descuenta de performance.now() y de los timestamps de rAF.
 *  4. devicePixelRatio con tope (1,5 por defecto).
 *  5. livelyPropertyListener(name, val) con las propiedades de LivelyProperties.json.
 */
(function () {
  'use strict';
  if (window.__WP) return;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const CFG = (window.__WP_CFG = window.__WP_CFG || {});     // misma referencia que usa autopilot.js
  const DEFAULTS = { fps: 30, dprMax: 1.5, autopilot: true, followShips: true, showUI: false, speed: 1, uiSelectors: ['#hud', '#fleet', '#hint', '#tip'] };
  for (const k in DEFAULTS) if (!(k in CFG)) CFG[k] = DEFAULTS[k];

  /* ---------- 1. Interfaz oculta ---------- */
  const style = document.createElement('style'); style.id = 'wp-hide-ui';
  const applyUI = () => { style.textContent = CFG.showUI ? '' : CFG.uiSelectors.join(',') + '{display:none!important}'; };
  applyUI(); (document.head || document.documentElement).appendChild(style);

  /* ---------- 2/3. Reloj + limitador de FPS + visibilidad ---------- */
  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeNow = performance.now.bind(performance);
  let skew = 0;                                    // ms descontados (tiempo oculto / congelado)
  performance.now = () => nativeNow() - skew;

  const queue = new Map(); let nextId = 1, scheduled = false, lastRun = -1e9, hiddenAt = null, delivered = 0;
  const isHidden = () => document.visibilityState === 'hidden';
  function schedule() { if (!scheduled && queue.size && !isHidden()) { scheduled = true; nativeRAF(pump); } }
  function pump(ts) {
    scheduled = false;
    if (isHidden()) return;                         // en pausa: no se renderiza ni se reprograma
    const interval = 1000 / clamp(CFG.fps, 5, 240);
    const gap = ts - lastRun;
    if (gap < interval - 2) { schedule(); return; } // saltar este fotograma
    if (lastRun > 0 && gap > 1000) skew += gap - interval;   // proceso congelado/suspendido: sin salto de tiempo
    lastRun = gap < interval * 1.5 ? lastRun + interval : ts;
    const t = ts - skew, cbs = [...queue.values()]; queue.clear(); delivered++;
    for (const cb of cbs) { try { cb(t); } catch (e) { setTimeout(() => { throw e; }); } }
    schedule();
  }
  window.requestAnimationFrame = cb => { const id = nextId++; queue.set(id, cb); schedule(); return id; };
  window.cancelAnimationFrame = id => { queue.delete(id); };
  document.addEventListener('visibilitychange', () => {
    if (isHidden()) hiddenAt = nativeNow();
    else { if (hiddenAt !== null) skew += nativeNow() - hiddenAt; hiddenAt = null; lastRun = -1e9; schedule(); }
  });

  /* ---------- 4. devicePixelRatio con tope ---------- */
  const dprDesc = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  const realDPR = () => (dprDesc && dprDesc.get ? dprDesc.get.call(window) : (dprDesc ? dprDesc.value : 1)) || 1;
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => Math.min(realDPR(), CFG.dprMax) });
  const refreshSize = () => window.dispatchEvent(new Event('resize'));

  /* ---------- Velocidad del tiempo: usa el slider de la propia página (aunque esté oculto) ---------- */
  function applySpeed() {
    const el = document.getElementById('speed'); if (!el) return false;
    el.value = String(Math.log2(clamp(CFG.speed, 0.25, 4))); el.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }
  document.addEventListener('DOMContentLoaded', () => { if (CFG.speed !== 1) applySpeed(); if (CFG.orbits === false) window.livelyPropertyListener('orbits', false); });

  /* ---------- 5. Lively ---------- */
  const QUALITY = [0.75, 1, 1.5, 2];                // Baja, Media, Alta, Máxima → tope de devicePixelRatio
  window.livelyPropertyListener = function (name, val) {
    switch (name) {
      case 'fps': CFG.fps = clamp(+val || 30, 15, 60); break;
      case 'quality': CFG.dprMax = QUALITY[val | 0] || 1.5; refreshSize(); break;
      case 'autopilot': CFG.autopilot = !!val; break;
      case 'followShips': CFG.followShips = !!val; break;
      case 'orbits': { const el = document.getElementById('orbitchk'); CFG.orbits = !!val; if (el) { el.checked = !!val; el.dispatchEvent(new Event('change', { bubbles: true })); } break; }
      case 'showUI': CFG.showUI = !!val; applyUI(); break;
      case 'speed': CFG.speed = clamp(+val || 1, 0.25, 4); applySpeed(); break;
    }
  };

  window.__WP = { CFG, stats: () => ({ delivered, skew, queue: queue.size }), applyUI };
})();
