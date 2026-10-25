// Mapas como imagen (para el álbum en pantalla y para el PDF). Se dibuja un mapa MapLibre fuera de pantalla,
// se espera a que carguen las teselas y se copia el resultado a un <canvas> junto con las paradas numeradas.
// Hay un solo mapa a la vez (los navegadores limitan los contextos WebGL) y los resultados se guardan en memoria.
import { config } from "./config.js";

const ML = () => window.maplibregl;
const cache = new Map(); // firma -> Promise<dataURL | null>
let queue = Promise.resolve();

const signature = ({ stops, routes, width, height, numbered }) =>
  JSON.stringify([
    width,
    height,
    numbered,
    stops.map((s) => [s.id, s.lat, s.lng, s.order, s.color]),
    routes.map((r) => [r.day, r.road, r.coords.length, r.coords[0], r.coords[r.coords.length - 1]]),
  ]);

// Devuelve una imagen JPEG (data URL) o null si no se pudo dibujar (sin WebGL, sin conexión, tiempo agotado).
export function mapImage({ stops = [], routes = [], width = 900, height = 560, numbered = true } = {}) {
  if (!stops.length && !routes.length) return Promise.resolve(null);
  const options = { stops, routes, width, height, numbered };
  const key = signature(options);
  if (!cache.has(key)) {
    const job = queue.then(() => render(options)).catch((err) => {
      console.warn("No se pudo dibujar el mapa:", err.message || err);
      return null;
    });
    queue = job.then(() => {}, () => {});
    // Un fallo no se guarda: la próxima vez se reintenta.
    cache.set(key, job.then((image) => (image ?? (cache.delete(key), null))));
  }
  return cache.get(key);
}

const waitFor = (map, event, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tiempo agotado esperando "${event}"`)), ms);
    map.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });

async function render({ stops, routes, width, height, numbered }) {
  if (!ML()) throw new Error("la librería del mapa no está cargada");
  const ratio = 1.6;
  const holder = document.createElement("div");
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none`;
  document.body.append(holder);
  let map;
  try {
    map = new (ML().Map)({
      container: holder,
      style: config.map.styles.light,
      interactive: false,
      attributionControl: false,
      preserveDrawingBuffer: true, // sin esto el lienzo está en blanco al copiarlo
      fadeDuration: 0,
      pixelRatio: ratio,
      center: config.map.center,
      zoom: config.map.zoom,
    });
    await waitFor(map, "load", 15000);

    map.addSource("routes", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: routes.map((r) => ({ type: "Feature", properties: { color: r.color, road: r.road }, geometry: { type: "LineString", coordinates: r.coords } })),
      },
    });
    const layout = { "line-cap": "round", "line-join": "round" };
    map.addLayer({ id: "casing", type: "line", source: "routes", layout, paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.9 } });
    map.addLayer({ id: "solid", type: "line", source: "routes", filter: ["==", ["get", "road"], true], layout, paint: { "line-color": ["get", "color"], "line-width": 4.5 } });
    map.addLayer({ id: "dashed", type: "line", source: "routes", filter: ["==", ["get", "road"], false], layout, paint: { "line-color": ["get", "color"], "line-width": 4, "line-dasharray": [1.4, 1.6] } });

    const points = [...routes.flatMap((r) => r.coords), ...stops.map((s) => [s.lng, s.lat])];
    const bounds = points.reduce((b, c) => b.extend(c), new (ML().LngLatBounds)(points[0], points[0]));
    map.fitBounds(bounds, { padding: Math.round(Math.min(width, height) * 0.14), maxZoom: 14.5, duration: 0 });
    await waitFor(map, "idle", 20000);

    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(width * ratio), height: Math.round(height * ratio) });
    const g = canvas.getContext("2d");
    g.drawImage(map.getCanvas(), 0, 0, canvas.width, canvas.height);

    // Paradas: círculos del color del día (con su número en los mapas de un día).
    for (const stop of stops) {
      const p = map.project([stop.lng, stop.lat]);
      const x = p.x * ratio;
      const y = p.y * ratio;
      const radius = (numbered ? 13 : 6) * ratio;
      g.beginPath();
      g.arc(x, y, radius, 0, Math.PI * 2);
      g.fillStyle = stop.color;
      g.fill();
      g.lineWidth = 3 * ratio;
      g.strokeStyle = "#fff";
      g.stroke();
      if (numbered && stop.order) {
        g.fillStyle = "#fff";
        g.font = `700 ${12 * ratio}px system-ui, sans-serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(String(stop.order), x, y + ratio * 0.5);
      }
    }

    // Atribución obligatoria de los datos del mapa.
    const credit = "© colaboradores de OpenStreetMap · OpenFreeMap";
    g.font = `${10 * ratio}px system-ui, sans-serif`;
    g.textAlign = "right";
    g.textBaseline = "alphabetic";
    const w = g.measureText(credit).width + 12 * ratio;
    g.fillStyle = "rgba(255,255,255,0.8)";
    g.fillRect(canvas.width - w, canvas.height - 18 * ratio, w, 18 * ratio);
    g.fillStyle = "#334155";
    g.fillText(credit, canvas.width - 6 * ratio, canvas.height - 6 * ratio);

    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    map?.remove();
    holder.remove();
  }
}
