// Juego «Álbum de dibujos»: cada viajero dibuja con el dedo (js/juegos/dibujos-lienzo.js), guarda sus dibujos en un álbum compartido de
// la familia y todos los ven, reaccionan (♡ y emojis) y destacan los mejores. Contrato del módulo en docs/JUEGOS.md; SQL en
// supabase/dibujos.sql (tabla `drawings`).
// Los datos viven en variables del módulo (la web repinta toda la página): se cargan al abrir el juego y se refrescan cada ~20 s mientras
// está abierto y la pestaña visible, además de un canal de tiempo real opcional. El lienzo y el visor grande son <dialog> propios colgados
// de <body>: así no los destruyen los repintados. Las reacciones las dibuja js/reacciones.js (tipo «drawing»).
// Los archivos van al bucket privado `photos` (<user_id>/dibujo-<id>.jpg y _t.jpg), pero NO a la tabla `photos`: no son fotos del viaje.
import { state, ctx } from "../state.js";
import { icon } from "../icons.js";
import { esc, toast, ago, safeFormat, fmtStamp } from "../util.js";
import { getName } from "../store.js";
import { hueOf } from "../ledger.js";
import { reactionBarHtml, handleReactionClick, reactionsOf } from "../reacciones.js";
import { openLienzo } from "./dibujos-lienzo.js";

export const meta = { id: "dibujos", title: "Álbum de dibujos", emoji: "🎨", blurb: "Dibuja con el dedo, guarda tus dibujos en el álbum de todos y reacciona a los de los demás." };

const PAGE = 24; // dibujos que se enseñan de golpe (y cada vez que se pide «Ver más»)
const MAX_ROWS = 1000; // los que se cargan como mucho (la base de datos limita a 300 por persona)
const MAX_PER_PERSON = 300; // lo mismo que impone la base de datos
const POLL_MS = 20_000;
const STALE_MS = 60_000; // el resumen del álbum se vuelve a pedir si lleva más de esto sin actualizarse
const SIGN_SECONDS = 6 * 3600;
const SEEN_KEY = "viaje.dibujos.visto";
const UPLOAD_MS = 60_000; // si una subida tarda más, se avisa y se puede reintentar (sin duplicar)

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const when = (iso) => safeFormat(fmtStamp, iso);
const ms = (iso) => Date.parse(iso) || 0;
const sb = () => ctx.store?.sb;
const me = () => ctx.store?.user?.id ?? "";
const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento: solo se pierde la marca de «visto» */
  }
};

// ---------- estado del módulo ----------

let rows = []; // todos los dibujos { id, user_id, name, prompt, path, thumb_path, created_at }, los más recientes primero
let byId = new Map();
let loaded = false; // ya hay datos
let loadError = ""; // fallo al cargar (con datos antiguos delante: «no se pudo actualizar»)
let missing = false; // falta la tabla (dibujos.sql)
let lastLoad = 0;
let filter = "all"; // all | mine | best
let shown = PAGE;
let peekInfo = { total: null, fresh: 0 }; // de la consulta ligera de la lista de juegos
let justSaved = null; // dibujo recién guardado (para la animación)
let active = false;
let timers = [];
let channel = null;
let debounce = null;
let dataKey = "";
let inflight = null;
let editorOpen = false;
let attempt = null; // el guardado en curso: { id, version, tried, saved } (se reutiliza al reintentar: nunca duplica)
let viewer = null; // el <dialog> del visor grande
let V = null; // { ids, index, confirm, busy, error, ai }

// ---------- enlaces firmados (el almacén `photos` es privado) ----------

const urls = new Map(); // ruta -> { url, expires }
const urlOf = (path) => urls.get(path)?.url ?? "";
async function sign(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter((p) => p && !(urls.get(p)?.expires > now));
  if (!need.length || !sb()) return;
  const expires = now + (SIGN_SECONDS - 3600) * 1000; // se renueva una hora antes de que caduque
  for (let i = 0; i < need.length; i += 100) {
    const { data, error } = await sb().storage.from("photos").createSignedUrls(need.slice(i, i + 100), SIGN_SECONDS);
    if (error) throw error;
    for (const { path, signedUrl } of data ?? []) if (signedUrl) urls.set(path, { url: signedUrl, expires });
  }
}

// ---------- errores en español ----------

