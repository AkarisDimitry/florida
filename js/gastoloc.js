// Ubicación de un gasto o compra («📍 Ubicación: aquí»): al abrir «Nuevo gasto» se pide la posición del dispositivo (si el ajuste
// «Poner ubicación a los gastos» está activo) y se puede quitar, cambiar en el mapa o poner a mano. Con ella el gasto sale en el mapa.
// Un gasto antiguo sin ubicación NO recibe la de ahora: solo se pone si la persona lo pide.
import { ctx } from "./state.js";
import { $, esc, guarded, toast, hasCoords } from "./util.js";
import { geolocationMessage, reversePlace } from "./geo.js";
import { settings } from "./settings.js";
import { categoryColumnMissing } from "./categorias.js";

const TIMEOUT_MS = 8000; // un gasto no se queda esperando al GPS
const MAX_AGE_MS = 120000; // vale una posición de hasta 2 minutos

let loc = { status: "none", lat: null, lng: null, source: "" }; // status: loading | ok | none | error
let original = null; // lo que tenía el gasto al abrirlo { lat, lng } o null
let seq = 0; // cada petición lleva su número: la respuesta de una anterior o ya cancelada se descarta
let picking = false; // mientras se elige en el mapa el diálogo está cerrado a propósito
let suggestedFor = ""; // coordenadas para las que ya se propuso una tienda
let form = null;
let dialog = null;
let kindOf = () => "gasto";

const round = (n) => Math.round(Number(n) * 1e6) / 1e6;
const valid = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// Sin las columnas lat y lng (todo_en_uno.sql sin ejecutar) no se ofrece ni se pide el permiso de ubicación.
export const locationSupported = () => !categoryColumnMissing();

function quickPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Este navegador no puede obtener la ubicación."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(geolocationMessage(e))),
      { enableHighAccuracy: true, timeout: TIMEOUT_MS, maximumAge: MAX_AGE_MS },
    );
  });
}

// Si el permiso ya está denegado no se insiste (el navegador no volvería a preguntar): se explica y se ofrece el mapa.
async function permissionDenied() {
  try {
    return (await navigator.permissions?.query({ name: "geolocation" }))?.state === "denied";
  } catch {
    return false;
  }
}

function setLoc(next) {
  loc = { ...loc, ...next };
  renderLocationRow();
}

// Pide la posición del dispositivo. Siempre desde un gesto de la persona (abrir el diálogo o tocar el botón).
async function locate() {
  const mine = ++seq;
  setLoc({ status: "loading" });
  try {
    if (await permissionDenied()) throw new Error(geolocationMessage({ code: 1 }));
    const pos = await quickPosition();
    if (mine !== seq) return;
    if (!valid(pos.lat, pos.lng)) throw new Error("No se pudo obtener la ubicación.");
    setLoc({ status: "ok", lat: round(pos.lat), lng: round(pos.lng), source: "auto", error: "" });
    suggestPlace();
  } catch (err) {
    if (mine !== seq) return;
    setLoc({ status: "error", lat: null, lng: null, error: err.message || "No se pudo obtener la ubicación." });
  }
}

// En las compras, la tienda se propone con el nombre del sitio, sin pisar nada de lo que ya esté escrito.
export async function suggestPlace() {
  if (!form || loc.status !== "ok" || kindOf() !== "compra" || form.elements.place.value.trim()) return;
  const key = `${loc.lat},${loc.lng}`;
  if (suggestedFor === key) return;
  suggestedFor = key;
  try {
    const found = await reversePlace(loc.lat, loc.lng);
    if (found?.name && key === `${loc.lat},${loc.lng}` && !form.elements.place.value.trim() && kindOf() === "compra") form.elements.place.value = found.name;
  } catch {
    /* la tienda es opcional */
  }
}

