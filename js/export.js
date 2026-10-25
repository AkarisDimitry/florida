// Extracción de datos: cada función genera un archivo y lo descarga en el dispositivo.
import { config } from "./config.js";
import { state } from "./state.js";
import { esc, categoryOf, download, slug, toast, hasCoords } from "./util.js";
import { currentRoutes, locatedStops, photoTime, photosNewestFirst, tripPhotos } from "./trip.js";
import { shares, isValid } from "./ledger.js";

const { trip } = config;
const stamp = () => new Date().toISOString().slice(0, 10);
const baseName = () => slug(trip.name);

// ---------- JSON: copia completa ----------

export function exportJson() {
  const payload = {
    exportado: new Date().toISOString(),
    viaje: trip,
    actividades: state.activities,
    comentarios: state.comments,
    gastos: state.expenses,
    maleta: state.checklist,
    // Los enlaces de las imágenes son temporales; las fotos en sí van en el ZIP.
    fotos: state.photos.map(({ full_url, thumb_url, ...meta }) => meta),
  };
  download(`${baseName()}-copia-${stamp()}.json`, "application/json", JSON.stringify(payload, null, 2));
}

// ---------- CSV: actividades (separador ";" y decimales con coma, como espera Excel en español) ----------

const NUMERIC = /^-?\d+(?:[.,]\d+)?$/;
const csvCell = (value) => {
  let s = value == null ? "" : String(value);
  // Evita que una hoja de cálculo ejecute un texto como fórmula (pero sin tocar los números negativos).
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const num = (n) => (n == null ? "" : String(n).replace(".", ","));

export function exportCsv() {
  const header = ["dia", "hora", "titulo", "tipo", "lugar", "latitud", "longitud", "coste", "valoracion", "notas", "autor"];
  const rows = [...state.activities]
    .sort((a, b) => a.day.localeCompare(b.day) || (a.start_time || "99").localeCompare(b.start_time || "99"))
    .map((a) => [a.day, a.start_time?.slice(0, 5), a.title, categoryOf(a.category).label, a.place, num(a.lat), num(a.lng), num(a.cost), a.rating, a.notes, a.created_by_name]);
  const text = [header, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n");
  download(`${baseName()}-actividades-${stamp()}.csv`, "text/csv", `﻿${text}`);
}

// Gastos repartidos: una fila por gasto, con quién pagó, entre quién se reparte y lo que le toca a cada uno.
export function exportExpensesCsv() {
  const header = ["dia", "tipo", "concepto", "tienda", "importe", "pago", "reparto", "autor"];
  const rows = [...state.expenses]
    .filter(isValid)
    .sort((a, b) => a.day.localeCompare(b.day) || a.created_at.localeCompare(b.created_at))
    // "reparto" usa el mismo cálculo que la web (en céntimos), no importe / personas: 10 € entre 3 son 3,34 + 3,33 + 3,33.
    .map((e) => [e.day, e.kind === "compra" ? "compra" : "gasto", e.title, e.place, num(Number(e.amount)), e.paid_by, [...shares(e)].map(([name, c]) => `${name}: ${num((c / 100).toFixed(2))}`).join("; "), e.created_by_name]);
  if (!rows.length) throw new Error("Todavía no hay gastos repartidos que exportar.");
  const text = [header, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n");
  download(`${baseName()}-gastos-${stamp()}.csv`, "text/csv", `﻿${text}`);
}

// ---------- GPX: lugares y rutas para apps de navegación y Google Earth ----------

export function exportGpx() {
  const waypoints = locatedStops().map(
    (s) =>
      `  <wpt lat="${s.lat}" lon="${s.lng}"><name>${esc(s.title)}</name><desc>${esc([s.day, s.start_time?.slice(0, 5), s.place].filter(Boolean).join(" · "))}</desc><type>${esc(categoryOf(s.category).label)}</type></wpt>`,
  );
  const tracks = currentRoutes().map(
    (r) =>
      `  <trk><name>${esc(r.day)}</name><trkseg>${r.coords.map(([lng, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`).join("")}</trkseg></trk>`,
  );
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Viaje colaborativo" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(trip.name)}</name></metadata>`,
    ...waypoints,
    ...tracks,
    "</gpx>",
  ].join("\n");
  download(`${baseName()}-ruta-${stamp()}.gpx`, "application/gpx+xml", xml);
}

// ---------- GeoJSON ----------

export function exportGeoJson() {
  const point = (lng, lat, properties) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates: [lng, lat] } });
  const features = [
    ...locatedStops().map((s) =>
      point(s.lng, s.lat, { tipo: "lugar", titulo: s.title, dia: s.day, hora: s.start_time?.slice(0, 5) ?? null, categoria: s.category, lugar: s.place, coste: s.cost, valoracion: s.rating }),
    ),
    ...tripPhotos().filter(hasCoords).map((p) => point(p.lng, p.lat, { tipo: "foto", id: p.id, fecha: photoTime(p), autor: p.created_by_name })),
    ...currentRoutes().map((r) => ({
      type: "Feature",
      properties: { tipo: "ruta", dia: r.day, km: Number(r.km.toFixed(1)), por_carretera: r.road },
      geometry: { type: "LineString", coordinates: r.coords },
    })),
  ];
  download(`${baseName()}-mapa-${stamp()}.geojson`, "application/geo+json", JSON.stringify({ type: "FeatureCollection", features }, null, 2));
}

