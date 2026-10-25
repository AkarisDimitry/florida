// Ubicar de golpe las actividades que no tienen sitio en el mapa. Una actividad sin ubicación no tiene pin ni ruta, así que sus
// días salen vacíos en el mapa aunque el itinerario esté completo. Esto busca cada una por su lugar (o su título) con Nominatim,
// enseña lo que ha encontrado para que la persona lo revise y, al aceptar, guarda las ubicaciones.
import { state, ctx } from "./state.js";
import { config } from "./config.js";
import { esc, hasCoords, toast, guarded } from "./util.js";
import { icon } from "./icons.js";
import { searchPlaces } from "./geo.js";
import { distKm } from "./recorrido.js";

const MAX_KM = 900; // un resultado más lejos que esto del resto del viaje se considera un error de la búsqueda
const MIN_LETTERS = 3;

// Actividades sin ubicación que se pueden buscar (con algo de texto en el lugar o el título), de un día o de todo el viaje.
export function unlocated(day = "") {
  return state.activities.filter((a) => !hasCoords(a) && (!day || a.day === day) && queryOf(a).length >= MIN_LETTERS);
}

const queryOf = (a) => String(a.place || a.title || "").trim();

// El aviso que se enseña en la hoja del mapa; vacío si no hay nada que ubicar.
export function locateHintHtml(day = "") {
  const n = unlocated(day).length;
  if (!n) return "";
  return `<button type="button" class="locate-hint" data-action="locate-all" data-day="${esc(day)}">${icon("pin", 15)} <span>${n} ${n === 1 ? "actividad sin ubicación" : "actividades sin ubicación"}: no sale${n === 1 ? "" : "n"} en el mapa ni en las rutas</span> <b>Ubicar${n === 1 ? "la" : "las"}</b></button>`;
}

// Hacia dónde sesgar la búsqueda: el centro de lo que ya está ubicado, o la vista inicial del mapa.
function centre() {
  const placed = state.activities.filter(hasCoords);
  if (!placed.length) return { lat: config.map.center[1], lng: config.map.center[0], known: false };
  return { lat: placed.reduce((s, a) => s + a.lat, 0) / placed.length, lng: placed.reduce((s, a) => s + a.lng, 0) / placed.length, known: true };
}

let dialog;
let token = 0; // cada búsqueda lleva el suyo: cerrar el diálogo cancela la que está en marcha
let rows = [];

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "locate-dialog";
  dialog.innerHTML = `<div class="dialog-head"><h2>Ubicar actividades</h2><button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon("x")}</button></div>
    <p class="hint" id="locate-status" aria-live="polite"></p>
    <ul class="locate-list" id="locate-list"></ul>
    <div class="dialog-actions"><button type="button" class="btn ghost" data-close>Cancelar</button><button type="button" class="btn primary" id="locate-apply" disabled>Ubicar</button></div>`;
  document.body.append(dialog);
  dialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) dialog.close();
  });
  dialog.addEventListener("close", () => token++);
  dialog.addEventListener("change", (event) => {
    const li = event.target.closest("[data-i]");
    if (!li) return;
    const row = rows[Number(li.dataset.i)];
    if (event.target.matches("select")) row.pick = Number(event.target.value);
    if (event.target.matches("input[type=checkbox]")) row.on = event.target.checked;
    updateApply();
  });
  dialog.querySelector("#locate-apply").addEventListener("click", guarded(apply));
  return dialog;
}

const pickedOf = (row) => row.hits[row.pick] ?? null;

function updateApply() {
  const n = rows.filter((r) => r.on && pickedOf(r)).length;
  const button = dialog.querySelector("#locate-apply");
  button.disabled = n === 0;
  button.textContent = n ? `Ubicar ${n}` : "Ubicar";
}

