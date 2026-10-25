// Avisos del viaje: alerta resaltada en pantalla (con sonido, vibración, título parpadeante e insignia del icono), campana con el
// panel «Novedades», Ajustes → Avisos y la tarjeta para activar los avisos con la web cerrada (Web Push, ver js/avisos-push.js).
//
// Los avisos nacen en la base de datos (supabase/avisos.sql): cada novedad se escribe en `push_outbox`, que la web recibe por Realtime
// (solo lo que le corresponde a cada persona: nunca lo suyo propio) y que el service worker recibe como notificación del sistema.
// Si el SQL aún no está ejecutado, nada de esto se muestra y el resto de la web funciona igual.
// Para otros módulos: ctx.actions.alert({ title, body, urgent = false, url = null, kind = "otro" }).
import { state, ctx, read, persist, viewOfHash, planTabOfHash } from "./state.js";
import { config } from "./config.js";
import { icon } from "./icons.js";
import { $, esc, ago, toast, guarded } from "./util.js";
import { openAccess } from "./accessdialog.js";
import * as push from "./avisos-push.js";

// ---------- categorías ----------
const CATS = [
  ["foto", "📷", "Fotos", "Cuando alguien sube fotos nuevas."],
  ["comentario", "💬", "Comentarios", "Comentarios y respuestas en actividades y fotos."],
  ["plan", "🗓️", "Planes", "Cuando alguien añade una actividad al plan."],
  ["gasto", "💸", "Gastos y compras", "Gastos y compras que apuntan los demás."],
  ["juego", "🎮", "Juegos", "Retos de la batalla de fotos y avances del bingo."],
  ["encuentro", "📍", "Punto de encuentro", "Cuando alguien fija un punto de encuentro o avisa de que llega."],
  ["bateria", "🔋", "Batería baja de la familia", "Cuando el móvil de alguien está a punto de quedarse sin batería."],
  ["chat", "🗨️", "Mensajes del chat", "Mensajes nuevos del chat de la familia."],
  ["acceso", "🔑", "Solicitudes de acceso", "Solo administradores: alguien pide entrar a la web.", true],
];
const KIND_EMOJI = { foto: "📷", comentario: "💬", plan: "🗓️", gasto: "💸", acceso: "🔑", juego: "🎮", encuentro: "📍", bateria: "🔋", chat: "🗨️", alerta: "🚨", prueba: "🔔", otro: "🔔" };
const EMOJI_RE = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u;
const splitTitle = (title, kind) => {
  const m = EMOJI_RE.exec(title || "");
  return m ? [m[1], String(title).slice(m[0].length)] : [KIND_EMOJI[kind] || "🔔", title || ""];
};

const PREFS_KEY = "viaje.avisos.prefs"; // copia local de push_prefs (la verdad está en la base de datos)
const SEEN_KEY = "viaje.avisos.visto"; // hasta cuándo se ha leído (por dispositivo)
const CTA_KEY = "viaje.avisos.cta"; // la tarjeta «Activar avisos» vuelve a salir cuando pasa esta hora
const ADM_KEY = "viaje.avisos.adm"; // idem para el aviso a los administradores
const AUTO_KEY = "viaje.avisos.autopedido"; // el permiso se pide solo una vez en el primer toque; después, solo con el botón
const DAY = 24 * 3600 * 1000;

let prefs = { kinds: {}, sound: true, mutedUntil: 0, ...read(PREFS_KEY, {}) };
// Las ALERTAS de la familia («ven aquí», «necesito ayuda») y la prueba ignoran los interruptores por categoría y el silencio.
const ALWAYS = new Set(["alerta", "prueba"]);
const kindOn = (kind) => ALWAYS.has(kind) || prefs.kinds?.[kind] !== false;
const muted = () => Number(prefs.mutedUntil) > Date.now();
// El chat tiene su propio contador: no se mezcla con la campana ni con «Novedades».
const inFeed = (i) => i.kind !== "chat" && kindOn(i.kind);
const chatOpen = () => location.hash === "#chat" || Boolean($("#chat-dialog")?.open);
const savePrefsLocal = () => persist(PREFS_KEY, prefs);

const sb = () => ctx.store?.sb;
const online = () => ctx.store?.mode === "supabase" && Boolean(ctx.store.user) && state.member;

// ---------- estado ----------
const S = {
  userId: null,
  available: false, // false si falta avisos.sql
  feed: [], // las últimas novedades (de la más nueva a la más vieja)
  seen: new Set(), // ids ya recibidos (evita duplicados entre Realtime y el service worker)
  subscribed: false,
  serverKey: null, // la clave pública VAPID (null = la función aún no está lista)
  pushReason: "", // por qué no se pudo suscribir (nokey, nosw…)
  admin: null, // lo que encontró adminSetup()
  busy: false,
  channel: null,
};
let lastSeen = Number(read(SEEN_KEY, 0)) || 0;
if (!lastSeen) {
  lastSeen = Date.now(); // primera vez en este dispositivo: lo anterior no cuenta como «sin leer»
  persist(SEEN_KEY, lastSeen);
}

// ---------- elementos que crea el propio módulo ----------
let bell, bellCount, stack, cta, panel, panelList, section;