const isMissing = (e) => ["42P01", "PGRST205"].includes(e?.code) || /does not exist|schema cache|could not find the table/i.test(e?.message || "");
const answered = (err) => Boolean(err?.code || err?.statusCode || err?.status); // el servidor contestó (no fue un corte de red)
const alreadyExists = (err) => String(err?.statusCode ?? err?.status) === "409" || /already exists|duplicate/i.test(err?.message || "");

function friendly(err) {
  const msg = String(err?.message ?? err ?? "");
  if (err?.timeout) return msg;
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) return "No hay conexión con el servidor. Comprueba tu internet e inténtalo de nuevo: tu dibujo sigue aquí.";
  if (/jwt expired|invalid jwt|not authenticated/i.test(msg)) return "Tu sesión ha caducado. Recarga la página y vuelve a entrar.";
  if (isMissing(err)) return "Falta ejecutar todo_en_uno.sql en Supabase para guardar dibujos. No hace daño repetirlo.";
  if (/maximum allowed size|payload too large|too large/i.test(msg)) return "El dibujo pesa demasiado (máximo 5 MB). Prueba a borrar parte del dibujo.";
  if (/mime type|not supported|unsupported/i.test(msg)) return "Solo se admiten imágenes JPG.";
  // Los mensajes en español de la base de datos (el límite de 300 dibujos) se enseñan tal cual.
  if (err?.code === "54000") return msg;
  if (err?.code === "42501" || /row-level security|permission denied|violates row/i.test(msg)) return "No tienes permiso para hacer esto. ¿Sigues autorizado como viajero?";
  if (typeof err?.code === "string" || err?.__isStorageError || err?.status || err?.statusCode) {
    console.warn("Dibujos:", msg);
    return "El servidor no pudo completar la acción. Inténtalo de nuevo en un momento: tu dibujo sigue aquí.";
  }
  return msg || "Algo ha fallado. Inténtalo de nuevo.";
}

// ---------- carga de datos ----------

function load() {
  return (async () => {
    const c = sb();
    if (!c || !me()) return;
    const { data, error } = await c.from("drawings").select("id,user_id,name,prompt,path,thumb_path,created_at").order("created_at", { ascending: false }).limit(MAX_ROWS);
    lastLoad = Date.now();
    if (error) {
      if (isMissing(error)) missing = true;
      else loadError = friendly(error);
      return;
    }
    missing = false;
    loadError = "";
    rows = data ?? [];
    byId = new Map(rows.map((r) => [r.id, r]));
    loaded = true;
    peekInfo = { total: rows.length, fresh: peekInfo.fresh };
    if (active) markSeen();
    // Solo se firman las miniaturas que se van a ver (las de la pantalla, las del resumen del álbum y la del dibujo abierto).
    try {
      await sign(thumbsNeeded());
    } catch (err) {
      console.warn("Dibujos: no se pudieron firmar las miniaturas:", err.message || err);
    }
  })()
    .catch((err) => {
      lastLoad = Date.now();
      loadError = friendly(err);
    })
    .then(afterLoad);
}

const thumbsNeeded = () => [...visible().slice(0, shown), ...summaryPicks()].map((r) => r.thumb_path);

function refresh({ force = false } = {}) {
  if (inflight) return force ? inflight.then(() => refresh()) : inflight;
  inflight = load().finally(() => {
    inflight = null;
  });
  return inflight;
}

const totalOf = (r) => reactionsOf("drawing", r.id).reduce((n, x) => n + x.count, 0);
const bestKey = () => (filter === "best" ? rows.map((r) => `${r.id}:${totalOf(r)}`).join() : "");

// Repinta solo si algo ha cambiado de verdad (así no se pierde el desplazamiento cada 20 s).
function afterLoad() {
  const key = JSON.stringify([missing, loaded, loadError, rows.map((r) => r.id), filter, shown, bestKey()]);
  if (key !== dataKey) {
    dataKey = key;
    ctx.actions.render?.();
  }
  reconcileViewer();
}

// Lo último que se ha visto (para «3 dibujos nuevos» en la tarjeta de la lista de juegos).
function markSeen() {
  const newest = rows[0]?.created_at;
  if (newest && newest > (read(SEEN_KEY) ?? "")) write(SEEN_KEY, newest);
  peekInfo.fresh = 0;
}

// ---------- tiempo real, temporizadores ----------

