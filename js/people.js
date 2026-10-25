// Panel «Viajeros»: quién está en línea, cuándo se vio por última vez a cada uno y, si compartió su ubicación, dónde está.
// Combina la presencia (presencia.sql), las posiciones en vivo (vivo.sql) y los nombres de quienes ya han añadido algo.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, esc, ago } from "./util.js";
import { getName } from "./store.js";
import { settings } from "./settings.js";
import { people, hueOf } from "./ledger.js";
import { setShowOnline } from "./presence.js";

const ONLINE_MS = 100_000; // un latido de hace menos de ~100 s cuenta como "en línea"
const LIVE_MS = 30 * 60_000; // una posición de hace más de 30 min ya no se muestra
const key = (name) => String(name ?? "").trim().toLowerCase();

export function peopleRows() {
  const myId = ctx.store?.user?.id;
  const mine = key(getName());
  const rows = new Map();
  const row = (name) => {
    const k = key(name);
    if (!rows.has(k)) rows.set(k, { name: String(name || "Viajero").trim(), id: null, lastSeen: 0, online: false, loc: null, me: Boolean(mine) && k === mine });
    return rows.get(k);
  };
  const now = Date.now();
  for (const p of state.presence) {
    const r = row(p.name);
    const t = Date.parse(p.last_seen) || 0;
    r.id = p.user_id;
    r.lastSeen = Math.max(r.lastSeen, t);
    r.online ||= now - t < ONLINE_MS;
    r.me ||= p.user_id === myId;
  }
  for (const l of state.live) {
    const r = row(l.name);
    const t = Date.parse(l.updated_at) || 0;
    r.id ??= l.user_id;
    r.me ||= l.user_id === myId;
    if (now - t < LIVE_MS) r.loc = { lat: l.lat, lng: l.lng, at: t };
  }
  for (const name of people()) row(name); // quienes ya han añadido algo aunque nunca hayan aparecido en línea
  return [...rows.values()].sort((a, b) => b.me - a.me || b.online - a.online || Boolean(b.loc) - Boolean(a.loc) || b.lastSeen - a.lastSeen || a.name.localeCompare(b.name, "es"));
}

export const onlineCount = () => peopleRows().filter((r) => r.online).length;

function statusOf(r) {
  if (r.online) return `<span class="st-online">En línea ahora</span>`;
  if (r.me && !settings.showOnline) return "Has ocultado que estás en línea";
  return r.lastSeen ? `Visto ${esc(ago(r.lastSeen))}` : "Todavía no ha entrado";
}

export function renderPeople() {
  const rows = peopleRows();
  const list = rows
    .map(
      (r, i) => `<li class="viajero ${r.online ? "is-online" : ""}">
      <span class="person-dot lg" style="--h:${hueOf(r.name)}" aria-hidden="true">${esc(r.name.charAt(0).toUpperCase())}${r.online ? `<i class="on" aria-hidden="true"></i>` : ""}</span>
      <div class="req-text"><strong>${esc(r.name)}${r.me ? ` <small class="you">tú</small>` : ""}</strong>
        <small>${statusOf(r)}</small>
        ${r.loc ? `<small class="loc">${icon("pin", 13)} Compartiendo su ubicación · ${esc(ago(r.loc.at))}</small><button type="button" class="btn small" data-person="${i}">${icon("map", 15)} Ver dónde está</button>` : ""}</div>
    </li>`,
    )
    .join("");
  $("#people-body").dataset.rows = JSON.stringify(rows.map((r) => r.loc ?? null));
  const sharing = ctx.store?.mode === "supabase";
  $("#people-body").innerHTML = `
    <ul class="viajeros">${list}</ul>
    <section><h3>Para ti</h3>
      <label class="switch"><input type="checkbox" id="people-online" ${settings.showOnline ? "checked" : ""}><span>Mostrar que estoy en línea</span></label>
      ${sharing ? `<label class="switch"><input type="checkbox" id="people-live" ${state.sharing ? "checked" : ""}><span>Compartir mi ubicación con los viajeros</span></label>` : ""}
      <p class="hint">Solo lo ven los viajeros autorizados. La ubicación se comparte únicamente mientras tengas la web abierta con esto activado; puedes dejar de compartirla cuando quieras.</p>
    </section>`;
}

const dialog = $("#people-dialog");
export const refreshPeopleDialog = () => dialog.open && renderPeople();

export function openPeople() {
  renderPeople();
  dialog.showModal();
}

export function initPeople() {
  $("#people-btn").addEventListener("click", openPeople);
  $("#people-body").addEventListener("click", (event) => {
    const button = event.target.closest("[data-person]");
    if (!button) return;
    const loc = JSON.parse($("#people-body").dataset.rows)[Number(button.dataset.person)];
    if (!loc) return;
    dialog.close();
    ctx.actions.focusPerson(loc.lat, loc.lng);
  });
  $("#people-body").addEventListener("change", (event) => {
    if (event.target.id === "people-online") setShowOnline(event.target.checked);
    if (event.target.id === "people-live") ctx.actions.setSharing(event.target.checked);
  });
}
