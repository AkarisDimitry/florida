// Juego «Bingo del viaje»: un cartón de 5×5 retos igual para todos; cada viajero marca un reto con una foto de prueba y
// gana quien antes completa una línea. Contrato del módulo en docs/JUEGOS.md; SQL en supabase/juego_bingo.sql.
// Los datos viven en variables del módulo (la web repinta toda la página): se cargan al abrir el juego y se refrescan
// cada ~15 s mientras está abierto y la pestaña visible, además de un canal de tiempo real opcional.
// El diálogo (marcar, ver foto, cambiar retos) es un <dialog> propio colgado de <body>: así no lo destruyen los repintados.
import { state, ctx } from "../state.js";
import { icon } from "../icons.js";
import { esc, toast, ago, safeFormat, fmtStamp } from "../util.js";
import { getName } from "../store.js";
import { hueOf } from "../ledger.js";
import { prepareImage } from "../images.js";

export const meta = { id: "bingo", title: "Bingo del viaje", emoji: "🎯", blurb: "Tacha retos con una foto como prueba. Gana quien complete una línea." };

const TOTAL = 25;
const POLL_MS = 15_000;
const STALE_MS = 60_000; // el resumen del álbum se vuelve a pedir si lleva más de esto sin actualizarse
const SIGN_SECONDS = 6 * 3600;

// ---------- el cartón: líneas e ideas de retos ----------

// Las 12 líneas posibles (casillas numeradas por filas, 0..24). La misma definición que bingo_progress() en el SQL: aquí
// solo sirven para resaltar casillas y contar lo que falta; el ranking sale siempre del servidor.
const LINES = [
  ...[0, 1, 2, 3, 4].map((r) => ({ label: `fila ${r + 1}`, cells: [0, 1, 2, 3, 4].map((c) => r * 5 + c) })),
  ...[0, 1, 2, 3, 4].map((c) => ({ label: `columna ${c + 1}`, cells: [0, 1, 2, 3, 4].map((r) => r * 5 + c) })),
  { label: "diagonal principal", cells: [0, 6, 12, 18, 24] },
  { label: "diagonal secundaria", cells: [4, 8, 12, 16, 20] },
];

// Los 25 retos con los que se siembra la base de datos (los mismos que juego_bingo.sql) y un banco de ideas de reserva:
// el administrador puede sustituir cualquier reto por una de ellas desde «Cambiar retos».
const INITIAL = [
  "🌅 Ver un atardecer en la playa", "🍽️ Probar algo que nunca has comido", "🦩 Foto con un flamenco", "🧭 Pedir indicaciones a un desconocido", "😫 Un selfie con tu cara de cansado",
  "🐊 Ver un animal salvaje o su estatua", "🍦 Tomar un helado a deshoras", "🚗 Cantar a gritos en el coche", "🧢 Comprar un recuerdo absurdo", "🌴 Foto bajo una palmera",
  "🛒 Pasear por un supermercado de aquí", "🪧 Foto con un cartel que no entiendes", "👨‍👩‍👧 Foto de grupo con todos", "🍕 Foto de tu plato más grande", "🌊 Meter los pies en el agua",
  "🚦 Foto de una señal de tráfico curiosa", "🏖️ Hacer algo con arena", "💃 Bailar donde no toca", "💤 Foto de alguien dormido en el coche", "🐚 Encontrar una concha bonita",
  "🌃 Foto de noche con luces de ciudad", "🥤 Brindar con una bebida local", "🧳 Tu maleta en un sitio inesperado", "🤳 Selfie con alguien que no conocías", "🏆 Un momento que no olvidarás",
];
const EXTRA_IDEAS = [
  "🎶 Descubrir una canción local", "🛶 Subirte a algo que flota", "🌮 Comer con las manos", "📮 Mandar una postal", "🧊 Probar un sabor de helado raro", "🐦 Foto de un ave exótica",
  "🪁 Ver a alguien con una cometa", "🏄 Ver a alguien surfear", "🌈 Encontrar un arcoíris", "🎰 Foto con un cartel luminoso", "🛍️ Regatear o pedir descuento", "🚤 Montar en un barco",
  "🕶️ Foto con gafas de sol absurdas", "🥥 Beber de un coco", "🎢 Subir a algo que dé vértigo", "🧸 Foto con una mascota ajena", "📚 Entrar en una librería", "⛽ Foto en una gasolinera con encanto",
  "🌵 Foto con una planta rara", "🌙 Ver salir la luna", "🤝 Aprender una palabra local", "🎨 Foto de un mural o grafiti", "🍳 Desayunar algo distinto", "🧦 Foto de tus pies cansados",
];
const IDEAS = [...INITIAL, ...EXTRA_IDEAS];

