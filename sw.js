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
  "js/juegos/index.js", "js/juegos/batalla.js", "js/juegos/bolsa.js", "js/juegos/bingo.js",
  "css/juegos.css", "css/bateria.css", "css/ubicar.css", "css/chat.css", "js/chat.js", "css/actualizar.css", "js/actualizar.js", "js/ubicar.js", "js/bateria.js", "js/recorrido.js", "js/maprecorrido.js", "css/juego-batalla.css", "css/juego-bolsa.css", "css/juego-bingo.css", "js/ideas.js", "js/media.js", "js/comments.js", "js/attach.js", "js/accessdialog.js", "js/people.js", "js/presence.js", "js/ledger.js", "js/extras.js", "js/expensedialog.js", "js/share.js", "js/discover.js",
  "js/app.js", "js/config.js", "js/dialogs.js", "js/export.js", "js/geo.js", "js/icons.js",
  "js/images.js", "js/map.js", "js/state.js", "js/store.js", "js/trip.js", "js/util.js", "js/views.js",
  "css/cola.css", "js/cola.js", "js/formatos.js", "js/fotoloc.js", // cola de fotos sin conexión, formatos de foto y ubicación de las fotos
  "css/encuentro.css", "js/encuentro.js", // punto de encuentro
  "css/avisos.css", "js/avisos.js", "js/avisos-push.js", "icons/badge.png", // avisos: alertas en pantalla, campana y notificaciones
  "css/categorias.css", "js/categorias.js", "js/gastopresets.js", "js/gastoloc.js", "js/mapgastos.js", // categorías de gasto, atajos, ubicación del gasto y gastos en el mapa
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

// ---------- avisos (Web Push) ----------
// La Edge Function `push` envía un JSON {id, kind, title, body, url, tag, urgent, image, ts}. Con la web visible y en primer plano no se
// enseña la notificación del sistema: se avisa a la página para que muestre su alerta resaltada (así no suena dos veces). En iPhone sí se
// enseña siempre: Safari retira la suscripción a quien recibe avisos sin mostrar ninguna notificación.
const IOS = /iPhone|iPad|iPod/.test(self.navigator?.userAgent || "");

async function handlePush(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Nuestro viaje", body: event.data ? event.data.text() : "" };
  }
  const urgent = Boolean(data.urgent);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const front = windows.find((c) => c.visibilityState === "visible" && c.focused);
  if (front) {
    front.postMessage({ type: "push", ...data });
    if (!IOS) return;
  }
  await self.registration.showNotification(data.title || "Nuestro viaje", {
    body: data.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/badge.png",
    image: data.image || undefined,
    tag: data.tag || data.id || "aviso", // renotify exige una etiqueta
    renotify: true,
    timestamp: data.ts || Date.now(),
    data: { url: data.url || "#mapa", id: data.id || null, kind: data.kind || null },
    vibrate: urgent ? [300, 120, 300, 120, 600] : [180, 80, 180],
    silent: false,
    requireInteraction: urgent,
    actions: urgent ? [{ action: "ver", title: "Ver" }] : [],
    lang: "es",
  });
}
self.addEventListener("push", (event) => event.waitUntil(handlePush(event)));

// Tocar la notificación: se enfoca la web que ya esté abierta y se la lleva al sitio del aviso, o se abre una nueva.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "#mapa";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => c.url.startsWith(self.registration.scope));
      if (open) {
        await open.focus().catch(() => {});
        open.postMessage({ type: "navigate", url });
        return;
      }
      await self.clients.openWindow(new URL(url, self.registration.scope).href);
    })(),
  );
});

// El navegador cambió o caducó la suscripción: se intenta renovarla aquí; la web la guarda en la base de datos al abrirse
// (el service worker no tiene la sesión de la persona) y se avisa a las ventanas abiertas para que lo hagan ya.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
        if (!event.newSubscription && key) await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch {
        /* sin permiso o sin red: la web lo detectará al abrirse y avisará */
      }
      for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) c.postMessage({ type: "resubscribed" });
    })(),
  );
});
