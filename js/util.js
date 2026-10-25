import { config } from "./config.js";
import { settings } from "./settings.js";

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
export const reducedMotion = () => settings.animations === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches;
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
// Formatea una fecha tolerando valores vacíos o mal formados (devuelve "" en vez de lanzar un error).
export function safeFormat(formatter, value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : formatter.format(date);
}
export const money = new Intl.NumberFormat("es", { style: "currency", currency: config.trip.currency || "EUR" });

// Distancias y temperaturas según los ajustes de cada persona (km o millas, °C o °F).
export const formatKm = (km) => {
  const miles = settings.distance === "mi";
  const value = miles ? km * 0.621371 : km;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(".", ",")} ${miles ? "mi" : "km"}`;
};
export const formatTemp = (celsius) => (settings.temperature === "f" ? `${Math.round((celsius * 9) / 5 + 32)}°F` : `${Math.round(celsius)}°`);
export const formatDuration = (minutes) => {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
};
// "ahora mismo", "hace 5 min", "hace 3 h", "hace 2 días" a partir de una marca de tiempo en milisegundos.
export function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} ${days === 1 ? "día" : "días"}`;
}
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

export function hideToast() {
  clearTimeout(toast.timer);
  const el = $("#toast");
  el.classList.remove("show");
  el.hidden = true;
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
  // Fotos y audios en comentarios, notas de voz y compras (adjuntos.sql y compras.sql).
  if ((/schema cache|does not exist|could not find|permission denied/i.test(message) && /audios|attached_audio|attached_photo|on_photo|reply_to|expense_id|'kind'|'place'|'activity_id' column of 'photos'/i.test(message)) || /bucket not found/i.test(message)) {
    return new Error("Falta ejecutar supabase/todo_en_uno.sql en Supabase (fotos y audios en comentarios, compras). No hace daño repetirlo.");
  }
  // Solo cuando falta la tabla o la columna (o el permiso); un CHECK que falla también nombra "expenses" y no es esto.
  if (/schema cache|does not exist|permission denied|could not find the table/i.test(message) && /expenses|checklist_items|caption/i.test(message)) {
    return new Error("Falta ejecutar supabase/todo_en_uno.sql en Supabase (gastos, maleta y pies de foto). No hace daño repetirlo.");
  }
  if (/schema cache|does not exist|could not find the function/i.test(message) && /request_access|approve_access|deny_access|add_member|remove_member|list_members|access_requests|is_admin/i.test(message)) {
    return new Error("Falta ejecutar supabase/todo_en_uno.sql en Supabase (solicitudes de acceso y administradores). No hace daño repetirlo.");
  }
  if (/column|schema cache/i.test(message) && /lat|lng|rating|taken_at/i.test(message)) {
    return new Error("Falta ejecutar supabase/mapa.sql en Supabase (columnas nuevas de ubicación y valoración).");
  }
  return err;
}

// Errores al pedir el correo de acceso, con la causa real y qué hacer.
export function authHint(err) {
  const message = err?.message || String(err);
  if (/not authorized/i.test(message)) {
    return new Error("El servicio de correo de Supabase solo envía a quien administra el proyecto. Para que entre más gente hay que configurar un servidor de correo propio (ver docs/DESPLIEGUE.md, «Correo de acceso»).");
  }
  if (/rate limit/i.test(message)) return new Error("Se han pedido demasiados correos en poco tiempo. Espera unos minutos e inténtalo de nuevo.");
  if (/error sending|smtp/i.test(message)) return new Error("Supabase no pudo enviar el correo. Revisa la configuración del servidor de correo (ver docs/DESPLIEGUE.md).");
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
