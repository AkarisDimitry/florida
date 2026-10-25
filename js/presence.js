// Quién está en línea. Mientras la web está abierta y visible se envía un latido cada ~45 s y se consulta la lista de
// personas cada 30 s (una consulta pequeña: no recarga el resto de los datos). Cada persona puede dejar de aparecer.
import { state, ctx } from "./state.js";
import { settings, setSetting } from "./settings.js";
import { getName } from "./store.js";

const BEAT_MS = 45_000;
const POLL_MS = 30_000;
let timers = [];
let started = false;
let onPeople = () => {};
let warned = false;

async function beat() {
  if (document.hidden || !settings.showOnline || !getName() || !state.presenceOn) return;
  try {
    await ctx.store.heartbeat(getName());
  } catch (err) {
    if (!warned) console.warn("Presencia:", err.message || err);
    warned = true;
  }
}

// Consulta ligera de personas (presencia y posiciones en vivo) y repinta solo lo que las muestra.
export async function refreshPeople() {
  if (document.hidden || !ctx.store) return;
  try {
    Object.assign(state, await ctx.store.loadPeople());
    onPeople();
  } catch (err) {
    console.warn("Personas:", err.message || err);
  }
}

const tick = async () => {
  await beat();
  await refreshPeople();
};
const onVisible = () => {
  if (!document.hidden && started) tick();
};

export function startPresence(callback) {
  onPeople = callback;
  if (started) return;
  started = true;
  timers = [setInterval(beat, BEAT_MS), setInterval(refreshPeople, POLL_MS)];
  document.addEventListener("visibilitychange", onVisible);
  tick();
}

export function stopPresence() {
  if (!started) return;
  started = false;
  for (const t of timers) clearInterval(t);
  timers = [];
  document.removeEventListener("visibilitychange", onVisible);
}

// "Mostrar que estoy en línea": al apagarlo se borra el rastro propio; al encenderlo se vuelve a aparecer enseguida.
export async function setShowOnline(on) {
  setSetting("showOnline", on);
  try {
    if (on) await beat();
    else await ctx.store.stopHeartbeat();
  } catch (err) {
    console.warn("Presencia:", err.message || err);
  }
  await refreshPeople();
}
