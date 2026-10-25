// Service worker: permite instalar la web como app y abrir el itinerario sin conexión.
// Los archivos propios se piden primero a la red (así las actualizaciones llegan enseguida) y, si no
// hay cobertura, se sirven de la copia guardada. Supabase, mapas, rutas y búsquedas van siempre a la red.
const VERSION = "v1";
const SHELL = `viaje-shell-${VERSION}`;
const CDN = `viaje-cdn-${VERSION}`;
const SHARE = "viaje-compartido"; // fotos recibidas desde la galería del móvil, a la espera de subirse
const SHELL_FILES = [
  "./", "index.html", "css/styles.css", "manifest.webmanifest", "icons/icon.svg",
  "js/album.js", "js/albumview.js", "js/mapimage.js", "js/pdf.js", "js/settings.js", "js/weather.js", "js/places.js", "js/live.js",
  "js/accessdialog.js", "js/people.js", "js/presence.js", "js/ledger.js", "js/extras.js", "js/expensedialog.js", "js/share.js", "js/discover.js",
  "js/app.js", "js/config.js", "js/dialogs.js", "js/export.js", "js/geo.js", "js/icons.js",
  "js/images.js", "js/map.js", "js/state.js", "js/store.js", "js/trip.js", "js/util.js", "js/views.js",
];
const CDN_HOSTS = ["cdn.jsdelivr.net"]; // librerías con versión fija: se pueden guardar para siempre

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => Promise.all(SHELL_FILES.map((file) => cache.add(file).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL && key !== CDN && key !== SHARE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // "Compartir" desde la galería del móvil: el navegador envía las fotos por POST a esta dirección.
  if (request.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/compartir")) {
    event.respondWith(receiveShared(request));
    return;
  }
  if (request.method !== "GET") return;
  if (url.origin === location.origin) event.respondWith(networkFirst(request));
  else if (CDN_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(request));
});

// Guarda las fotos recibidas y abre la app, que las subirá al álbum (ver app.js). Si lo compartido es un texto o un
// enlace (p. ej. un sitio desde Google Maps), abre la app con ese texto para proponer una actividad nueva.
async function receiveShared(request) {
  const form = await request.formData();
  const files = form.getAll("fotos").filter((f) => typeof f !== "string" && f.type.startsWith("image/"));
  const text = ["title", "text", "url"].map((k) => form.get(k)).filter((v) => typeof v === "string" && v.trim()).join("\n");
  if (!files.length && text) return Response.redirect(`${self.registration.scope}?lugar=${encodeURIComponent(Array.from(text).slice(0, 1500).join(""))}#plan`, 303);
  const cache = await caches.open(SHARE);
  for (const old of await cache.keys()) await cache.delete(old);
  await Promise.all(
    files.map((file, i) =>
      cache.put(`${self.registration.scope}compartido/${i}`, new Response(file, { headers: { "Content-Type": file.type, "X-Nombre": encodeURIComponent(file.name || `foto-${i + 1}.jpg`) } })),
    ),
  );
  return Response.redirect(`${self.registration.scope}?compartido=${files.length}#fotos`, 303);
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request, { cache: "no-cache" });
    // Las visitas con un lugar o fotos compartidas llevan el contenido en la dirección: no se guardan en caché.
    const shared = new URL(request.url).searchParams.has("lugar") || new URL(request.url).searchParams.has("compartido");
    if (response.ok && !shared) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const home = (await cache.match("./")) ?? (await cache.match("index.html"));
      if (home) return home;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CDN);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === "opaque") cache.put(request, response.clone()).catch(() => {});
  return response;
}
