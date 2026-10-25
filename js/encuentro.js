// «Punto de encuentro»: un viajero fija un punto en el mapa («nos vemos aquí»), a todos les sale un aviso fuerte y cada uno
// responde «voy llegando», «ya llegué» o «no puedo». Todos ven el pin en el mapa, quién viene y quién falta.
//
// Todo el estado vive en este módulo (no en state.js ni en store.js): así los archivos compartidos solo necesitan unas líneas
// (ver app.js: initEncuentro, syncEncuentro y encuentroActions; views.js: encuentroChip y encuentroButton; map.js: rawMap).
// Datos: tablas `meetups` y `meetup_replies` y las funciones `create_meetup`, `reply_meetup` y `close_meetup` de encuentro.sql.
// Nadie escribe en las tablas directamente; si faltan, el botón ni se ofrece. En modo demo funciona en local con un único usuario.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, esc, ago, toast, hasCoords, todayIso, utc, capitalize, fmtDayShort, formatKm } from "./util.js";
import { getName } from "./store.js";
import { currentPosition, reversePlace, distanceKm } from "./geo.js";
import { settings } from "./settings.js";
import { peopleRows } from "./people.js";
import { hueOf } from "./ledger.js";
import { requireName } from "./dialogs.js";

const POLL_ACTIVE_MS = 12_000; // mientras hay un punto activo se consulta con frecuencia (por si falla el tiempo real)
const POLL_IDLE_MS = 60_000;
const ALERTED_KEY = "viaje.encuentroAvisado"; // ids de puntos que ya sonaron en este móvil (para no repetir la alerta)
const DEMO_KEY = "viaje.encuentros";
const QUICK_NOTES = ["Junto a la entrada", "En el coche", "En el bar", "Aquí mismo"];
const ETAS = [5, 10, 15, 30];
const STATUS_TEXT = { voy: "🚶 Voy llegando", llegue: "✅ Ya llegué", no_puedo: "🙏 No puedo" };

// ---------- estado ----------

let data = { on: false, loaded: false, meetups: [], replies: [] }; // on = existen las tablas
let started = false;
let pollTimer = null;
let loading = null;
let channel = null;
let hooks = { chips: () => {} };
const dismissed = new Set(); // puntos cuyo banner se cerró con «Luego»
const autoOpened = new Set(); // puntos cuya tarjeta ya se abrió sola en el mapa
const framed = new Set(); // puntos que ya se encuadraron en el mapa
let seq = 0; // evita que una respuesta lenta de la dirección pise otra más reciente

const myId = () => ctx.store?.user?.id ?? null;
const isDemo = () => ctx.store?.mode === "demo";
const canUse = () => Boolean(ctx.store) && state.member !== false && (isDemo() || Boolean(ctx.store.user));
const isLive = (m) => Boolean(m) && m.status === "active" && Date.parse(m.expires_at) > Date.now();
export const activeMeetup = () => data.meetups.find(isLive) ?? null;
export const meetupsAvailable = () => canUse() && data.on;
const repliesOf = (m) => data.replies.filter((r) => r.meetup_id === m.id);
const myReply = (m) => repliesOf(m).find((r) => r.user_id === myId()) ?? null;
const iAmCreator = (m) => Boolean(m) && m.created_by != null && m.created_by === myId();
const canClose = (m) => iAmCreator(m) || state.isAdmin;
const key = (name) => String(name ?? "").trim().toLowerCase();

// ---------- acceso a los datos ----------

const missingError = (error) => ["42P01", "PGRST205"].includes(error?.code) || /does not exist|schema cache|could not find the table/i.test(error?.message || "");

// Consulta ligera: los últimos puntos y las respuestas del activo. Si falta la tabla (encuentro.sql sin ejecutar) devuelve `on: false`;
// un fallo pasajero (red, 500…) conserva lo último que se cargó.
async function sbLoad() {
  const sb = ctx.store.sb;
  const first = await sb.from("meetups").select("*").order("created_at", { ascending: false }).limit(10).then((r) => r, (error) => ({ error, data: null }));
  if (first.error) {
    if (missingError(first.error)) return { on: false, meetups: [], replies: [] };
    throw first.error;
  }
  const meetups = first.data ?? [];
  const live = meetups.find(isLive);
  let replies = [];
  if (live) {
    const second = await sb.from("meetup_replies").select("*").eq("meetup_id", live.id);
    if (second.error) throw second.error;
    replies = second.data ?? [];
  }
  return { on: true, meetups, replies };
}

// Modo demo: lo mismo con localStorage y un único usuario («local»), con las mismas reglas que la base de datos.
const demoRead = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(DEMO_KEY));
    return { meetups: raw?.meetups ?? [], replies: raw?.replies ?? [] };
  } catch {
    return { meetups: [], replies: [] };
  }
};
const demoWrite = (value) => {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(value));
  } catch {
    throw new Error("El navegador se ha quedado sin espacio para el modo demo.");
  }
};
const clean = (text, max) => String(text ?? "").replace(/[\s\u0000-\u001f]+/g, " ").trim().slice(0, max);

