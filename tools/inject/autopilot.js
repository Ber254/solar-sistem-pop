/* Autopiloto de cámara (compartido por el paquete de Lively y por el exportador de vídeo).
 *
 * Solo usa performance.now() y requestAnimationFrame, que en el vídeo son virtuales y en Lively
 * pasan por el limitador de FPS; el azar sale de Math.random (con semilla en el vídeo).
 *
 * Modo «directo»: si la cámara es accesible (la página es un script clásico: `camT`, `cam`,
 * `clampDist`, `following`, `homeDist` son globales léxicas visibles desde otros scripts), se
 * modifica directamente el objetivo de cámara. Modo «eventos»: si no, se simulan rueda y puntero
 * sobre el canvas. Para seguir una nave se pulsa el botón «Localizar» de una fila aleatoria del
 * menú (aunque esté oculto por CSS) y para soltarla se envía Escape.
 */
(function () {
  'use strict';
  if (window.__AP) return;
  const TAU = Math.PI * 2;
  // configuración compartida con wallpaper.js: se completa EN SITIO (misma referencia para todos los scripts)
  const CFG = (window.__WP_CFG = window.__WP_CFG || {});
  const DEFAULTS = { autopilot: true, followShips: true, rotateSpeed: 0.04, autopilotMode: 'auto' };
  for (const k in DEFAULTS) if (!(k in CFG)) CFG[k] = DEFAULTS[k];
  const rnd = (a, b) => a + Math.random() * (b - a);

  const direct = () => {
    if (CFG.autopilotMode === 'events') return false;
    try { return typeof camT === 'object' && typeof cam === 'object' && typeof clampDist === 'function'; } catch (e) { return false; }
  };
  const followingNow = () => { try { return typeof following !== 'undefined' ? following : null; } catch (e) { return null; } };

  const st = { last: null, T: 0, nextFollow: rnd(5, 9), followEnd: 0, isFollowing: false, lastUser: -1e9, wheelLeft: 0, wheelDir: 1, nextWheel: 8, drag: null, mode: 'none' };
  window.__AP = { st, CFG };

  // si una persona toca el ratón o el teclado, el autopiloto se aparta unos segundos
  for (const ev of ['pointerdown', 'wheel', 'keydown'])
    window.addEventListener(ev, e => { if (e.isTrusted) st.lastUser = st.T; }, true);

  function pickLocate() {
    const btns = [...document.querySelectorAll('.srow:not([hidden]) button[data-act="loc"]')];
    if (btns.length) { btns[Math.floor(Math.random() * btns.length)].click(); return true; }
    if (window.__solar && window.__solar.setFollow && window.__solar.ships) {
      const ids = Object.keys(window.__solar.ships).filter(id => window.__solar.ships[id].visible);
      if (ids.length) { window.__solar.setFollow(ids[Math.floor(Math.random() * ids.length)]); return true; }
    }
    return false;
  }
  const release = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  function fireWheel(canvas, dy) {
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true }));
  }
  // Un puntero sintético puede ser rechazado por la página (p. ej. setPointerCapture con un id no activo):
  // se detecta el error durante el despacho y se deja de intentar el arrastre.
  function firePointer(canvas, type, x, y) {
    let broke = false; const h = e => { broke = true; e.preventDefault(); };
    window.addEventListener('error', h);
    try { canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true })); } catch (e) { broke = true; }
    window.removeEventListener('error', h);
    if (broke) st.dragBroken = true;
  }

  function tick() {
    requestAnimationFrame(tick);
    const nowMs = performance.now();
    if (st.last === null) { st.last = nowMs; return; }
    const dt = Math.min((nowMs - st.last) / 1000, 0.5); st.last = nowMs;
    if (!CFG.autopilot) { st.mode = 'off'; return; }
    st.T += dt;
    if (st.T - st.lastUser < 20) { st.mode = 'user'; return; }
    const isDirect = direct();
    st.mode = isDirect ? 'direct' : 'events';
    if (st.T < 1) return;

    // --- seguir una nave 15-25 s cada 20-45 s ---
    if (CFG.followShips) {
      if (!st.isFollowing && st.T >= st.nextFollow) { if (pickLocate()) { st.isFollowing = true; st.followEnd = st.T + rnd(15, 25); } else st.nextFollow = st.T + 5; }
      else if (st.isFollowing && st.T >= st.followEnd) { release(); st.isFollowing = false; st.nextFollow = st.T + rnd(20, 45); }
    } else if (st.isFollowing) { release(); st.isFollowing = false; }

    if (isDirect) {
      const f = followingNow();
      camT.theta -= CFG.rotateSpeed * dt;                                    // rotación lenta y continua
      camT.phi = 0.58 + 0.22 * Math.sin(st.T * TAU / 150);                    // cabeceo suave (elevación ~35-65°)
      if (f) camT.dist = clampDist(f.followDist * (1 + 0.45 * (0.5 + 0.5 * Math.sin(st.T * TAU / 35 - 1.6))));   // respira alrededor de la nave
      else { let h = 250; try { h = homeDist; } catch (e) {} camT.dist = clampDist(h * (0.62 + 0.38 * (0.5 + 0.5 * Math.sin(st.T * TAU / 100 - 1.57)))); }
    } else {
      const canvas = document.getElementById('scene') || document.querySelector('canvas'); if (!canvas) return;
      // rueda: acerca y aleja por ráfagas
      if (st.wheelLeft <= 0 && st.T >= st.nextWheel) { st.wheelLeft = 90; st.wheelDir = -st.wheelDir; st.nextWheel = st.T + rnd(10, 20); }
      if (st.wheelLeft > 0) { fireWheel(canvas, 12 * st.wheelDir); st.wheelLeft -= 1; }
      // arrastre lento (puede no ser aceptado por la página)
      const cx = innerWidth / 2, cy = innerHeight / 2;
      if (st.dragBroken) return;
      if (!st.drag) { st.drag = { x: cx, y: cy }; firePointer(canvas, 'pointerdown', st.drag.x, st.drag.y); }
      st.drag.x += CFG.rotateSpeed / 0.006 * dt * 1; // el ratón mueve 0,006 rad por píxel
      if (st.drag.x > innerWidth - 20) { firePointer(canvas, 'pointerup', st.drag.x, st.drag.y); st.drag = null; }
      else firePointer(canvas, 'pointermove', st.drag.x, st.drag.y);
    }
  }
  requestAnimationFrame(tick);
})();