// «🌅 Ver un atardecer» -> { emoji: "🌅", label: "Ver un atardecer" } (sin emoji al principio: todo es etiqueta)
const EMOJI_RE = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*)\s*(.*)$/su;
function splitCell(text) {
  const clean = String(text ?? "").trim();
  const m = EMOJI_RE.exec(clean);
  return m && m[2] ? { emoji: m[1], label: m[2] } : { emoji: "", label: clean };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const linesText = (n) => (n ? ` · ${plural(n, "línea", "líneas")}` : "");
const when = (iso) => safeFormat(fmtStamp, iso);
const ms = (iso) => Date.parse(iso) || 0;

// Cámara o galería. `capture` se pone como ATRIBUTO (no como propiedad): así lo respetan todos los navegadores y abre la cámara
// trasera del móvil. Tiene que llamarse directamente desde un toque (iOS no abre el selector pasado un instante).
function pickPhoto({ camera = false } = {}) {
  return new Promise((resolve) => {
    document.querySelectorAll("input[data-bingo-pick]").forEach((old) => old.remove()); // un selector cancelado sin aviso no se acumula
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
    input.dataset.bingoPick = "";
    if (camera) input.setAttribute("capture", "environment");
    input.style.display = "none";
    document.body.append(input);
    let done = false;
    const finish = (file) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => finish(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => finish(null));
    // Navegadores sin el evento "cancel": al volver el foco sin archivo se da por cancelado (con margen para el "change").
    window.addEventListener("focus", () => setTimeout(() => !input.files?.length && finish(null), 1500), { once: true });
    input.click();
  });
}

// ---------- estado del módulo ----------

let cells = new Map(); // idx -> texto del reto
let marks = []; // todas las marcas { id, user_id, name, cell, path, thumb_path, created_at }
let progress = []; // filas de bingo_progress(), ya ordenadas por el servidor
let byUser = new Map(); // user_id -> Map(cell -> marca)
let byCell = new Map(); // cell -> [marcas]
let loaded = false; // ya hay datos
let loadError = ""; // fallo al cargar (con datos antiguos delante: «no se pudo actualizar»)
let missing = false; // faltan las tablas o funciones (juego_bingo.sql)
let lastLoad = 0;
let peekCount = null; // mis marcas, de la consulta ligera de la lista
let tab = "mine"; // mine | all | rank
let viewing = null; // user_id cuyo cartón se mira (solo lectura); null = pantalla de la pestaña
let justMarked = null; // casilla recién marcada (para la animación)
let active = false;
let timers = [];
let channel = null;
let debounce = null;
let dataKey = "";
let inflight = null;
let dlg = null; // el <dialog> propio
let D = null; // estado del diálogo { mode, cell, owner, markId, prepared, busy, error, confirm, draft }

const sb = () => ctx.store?.sb;
const me = () => ctx.store?.user?.id ?? "";
const textOf = (idx) => cells.get(idx) ?? "";

// ---------- enlaces firmados (el almacén `photos` es privado) ----------

const urls = new Map(); // ruta -> { url, expires }
const urlOf = (path) => urls.get(path)?.url ?? "";
async function sign(paths) {
  const now = Date.now();
  const need = [...new Set(paths)].filter((p) => p && !(urls.get(p)?.expires > now));
  if (!need.length || !sb()) return;
  const { data, error } = await sb().storage.from("photos").createSignedUrls(need, SIGN_SECONDS);
  if (error) throw error;
  const expires = now + (SIGN_SECONDS - 3600) * 1000; // se renueva una hora antes de que caduque
  for (const { path, signedUrl } of data ?? []) if (signedUrl) urls.set(path, { url: signedUrl, expires });
}

// ---------- cálculo de líneas y puestos ----------

const doneLines = (byCellMap) => LINES.filter((l) => l.cells.every((c) => byCellMap.has(c)));
// Cuántas fotos faltan para la línea más cercana (para animar a quien aún no tiene ninguna).
const closestLine = (byCellMap) => Math.min(...LINES.map((l) => l.cells.filter((c) => !byCellMap.has(c)).length));

function index() {
  byUser = new Map();
  byCell = new Map();
  for (const m of marks) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, new Map());
    byUser.get(m.user_id).set(m.cell, m);
    if (!byCell.has(m.cell)) byCell.set(m.cell, []);
    byCell.get(m.cell).push(m);
  }
}

function players() {
  const rows = progress.map((p) => ({ ...p, me: p.user_id === me() }));
  if (me() && !rows.some((r) => r.me)) rows.push({ user_id: me(), name: getName() || "Tú", marks: 0, lines: 0, first_line_at: null, full_at: null, me: true });
  return rows;
}
const rowOf = (uid) => players().find((r) => r.user_id === uid);
// Quien antes completó una línea canta «¡Bingo!».
const winner = () => progress.filter((p) => p.first_line_at).sort((a, b) => ms(a.first_line_at) - ms(b.first_line_at))[0] ?? null;

// ---------- carga de datos ----------

const isMissing = (e) => ["42P01", "PGRST205", "PGRST202", "42883"].includes(e?.code) || /does not exist|schema cache|could not find the (table|function)/i.test(e?.message || "");

function friendly(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return "No hay conexión con el servidor. Comprueba tu internet e inténtalo de nuevo.";
  if (/jwt expired|invalid jwt|not authenticated/i.test(msg)) return "Tu sesión ha caducado. Recarga la página y vuelve a entrar.";
  if (err?.code === "23505" && /user_cell_key|duplicate key/i.test(msg)) return "Ya habías marcado este reto. He actualizado el cartón.";
  if (/No autorizado/i.test(msg)) return "Solo los administradores pueden cambiar los retos.";
  if (err?.code === "42501" || /row-level security|permission denied/i.test(msg)) return "No tienes permiso para hacer esto. ¿Sigues autorizado como viajero?";
  if (/maximum allowed size|payload too large|too large/i.test(msg)) return "La foto es demasiado grande (máximo 5 MB). Prueba con otra.";
  if (/mime type|not supported|unsupported/i.test(msg)) return "Solo se admiten fotos en JPG.";
  // Los mensajes en español de nuestras funciones SQL (código 22023 o el del nombre repetido) se enseñan tal cual; los demás
  // errores del servidor suelen venir en inglés y técnicos: se explican en español y el detalle queda en la consola.
  if (err?.code === "22023" || err?.code === "23505") return msg;
  if (typeof err?.code === "string" || err?.__isStorageError || err?.status || err?.statusCode) {
    console.warn("Bingo:", msg);
    return "El servidor no pudo completar la acción. Inténtalo de nuevo en un momento.";
  }
  return msg || "Algo ha fallado. Inténtalo de nuevo.";
}

function load() {
  return (async () => {
    const c = sb();
    if (!c || !me()) return;
    const [cr, mr, pr] = await Promise.all([
      c.from("bingo_cells").select("idx,text").order("idx"),
      c.from("bingo_marks").select("id,user_id,name,cell,path,thumb_path,created_at").order("created_at"),
      c.rpc("bingo_progress"),
    ]);
    const failed = [cr, mr, pr].find((r) => r.error)?.error;
    lastLoad = Date.now();
    if (failed) {
      if (isMissing(failed)) missing = true;
      else loadError = friendly(failed);
      return;
    }
    missing = false;
    loadError = "";
    cells = new Map((cr.data ?? []).map((r) => [Number(r.idx), r.text]));
    marks = (mr.data ?? []).map((m) => ({ ...m, cell: Number(m.cell) }));
    progress = (pr.data ?? []).map((p) => ({ ...p, marks: Number(p.marks), lines: Number(p.lines) }));
    loaded = true;
    index();
    // Solo se firman las miniaturas que se van a ver (mi cartón, el que se mira y las del resumen del álbum).
    try {
      await sign(thumbsNeeded());
    } catch (err) {
      console.warn("Bingo: no se pudieron firmar las fotos:", err.message || err);
    }
  })()
    .catch((err) => {
      lastLoad = Date.now();
      loadError = friendly(err);
    })
    .then(afterLoad);
}

