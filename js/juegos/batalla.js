// Juego «Batalla de fotos»: un viajero lanza un reto de foto, todos envían UNA foto hecha con el móvil, se vota en secreto la
// mejor (no la propia) y al terminar se muestra el podio. Contrato del módulo en docs/JUEGOS.md; SQL en supabase/juego_batalla.sql.
//
// Lo que no debe poder falsearse (quién vota, que no se vote la propia foto, los estados, los votos ajenos) lo decide la base
// de datos: aquí solo se pintan los datos y se llama a las funciones start_battle, start_voting, close_battle y cast_vote.
// El anonimato de las fotos durante la votación es solo de esta pantalla (el nombre del autor no se muestra hasta el final).
import { state, ctx } from "../state.js";
import { icon } from "../icons.js";
import { esc, toast, safeFormat } from "../util.js";
import { getName } from "../store.js";
import { prepareImage } from "../images.js";
import { pickFiles } from "../media.js";
import { hueOf, people } from "../ledger.js";
import { requireName } from "../dialogs.js";
import { starsHtml } from "../valoraciones.js";
import { iaIdeaButton } from "../ia.js";

export const meta = { id: "batalla", title: "Batalla de fotos", emoji: "📸", blurb: "Un reto de foto, todos participan con la cámara y se vota la mejor." };

const POLL_MS = 10_000; // refresco mientras el juego está abierto y la pestaña visible
const PROMPT_MAX = 120;
const SIGN_SECONDS = 6 * 3600;
const SEEN_KEY = "viaje.batalla.visto"; // último resultado que esta persona ya ha mirado (para el aviso «Resultado listo»)
const FRESH_MS = 3 * 24 * 3600 * 1000; // un resultado se anuncia como «listo» durante 3 días

const THEMES = [
  "La sonrisa más rara",
  "Lo más azul que encuentres",
  "Una selfie con alguien que no conoces",
  "El plato más raro del viaje",
  "Una foto que parezca una postal",
  "Tu pie en el sitio más bonito",
  "Algo que empiece por la letra M",
  "El mejor reflejo",
  "Un animal que se parezca a alguien del grupo",
  "Foto de grupo con cara de susto",
  "La sombra más graciosa",
  "El cartel más absurdo que veas",
  "Algo redondo y de color amarillo",
  "Una pose de estatua",
  "El rincón más tranquilo",
  "Tu mejor salto en el aire",
  "La cola más larga",
  "El desayuno de campeones",
];
const CHIPS = 6; // sugerencias visibles a la vez

// ---------- estado del módulo (la web repinta todo: aquí vive lo que hay que recordar) ----------

const S = {
  loaded: false,
  loading: false,
  again: false,
  missing: false, // faltan las tablas o funciones (no se ha ejecutado juego_batalla.sql)
  offline: false, // el último refresco falló
  battles: [], // más recientes primero
  active: null, // la batalla sin terminar, si hay
  entries: [], // fotos de la batalla activa
  myVote: null, // id de la foto que he votado en la batalla activa
  myRatings: new Map(), // id de foto -> mis estrellas (1-5) en la batalla activa
  ratingsMissing: false, // faltan las notas con estrellas (no se ha ejecutado valoraciones.sql): todo lo demás sigue igual
  progress: null, // { participants, voted } de la batalla en votación
  leaderboard: [],
  results: new Map(), // id de batalla terminada -> { rows, votes }
  viewId: null, // resultado que se está mirando
  prevActiveId: null,
  draft: "", // texto del campo «tema»
  chips: [],
  preview: null, // { full, thumb, url } foto elegida que aún no se ha enviado
  changing: false, // quiero cambiar la foto que ya envié
  busy: new Set(), // acciones en curso (evitan el doble toque)
  urls: new Map(), // ruta -> { url, expires } enlaces firmados reutilizados mientras valgan
  zoom: null, // { mode: "voting" | "done", battleId, id }
  sig: "",
  peeked: null,
  channel: null,
  timer: null,
  sum: null, // { at, data } resumen para el álbum
  sumLoading: false,
};

const sb = () => ctx.store?.sb;
const me = () => ctx.store?.user?.id;
const inGame = () => state.view === "games" && state.game === meta.id;
const inHub = () => state.view === "games" && !state.game;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const shortDate = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
const when = (iso) => safeFormat(shortDate, iso);
const dot = (name, cls = "") => `<span class="person-dot ${cls}" style="--h:${hueOf(name || "?")}" aria-hidden="true">${esc(String(name || "?").trim().charAt(0).toUpperCase())}</span>`;
const myName = () => String(getName() || "").trim().slice(0, 40);

const isMissing = (err) =>
  ["42P01", "PGRST205", "PGRST202", "42883"].includes(err?.code) || /schema cache|does not exist|could not find the (table|function)/i.test(err?.message || "");

// Mensajes de error en español claro (los de la base de datos ya lo son; aquí se traducen los de red y de almacenamiento).
function nice(err) {
  const m = String(err?.message || err || "");
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(m)) return "No hay conexión ahora mismo. Inténtalo de nuevo en un momento.";
  if (/maximum allowed size|payload too large|too large/i.test(m)) return "La foto es demasiado grande. Prueba con otra.";
  if (/row-level security|permission denied/i.test(m)) return "Ahora no puedes hacer eso: puede que el reto haya cambiado de fase.";
  return m || "Algo ha fallado. Inténtalo de nuevo.";
}
const fail = (err) => {
  console.warn("Batalla de fotos:", err?.message || err);
  toast(nice(err));
};

const repaint = () => {
  if (inGame() || inHub()) ctx.actions.render();
  refreshZoom();
};

const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const newChips = (avoid = []) => (S.chips = shuffle(THEMES.filter((t) => !avoid.includes(t))).slice(0, CHIPS));

// Orden fijo pero sin relación con quién envió primero (así el orden no delata al autor): mezcla por una huella del id.
const hash = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
};
const anonymous = (entries, seed) => [...entries].sort((a, b) => hash(seed + a.id) - hash(seed + b.id));

