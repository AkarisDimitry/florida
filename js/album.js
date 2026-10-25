// Modelo del álbum: reúne todo lo recogido (actividades, comentarios, fotos, rutas, gastos, comida) en una
// estructura lista para mostrarse en la página (albumview.js) o para el PDF (pdf.js). No toca el DOM.
import { config } from "./config.js";
import { state } from "./state.js";
import { hasCoords, categoryOf, utc, capitalize, fmtDayLong, fmtDayShort, dayColor, groupBy, formatKm, formatTemp, money } from "./util.js";
import { describeWeather } from "./weather.js";
import { allDays, byTime, locatedStops, currentRoutes, photoTime } from "./trip.js";
import { distanceKm } from "./geo.js";
import { balances, settlements, totalCents, fromCents, shares } from "./ledger.js";

const NEAR_KM = 0.35; // una foto con GPS se asocia a un lugar si se hizo a menos de 350 m
const pad = (n) => String(n).padStart(2, "0");

// Día (AAAA-MM-DD) al que pertenece una foto. `taken_at` es la hora de reloj de la cámara (UTC sin convertir);
// `created_at` es un instante real, así que se pasa a la fecha local.
export function photoDay(photo) {
  if (photo.taken_at) return photo.taken_at.slice(0, 10);
  const d = new Date(photo.created_at);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Cuenta por clave; las claves de texto se unen sin distinguir mayúsculas ("Ana" y "ana" son la misma persona).
const count = (items, key, weight = () => 1) => {
  const counts = new Map();
  const shown = new Map();
  for (const item of items) {
    const k = key(item);
    if (k === undefined || k === null || k === "" || Number.isNaN(k)) continue;
    const id = typeof k === "string" ? k.trim().toLowerCase() : k;
    if (!shown.has(id)) shown.set(id, typeof k === "string" ? k.trim() : k);
    counts.set(id, (counts.get(id) ?? 0) + weight(item));
  }
  return new Map([...counts].map(([id, n]) => [shown.get(id), n]));
};

const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

export function buildAlbum() {
  const days = allDays();
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const stops = locatedStops(days);
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const commentsByActivity = groupBy(
    [...state.comments].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    (c) => c.activity_id,
  );
  const photos = [...state.photos].sort((a, b) => photoTime(a).localeCompare(photoTime(b)));

  // 1. Cada foto va a un lugar (por GPS y fecha), a la galería de su día (solo por fecha) o a "más recuerdos".
  const byActivity = new Map();
  const byDay = new Map();
  const orphans = [];
  for (const photo of photos) {
    const day = photoDay(photo);
    const isTripDay = dayIndex.has(day);
    let target = null;
    if (hasCoords(photo)) {
      let best = Infinity;
      for (const stop of stops) {
        if (isTripDay && stop.day !== day) continue; // con fecha de viaje conocida, solo vale un lugar de ese día
        const d = distanceKm(photo, stop);
        if (d <= NEAR_KM && d < best) {
          target = stop;
          best = d;
        }
      }
    }
    if (target) push(byActivity, target.id, photo);
    else if (isTripDay) push(byDay, day, photo);
    else orphans.push(photo);
  }

  // 2. Capítulos: un día entra si tiene actividades o fotos.
  const routes = currentRoutes();
  const routeByDay = new Map(routes.map((r) => [r.day, r]));
  const chapters = [];
  for (const [i, day] of days.entries()) {
    const activities = state.activities.filter((a) => a.day === day).sort(byTime);
    const loosePhotos = byDay.get(day) ?? [];
    if (!activities.length && !loosePhotos.length) continue;
    const route = routeByDay.get(day) ?? null;
    const dayActivities = activities.map((a) => ({
      ...a,
      cat: categoryOf(a.category),
      stop: stopById.get(a.id) ?? null,
      order: stopById.get(a.id)?.order ?? null,
      photos: byActivity.get(a.id) ?? [],
      comments: commentsByActivity.get(a.id) ?? [],
    }));
    const city = state.places[day] ?? "";
    const weather = state.weather.get(day) ?? null;
    chapters.push({
      day,
      number: i + 1,
      color: dayColor(i),
      title: capitalize(fmtDayLong.format(utc(day))),
      shortTitle: capitalize(fmtDayShort.format(utc(day))),
      activities: dayActivities,
      city,
      weather,
      center: stops.find((s) => s.day === day) ?? null,
      summary: summarizeDay({ activities: dayActivities, loosePhotos, route, city, weather, cost: activities.reduce((sum, a) => sum + (a.cost || 0), 0) }),
      loosePhotos,
      route,
      km: route?.km ?? 0,
      cost: activities.reduce((sum, a) => sum + (a.cost || 0), 0),
      stops: stops.filter((s) => s.day === day),
    });
  }

  // 3. Gastos.
  const withCost = state.activities.filter((a) => a.cost > 0);
  const total = withCost.reduce((sum, a) => sum + a.cost, 0);
  const byCategory = [...groupBy(withCost, (a) => a.category)]
    .map(([key, list]) => ({ key, ...categoryOf(key), total: list.reduce((s, a) => s + a.cost, 0), count: list.length }))
    .sort((a, b) => b.total - a.total);
  const byDayCost = chapters.filter((c) => c.cost > 0).map((c) => ({ day: c.day, label: c.shortTitle, color: c.color, total: c.cost }));
  const expenses = {
    total,
    daysWithCost: byDayCost.length,
    perDay: byDayCost.length ? total / byDayCost.length : 0,
    byCategory,
    byDay: byDayCost,
    top: [...withCost].sort((a, b) => b.cost - a.cost).slice(0, 5),
  };

  // 4. Dónde comimos: mejor valorados primero.
  const activityPhotos = (a) => byActivity.get(a.id) ?? [];
  const food = state.activities
    .filter((a) => a.category === "comida")
    .map((a) => ({ ...a, photos: activityPhotos(a), dayTitle: capitalize(fmtDayShort.format(utc(a.day))) }))
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.day.localeCompare(b.day) || byTime(a, b));
  const rated = food.filter((f) => f.rating);

  // 5. Cifras y destacados.
  const km = routes.reduce((sum, r) => sum + r.km, 0);
  const authors = [...count([...state.activities, ...state.comments, ...state.photos], (x) => x.created_by_name).keys()];
  const busiest = [...chapters].sort((a, b) => b.activities.length - a.activities.length)[0];
  const longest = [...chapters].sort((a, b) => b.km - a.km)[0];
  const stats = {
    days: chapters.length,
    places: stops.length,
    activities: state.activities.length,
    km,
    kmByRoad: routes.length > 0 && routes.every((r) => r.road),
    photos: photos.length,
    photosLocated: photos.filter(hasCoords).length,
    comments: state.comments.length,
    spent: total,
    foodPlaces: food.length,
    foodAverage: rated.length ? rated.reduce((s, f) => s + f.rating, 0) / rated.length : null,
    authors,
  };
  const highlights = {
    topFood: rated[0] ?? null,
    priciest: expenses.top[0] ?? null,
    busiest: busiest && busiest.activities.length > 1 ? busiest : null,
    longest: longest && longest.km > 0 ? longest : null,
  };

  // 6. Portada: una foto por día (en orden) y, si faltan, las más recientes.
  const firstPerDay = new Map();
  for (const p of photos) if (!firstPerDay.has(photoDay(p))) firstPerDay.set(photoDay(p), p);
  const cover = [...firstPerDay.values()].slice(0, 5);
  for (const p of [...photos].reverse()) if (cover.length < 5 && !cover.includes(p)) cover.push(p);

  // 7. Anexos con los metadatos: lugares y fotos.
  const placeIndex = stops.map((s) => ({ ...s, dayTitle: capitalize(fmtDayShort.format(utc(s.day))) }));
  const photoIndex = photos.map((p, i) => ({
    n: i + 1,
    photo: p,
    day: photoDay(p),
    author: p.created_by_name || "",
    near: hasCoords(p) ? nearestStop(p, stops) : null,
  }));

  const ledger = state.expenses.length
    ? {
        total: fromCents(totalCents()),
        count: state.expenses.length,
        rows: balances().map((r) => ({ name: r.name, paid: fromCents(r.paid), owed: fromCents(r.owed), balance: fromCents(r.balance) })),
        payments: settlements().map((p) => ({ from: p.from, to: p.to, amount: fromCents(p.cents) })),
        items: [...state.expenses].sort((a, b) => a.day.localeCompare(b.day) || a.created_at.localeCompare(b.created_at)).map((e) => ({ ...e, amount: Number(e.amount), people: shares(e).size })),
      }
    : null;

  return {
    trip: config.trip,
    generatedAt: new Date(),
    chapters,
    orphans,
    ledger,
    awards: buildAwards({ photos, chapters, stops, byActivity, highlights, ledger }),
    expenses,
    food,
    stats,
    highlights,
    cover,
    routes,
    placeIndex,
    photoIndex,
    isEmpty: !state.activities.length && !photos.length,
  };
}

