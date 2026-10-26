// El «contexto del viaje» que se manda a la IA: un resumen compacto, en texto plano, de lo que hay apuntado (días con horas, lugares, notas
// y costes; el tiempo y la ciudad de cada día; gastos; fotos con su pie; comentarios). Es lo único que ve la IA del viaje, y no se guarda.
// Módulo PURO (sin DOM ni red): recibe los datos ya reunidos y devuelve un texto de como máximo `maxChars` caracteres (el servidor rechaza
// más de 8.000). Lo que cabe se decide por cercanía al día de hoy: el día en curso va con todo detalle; los más lejanos se resumen.
// Prueba: docs/pruebas-js/ia-contexto.test.mjs.

export const TRIP_CHARS = 7800; // por debajo de los 8.000 que admite el servidor
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Una línea: sin saltos ni espacios repetidos, recortada con «…».
export const oneLine = (text, max) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…` : s;
};
const quote = (text, max) => `«${oneLine(text, max).replace(/[«»]/g, "")}»`;

export const weekdayOf = (iso) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? "";
const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
const money = (n, fmt) => (fmt ? fmt(n) : String(Math.round(n * 100) / 100).replace(".", ","));

function weatherLine(w, label) {
  if (!w || (w.tmax == null && w.code == null)) return "";
  const parts = [];
  if (w.code != null && label) parts.push(label(w.code));
  if (w.tmax != null) parts.push(`${Math.round(w.tmax)}°${w.tmin != null ? `/${Math.round(w.tmin)}°` : ""}`);
  if (w.prob != null) parts.push(`lluvia ${w.prob} %`);
  if (w.sunset) parts.push(`sol se pone ${w.sunset}`);
  return `${parts.join(", ")}${w.kind === "typical" ? " (típico de esas fechas)" : ""}`;
}

// Todo lo de un día, ya ordenado y recortado: lo usan el contexto general y el del resumen del día.
function dayFacts(data, day, { notes = 120, comments = 6, captions = 5, commentChars = 110 } = {}) {
  const activities = data.activities
    .filter((a) => a.day === day)
    .sort((a, b) => (a.start_time || "99:99").localeCompare(b.start_time || "99:99") || String(a.title).localeCompare(String(b.title)));
  const ids = new Set(activities.map((a) => a.id));
  const photoDay = data.photoDay ?? ((p) => String(p.taken_at || p.created_at || "").slice(0, 10));
  const photos = data.photos.filter((p) => !p.expense_id && (p.activity_id && ids.has(p.activity_id) ? true : photoDay(p) === day));
  const photoIds = new Set(photos.map((p) => p.id));
  const comments_ = data.comments
    .filter((c) => c.body && ((c.activity_id && ids.has(c.activity_id)) || (c.on_photo && photoIds.has(c.on_photo))))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-comments);
  const spent = data.expenses.filter((e) => e.day === day);
  return {
    activities,
    photos,
    captions: photos.filter((p) => p.caption).slice(0, captions),
    comments: comments_,
    expenses: spent,
    total: spent.reduce((s, e) => s + Number(e.amount || 0), 0),
    notes,
    commentChars,
  };
}

function activityLine(a, data, level, notes) {
  const bits = [`${hhmm(a.start_time) || "  ?  "} ${oneLine(a.title, 70)}`];
  if (level >= 1) {
    if (a.place && a.place !== a.title) bits.push(`en ${oneLine(a.place, 50)}`);
  }
  if (level >= 2) {
    const label = data.categoryLabel?.(a.category);
    if (label) bits.push(`[${label}]`);
    if (a.cost != null && Number(a.cost) > 0) bits.push(money(Number(a.cost), data.money));
    if (a.rating) bits.push(`★${a.rating}`);
    if (a.notes) bits.push(`nota: ${quote(a.notes, notes)}`);
  }
  return `  ${bits.join(" · ")}`;
}

// Un día en uno de cuatro niveles de detalle: 2 = completo, 1 = lugares, 0 = solo los títulos, -1 = una línea.
export function dayBlock(data, day, level, opts = {}) {
  const f = dayFacts(data, day, opts);
  const city = data.places?.[day];
  const w = weatherLine(data.weather?.[day], data.weatherLabel);
  const head = `${day} (${weekdayOf(day)})${city ? ` · ${oneLine(city, 40)}` : ""}${w && level >= 1 ? ` · ${w}` : ""}`;
  if (level <= -1) return `${head}: ${f.activities.length} ${f.activities.length === 1 ? "plan" : "planes"}${f.photos.length ? `, ${f.photos.length} fotos` : ""}`;
  if (level === 0) return `${head}: ${f.activities.length ? f.activities.slice(0, 8).map((a) => oneLine(a.title, 40)).join("; ") : "sin planes"}`;
  const lines = [head];
  const maxActivities = level >= 2 ? 14 : 10;
  for (const a of f.activities.slice(0, maxActivities)) lines.push(activityLine(a, data, level, f.notes));
  if (f.activities.length > maxActivities) lines.push(`  (+${f.activities.length - maxActivities} planes más)`);
  if (!f.activities.length) lines.push("  sin planes apuntados");
  if (f.expenses.length) {
    if (level >= 2) {
      const list = f.expenses.slice(0, 6).map((e) => `${oneLine(e.title, 30)} ${money(Number(e.amount || 0), data.money)}${e.paid_by ? ` (pagó ${oneLine(e.paid_by, 20)})` : ""}`);
      lines.push(`  Gastos: ${list.join("; ")}${f.expenses.length > 6 ? `; +${f.expenses.length - 6} más` : ""} · total ${money(f.total, data.money)}`);
    } else lines.push(`  Gastos del día: ${money(f.total, data.money)}`);
  }
  if (f.photos.length) {
    lines.push(`  Fotos: ${f.photos.length}${level >= 2 && f.captions.length ? ` · pies: ${f.captions.map((p) => quote(p.caption, 60)).join(", ")}` : ""}`);
  }
  if (level >= 2 && f.comments.length) {
    lines.push(`  Comentarios: ${f.comments.map((c) => `${oneLine(c.created_by_name || "alguien", 20)}: ${quote(c.body, f.commentChars)}`).join(" | ")}`);
  }
  return lines.join("\n");
}

// El día sobre el que se pregunta: hoy si cae en el viaje; si no, el primero que queda o el último.
export function focusIndex(days, today) {
  if (!days.length) return 0;
  const i = days.indexOf(today);
  if (i >= 0) return i;
  const next = days.findIndex((d) => d > today);
  return next >= 0 ? next : days.length - 1;
}

function header(data) {
  const { trip = {}, today } = data;
  const people = (data.people ?? []).slice(0, 12).map((p) => oneLine(p, 20));
  return [
    `Hoy: ${today} (${weekdayOf(today)}).`,
    `Viaje «${oneLine(trip.name || "Nuestro viaje", 60)}»${trip.destination ? ` a ${oneLine(trip.destination, 60)}` : ""}${trip.start && trip.end ? `, del ${trip.start} al ${trip.end}` : ""}.`,
    people.length ? `Viajeros: ${people.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function expensesSummary(data) {
  if (!data.expenses.length) return "";
  const total = data.expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const byCat = new Map();
  for (const e of data.expenses) byCat.set(e.category || "otros", (byCat.get(e.category || "otros") ?? 0) + Number(e.amount || 0));
  const parts = [...byCat].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${money(v, data.money)}`);
  return `GASTOS DEL VIAJE: ${money(total, data.money)} en total (${parts.join(", ")}).`;
}

// El contexto general (asistente). Siempre cabe en `maxChars`: si hace falta, los días más lejanos del de hoy pierden detalle y, al final,
// desaparecen (con un aviso de cuántos días se han omitido).
export function buildTripContext(data, { maxChars = TRIP_CHARS } = {}) {
  const days = [...new Set(data.days ?? [])].sort();
  const head = header(data);
  const tail = expensesSummary(data);
  if (!days.length) return `${head}\nTodavía no hay días ni planes apuntados.`.slice(0, maxChars);
  const focus = focusIndex(days, data.today);
  const level = new Map(days.map((d) => [d, d === days[focus] ? 2 : 1])); // el día en curso, completo; los demás, con lugares
  const near = (d) => Math.abs(days.indexOf(d) - focus);
  const opts = (d) => (d === days[focus] ? { notes: 160, comments: 8, captions: 6 } : { notes: 80, comments: 3, captions: 2, commentChars: 80 });
  const build = () => {
    const blocks = days.map((d) => (level.get(d) <= -2 ? null : dayBlock(data, d, level.get(d), opts(d)))).filter(Boolean);
    const omitted = days.filter((d) => level.get(d) <= -2).length;
    return [head, "DÍAS", ...blocks, omitted ? `(${omitted} ${omitted === 1 ? "día más no cabe" : "días más no caben"} aquí)` : "", tail].filter(Boolean).join("\n");
  };
  let text = build();
  // Bajar de nivel por fases: primero lo más lejano (y, a igual distancia, lo ya pasado antes que lo que queda por hacer); el día en curso
  // es lo último que se resume.
  const order = [...days].sort((a, b) => near(b) - near(a) || (a < days[focus] ? -1 : 1) - (b < days[focus] ? -1 : 1) || b.localeCompare(a));
  const phases = [["others", 0], ["others", -1], ["focus", 1], ["others", -2], ["focus", 0], ["focus", -1]];
  for (const [who, to] of phases) {
    for (const d of order) {
      if (text.length <= maxChars) break;
      if ((who === "focus") !== (d === days[focus])) continue;
      if (level.get(d) > to) {
        level.set(d, to);
        text = build();
      }
    }
    if (text.length <= maxChars) break;
  }
  // Último recurso (no debería hacer falta): corte duro.
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

// El contexto de UN día para el resumen: todo lo de ese día con más detalle que en el contexto general.
export function buildDayContext(data, day, { maxChars = TRIP_CHARS } = {}) {
  const f = dayFacts(data, day, { notes: 240, comments: 14, captions: 12, commentChars: 180 });
  if (!f.activities.length && !f.photos.length && !f.comments.length && !f.expenses.length) return "";
  const people = [...new Set([...f.photos.map((p) => p.created_by_name), ...f.comments.map((c) => c.created_by_name), ...f.activities.map((a) => a.created_by_name)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "es")).slice(0, 10);
  const lines = [header({ ...data, people }), "", dayBlock(data, day, 2, { notes: 240, comments: 14, captions: 12, commentChars: 180 })];
  const w = data.weather?.[day];
  if (w?.sunrise) lines.push(`  Amanecer ${w.sunrise}, atardecer ${w.sunset ?? "?"}`);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

// Preguntas rápidas del asistente.
export const QUICK_QUESTIONS = [
  { label: "¿Qué hacemos mañana?", text: "¿Qué hacemos mañana? Dame un plan con horas, teniendo en cuenta lo que ya está apuntado." },
  { label: "Plan B si llueve", text: "Si llueve, ¿cuál es el plan B para hoy o mañana? Dame 2 o 3 opciones cubiertas." },
  { label: "¿Dónde cenamos cerca de hoy?", text: "¿Dónde podríamos cenar cerca de los sitios de hoy? Dame 3 ideas con el tipo de comida." },
  { label: "Resume el día de hoy", text: "Resume en pocas líneas cómo va el día de hoy: qué toca, qué falta y el tiempo." },
  { label: "Ideas de fotos", text: "Dame 5 ideas de fotos divertidas para hacer hoy en los sitios del plan." },
];
