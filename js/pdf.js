// Álbum del viaje en PDF (jsPDF, cargado solo al exportar). Texto vectorial (seleccionable), mapas e imágenes
// incrustados, enlaces a los lugares y metadatos del documento. Todo se monta en el navegador y se descarga directo.
import { state } from "./state.js";
import { toast, hideToast, slug, download, hasCoords, money, formatKm, formatTemp, utc, sleep, safeFormat, $ } from "./util.js";
import { settings } from "./settings.js";
import { loadWeather, describeWeather } from "./weather.js";
import { cityName, nearbyWiki } from "./places.js";
import { buildAlbum } from "./album.js";
import { mapImage } from "./mapimage.js";
import { fetchRoadRoute } from "./geo.js";
import { routePlan, dayTargets } from "./trip.js";
import { CATEGORIES } from "./categorias.js";

const JSPDF = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
const W = 210;
const H = 297;
const M = 14; // margen
const CW = W - 2 * M; // ancho útil
const LIMIT = H - 20; // por debajo no se escribe: ahí va el pie
const PT = 0.3528; // mm por punto tipográfico
const C = { ink: "#0f172a", muted: "#5b6b82", line: "#d9e0ea", soft: "#f3f6fb", brand: "#0369a1", brand2: "#0f766e", gold: "#f59e0b", white: "#ffffff" };

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Las fuentes estándar del PDF solo llevan Latin-1: se cambian o quitan los símbolos que no existen
// (emojis, ★, ≈…). Los acentos, la ñ, el € y las comillas tipográficas sí se conservan.
const SWAPS = { "≈": "~", "→": "->", "★": "*", "✓": "ok", "→": "->" };
export const latin = (text) =>
  String(text ?? "")
    .normalize("NFC")
    .replace(/[≈→★✓]/g, (c) => SWAPS[c])
    .replace(/[^\n -~ -ÿ–—‘’“”•…€]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

const capDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const capDateWall = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const fullDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "long", year: "numeric" });
const capDay = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", timeZone: "UTC" });
const when = (p) => safeFormat(p.taken_at ? capDateWall : capDate, p.taken_at || p.created_at);
const coords = (o) => `${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}`;
const mapsUrl = (o) => `https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}`;

async function loadJsPdf() {
  if (!window.jspdf) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = JSPDF;
      script.onload = resolve;
      script.onerror = () => reject(new Error("No se pudo cargar el generador de PDF. Revisa la conexión."));
      document.head.append(script);
    });
  }
  return window.jspdf.jsPDF;
}

// ---------- imágenes ----------

async function loadPhoto(url, maxSide, { bitmap = false, quality = 0.8 } = {}) {
  const blob = await (await fetch(url)).blob();
  const source = await createImageBitmap(blob);
  const ratio = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(source.width * ratio), height: Math.round(source.height * ratio) });
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const result = { data: canvas.toDataURL("image/jpeg", quality), w: canvas.width, h: canvas.height };
  if (bitmap) result.canvas = canvas;
  return result;
}

const emojiCache = new Map();
function emojiPng(emoji) {
  if (!emojiCache.has(emoji)) {
    const canvas = Object.assign(document.createElement("canvas"), { width: 96, height: 96 });
    const g = canvas.getContext("2d");
    g.font = "74px serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(emoji, 48, 52);
    emojiCache.set(emoji, canvas.toDataURL("image/png"));
  }
  return emojiCache.get(emoji);
}

