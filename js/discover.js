// "Descubrir cerca": restaurantes, sitios que ver y aire libre alrededor de un punto, con datos de OpenStreetMap
// (a través de Nominatim, gratuito y sin clave). Cada resultado se puede añadir al itinerario con un toque.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, esc, guarded, toast, formatKm } from "./util.js";
import { settings } from "./settings.js";
import { directionsUrl, distanceKm, searchCategory } from "./geo.js";
import { defaultDay, locatedStops } from "./trip.js";
import { openActivity } from "./dialogs.js";

// Cada categoría consulta unos pocos tipos de sitio de OpenStreetMap a través de Nominatim (rápido y sin clave).
const KINDS = {
  food: { label: "Comer", emoji: "🍽️", category: "comida", radiusKm: 0.9, terms: ["restaurant", "cafe", "fast food"] },
  see: { label: "Ver", emoji: "🏛️", category: "visita", radiusKm: 4, terms: ["attraction", "museum", "viewpoint"] },
  outdoor: { label: "Aire libre", emoji: "🌴", category: "ocio", radiusKm: 5, terms: ["park", "beach"] },
};

const TYPES = {
  restaurant: "Restaurante", cafe: "Cafetería", fast_food: "Comida rápida", ice_cream: "Heladería", bar: "Bar", pub: "Pub", food_court: "Zona de restaurantes",
  attraction: "Atracción", museum: "Museo", gallery: "Galería", viewpoint: "Mirador", zoo: "Zoo", aquarium: "Acuario", theme_park: "Parque temático", artwork: "Obra de arte",
  monument: "Monumento", castle: "Castillo", memorial: "Memorial", ruins: "Ruinas", fort: "Fuerte", archaeological_site: "Yacimiento",
  park: "Parque", nature_reserve: "Reserva natural", garden: "Jardín", marina: "Puerto deportivo", beach_resort: "Playa", beach: "Playa", peak: "Pico", waterfall: "Cascada", spring: "Manantial",
};
const DAYS = { Mo: "L", Tu: "M", We: "X", Th: "J", Fr: "V", Sa: "S", Su: "D", PH: "festivos", off: "cerrado" };
const hours = (text) => (text === "24/7" ? "Abierto 24 horas" : text.replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|off)\b/g, (d) => DAYS[d]));
const cuisine = (text) => text.split(";").slice(0, 2).map((c) => c.replace(/_/g, " ")).join(", ");

// Las distancias cortas se dan en metros (o pies): "0,0 km" no dice nada.
function formatNear(km) {
  if (settings.distance === "mi") return km < 0.2 ? `${Math.round((km * 3280.84) / 10) * 10} ft` : formatKm(km);
  return km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : formatKm(km);
}

const memo = new Map();