function subscribe() {
  const c = sb();
  if (!c || channel) return;
  try {
    channel = c
      .channel("viaje-dibujos")
      .on("postgres_changes", { event: "*", schema: "public", table: "drawings" }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => active && refresh(), 700); // varios dibujos seguidos = un solo refresco
      })
      .subscribe();
  } catch (err) {
    console.warn("Dibujos: sin tiempo real:", err.message || err);
  }
}
function unsubscribe() {
  clearTimeout(debounce);
  if (channel) {
    try {
      sb()?.removeChannel(channel);
    } catch {
      /* ya cerrado */
    }
    channel = null;
  }
}
const tick = () => {
  if (active && !document.hidden && !editorOpen) refresh();
};
const onVisible = () => !document.hidden && tick();
const onOnline = () => active && refresh();

// «Mejores» se ordena por reacciones, que llegan por su propio canal: si cambian mientras se mira, se repinta.
let totalsSeen = ""; // las reacciones con las que se pintó «Mejores» la última vez (lo apunta build())
function watchTotals() {
  if (!active || filter !== "best" || !loaded || editorOpen) return;
  if (bestKey() !== totalsSeen) ctx.actions.render?.();
}

export function enter() {
  active = true;
  dataKey = "";
  shown = PAGE;
  timers = [setInterval(tick, POLL_MS), setInterval(watchTotals, 2500)];
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  subscribe();
  refresh();
}

export function leave() {
  active = false;
  for (const t of timers) clearInterval(t);
  timers = [];
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("online", onOnline);
  unsubscribe();
  closeViewer(true);
  viewer?.remove();
  viewer = null;
  // El lienzo NO se cierra aquí: es de pantalla completa y modal, y un dibujo a medias no se debe perder porque cambie la pantalla de fondo.
  if (loaded) markSeen();
}

// Consulta ligera desde la lista de juegos: cuántos dibujos hay y cuántos son nuevos (para la etiqueta de la tarjeta).
export async function peek() {
  const c = sb();
  if (!c || !me()) return;
  const seen = read(SEEN_KEY);
  const total = c.from("drawings").select("id", { count: "exact", head: true });
  const fresh = seen ? c.from("drawings").select("id", { count: "exact", head: true }).gt("created_at", seen).neq("user_id", me()) : null;
  const [a, b] = await Promise.all([total, fresh ?? Promise.resolve({ count: 0 })]);
  if (a.error) {
    if (isMissing(a.error) && !missing) {
      missing = true;
      ctx.actions.render?.();
    }
    return;
  }
  const next = { total: a.count ?? 0, fresh: b.error ? 0 : (b.count ?? 0) };
  if (next.total !== peekInfo.total || next.fresh !== peekInfo.fresh) {
    peekInfo = next;
    ctx.actions.render?.();
  }
}

export const available = () => !missing;
export const badge = () => {
  if (missing || peekInfo.total == null) return "";
  if (peekInfo.fresh > 0) return `${plural(peekInfo.fresh, "dibujo nuevo", "dibujos nuevos")}`;
  return peekInfo.total ? plural(peekInfo.total, "dibujo", "dibujos") : "¡Dibuja el primero!";
};

// ---------- qué se ve ----------

const mineCount = () => rows.filter((r) => r.user_id === me()).length;

function visible() {
  if (filter === "mine") return rows.filter((r) => r.user_id === me());
  if (filter === "best") {
    return rows
      .map((r) => [r, totalOf(r)])
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || ms(b[0].created_at) - ms(a[0].created_at))
      .map(([r]) => r);
  }
  return rows;
}

// ---------- pantalla: el álbum ----------

export const render = () => {
  try {
    return build();
  } catch (err) {
    console.error(err);
    return `<div class="notice">${icon("file", 18)}<p><strong>No se pudo mostrar el álbum de dibujos.</strong> ${esc(err.message || String(err))}</p></div>`;
  }
};

function build() {
  if (!loaded) {
    return loadError
      ? `<div class="gate"><h2>No se pudo cargar el álbum</h2><p>${esc(loadError)}</p><button type="button" class="btn primary" data-action="dibujos-retry">Reintentar</button></div>`
      : `<p class="dib-loading" role="status">Cargando el álbum…</p>`;
  }
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  totalsSeen = bestKey();
  const list = visible();
  return `<section class="dib-top" aria-label="Acciones del álbum">
      <button type="button" class="btn primary big dib-draw" data-action="dibujos-new"><span aria-hidden="true">✏️</span> Dibujar</button>
      ${segmented()}
    </section>
    ${offline ? `<p class="dib-stale" role="status">${icon("file", 16)} Sin conexión: puedes dibujar, pero no guardar ni ver los dibujos nuevos hasta que vuelva internet.</p>` : ""}
    ${loadError ? `<p class="dib-stale" role="status">${icon("file", 16)} No se pudo actualizar: ${esc(loadError)} Se reintentará solo.</p>` : ""}
    ${list.length ? grid(list) : empty()}`;
}