const seenId = () => {
  try {
    return localStorage.getItem(SEEN_KEY) || "";
  } catch {
    return "";
  }
};
const markSeen = (id) => {
  try {
    localStorage.setItem(SEEN_KEY, id);
  } catch {
    /* sin almacenamiento: el aviso se repetirá */
  }
};

// ---------- fotos firmadas ----------

// El almacén es privado: se piden enlaces temporales y se reutilizan mientras valgan para no volver a descargar las fotos.
async function sign(paths) {
  const now = Date.now();
  const missing = [...new Set(paths.filter((p) => p && !(S.urls.get(p)?.expires > now)))];
  if (!missing.length) return;
  try {
    const { data, error } = await sb().storage.from("photos").createSignedUrls(missing, SIGN_SECONDS);
    if (error) throw error;
    const expires = now + (SIGN_SECONDS - 3600) * 1000;
    for (const { path, signedUrl } of data ?? []) if (signedUrl) S.urls.set(path, { url: signedUrl, expires });
  } catch (err) {
    console.warn("Batalla de fotos: no se pudieron firmar las fotos:", err?.message || err);
  }
}
const urlOf = (path) => S.urls.get(path)?.url ?? "";

// ---------- carga de datos ----------

const myEntry = () => S.entries.find((e) => e.user_id === me()) ?? null;
const canManage = (b) => Boolean(b) && (b.created_by === me() || state.isAdmin === true);
const creatorName = (b) => b?.created_by_name || "un viajero";

async function load() {
  if (!sb()) return;
  if (S.loading) {
    S.again = true;
    return;
  }
  S.loading = true;
  try {
    const { data: battles, error } = await sb().from("battles").select("*").order("created_at", { ascending: false }).limit(40);
    if (error) throw error;
    const active = battles.find((b) => b.status !== "done") ?? null;
    // Si la batalla que se estaba jugando acaba de terminar, todos pasan a ver el resultado.
    const finished = S.prevActiveId && !active ? battles.find((b) => b.id === S.prevActiveId && b.status === "done") : null;
    let entries = [];
    let myVote = null;
    let myRatings = new Map();
    let progress = null;
    let leaderboard = S.leaderboard;
    if (active) {
      const [e, v, p] = await Promise.all([
        sb().from("battle_entries").select("*").eq("battle_id", active.id).order("created_at"),
        sb().from("battle_votes").select("entry_id").eq("battle_id", active.id).eq("voter_id", me()),
        active.status === "voting" ? sb().rpc("battle_progress", { p_battle: active.id }) : Promise.resolve({ data: null }),
      ]);
      if (e.error) throw e.error;
      if (v.error) throw v.error;
      entries = e.data;
      myVote = v.data?.[0]?.entry_id ?? null;
      if (active.status === "voting") {
        // Mis notas con estrellas (las de los demás son secretas hasta el final). Si faltan las tablas, se sigue sin ellas.
        const r = await sb().from("battle_ratings").select("entry_id,stars").eq("battle_id", active.id).eq("user_id", me());
        S.ratingsMissing = Boolean(r.error);
        if (!r.error) myRatings = new Map((r.data ?? []).map((x) => [x.entry_id, Number(x.stars)]));
      }
      const row = Array.isArray(p.data) ? p.data[0] : p.data;
      progress = row ? { participants: Number(row.participants), voted: Number(row.voted) } : null;
    } else {
      const l = await sb().rpc("battle_leaderboard");
      if (l.error) throw l.error;
      leaderboard = l.data ?? [];
    }
    S.missing = false;
    S.offline = false;
    S.battles = battles;
    S.active = active;
    S.entries = entries;
    S.myVote = myVote;
    S.myRatings = myRatings;
    S.progress = progress;
    S.leaderboard = leaderboard;
    S.prevActiveId = active?.id ?? null;
    if (finished && !S.viewId) {
      S.viewId = finished.id;
      markSeen(finished.id); // ya lo está viendo: no hace falta avisarle luego de «Resultado listo»
    }
    if (S.viewId && !battles.some((b) => b.id === S.viewId)) S.viewId = null;
    if (S.viewId) await loadResult(S.viewId, { silent: true });
    await sign([...entries.map((e) => e.thumb_path), ...(S.viewId ? resultPaths(S.viewId) : [])]);
    const sig = JSON.stringify([battles.map((b) => [b.id, b.status]), entries.map((e) => e.id), myVote, [...myRatings], progress, leaderboard, S.viewId, S.results.size]);
    if (!S.loaded || sig !== S.sig) {
      S.sig = sig;
      S.loaded = true;
      repaint();
    }
  } catch (err) {
    if (isMissing(err)) {
      S.missing = true;
      S.loaded = true;
    } else {
      S.offline = true;
      console.warn("Batalla de fotos:", err?.message || err);
    }
    repaint();
  } finally {
    S.loading = false;
    if (S.again) {
      S.again = false;
      load();
    }
  }
}

const resultPaths = (id) => {
  const r = S.results.get(id);
  return r ? r.rows.flatMap((x) => (x.rank === 1 ? [x.thumb_path, x.path] : [x.thumb_path])) : [];
};

// Resultado de una batalla terminada: puestos (battle_results) y quién votó qué (visible para todos solo al terminar).
async function loadResult(id, { silent = false } = {}) {
  if (S.results.has(id)) return;
  try {
    // battle_final trae además la nota media y desempata por estrellas; sin valoraciones.sql se usa battle_results (solo votos).
    let r = await sb().rpc("battle_final", { p_battle: id });
    if (r.error) r = await sb().rpc("battle_results", { p_battle: id });
    const v = await sb().from("battle_votes").select("voter_id,entry_id").eq("battle_id", id);
    if (r.error) throw r.error;
    if (v.error) throw v.error;
    const rows = r.data.map((x) => ({ ...x, votes: Number(x.votes), rank: Number(x.rank), avg: x.avg_stars == null ? null : Number(x.avg_stars), nratings: Number(x.ratings ?? 0) }));
    S.results.set(id, { rows, votes: v.data ?? [] });
    await sign(resultPaths(id));
  } catch (err) {
    if (!silent) fail(err);
    else console.warn("Batalla de fotos:", err?.message || err);
  }
  if (!silent) repaint();
}