const api = {
  async create({ note, lat, lng, place }) {
    if (isDemo()) {
      const db = demoRead();
      for (const m of db.meetups) if (m.status === "active" && Date.parse(m.expires_at) <= Date.now()) Object.assign(m, { status: "closed", closed_at: m.expires_at });
      const other = db.meetups.find((m) => m.status === "active");
      if (other) throw new Error(`Ya hay un punto de encuentro activo: lo fijó ${other.created_by_name}. Quien lo fijó o un administrador puede cerrarlo para fijar otro`);
      const created = new Date();
      const row = { id: crypto.randomUUID(), created_by: "local", created_by_name: clean(getName(), 40) || "Viajero", title: "Punto de encuentro", note: clean(note, 200) || null, place: clean(place, 120) || null, lat, lng, status: "active", created_at: created.toISOString(), closed_at: null, expires_at: new Date(created.getTime() + 6 * 3600_000).toISOString() };
      db.meetups.unshift(row);
      demoWrite(db);
      return row.id;
    }
    const { data: id, error } = await ctx.store.sb.rpc("create_meetup", { p_title: null, p_note: note || null, p_lat: lat, p_lng: lng, p_place: place || null, p_name: getName() });
    if (error) throw error;
    return id;
  },
  async reply(meetupId, status, eta) {
    if (isDemo()) {
      const db = demoRead();
      const m = db.meetups.find((x) => x.id === meetupId);
      if (!m) throw new Error("Ese punto de encuentro no existe");
      if (m.status !== "active" || Date.parse(m.expires_at) <= Date.now()) throw new Error("Este punto de encuentro ya ha terminado");
      const row = { meetup_id: meetupId, user_id: "local", name: clean(getName(), 40) || "Viajero", status, eta_minutes: status === "voy" ? eta : null, updated_at: new Date().toISOString() };
      db.replies = db.replies.filter((r) => !(r.meetup_id === meetupId && r.user_id === "local")).concat(row);
      demoWrite(db);
      return;
    }
    const { error } = await ctx.store.sb.rpc("reply_meetup", { p_meetup: meetupId, p_status: status, p_eta: eta, p_name: getName() });
    if (error) throw error;
  },
  async close(meetupId) {
    if (isDemo()) {
      const db = demoRead();
      const m = db.meetups.find((x) => x.id === meetupId);
      if (!m || m.status === "closed") throw new Error("Este punto de encuentro ya estaba cerrado");
      Object.assign(m, { status: "closed", closed_at: new Date().toISOString() });
      demoWrite(db);
      return;
    }
    const { error } = await ctx.store.sb.rpc("close_meetup", { p_meetup: meetupId });
    if (error) throw error;
  },
};

// Los errores de la base de datos ya vienen en español; solo se explican los que no (falta el SQL, sin red).
function hint(err) {
  const message = err?.message || String(err);
  if (/could not find the function|schema cache|does not exist/i.test(message) && /meetup/i.test(message)) return new Error("Falta ejecutar supabase/todo_en_uno.sql en Supabase (punto de encuentro). No hace daño repetirlo.");
  if (err instanceof TypeError || /failed to fetch|network/i.test(message)) return new Error("No se pudo enviar. Revisa la conexión e inténtalo de nuevo.");
  return err instanceof Error ? err : new Error(message);
}

// ---------- carga, tiempo real y refresco ----------

const shapeKey = () => `${data.on}|${activeMeetup()?.id ?? ""}`;
const repliesKey = () => data.replies.map((r) => `${r.user_id}:${r.status}:${r.eta_minutes ?? ""}`).sort().join(",");

// Si ya hay una consulta en marcha, se pide otra al terminar (la que va a medias pudo empezar antes del cambio que se quiere ver).
let again = false;
export function loadMeetups() {
  if (loading) {
    again = true;
    return loading;
  }
  loading = (async () => {
    try {
      do {
        again = false;
        await loadOnce();
      } while (again);
    } finally {
      loading = null;
      schedule();
    }
  })();
  return loading;
}

async function loadOnce() {
  try {
    const next = isDemo() ? { on: true, ...demoRead() } : await sbLoad();
    const before = `${shapeKey()}|${data.loaded}`;
    const beforeReplies = repliesKey();
    data = { ...next, loaded: true };
    if (data.on) subscribe();
    if (`${shapeKey()}|${data.loaded}` !== before) {
      ctx.actions.render?.(); // aparece, cambia o se cierra el punto: se repinta todo (chip, botón de «Hoy», pin, banner)
      if (dlg?.open && ui.view === "card") renderDialog(); // y la tarjeta abierta (p. ej. «ya ha terminado»)
    } else if (repliesKey() !== beforeReplies) refreshReplies();
    maybeAlert();
  } catch (err) {
    console.warn("Punto de encuentro:", err?.message || err);
  }
}

// Las respuestas cambiaron: solo se repinta lo que las muestra (tarjeta abierta, banner y chip del mapa).
function refreshReplies() {
  if (dialog()?.open && ui.view === "card") renderDialog();
  renderBanner();
  hooks.chips();
}

function schedule() {
  clearTimeout(pollTimer);
  if (!started) return;
  const m = activeMeetup();
  let wait = m ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  if (m) wait = Math.min(wait, Math.max(500, Date.parse(m.expires_at) - Date.now() + 300)); // al caducar, se repinta justo entonces
  pollTimer = setTimeout(() => {
    if (document.hidden) return schedule();
    if (activeMeetup() === null && data.meetups.some((x) => x.status === "active")) ctx.actions.render?.(); // caducó: ya no cuenta como activo
    loadMeetups();
  }, wait);
}

function subscribe() {
  const sb = ctx.store?.sb;
  if (channel || !sb || isDemo()) return;
  // Canal propio: si las tablas faltan nunca se abre, y las actividades, comentarios y fotos no dependen de él.
  channel = sb.channel("viaje-encuentro");
  for (const table of ["meetups", "meetup_replies"]) channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, () => setTimeout(loadMeetups, 120));
  channel.subscribe();
}