const thumbsNeeded = () => [...(byUser.get(me())?.values() ?? []), ...(viewing ? (byUser.get(viewing)?.values() ?? []) : []), ...summaryPicks()].map((m) => m.thumb_path);

function refresh({ force = false } = {}) {
  if (inflight) return force ? inflight.then(() => refresh()) : inflight;
  inflight = load().finally(() => {
    inflight = null;
  });
  return inflight;
}

// Repinta solo si algo ha cambiado de verdad (así no se pierde el foco ni el desplazamiento cada 15 s).
function afterLoad() {
  const key = JSON.stringify([missing, loaded, loadError, [...cells], marks.map((m) => m.id), progress, viewing, tab]);
  if (key !== dataKey) {
    dataKey = key;
    ctx.actions.render?.();
  }
  reconcileDialog();
}

// ---------- tiempo real, temporizadores ----------

function subscribe() {
  const c = sb();
  if (!c || channel) return;
  try {
    channel = c
      .channel("viaje-bingo")
      .on("postgres_changes", { event: "*", schema: "public", table: "bingo_marks" }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => active && refresh(), 700); // varias marcas seguidas = un solo refresco
      })
      .subscribe();
  } catch (err) {
    console.warn("Bingo: sin tiempo real:", err.message || err);
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
  if (active && !document.hidden && !D?.busy) refresh();
};
const onVisible = () => !document.hidden && tick();

export function enter() {
  active = true;
  viewing = null;
  dataKey = "";
  timers = [setInterval(tick, POLL_MS)];
  document.addEventListener("visibilitychange", onVisible);
  subscribe();
  refresh();
}

export function leave() {
  active = false;
  for (const t of timers) clearInterval(t);
  timers = [];
  document.removeEventListener("visibilitychange", onVisible);
  unsubscribe();
  closeDialog(true);
  dlg?.remove();
  dlg = null;
  viewing = null;
}

// Consulta ligera desde la lista de juegos: solo cuántas marcas llevo (para la etiqueta de la tarjeta).
export async function peek() {
  const c = sb();
  if (!c || !me()) return;
  const { count, error } = await c.from("bingo_marks").select("id", { count: "exact", head: true }).eq("user_id", me());
  if (error) {
    if (isMissing(error) && !missing) {
      missing = true;
      ctx.actions.render?.();
    }
    return;
  }
  if (count !== peekCount) {
    peekCount = count;
    ctx.actions.render?.();
  }
}

export const available = () => !missing;
export const badge = () => {
  if (missing) return "";
  const n = loaded ? (byUser.get(me())?.size ?? 0) : peekCount;
  if (n == null) return "";
  return n ? `Llevas ${n}/${TOTAL}` : "¡Empieza!";
};

// ---------- pantalla ----------

export const render = () => {
  try {
    return build();
  } catch (err) {
    console.error(err);
    return `<div class="notice">${icon("file", 18)}<p><strong>No se pudo mostrar el bingo.</strong> ${esc(err.message || String(err))}</p></div>`;
  }
};

function build() {
  if (!loaded) {
    return loadError
      ? `<div class="gate"><h2>No se pudo cargar el bingo</h2><p>${esc(loadError)}</p><button type="button" class="btn primary" data-action="bingo-retry">Reintentar</button></div>`
      : `<p class="bingo-loading" role="status">Cargando el cartón…</p>`;
  }
  // El aviso del ganador va debajo del cartón (para que este quepa en pantalla) y no se repite en el Ranking, que ya lo destaca.
  const body = viewing ? playerBoard(viewing) : tab === "all" ? `${winnerBanner()}${allTab()}` : tab === "rank" ? rankTab() : mineTab();
  return `${segmented()}${loadError ? `<p class="bingo-stale" role="status">${icon("file", 16)} No se pudo actualizar: ${esc(loadError)} Se reintentará solo.</p>` : ""}${body}`;
}

function segmented() {
  const items = [["mine", "Mi cartón"], ["all", "Todos"], ["rank", "Ranking"]];
  return `<div class="bingo-seg" role="group" aria-label="Secciones del bingo">${items
    .map(([id, label]) => `<button type="button" data-action="bingo-tab" data-tab="${id}" aria-pressed="${!viewing && tab === id}">${label}</button>`)
    .join("")}</div>`;
}

function winnerBanner() {
  const w = winner();
  if (!w) return "";
  const mine = w.user_id === me();
  return `<p class="bingo-win"><span aria-hidden="true">🏆</span><span><strong>¡Bingo!</strong> ${mine ? "Tú fuiste quien primero completó una línea." : `${esc(w.name)} fue quien primero completó una línea.`} <small>${esc(when(w.first_line_at))}</small></span></p>`;
}

const bar = (n, label) => `<div class="bingo-bar" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${TOTAL}" aria-valuenow="${n}"><i style="width:${(n / TOTAL) * 100}%"></i></div>`;