// Consulta ligera para la lista de juegos (etiqueta «Reto abierto», «¡A votar!»…).
export async function peek() {
  if (!sb() || S.missing) return;
  try {
    const { data, error } = await sb().from("battles").select("id,status,closed_at").order("created_at", { ascending: false }).limit(1);
    if (error) throw error;
    const b = data[0] ?? null;
    let canVote = false;
    if (b?.status === "voting") {
      const [e, v] = await Promise.all([
        sb().from("battle_entries").select("id").eq("battle_id", b.id).eq("user_id", me()),
        sb().from("battle_votes").select("battle_id").eq("battle_id", b.id).eq("voter_id", me()),
      ]);
      canVote = Boolean(e.data?.length) && !v.data?.length;
    }
    const next = b ? { status: b.status, closedAt: b.closed_at, id: b.id, canVote } : null;
    const changed = JSON.stringify(next) !== JSON.stringify(S.peeked);
    S.peeked = next;
    if (changed && inHub()) ctx.actions.render();
  } catch (err) {
    if (isMissing(err)) S.missing = true;
    else console.warn("Batalla de fotos:", err?.message || err);
  }
}

export const available = () => !S.missing;

export const badge = () => {
  const p = S.peeked;
  if (!p || S.missing) return "";
  if (p.status === "open") return "Reto abierto";
  if (p.status === "voting") return p.canVote ? "¡A votar!" : "";
  if (p.status === "done" && p.id !== seenId() && Date.now() - Date.parse(p.closedAt) < FRESH_MS) return "Resultado listo";
  return "";
};

// ---------- ciclo de vida ----------

const nudge = (() => {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(load, 300);
  };
})();
const tick = () => {
  if (!document.hidden) load();
};

export function enter() {
  S.viewId = null;
  S.prevActiveId = null;
  S.changing = false;
  if (!S.chips.length) newChips();
  load();
  clearInterval(S.timer);
  S.timer = setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", tick);
  if (!S.channel && sb()) {
    // Tiempo real opcional: las batallas y sus fotos avisan al instante (los votos no se publican a propósito).
    try {
      S.channel = sb()
        .channel("viaje-batalla")
        .on("postgres_changes", { event: "*", schema: "public", table: "battles" }, nudge)
        .on("postgres_changes", { event: "*", schema: "public", table: "battle_entries" }, nudge)
        .subscribe();
    } catch (err) {
      console.warn("Batalla de fotos: sin tiempo real:", err?.message || err);
    }
  }
}

export function leave() {
  clearInterval(S.timer);
  S.timer = null;
  document.removeEventListener("visibilitychange", tick);
  if (S.channel) {
    try {
      sb()?.removeChannel(S.channel);
    } catch {
      /* ya estaba cerrado */
    }
    S.channel = null;
  }
  S.zoom = null;
  const d = document.getElementById("batalla-zoom");
  if (d?.open) d.close();
  peek();
}

// ---------- pantalla ----------

export function render() {
  if (!S.loaded) return `<p class="hint bt-loading" role="status">Cargando el reto…</p>`;
  const warn = S.offline ? `<p class="notice bt-offline" role="status">${icon("file", 18)}<span>No se pudo actualizar. Se reintentará solo.</span></p>` : "";
  const b = S.active;
  if (S.viewId) return warn + renderResult(S.viewId);
  if (!b) return warn + renderIdle();
  return warn + (b.status === "open" ? renderOpen(b) : renderVoting(b));
}

const steps = (current) =>
  `<ol class="bt-steps" aria-label="Fases del reto">${[
    ["open", "Fotos"],
    ["voting", "Votos"],
    ["done", "Resultado"],
  ]
    .map(([k, label], i) => `<li ${k === current ? 'aria-current="step" class="is-on"' : ""}><b aria-hidden="true">${i + 1}</b> ${label}</li>`)
    .join("")}</ol>`;

const hero = (b, phase) =>
  `<section class="bt-hero" aria-labelledby="bt-theme">${steps(phase)}<p class="bt-eyebrow">Reto de ${esc(creatorName(b))}</p><h3 class="bt-theme" id="bt-theme">${esc(b.prompt)}</h3></section>`;

// ----- sin batalla activa -----

function renderIdle() {
  const done = S.battles.filter((b) => b.status === "done");
  const last = done[0];
  const fresh = last && last.id !== seenId() && Date.now() - Date.parse(last.closed_at) < FRESH_MS;
  const launching = S.busy.has("launch");
  const chips = (S.chips.length ? S.chips : newChips())
    .map((t) => `<button type="button" class="chip is-link bt-chip" data-action="batalla-tema" data-i="${THEMES.indexOf(t)}">${esc(t)}</button>`)
    .join("");
  return `<form class="bt-launch" data-batalla-form="launch" autocomplete="off">
      <span class="bt-big-emoji" aria-hidden="true">📸</span>
      <h3>Lanza un reto de foto</h3>
      <p class="hint">Todos haréis una foto con el móvil y luego votaréis la mejor, en secreto.</p>
      <label>Tema del reto
        <input name="prompt" maxlength="${PROMPT_MAX}" required data-keep="batalla-tema" placeholder="Ej.: La sonrisa más rara" value="${esc(S.draft)}" enterkeyhint="send">
      </label>
      <div class="bt-chips" role="group" aria-label="Ideas de temas">${chips}</div>
      <p class="ia-line" data-ia-line data-ia-only>${iaIdeaButton("battle-idea", "Idea con IA")}</p>
      <div class="bt-actions">
        <button type="button" class="btn bt-big" data-action="batalla-otra">${icon("sparkle", 18)} Otra idea</button>
        <button type="submit" class="btn primary bt-big" ${launching ? "disabled" : ""}>${launching ? "Lanzando…" : "Lanzar reto"}</button>
      </div>
    </form>
    ${
      fresh
        ? `<section class="bt-fresh"><p><strong>Resultado listo</strong><span>«${esc(last.prompt)}»</span></p><button type="button" class="btn primary" data-action="batalla-ver" data-id="${esc(last.id)}">Ver resultado</button></section>`
        : ""
    }
    ${renderBoard()}
    ${renderPast(done)}`;
}