function segmented() {
  const items = [["all", "Todos"], ["mine", "Míos"], ["best", "🏆 Mejores"]];
  return `<div class="dib-seg" role="group" aria-label="Qué dibujos ver">${items
    .map(([id, label]) => `<button type="button" data-action="dibujos-filter" data-filter="${id}" aria-pressed="${filter === id}">${label}</button>`)
    .join("")}</div>`;
}

function empty() {
  const text = {
    all: ["Todavía no hay dibujos", "¡Haz el primero! Toca «Dibujar», elige un tema o dibuja lo que quieras."],
    mine: ["Todavía no has dibujado nada", "Toca «Dibujar» y guarda tu primer dibujo en el álbum."],
    best: ["Aún no hay favoritos", "Toca el ♡ (o un emoji) en los dibujos que más te gusten y los más queridos aparecerán aquí."],
  }[filter];
  return `<div class="gate"><div class="gate-art">${icon("star", 30)}</div><h2>${text[0]}</h2><p>${text[1]}</p></div>`;
}

const avatar = (name) => `<span class="person-dot sm" style="--h:${hueOf(name)}" aria-hidden="true">${esc(String(name).charAt(0).toUpperCase())}</span>`;
const topicOf = (r) => (r.prompt ? esc(r.prompt) : "Dibujo libre");
const MEDALS = ["🥇", "🥈", "🥉"];

function grid(list) {
  const part = list.slice(0, shown);
  const more = list.length - part.length;
  return `<ul class="dib-grid">${part
    .map((r, i) => {
      const own = r.user_id === me();
      const src = urlOf(r.thumb_path);
      const n = filter === "best" ? totalOf(r) : 0;
      return `<li class="dib-card${justSaved === r.id ? " is-new" : ""}">
        <button type="button" class="dib-thumb" data-action="dibujos-open" data-id="${esc(r.id)}" aria-label="${esc(`Abrir el dibujo de ${own ? "ti" : r.name}: ${r.prompt || "dibujo libre"}`)}">
          ${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : `<span class="dib-ph" aria-hidden="true">🎨</span>`}
          ${filter === "best" && i < 3 ? `<span class="dib-medal" aria-hidden="true">${MEDALS[i]}</span>` : ""}
          ${n ? `<span class="dib-count" aria-hidden="true">♡ ${n}</span>` : ""}
        </button>
        <div class="dib-meta">${avatar(r.name)}<span class="dib-who"><strong>${esc(own ? `${r.name} (tú)` : r.name)}</strong><small>${topicOf(r)} · ${esc(ago(ms(r.created_at)))}</small></span></div>
        ${reactionBarHtml("drawing", r.id)}
      </li>`;
    })
    .join("")}</ul>${more > 0 ? `<p class="dib-more"><button type="button" class="btn big" data-action="dibujos-more">Ver ${plural(Math.min(more, PAGE), "dibujo más", "dibujos más")} <small>(quedan ${more})</small></button></p>` : ""}`;
}

// ---------- el visor grande ----------

function ensureViewer() {
  if (viewer) return viewer;
  viewer = document.createElement("dialog");
  viewer.className = "dib-viewer";
  viewer.setAttribute("aria-label", "Dibujo");
  document.body.append(viewer);
  viewer.addEventListener("click", (event) => {
    if (event.target === viewer) {
      // Un clic en el fondo oscuro cierra; uno dentro del recuadro (p. ej. al acabar un deslizamiento, cuando el elemento ya se repintó) no.
      const r = viewer.getBoundingClientRect();
      const outside = event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
      if (outside && !V?.busy) closeViewer();
      return;
    }
    if (handleReactionClick(event)) return;
    const el = event.target.closest("[data-action]");
    if (!el || el.disabled) return;
    actions[el.dataset.action]?.({ ...el.dataset }, el);
  });
  viewer.addEventListener("cancel", (event) => V?.busy && event.preventDefault());
  viewer.addEventListener("close", () => {
    if (!viewer?.open) V = null;
  });
  viewer.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
  });
  // Deslizar de lado a lado para pasar de dibujo (la imagen deja el desplazamiento vertical al navegador).
  let from = null;
  viewer.addEventListener("pointerdown", (event) => {
    from = event.target.closest(".dib-v-stage") && !event.target.closest("button") ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
  });
  viewer.addEventListener("pointerup", (event) => {
    if (!from || from.id !== event.pointerId) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    from = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
  viewer.addEventListener("pointercancel", () => (from = null));
  // Si la imagen grande no carga (enlace caducado), se enseña la miniatura.
  viewer.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("dib-v-img") || img.dataset.fallback) return;
      const r = byId.get(V?.ids[V.index]);
      if (!r) return;
      img.dataset.fallback = "1";
      img.src = urlOf(r.thumb_path) || img.src;
    },
    true,
  );
  return viewer;
}