function mineTab() {
  const mine = byUser.get(me()) ?? new Map();
  const n = mine.size;
  const lines = doneLines(mine);
  const hint =
    n === 0
      ? "Toca una casilla, haz una foto como prueba y márcala."
      : n === TOTAL
        ? "🎉 ¡Cartón lleno! Lo has completado todo."
        : lines.length
          ? `Líneas completas: ${lines.map((l) => l.label).join(", ")}.`
          : `Te ${closestLine(mine) === 1 ? "falta 1 reto" : `faltan ${closestLine(mine)} retos`} para tu primera línea.`;
  return `<section class="bingo-head" aria-label="Tu progreso">
      <p class="bingo-count"><strong>Llevas ${n} de ${TOTAL}</strong>${esc(linesText(lines.length))}</p>
      ${bar(n, "Retos marcados")}
      <p class="bingo-hint">${esc(hint)}</p>
    </section>
    ${board(mine, me())}
    ${winnerBanner()}
    ${state.isAdmin ? `<p class="bingo-admin"><button type="button" class="link-btn" data-action="bingo-edit">${icon("edit", 15)} Cambiar retos</button></p>` : ""}`;
}

// El cartón: 25 botones. Una casilla marcada enseña la miniatura de la foto y una marca (✓, o ★ si está en una línea completa).
function board(byCellMap, owner) {
  const lines = doneLines(byCellMap);
  const inLine = new Set(lines.flatMap((l) => l.cells));
  const own = owner === me();
  const items = Array.from({ length: TOTAL }, (_, idx) => {
    const { emoji, label } = splitCell(textOf(idx));
    const mark = byCellMap.get(idx);
    const photo = mark ? urlOf(mark.thumb_path) : "";
    const line = inLine.has(idx);
    const status = mark ? (own ? "Marcado con tu foto" : `Marcado por ${mark.name}`) : own ? "Sin marcar, toca para hacer la foto" : "Sin marcar";
    return `<button type="button" class="bingo-cell${mark ? " is-done" : ""}${line ? " is-line" : ""}${justMarked === idx ? " is-new" : ""}" data-action="bingo-cell" data-idx="${idx}" aria-label="${esc(`Reto ${idx + 1}: ${label}. ${status}${line ? ". Forma parte de una línea completa" : ""}`)}">
      ${photo ? `<img class="bingo-photo" src="${esc(photo)}" alt="" loading="lazy" decoding="async">` : ""}
      ${emoji ? `<span class="bingo-emoji" aria-hidden="true">${esc(emoji)}</span>` : ""}
      ${mark && photo ? "" : `<span class="bingo-text${emoji ? "" : " no-emoji"}" aria-hidden="true">${esc(label)}</span>`}
      ${mark ? `<span class="bingo-check" aria-hidden="true">${icon(line ? "star" : "check", 14)}</span>` : ""}
    </button>`;
  });
  return `<div class="bingo-board" role="group" aria-label="Cartón de bingo de 5 por 5 retos">${items.join("")}</div>`;
}

// Cartón de otra persona (solo lectura).
function playerBoard(uid) {
  const row = rowOf(uid);
  const theirs = byUser.get(uid) ?? new Map();
  const name = row?.name ?? [...theirs.values()][0]?.name ?? "Viajero";
  const lines = doneLines(theirs);
  return `<div class="bingo-viewing"><button type="button" class="btn small" data-action="bingo-back">${icon("chevronL", 16)} Volver</button><h3>Cartón de ${esc(name)}${uid === me() ? ` <small class="you">tú</small>` : ""}</h3></div>
    <section class="bingo-head" aria-label="Progreso de ${esc(name)}">
      <p class="bingo-count"><strong>${theirs.size} de ${TOTAL}</strong>${esc(linesText(lines.length))}</p>
      ${bar(theirs.size, `Retos marcados por ${name}`)}
      ${lines.length ? `<p class="bingo-hint">Líneas completas: ${esc(lines.map((l) => l.label).join(", "))}.</p>` : ""}
    </section>
    ${board(theirs, uid)}
    <p class="bingo-hint center">Solo lectura: toca una casilla para ver su foto.</p>`;
}

const avatar = (name, size = "lg") => `<span class="person-dot ${size}" style="--h:${hueOf(name)}" aria-hidden="true">${esc(String(name).charAt(0).toUpperCase())}</span>`;

function chips(r, w) {
  return `${r.user_id === w?.user_id ? `<span class="bingo-chip is-bingo"><span aria-hidden="true">🥇</span> ¡Bingo!</span>` : ""}${r.marks >= TOTAL ? `<span class="bingo-chip"><span aria-hidden="true">🎉</span> Cartón lleno</span>` : ""}`;
}

function miniMap(uid) {
  const theirs = byUser.get(uid) ?? new Map();
  const inLine = new Set(doneLines(theirs).flatMap((l) => l.cells));
  return `<span class="bingo-mini" aria-hidden="true">${Array.from({ length: TOTAL }, (_, i) => `<i class="${inLine.has(i) ? "is-line" : theirs.has(i) ? "is-on" : ""}"></i>`).join("")}</span>`;
}

function allTab() {
  const w = winner();
  const rows = players();
  if (!rows.some((r) => r.marks > 0)) return `<div class="gate"><h2>Todavía nadie ha marcado un reto</h2><p>Sé la primera persona: ve a «Mi cartón», toca una casilla y haz la foto.</p></div>`;
  rows.sort((a, b) => b.me - a.me); // yo primero; el resto, en el orden del servidor
  return `<ul class="bingo-players">${rows
    .map(
      (r) => `<li><button type="button" class="bingo-player${r.user_id === w?.user_id ? " is-bingo" : ""}" data-action="bingo-open" data-user="${esc(r.user_id)}" aria-label="${esc(`Ver el cartón de ${r.name}: ${r.marks} de ${TOTAL}, ${plural(r.lines, "línea", "líneas")}`)}">
        ${avatar(r.name)}
        <span class="bingo-player-main"><strong>${esc(r.name)}${r.me ? ` <small class="you">tú</small>` : ""}</strong>
          <span class="bingo-player-stats">${r.marks} de ${TOTAL}${esc(linesText(r.lines))}</span>
          ${bar(r.marks, `Progreso de ${r.name}`)}
          ${chips(r, w) ? `<span class="bingo-chips">${chips(r, w)}</span>` : ""}</span>
        ${miniMap(r.user_id)}
      </button></li>`,
    )
    .join("")}</ul><p class="bingo-hint center">Toca un cartón para ver sus fotos.</p>`;
}