function buildUi() {
  if (bell) return;
  bell = Object.assign(document.createElement("button"), { type: "button", id: "bell-btn", className: "icon-btn bell-btn", hidden: true });
  bell.setAttribute("aria-label", "Novedades");
  bell.title = "Novedades";
  bell.innerHTML = `${icon("bell", 21)}<span class="bell-count" id="bell-count" hidden>0</span>`;
  bellCount = bell.querySelector(".bell-count");
  const people = $("#people-btn");
  people.parentElement.insertBefore(bell, people);

  stack = Object.assign(document.createElement("div"), { id: "aviso-stack", className: "aviso-stack" });
  stack.setAttribute("popover", "manual");
  stack.dataset.shown = "0";
  stack.dataset.sound = "";
  stack.dataset.vibrate = "";
  document.body.append(stack);

  cta = Object.assign(document.createElement("div"), { id: "aviso-cta", className: "aviso-cta", hidden: true });
  $("#banner").after(cta); // en el flujo de la página, entre la cabecera y el contenido
  new ResizeObserver(syncCtaSpace).observe(cta);

  panel = document.createElement("dialog");
  panel.id = "avisos-dialog";
  panel.innerHTML = `<div class="dialog-head"><h2>Novedades</h2><button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon("x")}</button></div>
    <div class="avisos-tools"><button type="button" class="btn small" id="avisos-readall">${icon("check", 15)} Marcar todo como leído</button><button type="button" class="link-btn" id="avisos-settings">Ajustes de avisos</button></div>
    <ul class="avisos-list" id="avisos-list"></ul>`;
  document.body.append(panel);
  panelList = panel.querySelector("#avisos-list");

  const settings = $("#settings-dialog");
  section = Object.assign(document.createElement("section"), { id: "avisos-section" });
  section.innerHTML = `<h3>Avisos</h3><div id="avisos-body"></div>`;
  settings.querySelector(".dialog-head").after(section);
}

// ---------- sonido, vibración, título, insignia ----------
let audioCtx = null;
function audio() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    audioCtx = new AC();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}
// Los navegadores solo dejan sonar al audio después de un toque: en el primer toque de la persona se «desbloquea».
function unlockAudio() {
  const ac = audio();
  if (ac?.state === "suspended") ac.resume().catch(() => {});
  stack.dataset.audio = ac?.state ?? "none";
}

const CHIME = {
  normal: { wave: "sine", gain: 0.3, notes: [[660, 0, 0.14], [880, 0.17, 0.26]] },
  urgent: { wave: "triangle", gain: 0.6, notes: [[880, 0, 0.22], [660, 0.26, 0.22], [880, 0.52, 0.22], [660, 0.78, 0.22], [990, 1.04, 0.22], [660, 1.3, 0.22], [990, 1.56, 0.55]] },
};
function playChime(urgent, soft = false) {
  const ac = audio();
  stack.dataset.sound = urgent ? "urgent" : "normal";
  stack.dataset.soundCount = String((Number(stack.dataset.soundCount) || 0) + 1);
  if (!ac || ac.state !== "running") {
    stack.dataset.audio = ac?.state ?? "none";
    return false; // sin un toque previo o con el móvil en silencio por el sistema: no suena (no se puede ni se debe forzar)
  }
  const spec = CHIME[urgent ? "urgent" : "normal"];
  const t0 = ac.currentTime + 0.03;
  const master = ac.createGain();
  master.gain.value = soft ? spec.gain * 0.45 : spec.gain;
  master.connect(ac.destination);
  for (const [freq, at, dur] of spec.notes) {
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = spec.wave;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, t0 + at);
    env.gain.linearRampToValueAtTime(1, t0 + at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(env);
    env.connect(master);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.05);
  }
  return true;
}
function vibrate(urgent) {
  const pattern = urgent ? [300, 120, 300, 120, 600] : [180, 80, 180];
  stack.dataset.vibrate = pattern.join(",");
  // Chrome bloquea la vibración hasta que la persona ha tocado la página (y lo anota como error en la consola).
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* sin vibración */
  }
}

let blinkTimer = null;
const baseTitle = () => config.trip.name || document.title;
function syncTitleBlink() {
  const unread = unreadCount();
  const away = document.hidden || !document.hasFocus();
  if (unread > 0 && away) {
    if (blinkTimer) return;
    let on = false;
    const tick = () => {
      on = !on;
      document.title = on ? `🔔 (${unreadCount()}) Novedades` : baseTitle();
    };
    tick();
    blinkTimer = setInterval(tick, 1500);
  } else if (blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
    document.title = baseTitle();
  }
}

function setBadge(n) {
  try {
    if (n > 0) navigator.setAppBadge?.(n)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch {
    /* sin insignia en este navegador */
  }
}

// ---------- alerta resaltada ----------
const MAX_ALERTS = 3;
let alertSeq = 0;
// Con un diálogo modal abierto, todo lo que queda fuera de él no recibe toques: la capa de alertas se mete dentro del diálogo de arriba
// (y vuelve al cuerpo de la página cuando se cierra) para que se vea Y se pueda tocar.
const topDialog = () => [...document.querySelectorAll("dialog[open]")].at(-1) ?? null;
function raiseStack() {
  const host = topDialog() ?? document.body;
  if (stack.parentElement !== host) host.append(stack);
  stack.classList.toggle("no-popover", !stack.showPopover);
  stack.classList.toggle("is-empty", !stack.children.length);
  if (!stack.children.length) {
    if (stack.matches?.(":popover-open")) stack.hidePopover();
    return;
  }
  // popover: se pinta por encima de cualquier diálogo abierto (si el navegador lo admite)
  try {
    if (stack.showPopover) {
      if (stack.matches(":popover-open")) stack.hidePopover();
      stack.showPopover();
    }
  } catch {
    /* sin popover: la capa fija de CSS basta */
  }
}

function dismiss(el) {
  if (!el?.isConnected) return;
  clearTimeout(el._timer);
  clearInterval(el._ring);
  el.classList.add("is-leaving");
  setTimeout(() => {
    el.remove();
    stack.dataset.shown = String(stack.children.length);
    raiseStack();
  }, 200);
}

const dupes = new Map(); // clave -> cuándo se enseñó por última vez
function isDuplicate(key, seconds) {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of dupes) if (now - t > 600_000) dupes.delete(k);
  const last = dupes.get(key);
  if (last && now - last < seconds * 1000) return true;
  dupes.set(key, now);
  return false;
}