function openViewer(id) {
  const ids = visible().map((r) => r.id);
  const index = ids.indexOf(id);
  if (index < 0) return;
  V = { ids, index, confirm: false, busy: false, error: "", ai: null };
  ensureViewer();
  paintViewer({ focus: true });
  if (!viewer.open) viewer.showModal();
  viewer.querySelector("[data-autofocus]")?.focus();
  signAround();
}

// Los enlaces del dibujo abierto y de sus vecinos (para que al deslizar ya estén listos).
async function signAround() {
  const d = V;
  if (!d) return;
  const paths = [d.index - 1, d.index, d.index + 1].map((i) => byId.get(d.ids[i])).filter(Boolean).flatMap((r) => [r.path, r.thumb_path]);
  try {
    await sign(paths);
    if (V === d) paintViewer();
  } catch (err) {
    console.warn("Dibujos: no se pudo firmar el dibujo grande:", err.message || err);
  }
}

function closeViewer(silent = false) {
  const id = V?.ids[V.index];
  if (viewer?.open) viewer.close();
  V = null;
  if (silent) return;
  viewer?.replaceChildren();
  if (id) requestAnimationFrame(() => document.querySelector(`.dib-thumb[data-id="${CSS.escape(id)}"]`)?.focus());
}

function step(delta) {
  if (!V || V.busy) return;
  const next = V.index + delta;
  if (next < 0 || next >= V.ids.length) return;
  V.index = next;
  V.confirm = false;
  V.error = "";
  V.ai = null;
  paintViewer({ focus: true });
  signAround();
}

function paintViewer({ focus = false } = {}) {
  if (!viewer || !V) return;
  // Si el dibujo que tocaba ya no existe (lo han borrado), se pasa al siguiente que quede.
  while (V.ids.length && !byId.has(V.ids[V.index])) {
    V.ids.splice(V.index, 1);
    if (V.index >= V.ids.length) V.index = V.ids.length - 1;
  }
  const r = byId.get(V.ids[V.index]);
  if (!r) return closeViewer();
  const own = r.user_id === me();
  const canDelete = own || state.isAdmin;
  const src = urlOf(r.path) || urlOf(r.thumb_path);
  const had = viewer.contains(document.activeElement) ? document.activeElement?.dataset?.action : null;
  const canAsk = typeof ctx.actions?.iaDescribeImage === "function";
  const date = when(r.created_at);
  viewer.innerHTML = `<div class="dib-v-head">
      <span class="dib-v-count" aria-live="polite">${V.index + 1} de ${V.ids.length}</span>
      <button type="button" class="icon-btn" data-action="dibujos-vclose" aria-label="Cerrar"${V.busy ? " disabled" : ""}>${icon("x", 20)}</button>
    </div>
    <div class="dib-v-stage">
      ${src ? `<img class="dib-v-img" src="${esc(src)}" alt="${esc(`Dibujo de ${own ? "ti" : r.name}: ${r.prompt || "dibujo libre"}`)}" draggable="false">` : `<p class="hint dib-v-none">Cargando el dibujo…</p>`}
      <button type="button" class="dib-v-nav is-prev" data-action="dibujos-prev" aria-label="Dibujo anterior"${V.index === 0 ? " disabled" : ""}>${icon("chevronL", 22)}</button>
      <button type="button" class="dib-v-nav is-next" data-action="dibujos-next" aria-label="Dibujo siguiente"${V.index >= V.ids.length - 1 ? " disabled" : ""}>${icon("chevronR", 22)}</button>
    </div>
    <div class="dib-v-info">
      <div class="dib-v-by">${avatar(r.name)}<span class="dib-v-who"><strong class="dib-v-topic">${topicOf(r)}</strong><span>${esc(own ? `${r.name} (tú)` : r.name)}</span><small>${esc(date)}${date ? " · " : ""}${esc(ago(ms(r.created_at)))}</small></span></div>
      ${reactionBarHtml("drawing", r.id)}
      ${V.ai ? `<p class="dib-v-ai${V.ai.error ? " is-error" : ""}" role="status">${V.ai.busy ? "Pensando…" : esc(V.ai.error || V.ai.text)}</p>` : ""}
      ${V.error ? `<p class="dib-error" role="alert">${esc(V.error)}</p>` : ""}
      ${
        V.confirm
          ? `<div class="dib-confirm-bar" role="group" aria-label="Confirmar"><p>¿Borrar este dibujo? Se quita del álbum de todos.</p>
              <div class="dib-v-actions"><button type="button" class="btn big" data-action="dibujos-keep" data-autofocus${V.busy ? " disabled" : ""}>No, dejarlo</button><button type="button" class="btn big danger" data-action="dibujos-del"${V.busy ? " disabled" : ""}>${icon("trash", 18)} Sí, borrar</button></div></div>`
          : `<div class="dib-v-actions">
              ${canAsk ? `<button type="button" class="btn big" data-action="dibujos-ask"${V.ai?.busy ? " disabled" : ""}><span aria-hidden="true">✨</span> ¿Qué es?</button>` : ""}
              ${canDelete ? `<button type="button" class="btn big danger" data-action="dibujos-del"${V.busy ? " disabled" : ""}>${icon("trash", 18)} Borrar${own ? "" : " (administrador)"}</button>` : ""}
              <button type="button" class="btn big primary" data-action="dibujos-vclose" data-autofocus>Cerrar</button></div>`
      }
    </div>`;
  if (!focus && had) (viewer.querySelector(`[data-action="${had}"]:not([disabled])`) ?? viewer.querySelector("[data-autofocus]"))?.focus();
}