function rankTab() {
  const w = winner();
  const rows = players().filter((r) => r.marks > 0);
  if (!rows.length) return `<div class="gate"><h2>Aún no hay ranking</h2><p>Aparecerá cuando alguien marque su primer reto.</p></div>`;
  let pos = 0;
  let prev = "";
  const items = rows.map((r, i) => {
    const key = `${r.lines}|${r.marks}|${r.first_line_at}`;
    if (key !== prev) pos = i + 1;
    prev = key;
    return `<li><button type="button" class="bingo-player${r.user_id === w?.user_id ? " is-bingo" : ""}" data-action="bingo-open" data-user="${esc(r.user_id)}" aria-label="${esc(`Puesto ${pos}: ${r.name}, ${r.marks} marcas, ${plural(r.lines, "línea", "líneas")}. Ver su cartón`)}">
      <span class="bingo-pos${pos === 1 ? " is-first" : ""}" aria-hidden="true">${pos}</span>
      ${avatar(r.name, "")}
      <span class="bingo-player-main"><strong>${esc(r.name)}${r.me ? ` <small class="you">tú</small>` : ""}</strong>
        <span class="bingo-player-stats">${plural(r.lines, "línea", "líneas")} · ${plural(r.marks, "marca", "marcas")}${r.first_line_at ? ` · 1.ª línea ${esc(ago(ms(r.first_line_at)))}` : ""}</span>
        ${chips(r, w) ? `<span class="bingo-chips">${chips(r, w)}</span>` : ""}</span>
    </button></li>`;
  });
  const hero = w
    ? `<section class="bingo-hero"><span class="bingo-hero-medal" aria-hidden="true">🏅</span><div><p class="eyebrow">¡Bingo!</p><h3>${esc(w.name)}${w.user_id === me() ? ` <small class="you">tú</small>` : ""}</h3><p>Fue quien primero completó una línea · ${esc(when(w.first_line_at))}</p></div></section>`
    : `<section class="bingo-hero is-empty"><span class="bingo-hero-medal" aria-hidden="true">🎯</span><div><p class="eyebrow">Sin bingo todavía</p><p>Nadie ha completado una línea. ¡Gana quien lo haga primero!</p></div></section>`;
  return `${hero}<ol class="bingo-rank">${items.join("")}</ol><p class="bingo-hint center">Se ordena por líneas, luego por marcas y, si empatan, por quién completó antes su primera línea.</p>`;
}

// ---------- el diálogo propio ----------

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "bingo-dialog";
  dlg.setAttribute("aria-labelledby", "bingo-dlg-title");
  document.body.append(dlg);
  dlg.addEventListener("click", (event) => {
    if (event.target === dlg) {
      if (!D?.busy) closeDialog();
      return;
    }
    const el = event.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    // Sin `await` antes: la cámara de iOS solo se abre si la llamada sale directamente del toque.
    fn({ ...el.dataset }, el);
  });
  dlg.addEventListener("cancel", (event) => D?.busy && event.preventDefault()); // Escape no corta una subida
  dlg.addEventListener("close", () => {
    if (!dlg?.open) cleanupDialog();
  });
  return dlg;
}

function cleanupDialog() {
  if (D?.prepared?.url) URL.revokeObjectURL(D.prepared.url);
  D = null;
}

function openDialog(next) {
  if (D?.prepared?.url && D.prepared.url !== next.prepared?.url) URL.revokeObjectURL(D.prepared.url);
  D = next;
  ensureDialog();
  paintDialog({ focusFirst: true });
  if (!dlg.open) dlg.showModal();
  dlg.querySelector("[data-autofocus]")?.focus();
}

// Al cerrar, el foco vuelve a la casilla (o al botón) que abrió el diálogo: el repintado de la página destruye el botón
// original, así que el navegador no puede devolverlo solo.
function closeDialog(silent = false) {
  const back = D?.mode === "edit" ? "[data-action=bingo-edit]" : D?.cell != null ? `.bingo-cell[data-idx="${D.cell}"]` : "";
  if (dlg?.open) dlg.close();
  cleanupDialog();
  if (silent) return;
  dlg?.replaceChildren();
  if (back) requestAnimationFrame(() => document.querySelector(back)?.focus());
}

function dialogHead(title) {
  return `<div class="dialog-head"><h2 id="bingo-dlg-title" tabindex="-1">${esc(title)}</h2><button type="button" class="icon-btn" data-action="bingo-close" aria-label="Cerrar"${D?.busy ? " disabled" : ""}>${icon("x", 20)}</button></div>`;
}

function challengeBlock(idx) {
  const { emoji, label } = splitCell(textOf(idx));
  return `<div class="bingo-challenge">${emoji ? `<span class="bingo-challenge-emoji" aria-hidden="true">${esc(emoji)}</span>` : ""}<p>${esc(label)}</p></div>`;
}

const errorBlock = () => (D?.error ? `<p class="bingo-error" role="alert">${esc(D.error)}</p>` : "");

function paintDialog({ focusFirst = false } = {}) {
  if (!dlg || !D) return;
  const hadFocus = dlg.contains(document.activeElement) ? document.activeElement?.dataset?.action : null;
  if (D.mode === "edit") captureDraft();
  dlg.innerHTML = { mark: markHtml, view: viewHtml, peek: peekHtml, edit: editHtml }[D.mode]();
  if (!focusFirst && hadFocus) (dlg.querySelector(`[data-action="${hadFocus}"]:not([disabled])`) ?? dlg.querySelector("#bingo-dlg-title"))?.focus();
}

