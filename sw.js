// Service worker: permite instalar la web como app y abrir el itinerario sin conexión.
// Los archivos propios se piden primero a la red (así las actualizaciones llegan enseguida) y, si no
// hay cobertura, se sirven de la copia guardada. Supabase, mapas, rutas y búsquedas van siempre a la red.
const VERSION = "v1";
const SHELL = `viaje-shell-${VERSION}`;
const CDN = `viaje-cdn-${VERSION}`;
const SHELL_FILES = [
  "./", "index.html", "css/styles.css", "manifest.webmanifest", "icons/icon.svg",
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
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL && key !== CDN).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === location.origin) event.respondWith(networkFirst(request));
  else if (CDN_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok) cache.put(request, response.clone()).catch(() => {});
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