function renderBoard() {
  const rows = S.leaderboard;
  if (!rows.length) return `<section class="bt-section"><h3>Clasificación del viaje</h3><p class="hint">Aún no hay ninguna batalla terminada. ¡Lanza la primera!</p></section>`;
  return `<section class="bt-section"><h3>Clasificación del viaje</h3>
    <ol class="bt-board">${rows
      .slice(0, 10)
      .map(
        (r, i) => `<li class="${r.user_id === me() ? "is-me" : ""}">
          <span class="bt-pos" aria-label="Puesto ${i + 1}">${i + 1}</span>${dot(r.name, "lg")}
          <span class="bt-who-text"><strong>${esc(r.name || "Viajero")}${r.user_id === me() ? ` <small class="you">tú</small>` : ""}</strong>
          <small>${esc(plural(Number(r.wins), "victoria", "victorias"))} · ${esc(plural(Number(r.votes), "voto", "votos"))} · ${esc(plural(Number(r.battles), "batalla", "batallas"))}</small></span>
        </li>`,
      )
      .join("")}</ol></section>`;
}

function renderPast(done) {
  if (!done.length) return "";
  return `<section class="bt-section"><h3>Batallas anteriores</h3>
    <ul class="bt-past">${done
      .map(
        (b) => `<li><button type="button" class="bt-past-btn" data-action="batalla-ver" data-id="${esc(b.id)}">
          <span class="bt-past-text"><strong>${esc(b.prompt)}</strong><small>${esc(b.created_by_name ? `Lanzado por ${b.created_by_name} · ` : "")}${esc(when(b.closed_at || b.created_at))}</small></span>
          <span class="bt-past-go"><span>Ver resultado</span> ${icon("chevronR", 16)}</span></button></li>`,
      )
      .join("")}</ul></section>`;
}

// ----- open: se envían fotos -----

const pendingNames = () => {
  const sent = new Set(S.entries.map((e) => String(e.name || "").trim().toLowerCase()));
  return people().filter((n) => !sent.has(n.toLowerCase())).slice(0, 8);
};

function renderOpen(b) {
  const mine = myEntry();
  const sending = S.busy.has("send");
  const prep = S.busy.has("prep");
  let photo;
  if (S.preview) {
    photo = `<img class="bt-preview" src="${esc(S.preview.url)}" alt="Vista previa de tu foto">
      <p class="hint">Así se verá tu foto. ¿La envías?</p>
      <div class="bt-actions">
        <button type="button" class="btn primary bt-big" data-action="batalla-enviar" ${sending ? "disabled" : ""}>${sending ? "Enviando…" : "Enviar mi foto"}</button>
        <button type="button" class="btn bt-big" data-action="batalla-descartar" ${sending ? "disabled" : ""}>Cambiar</button>
      </div>`;
  } else if (mine && !S.changing) {
    photo = `<img class="bt-preview" src="${esc(urlOf(mine.thumb_path))}" alt="Tu foto ya enviada" loading="lazy" decoding="async">
      <p class="bt-sent">${icon("check", 18)} <span>Tu foto está enviada. Puedes cambiarla hasta que empiece la votación.</span></p>
      <button type="button" class="btn bt-big" data-action="batalla-cambiar">Cambiar mi foto</button>`;
  } else {
    photo = `<p class="hint">${mine ? "Elige la foto nueva." : "Haz una foto que encaje con el reto."}</p>
      <div class="bt-actions">
        <button type="button" class="btn primary bt-big" data-action="batalla-foto" data-mode="camera" ${prep ? "disabled" : ""}>${icon("camera", 20)} ${prep ? "Preparando…" : "Hacer foto"}</button>
        <button type="button" class="btn bt-big" data-action="batalla-foto" data-mode="gallery" ${prep ? "disabled" : ""}>${icon("images", 20)} Elegir de la galería</button>
      </div>
      ${mine ? `<button type="button" class="link-btn" data-action="batalla-descartar">Dejar la que ya envié</button>` : ""}`;
  }
  const sent = S.entries
    .map((e) => `<li class="bt-who">${dot(e.name)}<span>${esc(e.name || "Viajero")}</span>${icon("check", 14)}</li>`)
    .join("");
  const missing = pendingNames();
  const manage = canManage(b)
    ? `<section class="bt-manage"><p class="hint">Cuando hayan enviado su foto todos, abre la votación. Después ya no se podrán cambiar las fotos.</p>
        <button type="button" class="btn primary bt-big" data-action="batalla-votar-ya" ${S.busy.has("start") ? "disabled" : ""}>${S.busy.has("start") ? "Abriendo…" : "Empezar la votación"}</button></section>`
    : `<p class="hint bt-wait">Cuando estéis todos, ${esc(creatorName(b))} abrirá la votación.</p>`;
  return `${hero(b, "open")}
    <section class="bt-card-box" aria-label="Tu foto"><h3>Tu foto</h3>${photo}</section>
    <section class="bt-card-box" aria-label="Quién ha enviado ya su foto"><h3>${esc(plural(S.entries.length, "foto enviada", "fotos enviadas"))}</h3>
      ${sent ? `<ul class="bt-whos">${sent}</ul>` : `<p class="hint">Todavía no hay ninguna. Las fotos de los demás se verán durante la votación.</p>`}
      ${missing.length ? `<p class="bt-missing"><small>Aún sin foto:</small> ${esc(missing.join(", "))}</p>` : ""}
    </section>
    ${manage}`;
}

// ----- voting: se vota -----