// Las alertas «sticky» (kind «alerta»): ocupan todo el ancho, en rojo intenso y pulsando, no se ocultan solas, el sonido se repite unos 10 s
// y la vibración es larga. No les afecta ni «Sonido en la app» ni el silencio: son para «ven aquí» o «necesito ayuda».
const STICKY_VIBRATION = [500, 150, 500, 150, 500, 150, 900];
function startSticky(el) {
  let n = 0;
  const burst = () => {
    playChime(true);
    try {
      if (!navigator.userActivation || navigator.userActivation.hasBeenActive) navigator.vibrate?.(STICKY_VIBRATION);
    } catch {
      /* sin vibración */
    }
    stack.dataset.vibrate = STICKY_VIBRATION.join(",");
    if (++n >= 4 || !el.isConnected) clearInterval(el._ring);
  };
  burst();
  el._ring = setInterval(burst, 2600); // 4 veces ≈ 10 s
}

// Muestra una alerta resaltada. Es lo que usan los demás módulos: ctx.actions.alert({ title, body, urgent, url, kind, dedupeKey, sticky, actions }).
//  · dedupeKey (+ dedupeSeconds, 300 por defecto): dos alertas con la misma clave en ese tiempo se enseñan UNA vez.
//  · sticky: ver arriba; sus botones son «Ver» (si hay url) y «Entendido». `actions` los sustituye: [{ label, url, onClick, primary, dismiss = true }].
export function showAlert({ title, body = "", urgent = false, url = null, kind = "otro", id = null, silent = false, dedupeKey = null, dedupeSeconds = 300, sticky = false, actions = null } = {}) {
  if (!title) return null;
  buildUi();
  if (isDuplicate(dedupeKey, dedupeSeconds)) return null;
  const loud = urgent || sticky;
  const key = id || dedupeKey || `a${++alertSeq}`;
  stack.querySelector(`[data-id="${CSS.escape(String(key))}"]`)?.remove();
  const [emoji, text] = splitTitle(title, kind);
  const el = document.createElement("div");
  el.className = `aviso-alert kind-${esc(kind)}${loud ? " is-urgent" : ""}${sticky ? " is-sticky" : ""}`;
  el.dataset.id = key;
  el.dataset.kind = kind;
  el.setAttribute("role", "alert");
  const head = `<span class="aviso-emoji" aria-hidden="true">${esc(emoji)}</span>
      <span class="aviso-text"><strong>${esc(text)}</strong>${body ? `<span>${esc(body)}</span>` : ""}</span>`;
  if (sticky) {
    const list = actions ?? [...(url ? [{ label: "Ver", url, primary: true }] : []), { label: "Entendido" }];
    el.innerHTML = `<div class="aviso-main">${head}</div><div class="aviso-actions">${list.map((a, i) => `<button type="button" class="aviso-btn${a.primary ? " primary" : ""}" data-i="${i}">${esc(a.label)}</button>`).join("")}</div>`;
    el.querySelector(".aviso-actions").addEventListener("click", (event) => {
      const a = list[Number(event.target.closest("[data-i]")?.dataset.i)];
      if (!a) return;
      a.onClick?.();
      if (a.url) goTo(a.url);
      if (a.dismiss !== false) dismiss(el);
    });
  } else {
    el.innerHTML = `<button type="button" class="aviso-main" aria-label="${esc(`${text}. ${body}`.trim())}. Tocar para ver">${head}
      <span class="aviso-go">${loud ? "¡Ver ya!" : "Ver"}</span></button>
    <button type="button" class="aviso-x" aria-label="Cerrar el aviso">${icon("x", 18)}</button>`;
    el.querySelector(".aviso-main").addEventListener("click", () => {
      dismiss(el);
      if (url) goTo(url);
    });
    el.querySelector(".aviso-x").addEventListener("click", () => dismiss(el));
  }
  stack.prepend(el);
  while (stack.children.length > MAX_ALERTS) {
    const last = [...stack.children].reverse().find((c) => !c.classList.contains("is-urgent")) ?? stack.lastElementChild;
    clearInterval(last._ring);
    last.remove();
  }
  stack.dataset.shown = String(stack.children.length);
  stack.dataset.last = `${kind}|${sticky ? "sticky" : loud ? "urgent" : "normal"}|${text}`;
  raiseStack();
  // Las normales se van solas a los 9 s; las urgentes y las «sticky» se quedan hasta que se toquen.
  if (!loud) el._timer = setTimeout(() => dismiss(el), 9000);
  if (sticky) startSticky(el);
  else {
    if (!silent && prefs.sound !== false) playChime(urgent);
    if (!silent) vibrate(urgent);
  }
  return el;
}

// ---------- ir al sitio del aviso ----------
// url: «#fotos», «#mapa», «#cuentas», «#juegos», «#plan?a=<id de actividad>», «#acceso» (administradores).
export function goTo(url) {
  if (!url || typeof url !== "string") return;
  const [base, query] = url.split("?");
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  if (base === "#acceso") {
    if (state.isAdmin) openAccess();
    return;
  }
  const view = viewOfHash(base);
  if (!view) return;
  const tab = planTabOfHash(base);
  if (state.view !== view || (view === "plan" && state.planTab !== tab)) location.hash = base;
  const activity = new URLSearchParams(query || "").get("a");
  if (activity) highlightActivity(activity);
}
function highlightActivity(id) {
  let tries = 0;
  const look = () => {
    const card = document.querySelector(`details[data-id="${CSS.escape(id)}"]`);
    if (card) {
      state.open.add(id);
      card.open = true;
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.add("aviso-flash");
      setTimeout(() => card.classList.remove("aviso-flash"), 3000);
    } else if (++tries < 12) setTimeout(look, 200);
  };
  setTimeout(look, 120);
}

