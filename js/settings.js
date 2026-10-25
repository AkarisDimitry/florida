// Ajustes de cada persona (se guardan en este navegador): unidades, tema, animaciones y opciones del PDF.
import { read, persist } from "./state.js";

const DEFAULTS = {
  distance: "km", // km | mi
  temperature: "c", // c | f
  theme: "auto", // auto | light | dark
  animations: "auto", // auto (sigue al sistema) | off
  showOnline: true, // aparecer "en línea" para los demás viajeros
  shareBattery: true, // enviar el nivel de batería de este móvil junto con el latido (solo Chrome/Edge lo permiten)
  locatePhotos: true, // poner mi ubicación (la de ahora) a las fotos que no traen GPS
  expenseLocation: "on", // on | off: poner mi ubicación a los gastos nuevos, para verlos en el mapa
  accent: "ocean", // ocean | sunset | forest | grape | rose
  pdfMaps: true,
  pdfComments: true,
  pdfWiki: true,
  pdfAppendix: true,
  pdfQuality: "normal", // small | normal | high
};

const KEY = "viaje.ajustes";
export const settings = { ...DEFAULTS, ...read(KEY, {}) };
const listeners = new Set();

export function applyAppearance() {
  const root = document.documentElement;
  if (settings.theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = settings.theme;
  if (settings.accent === "ocean") root.removeAttribute("data-accent");
  else root.dataset.accent = settings.accent;
  if (settings.animations === "off") root.dataset.motion = "off";
  else root.removeAttribute("data-motion");
}

export function setSetting(key, value) {
  settings[key] = value;
  persist(KEY, settings);
  applyAppearance();
  for (const fn of listeners) fn(key, value);
}

export const onSettingChange = (fn) => listeners.add(fn);
applyAppearance();