const hourOf = (p) => (p.taken_at ? Number(p.taken_at.slice(11, 13)) : new Date(p.created_at).getHours());

// Datos curiosos del viaje. Solo entran los que tienen datos suficientes (y los que comparan personas, si hay varias).
function buildAwards({ photos, chapters, stops, byActivity, highlights, ledger }) {
  const awards = [];
  const top = (counts) => [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "es"))[0];
  const photoAuthors = count(photos, (p) => p.created_by_name);
  if (photoAuthors.size >= 2) {
    const [name, n] = top(photoAuthors);
    awards.push({ emoji: "📸", title: "Fotógrafo del viaje", winner: name, detail: `${n} de ${photos.length} fotos` });
  }
  const commenters = count(state.comments, (c) => c.created_by_name);
  if (commenters.size >= 2) {
    const [name, n] = top(commenters);
    awards.push({ emoji: "💬", title: "El que más comenta", winner: name, detail: `${n} comentarios` });
  }
  if (ledger) {
    const payers = count(state.expenses, (e) => e.paid_by, (e) => Number(e.amount) || 0);
    if (payers.size >= 2) {
      const [name, amount] = top(payers);
      awards.push({ emoji: "💳", title: "El que más ha pagado", winner: name, detail: money.format(amount) });
    }
  }
  if (highlights.topFood) awards.push({ emoji: "🍽️", title: "Mejor sitio para comer", winner: highlights.topFood.title, detail: `${highlights.topFood.rating} de 5 estrellas` });
  if (highlights.priciest) awards.push({ emoji: "💸", title: "El mayor gasto", winner: highlights.priciest.title, detail: money.format(highlights.priciest.cost) });
  if (highlights.longest) awards.push({ emoji: "🚗", title: "Día de más carretera", winner: highlights.longest.shortTitle, detail: formatKm(highlights.longest.km) });
  if (highlights.busiest) awards.push({ emoji: "🎯", title: "Día más movido", winner: highlights.busiest.shortTitle, detail: `${highlights.busiest.activities.length} planes` });

  const photosByDay = count(photos, (p) => photoDay(p));
  if (photosByDay.size >= 2) {
    const [day, n] = top(photosByDay);
    const chapter = chapters.find((c) => c.day === day);
    if (n >= 3 && chapter) awards.push({ emoji: "🔥", title: "Día con más fotos", winner: chapter.shortTitle, detail: `${n} fotos` });
  }
  const stopPhotos = [...byActivity].map(([id, list]) => [stops.find((s) => s.id === id)?.title, list.length]).filter(([title, n]) => title && n >= 3);
  if (stopPhotos.length) {
    const [title, n] = top(stopPhotos);
    awards.push({ emoji: "🏞️", title: "Lugar más fotografiado", winner: title, detail: `${n} fotos` });
  }
  const hours = count(photos, (p) => hourOf(p));
  if (photos.length >= 5 && hours.size) {
    const [hour, n] = top(hours);
    awards.push({ emoji: "🌅", title: "Hora favorita para fotos", winner: `${pad(hour)}:00 - ${pad((hour + 1) % 24)}:00`, detail: `${n} fotos` });
  }
  return awards.slice(0, 8);
}