// ---------- novedades (feed) ----------
const unreadItems = () => S.feed.filter((i) => inFeed(i) && Date.parse(i.created_at) > lastSeen);
const unreadCount = () => unreadItems().length;

function normalize(row) {
  return { id: row.id, kind: row.kind || "otro", title: row.title || "", body: row.body || "", url: row.url || null, urgent: Boolean(row.urgent), tag: row.tag || null, from: row.exclude_user || null, created_at: row.created_at || new Date().toISOString() };
}

function renderBell() {
  if (!bell) return;
  const show = S.available && online();
  bell.hidden = !show;
  const n = show ? unreadCount() : 0;
  bellCount.hidden = n === 0;
  bellCount.textContent = n > 99 ? "99+" : String(n);
  bell.setAttribute("aria-label", n ? `Novedades: ${n} sin leer` : "Novedades");
  bell.classList.toggle("has-unread", n > 0);
  setBadge(n);
  syncTitleBlink();
  if (panel?.open) renderPanel();
}

function renderPanel() {
  const items = S.feed.filter(inFeed).slice(0, 50);
  panel.querySelector("#avisos-readall").disabled = unreadCount() === 0;
  panelList.innerHTML = items.length
    ? items
        .map((i, n) => {
          const [emoji, text] = splitTitle(i.title, i.kind);
          const fresh = Date.parse(i.created_at) > lastSeen;
          return `<li><button type="button" class="aviso-item${fresh ? " is-new" : ""}${i.urgent ? " is-urgent" : ""}" data-i="${n}">
            <span class="aviso-emoji" aria-hidden="true">${esc(emoji)}</span>
            <span class="aviso-text"><strong>${esc(text)}</strong>${i.body ? `<span>${esc(i.body)}</span>` : ""}<small>${esc(ago(Date.parse(i.created_at)))}${fresh ? " · nuevo" : ""}</small></span></button></li>`;
        })
        .join("")
    : `<li class="avisos-empty">Todavía no hay novedades. Aquí verás las fotos, comentarios, planes y gastos que añadan los demás.</li>`;
  panelList._items = items;
}

function markAllRead() {
  lastSeen = Math.max(Date.now(), ...S.feed.map((i) => Date.parse(i.created_at) || 0));
  persist(SEEN_KEY, lastSeen);
  renderBell();
}

async function loadFeed() {
  if (!sb()) return;
  const { data, error } = await sb().from("push_outbox").select("id,kind,title,body,url,urgent,tag,exclude_user,created_at").order("created_at", { ascending: false }).limit(50);
  if (error) {
    S.available = !push.missing(error); // solo «la tabla no existe» apaga los avisos; un fallo pasajero (red…) no
    return;
  }
  S.available = true;
  const fresh = [];
  for (const row of data ?? []) {
    if (S.seen.has(row.id)) continue;
    S.seen.add(row.id);
    fresh.push(normalize(row));
  }
  if (fresh.length) {
    const first = !S.feed.length;
    S.feed = [...fresh, ...S.feed].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 50);
    // Lo que ocurrió mientras la web estaba dormida y es muy reciente también se enseña; lo antiguo solo cuenta como «sin leer».
    if (!first) for (const item of fresh.filter((i) => Date.now() - Date.parse(i.created_at) < 90_000).reverse()) announce(item);
  }
  renderBell();
}

function announce(item) {
  if (!kindOn(item.kind)) return;
  if (item.kind === "alerta") {
    // «Ven aquí / necesito ayuda»: siempre, a pantalla completa, sin ocultarse sola. Misma clave que usa el chat: la etiqueta («alerta-<mensaje>»).
    showAlert({ title: item.title, body: item.body, url: item.url, kind: "alerta", id: item.id, sticky: true, dedupeKey: item.tag || item.id });
    return;
  }
  if (muted() && item.kind !== "prueba") return;
  if (item.kind === "chat" && chatOpen()) {
    if (prefs.sound !== false && !isDuplicate(`chat-${item.from || item.id}`, 20)) playChime(false, true); // en el chat solo suena suave
    return;
  }
  showAlert({ title: item.title, body: item.body, urgent: item.urgent, url: item.url, kind: item.kind, id: item.id, dedupeKey: item.kind === "chat" ? `chat-${item.from || item.id}` : item.id, dedupeSeconds: item.kind === "chat" ? 20 : 300 });
}

// Una novedad nueva, por Realtime (fila de push_outbox) o por el service worker (mensaje «push»).
function receive(row) {
  if (!row?.id || S.seen.has(row.id)) return;
  S.seen.add(row.id);
  const item = normalize(row);
  S.feed = [item, ...S.feed].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 50);
  renderBell();
  announce(item);
}

function startRealtime() {
  stopRealtime();
  if (!sb() || !S.available) return;
  S.channel = sb()
    .channel("viaje-avisos")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "push_outbox" }, (payload) => receive(payload.new))
    .subscribe();
}
function stopRealtime() {
  if (S.channel && sb()) sb().removeChannel(S.channel);
  S.channel = null;
}

// ---------- preferencias (la verdad está en la base de datos) ----------
async function loadPrefs() {
  if (!sb()) return;
  const { data, error } = await sb().from("push_prefs").select("kinds,sound,muted_until").maybeSingle();
  if (error || !data) return; // sin fila = todo activado
  prefs = { kinds: data.kinds || {}, sound: data.sound !== false, mutedUntil: data.muted_until ? Date.parse(data.muted_until) : 0 };
  savePrefsLocal();
}
async function savePrefs() {
  savePrefsLocal();
  renderBell();
  if (!sb()) return;
  const { error } = await sb().rpc("set_push_prefs", { p_kinds: prefs.kinds, p_sound: prefs.sound !== false, p_muted_until: muted() ? new Date(prefs.mutedUntil).toISOString() : null });
  if (error && !push.missing(error)) toast("No se pudieron guardar tus ajustes de avisos: " + error.message);
}

