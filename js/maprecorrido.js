// Recorrido real de cada día en el mapa: la línea que une, por orden de hora, las fotos y los gastos con ubicación de cada persona.
// Se enciende y apaga con el interruptor «Recorrido real» de las capas. map.js solo llama a add() y sync(); los datos salen de
// currentTracks(), que usa la lógica pura de js/recorrido.js.
import { state } from "./state.js";
import { esc, hasCoords, utc, capitalize, fmtDayShort, formatKm } from "./util.js";
import { tripPhotos, photoTime } from "./trip.js";
import { photoDay } from "./album.js";
import { isValid } from "./ledger.js";
import { buildTracks, hueOfName } from "./recorrido.js";

const ML = () => window.maplibregl;
const SOURCE = "tracks";
const LAYER = "tracks-line";
const pad = (n) => String(n).padStart(2, "0");

// La hora «de reloj» de un instante real (en la zona del móvil), expresada como si fuera UTC: así se puede comparar con la hora de
// una foto (taken_at, que ya es hora de reloj de la cámara) sin que la zona horaria las desordene.
function wallMs(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? NaN : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}
const localDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Las paradas con ubicación de cada persona cada día: fotos (a la hora en que se hicieron) y gastos (a la hora en que se apuntaron,
// o a mediodía si se apuntaron otro día).
export function trackPoints() {
  const points = [];
  for (const p of tripPhotos()) {
    if (!hasCoords(p)) continue;
    const day = photoDay(p);
    const t = p.taken_at ? Date.parse(p.taken_at) : wallMs(p.created_at);
    points.push({ who: p.created_by_name, day, t: Number.isFinite(t) ? t : Date.parse(photoTime(p)), lat: p.lat, lng: p.lng, kind: "foto" });
  }
  for (const e of state.expenses) {
    if (!isValid(e) || !hasCoords(e) || !e.day) continue;
    const sameDay = localDay(e.created_at) === e.day;
    points.push({ who: e.created_by_name || e.paid_by, day: e.day, t: sameDay ? wallMs(e.created_at) : Date.parse(`${e.day}T12:00:00Z`), lat: e.lat, lng: e.lng, kind: "gasto" });
  }
  return points;
}

export const currentTracks = () => buildTracks(trackPoints()).map((t) => ({ ...t, color: `hsl(${hueOfName(t.who)} 72% 42%)` }));

const dayLabel = (day) => capitalize(fmtDayShort.format(utc(day)));
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export function createTrackLayer() {
  let popup = null;
  let wired = false;

  function add(map) {
    if (map.getSource(SOURCE)) return;
    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: LAYER,
      type: "line",
      source: SOURCE,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.5, 12, 5],
        "line-opacity": ["get", "opacity"],
        "line-dasharray": [0.6, 1.6],
      },
    });
    if (wired) return;
    wired = true;
    map.on("click", LAYER, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties;
      popup?.remove();
      popup = new (ML().Popup)({ closeButton: false, closeOnClick: true, maxWidth: "260px" })
        .setLngLat(e.lngLat)
        .setHTML(`<div class="track-card"><strong>${esc(p.who)}</strong><span>${esc(dayLabel(p.day))} · ${esc(clock(Number(p.from)))}–${esc(clock(Number(p.to)))}</span><span>${esc(formatKm(Number(p.km)))} · ${Number(p.n)} paradas</span></div>`)
        .addTo(map);
    });
    map.on("mouseenter", LAYER, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", LAYER, () => (map.getCanvas().style.cursor = ""));
  }

  // tracks: currentTracks(); el día elegido en los chips resalta su recorrido y atenúa los demás (igual que las rutas planificadas).
  function sync(map, tracks, { visible, activeDay }) {
    let source;
    try {
      source = map?.getSource(SOURCE);
    } catch {
      return;
    }
    if (!source) return;
    source.setData({
      type: "FeatureCollection",
      features: tracks.map((t) => ({
        type: "Feature",
        properties: { color: t.color, who: t.who, day: t.day, from: t.from, to: t.to, km: t.km, n: t.n, opacity: activeDay && t.day !== activeDay ? 0.18 : 0.9 },
        geometry: { type: "LineString", coordinates: t.coords },
      })),
    });
    if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, "visibility", visible ? "visible" : "none");
    if (!visible) {
      popup?.remove();
      popup = null;
    }
  }

  return { add, sync };
}