// ---------- ICS: calendario del móvil ----------

const icsText = (s) => String(s ?? "").replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r?\n/g, "\\n");

// Las líneas del calendario no deben pasar de 75 bytes: se parten y se continúan con un espacio.
function fold(line) {
  const encoder = new TextEncoder();
  const parts = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > 72) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function exportIcs() {
  const dateOnly = (iso) => iso.replaceAll("-", "");
  const nextDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const nowStamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Viaje colaborativo//ES", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsText(trip.name)}`];
  for (const a of state.activities) {
    lines.push("BEGIN:VEVENT", `UID:${a.id}@viaje-colaborativo`, `DTSTAMP:${nowStamp}`);
    if (a.start_time) {
      // Hora "flotante": se muestra a la hora indicada en el huso del dispositivo, sin conversiones.
      lines.push(`DTSTART:${dateOnly(a.day)}T${a.start_time.slice(0, 5).replace(":", "")}00`, "DURATION:PT1H");
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(a.day)}`, `DTEND;VALUE=DATE:${dateOnly(nextDay(a.day))}`);
    }
    lines.push(`SUMMARY:${icsText(`${categoryOf(a.category).emoji} ${a.title}`)}`);
    if (a.place) lines.push(`LOCATION:${icsText(a.place)}`);
    if (hasCoords(a)) lines.push(`GEO:${a.lat};${a.lng}`);
    if (a.notes) lines.push(`DESCRIPTION:${icsText(a.notes)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  download(`${baseName()}-calendario.ics`, "text/calendar", lines.map(fold).join("\r\n") + "\r\n");
}

// ---------- ZIP: fotos ----------

async function loadJsZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("No se pudo cargar el compresor ZIP. Revisa la conexión."));
    document.head.append(script);
  });
  return window.JSZip;
}

export async function exportPhotosZip() {
  const photos = photosNewestFirst();
  if (!photos.length) throw new Error("Todavía no hay fotos que descargar.");
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  const index = [["archivo", "latitud", "longitud", "fecha", "autor", "pie_de_foto"]];
  for (const [i, photo] of photos.entries()) {
    toast(`Preparando fotos… ${i + 1} de ${photos.length}`, 120_000);
    const response = await fetch(photo.full_url);
    if (!response.ok) throw new Error("No se pudo descargar una de las fotos.");
    const when = photoTime(photo);
    const name = `${when.slice(0, 10)}_${when.slice(11, 16).replace(":", "")}_${slug(photo.created_by_name || "viajero")}_${photo.id.slice(0, 6)}.jpg`;
    zip.file(name, await response.blob());
    index.push([name, num(photo.lat), num(photo.lng), when, photo.created_by_name, photo.caption]);
  }
  zip.file("ubicaciones.csv", `﻿${index.map((r) => r.map(csvCell).join(";")).join("\r\n")}`);
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }); // los JPEG ya van comprimidos
  download(`${baseName()}-fotos-${stamp()}.zip`, "application/zip", blob);
  toast(`${photos.length} fotos descargadas`);
}

// El PDF del álbum es un módulo grande: solo se carga cuando se pide.
export const exportAlbum = async () => (await import("./pdf.js")).exportAlbumPdf();

export const EXPORTERS = { pdf: exportAlbum, json: exportJson, csv: exportCsv, gastos: exportExpensesCsv, gpx: exportGpx, geojson: exportGeoJson, ics: exportIcs, zip: exportPhotosZip };