function markHtml() {
  const busy = D.busy;
  const p = D.prepared;
  return `${dialogHead(`Reto ${D.cell + 1} de ${TOTAL}`)}
    ${challengeBlock(D.cell)}
    ${p ? `<figure class="bingo-preview"><img src="${esc(p.url)}" alt="Vista previa de tu foto"></figure>` : `<p class="hint">Haz una foto como prueba de que lo has cumplido. La verán todos los viajeros.</p>`}
    <div class="bingo-pick">
      <button type="button" class="btn big${p ? "" : " primary"}" data-action="bingo-pick" data-camera="1"${busy ? " disabled" : ""}${p ? "" : " data-autofocus"}>${icon("camera", 20)} ${p ? "Hacer otra foto" : "Hacer foto"}</button>
      <button type="button" class="btn big" data-action="bingo-pick"${busy ? " disabled" : ""}>${icon("images", 20)} Elegir de la galería</button>
    </div>
    ${busy === "prepare" ? `<p class="bingo-status" role="status">Preparando la foto…</p>` : busy === "upload" ? `<p class="bingo-status" role="status">Subiendo la foto…</p>` : ""}
    ${errorBlock()}
    <div class="dialog-actions"><button type="button" class="btn big${p ? " primary" : ""}" data-action="bingo-submit"${p && !busy ? " data-autofocus" : " disabled"}>${icon("check", 20)} Marcar reto</button></div>`;
}

function viewHtml() {
  const mark = marks.find((m) => m.id === D.markId);
  if (!mark) return `${dialogHead("Reto")}<p class="hint">Esta marca ya no existe.</p>`;
  const own = mark.user_id === me();
  const { label } = splitCell(textOf(mark.cell));
  const src = urlOf(mark.path) || urlOf(mark.thumb_path);
  const date = when(mark.created_at);
  return `${dialogHead(`Reto ${mark.cell + 1} de ${TOTAL}`)}
    ${challengeBlock(mark.cell)}
    ${src ? `<figure class="bingo-big"><img src="${esc(src)}" alt="${esc(`Foto de prueba de ${own ? "ti" : mark.name} para el reto: ${label}`)}"></figure>` : `<p class="hint">No se pudo cargar la foto.</p>`}
    <p class="bingo-by">${avatar(mark.name, "")}<span><strong>${esc(own ? `${mark.name} (tú)` : mark.name)}</strong><small>${esc(date)}${date ? " · " : ""}${esc(ago(ms(mark.created_at)))}</small></span></p>
    ${errorBlock()}
    ${
      own
        ? D.confirm
          ? `<div class="bingo-confirm" role="group" aria-label="Confirmar"><p>¿Quitar tu marca? Se borra la foto y podrás volver a hacerla.</p>
              <div class="dialog-actions"><button type="button" class="btn big" data-action="bingo-keep" data-autofocus${D.busy ? " disabled" : ""}>No, dejarla</button><button type="button" class="btn big danger" data-action="bingo-unmark"${D.busy ? " disabled" : ""}>${icon("trash", 18)} Sí, quitar</button></div></div>`
          : `<div class="dialog-actions"><button type="button" class="btn danger" data-action="bingo-unmark"${D.busy ? " disabled" : ""}>${icon("trash", 18)} Quitar mi marca</button><button type="button" class="btn primary" data-action="bingo-close" data-autofocus>Cerrar</button></div>`
        : `<div class="dialog-actions"><button type="button" class="btn primary" data-action="bingo-close" data-autofocus>Cerrar</button></div>`
    }`;
}

function peekHtml() {
  const name = rowOf(D.owner)?.name ?? "Esa persona";
  return `${dialogHead(`Reto ${D.cell + 1} de ${TOTAL}`)}
    ${challengeBlock(D.cell)}
    <p class="hint">${esc(name)} todavía no ha marcado este reto.</p>
    <div class="dialog-actions"><button type="button" class="btn primary" data-action="bingo-close" data-autofocus>Cerrar</button></div>`;
}

// «Cambiar retos» (solo administradores): los 25 textos editables, con ideas de reserva.
function editHtml() {
  const draft = D.draft ?? Array.from({ length: TOTAL }, (_, i) => textOf(i));
  const busy = D.busy;
  return `${dialogHead("Cambiar retos")}
    <p class="hint">Escribe el reto que quieras en cada casilla (hasta 120 letras). Si empieza con un emoji, se verá grande en la casilla. <strong>Si cambias un reto que ya tiene marcas, esas marcas se conservan</strong> con su foto bajo el reto nuevo.</p>
    <ul class="bingo-edit">${draft
      .map((text, i) => {
        const n = byCell.get(i)?.length ?? 0;
        return `<li><label for="bingo-e-${i}">Casilla ${i + 1} <small>fila ${Math.floor(i / 5) + 1}, columna ${(i % 5) + 1}</small>${n ? ` <small class="bingo-marks-note">${plural(n, "marca", "marcas")}</small>` : ""}</label>
          <span class="bingo-edit-row"><input id="bingo-e-${i}" data-edit="${i}" type="text" maxlength="120" value="${esc(text)}" autocomplete="off"${busy ? " disabled" : ""}>
          <button type="button" class="icon-btn" data-action="bingo-idea" data-idx="${i}" aria-label="Proponer otro reto para la casilla ${i + 1}" title="Proponer otro reto"${busy ? " disabled" : ""}>💡</button></span></li>`;
      })
      .join("")}</ul>
    ${errorBlock()}
    <div class="dialog-actions"><button type="button" class="btn" data-action="bingo-reset-ideas"${busy ? " disabled" : ""}>Volver a los retos iniciales</button><button type="button" class="btn primary" data-action="bingo-save"${busy ? " disabled" : ""}>${busy ? "Guardando…" : "Guardar retos"}</button></div>`;
}

const editInputs = () => [...(dlg?.querySelectorAll("[data-edit]") ?? [])];
function captureDraft() {
  const inputs = editInputs();
  if (inputs.length === TOTAL) D.draft = inputs.map((i) => i.value);
}

// Tras cada carga: si lo que muestra el diálogo ha cambiado por otra persona (o desde otro móvil), se pone al día.
function reconcileDialog() {
  if (!D || !dlg?.open) return;
  if (D.mode === "view") {
    if (!marks.some((m) => m.id === D.markId)) {
      closeDialog();
      toast("Esa marca ya no está.");
    } else if (!D.busy) paintDialog();
  } else if (D.mode === "mark" || D.mode === "peek") {
    const mark = byUser.get(D.mode === "mark" ? me() : D.owner)?.get(D.cell);
    if (mark && !D.busy) {
      D.mode = "view";
      D.markId = mark.id;
      D.error = "";
      paintDialog({ focusFirst: true });
      dlg.querySelector("[data-autofocus]")?.focus();
    }
  }
}