// ---------- Ajustes → Avisos ----------
const hhmm = (ms) => new Date(ms).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
const steps = (list) => `<ol class="aviso-steps">${list.map((t) => `<li>${t}</li>`).join("")}</ol>`;
const IOS_STEPS = [
  `Toca el botón <strong>Compartir</strong> de Safari (el cuadrado con una flecha hacia arriba).`,
  `Elige <strong>«Añadir a pantalla de inicio»</strong>.`,
  `Abre la web desde el <strong>nuevo icono</strong> y vuelve aquí para activar los avisos.`,
];
const ADMIN_STEPS_TEXT = `Para que los avisos lleguen con la web cerrada (una sola vez):
1. En supabase.com abre tu proyecto → Edge Functions → «Deploy a new function» → «Via Editor».
2. Ponle de nombre: push
3. Pega el contenido del archivo code/supabase/functions/push/index.ts
4. Desactiva «Verify JWT» y pulsa Deploy.
5. Vuelve a la web → Ajustes → Avisos → «Comprobar de nuevo».
Guía completa: docs/DESPLIEGUE.md, apartado «Avisos en el móvil».`;

function pushState() {
  if (!push.supported()) return push.iosNeedsInstall() ? "ios" : "unsupported";
  if (push.permission() === "denied") return "denied";
  return S.subscribed && push.permission() === "granted" ? "on" : "off";
}

function renderSettings() {
  const body = $("#avisos-body");
  if (!body) return;
  if (ctx.store?.mode !== "supabase") {
    body.innerHTML = `<p class="hint">En el modo demo no hay avisos compartidos. Puedes ver cómo se ve y suena una alerta:</p>
      <div class="aviso-row"><button type="button" class="btn" data-av="demo">${icon("sparkle", 16)} Probar alerta</button><button type="button" class="btn" data-av="demo-urgent">Probar alerta urgente</button></div>`;
    return;
  }
  if (!online()) {
    body.innerHTML = `<p class="hint">Inicia sesión como viajero para activar los avisos.</p>`;
    return;
  }
  if (!S.available) {
    body.innerHTML = `<div class="notice">${icon("file", 18)}<p><strong>Falta una parte de la base de datos.</strong> Ejecuta <code>supabase/todo_en_uno.sql</code> en Supabase (SQL Editor) para activar los avisos. No hace daño repetirlo.</p></div>`;
    return;
  }
  const st = pushState();
  const label = { on: "Activados en este móvil", off: "No activados", denied: "Bloqueados: actívalos en los ajustes del navegador", ios: "No activados: hace falta instalar la web", unsupported: "Este navegador no admite avisos con la web cerrada" }[st];
  const dot = st === "on" ? "ok" : st === "off" || st === "ios" ? "warn" : "bad";
  let action = "";
  if (st === "ios") action = `<p class="hint"><strong>En iPhone</strong>, los avisos solo funcionan con la web instalada en la pantalla de inicio (iOS 16.4 o más):</p>${steps(IOS_STEPS)}`;
  else if (st === "denied") action = `<p class="hint">Dijiste «No permitir» al navegador. Para activarlos: abre los <strong>ajustes del navegador</strong> (el candado junto a la dirección, o los ajustes de la app instalada) → <strong>Notificaciones</strong> → <strong>Permitir</strong>, y vuelve aquí.</p>`;
  else if (st === "unsupported") action = `<p class="hint">Aun así verás las alertas en pantalla mientras tengas la web abierta. Prueba con Chrome, Edge, Firefox o Safari (iPhone: con la web instalada).</p>`;
  else if (st === "off") {
    action = `<button type="button" class="btn primary aviso-big" data-av="enable">${icon("sparkle", 18)} Activar avisos en este móvil</button>`;
    if (S.pushReason === "nokey") action += `<p class="hint">Todavía falta un paso de quien administra la web para recibir avisos con la web cerrada. Mientras tanto, verás las alertas en pantalla con la web abierta.</p>`;
  } else {
    action = `<div class="aviso-row"><button type="button" class="btn primary" data-av="test">${icon("sparkle", 16)} Enviar aviso de prueba</button><button type="button" class="btn" data-av="disable">Desactivar en este móvil</button></div>`;
  }
  const mutedNow = muted();
  const cats = CATS.filter((c) => !c[4] || state.isAdmin)
    .map(([k, emoji, text, desc]) => `<label class="switch"><input type="checkbox" data-kind="${k}" ${kindOn(k) ? "checked" : ""}><span><span aria-hidden="true">${emoji}</span> ${esc(text)}<small class="aviso-desc">${esc(desc)}</small></span></label>`)
    .join("");
  body.innerHTML = `
    <p class="aviso-status ${dot}"><span class="aviso-dot" aria-hidden="true"></span><strong>${esc(label)}</strong></p>
    ${action}
    ${st === "on" || st === "off" ? "" : `<div class="aviso-row"><button type="button" class="btn small" data-av="test">${icon("sparkle", 15)} Enviar aviso de prueba</button></div>`}
    <h4 class="aviso-sub">Qué quieres que te avise</h4>
    ${cats}
    <label class="switch"><input type="checkbox" id="av-sound" ${prefs.sound !== false ? "checked" : ""}><span><span aria-hidden="true">🔊</span> Sonido en la app<small class="aviso-desc">El tono de las alertas que salen en pantalla.</small></span></label>
    <p class="aviso-always"><span aria-hidden="true">🚨</span> <strong>Las alertas de la familia siempre suenan</strong>, aunque apagues categorías o silencies los avisos: son para «ven aquí» o «necesito ayuda».</p>
    <h4 class="aviso-sub">Silenciar</h4>
    ${mutedNow ? `<p class="hint">Silenciados hasta las ${esc(hhmm(prefs.mutedUntil))}. Sigues viendo las novedades en la campana.</p><button type="button" class="btn small" data-av="unmute">Quitar el silencio</button>` : `<div class="aviso-row"><button type="button" class="btn small" data-av="mute" data-h="1">1 hora</button><button type="button" class="btn small" data-av="mute" data-h="8">8 horas</button><button type="button" class="btn small" data-av="mute" data-h="tomorrow">Hasta mañana</button></div>`}
    <p class="hint">Los avisos suenan según el modo del móvil: si está en silencio o en «No molestar», llegarán sin sonido.</p>
    ${state.isAdmin ? adminCard() : ""}`;
}

