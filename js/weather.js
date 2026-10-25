// Tiempo de cada día del viaje (Open-Meteo, gratuito y sin clave):
//   - hasta 15 días por delante y hasta 7 hacia atrás: previsión / datos recientes
//   - días pasados más antiguos: datos registrados (archivo histórico)
//   - fechas lejanas: media de los últimos 5 años en esos mismos días ("típico de estas fechas")
// Los resultados se guardan en el navegador para no repetir consultas.
import { read, persist } from "./state.js";
import { todayIso, utc, groupBy } from "./util.js";

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const DAILY = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset";
const KEY = "viaje.tiempo";
const TTL = { forecast: 3 * 3600e3, observed: 60 * 864e5, typical: 60 * 864e5 };
const cache = read(KEY, {});

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const shiftDays = (day, n) => iso(utc(day).getTime() + n * 864e5);
const shiftYears = (day, n) => `${Number(day.slice(0, 4)) - n}${day.slice(4)}`;
const cellOf = (lat, lng) => `${lat.toFixed(1)},${lng.toFixed(1)}`;

// Códigos WMO del tiempo -> icono y descripción.
const WMO = {
  0: ["☀️", "Despejado"], 1: ["🌤️", "Casi despejado"], 2: ["⛅", "Parcialmente nublado"], 3: ["☁️", "Nublado"],
  45: ["🌫️", "Niebla"], 48: ["🌫️", "Niebla con escarcha"],
  51: ["🌦️", "Llovizna ligera"], 53: ["🌦️", "Llovizna"], 55: ["🌧️", "Llovizna intensa"], 56: ["🌧️", "Llovizna helada"], 57: ["🌧️", "Llovizna helada"],
  61: ["🌧️", "Lluvia ligera"], 63: ["🌧️", "Lluvia"], 65: ["🌧️", "Lluvia fuerte"], 66: ["🌧️", "Lluvia helada"], 67: ["🌧️", "Lluvia helada"],
  71: ["🌨️", "Nieve ligera"], 73: ["❄️", "Nieve"], 75: ["❄️", "Nieve fuerte"], 77: ["🌨️", "Granizo fino"],
  80: ["🌦️", "Chubascos ligeros"], 81: ["🌧️", "Chubascos"], 82: ["⛈️", "Chubascos violentos"], 85: ["🌨️", "Chubascos de nieve"], 86: ["🌨️", "Chubascos de nieve"],
  95: ["⛈️", "Tormenta"], 96: ["⛈️", "Tormenta con granizo"], 99: ["⛈️", "Tormenta con granizo"],
};
export const describeWeather = (code) => WMO[code] ?? ["🌡️", "Sin datos"];
export const WEATHER_KIND = { forecast: "Previsión", observed: "Registrado", typical: "Media de los últimos 5 años en estas fechas" };