function renderVoting(b) {
  const mine = myEntry();
  const ordered = anonymous(S.entries, b.id);
  const manage = canManage(b);
  const p = S.progress;
  const all = p && p.participants > 0 && p.voted >= p.participants;
  const cards = ordered
    .map((e, i) => {
      const isMine = e.user_id === me();
      const voted = S.myVote === e.id;
      const voting = S.busy.has("vote");
      const label = `Foto ${i + 1}`;
      const foot = isMine
        ? `<span class="bt-nope">No puedes votar tu foto</span>`
        : voted
          ? `<button type="button" class="btn primary bt-vote is-voted" aria-pressed="true" disabled>${icon("check", 18)} Tu voto</button>`
          : !mine
            ? `<span class="bt-nope">Solo puedes mirar</span>`
            : `<button type="button" class="btn primary bt-vote" data-action="batalla-vote" data-id="${esc(e.id)}" aria-label="Votar la ${label.toLowerCase()}" ${voting ? "disabled" : ""}>Votar</button>`;
      return `<li class="bt-card ${isMine ? "is-mine" : ""} ${voted ? "is-voted" : ""}">
        <button type="button" class="bt-photo" data-action="batalla-zoom" data-id="${esc(e.id)}" aria-label="Ampliar la ${label.toLowerCase()}${isMine ? " (es la tuya)" : ""}">
          ${urlOf(e.thumb_path) ? `<img src="${esc(urlOf(e.thumb_path))}" alt="${label}" loading="lazy" decoding="async">` : `<span class="bt-ph" aria-hidden="true">${icon("images", 28)}</span>`}
          <span class="bt-num">${i + 1}</span>
          ${isMine ? `<span class="bt-tag">Tu foto</span>` : voted ? `<span class="bt-tag is-ok">${icon("check", 14)} Tu voto</span>` : ""}
        </button>
        <div class="bt-card-foot">${foot}${!isMine && S.myRatings.get(e.id) ? `<p class="bt-mynote">Tu nota ${starsHtml(S.myRatings.get(e.id), "", "estrellas")}</p>` : ""}</div>
      </li>`;
    })
    .join("");
  const status = p ? `<p class="bt-count" role="status">Han votado <strong>${p.voted}</strong> de <strong>${p.participants}</strong></p>` : "";
  const closing = manage
    ? `<section class="bt-manage ${all ? "is-ready" : ""}">${all ? `<p class="bt-ready">${icon("check", 18)} <strong>¡Han votado todos!</strong></p>` : `<p class="hint">Puedes cerrar cuando quieras; lo ideal es esperar a que voten todos.</p>`}
        <button type="button" class="btn primary bt-big" data-action="batalla-cerrar" ${S.busy.has("close") ? "disabled" : ""}>${S.busy.has("close") ? "Cerrando…" : "Cerrar y ver resultado"}</button></section>`
    : `<p class="hint bt-wait">${all ? "Han votado todos. " : ""}${esc(creatorName(b))} cerrará la votación y se verá el resultado.</p>`;
  return `${hero(b, "voting")}
    ${!mine ? `<p class="notice bt-view-only" role="note">${icon("file", 18)}<span>No enviaste foto a este reto, así que esta vez solo puedes mirar.</span></p>` : ""}
    <p class="hint bt-hint">Las fotos son anónimas. Toca una para verla grande. Solo cuenta un voto: si cambias de idea, vota otra.${mine && !S.ratingsMissing ? " Además puedes puntuar cada foto con estrellas (al ampliarla): son secretas hasta el final y desempatan si dos fotos empatan a votos." : ""}</p>
    ${status}
    ${cards ? `<ul class="bt-grid">${cards}</ul>` : `<p class="hint bt-wait">Nadie ha enviado foto, así que no hay nada que votar.</p>`}
    ${closing}`;
}

// ----- done: resultado -----

const medal = (rank) => ({ 1: "🥇", 2: "🥈", 3: "🥉" })[rank] ?? "";
const ordinal = (rank) => `${rank}º`;

function renderResult(id) {
  const b = S.battles.find((x) => x.id === id);
  const r = S.results.get(id);
  const back = `<button type="button" class="btn small bt-back" data-action="batalla-volver">${icon("chevronL", 16)} ${S.active ? "Volver al reto" : "Todas las batallas"}</button>`;
  if (!b) return `<p class="hint">Esa batalla ya no existe.</p>${back}`;
  const head = `<section class="bt-hero is-done" aria-labelledby="bt-theme">${steps("done")}<p class="bt-eyebrow">Reto de ${esc(creatorName(b))} · ${esc(when(b.closed_at || b.created_at))}</p><h3 class="bt-theme" id="bt-theme">${esc(b.prompt)}</h3></section>`;
  if (!r) return `${back}${head}<p class="hint bt-loading" role="status">Cargando el resultado…</p><button type="button" class="btn bt-big" data-action="batalla-ver" data-id="${esc(id)}">Reintentar</button>`;
  const rows = r.rows;
  const top = rows.filter((x) => x.rank === 1 && x.votes > 0);
  const star1 = (x) => (x.avg == null ? "" : ` · ★ ${x.avg.toFixed(1).replace(".", ",")}`); // nota media, si alguien la puntuó
  const maxVotes = Math.max(0, ...rows.map((x) => x.votes));
  const brokeTie = top.length === 1 && rows.filter((x) => x.votes === maxVotes).length > 1; // empataron a votos y desempató la nota
  const banner = top.length
    ? `<p class="bt-winner"><span aria-hidden="true">🏆</span> <span>${top.length === 1 ? `Ganó <strong>${esc(top[0].name)}</strong>` : `Empate: <strong>${esc(top.map((x) => x.name).join(" y "))}</strong>`} con ${esc(plural(top[0].votes, "voto", "votos"))}${brokeTie ? ` (empate a votos: ganó por la nota media${esc(star1(top[0]))})` : ""}</span></p>`
    : `<p class="bt-winner"><span aria-hidden="true">🤷</span> <span>Nadie recibió votos esta vez.</span></p>`;
  const podium = rows.filter((x) => x.rank <= 3 && x.votes > 0); // sin votos no hay medalla
  const card = (x, big) => {
    const src = big ? urlOf(x.path) || urlOf(x.thumb_path) : urlOf(x.thumb_path);
    return `<li class="bt-pod ${x.rank === 1 ? "is-first" : ""}">
      <button type="button" class="bt-photo" data-action="batalla-zoom" data-id="${esc(x.entry_id)}" aria-label="Ampliar la foto de ${esc(x.name)}">
        ${src ? `<img src="${esc(src)}" alt="Foto de ${esc(x.name)}" loading="lazy" decoding="async">` : `<span class="bt-ph" aria-hidden="true">${icon("images", 28)}</span>`}
      </button>
      <p class="bt-pod-info"><span class="bt-medal" aria-label="${ordinal(x.rank)} puesto">${medal(x.rank)} ${ordinal(x.rank)}</span><strong>${esc(x.name)}</strong><small>${esc(plural(x.votes, "voto", "votos"))}${esc(star1(x))}</small></p>
    </li>`;
  };
  const nameOf = new Map(rows.map((x) => [x.user_id, x.name]));
  const entryOwner = new Map(rows.map((x) => [x.entry_id, x.name]));
  const votes = [...r.votes]
    .map((v) => ({ from: nameOf.get(v.voter_id) || "Viajero", to: entryOwner.get(v.entry_id) || "Viajero" }))
    .sort((a, b2) => a.from.localeCompare(b2.from, "es"));
  const next = S.active
    ? `<button type="button" class="btn primary bt-big" data-action="batalla-volver">Ir al reto en marcha ${icon("arrowRight", 18)}</button>`
    : `<button type="button" class="btn primary bt-big" data-action="batalla-nueva">Lanzar otra batalla</button>`;
  return `${back}${head}${banner}
    ${podium.length ? `<section class="bt-section"><h3>Podio</h3><ol class="bt-podium">${podium.map((x) => card(x, x.rank === 1)).join("")}</ol></section>` : ""}
    <section class="bt-section"><h3>Todas las fotos</h3>
      <ul class="bt-all">${rows
        .map(
          (x) => `<li><button type="button" class="bt-photo" data-action="batalla-zoom" data-id="${esc(x.entry_id)}" aria-label="Ampliar la foto de ${esc(x.name)}, ${esc(plural(x.votes, "voto", "votos"))}">
            ${urlOf(x.thumb_path) ? `<img src="${esc(urlOf(x.thumb_path))}" alt="Foto de ${esc(x.name)}" loading="lazy" decoding="async">` : `<span class="bt-ph" aria-hidden="true">${icon("images", 24)}</span>`}
          </button><p class="bt-all-info"><strong>${esc(x.name)}</strong><small>${esc(plural(x.votes, "voto", "votos"))}${esc(star1(x))}${x.nratings ? esc(` (${x.nratings})`) : ""}</small></p></li>`,
        )
        .join("")}</ul></section>
    <section class="bt-section"><h3>Quién votó a quién</h3>
      ${votes.length ? `<ul class="bt-votes">${votes.map((v) => `<li>${dot(v.from)}<span><strong>${esc(v.from)}</strong> ${icon("arrowRight", 14)} <strong>${esc(v.to)}</strong></span></li>`).join("")}</ul>` : `<p class="hint">Nadie votó.</p>`}
    </section>
    <div class="bt-end">${next}</div>`;
}

