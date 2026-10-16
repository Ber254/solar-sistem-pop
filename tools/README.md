# Herramientas: fondo para Lively y exportador a vídeo

Todo lo de aquí **no modifica** `index.html` (ni ningún archivo previo): trabaja sobre copias
generadas en `dist/` (carpeta ignorada por git). *(El HTML de origen es el `index.html` de la raíz; se puede cambiar con `--src`.)*

Requisitos: Node ≥ 18 (probado con 22). Para imágenes y vídeo: Playwright con Chromium y ffmpeg.
Los scripts **no instalan nada**; si falta algo, te dicen qué ejecutar:

```bash
cd tools && npm install playwright && npx playwright install chromium     # Playwright
# ffmpeg: winget install Gyan.FFmpeg · brew install ffmpeg · sudo apt install ffmpeg
```

## A) Paquete para Lively Wallpaper

```bash
node tools/build-wallpaper.mjs            # genera dist/wallpaper/ y dist/SistemaSolarPop.zip
```
Qué hace: copia el HTML a `dist/wallpaper/index.html`; baja `three.min.js` de la CDN a `libs/` (si la CDN no responde
usa jsDelivr/unpkg o el paquete npm; también vale dejarlo en `tools/.cache/`) y reescribe la URL **solo en la copia**;
inyecta `wallpaper.js` (= `tools/inject/autopilot.js` + `tools/inject/wallpaper.js`) antes de cualquier otro script;
crea `LivelyInfo.json`, `LivelyProperties.json` (plantillas en `wallpaper/`), `thumbnail.jpg`, `preview.gif`/`.jpg` y el zip.

Opciones: `--src`, `--out`, `--no-images`, `--fps 30`, `--dpr 1.5`, `--no-autopilot`, `--show-ui`.

**Instalar:** abre Lively → arrastra `SistemaSolarPop.zip` a la ventana (o «＋ Añadir fondo» → *Examinar*). Se instala con
su miniatura; ábrelo y usa el icono ⚙ para ajustar las propiedades.

| Propiedad (Lively) | Efecto |
|---|---|
| Límite de FPS (15-60, def. 30) | envuelve `requestAnimationFrame`; la simulación **no** cambia de velocidad al saltar fotogramas |
| Calidad (Baja 0,75× · Media 1× · Alta 1,5× · Máxima 2×) | tope de `devicePixelRatio` (def. Alta = 1,5) |
| Autopiloto de cámara (def. sí) | rotación lenta, zoom suave y, cada 20-45 s, sigue una nave 15-25 s |
| El autopiloto sigue naves | permite desactivar solo los seguimientos |
| Velocidad del tiempo (0,25-4×) | mueve el slider de velocidad de la página |
| Mostrar interfaz | HUD, menú de naves, ayuda y tooltip (ocultos por defecto) |

Además se pausa el render con `document.visibilityState === "hidden"` y se reanuda sin saltos de tiempo.
Si tocas el ratón o el teclado, el autopiloto se aparta 20 s.

## B) Exportador a vídeo

```bash
node tools/render-video.mjs --width 1920 --height 1080 --fps 30 --duration 1200 --seed 1 --out dist/video/sistema-solar.mp4
```
Carga el HTML **tal cual** con `page.addInitScript`: reloj virtual (`performance.now`, `Date.now`, `requestAnimationFrame`
solo avanzan cuando el script lo ordena, en pasos de 1/fps) y `Math.random` con semilla (mulberry32). Cada fotograma
se captura y se envía a ffmpeg por stdin (sin PNG en disco). El autopiloto de cámara funciona con ese reloj virtual.

| Opción | Por defecto | |
|---|---|---|
| `--width/--height` | 1920×1080 | (se redondean a pares) |
| `--fps` | 30 | |
| `--duration` | 1200 s | |
| `--seed` | 1 | misma semilla + mismos parámetros ⇒ mismos fotogramas |
| `--format` | `h264` | `h264` (mp4), `hevc` (mp4 H.265), `vp9` (webm) |
| `--crf` | 18 / 22 / 30 | calidad según formato |
| `--out` | `dist/video/sistema-solar.<ext>` | |
| `--resume` | — | continúa un render interrumpido (mismos parámetros) |
| `--capture` | `canvas` | `page` captura también el HUD |
| `--fade` | 2 s | fundido a negro al inicio y al final (0 = sin fundido) |
| `--no-autopilot` | — | cámara fija |
| `--segment` | 60 s | duración de cada tramo; los tramos terminados se conservan para `--resume` |
| `--frame-hashes` | — | guarda el SHA-256 de cada fotograma |

Muestra progreso y tiempo estimado. Con **Ctrl-C** se conservan los tramos terminados; vuelve a lanzar el mismo comando con
`--resume` (reproduce internamente la simulación hasta ese punto sin codificar y sigue; el resultado es idéntico al de un
render sin interrupción). Ritmo orientativo: Chromium usa WebGL por software (SwiftShader) por defecto — es lo que lo hace
reproducible y funciona sin GPU, pero es lento a 1080p; 20 min a 30 fps son 36 000 fotogramas, calcula varias horas.

**No es un bucle perfecto.** El fundido a negro de 2 s al principio y al final solo evita un salto brusco al repetirse. Un
bucle real exigiría cambiar la simulación (que el estado final coincida con el inicial); la Tierra vuelve a su sitio cada
60 s, pero las naves (viajes aleatorios), las estelas y el avance del sistema no.

**Usarlo como fondo.** *Lively:* arrastra el `.mp4` a la ventana (o «Añadir fondo» → archivo) y activa «bucle».
*Wallpaper Engine:* «Crear fondo» → arrastra el vídeo → guardar; en las propiedades del vídeo activa la reproducción en bucle.

## Verificación

```bash
node tools/verify.mjs                  # 7 comprobaciones + extras (tarda ~5 min por el render de prueba)
node tools/verify.mjs --skip-video     # sin las pruebas de vídeo
```