function start() {
  started = true;
  loadMeetups();
}

function stop() {
  started = false;
  clearTimeout(pollTimer);
  if (channel) {
    ctx.store?.sb?.removeChannel(channel);
    channel = null;
  }
  data = { on: false, loaded: false, meetups: [], replies: [] };
  removePin();
  renderBanner();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && started) loadMeetups();
});

// ---------- alerta fuerte cuando aparece un punto nuevo ----------

const alertedIds = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(ALERTED_KEY)) || []);
  } catch {
    return new Set();
  }
};
const rememberAlerted = (id) => {
  const ids = [...alertedIds(), id].slice(-20);
  try {
    localStorage.setItem(ALERTED_KEY, JSON.stringify(ids));
  } catch {
    /* sin almacenamiento: puede repetirse la alerta al recargar */
  }
};

// Una sola alerta por punto aunque lleguen varios eventos (tiempo real, consulta periódica, recarga). No suena si lo fijé yo, si ya
// contesté (por ejemplo desde otro móvil) o si el punto tiene más de 10 minutos (entonces basta el banner).
function maybeAlert() {
  const m = activeMeetup();
  if (!m || !canUse() || iAmCreator(m) || (isDemo() && m.created_by === "local")) return;
  if (alertedIds().has(m.id)) return;
  rememberAlerted(m.id);
  if (myReply(m) || Date.now() - Date.parse(m.created_at) > 10 * 60_000) return;
  const who = m.created_by_name || "Alguien";
  const payload = {
    title: `📍 ¡${who} ha fijado un punto de encuentro!`,
    body: [m.place, m.note].filter(Boolean).join(" · ") || "Toca para ver cómo llegar",
    urgent: true,
    url: "#mapa",
    kind: "encuentro",
    tag: `encuentro-${m.id}`, // la misma etiqueta que lleva el aviso del servidor: quien reciba los dos puede unirlos
  };
  if (typeof ctx.actions.alert !== "function") return fallbackAlert(payload);
  // Con la parte `avisos` instalada, el servidor ya manda su propio aviso urgente del mismo punto (por la tabla push_outbox), que
  // llega casi a la vez. Se espera un momento y, si ya hay una alerta de «encuentro» en pantalla, no se pone otra (sonaría dos veces).
  setTimeout(() => {
    const now = activeMeetup();
    if (now?.id !== m.id || myReply(m) || document.querySelector('.aviso-alert[data-kind="encuentro"]')) return;
    ctx.actions.alert({ ...payload, id: payload.tag });
  }, 1500);
}

// Sin el módulo de avisos: vibración, un pitido si el navegador lo deja y el banner de arriba (que ya sale solo).
function fallbackAlert(payload) {
  navigator.vibrate?.([300, 120, 300, 120, 600]);
  try {
    const audio = new (window.AudioContext || window.webkitAudioContext)();
    const tone = (start, freq) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, audio.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + start + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + start);
      osc.stop(audio.currentTime + start + 0.4);
    };
    tone(0, 880);
    tone(0.45, 1175);
  } catch {
    /* el navegador no deja sonar sin un toque previo: queda la vibración y el banner */
  }
  toast(payload.title, 7000);
}

// ---------- utilidades de pantalla ----------

