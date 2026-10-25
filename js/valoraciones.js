// Valoraciones con estrellas (1 a 5) de las fotos del viaje: se puntúan las de los demás (no las propias), se ve la nota media de cada
// foto en la galería y en el visor, y una tira con las mejor valoradas arriba de Fotos. Los datos viven aquí (tabla `photo_ratings` en
// Supabase, o el navegador en el modo demo) y se actualizan en directo sin repintar la página. La puntuación de las fotos de la batalla
// es aparte (js/juegos/batalla.js, función rate_battle_entry): este módulo exporta `starsHtml` para reutilizar las estrellas allí.
import { state, ctx } from "./state.js";
import { esc, toast } from "./util.js";
import { getName } from "./store.js";

const DEMO_KEY = "viaje.valoraciones";

const V = {
  map: new Map(), // photo_id -> Map(user_id -> { stars, name })
  started: false,
  loading: false,
  missing: false,
  channel: null,
};

const demo = () => ctx.store?.mode !== "supabase";
const me = () => (demo() ? "local" : ctx.store?.user?.id ?? null);
const sb = () => ctx.store?.sb;
const fmt = (n) => n.toFixed(1).replace(".", ",");

// ---------- datos ----------

function put(row) {
  if (!V.map.has(row.photo_id)) V.map.set(row.photo_id, new Map());
  V.map.get(row.photo_id).set(row.user_id, { stars: Number(row.stars), name: row.name || "Alguien" });
}
function drop(photoId, userId) {
  const by = V.map.get(photoId);
  if (!by?.delete(userId)) return false;
  if (!by.size) V.map.delete(photoId);
  return true;
}

// { avg, n, mine }: la media (0 si nadie la ha puntuado), cuántas notas y la nota de esta persona (0 si no puntuó).
export function ratingOf(photoId) {
  const by = V.map.get(photoId);
  if (!by?.size) return { avg: 0, n: 0, mine: 0 };
  let sum = 0;
  for (const r of by.values()) sum += r.stars;
  return { avg: sum / by.size, n: by.size, mine: by.get(me())?.stars ?? 0 };
}

const isOwn = (photo) => Boolean(photo) && (demo() ? true : photo.created_by === me());
const photoById = (id) => state.photos.find((p) => p.id === id);

function readDemo() {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY) || "[]");
  } catch {
    return [];
  }
}
function writeDemo() {
  const rows = [];
  for (const [photo_id, by] of V.map) for (const [user_id, r] of by) rows.push({ photo_id, user_id, name: r.name, stars: r.stars });
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(rows));
  } catch {
    throw new Error("El navegador se ha quedado sin espacio para el modo demo.");
  }
}

const isMissing = (error) => ["42P01", "PGRST205"].includes(error?.code) || /does not exist|schema cache|could not find the table/i.test(error?.message || "");

async function load() {
  if (V.loading) return;
  V.loading = true;
  try {
    V.map.clear();
    if (demo()) for (const row of readDemo()) put(row);
    else {
      const { data, error } = await sb().from("photo_ratings").select("photo_id,user_id,name,stars").limit(10000);
      if (error) throw error;
      for (const row of data ?? []) put(row);
      V.missing = false;
    }
  } catch (err) {
    if (isMissing(err)) V.missing = true;
    else console.warn("Valoraciones:", err.message || err);
  } finally {
    V.loading = false;
    paintAll();
  }
}

function subscribe() {
  if (V.channel || demo() || !sb()) return;
  try {
    V.channel = sb()
      .channel("viaje-valoraciones")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "photo_ratings" }, (e) => e.new?.photo_id && (put(e.new), paintPhoto(e.new.photo_id)))
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "photo_ratings" }, (e) => e.new?.photo_id && (put(e.new), paintPhoto(e.new.photo_id)))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "photo_ratings" }, (e) => e.old?.photo_id && e.old?.user_id && drop(e.old.photo_id, e.old.user_id) && paintPhoto(e.old.photo_id))
      .subscribe();
  } catch (err) {
    console.warn("Valoraciones en directo:", err.message || err);
  }
}

// Lo llama app.js en cada pintado: arranca la carga y el tiempo real la primera vez que hay sesión (o enseguida en el modo demo).
export function syncValoraciones() {
  const ready = demo() ? Boolean(ctx.store) : Boolean(ctx.store?.user) && state.member !== false;
  if (ready && !V.started) {
    V.started = true;
    subscribe();
    load();
  } else if (!ready && V.started) {
    V.started = false;
    V.map.clear();
    try {
      if (V.channel) sb()?.removeChannel?.(V.channel);
    } catch {
      /* ya cerrado */
    }
    V.channel = null;
  }
}

// ---------- dibujo ----------

// Cinco estrellas. `current` = las que se ven rellenas; `attrs` = atributos que lleva cada botón (data-action, data-id…); sin `attrs`
// son solo de mostrar (no se pueden tocar).
export function starsHtml(current, attrs = "", label = "estrellas") {
  const n = Math.round(current);
  return `<span class="stars-row ${attrs ? "is-input" : ""}" role="${attrs ? "group" : "img"}" aria-label="${n} de 5 ${label}">${[1, 2, 3, 4, 5]
    .map((i) =>
      attrs
        ? `<button type="button" class="star ${i <= n ? "is-on" : ""}" ${attrs} data-stars="${i}" aria-label="${i} ${i === 1 ? "estrella" : "estrellas"}" aria-pressed="${i === n}">${i <= n ? "★" : "☆"}</button>`
        : `<span class="star ${i <= n ? "is-on" : ""}" aria-hidden="true">${i <= n ? "★" : "☆"}</span>`,
    )
    .join("")}</span>`;
}