// Tras cada carga: si alguno de los dibujos del visor lo han borrado, se pone al día (si no, no se toca: repintar cada 20 s haría parpadear
// la imagen y cortaría un deslizamiento; las reacciones se pintan solas).
function reconcileViewer() {
  if (!V || !viewer?.open || V.busy) return;
  if (V.ids.some((id) => !byId.has(id))) paintViewer();
}

// ---------- guardar un dibujo ----------

const withTimeout = (promise, time, message) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(message), { timeout: true })), time))]);

// Lo llama el lienzo al pulsar «Guardar». Sube el dibujo y su miniatura y guarda la fila. Se puede reintentar sin duplicar:
//  · el id del dibujo lo pone este código y se mantiene mientras el dibujo no cambie (si cambia, es otro dibujo y otro id);
//  · una subida que ya existe (409) o una fila que ya está (clave duplicada) cuentan como hechas;
//  · si el servidor RECHAZA guardar la fila, los archivos se borran; si lo que falló fue la red no se borra nada (no se sabe si la fila
//    llegó) y el reintento lo comprueba antes de volver a subir.
async function saveDrawing({ full, thumb, prompt, version }) {
  const c = sb();
  const uid = me();
  if (!c || !uid) throw new Error("No hay sesión iniciada. Recarga la página y vuelve a entrar.");
  if (attempt && attempt.version !== version) {
    await discardAttempt(attempt); // el dibujo cambió después de un intento fallido: es otro dibujo
    attempt = null;
  }
  attempt ??= { id: crypto.randomUUID(), version, tried: false, saved: false };
  const a = attempt;
  const path = `${uid}/dibujo-${a.id}.jpg`;
  const thumb_path = `${uid}/dibujo-${a.id}_t.jpg`;
  const bucket = c.storage.from("photos");
  try {
    if (a.tried) {
      const { data, error } = await withTimeout(c.from("drawings").select("id").eq("id", a.id).maybeSingle(), 20_000, "La comprobación tarda demasiado. Inténtalo de nuevo.");
      if (!error && data) {
        a.saved = true;
        return;
      }
    }
    a.tried = true;
    for (const [where, blob] of [[path, full], [thumb_path, thumb]]) {
      const { error } = await withTimeout(bucket.upload(where, blob, { contentType: "image/jpeg" }), UPLOAD_MS, "La subida está tardando demasiado. Comprueba tu conexión e inténtalo de nuevo: tu dibujo sigue aquí.");
      if (error && !alreadyExists(error)) throw error;
    }
    const { error } = await withTimeout(c.from("drawings").insert({ id: a.id, name: getName() || "Viajero", prompt: prompt || null, path, thumb_path }), 30_000, "Guardar está tardando demasiado. Comprueba tu conexión e inténtalo de nuevo: tu dibujo sigue aquí.");
    if (error && error.code !== "23505") throw error; // 23505: ya estaba guardado (un intento anterior llegó aunque no lo supimos)
  } catch (err) {
    if (answered(err)) bucket.remove([path, thumb_path]).catch(() => {}); // el servidor dijo que no: no dejar archivos sueltos
    throw new Error(friendly(err));
  }
  a.saved = true;
}