// ---------- foto ampliada (diálogo propio, fuera de la página para que sobreviva a los repintados) ----------

function zoomItems() {
  const z = S.zoom;
  if (!z) return [];
  if (z.mode === "voting") {
    if (!S.active || S.active.id !== z.battleId || S.active.status !== "voting") return [];
    return anonymous(S.entries, z.battleId).map((e, i) => ({ id: e.id, path: e.path, thumb: e.thumb_path, caption: `Foto ${i + 1} de ${S.entries.length}`, mine: e.user_id === me() }));
  }
  const r = S.results.get(z.battleId);
  return (r?.rows ?? []).map((x) => ({ id: x.entry_id, path: x.path, thumb: x.thumb_path, caption: `${x.name} · ${plural(x.votes, "voto", "votos")}${x.rank <= 3 ? ` · ${medal(x.rank)} ${ordinal(x.rank)}` : ""}` }));
}

function zoomDialog() {
  let d = document.getElementById("batalla-zoom");
  if (d) return d;
  d = document.createElement("dialog");
  d.id = "batalla-zoom";
  d.className = "bt-zoom";
  d.setAttribute("aria-label", "Foto ampliada");
  d.addEventListener("click", (event) => {
    if (event.target === d) return d.close();
    const el = event.target.closest("[data-z]");
    if (!el) return;
    const k = el.dataset.z;
    if (k === "close") d.close();
    else if (k === "prev" || k === "next") stepZoom(k === "next" ? 1 : -1);
    else if (k === "vote") vote(el.dataset.id);
    else if (k === "rate") rate(el.dataset.id, el.dataset.stars);
  });
  d.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") stepZoom(-1);
    if (event.key === "ArrowRight") stepZoom(1);
  });
  d.addEventListener("close", () => {
    S.zoom = null;
  });
  document.body.append(d);
  return d;
}

function stepZoom(delta) {
  const items = zoomItems();
  const i = items.findIndex((x) => x.id === S.zoom?.id);
  if (i < 0 || !items.length) return;
  S.zoom.id = items[(i + delta + items.length) % items.length].id;
  refreshZoom();
  const it = items.find((x) => x.id === S.zoom.id);
  if (it && !urlOf(it.path)) sign([it.path]).then(refreshZoom);
}

function refreshZoom() {
  const d = document.getElementById("batalla-zoom");
  if (!d || !S.zoom) return;
  const items = zoomItems();
  const it = items.find((x) => x.id === S.zoom.id);
  if (!it) {
    if (d.open) d.close();
    return;
  }
  const i = items.indexOf(it);
  const src = urlOf(it.path) || urlOf(it.thumb);
  const voted = S.myVote === it.id;
  const canVote = S.zoom.mode === "voting" && !it.mine && Boolean(myEntry());
  d.innerHTML = `<button type="button" class="icon-btn bt-zoom-close" data-z="close" aria-label="Cerrar">${icon("x", 20)}</button>
    <div class="bt-zoom-stage">${src ? `<img src="${esc(src)}" alt="${esc(it.caption)}">` : `<span class="bt-ph" aria-hidden="true">${icon("images", 40)}</span>`}</div>
    <div class="bt-zoom-info">
      <p class="bt-zoom-cap">${esc(it.caption)}${it.mine ? ` · <b>Tu foto</b>` : ""}</p>
      <div class="bt-zoom-nav">
        <button type="button" class="icon-btn" data-z="prev" aria-label="Foto anterior" ${items.length < 2 ? "disabled" : ""}>${icon("chevronL", 22)}</button>
        ${
          S.zoom.mode === "voting"
            ? canVote
              ? voted
                ? `<button type="button" class="btn primary bt-vote is-voted" aria-pressed="true" disabled>${icon("check", 18)} Tu voto</button>`
                : `<button type="button" class="btn primary bt-vote" data-z="vote" data-id="${esc(it.id)}" ${S.busy.has("vote") ? "disabled" : ""}>Votar esta foto</button>`
              : `<span class="bt-nope">${it.mine ? "Es tu foto: no se puede votar" : "Solo votan quienes enviaron foto"}</span>`
            : `<span class="bt-zoom-n">${i + 1} de ${items.length}</span>`
        }
        <button type="button" class="icon-btn" data-z="next" aria-label="Foto siguiente" ${items.length < 2 ? "disabled" : ""}>${icon("chevronR", 22)}</button>
      </div>
      ${canVote && !S.ratingsMissing ? `<div class="bt-zoom-rate">${starsHtml(S.myRatings.get(it.id) ?? 0, `data-z="rate" data-id="${esc(it.id)}"`, "estrellas, tu nota")}<small>Tu nota (secreta hasta el final). Toca la misma estrella para quitarla</small></div>` : ""}
    </div>`;
}