function renderRows(searching) {
  dialog.querySelector("#locate-list").innerHTML = rows
    .map((r, i) => {
      const hit = pickedOf(r);
      const body = r.state === "waiting" ? `<small>Esperando…</small>` : r.state === "searching" ? `<small>Buscando…</small>` : hit
        ? `<label class="locate-pick"><input type="checkbox" ${r.on ? "checked" : ""}><span>${icon("pin", 14)} ${esc(hit.name)}<small>${esc(hit.detail || "")}${hit.far ? " · lejos del resto del viaje" : ""}</small></span></label>
           ${r.hits.length > 1 ? `<select aria-label="Otros resultados para ${esc(r.a.title)}">${r.hits.map((h, k) => `<option value="${k}" ${k === r.pick ? "selected" : ""}>${esc(h.name)}${h.detail ? ` · ${esc(h.detail.slice(0, 40))}` : ""}</option>`).join("")}</select>` : ""}`
        : `<small class="locate-none">${r.state === "error" ? "No se pudo buscar ahora." : "No se encontró. Ábrela y elige el punto en el mapa."}</small>`;
      return `<li data-i="${i}" class="${hit ? "" : "is-empty"}"><strong>${esc(r.a.title)}</strong>${r.a.place && r.a.place !== r.a.title ? `<small class="locate-q">«${esc(r.a.place)}»</small>` : ""}${body}</li>`;
    })
    .join("");
  dialog.querySelector("#locate-status").textContent = searching
    ? `Buscando ${rows.filter((r) => r.state === "done" || r.state === "error").length + 1} de ${rows.length}… (se va despacio para no saturar el servicio de mapas)`
    : rows.some((r) => pickedOf(r)) ? "Revisa lo encontrado: desmarca lo que no sea correcto o elige otro resultado." : "No se pudo ubicar ninguna. Prueba a abrirlas y elegir el punto en el mapa.";
  updateApply();
}

async function search(a, near) {
  let hits = await searchPlaces(queryOf(a), near);
  if (!hits.length && a.place && a.title && a.title !== a.place && a.title.trim().length >= MIN_LETTERS) hits = await searchPlaces(a.title.trim(), near);
  return hits
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng))
    .map((h) => ({ ...h, far: near.known && distKm(near, h) > MAX_KM }))
    .sort((x, y) => Number(x.far) - Number(y.far)); // los que están en la zona del viaje, primero (el orden de Nominatim se conserva)
}

export async function openLocate(day = "") {
  const list = unlocated(day);
  if (!list.length) return toast("No hay actividades sin ubicación.");
  ensureDialog();
  const mine = ++token;
  const near = centre();
  rows = list.map((a) => ({ a, hits: [], pick: 0, on: false, state: "waiting" }));
  renderRows(true);
  dialog.showModal();
  for (const row of rows) {
    if (mine !== token) return; // se cerró el diálogo
    row.state = "searching";
    renderRows(true);
    try {
      row.hits = await search(row.a, near);
      row.on = row.hits.length > 0 && !row.hits[0].far; // lo que cae lejos del viaje queda sin marcar
      row.state = "done";
    } catch (err) {
      console.warn("Ubicar:", err.message || err);
      row.state = "error";
    }
  }
  if (mine === token) renderRows(false);
}

async function apply() {
  const chosen = rows.filter((r) => r.on && pickedOf(r));
  if (!chosen.length) return;
  const button = dialog.querySelector("#locate-apply");
  button.disabled = true;
  let done = 0;
  for (const r of chosen) {
    const hit = pickedOf(r);
    try {
      await ctx.store.saveActivity({ id: r.a.id, lat: Number(hit.lat.toFixed(6)), lng: Number(hit.lng.toFixed(6)) });
      done++;
    } catch (err) {
      console.warn("Ubicar:", err.message || err);
    }
  }
  dialog.close();
  await ctx.actions.refresh();
  toast(done === chosen.length ? `📍 ${done} ${done === 1 ? "actividad ubicada" : "actividades ubicadas"}. Ya salen en el mapa y en las rutas.` : `Se ubicaron ${done} de ${chosen.length}; el resto no se pudo guardar.`, 6000);
}

export const ubicarActions = { "locate-all": ({ day }) => openLocate(day || "") };