// Si se sale sin guardar tras un intento fallido, se borran los archivos que pudieran haberse subido (salvo que la fila sí exista).
async function discardAttempt(a) {
  if (!a?.tried || a.saved || !sb() || !me()) return;
  try {
    const { data } = await sb().from("drawings").select("id").eq("id", a.id).maybeSingle();
    if (data) return;
    await sb().storage.from("photos").remove([`${me()}/dibujo-${a.id}.jpg`, `${me()}/dibujo-${a.id}_t.jpg`]);
  } catch {
    /* sin conexión: quedan archivos sueltos de unos 100 KB, sin consecuencias */
  }
}

async function newDrawing() {
  if (editorOpen) return;
  if (mineCount() >= MAX_PER_PERSON) {
    toast(`Has llegado al máximo de ${MAX_PER_PERSON} dibujos. Borra alguno del álbum para poder guardar otro.`);
    return;
  }
  editorOpen = true;
  attempt = null;
  try {
    const saved = await openLienzo({ save: saveDrawing });
    if (saved) {
      justSaved = attempt?.id ?? null;
      filter = "all";
      shown = Math.max(shown, PAGE);
      await refresh({ force: true });
      ctx.actions.render?.();
      window.scrollTo({ top: 0 });
      setTimeout(() => (justSaved = null), 2500);
      toast("¡Dibujo guardado en el álbum! Ya lo pueden ver todos.");
    } else await discardAttempt(attempt);
  } catch (err) {
    console.error(err);
    toast(friendly(err));
  } finally {
    editorOpen = false;
    attempt = null;
  }
}

// ---------- borrar ----------

async function removeDrawing() {
  const d = V;
  if (!d || d.busy) return;
  const r = byId.get(d.ids[d.index]);
  if (!r) return;
  if (!d.confirm) {
    d.confirm = true;
    d.error = "";
    paintViewer({ focus: true });
    viewer.querySelector("[data-autofocus]")?.focus();
    return;
  }
  d.busy = true;
  paintViewer();
  try {
    const { data, error } = await sb().from("drawings").delete().eq("id", r.id).select("id");
    if (error) throw error;
    if (!data?.length) throw new Error("No se pudo borrar el dibujo. Puede que ya no exista o que no tengas permiso.");
    // Primero la fila (es la verdad), luego los archivos: solo su dueño puede borrarlos (la política de Storage), un administrador no.
    if (r.user_id === me()) sb().storage.from("photos").remove([r.path, r.thumb_path]).catch(() => {});
    rows = rows.filter((x) => x.id !== r.id);
    byId.delete(r.id);
    d.busy = false;
    d.confirm = false;
    d.ids.splice(d.index, 1);
    if (d.index >= d.ids.length) d.index = d.ids.length - 1;
    dataKey = "";
    ctx.actions.render?.();
    if (!d.ids.length) {
      closeViewer();
      toast("Dibujo borrado.");
    } else {
      paintViewer({ focus: true });
      toast("Dibujo borrado.");
      refresh({ force: true });
    }
  } catch (err) {
    console.error(err);
    d.busy = false;
    d.error = friendly(err);
    if (V === d) paintViewer();
  }
}

// ---------- IA (opcional): «¿Qué es?» ----------

const aiText = (res) => (typeof res === "string" ? res : (res?.text ?? res?.description ?? res?.answer ?? res?.result ?? ""));
async function askAi() {
  const d = V;
  const r = d && byId.get(d.ids[d.index]);
  const ask = ctx.actions?.iaDescribeImage;
  if (!r || typeof ask !== "function" || d.ai?.busy) return;
  d.ai = { busy: true };
  paintViewer();
  try {
    await sign([r.path]);
    const res = await fetch(urlOf(r.path) || urlOf(r.thumb_path));
    if (!res.ok) throw new Error("No se pudo preparar el dibujo.");
    const answer = aiText(await ask(await res.blob()));
    d.ai = answer ? { text: answer } : { error: "No he sabido decir qué es. Prueba con otro dibujo." };
  } catch (err) {
    console.warn("Dibujos (IA):", err?.message || err);
    d.ai = { error: err?.message || "No se pudo preguntar ahora mismo. Inténtalo más tarde." };
  }
  if (V === d) paintViewer();
}

