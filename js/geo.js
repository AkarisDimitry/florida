// Utilidades geográficas y servicios externos gratuitos (sin clave):
//   - Nominatim (OpenStreetMap): buscar lugares y nombrar coordenadas
//   - OSRM (servidor de demostración): ruta por carretera entre varias paradas
// Ambos piden un uso moderado, así que las llamadas se espacian y las rutas se guardan en caché.
import { sleep } from "./util.js";

const rad = (deg) => (deg * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export function pathKm(coords) {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    km += distanceKm({ lng: coords[i - 1][0], lat: coords[i - 1][1] }, { lng: coords[i][0], lat: coords[i][1] });
  }
  return km;
}

export function nearest(point, items, maxKm = 0.4) {
  let best = null;
  let bestDistance = maxKm;
  for (const item of items) {
    const d = distanceKm(point, item);
    if (d <= bestDistance) {
      best = item;
      bestDistance = d;
    }
  }
  return best;
}

// Enlace para abrir la navegación en la app de mapas del móvil.
export function directionsUrl(lat, lng) {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

// ---------- ubicación del dispositivo ----------

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Este navegador no puede obtener la ubicación."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(geolocationMessage(e))),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

export function geolocationMessage(error) {
  return error?.code === 1
    ? "No hay permiso para usar la ubicación. Actívalo en los ajustes del navegador."
    : "No se pudo obtener la ubicación. Prueba de nuevo, mejor al aire libre.";
}

// ---------- Nominatim ----------

const throttles = new Map();
async function polite(name, gapMs) {
  const next = Math.max(throttles.get(name) ?? 0, Date.now());
  throttles.set(name, next + gapMs);
  if (next > Date.now()) await sleep(next - Date.now());
}

async function nominatim(path, params) {
  await polite("nominatim", 1100);
  const url = new URL(`https://nominatim.openstreetmap.org/${path}`);
  url.search = new URLSearchParams({ format: "jsonv2", "accept-language": "es", ...params });
  const response = await fetch(url);
  if (response.status === 429) throw new Error("El servicio de búsqueda está ocupado. Prueba en unos segundos.");
  if (!response.ok) throw new Error("No se pudo consultar el buscador de lugares.");
  return response.json();
}

// `near` ({lat,lng}) solo sesga el orden de los resultados hacia esa zona.
export async function searchPlaces(query, near) {
  const params = { q: query, limit: "6" };
  if (near) params.viewbox = [near.lng - 4, near.lat + 4, near.lng + 4, near.lat - 4].join(",");
  const items = await nominatim("search", params);
  return items.map((item) => {
    const parts = item.display_name.split(",").map((s) => s.trim());
    return { name: item.name || parts[0], detail: parts.slice(1, 4).join(", "), lat: Number(item.lat), lng: Number(item.lon) };
  });
}

// Sitios de un tipo ("restaurant", "museum", "park"…) dentro de un recuadro, con sus etiquetas de OpenStreetMap
// (cocina, horario, web). Nominatim los devuelve por importancia: quien llama los ordena por distancia.
export function searchCategory(term, { lat, lng, radiusKm }) {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.2));
  return nominatim("search", { q: term, viewbox: [lng - dLng, lat + dLat, lng + dLng, lat - dLat].join(","), bounded: "1", limit: "40", extratags: "1", dedupe: "1" });
}

export async function reversePlace(lat, lng) {
  const item = await nominatim("reverse", { lat: String(lat), lon: String(lng), zoom: "18" });
  if (!item || item.error) return null;
  const parts = item.display_name.split(",").map((s) => s.trim());
  return { name: item.name || item.address?.road || parts[0], detail: parts.slice(1, 4).join(", ") };
}

// Ciudad y región de unas coordenadas ("Miami Beach, Florida"), o null.
export async function reverseCity(lat, lng) {
  const item = await nominatim("reverse", { lat: String(lat), lon: String(lng), zoom: "10" });
  if (!item || item.error) return null;
  const a = item.address ?? {};
  const city = a.city || a.town || a.village || a.municipality || a.county || item.name;
  return [city, a.state || a.country].filter(Boolean).join(", ") || null;
}

// ---------- OSRM ----------

const ROUTES_KEY = "viaje.rutas";
const MAX_CACHED_ROUTES = 12;
const keyOf = (points) => points.map((p) => `${p.lng.toFixed(4)},${p.lat.toFixed(4)}`).join(";");

// Las rutas pesan (miles de puntos): se leen de localStorage una sola vez y luego se usa la copia en memoria.
let routeCache = null;
function readRouteCache() {
  if (routeCache) return routeCache;
  try {
    routeCache = JSON.parse(localStorage.getItem(ROUTES_KEY)) || {};
  } catch {
    routeCache = {};
  }
  return routeCache;
}

export const cachedRoute = (points) => readRouteCache()[keyOf(points)]?.route ?? null;

function cacheRoute(key, route) {
  const cache = readRouteCache();
  cache[key] = { t: Date.now(), route };
  for (const old of Object.keys(cache).sort((a, b) => cache[b].t - cache[a].t).slice(MAX_CACHED_ROUTES)) delete cache[old];
  try {
    localStorage.setItem(ROUTES_KEY, JSON.stringify(cache));
  } catch {
    /* sin espacio: queda solo en memoria y se vuelve a pedir en la próxima visita */
  }
}

// Reduce puntos casi alineados (Ramer–Douglas–Peucker en grados; 0,00004° ≈ 4 m).
export function simplify(coords, epsilon = 0.00004) {
  if (coords.length < 3) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = deviation(coords[i], coords[a], coords[b]);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index > -1 && max > epsilon) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

function deviation(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (!dx && !dy) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const inFlight = new Map();
const failedAt = new Map();

// Devuelve { coords: [[lng, lat], ...], km, min } o null si no hay ruta (o el servicio falla).
export function fetchRoadRoute(points) {
  const key = keyOf(points);
  const hit = readRouteCache()[key]?.route;
  if (hit) return Promise.resolve(hit);
  if (points.length < 2 || points.length > 40) return Promise.resolve(null);
  if (Date.now() - (failedAt.get(key) ?? 0) < 120_000) return Promise.resolve(null);
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    try {
      await polite("osrm", 700);
      const coordinates = points.map((p) => `${p.lng},${p.lat}`).join(";");
      const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`);
      const data = await response.json();
      if (data.code !== "Ok" || !data.routes?.[0]) throw new Error(data.code || "sin ruta");
      const route = data.routes[0];
      const result = { coords: simplify(route.geometry.coordinates), km: route.distance / 1000, min: route.duration / 60 };
      cacheRoute(key, result);
      return result;
    } catch (err) {
      console.warn("Ruta por carretera no disponible:", err.message || err);
      failedAt.set(key, Date.now());
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}