const tick = (ok) => (ok ? "✅" : "❌");
function adminCard() {
  const a = S.admin;
  const wanted = push.functionUrl();
  const status = a?.status;
  const fnOk = a?.functionOk;
  let rows = "";
  if (a && a.sql === false) rows = `<li>${tick(false)} Falta ejecutar <code>todo_en_uno.sql</code> (avisos).</li>`;
  else if (a) {
    rows = `<li>${tick(true)} Base de datos preparada</li>
      <li>${tick(fnOk)} Función <code>push</code> ${fnOk ? "desplegada" : a.probe?.status === 401 || a.probe?.status === 403 ? "desplegada, pero con «Verify JWT» activado: desactívalo" : "sin desplegar"}</li>
      <li>${tick(status?.has_keys)} Claves de los avisos ${status?.has_keys ? "creadas" : "sin crear (se crean solas al desplegar la función)"}</li>
      <li>${tick(status?.function_url === wanted)} Dirección de la función ${status?.function_url === wanted ? "registrada" : "sin registrar"}</li>
      ${status ? `<li>📱 ${status.devices} ${status.devices === 1 ? "móvil" : "móviles"} con avisos (${status.people} de ${status.members} ${status.members === 1 ? "persona" : "personas"})</li>
      <li>📬 Últimas 24 h: ${status.sent_24h} enviados${status.errors_24h ? `, ${status.errors_24h} con errores` : ""}</li>` : ""}`;
  } else rows = `<li>Comprobando…</li>`;
  const lastErr = status?.recent?.find((r) => r.error)?.error;
  return `<div class="aviso-admin"><h4 class="aviso-sub">Para todos (administradores)</h4>
    <p class="hint">Para que los avisos lleguen a todos con la web cerrada hace falta desplegar una vez la función <code>push</code>.</p>
    <ul class="aviso-checks">${rows}</ul>
    ${lastErr ? `<p class="hint">Último error: ${esc(lastErr)}</p>` : ""}
    ${a && !fnOk && a.sql !== false ? `<div class="notice">${icon("file", 18)}<p><strong>Falta desplegar la función <code>push</code>:</strong> sigue <code>docs/DESPLIEGUE.md</code>, apartado «Avisos en el móvil».</p></div><button type="button" class="btn small" data-av="copy-steps">${icon("copy", 15)} Copiar los pasos</button>` : ""}
    <div class="aviso-row"><button type="button" class="btn primary" data-av="admin" ${S.busy ? "disabled" : ""}>${icon("sparkle", 16)} ${fnOk && status?.function_url === wanted ? "Comprobar de nuevo" : "Activar avisos para todos"}</button></div></div>`;
}

async function runAdmin({ quiet = true } = {}) {
  S.admin = await push.adminSetup(sb());
  S.serverKey = S.serverKey || (S.admin.probe?.ok ? S.admin.probe.publicKey : null);
  if (!quiet) {
    if (S.admin.functionOk && S.admin.status?.function_url === push.functionUrl()) toast("Listo: los avisos para todos están activados.");
    else if (S.admin.sql === false) toast("Falta ejecutar todo_en_uno.sql en Supabase.");
    else toast("Todavía falta desplegar la función push (mira los pasos en Ajustes → Avisos).", 7000);
  }
  renderSettings();
  renderCta();
}

async function afterEnable(r, { manual = true } = {}) {
  if (r.ok) {
    S.subscribed = true;
    S.pushReason = "";
    if (manual) {
      toast("¡Listo! Te avisaremos de lo que pase en el viaje.");
      sb()?.rpc("push_test")?.then?.(() => {}, () => {}); // un aviso de prueba para ver que funciona
    }
  } else {
    S.pushReason = r.reason;
    const msg = {
      denied: "Los avisos están bloqueados. Actívalos en los ajustes del navegador (Notificaciones → Permitir).",
      dismissed: "No se activaron los avisos. Puedes hacerlo cuando quieras desde Ajustes → Avisos.",
      nokey: "Falta un paso de quien administra la web para recibir avisos con la web cerrada. Verás las alertas en pantalla mientras tengas la web abierta.",
      nosw: "Este navegador no tiene la web instalada para avisos (hace falta abrirla con https o instalarla).",
      ios: "En iPhone hay que instalar primero la web en la pantalla de inicio.",
      unsupported: "Este navegador no admite avisos con la web cerrada.",
      nosql: "Falta ejecutar todo_en_uno.sql en Supabase.",
    }[r.reason];
    if (manual) toast(msg || `No se pudieron activar los avisos${r.message ? `: ${r.message}` : ""}`, 8000);
  }
  renderSettings();
  renderCta();
}