// ---------- acciones ----------

const renderNow = () => ctx.actions.render?.();
const act = (fn) => async (data, el) => {
  try {
    await fn(data, el);
  } catch (err) {
    console.error(err);
    toast(friendly(err));
  }
};

export const actions = {
  "dibujos-new": act(newDrawing),
  "dibujos-retry": act(async () => {
    loadError = "";
    renderNow();
    await refresh();
  }),
  "dibujos-filter": act(async ({ filter: next }) => {
    filter = ["all", "mine", "best"].includes(next) ? next : "all";
    shown = PAGE;
    dataKey = "";
    await sign(thumbsNeeded()).catch(() => {});
    renderNow();
    requestAnimationFrame(() => document.querySelector(".dib-seg [aria-pressed=true]")?.focus());
  }),
  "dibujos-more": act(async () => {
    shown += PAGE;
    dataKey = "";
    await sign(thumbsNeeded()).catch(() => {});
    renderNow();
  }),
  "dibujos-open": act(async ({ id }) => openViewer(id)),
  "dibujos-vclose": () => !V?.busy && closeViewer(),
  "dibujos-prev": () => step(-1),
  "dibujos-next": () => step(1),
  "dibujos-del": act(removeDrawing),
  "dibujos-keep": () => {
    if (!V) return;
    V.confirm = false;
    paintViewer({ focus: true });
    viewer.querySelector("[data-autofocus]")?.focus();
  },
  "dibujos-ask": act(askAi),
};

// Este juego no usa formularios dentro de la página (el lienzo es un diálogo con los suyos).
export const onSubmit = async () => false;
export const onInput = async () => false;
export const onChange = async () => false;

// ---------- resumen para el álbum y el PDF ----------

// Los tres con más reacciones (si hay menos de tres con alguna, se completa con los más recientes).
function summaryPicks() {
  if (!rows.length) return [];
  const reacted = rows
    .map((r) => [r, totalOf(r)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || ms(b[0].created_at) - ms(a[0].created_at))
    .map(([r]) => r);
  const picks = new Map(reacted.slice(0, 3).map((r) => [r.id, r]));
  for (const r of rows) if (picks.size < 3) picks.set(r.id, r);
  return [...picks.values()];
}

// Es síncrono: usa lo último cargado; si hace tiempo que no se actualiza lo pide en segundo plano (y repinta solo si hay algo nuevo),
// así el álbum cuenta los dibujos aunque el juego no se haya abierto en esta sesión.
export function summary() {
  if (sb() && me() && !missing && !inflight && !active && Date.now() - lastLoad > STALE_MS) {
    lastLoad = Date.now();
    refresh();
  }
  if (!loaded || !rows.length) return null;
  const artists = new Map();
  for (const r of rows) {
    const a = artists.get(r.user_id) ?? { name: r.name, n: 0 };
    a.n++;
    artists.set(r.user_id, a);
  }
  const top = [...artists.values()].sort((x, y) => y.n - x.n || x.name.localeCompare(y.name, "es"))[0];
  const picks = summaryPicks();
  const loved = picks.map((r) => [r, totalOf(r)]).filter(([, n]) => n > 0);
  const label = (r) => `«${r.prompt || "Dibujo libre"}» de ${r.name}`;
  const lines = [`${plural(rows.length, "dibujo", "dibujos")} de ${plural(artists.size, "artista", "artistas")}.`, `Quien más dibuja: ${top.name} (${plural(top.n, "dibujo", "dibujos")}).`];
  if (loved.length) lines.push(`Los más queridos: ${loved.map(([r, n]) => `${label(r)} (${plural(n, "reacción", "reacciones")})`).join(" · ")}.`);
  const highlights = [
    { label: "Dibujos", value: String(rows.length) },
    { label: "Artista del viaje", value: `${top.name} (${top.n})` },
  ];
  if (loved[0]) highlights.push({ label: "El más querido", value: `${label(loved[0][0])} (${loved[0][1]})` });
  return { lines, highlights, images: picks.map((r) => urlOf(r.thumb_path)).filter(Boolean) };
}