// Frase automática con lo más destacado del día.
function summarizeDay({ activities, loosePhotos, route, city, weather, cost }) {
  const bits = [];
  if (activities.length) bits.push(`${activities.length} ${activities.length === 1 ? "plan" : "planes"}${city ? ` en ${city}` : ""}`);
  else if (city) bits.push(`Día en ${city}`);
  if (route) bits.push(`${formatKm(route.km)} ${route.road ? "por carretera" : "en línea recta"}`);
  if (cost) bits.push(`${money.format(cost)} gastados`);
  let text = bits.length ? `${bits.slice(0, -1).join(", ")}${bits.length > 1 ? " y " : ""}${bits.at(-1)}.` : "";
  const best = [...activities].filter((a) => a.rating).sort((a, b) => b.rating - a.rating)[0];
  if (best) text += ` Lo mejor valorado: «${best.title}» (${best.rating}/5).`;
  const photos = activities.reduce((n, a) => n + a.photos.length, loosePhotos.length);
  if (photos) text += ` ${photos} ${photos === 1 ? "foto" : "fotos"}.`;
  if (weather?.tmax != null) {
    const [, label] = describeWeather(weather.code);
    text += ` ${weather.kind === "typical" ? "Tiempo típico de esas fechas" : "Tiempo"}: ${label.toLowerCase()}, ${formatTemp(weather.tmax)}/${formatTemp(weather.tmin)}.`;
  }
  return text.trim();
}

function nearestStop(photo, stops) {
  let best = null;
  let bestD = NEAR_KM;
  for (const s of stops) {
    const d = distanceKm(photo, s);
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}