// Al abrir el diálogo. `expense` es el gasto que se edita; `activity`, la actividad cuyo coste se reparte.
export function startLocation({ expense = null, activity = null } = {}) {
  seq++;
  suggestedFor = "";
  original = expense && hasCoords(expense) ? { lat: expense.lat, lng: expense.lng } : null;
  if (expense) {
    // Editar: se enseña lo que tiene y no se toca (un gasto antiguo sin ubicación sigue sin ella hasta que se pida).
    loc = original ? { status: "ok", ...original, source: "saved", error: "" } : { status: "none", lat: null, lng: null, source: "", error: "" };
    renderLocationRow();
    return;
  }
  if (activity && hasCoords(activity)) {
    // Repartir el coste de una actividad: el gasto es de ese lugar.
    loc = { status: "ok", lat: activity.lat, lng: activity.lng, source: "activity", error: "" };
    renderLocationRow();
    return;
  }
  loc = { status: "none", lat: null, lng: null, source: "", error: "" };
  renderLocationRow();
  if (locationSupported() && settings.expenseLocation !== "off") locate();
}

// Lo que hay que guardar: { lat, lng } con valores o con null (si se quitó la que tenía), o {} si no hay nada que enviar.
export function locationFields() {
  if (!locationSupported()) return {};
  if (loc.status === "ok" && valid(loc.lat, loc.lng)) {
    return original && original.lat === loc.lat && original.lng === loc.lng ? {} : { lat: loc.lat, lng: loc.lng };
  }
  return original ? { lat: null, lng: null } : {};
}

export const hasLocation = () => loc.status === "ok";

// ---------- la fila del diálogo ----------

const SOURCE = { auto: "aquí", map: "elegida en el mapa", saved: "la que tenía guardada", activity: "la de la actividad" };

export function renderLocationRow() {
  const box = $("#expense-loc");
  if (!box) return;
  box.hidden = !locationSupported();
  if (box.hidden) return;
  const btn = (action, label, cls = "") => `<button type="button" class="btn small ${cls}" data-loc="${action}">${label}</button>`;
  let text;
  let buttons;
  if (loc.status === "loading") {
    text = `<span class="loc-text"><b>📍 Buscando tu ubicación…</b></span>`;
    buttons = btn("clear", "Quitar", "ghost");
  } else if (loc.status === "ok") {
    text = `<span class="loc-text"><b>📍 Ubicación: ${esc(SOURCE[loc.source] ?? "aquí")}</b><small>${esc(`${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`)} · saldrá en el mapa</small></span>`;
    buttons = btn("clear", "Quitar", "ghost") + btn("map", "Cambiar en el mapa");
  } else {
    const why = loc.status === "error" && loc.error ? loc.error : original ? "Se quitó la ubicación de este gasto." : settings.expenseLocation === "off" ? "Pon una ubicación para verlo en el mapa." : "No saldrá en el mapa.";
    text = `<span class="loc-text"><b>📍 Sin ubicación</b><small>${esc(why)}</small></span>`;
    buttons = btn("here", "Usar mi ubicación") + btn("map", "Elegir en el mapa", "ghost");
  }
  box.innerHTML = `${text}<span class="loc-actions">${buttons}</span>`;
}

// `deps`: el formulario y el diálogo de gasto, y cómo saber si es una compra (para sugerir la tienda).
export function initLocationRow({ formEl, dialogEl, getKind }) {
  form = formEl;
  dialog = dialogEl;
  kindOf = getKind;
  dialog.addEventListener("close", () => {
    if (!picking) seq++; // cerrar el diálogo cancela la búsqueda en curso
  });
  $("#expense-loc").addEventListener(
    "click",
    guarded(async (event) => {
      const action = event.target.closest("[data-loc]")?.dataset.loc;
      if (!action) return;
      if (action === "clear") {
        seq++;
        setLoc({ status: "none", lat: null, lng: null, source: "", error: "" });
      } else if (action === "here") {
        await locate();
      } else if (action === "map") {
        seq++;
        if (loc.status === "loading") setLoc({ status: "none", lat: null, lng: null, source: "", error: "" }); // la búsqueda en curso se cancela
        picking = true;
        let spot = null;
        try {
          dialog.close();
          spot = await ctx.actions.pickOnMap("Toca el mapa para elegir dónde fue el gasto");
        } finally {
          picking = false;
          if (!dialog.open) dialog.showModal();
        }
        if (spot && valid(spot.lat, spot.lng)) {
          setLoc({ status: "ok", lat: round(spot.lat), lng: round(spot.lng), source: "map", error: "" });
          suggestPlace();
        } else if (spot) toast("Ese punto no es válido. Prueba con otro.");
      }
    }),
  );
}