async function fetchJson(base, params) {
  const url = new URL(base);
  url.search = new URLSearchParams(params);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo respondió ${response.status}`);
  return response.json();
}

// Convierte la respuesta "daily" en una lista de { day, code, tmax, tmin, rain, prob, sunrise, sunset }.
const rows = (json) =>
  (json.daily?.time ?? []).map((day, i) => ({
    day,
    code: json.daily.weather_code?.[i] ?? null,
    tmax: json.daily.temperature_2m_max?.[i] ?? null,
    tmin: json.daily.temperature_2m_min?.[i] ?? null,
    rain: json.daily.precipitation_sum?.[i] ?? null,
    prob: json.daily.precipitation_probability_max?.[i] ?? null,
    sunrise: json.daily.sunrise?.[i]?.slice(11, 16) ?? null,
    sunset: json.daily.sunset?.[i]?.slice(11, 16) ?? null,
  }));

const mean = (values) => {
  const list = values.filter((v) => v != null);
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
};
const mode = (values) => {
  const counts = new Map();
  for (const v of values.filter((x) => x != null)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

async function typicalFor(lat, lng, days) {
  const first = days.reduce((a, b) => (a < b ? a : b));
  const last = days.reduce((a, b) => (a > b ? a : b));
  const years = [];
  for (let k = 1; k <= 5; k++) {
    try {
      const json = await fetchJson(ARCHIVE, { latitude: lat, longitude: lng, daily: DAILY, timezone: "auto", start_date: shiftYears(first, k), end_date: shiftYears(last, k) });
      years.push(rows(json));
    } catch (err) {
      console.warn("Año sin datos de tiempo:", err.message || err);
    }
  }
  if (!years.length) return new Map();
  const span = (utc(last).getTime() - utc(first).getTime()) / 864e5;
  const result = new Map();
  for (const day of days) {
    const i = Math.round((utc(day).getTime() - utc(first).getTime()) / 864e5);
    if (i < 0 || i > span) continue;
    const sample = years.map((y) => y[i]).filter(Boolean);
    if (!sample.length) continue;
    result.set(day, {
      kind: "typical",
      tmax: mean(sample.map((s) => s.tmax)),
      tmin: mean(sample.map((s) => s.tmin)),
      rain: mean(sample.map((s) => s.rain)),
      prob: Math.round((sample.filter((s) => (s.rain ?? 0) >= 1).length / sample.length) * 100),
      code: mode(sample.map((s) => s.code)),
      sunrise: sample[0].sunrise,
      sunset: sample[0].sunset,
    });
  }
  return result;
}

// targets: [{ day, lat, lng }]. Devuelve Map(día -> datos del tiempo); lo que falle simplemente no aparece.
export async function loadWeather(targets) {
  const today = todayIso();
  const result = new Map();
  for (const [cell, list] of groupBy(targets, (t) => cellOf(t.lat, t.lng))) {
    const { lat, lng } = list[0];
    const store = (cache[cell] ??= {});
    const need = { forecast: [], observed: [], typical: [] };
    for (const { day } of list) {
      const hit = store[day];
      if (hit && Date.now() - hit.t < TTL[hit.kind]) result.set(day, hit);
      else if (day > shiftDays(today, 15)) need.typical.push(day);
      else if (day >= shiftDays(today, -7)) need.forecast.push(day);
      else need.observed.push(day);
    }
    const keep = (day, record, kind) => {
      store[day] = { ...record, kind, t: Date.now() };
      result.set(day, store[day]);
    };
    try {
      if (need.forecast.length) {
        const json = await fetchJson(FORECAST, { latitude: lat, longitude: lng, daily: `${DAILY},precipitation_probability_max`, timezone: "auto", past_days: "7", forecast_days: "16" });
        for (const r of rows(json)) if (need.forecast.includes(r.day)) keep(r.day, r, r.day < today ? "observed" : "forecast");
      }
      if (need.observed.length) {
        const first = need.observed.reduce((a, b) => (a < b ? a : b));
        const last = need.observed.reduce((a, b) => (a > b ? a : b));
        const json = await fetchJson(ARCHIVE, { latitude: lat, longitude: lng, daily: DAILY, timezone: "auto", start_date: first, end_date: last });
        for (const r of rows(json)) if (need.observed.includes(r.day)) keep(r.day, r, "observed");
      }
      if (need.typical.length) for (const [day, record] of await typicalFor(lat, lng, need.typical)) keep(day, record, "typical");
    } catch (err) {
      console.warn("No se pudo obtener el tiempo:", err.message || err);
    }
    persist(KEY, cache);
  }
  return result;
}

// Consejos automáticos para la maleta a partir del tiempo de varios días.
export function packingTips(records) {
  const list = records.filter(Boolean);
  if (!list.length) return [];
  const tmax = Math.max(...list.map((w) => w.tmax ?? -99));
  const tmin = Math.min(...list.map((w) => w.tmin ?? 99));
  const rainy = list.some((w) => (w.prob ?? 0) >= 40 || (w.rain ?? 0) >= 5);
  const tips = [];
  if (tmax >= 24) tips.push("☀️ Protector solar y gorra");
  if (tmax >= 28) tips.push("💧 Botella de agua");
  if (rainy) tips.push("☂️ Paraguas o chubasquero");
  if (tmin <= 8) tips.push("🧥 Ropa de abrigo");
  else if (tmin <= 15) tips.push("🧥 Una chaqueta ligera");
  return tips;
}
