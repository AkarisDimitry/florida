// Atajos del diálogo de gastos: cada uno fija el concepto Y la categoría, se ordenan por los más usados en este dispositivo,
// y los importes rápidos rellenan la cantidad con un toque. Un gasto típico: atajo → importe → Guardar.
import { config } from "./config.js";
import { read, persist } from "./state.js";

// [emoji, concepto, categoría]. Los gastos y las compras tienen los suyos.
export const PRESETS = {
  gasto: [
    ["⛽", "Nafta", "nafta"], ["🍽️", "Comida", "comida"], ["🎟️", "Salidas", "salidas"], ["☕", "Café y snacks", "comida"], ["🍺", "Bebidas", "comida"], ["🛣️", "Peajes", "transporte"],
    ["🅿️", "Estacionamiento", "transporte"], ["🚕", "Taxi / Uber", "transporte"], ["🏨", "Alojamiento", "alojamiento"], ["🎡", "Entradas", "salidas"], ["🎁", "Souvenirs", "compras"], ["💊", "Farmacia", "salud"],
  ],
  compra: [
    ["🛒", "Supermercado", "comida"], ["🥖", "Pan y desayuno", "comida"], ["🍎", "Fruta y verdura", "comida"], ["🥤", "Bebidas y agua", "comida"], ["🍿", "Snacks", "comida"],
    ["🧴", "Protector solar", "salud"], ["💊", "Farmacia", "salud"], ["🧊", "Hielo", "comida"], ["🏖️", "Playa", "salidas"], ["🎁", "Souvenirs", "compras"],
  ],
};

// ---------- más usados ----------

const USE_KEY = "viaje.presetsUso"; // { "gasto|Nafta": 3, … } (solo este dispositivo)
const norm = (text) => String(text ?? "").trim().toLowerCase();
const useCounts = () => {
  const stored = read(USE_KEY, {});
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
};

// Los atajos del tipo, de más a menos usados; en empate, en su orden de siempre (así sin uso se ven como antes).
export function orderedPresets(kind) {
  const counts = useCounts();
  const uses = (label) => Math.max(0, Math.floor(Number(counts[`${kind}|${label}`]))) || 0;
  return (PRESETS[kind] ?? []).map((preset, index) => ({ preset, index, uses: uses(preset[1]) })).sort((a, b) => b.uses - a.uses || a.index - b.index).map((x) => x.preset);
}

// El atajo que corresponde a un concepto (sin distinguir mayúsculas), o undefined.
export const presetFor = (kind, title) => (PRESETS[kind] ?? []).find(([, label]) => norm(label) === norm(title));

// Apunta un uso cuando se guarda un gasto cuyo concepto es el de un atajo (tocado o escrito a mano).
export function bumpPreset(kind, title) {
  const preset = presetFor(kind, title);
  if (!preset) return false;
  const counts = useCounts();
  const key = `${kind}|${preset[1]}`;
  counts[key] = (Math.max(0, Math.floor(Number(counts[key]))) || 0) + 1;
  persist(USE_KEY, counts);
  return true;
}

// ---------- importes rápidos ----------

export const QUICK_AMOUNTS = [5, 10, 20, 50, 100];
const wholeMoney = new Intl.NumberFormat("es", { style: "currency", currency: config.trip.currency || "EUR", maximumFractionDigits: 0 });
export const quickLabel = (amount) => wholeMoney.format(amount);