// Busca por tipos de sitio y va avisando con `onPartial` según llegan los resultados (cada consulta tarda ~1 s).
export async function placesNear(kind, point, onPartial = () => {}) {
  const { terms, radiusKm } = KINDS[kind];
  const key = `${kind}:${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < 10 * 60_000) return hit.list;
  const seen = new Set();
  const all = [];
  let failures = 0;
  for (const term of terms) {
    try {
      const items = await searchCategory(term, { ...point, radiusKm });
      for (const item of items) {
        const lat = Number(item.lat);
        const lng = Number(item.lon);
        const name = item.name || item.namedetails?.name;
        const id = `${item.osm_type}/${item.osm_id}`;
        if (!name || !Number.isFinite(lat) || seen.has(id)) continue;
        seen.add(id);
        const tags = item.extratags ?? {};
        const type = item.type ?? "";
        all.push({
          id, name,
          type: TYPES[type] ?? type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
          cuisine: tags.cuisine ? cuisine(tags.cuisine) : "",
          hours: tags.opening_hours ? hours(tags.opening_hours) : "",
          website: tags.website || tags["contact:website"] || "",
          lat, lng, km: distanceKm(point, { lat, lng }),
        });
      }
      onPartial(all.filter((p) => p.km <= radiusKm * 1.25).sort((a, b) => a.km - b.km).slice(0, 25));
    } catch (err) {
      failures++;
      console.warn("Lugares cercanos:", err.message || err);
    }
  }
  if (failures === terms.length) throw new Error("No se pudo consultar el servicio de lugares.");
  const list = all.filter((p) => p.km <= radiusKm * 1.25).sort((a, b) => a.km - b.km).slice(0, 25);
  if (!failures) memo.set(key, { t: Date.now(), list });
  return list;
}

// ---------- diálogo ----------

const dialog = $("#discover-dialog");
let origin = null; // { lat, lng, label }
let kind = "food";
let results = [];
let token = 0;

const safeUrl = (url) => (/^https?:\/\//i.test(url) ? url : /^[\w.-]+\.[a-z]{2,}/i.test(url) ? `https://${url}` : "");

function renderResults(list, { loading = false, error = "" } = {}) {
  const box = $("#discover-list");
  if (loading) box.innerHTML = `<li class="discover-msg">Buscando sitios cerca…</li>`;
  else if (error) box.innerHTML = `<li class="discover-msg">${esc(error)}</li>`;
  else if (!list.length) box.innerHTML = `<li class="discover-msg">No hay nada apuntado en OpenStreetMap en esta zona. Prueba con otra categoría o mueve el mapa.</li>`;
  else {
    box.innerHTML = list
      .map((p, i) => {
        const site = safeUrl(p.website);
        const meta = [p.type, p.cuisine, formatNear(p.km)].filter(Boolean);
        return `<li class="place">
          <div class="place-main"><strong>${esc(p.name)}</strong><span>${esc(meta.join(" · "))}</span>${p.hours ? `<small>${esc(p.hours)}</small>` : ""}</div>
          <div class="place-actions">
            <button type="button" class="btn small primary" data-add="${i}">${icon("plus", 15)} Al plan</button>
            <a class="icon-btn sm" href="${esc(directionsUrl(p.lat, p.lng))}" target="_blank" rel="noopener" title="Cómo llegar" aria-label="Cómo llegar a ${esc(p.name)}">${icon("navigate", 16)}</a>
            ${site ? `<a class="icon-btn sm" href="${esc(site)}" target="_blank" rel="noopener" title="Abrir su web" aria-label="Abrir la web de ${esc(p.name)}">${icon("file", 16)}</a>` : ""}
          </div>
        </li>`;
      })
      .join("");
  }
}

async function load() {
  const mine = ++token;
  for (const button of $("#discover-kind").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
  renderResults([], { loading: true });
  try {
    const found = await placesNear(kind, origin, (partial) => {
      if (mine === token && partial.length) {
        results = partial;
        renderResults(partial);
      }
    });
    if (mine === token) {
      results = found; // solo la búsqueda vigente: una antigua no debe pisar la lista que se está viendo
      renderResults(results);
    }
  } catch (err) {
    console.warn("Lugares cercanos:", err.message || err);
    if (mine === token) renderResults([], { error: "No se pudo consultar el servicio de lugares. Revisa la conexión e inténtalo de nuevo en un momento." });
  }
}

// Punto de partida: el lugar elegido, mi ubicación o el centro del mapa (por ese orden).
export function openDiscover(point) {
  const chosen = state.selectedStop ? locatedStops().find((s) => s.id === state.selectedStop) : null;
  origin = point ?? (chosen && { lat: chosen.lat, lng: chosen.lng, label: chosen.title }) ?? (state.me && { ...state.me, label: "tu ubicación" }) ?? (ctx.map?.ready() && ctx.map.center() && { ...ctx.map.center(), label: "el centro del mapa" });
  if (!origin) return toast("Elige un lugar o mueve el mapa para buscar cerca.");
  $("#discover-where").innerHTML = `${icon("pin", 14)} Cerca de ${esc(origin.label ?? "este punto")}`;
  dialog.showModal();
  load();
}

export function initDiscover() {
  $("#discover-kind").innerHTML = Object.entries(KINDS).map(([key, k]) => `<button type="button" data-kind="${key}">${k.emoji} ${k.label}</button>`).join("");
  $("#discover-kind").addEventListener("click", (event) => {
    const button = event.target.closest("[data-kind]");
    if (!button || button.dataset.kind === kind) return;
    kind = button.dataset.kind;
    load();
  });
  $("#discover-list").addEventListener(
    "click",
    guarded((event) => {
      const place = results[event.target.closest("[data-add]")?.dataset.add];
      if (!place) return;
      dialog.close();
      openActivity({ day: state.day || defaultDay(), category: KINDS[kind].category, lat: place.lat, lng: place.lng, title: place.name, place: place.name });
    }),
  );
}
