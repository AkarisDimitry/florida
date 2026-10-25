// Reacciones («me gusta» y emojis) en comentarios, fotos y mensajes del chat. Los datos viven en este módulo (una tabla `reactions`
// en Supabase, o el navegador en el modo demo); las barras de reacciones se dibujan donde haga falta con reactionBarHtml(tipo, id) y
// se actualizan solas cuando alguien reacciona (tiempo real), sin repintar el resto de la página: así no se corta un audio ni se
// pierde lo escrito.
import { state, ctx } from "./state.js";
import { esc, toast } from "./util.js";
import { getName } from "./store.js";
import { REACTION_EMOJIS } from "./emojis.js";

const DEMO_KEY = "viaje.reacciones";
const MAX_PER_PERSON = 6; // lo mismo que impone la base de datos

const R = {
  map: new Map(), // "tipo:id" -> Map(emoji -> [{ user_id, name }])
  started: false,
  loading: false,
  loaded: false,
  missing: false, // faltan las tablas: no se ofrece nada
  channel: null,
  picker: null, // clave de la barra con el selector abierto
};

const demo = () => ctx.store?.mode !== "supabase";
const me = () => (demo() ? "local" : ctx.store?.user?.id ?? null);
const sb = () => ctx.store?.sb;
const keyOf = (kind, id) => `${kind}:${id}`;
const parseKey = (key) => ({ kind: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1) });

// ---------- datos ----------

function put(row) {
  const key = keyOf(row.target_kind, row.target_id);
  if (!R.map.has(key)) R.map.set(key, new Map());
  const by = R.map.get(key);
  if (!by.has(row.emoji)) by.set(row.emoji, []);
  const list = by.get(row.emoji);
  if (!list.some((u) => u.user_id === row.user_id)) list.push({ user_id: row.user_id, name: row.name || "Alguien" });
}

function drop(row) {
  const key = keyOf(row.target_kind, row.target_id);
  const by = R.map.get(key);
  const list = by?.get(row.emoji);
  if (!list) return false;
  const i = list.findIndex((u) => u.user_id === row.user_id);
  if (i < 0) return false;
  list.splice(i, 1);
  if (!list.length) by.delete(row.emoji);
  if (!by.size) R.map.delete(key);
  return true;
}

const mine = (key) => {
  const set = new Set();
  for (const [emoji, list] of R.map.get(key) ?? []) if (list.some((u) => u.user_id === me())) set.add(emoji);
  return set;
};

function readDemo() {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY) || "[]");
  } catch {
    return [];
  }
}
function writeDemo() {
  const rows = [];
  for (const [key, by] of R.map) for (const [emoji, list] of by) for (const u of list) rows.push({ target_kind: parseKey(key).kind, target_id: parseKey(key).id, user_id: u.user_id, name: u.name, emoji });
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(rows));
  } catch {
    throw new Error("El navegador se ha quedado sin espacio para el modo demo.");
  }
}

const isMissing = (error) => ["42P01", "PGRST205"].includes(error?.code) || /does not exist|schema cache|could not find the table/i.test(error?.message || "");

async function load() {
  if (R.loading) return;
  R.loading = true;
  try {
    if (demo()) {
      R.map.clear();
      for (const row of readDemo()) put(row);
    } else {
      const { data, error } = await sb().from("reactions").select("target_kind,target_id,user_id,name,emoji").limit(10000);
      if (error) throw error;
      R.map.clear();
      for (const row of data ?? []) put(row);
      R.missing = false;
    }
    R.loaded = true;
  } catch (err) {
    if (isMissing(err)) R.missing = true;
    else console.warn("Reacciones:", err.message || err);
  } finally {
    R.loading = false;
    paintAll();
  }
}

function subscribe() {
  if (R.channel || demo() || !sb()) return;
  try {
    R.channel = sb()
      .channel("viaje-reacciones")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "reactions" }, (e) => {
        if (e.new?.target_id) {
          put(e.new);
          paint(keyOf(e.new.target_kind, e.new.target_id));
        }
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "reactions" }, (e) => {
        // Con la identidad de réplica por defecto, el borrado trae la clave primaria completa (cosa, persona y emoji).
        if (e.old?.target_id && e.old?.user_id && e.old?.emoji && drop(e.old)) paint(keyOf(e.old.target_kind, e.old.target_id));
      })
      .subscribe();
  } catch (err) {
    console.warn("Reacciones en directo:", err.message || err);
  }
}

// Lo llama app.js en cada pintado: arranca la carga y el tiempo real la primera vez que hay sesión (o enseguida en el modo demo).
export function syncReacciones() {
  const ready = demo() ? Boolean(ctx.store) : Boolean(ctx.store?.user) && state.member !== false;
  if (ready && !R.started) {
    R.started = true;
    subscribe();
    load();
  } else if (!ready && R.started) {
    R.started = false;
    R.loaded = false;
    R.map.clear();
    try {
      if (R.channel) sb()?.removeChannel?.(R.channel);
    } catch {
      /* ya cerrado */
    }
    R.channel = null;
  }
}

// ---------- dibujo ----------

