# Sistema Solar Pop

Simulación 3D animada del sistema solar en **un único `index.html`** (sin build, solo [Three.js r128](https://threejs.org/) desde cdnjs):

- La Tierra da una vuelta al Sol cada **60 s reales**; el resto de planetas usa su periodo real relativo (Mercurio 0,241 años … Plutón 248).
- Sol, 8 planetas y Plutón, con 20 lunas, anillos de Saturno y texturas procedurales (sin imágenes externas).
- **34 naves de la cultura pop** (Star Wars, Star Trek, Battlestar Galactica, Alien, Spaceballs, Independence Day, Zathura, Depredador, Prometheus…) que viajan de planeta en planeta, con flotas en formación, estelas, tooltips y **menú de localización** con buscador.
- Cámara orbital (arrastrar / rueda), clic en una nave para seguirla (Esc para soltar), control de luz y velocidad.

Las siluetas están hechas con primitivas 3D y son aproximaciones; los nombres de obras y naves se usan solo como etiquetas.
Proyecto de aficionado, sin relación con los titulares de esas obras ni de sus marcas.

## Idioma y contacto
- **Idioma:** selector *Español / English* en el panel (se recuerda en el navegador; también `?lang=en`). Traduce la interfaz, los nombres de cuerpos y de naves, y la búsqueda funciona en ambos idiomas.
- **Contactar al equipo:** botón verde «Contacta al equipo creador» (abajo a la derecha) que abre un formulario con **Nombre, Mail y Mensaje obligatorios**. El mensaje se envía por [FormSubmit](https://formsubmit.co) al correo configurado en la constante `CONTACT_EMAIL` de `index.html`.
  **La primera vez** FormSubmit manda un correo de activación a esa dirección: hay que pulsar el enlace una vez para que lleguen los mensajes. Para no dejar el correo a la vista en el código, tras activarlo se puede sustituir por el alias aleatorio que da FormSubmit (`CONTACT_ENDPOINT`).

## Ver en local
Abre `index.html` en el navegador (necesita internet solo para cargar Three.js desde la CDN).

## Publicar en Vercel
1. En [vercel.com](https://vercel.com) → **Add New… → Project** → importa este repositorio de GitHub.
2. *Framework Preset:* **Other**. Sin *Build Command* ni *Output Directory* (se sirve la raíz tal cual).
3. **Deploy.** Obtendrás una URL `https://<proyecto>.vercel.app`; en *Settings → Domains* puedes añadir tu dominio.

(Con la CLI: `npx vercel --prod` en la raíz del repo.)

## Fondo animado para Lively Wallpaper y vídeo
- `wallpaper/SistemaSolarPop.zip` está listo para arrastrarlo a [Lively](https://rocksdanister.github.io/lively/) (Windows).
  Para regenerarlo: `node tools/build-wallpaper.mjs`.
- `node tools/render-video.mjs` exporta un vídeo reproducible (reloj virtual + semilla).
- Detalles, opciones y verificación en [`tools/README.md`](tools/README.md).

Tip: Lively también puede usar la URL de Vercel como fondo («Introduzca la URL»), aunque el paquete local funciona sin internet.
