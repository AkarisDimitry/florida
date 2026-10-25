// Textos para compartir fuera de la web (WhatsApp, notas, correo…).
import { config } from "./config.js";
import { state } from "./state.js";
import { categoryOf, utc, capitalize, fmtDayLong, formatTemp, hasCoords, money } from "./util.js";
import { byTime } from "./trip.js";
import { describeWeather } from "./weather.js";

const mapLink = (a) => `https://maps.google.com/?q=${a.lat},${a.lng}`;

// El plan de un día como texto: hora, título, lugar y un enlace al mapa de cada sitio.
export function dayPlanText(day) {
  const items = state.activities.filter((a) => a.day === day).sort(byTime);
  const w = state.weather.get(day);
  const city = state.places[day];
  const head = [`📅 ${capitalize(fmtDayLong.format(utc(day)))} · ${config.trip.name}`];
  const meta = [city ? `📍 ${city}` : "", w?.tmax != null ? `${describeWeather(w.code)[0]} ${formatTemp(w.tmax)}/${formatTemp(w.tmin)}` : "", w?.sunrise ? `🌅 ${w.sunrise} · 🌇 ${w.sunset}` : ""].filter(Boolean);
  if (meta.length) head.push(meta.join("   "));
  const lines = items.flatMap((a) => {
    const where = a.place && a.place !== a.title ? ` — ${a.place}` : "";
    const cost = a.cost > 0 ? ` (${money.format(a.cost)})` : "";
    return [`${a.start_time ? a.start_time.slice(0, 5) : "  ·  "} ${categoryOf(a.category).emoji} ${a.title}${where}${cost}`, ...(hasCoords(a) ? [`      ${mapLink(a)}`] : [])];
  });
  return [...head, "", ...(lines.length ? lines : ["Sin planes todavía."]), "", `${location.origin}${location.pathname}`].join("\n");
}

// Lo que llega al compartir un sitio desde otra app (Google Maps, etc.): nombre, dirección y enlace.
// Si el enlace trae coordenadas se usan; si no, la actividad se propone sin ubicación y se busca por el nombre.
export function parseSharedPlace(raw) {
  const text = String(raw ?? "").trim();
  // Enlaces sin la puntuación que suele quedar pegada al final ("(https://…)." → "https://…").
  const urls = (text.match(/https?:\/\/\S+/g) ?? []).map((u) => u.replace(/[)\]}>.,;:!?'"]+$/, ""));
  const geo = text.match(/geo:\S+/g) ?? [];
  // Cada línea sin los enlaces que lleve dentro, y sin líneas repetidas (muchas apps mandan el nombre como título y
  // otra vez al principio del texto).
  const lines = [...new Set(text.split(/\r?\n/).map((l) => l.replace(/https?:\/\/\S+/g, "").replace(/geo:\S+/g, "").replace(/\s+/g, " ").replace(/[\s(\[{:;,\-–—]+$/, "").trim()).filter(Boolean))];
  const found = (u, re) => {
    const m = u.match(re);
    return m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180 && !(+m[1] === 0 && +m[2] === 0) ? [+m[1], +m[2]] : null;
  };
  // "!3d…!4d…" es el pin del sitio; "@lat,lng" es solo el centro de la vista del mapa, así que va después.
  const patterns = [/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/, /geo:(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, /[?&](?:q|ll|query|destination)=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i, /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, /[?&]center=(-?\d{1,3}\.\d+)(?:,|%2C)(-?\d{1,3}\.\d+)/i];
  let spot = null;
  for (const re of patterns) {
    for (const u of [...urls, ...geo]) {
      spot = found(u, re);
      if (spot) break;
    }
    if (spot) break;
  }
  const title = (lines[0] ?? "").slice(0, 120);
  const address = lines.slice(1).join(", ");
  return {
    title,
    place: title.slice(0, 200),
    notes: [address, ...new Set(urls)].filter(Boolean).join("\n").slice(0, 1900),
    lat: spot?.[0] ?? null,
    lng: spot?.[1] ?? null,
    query: [title, address].filter(Boolean).join(", "),
  };
}