const settingsActions = {
  enable: async () => {
    if (S.busy) return;
    S.busy = true;
    try {
      await afterEnable(await push.enable(sb()));
    } finally {
      S.busy = false;
      renderSettings();
    }
  },
  disable: async () => {
    await push.disable(sb());
    S.subscribed = false;
    toast("Avisos desactivados en este móvil.");
    renderSettings();
    renderCta();
  },
  test: async () => {
    const { error } = await sb().rpc("push_test");
    if (error) throw new Error(/Espera unos segundos/.test(error.message) ? "Espera unos segundos antes de enviar otra prueba." : error.message);
    toast("Aviso de prueba enviado. Debería aparecer en unos segundos.");
  },
  mute: ({ h }) => {
    const until = new Date();
    if (h === "tomorrow") {
      until.setDate(until.getDate() + 1);
      until.setHours(8, 0, 0, 0);
    } else until.setTime(Date.now() + Number(h) * 3600_000);
    prefs.mutedUntil = until.getTime();
    savePrefs();
    renderSettings();
  },
  unmute: () => {
    prefs.mutedUntil = 0;
    savePrefs();
    renderSettings();
  },
  admin: () => runAdmin({ quiet: false }),
  "copy-steps": async () => {
    try {
      await navigator.clipboard.writeText(ADMIN_STEPS_TEXT);
      toast("Pasos copiados. Pégalos en un mensaje o en tus notas.");
    } catch {
      toast("No se pudo copiar. Los pasos están en docs/DESPLIEGUE.md.");
    }
  },
  demo: () => showAlert({ title: "📷 Ana subió fotos nuevas", body: "Toca para verlas", url: "#fotos", kind: "foto" }),
  "demo-urgent": () => showAlert({ title: "📍 Ana fija un punto de encuentro", body: "Parque · Toca para ver cómo llegar", url: "#mapa", kind: "encuentro", urgent: true }),
};

function bindSettings() {
  const body = $("#avisos-body");
  body.addEventListener(
    "click",
    guarded(async (event) => {
      const el = event.target.closest("[data-av]");
      if (!el) return;
      unlockAudio();
      await settingsActions[el.dataset.av]?.({ ...el.dataset });
    }),
  );
  body.addEventListener("change", (event) => {
    const input = event.target;
    if (input.dataset.kind) {
      prefs.kinds = { ...prefs.kinds, [input.dataset.kind]: input.checked };
      savePrefs();
    } else if (input.id === "av-sound") {
      prefs.sound = input.checked;
      savePrefs();
      if (input.checked) {
        unlockAudio();
        playChime(false);
      }
    }
  });
  // Al abrir Ajustes se repinta la sección (el diálogo es de dialogs.js; aquí solo se mira cuándo se abre).
  new MutationObserver(() => {
    if ($("#settings-dialog").open) {
      renderSettings();
      if (online() && state.isAdmin && !S.admin) runAdmin();
    }
  }).observe($("#settings-dialog"), { attributes: true, attributeFilter: ["open"] });
}

// ---------- la tarjeta «Activar avisos de la familia» ----------
const snoozed = (key) => Number(read(key, 0)) > Date.now();
const snooze = (key) => persist(key, Date.now() + DAY);
function wantsCta() {
  if (!online() || !S.available) return false;
  if (snoozed(CTA_KEY)) return false;
  if (push.iosNeedsInstall()) return true;
  if (!push.supported() || push.permission() === "denied" || S.subscribed) return false;
  return Boolean(S.serverKey); // sin la función lista no hay nada que activar (el administrador ya ve su aviso)
}
function wantsAdminNotice() {
  return online() && state.isAdmin && S.available && S.admin && S.admin.sql !== false && !S.admin.functionOk && !snoozed(ADM_KEY);
}
function syncCtaSpace() {
  const open = Boolean(cta) && !cta.hidden;
  document.body.classList.toggle("has-aviso-cta", open);
  document.documentElement.style.setProperty("--aviso-h", open ? `${Math.ceil(cta.getBoundingClientRect().height + 10)}px` : "0px");
  if (state.view === "map") window.dispatchEvent(new Event("resize")); // el mapa empieza ahora más abajo (o más arriba): que se redibuje
}
function renderCta() {
  if (!cta) return;
  const personal = wantsCta();
  const admin = wantsAdminNotice();
  cta.hidden = !(personal || admin);
  if (cta.hidden) return;
  const ios = push.iosNeedsInstall();
  cta.innerHTML = `${
    personal
      ? `<section class="aviso-card" aria-label="Activar avisos">
      <h2>🔔 Activar avisos de la familia</h2>
      ${ios ? `<p>En iPhone hay que instalar primero la web: <strong>Compartir → Añadir a pantalla de inicio</strong>, y abrirla desde el nuevo icono.</p>` : `<p>Entérate al instante de las fotos, planes y avisos del viaje, aunque tengas la web cerrada.</p>`}
      <div class="aviso-row">${ios ? `<button type="button" class="btn primary aviso-big" data-cta="steps">Ver los pasos</button>` : `<button type="button" class="btn primary aviso-big" data-cta="enable">Activar avisos</button>`}<button type="button" class="btn" data-cta="later">Más tarde</button></div>
    </section>`
      : ""
  }${
    admin
      ? `<section class="aviso-card is-admin" aria-label="Aviso para administradores">
      <h2>⚙️ Falta un paso: la función de avisos</h2>
      <p>Para que lleguen con la web cerrada hay que desplegar una vez la función <code>push</code> (docs/DESPLIEGUE.md, «Avisos en el móvil»).</p>
      <div class="aviso-row"><button type="button" class="btn primary aviso-big" data-cta="steps">Ver los pasos</button><button type="button" class="btn" data-cta="admin-later">Luego</button></div>
    </section>`
      : ""
  }`;
}