// Como "object-fit: cover": rellena el rectángulo recortando lo que sobre.
function drawCover(g, image, x, y, w, h) {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  g.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

function coverCanvas(images) {
  const cw = 1240;
  const ch = 1754;
  const canvas = Object.assign(document.createElement("canvas"), { width: cw, height: ch });
  const g = canvas.getContext("2d");
  const base = g.createLinearGradient(0, 0, cw, ch);
  base.addColorStop(0, "#0369a1");
  base.addColorStop(1, "#0f766e");
  g.fillStyle = base;
  g.fillRect(0, 0, cw, ch);

  const gap = 8;
  const top = 1130;
  const n = images.length;
  if (n === 1) drawCover(g, images[0], 0, 0, cw, top);
  else if (n === 2) {
    drawCover(g, images[0], 0, 0, cw / 2 - gap / 2, top);
    drawCover(g, images[1], cw / 2 + gap / 2, 0, cw / 2 - gap / 2, top);
  } else if (n === 3) {
    drawCover(g, images[0], 0, 0, 740, top);
    drawCover(g, images[1], 740 + gap, 0, cw - 740 - gap, top / 2 - gap / 2);
    drawCover(g, images[2], 740 + gap, top / 2 + gap / 2, cw - 740 - gap, top / 2 - gap / 2);
  } else if (n >= 4) {
    drawCover(g, images[0], 0, 0, 740, top);
    const cell = (cw - 740 - gap * 2) / 2;
    const rows = (top - gap) / 2;
    [images[1], images[2], images[3], images[4]].forEach((image, i) => {
      if (image) drawCover(g, image, 740 + gap + (i % 2) * (cell + gap), Math.floor(i / 2) * (rows + gap), cell, rows);
      else {
        g.fillStyle = "rgba(255,255,255,0.12)";
        g.fillRect(740 + gap + (i % 2) * (cell + gap), Math.floor(i / 2) * (rows + gap), cell, rows);
      }
    });
  } else {
    g.fillStyle = "rgba(255,255,255,0.08)";
    for (const [x, y, r] of [[280, 360, 320], [960, 640, 420], [520, 900, 200]]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const fade = g.createLinearGradient(0, n ? 700 : 0, 0, ch);
  fade.addColorStop(0, "rgba(6,38,58,0)");
  fade.addColorStop(0.42, "rgba(6,38,58,0.92)");
  fade.addColorStop(1, "#06263a");
  g.fillStyle = fade;
  g.fillRect(0, n ? 700 : 0, cw, ch);
  return canvas.toDataURL("image/jpeg", 0.86);
}

// ---------- el libro ----------

class Book {
  constructor(jsPDF, album, maps, images, { opts, wiki }) {
    this.doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
    this.album = album;
    this.maps = maps;
    this.images = images;
    this.opts = opts;
    this.wiki = wiki;
    this.y = M;
    this.context = ""; // texto del encabezado de las páginas siguientes
    this.labels = new Map(); // nº de página -> { text, banded }
    this.labels.set(1, { cover: true });
  }

  fill(hex) { this.doc.setFillColor(...rgb(hex)); }
  ink(hex) { this.doc.setTextColor(...rgb(hex)); }
  stroke(hex) { this.doc.setDrawColor(...rgb(hex)); }
  get pageNumber() { return this.doc.internal.getCurrentPageInfo().pageNumber; }

  page(label = this.context, banded = false) {
    this.doc.addPage();
    this.labels.set(this.pageNumber, { text: label, banded });
    this.y = M + 6;
  }

  need(h) {
    if (this.y + h > LIMIT) this.page();
  }

  // Párrafo con saltos de línea y de página automáticos.
  text(str, { size = 10, style = "normal", color = C.ink, x = M, w = CW, lh = 1.4, gap = 1.2 } = {}) {
    const d = this.doc;
    d.setFont("helvetica", style);
    d.setFontSize(size);
    this.ink(color);
    const lineH = size * PT * lh;
    const lines = d.splitTextToSize(latin(str), w);
    for (const line of lines) {
      this.need(lineH);
      d.text(line, x, this.y + size * PT * 0.85);
      this.y += lineH;
    }
    this.y += gap;
    return lines.length;
  }

  heading(str, { size = 18, color = C.ink } = {}) {
    this.need(size * PT * 2 + 6);
    this.fill(C.brand);
    this.doc.roundedRect(M, this.y + 1, 2.2, size * PT * 1.3, 1, 1, "F");
    this.text(str, { size, style: "bold", color, x: M + 6, w: CW - 6, gap: 3 });
  }

  subheading(str) {
    this.y += 2;
    this.text(str.toUpperCase(), { size: 8.5, style: "bold", color: C.muted, gap: 1.6 });
  }

  // Estrellas dibujadas (la fuente del PDF no tiene ★). Devuelve el ancho ocupado.
  stars(x, cy, n, r = 1.7) {
    const d = this.doc;
    for (let i = 0; i < 5; i++) {
      const cx = x + r + i * (r * 2 + 0.7);
      const pts = Array.from({ length: 10 }, (_, k) => {
        const a = (-90 + k * 36) * (Math.PI / 180);
        const rr = k % 2 ? r * 0.45 : r;
        return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
      });
      this.fill(i < n ? C.gold : C.line);
      d.lines(pts.slice(1).map((p, k) => [p[0] - pts[k][0], p[1] - pts[k][1]]), pts[0][0], pts[0][1], [1, 1], "F", true);
    }
    return 5 * (r * 2 + 0.7);
  }

  // Línea de datos con piezas: texto, { url, text } (enlace) o { stars }.
  meta(parts, { x = M, w = CW, size = 8.8 } = {}) {
    const d = this.doc;
    d.setFont("helvetica", "normal");
    d.setFontSize(size);
    const lineH = size * PT * 1.6;
    this.need(lineH);
    const sep = "  ·  ";
    let cx = x;
    parts.forEach((part, i) => {
      const text = typeof part === "string" ? latin(part) : latin(part.text ?? "");
      const itemW = part.stars ? 5 * 4.1 : d.getTextWidth(text);
      const sepW = i && cx > x ? d.getTextWidth(sep) : 0;
      if (cx > x && cx + sepW + itemW > x + w) {
        this.y += lineH;
        this.need(lineH);
        cx = x;
      } else if (sepW) {
        this.ink(C.line);
        d.text(sep, cx, this.y + size * PT * 0.95);
        cx += sepW;
      }
      if (part.stars) cx += this.stars(cx, this.y + lineH / 2 - 0.2, part.stars);
      else {
        d.setFont("helvetica", "normal");
        d.setFontSize(size);
        this.ink(part.url ? C.brand : C.muted);
        d.text(text, cx, this.y + size * PT * 0.95);
        if (part.url) d.link(cx, this.y, itemW, lineH, { url: part.url });
        cx += itemW;
      }
    });
    this.y += lineH + 0.8;
  }

  quote(c, { x, w, color }) {
    const d = this.doc;
    d.setFont("helvetica", "italic");
    d.setFontSize(9);
    const lines = d.splitTextToSize(`“${latin(c.body)}”`, w - 6);
    const lineH = 9 * PT * 1.4;
    const h = lines.length * lineH + 4.4;
    this.need(h);
    this.fill(color);
    d.rect(x, this.y, 0.9, h - 1, "F");
    this.ink(C.ink);
    d.setFont("helvetica", "italic");
    d.setFontSize(9);
    lines.forEach((line, i) => d.text(line, x + 4, this.y + 9 * PT * 0.85 + i * lineH));
    d.setFont("helvetica", "bold");
    d.setFontSize(7.6);
    this.ink(C.muted);
    d.text(latin(c.created_by_name || "Alguien"), x + 4, this.y + lines.length * lineH + 2.6);
    this.y += h + 1;
  }

  photoGrid(photos, { x = M, w = CW, cols = 3, boxH = 38, gap = 3 } = {}) {
    if (!photos.length) return;
    const d = this.doc;
    const cellW = (w - gap * (cols - 1)) / cols;
    for (let i = 0; i < photos.length; i += cols) {
      const row = photos.slice(i, i + cols);
      const rowH = boxH + 9 + (row.some((p) => p.caption) ? 3.6 : 0);
      this.need(rowH);
      row.forEach((p, k) => {
        const cx = x + k * (cellW + gap);
        const img = this.images.get(p.id);
        this.fill(C.soft);
        d.rect(cx, this.y, cellW, boxH, "F");
        if (img) {
          const scale = Math.min(cellW / img.w, boxH / img.h);
          const iw = img.w * scale;
          const ih = img.h * scale;
          d.addImage(img.data, "JPEG", cx + (cellW - iw) / 2, this.y + (boxH - ih) / 2, iw, ih, undefined, "FAST");
        } else {
          d.setFont("helvetica", "italic");
          d.setFontSize(7.5);
          this.ink(C.muted);
          d.text("foto no disponible", cx + cellW / 2, this.y + boxH / 2, { align: "center" });
        }
        let ty = this.y + boxH + 3.4;
        if (p.caption) {
          d.setFont("helvetica", "italic");
          d.setFontSize(7.6);
          this.ink(C.ink);
          const lines = d.splitTextToSize(latin(p.caption), cellW);
          d.text(lines.length > 1 ? `${lines[0].replace(/\s+\S*$/, "")}...` : lines[0] ?? "", cx, ty, { maxWidth: cellW });
          ty += 3.6;
        }
        d.setFont("helvetica", "normal");
        d.setFontSize(7.2);
        this.ink(C.muted);
        d.text(latin(`${p.created_by_name ? `${p.created_by_name}  ·  ` : ""}${when(p)}`), cx, ty, { maxWidth: cellW });
        if (hasCoords(p)) {
          this.ink("#8a98ad");
          d.text(coords(p), cx, ty + 3.2, { maxWidth: cellW });
          d.link(cx, ty + 0.8, cellW, 3, { url: mapsUrl(p) });
        }
      });
      this.y += rowH;
    }
  }

  mapPicture(id, caption) {
    const image = this.maps.get(id);
    if (!image) return;
    const h = (CW * 520) / 900;
    this.need(h + 6);
    this.doc.addImage(image, "JPEG", M, this.y, CW, h, undefined, "FAST");
    this.stroke(C.line);
    this.doc.rect(M, this.y, CW, h, "S");
    this.y += h + 1.5;
    if (caption) this.text(caption, { size: 8, color: C.muted, gap: 3 });
  }

  // ---------- páginas ----------

  cover(coverData) {
    const { trip, stats } = this.album;
    const d = this.doc;
    d.addImage(coverData, "JPEG", 0, 0, W, H, undefined, "FAST");
    const dates = trip.start && trip.end ? `${fullDate.format(utc(trip.start))} - ${fullDate.format(utc(trip.end))}` : "";
    this.ink("#a9d6f0");
    d.setFont("helvetica", "bold");
    d.setFontSize(11);
    d.text("ÁLBUM DEL VIAJE", M + 4, 196);
    this.ink(C.white);
    d.setFont("helvetica", "bold");
    d.setFontSize(36);
    const titleLines = d.splitTextToSize(latin(trip.name), CW - 8);
    titleLines.forEach((line, i) => d.text(line, M + 4, 212 + i * 15));
    let y = 212 + titleLines.length * 15 + 4;
    d.setFont("helvetica", "normal");
    d.setFontSize(16);
    if (trip.destination) {
      d.text(latin(trip.destination), M + 4, y);
      y += 8;
    }
    d.setFontSize(12);
    this.ink("#cfe6f5");
    if (dates) d.text(latin(dates), M + 4, y);
    const facts = [`${stats.days} ${stats.days === 1 ? "día" : "días"}`, stats.places ? `${stats.places} lugares` : "", stats.km ? formatKm(stats.km) : "", stats.photos ? `${stats.photos} fotos` : ""].filter(Boolean);
    d.setFontSize(11);
    d.text(latin(facts.join("   ·   ")), M + 4, 276);
    if (stats.authors.length) {
      d.setFontSize(9);
      this.ink("#8fbbd6");
      d.text(latin(`Con ${stats.authors.join(", ")}`), M + 4, 283);
    }
  }

  statsPage() {
    const { stats, highlights } = this.album;
    this.context = "El viaje en cifras";
    this.page("");
    this.heading("El viaje en cifras", { size: 22 });
    const tiles = [
      [String(stats.days), stats.days === 1 ? "día con recuerdos" : "días con recuerdos"],
      [String(stats.places), stats.places === 1 ? "lugar en el mapa" : "lugares en el mapa"],
      [stats.km ? formatKm(stats.km) : "-", stats.kmByRoad ? "por carretera" : "recorridos"],
      [String(stats.photos), stats.photosLocated ? `fotos (${stats.photosLocated} con ubicación)` : "fotos"],
      [money.format(stats.spent), "gasto anotado"],
      [stats.foodPlaces ? String(stats.foodPlaces) : "-", stats.foodAverage ? `sitios para comer (media ${stats.foodAverage.toFixed(1).replace(".", ",")}/5)` : "sitios para comer"],
    ];
    const gap = 5;
    const tw = (CW - gap * 2) / 3;
    const th = 27;
    tiles.forEach(([value, label], i) => {
      const x = M + (i % 3) * (tw + gap);
      const y = this.y + Math.floor(i / 3) * (th + gap);
      this.fill(C.soft);
      this.doc.roundedRect(x, y, tw, th, 3, 3, "F");
      this.doc.setFont("helvetica", "bold");
      this.doc.setFontSize(value.length > 9 ? 14 : 19);
      this.ink(C.brand);
      this.doc.text(latin(value), x + 4, y + 11.5);
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(8);
      this.ink(C.muted);
      this.doc.text(this.doc.splitTextToSize(latin(label), tw - 8), x + 4, y + 17.5);
    });
    this.y += 2 * (th + gap) + 2;
    if (this.maps.get("overview")) {
      this.subheading("El recorrido");
      this.mapPicture("overview");
    }
    const facts = [
      highlights.topFood && `Mejor valorado para comer: ${highlights.topFood.title} (${highlights.topFood.rating}/5)`,
      highlights.busiest && `Día con más planes: ${highlights.busiest.title} (${highlights.busiest.activities.length} actividades)`,
      highlights.longest && `Día de más carretera: ${highlights.longest.title} (${formatKm(highlights.longest.km)})`,
      highlights.priciest && `Mayor gasto: ${highlights.priciest.title} (${money.format(highlights.priciest.cost)})`,
      stats.authors.length && `Han aportado: ${stats.authors.join(", ")}`,
      stats.comments && `${stats.comments} comentarios en las actividades`,
    ].filter(Boolean);
    if (facts.length) {
      this.subheading("Destacados");
      for (const f of facts) this.text(`•  ${f}`, { size: 10, gap: 1.6 });
    }
  }

  perPerson() {
    const list = this.album.perPerson;
    if (!list.length) return;
    this.context = "Por persona";
    this.page("");
    this.heading("Por persona", { size: 22 });
    this.text("Lo que ha aportado cada viajero y cómo van las cuentas.", { size: 10, color: C.muted, gap: 4 });
    const cols = [
      { title: "VIAJERO", x: 0, w: 46 },
      { title: "FOTOS", x: 46, w: 16, align: "right" },
      { title: "LUGARES", x: 62, w: 20, align: "right" },
      { title: "COMENT.", x: 82, w: 20, align: "right" },
      { title: "AUDIOS", x: 102, w: 18, align: "right" },
      { title: "PAGÓ", x: 120, w: 30, align: "right" },
      { title: "SALDO", x: 150, w: 32, align: "right" },
    ];
    const d = this.doc;
    const header = () => {
      this.need(8);
      this.fill(C.soft);
      d.rect(M, this.y, CW, 6, "F");
      d.setFont("helvetica", "bold");
      d.setFontSize(7.8);
      this.ink(C.muted);
      for (const col of cols) d.text(col.title, M + col.x + (col.align === "right" ? col.w - 1 : 1), this.y + 4.1, { align: col.align || "left" });
      this.y += 7;
    };
    header();
    for (const p of list) {
      if (this.y + 6.2 > LIMIT) {
        this.page(this.context);
        header();
      }
      const sign = p.balance > 0.004 ? "+" : p.balance < -0.004 ? "-" : "";
      const cells = [p.name, p.photos, p.places, p.comments, p.audios, money.format(p.paid), `${sign}${money.format(Math.abs(p.balance))}`];
      d.setFont("helvetica", "normal");
      d.setFontSize(9);
      this.ink(C.ink);
      cols.forEach((col, i) => d.text(d.splitTextToSize(latin(String(cells[i])), col.w - 2)[0] ?? "", M + col.x + (col.align === "right" ? col.w - 1 : 1), this.y + 4, { align: col.align || "left" }));
      this.stroke("#e6ebf2");
      d.line(M, this.y + 5.6, W - M, this.y + 5.6);
      this.y += 6.2;
    }
  }

  daySummary() {
    const days = this.album.perDay;
    if (!days.length) return;
    const rows = days.map((r) => [r.number ? `Día ${r.number}` : "-", r.label, r.city || "", String(r.plans), String(r.photos), r.km ? formatKm(r.km) : "-", money.format(r.spent || 0)]);
    const sum = (k) => days.reduce((s, r) => s + (r[k] || 0), 0);
    rows.push(["Total", "", "", String(sum("plans")), String(sum("photos")), sum("km") ? formatKm(sum("km")) : "-", money.format(days.reduce((s, r) => s + (r.spent || 0), 0))]);
    this.table("Día a día", "Un resumen de cada jornada: planes, fotos, kilómetros y gasto.", [
      { title: "DÍA", x: 0, w: 16 },
      { title: "FECHA", x: 16, w: 34 },
      { title: "CIUDAD", x: 50, w: 52 },
      { title: "PLANES", x: 102, w: 18, align: "right" },
      { title: "FOTOS", x: 120, w: 16, align: "right" },
      { title: "KM", x: 136, w: 22, align: "right" },
      { title: "GASTO", x: 158, w: 24, align: "right" },
    ], rows);
  }

  games() {
    const list = this.album.games;
    if (!list.length) return;
    this.context = "Juegos";
    this.page("");
    this.heading("Juegos", { size: 22 });
    this.text("Los retos y competiciones del viaje.", { size: 10, color: C.muted, gap: 4 });
    for (const g of list) {
      this.need(24);
      const d = this.doc;
      d.addImage(emojiPng(g.emoji), "PNG", M, this.y + 0.4, 6, 6);
      this.y -= 0.2;
      this.text(g.title, { x: M + 8.5, w: CW - 8.5, size: 14, style: "bold", gap: 1.5 });
      if (g.highlights?.length) this.meta(g.highlights.map((h) => `${h.label}: ${h.value}`), { size: 9.2 });
      for (const l of g.lines ?? []) this.text(`•  ${l}`, { size: 9.6, gap: 1 });
      const shown = (g.images ?? []).map((u) => this.gameImages?.get(u)).filter(Boolean).slice(0, 6);
      if (shown.length) {
        this.need(36);
        const bw = 40;
        shown.forEach((img, i) => {
          const scale = Math.min(bw / img.w, 34 / img.h);
          d.addImage(img.data, "JPEG", M + i * (bw + 3) + (bw - img.w * scale) / 2, this.y + (34 - img.h * scale) / 2, img.w * scale, img.h * scale, undefined, "FAST");
        });
        this.y += 38;
      }
      this.y += 5;
    }
  }

  awards() {
    const list = this.album.awards;
    if (!list.length) return;
    const d = this.doc;
    this.context = "Premios del viaje";
    this.page("");
    this.heading("Premios del viaje", { size: 22 });
    this.text("Datos curiosos calculados automáticamente con todo lo que habéis ido añadiendo.", { size: 10, color: C.muted, gap: 4 });
    const gap = 5;
    const cw = (CW - gap) / 2;
    const ch = 25;
    list.forEach((a, i) => {
      if (i % 2 === 0) this.need(ch + gap);
      const x = M + (i % 2) * (cw + gap);
      const y = this.y;
      this.fill(C.soft);
      d.roundedRect(x, y, cw, ch, 3, 3, "F");
      d.addImage(emojiPng(a.emoji), "PNG", x + 4, y + 7.5, 10, 10);
      d.setFont("helvetica", "bold");
      d.setFontSize(7.2);
      this.ink(C.muted);
      d.text(latin(a.title.toUpperCase()), x + 17, y + 7.2, { maxWidth: cw - 20 });
      d.setFontSize(11);
      this.ink(C.ink);
      const winner = d.splitTextToSize(latin(a.winner), cw - 20)[0] ?? "";
      d.text(winner, x + 17, y + 13.6);
      d.setFont("helvetica", "normal");
      d.setFontSize(8.6);
      this.ink(C.muted);
      d.text(latin(a.detail), x + 17, y + 19.2, { maxWidth: cw - 20 });
      if (i % 2 === 1 || i === list.length - 1) this.y += ch + gap;
    });
  }

  // «Gastos por categoría»: barras por categoría y, por persona, una barra apilada con lo que le toca y lo que pagó (sin emojis en el texto:
  // los de las categorías van como imagen, igual que en «Gastos»).
  categories() {
    const c = this.album.categories;
    if (!c || !c.total) return;
    const d = this.doc;
    this.context = "Gastos por categoría";
    this.page("");
    this.heading("Gastos por categoría", { size: 22 });
    this.text(money.format(c.total / 100), { size: 26, style: "bold", color: C.brand, gap: 0.5 });
    this.text(`en ${c.count} ${c.count === 1 ? "apunte repartido" : "apuntes repartidos"}`, { size: 10, color: C.muted, gap: 4 });
    this.subheading("Por categoría");
    for (const r of c.rows) {
      this.need(8);
      d.addImage(emojiPng(r.emoji), "PNG", M, this.y, 4.6, 4.6);
      d.setFont("helvetica", "normal");
      d.setFontSize(9.5);
      this.ink(C.ink);
      d.text(latin(r.label), M + 6.4, this.y + 3.5);
      const bx = M + 40;
      const bw = CW - 40 - 40;
      this.fill(C.soft);
      d.roundedRect(bx, this.y + 0.4, bw, 4, 2, 2, "F");
      this.fill(r.color);
      d.roundedRect(bx, this.y + 0.4, Math.max(3, (r.cents / c.rows[0].cents) * bw), 4, 2, 2, "F");
      d.setFont("helvetica", "bold");
      this.ink(C.ink);
      d.text(latin(money.format(r.cents / 100)), W - M - 11, this.y + 3.5, { align: "right" });
      d.setFont("helvetica", "normal");
      this.ink(C.muted);
      d.text(latin(r.cents * 100 < c.total ? "<1 %" : `${Math.round((r.cents * 100) / c.total)} %`), W - M, this.y + 3.5, { align: "right" });
      this.y += 7.4;
    }
    const perPerson = (data, title) => {
      if (!data.rows.length) return;
      this.subheading(title);
      const max = data.rows[0].cents;
      for (const p of data.rows) {
        this.need(19);
        d.setFont("helvetica", "bold");
        d.setFontSize(10);
        this.ink(C.ink);
        d.text(latin(p.name), M, this.y + 3.6, { maxWidth: CW - 34 });
        d.text(latin(money.format(p.cents / 100)), W - M, this.y + 3.6, { align: "right" });
        const parts = CATEGORIES.filter((k) => p.byCat.get(k.key));
        let x = M;
        for (const k of parts) {
          const w = (CW * (p.cents / max) * p.byCat.get(k.key)) / p.cents;
          this.fill(k.color);
          d.rect(x, this.y + 5.2, w, 3.2, "F");
          x += w;
        }
        this.y += 10;
        this.text(parts.map((k) => `${k.label} ${money.format(p.byCat.get(k.key) / 100)}`).join("  ·  "), { size: 8.4, color: C.muted, gap: 2.4 });
      }
    };
    perPerson(c.owed, "Lo que le toca a cada uno");
    perPerson(c.paid, "Lo que pagó cada uno");
    if (c.guessed) this.text(`${c.guessed} ${c.guessed === 1 ? "apunte" : "apuntes"} sin categoría guardada: se ${c.guessed === 1 ? "calcula" : "calculan"} por las palabras del concepto.`, { size: 8.4, color: C.muted, gap: 2 });
  }

  ledger() {
    const l = this.album.ledger;
    if (!l) return;
    const d = this.doc;
    this.context = "Cuentas entre viajeros";
    this.page("");
    this.heading("Cuentas entre viajeros", { size: 22 });
    this.text(money.format(l.total), { size: 26, style: "bold", color: C.brand, gap: 0.5 });
    this.text(`en ${l.count} ${l.count === 1 ? "gasto repartido" : "gastos repartidos"}`, { size: 10, color: C.muted, gap: 4 });
    this.subheading("Para quedar en paz");
    if (!l.payments.length) this.text("Todos en paz: nadie debe nada.", { size: 10 });
    for (const p of l.payments) {
      this.need(8);
      d.setFont("helvetica", "bold");
      d.setFontSize(10.5);
      this.ink(C.ink);
      d.text(latin(`${p.from}  ->  ${p.to}`), M, this.y + 4);
      d.text(latin(money.format(p.amount)), W - M, this.y + 4, { align: "right" });
      this.stroke(C.line);
      d.line(M, this.y + 6, W - M, this.y + 6);
      this.y += 7.6;
    }
    this.subheading("Lo que pagó cada uno");
    for (const r of l.rows) {
      this.need(8);
      d.setFont("helvetica", "bold");
      d.setFontSize(10);
      this.ink(C.ink);
      d.text(latin(r.name), M, this.y + 4);
      d.setFont("helvetica", "normal");
      this.ink(C.muted);
      d.text(latin(`pagó ${money.format(r.paid)}`), M + 70, this.y + 4);
      d.text(latin(`le tocan ${money.format(r.owed)}`), M + 108, this.y + 4);
      d.setFont("helvetica", "bold");
      this.ink(r.balance > 0.004 ? C.brand2 : r.balance < -0.004 ? "#b91c1c" : C.muted);
      d.text(latin(`${r.balance > 0.004 ? "+" : r.balance < -0.004 ? "-" : ""}${money.format(Math.abs(r.balance))}`), W - M, this.y + 4, { align: "right" });
      this.stroke(C.line);
      d.line(M, this.y + 6, W - M, this.y + 6);
      this.y += 7.6;
    }
    this.subheading("Todos los gastos");
    for (const e of l.items) {
      this.need(7.4);
      d.setFont("helvetica", "normal");
      d.setFontSize(9);
      this.ink(C.muted);
      d.text(latin(safeFormat(capDay, `${e.day}T00:00:00Z`)), M, this.y + 3.8);
      this.ink(C.ink);
      d.text(d.splitTextToSize(latin(e.title), 74)[0] ?? "", M + 22, this.y + 3.8);
      this.ink(C.muted);
      d.text(d.splitTextToSize(latin(`pagó ${e.paid_by}, entre ${e.people}`), 52)[0] ?? "", M + 100, this.y + 3.8);
      d.setFont("helvetica", "bold");
      this.ink(C.ink);
      d.text(latin(money.format(e.amount)), W - M, this.y + 3.8, { align: "right" });
      this.stroke("#e6ebf2");
      d.line(M, this.y + 5.4, W - M, this.y + 5.4);
      this.y += 6.2;
    }
  }

  chapter(c) {
    this.context = `Día ${c.number} · ${c.title}`;
    this.page(this.context, true);
    this.y = 0;
    this.fill(c.color);
    this.doc.rect(0, 0, W, 31, "F");
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(9);
    this.ink("#e8f4fb");
    this.doc.text(`DÍA ${c.number}`, M, 10.5);
    this.doc.setFontSize(17);
    this.ink(C.white);
    this.doc.text(latin(c.title), M, 19.5);
    if (c.city) {
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(9.5);
      this.ink("#e8f4fb");
      this.doc.text(latin(c.city), M, 26.5);
    }
    if (c.weather?.tmax != null) {
      const [emoji, label] = describeWeather(c.weather.code);
      const text = latin(`${formatTemp(c.weather.tmax)} / ${formatTemp(c.weather.tmin)}  ·  ${label}${c.weather.kind === "typical" ? " (media de 5 años)" : ""}`);
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(9);
      this.ink(C.white);
      this.doc.text(text, W - M, 26, { align: "right" });
      this.doc.addImage(emojiPng(emoji), "PNG", W - M - this.doc.getTextWidth(text) - 7.5, 21.6, 5.6, 5.6);
    }
    const facts = [`${c.activities.length} ${c.activities.length === 1 ? "actividad" : "actividades"}`, c.km ? `${formatKm(c.km)}${c.route?.road ? "" : " en línea recta"}` : "", c.cost ? money.format(c.cost) : ""].filter(Boolean);
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(9);
    this.doc.text(latin(facts.join("  ·  ")), W - M, 10.5, { align: "right" });
    this.y = 37;
    if (c.summary) this.text(c.summary, { size: 9.5, style: "italic", color: C.muted, gap: 3 });
    if (this.maps.get(`day:${c.day}`)) this.mapPicture(`day:${c.day}`);
    for (const a of c.activities) this.entry(a, c.color);
    this.wikiBlock(this.wiki.get(c.day));
    if (c.loosePhotos.length) {
      this.y += 2;
      this.subheading("Más fotos del día");
      this.photoGrid(c.loosePhotos, { cols: 4, boxH: 30 });
    }
  }

  entry(a, color) {
    const d = this.doc;
    const x0 = M + 11;
    const w = CW - 11;
    this.need(26);
    const top = this.y;
    // insignia: número del lugar en el mapa, o el icono del tipo
    if (a.order) {
      this.fill(color);
      d.circle(M + 4, top + 4.6, 4, "F");
      d.setFont("helvetica", "bold");
      d.setFontSize(9.5);
      this.ink(C.white);
      d.text(String(a.order), M + 4, top + 5.9, { align: "center" });
    } else {
      this.fill(C.soft);
      d.circle(M + 4, top + 4.6, 4, "F");
      d.addImage(emojiPng(a.cat.emoji), "PNG", M + 1.6, top + 2.2, 4.8, 4.8);
    }
    this.text(a.title, { x: x0, w, size: 11.5, style: "bold", gap: 0.3 });
    const parts = [
      a.start_time ? a.start_time.slice(0, 5) : "",
      a.place ? (hasCoords(a) ? { text: a.place, url: mapsUrl(a) } : a.place) : "",
      a.cost != null ? money.format(a.cost) : "",
      a.rating ? { stars: a.rating } : "",
      a.created_by_name ? `por ${a.created_by_name}` : "",
    ].filter(Boolean);
    if (parts.length) this.meta(parts, { x: x0, w });
    if (a.notes) this.text(a.notes, { x: x0, w, size: 9.5, color: "#334155", gap: 1.2 });
    this.photoGrid(a.photos, { x: x0, w, cols: 3, boxH: 36 });
    // Un PDF no reproduce audio: se deja constancia de las notas de voz (están en el álbum de la web).
    for (const n of a.audios ?? []) this.text(`Nota de voz de ${n.created_by_name || "alguien"} (${Math.floor(n.seconds / 60)}:${String(n.seconds % 60).padStart(2, "0")})`, { x: x0, w, size: 8.6, style: "italic", color: C.muted, gap: 1.4 });
    if (this.opts.comments) {
      for (const c of a.comments) {
        const label = c.body || (c.attached_audio ? "(nota de voz)" : c.attached_photo ? "(foto)" : "");
        if (label) this.quote({ ...c, body: label }, { x: x0, w, color });
      }
    }
    const added = safeFormat(fullDate, a.created_at);
    const details = [hasCoords(a) ? coords(a) : "", added ? `añadido el ${added}` : ""].filter(Boolean).join("  ·  ");
    this.text(details, { x: x0, w, size: 7.2, color: "#8a98ad", gap: 4.5 });
  }

  wikiBlock(items) {
    if (!items?.length) return;
    this.y += 2;
    this.subheading("Cerca de aquí · Wikipedia");
    for (const item of items) {
      this.need(15);
      const top = this.y;
      this.text(item.title, { size: 9.5, style: "bold", color: C.brand, gap: 0.2 });
      this.doc.link(M, top, CW, 5, { url: item.url });
      this.text(item.extract, { size: 8.6, color: "#475569", gap: 2.4 });
    }
    this.text("Texto de Wikipedia, licencia CC BY-SA 4.0.", { size: 7, color: "#8a98ad", gap: 3 });
  }

  expenses() {
    const e = this.album.expenses;
    if (!e.total) return;
    this.context = "Gastos";
    this.page("");
    this.heading("Gastos", { size: 22 });
    this.text(money.format(e.total), { size: 26, style: "bold", color: C.brand, gap: 0.5 });
    this.text(`en total${e.daysWithCost > 1 ? `  ·  ${money.format(e.perDay)} de media por día con gastos` : ""}`, { size: 10, color: C.muted, gap: 4 });
    const bars = (rows, max) => {
      for (const r of rows) {
        this.need(8);
        const d = this.doc;
        if (r.emoji) d.addImage(emojiPng(r.emoji), "PNG", M, this.y, 4.6, 4.6);
        d.setFont("helvetica", "normal");
        d.setFontSize(9.5);
        this.ink(C.ink);
        d.text(latin(r.label), M + (r.emoji ? 6.4 : 0), this.y + 3.5);
        const bx = M + 52;
        const bw = CW - 52 - 30;
        this.fill(C.soft);
        d.roundedRect(bx, this.y + 0.4, bw, 4, 2, 2, "F");
        this.fill(r.color || C.brand);
        d.roundedRect(bx, this.y + 0.4, Math.max(3, (r.total / max) * bw), 4, 2, 2, "F");
        this.ink(C.ink);
        d.setFont("helvetica", "bold");
        d.text(latin(money.format(r.total)), W - M, this.y + 3.5, { align: "right" });
        this.y += 7.4;
      }
    };
    this.subheading("Por tipo");
    bars(e.byCategory.map((c) => ({ label: c.label, emoji: c.emoji, total: c.total })), e.byCategory[0].total);
    if (e.byDay.length > 1) {
      this.subheading("Por día");
      bars(e.byDay, Math.max(...e.byDay.map((r) => r.total)));
    }
    this.subheading("Los mayores gastos");
    e.top.forEach((a, i) => {
      this.need(6.5);
      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(10);
      this.ink(C.ink);
      this.doc.text(latin(`${i + 1}.  ${a.title}`), M, this.y + 3.6);
      this.doc.setFont("helvetica", "bold");
      this.doc.text(latin(money.format(a.cost)), W - M, this.y + 3.6, { align: "right" });
      this.stroke(C.line);
      this.doc.line(M, this.y + 5.4, W - M, this.y + 5.4);
      this.y += 6.6;
    });
  }

  food() {
    const { food } = this.album;
    if (!food.length) return;
    this.context = "Dónde comimos";
    this.page("");
    this.heading("Dónde comimos", { size: 22 });
    this.text("Los sitios de comida del viaje, de mejor a peor valorado.", { size: 10, color: C.muted, gap: 4 });
    food.forEach((f, i) => {
      const d = this.doc;
      const photo = f.photos.find((p) => this.images.get(p.id));
      const rowH = photo ? 34 : 17;
      this.need(rowH + 3);
      const top = this.y;
      this.fill(C.soft);
      d.circle(M + 4, top + 4.4, 4, "F");
      d.setFont("helvetica", "bold");
      d.setFontSize(10);
      this.ink(C.brand);
      d.text(String(i + 1), M + 4, top + 5.7, { align: "center" });
      const textX = M + 11;
      const textW = photo ? CW - 11 - 46 : CW - 11;
      this.y = top;
      this.text(f.title, { x: textX, w: textW, size: 11.5, style: "bold", gap: 0.3 });
      const parts = [f.dayTitle, f.place && f.place !== f.title ? f.place : "", f.cost != null ? money.format(f.cost) : "", f.rating ? { stars: f.rating } : ""].filter(Boolean);
      this.meta(parts, { x: textX, w: textW });
      if (photo) {
        const img = this.images.get(photo.id);
        const scale = Math.min(42 / img.w, 30 / img.h);
        d.addImage(img.data, "JPEG", W - M - 42 + (42 - img.w * scale) / 2, top + (30 - img.h * scale) / 2, img.w * scale, img.h * scale, undefined, "FAST");
      }
      this.y = top + rowH;
      this.stroke(C.line);
      d.line(M, this.y - 1.5, W - M, this.y - 1.5);
    });
  }

  orphans() {
    if (!this.album.orphans.length) return;
    this.context = "Más recuerdos";
    this.page("");
    this.heading("Más recuerdos", { size: 22 });
    this.text("Fotos que no se pudieron situar en un día o en un lugar del itinerario.", { size: 10, color: C.muted, gap: 4 });
    this.photoGrid(this.album.orphans, { cols: 3, boxH: 42 });
  }

  // Tablas con los metadatos: lugares y fotos.
  table(title, intro, columns, rows) {
    if (!rows.length) return;
    this.context = title;
    this.page("");
    this.heading(title, { size: 18 });
    this.text(intro, { size: 9, color: C.muted, gap: 3 });
    const d = this.doc;
    const header = () => {
      this.need(8);
      this.fill(C.soft);
      d.rect(M, this.y, CW, 6, "F");
      d.setFont("helvetica", "bold");
      d.setFontSize(7.8);
      this.ink(C.muted);
      for (const col of columns) d.text(col.title, M + col.x + 1 + (col.align === "right" ? col.w - 2 : 0), this.y + 4.1, { align: col.align || "left" });
      this.y += 7;
    };
    header();
    for (const row of rows) {
      if (this.y + 5.2 > LIMIT) {
        this.page(this.context);
        header();
      }
      d.setFont("helvetica", "normal");
      d.setFontSize(8);
      this.ink(C.ink);
      columns.forEach((col, i) => {
        const text = d.splitTextToSize(latin(row[i] ?? ""), col.w - 2)[0] ?? "";
        d.text(text, M + col.x + 1 + (col.align === "right" ? col.w - 2 : 0), this.y + 3.5, { align: col.align || "left" });
      });
      this.stroke("#e6ebf2");
      d.line(M, this.y + 4.9, W - M, this.y + 4.9);
      this.y += 5.2;
    }
  }

  // Encabezado y pie de todas las páginas menos la portada y las que llevan banda de color.
  chrome() {
    const d = this.doc;
    const total = d.getNumberOfPages();
    const title = latin(this.album.trip.name);
    for (let i = 2; i <= total; i++) {
      d.setPage(i);
      const label = this.labels.get(i);
      d.setFont("helvetica", "normal");
      d.setFontSize(7.8);
      this.ink("#8a98ad");
      if (label && !label.banded && label.text) d.text(latin(label.text), W - M, 9, { align: "right" });
      this.stroke(C.line);
      d.line(M, H - 13, W - M, H - 13);
      d.text(title, M, H - 8.5);
      d.text(`${i} / ${total}`, W - M, H - 8.5, { align: "right" });
    }
  }
}

// ---------- exportación ----------

const unique = (list) => [...new Map(list.map((p) => [p.id, p])).values()];

// Calidad de las fotos incrustadas: [lado máximo en px, calidad JPEG]. Con muchas fotos se baja un escalón.
const QUALITY = { small: [700, 0.7], normal: [1000, 0.8], high: [1500, 0.86] };
function photoQuality(level, count) {
  const order = ["small", "normal", "high"];
  const index = Math.max(0, order.indexOf(level) - (count > 150 ? 1 : 0));
  return QUALITY[order[index]];
}

// Pregunta qué hacer con el PDF ya montado. Se hace en un diálogo para que "Compartir" salga de un toque nuevo
// (los navegadores no dejan abrir la hoja de compartir pasados unos segundos desde el último toque).
function chooseDelivery(name, blob, pages) {
  const dialog = $("#pdf-ready");
  $("#pdf-ready-info").textContent = `${name} · ${pages} páginas · ${(blob.size / 1e6).toFixed(1).replace(".", ",")} MB`;
  return new Promise((resolve) => {
    const done = (choice) => {
      dialog.close();
      resolve(choice);
    };
    $("#pdf-ready-download").onclick = () => done("download");
    $("#pdf-ready-share").onclick = async () => {
      try {
        await navigator.share({ files: [new File([blob], name, { type: "application/pdf" })], title: name.replace(/\.pdf$/, "") });
        done("shared");
      } catch (err) {
        if (err.name !== "AbortError") done("download"); // no se pudo abrir "Compartir": se descarga
      }
    };
    dialog.addEventListener("close", () => resolve("closed"), { once: true });
    dialog.showModal();
  });
}

export async function exportAlbumPdf({ share = false, onProgress = (text) => toast(text, 240000) } = {}) {
  const opts = { maps: settings.pdfMaps, comments: settings.pdfComments, wiki: settings.pdfWiki, appendix: settings.pdfAppendix, quality: settings.pdfQuality };

  // 0. Tiempo y ciudad de cada día (suelen estar ya guardados en el navegador).
  const targets = dayTargets();
  if (targets.length) {
    onProgress("Consultando el tiempo y los lugares…");
    try {
      state.weather = await loadWeather(targets);
    } catch {
      /* sin tiempo: el álbum sale igual */
    }
    for (const t of targets) {
      if (state.places[t.day]) continue;
      const name = await cityName(t.lat, t.lng).catch(() => null);
      if (name) state.places[t.day] = name;
    }
  }
  // Las rutas por carretera tienen que estar calculadas antes de dibujar los mapas.
  if (state.roadMode) {
    onProgress("Calculando las rutas…");
    await Promise.all(routePlan().map((item) => fetchRoadRoute(item.points)));
  }
  const album = buildAlbum();
  if (album.isEmpty) throw new Error("Todavía no hay nada que poner en el álbum.");
  const jsPDF = await loadJsPdf();

  // 1. mapas
  const maps = new Map();
  if (opts.maps) {
    const mapJobs = [];
    if (album.routes.length || album.placeIndex.length) mapJobs.push(["overview", { stops: album.placeIndex, routes: album.routes, width: 900, height: 520, numbered: false }]);
    for (const c of album.chapters) {
      if (c.stops.length) mapJobs.push([`day:${c.day}`, { stops: c.stops, routes: c.route ? [c.route] : [], width: 900, height: 520, numbered: true }]);
    }
    for (const [i, [id, options]] of mapJobs.entries()) {
      onProgress(`Dibujando los mapas… ${i + 1} de ${mapJobs.length}`);
      const image = await mapImage(options);
      if (image) maps.set(id, image);
    }
  }

  // 2. curiosidades de los alrededores
  const wiki = new Map();
  if (opts.wiki) {
    const withCenter = album.chapters.filter((c) => c.center);
    for (const [i, c] of withCenter.entries()) {
      onProgress(`Buscando curiosidades de cada lugar… ${i + 1} de ${withCenter.length}`);
      try {
        const items = await nearbyWiki(c.center.lat, c.center.lng);
        if (items.length) wiki.set(c.day, items);
      } catch {
        /* sin curiosidades de ese día */
      }
    }
  }

  // 3. fotos (reducidas para que el PDF no pese demasiado)
  const photos = unique([...album.cover, ...album.chapters.flatMap((c) => [...c.activities.flatMap((a) => a.photos), ...c.loosePhotos]), ...album.orphans]);
  const [maxSide, quality] = photoQuality(opts.quality, photos.length);
  const images = new Map();
  let failed = 0;
  for (const [i, photo] of photos.entries()) {
    onProgress(`Preparando las fotos… ${i + 1} de ${photos.length}`);
    try {
      images.set(photo.id, await loadPhoto(photo.full_url || photo.thumb_url, maxSide, { quality }));
    } catch (err) {
      failed++;
      console.warn("Foto omitida en el PDF:", err.message || err);
    }
  }

  // 3b. fotos de los juegos (ganadoras, pruebas del bingo…), pocas y pequeñas
  const gameImages = new Map();
  for (const g of album.games) {
    for (const url of (g.images ?? []).slice(0, 6)) {
      try {
        gameImages.set(url, await loadPhoto(url, maxSide, { quality }));
      } catch {
        /* esa foto no sale en el PDF */
      }
    }
  }

  // 4. portada con collage
  const coverImages = [];
  for (const photo of album.cover.slice(0, 5)) {
    try {
      const { canvas } = await loadPhoto(photo.full_url || photo.thumb_url, 1100, { bitmap: true });
      coverImages.push(canvas);
    } catch {
      /* se omite esa foto en el collage */
    }
  }
  onProgress("Montando el PDF…");
  await sleep(30); // deja respirar a la interfaz antes del trabajo pesado

  const book = new Book(jsPDF, album, maps, images, { opts, wiki });
  book.gameImages = gameImages;
  book.cover(coverCanvas(coverImages));
  book.statsPage();
  book.awards();
  book.perPerson();
  book.daySummary();
  for (const c of album.chapters) book.chapter(c);
  book.expenses();
  book.categories();
  book.ledger();
  book.food();
  book.games();
  book.orphans();
  if (opts.appendix) {
    const placeRows = album.placeIndex.map((s, i) => [String(i + 1), s.dayTitle, s.start_time?.slice(0, 5) ?? "", s.title, coords(s)]);
    book.table("Lugares y coordenadas", "Todos los lugares con ubicación, en orden cronológico.", [
      { title: "N.º", x: 0, w: 10 },
      { title: "DÍA", x: 10, w: 34 },
      { title: "HORA", x: 44, w: 14 },
      { title: "LUGAR", x: 58, w: 78 },
      { title: "LATITUD, LONGITUD", x: 136, w: 46 },
    ], placeRows);
    const photoRows = album.photoIndex.map((e) => [String(e.n), when(e.photo), e.author, e.near?.title ?? "", hasCoords(e.photo) ? coords(e.photo) : "sin ubicación"]);
    book.table("Índice de fotos", "Cuándo, quién y dónde se hizo cada foto (la ubicación viene del GPS de la foto o se colocó a mano).", [
      { title: "N.º", x: 0, w: 10 },
      { title: "FECHA Y HORA", x: 10, w: 36 },
      { title: "AUTOR", x: 46, w: 28 },
      { title: "CERCA DE", x: 74, w: 62 },
      { title: "LATITUD, LONGITUD", x: 136, w: 46 },
    ], photoRows);
  }
  book.chrome();

  const { trip } = album;
  book.doc.setProperties({
    title: latin(`${trip.name} - Álbum del viaje`),
    subject: latin(trip.destination || "Álbum del viaje"),
    author: latin(album.stats.authors.join(", ") || "Viaje colaborativo"),
    keywords: latin(["viaje", "álbum", trip.destination].filter(Boolean).join(", ")),
    creator: "Viaje colaborativo",
  });
  const pages = book.doc.getNumberOfPages();
  const blob = book.doc.output("blob");
  const name = `${slug(trip.name)}-album-${new Date().toISOString().slice(0, 10)}.pdf`;
  hideToast(); // quita el aviso de progreso

  let delivered = "download";
  if (share) delivered = await chooseDelivery(name, blob, pages);
  if (delivered === "download") download(name, "application/pdf", blob);
  if (delivered !== "closed") toast(`Álbum ${delivered === "shared" ? "compartido" : "descargado"}: ${pages} páginas${failed ? ` (${failed} fotos no se pudieron incluir)` : ""}`, 6000);
  return { pages, bytes: blob.size, maps: maps.size, photos: images.size, failedPhotos: failed, wikiDays: wiki.size, delivered };
}
