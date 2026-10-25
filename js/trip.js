// Datos derivados del estado: días, paradas con ubicación, rutas y fotos ordenadas.
import { config } from "./config.js";
import { state, ctx } from "./state.js";
import { hasCoords, utc, dayColor, groupBy, todayIso } from "./util.js";
import { distanceKm, pathKm, cachedRoute, fetchRoadRoute } from "./geo.js";

const { trip } = config;

export function allDays() {
  const days = new Set(state.activities.map((a) => a.day));
  if (trip.start && trip.end) {
    for (let t = utc(trip.start).getTime(); t <= utc(trip.end).getTime(); t += 864e5) {
      days.add(new Date(t).toISOString().slice(0, 10));
    }
  }
  return [...days].sort();
}

export const byTime = (a, b) =>
  (a.start_time || "99:99").localeCompare(b.start_time || "99:99") || a.created_at.localeCompare(b.created_at);

// Día por defecto de una actividad nueva: el seleccionado en el mapa, hoy si cae dentro del viaje, o el primer día.
export function defaultDay() {
  if (state.day) return state.day;
  const today = todayIso();
  if (trip.start && trip.end && (today < trip.start || today > trip.end)) return trip.start;
  return today;
}

export const photoTime = (p) => p.taken_at || p.created_at;
export const photosNewestFirst = () => [...state.photos].sort((a, b) => photoTime(b).localeCompare(photoTime(a)));

// Actividades con ubicación, en orden cronológico, con su número dentro del día y el color del día.
export function locatedStops(days = allDays()) {
  const stops = [];
  days.forEach((day, i) => {
    state.activities
      .filter((a) => a.day === day && hasCoords(a))
      .sort(byTime)
      .forEach((a, k) => stops.push({ ...a, order: k + 1, color: dayColor(i) }));
  });
  return stops;
}

export const stopsOfDay = (day) => locatedStops().filter((s) => s.day === day);
export const foodStops = () => state.activities.filter((a) => a.category === "comida").sort((a, b) => a.day.localeCompare(b.day) || byTime(a, b));

// Cada día tiene una ruta con sus paradas. Si el día empieza lejos de donde terminó el anterior
// (cambio de ciudad), la ruta arranca en la última parada del día anterior para dibujar ese trayecto.
export function routePlan(stops = locatedStops()) {
  const plan = [];
  let previous = null;
  for (const [day, list] of groupBy(stops, (s) => s.day)) {
    const points = list.map((s) => ({ lat: s.lat, lng: s.lng }));
    const last = points[points.length - 1];
    if (previous && distanceKm(previous, points[0]) > 0.3) points.unshift(previous);
    if (points.length >= 2) {
      plan.push({ day, color: list[0].color, points, key: points.map((p) => `${p.lat},${p.lng}`).join(";") });
    }
    previous = last;
  }
  return plan;
}

let notify = () => {};
export const onRoutesChange = (fn) => (notify = fn);
const pending = new Set();

// Rutas listas para dibujar. Con "carretera" usa la ruta guardada; si falta, la pide en segundo plano y
// mientras tanto dibuja líneas rectas. `notify` avisa cuando llega una ruta nueva.
export function currentRoutes() {
  return routePlan().map((item) => {
    if (state.roadMode) {
      const road = cachedRoute(item.points);
      if (road) return { ...item, coords: road.coords, km: road.km, min: road.min, road: true };
      if (!pending.has(item.key)) {
        pending.add(item.key);
        fetchRoadRoute(item.points).then((route) => {
          pending.delete(item.key);
          if (route) notify();
        });
      }
    }
    const coords = item.points.map((p) => [p.lng, p.lat]);
    return { ...item, coords, km: pathKm(coords), min: null, road: false };
  });
}

// Dónde consultar el tiempo y la ciudad de cada día: la primera parada con ubicación de ese día;
// los días sin ubicación heredan la del día anterior (o la primera del viaje).
export function dayTargets() {
  const days = allDays();
  const stops = locatedStops(days);
  if (!stops.length) return [];
  const firstOfDay = new Map();
  for (const s of stops) if (!firstOfDay.has(s.day)) firstOfDay.set(s.day, s);
  let last = stops[0];
  return days.map((day) => {
    last = firstOfDay.get(day) ?? last;
    return { day, lat: last.lat, lng: last.lng };
  });
}

// Viajeros que comparten su ubicación ahora mismo (sin contarme a mí y sin posiciones de hace más de 20 min).
export function friendsNow() {
  const me = ctx.store?.user?.id;
  return state.live.filter((r) => r.user_id !== me && Date.now() - Date.parse(r.updated_at) < 20 * 60_000);
}

export const totalCost = () => state.activities.reduce((sum, a) => sum + (a.cost || 0), 0);