function barInner(kind, id) {
  const key = keyOf(kind, id);
  const by = R.map.get(key);
  const data = `data-kind="${esc(kind)}" data-id="${esc(id)}"`;
  const pills = [...(by ?? [])]
    .sort((a, b) => b[1].length - a[1].length || REACTION_EMOJIS.indexOf(a[0]) - REACTION_EMOJIS.indexOf(b[0]))
    .map(([emoji, list]) => {
      const names = list.map((u) => (u.user_id === me() ? "Tú" : u.name)).join(", ");
      const isMine = list.some((u) => u.user_id === me());
      return `<button type="button" class="react-pill ${isMine ? "is-mine" : ""}" data-action="react-toggle" ${data} data-emoji="${esc(emoji)}" aria-pressed="${isMine}" aria-label="${esc(emoji)} ${list.length}: ${esc(names)}" title="${esc(names)}"><span class="re" aria-hidden="true">${esc(emoji)}</span><span class="rn">${list.length}</span></button>`;
    })
    .join("");
  const hasHeart = by?.get("❤️")?.some((u) => u.user_id === me());
  const like = hasHeart ? "" : `<button type="button" class="react-like" data-action="react-toggle" ${data} data-emoji="❤️" aria-label="Me gusta">♡</button>`;
  const open = R.picker === key;
  const picker = open
    ? `<div class="react-picker" role="group" aria-label="Elegir una reacción">${REACTION_EMOJIS.map((e) => `<button type="button" class="react-opt ${mine(key).has(e) ? "is-mine" : ""}" data-action="react-toggle" ${data} data-emoji="${esc(e)}" data-close="1" aria-pressed="${mine(key).has(e)}" aria-label="Reaccionar con ${esc(e)}">${esc(e)}</button>`).join("")}</div>`
    : "";
  return `${like}${pills}<button type="button" class="react-add" data-action="react-picker" ${data} aria-label="${open ? "Cerrar las reacciones" : "Elegir una reacción"}" aria-expanded="${open}">${open ? "✕" : "☺"}</button>${picker}`;
}

// El contenedor de una barra de reacciones. Se puede meter en cualquier plantilla.
export function reactionBarHtml(kind, id) {
  if (R.missing || !id) return "";
  return `<div class="react-bar" data-react="${esc(keyOf(kind, id))}">${barInner(kind, id)}</div>`;
}

function paint(key) {
  const { kind, id } = parseKey(key);
  for (const el of document.querySelectorAll(`[data-react="${CSS.escape(key)}"]`)) el.innerHTML = barInner(kind, id);
}

function paintAll() {
  if (R.missing) {
    for (const el of document.querySelectorAll("[data-react]")) el.remove();
    return;
  }
  for (const el of document.querySelectorAll("[data-react]")) {
    const { kind, id } = parseKey(el.dataset.react);
    el.innerHTML = barInner(kind, id);
  }
}

// ---------- acciones ----------

async function toggle({ kind, id, emoji, close }) {
  const key = keyOf(kind, id);
  if (!REACTION_EMOJIS.includes(emoji)) return;
  const had = mine(key).has(emoji);
  if (!had && mine(key).size >= MAX_PER_PERSON) {
    toast(`Como mucho ${MAX_PER_PERSON} reacciones distintas por persona. Quita alguna antes de añadir otra.`);
    return;
  }
  const row = { target_kind: kind, target_id: id, user_id: me(), name: getName() || "Viajero", emoji };
  // Se ve al instante; si el servidor lo rechaza se deshace.
  if (had) drop(row);
  else put(row);
  if (close) R.picker = null;
  paint(key);
  try {
    if (demo()) {
      writeDemo();
      return;
    }
    if (had) {
      const { error } = await sb().from("reactions").delete().eq("target_kind", kind).eq("target_id", id).eq("user_id", me()).eq("emoji", emoji);
      if (error) throw error;
    } else {
      const { error } = await sb().from("reactions").insert({ target_kind: kind, target_id: id, name: row.name, emoji });
      if (error && error.code !== "23505") throw error;
    }
  } catch (err) {
    if (had) put(row);
    else drop(row);
    paint(key);
    toast(isMissing(err) ? "Falta ejecutar todo_en_uno.sql en Supabase para usar las reacciones." : /no existe/i.test(err.message || "") ? "Eso ya no existe." : err.message || "No se pudo guardar la reacción.");
  }
}

function togglePicker({ kind, id }) {
  const key = keyOf(kind, id);
  const previous = R.picker;
  R.picker = previous === key ? null : key;
  if (previous && previous !== key) paint(previous);
  paint(key);
}

export const reaccionesActions = {
  "react-toggle": (data) => toggle(data),
  "react-picker": (data) => togglePicker(data),
};

// Para los contenedores que no pasan por el reparto de acciones de app.js (como el chat). Devuelve true si el clic era de una reacción.
export function handleReactionClick(event) {
  const target = event.target.closest?.("[data-action^='react-']");
  if (!target) return false;
  reaccionesActions[target.dataset.action]?.({ ...target.dataset });
  return true;
}

// Para las pruebas y para otros módulos.
export const reactionsOf = (kind, id) => [...(R.map.get(keyOf(kind, id)) ?? [])].map(([emoji, list]) => ({ emoji, count: list.length, mine: list.some((u) => u.user_id === me()), names: list.map((u) => u.name) }));