function openZoom(mode, battleId, id) {
  S.zoom = { mode, battleId, id };
  const d = zoomDialog();
  refreshZoom();
  if (!d.open) d.showModal();
  const it = zoomItems().find((x) => x.id === id);
  if (it && !urlOf(it.path)) sign([it.path]).then(refreshZoom);
}

// ---------- acciones ----------

const busyRun = async (key, fn) => {
  if (S.busy.has(key)) return;
  S.busy.add(key);
  repaint();
  try {
    await fn();
  } catch (err) {
    fail(err);
  } finally {
    S.busy.delete(key);
    await load();
    repaint();
  }
};
const rpc = async (name, args) => {
  const { data, error } = await sb().rpc(name, args);
  if (error) throw error;
  return data;
};

async function launch(prompt) {
  const text = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!text) return toast("Escribe el tema del reto o elige una idea.");
  if (text.length > PROMPT_MAX) return toast(`El tema es demasiado largo: máximo ${PROMPT_MAX} caracteres.`);
  if (!requireName()) return;
  await busyRun("launch", async () => {
    await rpc("start_battle", { p_prompt: text, p_name: myName() || null });
    S.draft = "";
    S.viewId = null;
    S.preview = null;
    S.changing = false;
    navigator.vibrate?.(10);
    toast("¡Reto lanzado! Ahora a por la foto.");
  });
}

// Abre la cámara (o la galería). Se llama directamente desde el toque: iOS no deja abrir el selector pasado un instante.
async function pick(mode) {
  if (!requireName() || S.busy.has("prep") || S.busy.has("send")) return;
  const [file] = await pickFiles({ camera: mode === "camera" });
  if (!file) return;
  S.busy.add("prep");
  repaint();
  try {
    const img = await prepareImage(file); // reduce y limpia los metadatos (la foto pasa por <canvas>)
    if (S.preview) URL.revokeObjectURL(S.preview.url);
    S.preview = { full: img.full, thumb: img.thumb, url: URL.createObjectURL(img.full) };
    S.changing = true;
  } catch (err) {
    fail(err);
  } finally {
    S.busy.delete("prep");
    repaint();
  }
}

function discard() {
  if (S.preview) URL.revokeObjectURL(S.preview.url);
  S.preview = null;
  S.changing = false;
  repaint();
}

async function sendPhoto() {
  const b = S.active;
  if (!b || !S.preview || S.busy.has("send")) return;
  if (!requireName()) return;
  const { full, thumb } = S.preview;
  await busyRun("send", async () => {
    const uid = me();
    const path = `${uid}/batalla-${b.id}.jpg`;
    const thumbPath = `${uid}/batalla-${b.id}_t.jpg`;
    const bucket = sb().storage.from("photos");
    const cur = await sb().from("battles").select("status").eq("id", b.id).maybeSingle();
    if (cur.error) throw cur.error;
    if (cur.data?.status !== "open") throw new Error("Ya no se pueden enviar fotos: la votación ha empezado");
    // Cambiar la foto = borrar la anterior (solo se puede con la batalla abierta) y volver a enviar.
    const mine = myEntry();
    if (mine) {
      const del = await sb().from("battle_entries").delete().eq("id", mine.id).select("id");
      if (del.error) throw del.error;
      if (!del.data?.length) throw new Error("Ya no puedes cambiar tu foto: la votación ha empezado");
    }
    await bucket.remove([path, thumbPath]); // la misma ruta de antes (o restos de un envío a medias)
    const up1 = await bucket.upload(path, full, { contentType: "image/jpeg" });
    if (up1.error) throw up1.error;
    const up2 = await bucket.upload(thumbPath, thumb, { contentType: "image/jpeg" });
    if (up2.error) {
      await bucket.remove([path]);
      throw up2.error;
    }
    const ins = await sb().from("battle_entries").insert({ battle_id: b.id, name: myName() || "Viajero", path, thumb_path: thumbPath });
    if (ins.error) {
      await bucket.remove([path, thumbPath]);
      throw ins.error;
    }
    S.urls.delete(path);
    S.urls.delete(thumbPath); // la ruta es la misma: hace falta un enlace nuevo para ver la foto nueva
    URL.revokeObjectURL(S.preview.url);
    S.preview = null;
    S.changing = false;
    navigator.vibrate?.(10);
    toast("¡Foto enviada!");
  });
}

async function startVoting() {
  const b = S.active;
  if (!b || b.status !== "open") return;
  if (S.entries.length < 2 && !confirm(S.entries.length ? "Solo hay una foto, así que no habrá nada que votar. ¿Empezar la votación igualmente?" : "Todavía no hay ninguna foto. ¿Empezar la votación igualmente?")) return;
  await busyRun("start", async () => {
    await rpc("start_voting", { p_battle: b.id });
    toast("¡A votar!");
  });
}

async function vote(entryId) {
  const b = S.active;
  if (!b || b.status !== "voting" || !entryId) return;
  await busyRun("vote", async () => {
    await rpc("cast_vote", { p_entry: entryId });
    S.myVote = entryId;
    navigator.vibrate?.(10);
    toast("Voto guardado. Puedes cambiarlo votando otra foto.", 2500);
  });
}

