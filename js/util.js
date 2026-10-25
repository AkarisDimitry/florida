import { config } from "./config.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const utc = (iso) => new Date(`${iso}T00:00:00Z`);
export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const hasCoords = (o) => o != null && Number.isFinite(o.lat) && Number.isFinite(o.lng);
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

export const CATEGORIES = {
  comida: { emoji: "🍽️", label: "Comida" },
  visita: { emoji: "🏛️", label: "Visita" },
  transporte: { emoji: "🚆", label: "Transporte" },
  alojamiento: { emoji: "🏨", label: "Alojamiento" },
  ocio: { emoji: "🎉", label: "Ocio" },
  otro: { emoji: "📌", label: "Otro" },
};
export const categoryOf = (key) => CATEGORIES[key] || CATEGORIES.otro;

// Un color por día: sirve para chips, marcadores y rutas.
const DAY_COLORS = ["#0284c7", "#ea580c", "#059669", "#9333ea", "#dc2626", "#d97706", "#0d9488", "#db2777"];
export const dayColor = (index) => DAY_COLORS[((index % DAY_COLORS.length) + DAY_COLORS.length) % DAY_COLORS.length];

export const fmtDayLong = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
export const fmtDayShort = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
export const fmtDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const fmtStamp = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const fmtStampWallClock = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
export const money = new Intl.NumberFormat("es", { style: "currency", currency: config.trip.currency || "EUR" });

export const formatKm = (km) => (km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1).replace(".", ",")} km`);
export const formatDuration = (minutes) => {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
};
export const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

export function toast(message, ms = 5000) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  el.classList.remove("show");
  void el.offsetWidth; // reinicia la animación de entrada
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.classList.remove("show");
    el.hidden = true;
  }, ms);
}

export function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(err);
      toast(err.message || "Algo ha fallado");
    }
  };
}

// Si la base de datos aún no tiene las columnas nuevas, el error de Supabase es críptico: lo explicamos.
export function schemaHint(err) {
  const message = err?.message || String(err);
  if (/column|schema cache/i.test(message) && /lat|lng|rating|taken_at/i.test(message)) {
    return new Error("Falta ejecutar supabase/mapa.sql en Supabase (columnas nuevas de ubicación y valoración).");
  }
  return err;
}

export const slug = (text) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "viaje";

export function download(filename, mime, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