function boxInner(photoId) {
  const photo = photoById(photoId);
  const { avg, n, mine } = ratingOf(photoId);
  const summary = n ? `<span class="rate-avg"><strong>★ ${fmt(avg)}</strong> · ${n} ${n === 1 ? "valoración" : "valoraciones"}</span>` : `<span class="rate-avg is-none">Todavía sin valorar</span>`;
  if (isOwn(photo) && !demo()) return `<span class="rate-own">Tu foto</span>${summary}`;
  return `${starsHtml(mine, `data-action="rate-photo" data-id="${esc(photoId)}"`, "estrellas, tu nota")}${summary}${mine ? `<small class="rate-mine">Tu nota: ${mine}. Toca la misma estrella para quitarla</small>` : `<small class="rate-mine">Toca las estrellas para puntuar esta foto</small>`}`;
}

// La caja de estrellas del visor de fotos. Se rellena sola y se actualiza en directo.
export function ratingBoxHtml(photoId) {
  if (V.missing || !photoId) return "";
  return `<div class="rate-box" data-rate="${esc(photoId)}">${boxInner(photoId)}</div>`;
}

// «★ 4,3» sobre la miniatura de una foto con notas.
export function ratingBadgeHtml(photoId) {
  if (V.missing) return "";
  const { avg, n } = ratingOf(photoId);
  return `<span class="rate-badge" data-rate-badge="${esc(photoId)}" ${n ? "" : "hidden"}>${n ? `★ ${fmt(avg)}` : ""}</span>`;
}

// La tira de las mejor valoradas (arriba de Fotos).
function topInner() {
  const top = state.photos
    .filter((p) => !p.expense_id && ratingOf(p.id).n > 0)
    .map((p) => ({ p, ...ratingOf(p.id) }))
    .sort((a, b) => b.avg - a.avg || b.n - a.n)
    .slice(0, 10);
  if (!top.length) return "";
  return `<h3 class="top-title">⭐ Mejor valoradas</h3><div class="top-strip">${top
    .map(
      ({ p, avg, n }) => `<button type="button" class="top-photo" data-action="open-photo" data-id="${esc(p.id)}" aria-label="Foto de ${esc(p.created_by_name || "un viajero")}, ${fmt(avg)} de 5 con ${n} ${n === 1 ? "valoración" : "valoraciones"}">
        <img src="${esc(p.thumb_url)}" alt="" loading="lazy" decoding="async"><span class="rate-badge">★ ${fmt(avg)}</span></button>`,
    )
    .join("")}</div>`;
}
export function topRatedHtml() {
  if (V.missing) return "";
  return `<section class="top-rated" data-rate-top ${topInner() ? "" : "hidden"}>${topInner()}</section>`;
}

function paintPhoto(photoId) {
  for (const el of document.querySelectorAll(`[data-rate="${CSS.escape(photoId)}"]`)) el.innerHTML = boxInner(photoId);
  for (const el of document.querySelectorAll(`[data-rate-badge="${CSS.escape(photoId)}"]`)) {
    const { avg, n } = ratingOf(photoId);
    el.hidden = !n;
    el.textContent = n ? `★ ${fmt(avg)}` : "";
  }
  paintTop();
}

function paintTop() {
  for (const el of document.querySelectorAll("[data-rate-top]")) {
    const html = topInner();
    el.hidden = !html;
    el.innerHTML = html;
  }
}

function paintAll() {
  if (V.missing) {
    for (const el of document.querySelectorAll("[data-rate], [data-rate-badge], [data-rate-top]")) el.remove();
    return;
  }
  for (const el of document.querySelectorAll("[data-rate]")) el.innerHTML = boxInner(el.dataset.rate);
  for (const el of document.querySelectorAll("[data-rate-badge]")) paintPhoto(el.dataset.rateBadge);
  paintTop();
}

// ---------- puntuar ----------

async function rate({ id, stars }) {
  const photo = photoById(id);
  if (!photo) return;
  if (isOwn(photo) && !demo()) return toast("No puedes valorar tu propia foto.");
  const wanted = Number(stars);
  const previous = V.map.get(id)?.get(me()) ?? null;
  const remove = previous?.stars === wanted; // tocar la misma estrella quita la nota
  const name = getName() || "Viajero";
  if (remove) drop(id, me());
  else put({ photo_id: id, user_id: me(), name, stars: wanted });
  paintPhoto(id);
  try {
    if (demo()) return void writeDemo();
    if (remove) {
      const { error } = await sb().from("photo_ratings").delete().eq("photo_id", id).eq("user_id", me());
      if (error) throw error;
    } else {
      const { error } = await sb().from("photo_ratings").upsert({ photo_id: id, name, stars: wanted }, { onConflict: "photo_id,user_id" });
      if (error) throw error;
    }
  } catch (err) {
    if (previous) put({ photo_id: id, user_id: me(), name: previous.name, stars: previous.stars });
    else drop(id, me());
    paintPhoto(id);
    toast(isMissing(err) ? "Falta ejecutar todo_en_uno.sql en Supabase para valorar las fotos." : err.message || "No se pudo guardar la nota.");
  }
}

export const valoracionesActions = { "rate-photo": (data) => rate(data) };

export const photoRatings = (id) => [...(V.map.get(id) ?? [])].map(([user_id, r]) => ({ user_id, ...r }));