// Puntuar una foto con estrellas (1 a 5). Tocar la misma estrella quita la nota. Se ve al instante y se deshace si el servidor la rechaza.
async function rate(entryId, stars) {
  const b = S.active;
  if (!b || b.status !== "voting" || !entryId) return;
  const wanted = Number(stars);
  const had = S.myRatings.get(entryId) ?? 0;
  const next = had === wanted ? 0 : wanted;
  if (next) S.myRatings.set(entryId, next);
  else S.myRatings.delete(entryId);
  repaint();
  refreshZoom();
  try {
    await rpc("rate_battle_entry", { p_entry: entryId, p_stars: next });
    navigator.vibrate?.(8);
  } catch (err) {
    if (had) S.myRatings.set(entryId, had);
    else S.myRatings.delete(entryId);
    repaint();
    refreshZoom();
    fail(err);
  }
}

async function closeBattle() {
  const b = S.active;
  if (!b || b.status !== "voting") return;
  const p = S.progress;
  if (p && p.voted < p.participants && !confirm(`Han votado ${p.voted} de ${p.participants}. ¿Cerrar la votación igualmente?`)) return;
  await busyRun("close", async () => {
    await rpc("close_battle", { p_battle: b.id });
    S.viewId = b.id;
    S.sum = null; // el álbum tendrá una foto ganadora más
    markSeen(b.id);
  });
}

async function openResult(id) {
  S.viewId = id;
  markSeen(id);
  repaint();
  await loadResult(id);
  await load();
}

export const actions = {
  "batalla-tema": ({ i }) => {
    S.draft = THEMES[Number(i)] ?? S.draft;
    repaint();
  },
  "batalla-otra": () => {
    const next = shuffle(THEMES.filter((t) => t !== S.draft))[0];
    S.draft = next;
    newChips([next]);
    repaint();
  },
  "batalla-foto": ({ mode }) => pick(mode === "camera" ? "camera" : "gallery"), // sin «await» antes: debe abrirse dentro del toque
  "batalla-descartar": () => discard(),
  "batalla-cambiar": () => {
    S.changing = true;
    repaint();
  },
  "batalla-enviar": () => sendPhoto(),
  "batalla-votar-ya": () => startVoting(),
  "batalla-vote": ({ id }) => vote(id),
  "batalla-rate": ({ id, stars }) => rate(id, stars),
  "batalla-cerrar": () => closeBattle(),
  "batalla-zoom": ({ id }) => {
    const mode = S.viewId ? "done" : "voting";
    openZoom(mode, S.viewId || S.active?.id, id);
  },
  "batalla-ver": ({ id }) => openResult(id),
  "batalla-volver": () => {
    S.viewId = null;
    repaint();
  },
  "batalla-nueva": () => {
    S.viewId = null;
    repaint();
  },
};

export const onSubmit = async (event) => {
  const form = event.target.closest?.("[data-batalla-form]");
  if (!form) return false;
  event.preventDefault();
  if (form.dataset.batallaForm === "launch") await launch(new FormData(form).get("prompt"));
  return true;
};

export const onInput = async (event) => {
  if (event.target.matches?.('[data-keep="batalla-tema"]')) {
    S.draft = event.target.value;
    return true;
  }
  return false;
};

export const onChange = async () => false;

// ---------- álbum ----------

// summary() es síncrono: devuelve lo último que se calculó y, si está caducado, lo recalcula en segundo plano y repinta el
// álbum cuando llega. Así el álbum cuenta la batalla aunque el juego no se haya abierto en esta sesión.
async function loadSummary() {
  S.sumLoading = true;
  try {
    const { data: done, error } = await sb().from("battles").select("id,prompt,created_at,closed_at").eq("status", "done").order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    if (!done.length) {
      S.sum = { at: Date.now(), data: null };
      return;
    }
    const recent = done.slice(0, 8);
    const [board, ...res] = await Promise.all([sb().rpc("battle_leaderboard"), ...recent.map((b) => sb().rpc("battle_results", { p_battle: b.id }))]);
    const lines = [];
    const winners = [];
    recent.forEach((b, i) => {
      const rows = (res[i].data ?? []).map((x) => ({ ...x, votes: Number(x.votes), rank: Number(x.rank) }));
      const top = rows.filter((x) => x.rank === 1 && x.votes > 0);
      if (!top.length) lines.push(`«${b.prompt}»: sin votos`);
      else {
        lines.push(`«${b.prompt}»: ${top.length === 1 ? `ganó ${top[0].name}` : `empate entre ${top.map((x) => x.name).join(" y ")}`} con ${plural(top[0].votes, "voto", "votos")}`);
        winners.push(top[0].path);
      }
    });
    const paths = winners.slice(0, 6);
    await sign(paths);
    const rows = board.data ?? [];
    const best = rows[0];
    const mostVotes = [...rows].sort((a, b) => Number(b.votes) - Number(a.votes))[0];
    const highlights = [{ label: "Batallas", value: String(done.length) }];
    if (best && Number(best.wins) > 0) highlights.push({ label: "Más victorias", value: `${best.name} (${best.wins})` });
    if (mostVotes && Number(mostVotes.votes) > 0) highlights.push({ label: "Más votos", value: `${mostVotes.name} (${mostVotes.votes})` });
    S.sum = { at: Date.now(), data: { lines, highlights, images: paths.map(urlOf).filter(Boolean) } };
  } catch (err) {
    if (isMissing(err)) S.missing = true;
    S.sum = { at: Date.now(), data: S.sum?.data ?? null };
    console.warn("Batalla de fotos (álbum):", err?.message || err);
  } finally {
    S.sumLoading = false;
    if (state.view === "album") ctx.actions.render();
  }
}

export const summary = () => {
  if (!sb() || S.missing) return null;
  if (!S.sumLoading && (!S.sum || Date.now() - S.sum.at > 60_000)) {
    S.sumLoading = true;
    // Se difiere un instante: summary() se llama mientras el álbum se construye y no debe repintarlo a mitad.
    setTimeout(loadSummary, 0);
  }
  return S.sum?.data ?? null;
};