const walkingUrl = (lat, lng) =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=w` : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;

const rad = (deg) => (deg * Math.PI) / 180;
function compass(from, to) {
  const dLng = rad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) - Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180) / Math.PI; // grados desde el norte
  return ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"][Math.round(((deg + 360) % 360) / 45) % 8];
}

// Distancias cortas en metros (o pies): «0,0 km» no dice nada.
function nearText(km) {
  if (settings.distance === "mi") return km < 0.2 ? `${Math.round((km * 3280.84) / 10) * 10} ft` : formatKm(km);
  return km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : formatKm(km);
}

function distanceLine(m) {
  const me = state.me;
  if (!hasCoords(me)) return "";
  const km = distanceKm(me, m);
  if (km < 0.03) return `<p class="meet-dist is-here">${icon("check", 16)} Estás en el punto de encuentro</p>`;
  return `<p class="meet-dist">${icon("navigate", 16)} A ${esc(nearText(km))} en línea recta, hacia el ${compass(me, m)}</p>`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
const placeOf = (m) => m.place || m.title || "Punto de encuentro";

// ---------- botón del mapa, botón de «Hoy» ----------

// Primer botón de la fila de chips del mapa. Con un punto activo pasa a ser rojo y avisa de si falta contestar.
export function encuentroChip() {
  if (!meetupsAvailable()) return "";
  const m = activeMeetup();
  if (!m) return `<button type="button" class="chip-day meetup-chip" data-action="encuentro-open">📍 Punto de encuentro</button>`;
  const pending = !iAmCreator(m) && !myReply(m);
  return `<button type="button" class="chip-day meetup-chip is-live ${pending ? "needs" : ""}" data-action="encuentro-open"><span class="mc-t">📍 ${pending ? "¿Vienes? " : ""}Encuentro de ${esc(m.created_by_name)}</span></button>`;
}

export function encuentroButton() {
  if (!meetupsAvailable()) return "";
  const m = activeMeetup();
  return `<button type="button" class="btn small meetup-btn ${m ? "is-live" : ""}" data-action="encuentro-open">${m ? "📍 Encuentro activo" : "📍 Punto de encuentro"}</button>`;
}

// ---------- banner fijo arriba (todas las pestañas menos el mapa) ----------

let bannerEl = null;
function banner() {
  if (!bannerEl) {
    bannerEl = document.createElement("div");
    bannerEl.id = "meetup-banner";
    bannerEl.className = "meetup-banner";
    bannerEl.hidden = true;
    ($("#banner") ?? document.body.firstElementChild).after(bannerEl);
    bannerEl.addEventListener("click", onDialogAction);
  }
  return bannerEl;
}

function renderBanner() {
  const el = banner();
  const m = activeMeetup();
  // En el mapa no hace falta: allí están el pin, el botón rojo de arriba y la tarjeta, que se abre sola.
  const show = Boolean(m) && canUse() && !iAmCreator(m) && !myReply(m) && !dismissed.has(m.id) && !["map", "gate"].includes(document.body.dataset.view);
  if (!show) {
    el.hidden = true;
    el.innerHTML = "";
    delete el.dataset.sig;
    return;
  }
  const sig = `${m.id}|${Math.floor((Date.now() - Date.parse(m.created_at)) / 60_000)}`;
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = `<div class="mb-top"><span class="mb-ico" aria-hidden="true">📍</span>
      <div class="mb-text"><strong>${esc(m.created_by_name)} ha fijado un punto de encuentro</strong><small>${esc([m.place, ago(Date.parse(m.created_at))].filter(Boolean).join(" · "))}</small></div>
      <button type="button" class="mb-later" data-action="encuentro-later" data-id="${esc(m.id)}">Luego</button></div>
      <div class="mb-actions"><button type="button" class="mb-btn" data-action="encuentro-open" data-eta="1">🚶 Voy llegando</button><button type="button" class="mb-btn ghost" data-action="encuentro-open">Ver el punto</button></div>`;
  }
  el.hidden = false;
}

// ---------- pin en el mapa ----------

let pin = null; // { id, marker, el }
let touching = 0; // última vez que el dedo tocó el mapa (para no quitarle el control a quien lo mueve)

function removePin() {
  pin?.marker.remove();
  pin = null;
}

let tracked = null; // el mapa cuyos toques ya se vigilan
function trackTouches(map) {
  if (tracked === map) return;
  tracked = map;
  // Mientras alguien mueve el mapa con el dedo, no se le roba el control con el encuadre automático.
  const container = map.getContainer();
  const touch = () => (touching = Date.now());
  container.addEventListener("pointerdown", touch, { passive: true });
  container.addEventListener("pointermove", (e) => e.buttons && touch(), { passive: true });
  container.addEventListener("wheel", touch, { passive: true });
}

function syncPin() {
  const map = ctx.map?.rawMap?.();
  if (map) trackTouches(map);
  const m = canUse() ? activeMeetup() : null;
  if (!m) return removePin();
  const ML = window.maplibregl;
  if (!map || !ML) return;
  if (pin && pin.id !== m.id) removePin();
  if (!pin) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "meetup-pin";
    el.innerHTML = `<span class="mp-ring"></span><span class="mp-ring r2"></span><span class="mp-halo"></span><span class="mp-emoji" aria-hidden="true">📍</span><span class="mp-label"></span>`;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      openEncuentro();
    });
    pin = { id: m.id, el, marker: new ML.Marker({ element: el, anchor: "bottom" }).setLngLat([m.lng, m.lat]).addTo(map) };
    el.style.zIndex = "6";
  }
  pin.marker.setLngLat([m.lng, m.lat]);
  pin.el.querySelector(".mp-label").innerHTML = `<b>${esc(m.created_by_name)}</b>${m.place ? ` · ${esc(m.place)}` : ""}`;
  pin.el.setAttribute("aria-label", `Punto de encuentro de ${m.created_by_name}${m.place ? `: ${m.place}` : ""}. Toca para ver cómo llegar y contestar`);
  // La primera vez que se ve el mapa con este punto, se encuadra (sin interrumpir a quien lo está moviendo).
  if (state.view === "map" && !framed.has(m.id)) {
    framed.add(m.id);
    if (Date.now() - touching > 4000) ctx.map.flyTo(m.lat, m.lng, 16);
  }
}

// Si abres el mapa con un punto sin contestar, la tarjeta se abre sola una vez (sin pisar otro diálogo ni la elección de un punto).
function maybeOpenOnMap() {
  const m = activeMeetup();
  if (!m || state.view !== "map" || !canUse() || iAmCreator(m) || myReply(m) || dismissed.has(m.id) || autoOpened.has(m.id)) return;
  if (document.querySelector("dialog[open]") || $("#map")?.classList.contains("is-picking")) return;
  const idle = Date.now() - touching;
  if (idle < 4000) return void setTimeout(maybeOpenOnMap, 4100 - idle); // alguien mueve el mapa: la tarjeta espera a que suelte
  autoOpened.add(m.id);
  openEncuentro();
}

// ---------- gancho que app.js llama tras pintar cada vista ----------

export function syncEncuentro() {
  if (!ctx.store) return;
  const usable = canUse();
  if (usable && !started) start();
  else if (!usable && started) stop();
  if (!usable) return;
  renderBanner();
  syncPin();
  maybeOpenOnMap();
  if (dlg?.open && ui.view === "card") renderDialog(); // por si cambió algo que la tarjeta muestra (p. ej. ser administrador)
}

// ---------- diálogo: tarjeta y fijar un punto ----------

const ui = { view: "card", draft: { lat: null, lng: null, place: "", note: "", from: "" }, etaOpen: false, busy: false, err: "", locating: false, plan: [], askClose: false };
let dlg = null;
const dialog = () => dlg;

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "meetup-dialog";
  dlg.setAttribute("aria-labelledby", "meetup-title");
  dlg.addEventListener("click", onDialogAction);
  dlg.addEventListener("input", (event) => {
    const field = event.target.name;
    if (field === "place" || field === "note") {
      ui.draft[field] = event.target.value;
      if (field === "note") for (const b of dlg.querySelectorAll("[data-note]")) b.setAttribute("aria-pressed", String(b.dataset.note === ui.draft.note));
    }
  });
  dlg.addEventListener("close", () => {
    Object.assign(ui, { etaOpen: false, askClose: false, err: "", busy: false });
  });
  document.body.append(dlg);
  return dlg;
}

const head = (title) => `<div class="dialog-head"><h2 id="meetup-title">${title}</h2><button type="button" class="icon-btn" data-action="encuentro-close" aria-label="Cerrar">${icon("x")}</button></div>`;

function whereView() {
  return `${head("📍 Fijar punto de encuentro")}
    <p class="hint">Paso 1 de 2 · ¿Dónde es? Se avisará a todos los viajeros.</p>
    <div class="meet-choices">
      <button type="button" class="meet-choice" data-action="encuentro-here" ${ui.locating ? "disabled" : ""}><span aria-hidden="true">📍</span><span><strong>${ui.locating ? "Buscando tu ubicación…" : "Aquí donde estoy"}</strong><small>Usa la ubicación de tu móvil</small></span></button>
      <button type="button" class="meet-choice" data-action="encuentro-pick"><span aria-hidden="true">🗺️</span><span><strong>Elegir en el mapa</strong><small>Toca el sitio en el mapa</small></span></button>
      <button type="button" class="meet-choice" data-action="encuentro-plan"><span aria-hidden="true">🗓️</span><span><strong>Un sitio del plan</strong><small>Una actividad que ya tiene ubicación</small></span></button>
    </div>
    ${ui.err ? `<p class="meet-err" role="alert">${esc(ui.err)}</p>` : ""}
    <div class="dialog-actions"><button type="button" class="btn ghost" data-action="encuentro-close">Cancelar</button></div>`;
}

function planView() {
  const rows = ui.plan
    .map((a, i) => `<button type="button" class="meet-place" data-action="encuentro-plan-pick" data-i="${i}"><strong>${esc(a.title)}</strong><small>${esc(capitalize(fmtDayShort.format(utc(a.day))))}${a.start_time ? ` · ${esc(a.start_time.slice(0, 5))}` : ""}${a.place ? ` · ${esc(a.place)}` : ""}</small></button>`)
    .join("");
  return `${head("🗓️ Un sitio del plan")}
    ${rows ? `<div class="meet-places">${rows}</div>` : `<p class="empty">Ninguna actividad tiene ubicación todavía. Elige «Aquí donde estoy» o «Elegir en el mapa».</p>`}
    <div class="dialog-actions"><button type="button" class="btn" data-action="encuentro-back">Atrás</button></div>`;
}

function detailsView() {
  const d = ui.draft;
  return `${head("📍 Fijar punto de encuentro")}
    <p class="hint">Paso 2 de 2 · Añade un detalle si quieres (todo es opcional).</p>
    <div class="meet-chosen"><span aria-hidden="true">📍</span><span><strong>${esc(d.place || "Sitio elegido")}</strong><small>${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}${d.from ? ` · ${esc(d.from)}` : ""}</small></span><button type="button" class="link-btn" data-action="encuentro-back">Cambiar</button></div>
    <label>Nombre del sitio<input name="place" maxlength="120" autocomplete="off" placeholder="Parking norte" value="${esc(d.place)}"></label>
    <label>Una nota para los demás<input name="note" maxlength="200" autocomplete="off" placeholder="Junto a la entrada" value="${esc(d.note)}"></label>
    <div class="meet-quick" role="group" aria-label="Notas rápidas">${QUICK_NOTES.map((n) => `<button type="button" class="meet-chip" data-action="encuentro-note" data-note="${esc(n)}" aria-pressed="${n === d.note}">${esc(n)}</button>`).join("")}</div>
    ${ui.err ? `<p class="meet-err" role="alert">${esc(ui.err)}</p>` : ""}
    <div class="dialog-actions"><button type="button" class="btn ghost" data-action="encuentro-close">Cancelar</button><button type="button" class="btn primary meet-send" data-action="encuentro-review">Avisar a todos</button></div>`;
}

function confirmView() {
  const d = ui.draft;
  return `${head("¿Avisar a todos?")}
    <div class="notice meet-notice"><span aria-hidden="true">🔔</span><p>Esto <strong>hace sonar el móvil de todos los viajeros</strong> con un aviso fuerte. Úsalo cuando de verdad os tengáis que juntar.</p></div>
    <div class="meet-chosen"><span aria-hidden="true">📍</span><span><strong>${esc(clean(d.place, 120) || "Sitio elegido")}</strong><small>${esc(clean(d.note, 200) || "Sin nota")}</small></span></div>
    ${ui.err ? `<p class="meet-err" role="alert">${esc(ui.err)}</p>` : ""}
    <div class="dialog-actions"><button type="button" class="btn ghost" data-action="encuentro-edit" ${ui.busy ? "disabled" : ""}>Atrás</button><button type="button" class="btn primary meet-send" data-action="encuentro-send" ${ui.busy ? "disabled" : ""}>${ui.busy ? "Avisando…" : "Sí, avisar a todos"}</button></div>`;
}

const rowOf = (r, m) => {
  const when = ago(Date.parse(r.updated_at));
  const text = r.status === "llegue" ? "✅ Ya llegó" : r.status === "no_puedo" ? "🙏 No puede ir" : r.eta_minutes ? `🚶 Llega en ${r.eta_minutes} min` : "🚶 Va hacia allí";
  const me = r.user_id === myId();
  return `<li class="meet-row st-${r.status}"><span class="person-dot" style="--h:${hueOf(r.name)}" aria-hidden="true">${esc(r.name.charAt(0).toUpperCase())}</span><span class="meet-who"><strong>${esc(r.name)}${me ? ` <span class="you">tú</span>` : ""}${m.created_by === r.user_id ? ` <span class="you">lo fijó</span>` : ""}</strong><small>${esc(text)} · ${esc(when)}</small></span></li>`;
};

// Quién no ha contestado aún: viajeros que ya han entrado a la app (con cuenta), salvo quien fijó el punto.
function missingFor(m) {
  const done = new Set(repliesOf(m).map((r) => r.user_id));
  const doneNames = new Set(repliesOf(m).map((r) => key(r.name)));
  return peopleRows()
    .filter((p) => p.id && p.id !== m.created_by && !done.has(p.id) && !doneNames.has(key(p.name)) && key(p.name) !== key(m.created_by_name))
    .map((p) => (p.me ? "tú" : p.name));
}

function cardView() {
  const m = activeMeetup();
  if (!m) {
    return `${head("📍 Punto de encuentro")}
      <p class="empty">Este punto de encuentro ya ha terminado.</p>
      <div class="dialog-actions"><button type="button" class="btn primary" data-action="encuentro-new">Fijar otro punto</button></div>`;
  }
  const mine = myReply(m);
  const replies = repliesOf(m).sort((a, b) => ({ llegue: 0, voy: 1, no_puedo: 2 })[a.status] - ({ llegue: 0, voy: 1, no_puedo: 2 })[b.status] || (a.eta_minutes ?? 999) - (b.eta_minutes ?? 999) || a.name.localeCompare(b.name, "es"));
  const missing = missingFor(m);
  const counts = { llegue: 0, voy: 0, no_puedo: 0 };
  for (const r of replies) counts[r.status]++;
  const everyone = replies.length > 0 && counts.llegue > 0 && counts.voy === 0 && missing.length === 0;
  const mineText = mine ? `${STATUS_TEXT[mine.status]}${mine.status === "voy" && mine.eta_minutes ? ` · ${mine.eta_minutes} min` : ""}` : "Todavía no has contestado";
  const pressed = (st) => (mine?.status === st ? "true" : "false");
  const detail = [m.note].filter(Boolean);
  return `${head("📍 Punto de encuentro")}
    <div class="meet-by"><span class="person-dot lg" style="--h:${hueOf(m.created_by_name)}" aria-hidden="true">${esc(m.created_by_name.charAt(0).toUpperCase())}</span>
      <div><strong>${esc(m.created_by_name)}${iAmCreator(m) ? ` <span class="you">tú</span>` : ""}</strong> fijó este punto<small>${esc(ago(Date.parse(m.created_at)))} · se cierra solo a las ${esc(clock(m.expires_at))}</small></div></div>
    <div class="meet-where"><p class="meet-place-name">${icon("pin", 18)} ${esc(placeOf(m))}</p>${detail.map((t) => `<p class="meet-note">${esc(t)}</p>`).join("")}</div>
    ${distanceLine(m) || `<button type="button" class="link-btn meet-locate" data-action="encuentro-locate">${icon("locate", 15)} ¿A cuánto estoy?</button>`}
    <div class="meet-go"><a class="btn primary" href="${esc(walkingUrl(m.lat, m.lng))}" target="_blank" rel="noopener">${icon("navigate", 16)} Cómo llegar</a><button type="button" class="btn" data-action="encuentro-onmap">${icon("map", 16)} Ver en el mapa</button></div>
    <h3>Tu respuesta</h3>
    <p class="meet-mine${mine ? "" : " is-none"}" aria-live="polite">${esc(mineText)}</p>
    <div class="meet-answers" role="group" aria-label="Tu respuesta">
      <button type="button" class="meet-ans" data-action="encuentro-reply" data-st="voy" aria-pressed="${pressed("voy")}" aria-expanded="${ui.etaOpen}" ${ui.busy ? "disabled" : ""}><span aria-hidden="true">🚶</span>Voy llegando</button>
      <button type="button" class="meet-ans" data-action="encuentro-reply" data-st="llegue" aria-pressed="${pressed("llegue")}" ${ui.busy ? "disabled" : ""}><span aria-hidden="true">✅</span>Ya llegué</button>
      <button type="button" class="meet-ans" data-action="encuentro-reply" data-st="no_puedo" aria-pressed="${pressed("no_puedo")}" ${ui.busy ? "disabled" : ""}><span aria-hidden="true">🙏</span>No puedo</button>
    </div>
    ${ui.etaOpen ? `<div class="meet-eta" role="group" aria-label="¿En cuántos minutos llegas?"><p>¿En cuánto tiempo llegas?</p><div>${ETAS.map((n) => `<button type="button" class="meet-chip" data-action="encuentro-reply" data-st="voy" data-eta="${n}" aria-pressed="${mine?.status === "voy" && mine.eta_minutes === n}" ${ui.busy ? "disabled" : ""}>${n} min</button>`).join("")}</div></div>` : ""}
    ${ui.err ? `<p class="meet-err" role="alert">${esc(ui.err)}</p>` : ""}
    <h3>Quién viene</h3>
    <p class="meet-count">${counts.llegue} ${counts.llegue === 1 ? "ha llegado" : "han llegado"} · ${counts.voy} ${counts.voy === 1 ? "viene" : "vienen"} · ${counts.no_puedo} no ${counts.no_puedo === 1 ? "puede" : "pueden"}</p>
    ${replies.length ? `<ul class="meet-list">${replies.map((r) => rowOf(r, m)).join("")}</ul>` : `<p class="hint">Nadie ha contestado todavía.</p>`}
    ${missing.length ? `<p class="meet-missing">⏳ Faltan por contestar: <strong>${esc(missing.join(", "))}</strong></p>` : ""}
    ${everyone ? `<p class="meet-done" role="status">🎉 ¡Ya estáis todos! Si no hace falta más, puedes cerrar el punto de encuentro.</p>` : ""}
    ${ui.askClose ? `<div class="notice meet-notice"><span aria-hidden="true">✅</span><p>¿Cerrar el punto de encuentro? Se avisará a los demás de que ya no hace falta.</p></div>
      <div class="dialog-actions"><button type="button" class="btn ghost" data-action="encuentro-close-no">No, seguir</button><button type="button" class="btn danger" data-action="encuentro-close-yes" ${ui.busy ? "disabled" : ""}>Sí, cerrar</button></div>`
      : canClose(m) ? `<div class="dialog-actions"><button type="button" class="btn danger" data-action="encuentro-close-ask">Cerrar punto de encuentro</button></div>` : ""}`;
}

let lastHtml = "";
function renderDialog() {
  const d = ensureDialog();
  const html = { where: whereView, plan: planView, details: detailsView, confirm: confirmView }[ui.view]?.() ?? cardView();
  if (d.open && html === lastHtml) return; // sin cambios: no se toca el DOM (así no se pierde un toque en mitad de un repintado)
  const scroll = d.scrollTop;
  lastHtml = html;
  d.innerHTML = html;
  d.scrollTop = scroll;
}

function openDialog(view) {
  ui.view = view;
  const d = ensureDialog();
  if (!d.open) lastHtml = "";
  renderDialog();
  if (!d.open) d.showModal();
}

// Punto de entrada de los botones: con un punto activo abre su tarjeta; si no, empieza a fijar uno.
export function openEncuentro({ eta = false } = {}) {
  if (!meetupsAvailable()) return toast(isDemo() ? "No disponible." : "Falta ejecutar supabase/todo_en_uno.sql en Supabase (punto de encuentro). No hace daño repetirlo.");
  if (!requireName()) return;
  ui.err = "";
  const m = activeMeetup();
  if (m) {
    ui.etaOpen = eta && !myReply(m);
    ui.askClose = false;
    openDialog("card");
    if (!hasCoords(state.me)) autoLocate();
    return;
  }
  Object.assign(ui.draft, { lat: null, lng: null, place: "", note: "", from: "" });
  openDialog("where");
}

// Si el permiso de ubicación ya está concedido, la distancia aparece sola sin pedir nada.
async function autoLocate() {
  try {
    const perm = await navigator.permissions?.query({ name: "geolocation" });
    if (perm?.state !== "granted") return;
    const pos = await currentPosition();
    state.me = { lat: pos.lat, lng: pos.lng };
    if (dlg?.open && ui.view === "card") renderDialog();
  } catch {
    /* sin permiso o sin API: queda el botón «¿A cuánto estoy?» */
  }
}

// Nombre del sitio a partir de las coordenadas (Nominatim), sin bloquear: solo se rellena si la persona no ha escrito nada.
async function suggestPlace(lat, lng) {
  const mine = ++seq;
  try {
    const found = await Promise.race([reversePlace(lat, lng), new Promise((_, reject) => setTimeout(reject, 5000))]);
    if (mine !== seq || !found?.name || ui.draft.place || ui.view !== "details") return;
    ui.draft.place = found.name.slice(0, 120);
    const input = dlg?.querySelector("input[name=place]");
    if (input && !input.value) input.value = ui.draft.place;
    const label = dlg?.querySelector(".meet-chosen strong");
    if (label) label.textContent = ui.draft.place;
  } catch {
    /* sin nombre: se queda «Sitio elegido» y la persona puede escribirlo */
  }
}

function chosen(lat, lng, { place = "", from = "" } = {}) {
  Object.assign(ui.draft, { lat, lng, place, note: ui.draft.note || "", from });
  ui.err = "";
  openDialog("details");
  if (!place) suggestPlace(lat, lng);
}

// Ejecuta una acción del servidor con el diálogo ocupado y vuelve a pintar con los datos nuevos.
async function run(task) {
  ui.busy = true;
  ui.err = "";
  renderDialog();
  try {
    await task();
    return true;
  } catch (err) {
    const e = hint(err);
    ui.err = e.message;
    toast(e.message, 7000);
    return false;
  } finally {
    ui.busy = false;
    await loadMeetups();
    if (dlg?.open) renderDialog();
  }
}

// ---------- acciones (data-action="encuentro-…") ----------

export const encuentroActions = {
  "encuentro-open": (ds) => openEncuentro({ eta: ds?.eta === "1" }),
  "encuentro-close": () => dlg?.close(),
  "encuentro-later": ({ id }) => {
    dismissed.add(id);
    renderBanner();
  },
  "encuentro-new": () => {
    ui.err = "";
    Object.assign(ui.draft, { lat: null, lng: null, place: "", note: "", from: "" });
    openDialog("where");
  },
  "encuentro-back": () => {
    ui.err = "";
    openDialog("where");
  },
  "encuentro-edit": () => openDialog("details"),
  "encuentro-here": async () => {
    if (ui.locating) return;
    ui.locating = true;
    ui.err = "";
    renderDialog();
    try {
      const pos = await currentPosition();
      state.me = { lat: pos.lat, lng: pos.lng };
      ui.locating = false;
      chosen(pos.lat, pos.lng, { from: "tu ubicación" });
    } catch (err) {
      ui.locating = false;
      ui.err = `${err.message} También puedes elegir el sitio en el mapa.`;
      renderDialog();
    }
  },
  "encuentro-pick": async () => {
    dlg.close();
    const spot = await ctx.actions.pickOnMap("Toca el mapa para fijar el punto de encuentro");
    if (spot) chosen(spot.lat, spot.lng, { from: "elegido en el mapa" });
    else openDialog("where");
  },
  "encuentro-plan": () => {
    const today = todayIso();
    const located = state.activities.filter(hasCoords).sort((a, b) => a.day.localeCompare(b.day) || (a.start_time || "99:99").localeCompare(b.start_time || "99:99"));
    const upcoming = located.filter((a) => a.day >= today);
    ui.plan = (upcoming.length ? upcoming : located).slice(0, 40);
    openDialog("plan");
  },
  "encuentro-plan-pick": ({ i }) => {
    const a = ui.plan[Number(i)];
    if (a) chosen(a.lat, a.lng, { place: a.place || a.title, from: "del plan" });
  },
  "encuentro-note": ({ note }) => {
    ui.draft.note = ui.draft.note === note ? "" : note;
    const input = dlg.querySelector("input[name=note]");
    if (input) input.value = ui.draft.note;
    for (const b of dlg.querySelectorAll("[data-note]")) b.setAttribute("aria-pressed", String(b.dataset.note === ui.draft.note));
  },
  "encuentro-review": () => {
    ui.err = "";
    openDialog("confirm");
  },
  "encuentro-send": async () => {
    if (ui.busy) return;
    const d = ui.draft;
    let id = null;
    const ok = await run(async () => {
      id = await api.create({ note: clean(d.note, 200), lat: d.lat, lng: d.lng, place: clean(d.place, 120) });
    });
    if (ok) {
      if (id) {
        rememberAlerted(id); // el punto es mío: no debe sonar en mi propio móvil
      }
      toast("Aviso enviado: todos verán el punto de encuentro", 4000);
      ui.etaOpen = false;
      openDialog("card");
      if (state.view === "map") syncPin();
    } else if (/Ya hay un punto de encuentro activo/.test(ui.err) && activeMeetup()) {
      openDialog("card"); // otra persona se adelantó: se enseña el suyo
      ui.err = "";
    }
  },
  "encuentro-locate": async () => {
    try {
      const pos = await currentPosition();
      state.me = { lat: pos.lat, lng: pos.lng };
      renderDialog();
    } catch (err) {
      toast(err.message, 6000);
    }
  },
  "encuentro-onmap": () => {
    const m = activeMeetup();
    dlg?.close();
    if (!m) return;
    framed.add(m.id);
    ctx.actions.focusPerson(m.lat, m.lng); // lleva al mapa y centra el punto
  },
  "encuentro-reply": async ({ st, eta }) => {
    const m = activeMeetup();
    if (!m) return renderDialog();
    if (!requireName()) return;
    if (st === "voy" && !eta) {
      ui.etaOpen = !ui.etaOpen;
      return renderDialog();
    }
    navigator.vibrate?.(10);
    const ok = await run(() => api.reply(m.id, st, st === "voy" ? Number(eta) : null));
    if (ok) {
      ui.etaOpen = false;
      renderDialog();
      renderBanner();
      hooks.chips();
    }
  },
  "encuentro-close-ask": () => {
    ui.askClose = true;
    renderDialog();
  },
  "encuentro-close-no": () => {
    ui.askClose = false;
    renderDialog();
  },
  "encuentro-close-yes": async () => {
    const m = activeMeetup();
    if (!m) return;
    const ok = await run(() => api.close(m.id));
    if (ok) {
      ui.askClose = false;
      toast("Punto de encuentro cerrado", 3500);
      dlg.close();
    }
  },
};

// Los clics del diálogo y del banner (que app.js no escucha) van directos a las acciones.
async function onDialogAction(event) {
  if (event.target.closest("a[href]")) return; // «Cómo llegar» sigue su curso
  const el = event.target.closest("[data-action]");
  const handler = el && encuentroActions[el.dataset.action];
  if (!handler) return;
  try {
    await handler({ ...el.dataset });
  } catch (err) {
    console.error(err);
    toast(hint(err).message);
  }
}

// `chips`: función que repinta los chips del mapa (la pasa app.js).
export function initEncuentro(options = {}) {
  hooks = { ...hooks, ...options };
  banner();
  ensureDialog();
}
