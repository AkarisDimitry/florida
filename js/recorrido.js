// Recorrido real de cada día: une, por orden de hora, los sitios con ubicación donde cada persona hizo algo ese día (una foto,
// un gasto…). Es la ruta que de verdad se hizo, a diferencia de la ruta planificada del itinerario. Código puro, sin
// dependencias del navegador, para poder probarlo aparte; js/maprecorrido.js lo conecta con los datos y con el mapa.

const R = 6371; // km
const rad = (d) => (d * Math.PI) / 180;

// Distancia en km entre dos puntos { lat, lng }.
export function distKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const keyOf = (name) => String(name ?? "").trim().toLowerCase();

// points: [{ who, day, t, lat, lng }] (t en milisegundos). Devuelve un recorrido por persona y día con al menos dos paradas
// distintas: [{ id, who, key, day, coords: [[lng, lat]…], km, n, from, to }], ordenados por día y por persona.
// Paradas consecutivas a menos de `minKm` (por defecto 30 m) cuentan como la misma.
export function buildTracks(points, { minKm = 0.03 } = {}) {
  const groups = new Map();
  for (const p of points) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !p.day || !Number.isFinite(p.t)) continue;
    const key = keyOf(p.who) || "viajero";
    const id = `${p.day}|${key}`;
    if (!groups.has(id)) groups.set(id, { id, who: String(p.who ?? "").trim() || "Viajero", key, day: p.day, list: [] });
    groups.get(id).list.push(p);
  }
  const tracks = [];
  for (const g of groups.values()) {
    g.list.sort((a, b) => a.t - b.t);
    const stops = [];
    for (const p of g.list) {
      const last = stops[stops.length - 1];
      if (!last || distKm(last, p) >= minKm) stops.push(p);
    }
    if (stops.length < 2) continue;
    let km = 0;
    for (let i = 1; i < stops.length; i++) km += distKm(stops[i - 1], stops[i]);
    tracks.push({ id: g.id, who: g.who, key: g.key, day: g.day, coords: stops.map((p) => [p.lng, p.lat]), km, n: stops.length, from: stops[0].t, to: stops[stops.length - 1].t });
  }
  return tracks.sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key));
}

// Un tono (0-359) estable para cada nombre, como el de los avatares de la web.
export function hueOfName(name) {
  let h = 0;
  for (const ch of String(name ?? "")) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