const ctaActions = {
  enable: async () => {
    unlockAudio();
    if (S.busy) return;
    S.busy = true;
    try {
      await afterEnable(await push.enable(sb()));
    } finally {
      S.busy = false;
    }
  },
  later: () => {
    snooze(CTA_KEY);
    renderCta();
  },
  steps: () => $("#settings-btn")?.click(), // Ajustes → Avisos tiene los pasos (y el botón de copiarlos)
  "admin-later": () => {
    snooze(ADM_KEY);
    renderCta();
  },
};

// En navegadores que lo permiten, el permiso se pide en el primer toque de la persona tras entrar (sin un gesto lo bloquean).
let armedFirstTap = false;
function armFirstTap() {
  if (armedFirstTap || read(AUTO_KEY, false)) return;
  if (!online() || !S.available || !S.serverKey || S.subscribed || !push.supported() || push.permission() !== "default") return;
  armedFirstTap = true;
  const onTap = (event) => {
    document.removeEventListener("click", onTap, true);
    armedFirstTap = false;
    if (event.target.closest?.("[data-cta], [data-av], .aviso-alert")) return; // ya van a pedirlo ellos
    if (push.permission() !== "default" || S.subscribed || !online()) return;
    persist(AUTO_KEY, true);
    ctaActions.enable().catch(() => {});
  };
  document.addEventListener("click", onTap, true);
}

// ---------- puesta en marcha ----------
async function start() {
  S.userId = ctx.store.user.id;
  await loadPrefs();
  await loadFeed();
  startRealtime();
  renderBell();
  // Avisos con la web cerrada: comprobar en silencio la suscripción del navegador.
  S.serverKey = await push.fetchKey(sb(), { probe: false }).catch(() => null);
  const r = await push.sync(sb()).catch(() => ({ subscribed: false }));
  S.subscribed = Boolean(r.subscribed);
  S.pushReason = r.reason && !r.subscribed ? r.reason : "";
  if (state.isAdmin) await runAdmin();
  else if (!S.serverKey) S.serverKey = await push.fetchKey(sb(), { probe: false }).catch(() => null);
  renderCta();
  renderSettings();
  armFirstTap();
}

function stop() {
  stopRealtime();
  S.userId = null;
  S.available = false;
  S.feed = [];
  S.seen = new Set();
  S.subscribed = false;
  S.serverKey = null;
  S.admin = null;
  setBadge(0);
  if (blinkTimer) syncTitleBlink();
  renderBell();
  renderCta();
}

let starting = null;
// La llama app.js tras cada carga de datos: arranca o para según haya sesión de viajero. Es barata si ya está en marcha.
export function syncAvisos() {
  if (!bell) return;
  if (!online()) {
    if (S.userId) stop();
    return;
  }
  if (S.userId === ctx.store.user.id) {
    renderBell();
    if (state.isAdmin && !S.admin && !starting) starting = runAdmin().finally(() => (starting = null));
    renderCta();
    return;
  }
  if (starting) return;
  starting = start()
    .catch((err) => console.warn("Avisos:", err?.message || err))
    .finally(() => (starting = null));
}

export function initAvisos() {
  buildUi();
  bindSettings();
  bell.addEventListener("click", () => {
    unlockAudio();
    renderPanel();
    panel.showModal();
  });
  panel.querySelector("[data-close]").addEventListener("click", () => panel.close());
  panel.querySelector("#avisos-readall").addEventListener("click", markAllRead);
  panel.querySelector("#avisos-settings").addEventListener("click", () => {
    panel.close();
    $("#settings-btn")?.click();
  });
  panelList.addEventListener("click", (event) => {
    const item = panelList._items?.[Number(event.target.closest("[data-i]")?.dataset.i)];
    if (!item) return;
    panel.close();
    goTo(item.url);
  });
  cta.addEventListener(
    "click",
    guarded(async (event) => {
      const el = event.target.closest("[data-cta]");
      if (el) await ctaActions[el.dataset.cta]?.();
    }),
  );
  // Si se abre o se cierra un diálogo con alertas a la vista, la capa de alertas cambia de sitio (ver topDialog).
  new MutationObserver(() => stack.children.length && raiseStack()).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
  document.addEventListener("close", () => stack.children.length && raiseStack(), true);
  // Primer toque: se desbloquea el sonido (los navegadores no dejan sonar antes).
  const unlock = () => unlockAudio();
  for (const type of ["pointerdown", "keydown", "touchend"]) document.addEventListener(type, unlock, { once: true, capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    syncTitleBlink();
    if (!document.hidden && S.userId) loadFeed().catch(() => {});
  });
  window.addEventListener("focus", syncTitleBlink);
  window.addEventListener("blur", syncTitleBlink);
  // Mensajes del service worker: un aviso con la web visible («push») o un toque en la notificación («navigate»).
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const m = event.data;
    if (m?.type === "push") receive({ id: m.id, kind: m.kind, title: m.title, body: m.body, url: m.url, urgent: m.urgent, tag: m.tag, created_at: m.ts ? new Date(m.ts).toISOString() : new Date().toISOString() });
    else if (m?.type === "navigate") goTo(m.url);
    else if (m?.type === "resubscribed" && online()) push.sync(sb()).then((r) => ((S.subscribed = Boolean(r.subscribed)), renderSettings())).catch(() => {});
  });
  // Un enlace con «?a=<actividad>» (se abre al tocar una notificación con la web cerrada).
  if (/^#plan\?a=/.test(location.hash)) {
    const hash = location.hash;
    history.replaceState(null, "", `${location.pathname}${location.search}#plan`);
    setTimeout(() => goTo(hash), 800);
  }
  renderSettings();
}
