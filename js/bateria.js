// Batería del móvil, para que la familia sepa quién se queda sin carga. Se envía junto con el latido de «estoy en línea»
// (js/presence.js) y se ve en el panel de personas (js/people.js).
//
// Limitación: solo Chrome y Edge (Android y escritorio) dejan leer la batería desde una web. Safari (iPhone) y Firefox no:
// en esos móviles no se envía nada y el panel lo explica en vez de mostrar un dato falso.
import { settings } from "./settings.js";

const MIN_GAP_MS = 60_000; // entre dos envíos provocados por cambios de nivel
const LOW = 20;

let managerPromise = null;

export const batterySupported = () => typeof navigator !== "undefined" && typeof navigator.getBattery === "function";

// Una sola petición al navegador aunque la pidan dos sitios a la vez (el latido y el vigilante de cambios).
function battery() {
  if (!batterySupported()) return Promise.resolve(null);
  managerPromise ??= navigator.getBattery().catch(() => null); // null si una política de permisos lo bloquea
  return managerPromise;
}

// Lo que se añade al latido: nada si el móvil no deja leer la batería, valores vacíos si la persona decidió no compartirla,
// y el nivel (0-100) y si está cargando en el resto de casos.
export async function batteryPayload() {
  if (!batterySupported()) return {};
  if (!settings.shareBattery) return { battery: null, charging: null };
  const b = await battery();
  if (!b || !Number.isFinite(b.level)) return {};
  return { battery: Math.max(0, Math.min(100, Math.round(b.level * 100))), charging: Boolean(b.charging) };
}

// Avisa cuando cambia de forma que merezca un envío inmediato (empezar o dejar de cargar, o cruzar el 20 % y el 10 % hacia
// abajo); los cambios pequeños esperan al siguiente latido. Devuelve una función para dejar de escuchar.
export async function watchBattery(onChange) {
  const b = await battery();
  if (!b) return () => {};
  let last = Date.now();
  let level = b.level;
  const fire = () => {
    last = Date.now();
    onChange();
  };
  const onLevel = () => {
    const was = Math.round(level * 100);
    const now = Math.round(b.level * 100);
    level = b.level;
    const crossed = (now <= LOW && was > LOW) || (now <= 10 && was > 10);
    if (crossed || Date.now() - last > MIN_GAP_MS * 5) fire();
  };
  b.addEventListener("levelchange", onLevel);
  b.addEventListener("chargingchange", fire);
  return () => {
    b.removeEventListener("levelchange", onLevel);
    b.removeEventListener("chargingchange", fire);
  };
}

// Para mostrar la batería de alguien: nivel, si carga y un estado («low» por debajo del 20 %).
export function describeBattery(level, charging) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  const state = charging ? "charging" : n <= 10 ? "critical" : n <= LOW ? "low" : "ok";
  return { level: n, charging: Boolean(charging), state, text: `${charging ? "⚡" : n <= LOW ? "🪫" : "🔋"} ${n} %` };
}