// ---------- acciones ----------

const fail = (err) => {
  console.error(err);
  if (D && dlg?.open) {
    D.error = friendly(err);
    D.busy = false;
    paintDialog();
  } else toast(friendly(err));
};
const act = (fn) => async (data, el) => {
  try {
    await fn(data, el);
  } catch (err) {
    fail(err);
  }
};
const renderNow = () => ctx.actions.render?.();

async function openMark(mark) {
  openDialog({ mode: "view", cell: mark.cell, markId: mark.id, owner: mark.user_id });
  const d = D;
  try {
    await sign([mark.path]);
    if (D === d) paintDialog();
  } catch (err) {
    console.warn("Bingo: no se pudo firmar la foto grande:", err.message || err);
  }
}

async function preparePhoto(file) {
  const d = D;
  d.busy = "prepare";
  d.error = "";
  paintDialog();
  try {
    const out = await prepareImage(file);
    if (d.prepared?.url) URL.revokeObjectURL(d.prepared.url);
    d.prepared = { full: out.full, thumb: out.thumb, url: URL.createObjectURL(out.full) };
  } catch (err) {
    d.error = friendly(err);
  }
  d.busy = false;
  if (D === d) {
    paintDialog();
    dlg.querySelector("[data-autofocus]")?.focus();
  }
}

async function submitMark() {
  const d = D;
  if (!d || d.busy || !d.prepared || d.mode !== "mark") return;
  const c = sb();
  const uid = me();
  const id = crypto.randomUUID();
  // Rutas dentro de la carpeta del usuario (lo exigen las políticas de Storage y la restricción de bingo_marks).
  const path = `${uid}/bingo-${d.cell}-${id}.jpg`;
  const thumb_path = `${uid}/bingo-${d.cell}-${id}_t.jpg`;
  const before = byUser.get(uid)?.size ?? 0;
  const beforeLines = doneLines(byUser.get(uid) ?? new Map()).length;
  d.busy = "upload";
  d.error = "";
  paintDialog();
  try {
    const bucket = c.storage.from("photos");
    for (const [where, blob] of [[path, d.prepared.full], [thumb_path, d.prepared.thumb]]) {
      const { error } = await bucket.upload(where, blob, { contentType: "image/jpeg" });
      if (error) throw error;
    }
    const { error } = await c.from("bingo_marks").insert({ id, cell: d.cell, name: getName() || "Viajero", path, thumb_path });
    if (error) throw error;
  } catch (err) {
    c.storage.from("photos").remove([path, thumb_path]).catch(() => {}); // no dejar fotos huérfanas
    d.busy = false;
    d.error = friendly(err);
    if (err?.code === "23505") await refresh({ force: true });
    if (D === d) paintDialog();
    return;
  }
  justMarked = d.cell;
  setTimeout(() => (justMarked = null), 1600);
  await refresh({ force: true });
  closeDialog();
  const mine = byUser.get(uid) ?? new Map();
  const lines = doneLines(mine).length;
  const w = winner();
  if (mine.size === TOTAL) toast("🎉 ¡Cartón lleno! Has completado todos los retos.");
  else if (lines > beforeLines) toast(w?.user_id === uid && beforeLines === 0 && progress.filter((p) => p.first_line_at).length === 1 ? "🎯 ¡BINGO! Eres la primera persona en completar una línea." : `🎉 ¡Línea completa! Ya llevas ${plural(lines, "línea", "líneas")}.`);
  else toast(`¡Reto marcado! Llevas ${mine.size} de ${TOTAL}${before === 0 ? ". ¡Ya has empezado!" : "."}`);
}

async function removeMark() {
  const d = D;
  if (!d || d.busy || d.mode !== "view") return;
  const mark = marks.find((m) => m.id === d.markId);
  if (!mark || mark.user_id !== me()) return;
  if (!d.confirm) {
    d.confirm = true;
    d.error = "";
    paintDialog({ focusFirst: true });
    dlg.querySelector("[data-autofocus]")?.focus();
    return;
  }
  d.busy = "remove";
  paintDialog();
  const { data, error } = await sb().from("bingo_marks").delete().eq("id", mark.id).select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("No se pudo quitar la marca. Puede que ya no exista.");
  sb().storage.from("photos").remove([mark.path, mark.thumb_path]).catch(() => {}); // primero la fila (es la verdad), luego los archivos
  await refresh({ force: true });
  closeDialog();
  toast("Marca quitada. Puedes volver a hacerla cuando quieras.");
}

async function saveCells() {
  const d = D;
  if (!d || d.busy || d.mode !== "edit" || !state.isAdmin) return;
  captureDraft();
  const texts = (d.draft ?? []).map((t) => t.replace(/\s+/g, " ").trim());
  const bad = texts.findIndex((t) => !t || t.length > 120);
  if (texts.length !== TOTAL || bad >= 0) {
    d.error = bad >= 0 ? `El reto de la casilla ${bad + 1} ${texts[bad] ? "tiene más de 120 letras" : "está vacío"}.` : "Hacen falta 25 retos.";
    paintDialog();
    return;
  }
  d.busy = "save";
  d.error = "";
  paintDialog();
  const { error } = await sb().rpc("set_bingo_cells", { p_texts: texts });
  if (error) throw error;
  const withMarks = texts.filter((t, i) => t !== textOf(i) && (byCell.get(i)?.length ?? 0) > 0).length;
  await refresh({ force: true });
  closeDialog();
  toast(withMarks ? `Retos guardados. ${plural(withMarks, "reto cambiado ya tenía marcas, que se conservan", "retos cambiados ya tenían marcas, que se conservan")}.` : "Retos guardados.");
}

let ideaPointer = 0;
function nextIdea() {
  const used = new Set(editInputs().map((i) => i.value.trim().toLowerCase()));
  for (let k = 0; k < IDEAS.length; k++) {
    const idea = IDEAS[(ideaPointer + k) % IDEAS.length];
    if (!used.has(idea.toLowerCase())) {
      ideaPointer = (ideaPointer + k + 1) % IDEAS.length;
      return idea;
    }
  }
  return IDEAS[ideaPointer++ % IDEAS.length];
}

export const actions = {
  "bingo-tab": ({ tab: next }) => {
    tab = ["mine", "all", "rank"].includes(next) ? next : "mine";
    viewing = null;
    renderNow();
    requestAnimationFrame(() => document.querySelector(".bingo-seg [aria-pressed=true]")?.focus());
  },
  "bingo-retry": act(async () => {
    loadError = "";
    renderNow();
    await refresh();
  }),
  "bingo-open": act(async ({ user }) => {
    viewing = user;
    await sign(thumbsNeeded()).catch(() => {});
    renderNow();
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.querySelector(".bingo-viewing .btn")?.focus());
  }),
  "bingo-back": () => {
    viewing = null;
    renderNow();
    requestAnimationFrame(() => document.querySelector(".bingo-seg [aria-pressed=true]")?.focus());
  },
  "bingo-cell": act(async ({ idx }) => {
    const cell = Number(idx);
    const owner = viewing ?? me();
    const mark = byUser.get(owner)?.get(cell);
    if (mark) return openMark(mark);
    return openDialog(owner === me() ? { mode: "mark", cell } : { mode: "peek", cell, owner });
  }),
  "bingo-close": () => !D?.busy && closeDialog(),
  "bingo-pick": act(async ({ camera }) => {
    if (!D || D.busy || D.mode !== "mark") return;
    const file = await pickPhoto({ camera: camera === "1" }); // sin nada antes: tiene que salir directamente del toque
    if (file && D?.mode === "mark") await preparePhoto(file);
  }),
  "bingo-submit": act(submitMark),
  "bingo-unmark": act(removeMark),
  "bingo-keep": () => {
    if (!D) return;
    D.confirm = false;
    paintDialog({ focusFirst: true });
    dlg.querySelector("[data-autofocus]")?.focus();
  },
  "bingo-edit": () => state.isAdmin && openDialog({ mode: "edit" }),
  "bingo-idea": ({ idx }) => {
    const input = dlg?.querySelector(`[data-edit="${Number(idx)}"]`);
    if (input) {
      input.value = nextIdea();
      input.focus();
    }
  },
  "bingo-reset-ideas": () => {
    editInputs().forEach((input, i) => (input.value = INITIAL[i] ?? input.value));
  },
  "bingo-save": act(saveCells),
};

// Este juego no usa formularios dentro de la página (el administrador edita en su propio diálogo).
export const onSubmit = async () => false;
export const onInput = async () => false;
export const onChange = async () => false;

// ---------- resumen para el álbum ----------

const plainLabel = (idx) => splitCell(textOf(idx)).label;

// Fotos del álbum: las del bingo (hasta 2 de la persona que ganó), las de los retos más raros y las más recientes.
function summaryPicks() {
  if (!marks.length) return [];
  const picks = new Map();
  const add = (m) => m && picks.size < 6 && picks.set(m.id, m);
  const w = winner();
  if (w) [...(byUser.get(w.user_id)?.values() ?? [])].sort((a, b) => ms(a.created_at) - ms(b.created_at)).slice(0, 2).forEach(add);
  const counts = [...byCell].map(([cell, list]) => [cell, list.length]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [cell] of counts.slice(0, 2)) add(byCell.get(cell)?.[0]);
  [...marks].sort((a, b) => ms(b.created_at) - ms(a.created_at)).forEach(add);
  return [...picks.values()];
}

// Datos para el álbum final. Es síncrono: usa lo último cargado; si hace tiempo que no se actualiza lo pide en segundo plano
// (y repinta solo si hay algo nuevo), así el álbum se completa aunque nunca se haya abierto el juego.
export function summary() {
  if (sb() && me() && !missing && !inflight && !active && Date.now() - lastLoad > STALE_MS) {
    lastLoad = Date.now();
    refresh();
  }
  if (!loaded || !marks.length) return null;
  const w = winner();
  const ranked = progress.filter((p) => p.marks > 0);
  const counts = Array.from({ length: TOTAL }, (_, i) => [i, byCell.get(i)?.length ?? 0]);
  const most = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const rare = counts.filter(([, n]) => n > 0).sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
  const untouched = counts.filter(([, n]) => n === 0).length;
  const players = new Set(marks.map((m) => m.user_id)).size;
  const lines = [
    w ? `¡Bingo! ${w.name} fue quien primero completó una línea (${when(w.first_line_at)}).` : "Nadie ha completado todavía una línea.",
    `Ranking: ${ranked.slice(0, 5).map((p, i) => `${i + 1}.º ${p.name} (${plural(p.lines, "línea", "líneas")}, ${plural(p.marks, "marca", "marcas")})`).join(" · ")}.`,
    `${plural(marks.length, "foto de prueba", "fotos de prueba")} de ${plural(players, "jugador", "jugadores")}.`,
  ];
  const full = ranked.filter((p) => p.marks >= TOTAL).map((p) => p.name);
  if (full.length) lines.push(`Cartón lleno: ${full.join(", ")}.`);
  const highlights = [];
  if (w) highlights.push({ label: "¡Bingo!", value: w.name });
  if (ranked[0]) highlights.push({ label: "Más líneas", value: `${ranked[0].name} (${ranked[0].lines})` });
  if (most && most[1] > 0) highlights.push({ label: "Reto más completado", value: `${plainLabel(most[0])} (${most[1]} de ${players})` });
  if (rare && rare[0] !== most?.[0]) highlights.push({ label: "Reto más raro", value: `${plainLabel(rare[0])} (${rare[1]} de ${players})` });
  if (untouched) highlights.push({ label: "Sin cumplir", value: plural(untouched, "reto", "retos") });
  const images = summaryPicks().map((m) => urlOf(m.thumb_path)).filter(Boolean);
  return { lines, highlights, images };
}
