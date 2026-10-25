// Chat de la familia con alertas (pestaña «Chat»). Mensajes de texto con foto o nota de voz opcionales, y un botón rojo «Alerta» que
// hace sonar el móvil de todos (o de las personas elegidas) y que cada destinatario confirma con «Entendido».
// Todo vive en su propio contenedor (#chat-view): la página no lo repinta, así que no se pierde lo escrito, el foco ni un audio que suena.
// Datos: tablas chat_messages y chat_acks (supabase/chat.sql); las alertas se crean con la función send_alert.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, esc, toast } from "./util.js";
import { getName } from "./store.js";
import { hueOf } from "./ledger.js";
import { prepareImage } from "./images.js";
import { pickFiles, canRecord, startRecording, cancelAllRecordings, clock } from "./media.js";
import { showPhoto } from "./dialogs.js";
import { reactionBarHtml, handleReactionClick } from "./reacciones.js";
import { emojiPanelHtml, insertAtCursor, rememberEmoji } from "./emojis.js";

const PAGE = 200; // mensajes que se cargan de golpe (y cada vez que se piden «anteriores»)
const SEEN_KEY = "viaje.chat.visto";
const ALERT_GAP_MS = 15_000; // la base de datos deja una alerta cada 15 s; aquí se evita el error con una cuenta atrás
const TEMPLATES = [
  ["📍", "Ven aquí"],
  ["🆘", "Necesito ayuda"],
  ["🚗", "Nos vamos ya"],
  ["🍽️", "Hora de comer"],
  ["🧭", "Me he perdido"],
  ["⏰", "Llego tarde"],
];

const S = {
  started: false,
  loading: false,
  failed: "", // texto del error de carga
  missing: false, // faltan las tablas (no se ha ejecutado todo_en_uno.sql)
  messages: [], // ordenados por fecha
  acks: new Map(), // id de alerta -> [{ user_id, name, at }]
  hasMore: false,
  channel: null,
  timer: null,
  visible: false, // la pestaña Chat está a la vista
  unseenBelow: 0,
  photo: null, // { file, url } elegida para enviar
  audio: null, // { blob, seconds, mime, url }
  recording: null,
  recSeconds: 0,
  sending: false,
  alertOpen: false,
  alertTo: new Set(), // vacío = todos
  alertUntil: 0, // hasta cuándo no se puede enviar otra (cuenta atrás)
  alertBusy: false,
  refreshing: null,
};

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

const me = () => ctx.store?.user?.id ?? null;
const sb = () => ctx.store?.sb;
const isMine = (m) => Boolean(m.user_id) && m.user_id === me();
const canChat = () => ctx.store?.mode === "supabase" && Boolean(ctx.store.user) && state.member !== false;
const root = () => $("#chat-view");
const q = (sel) => root()?.querySelector(sel);

// ---------- personas conocidas (para elegir a quién va una alerta y para poner nombre a los ids) ----------

function knownPeople() {
  const map = new Map();
  const add = (id, name) => id && name && !map.has(id) && map.set(id, String(name).trim());
  for (const p of state.presence ?? []) add(p.user_id, p.name);
  for (const l of state.live ?? []) add(l.user_id, l.name);
  for (const m of S.messages) add(m.user_id, m.name);
  for (const list of S.acks.values()) for (const a of list) add(a.user_id, a.name);
  return map;
}
const nameOf = (id) => knownPeople().get(id) ?? "Alguien";
const others = () => [...knownPeople()].filter(([id]) => id !== me()).sort((a, b) => a[1].localeCompare(b[1], "es"));

// ---------- formato ----------

const pad = (n) => String(n).padStart(2, "0");
const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayKey = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtDay = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" });
function dayLabel(iso) {
  const key = dayKey(iso);
  const now = new Date();
  if (key === dayKey(now.toISOString())) return "Hoy";
  if (key === dayKey(new Date(now.getTime() - 86_400_000).toISOString())) return "Ayer";
  const text = fmtDay.format(new Date(iso));
  return text.charAt(0).toUpperCase() + text.slice(1);
}
// Texto del usuario ya escapado, con los enlaces http(s) clicables.
const linkify = (html) =>
  html.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const clean = url.replace(/[.,;:!?)\]]+$/, "");
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${url.slice(clean.length)}`;
  });

// ---------- carga y tiempo real ----------

const isMissingTable = (error) => ["42P01", "PGRST205"].includes(error?.code) || /does not exist|schema cache|could not find the table/i.test(error?.message || "");

async function fetchMessages(before = null) {
  let query = sb().from("chat_messages").select("*").order("created_at", { ascending: false }).limit(PAGE);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

async function fetchAcks(ids) {
  if (!ids.length) return [];
  const { data, error } = await sb().from("chat_acks").select("*").in("message_id", ids);
  if (error) throw error;
  return data ?? [];
}

function mergeAcks(list) {
  for (const a of list) {
    const have = S.acks.get(a.message_id) ?? [];
    if (!have.some((x) => x.user_id === a.user_id)) S.acks.set(a.message_id, [...have, a]);
  }
}

// Los destinatarios llegan como lista; por si el canal en directo los manda como texto «{a,b}», se normalizan.
function normalize(m) {
  if (typeof m.to_users === "string") m.to_users = m.to_users.replace(/[{}"]/g, "").split(",").filter(Boolean);
  return m;
}

function insertMessage(m) {
  normalize(m);
  const have = S.messages.find((x) => x.id === m.id);
  if (have) {
    // El mensaje propio que se mostró al enviar: se queda con la hora real del servidor.
    if (have._pending !== undefined && m.created_at) Object.assign(have, { created_at: m.created_at });
    return false;
  }
  S.messages.push(m);
  S.messages.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return true;
}

async function load() {
  if (S.loading) return;
  S.loading = true;
  S.failed = "";
  paint();
  try {
    const rows = await fetchMessages();
    S.messages = rows.reverse();
    S.hasMore = rows.length === PAGE;
    mergeAcks(await fetchAcks(S.messages.filter((m) => m.kind === "alerta").map((m) => m.id)));
    S.missing = false;
    if (read(SEEN_KEY) == null) markSeen(); // la primera vez, lo que ya había cuenta como visto
  } catch (err) {
    if (isMissingTable(err)) S.missing = true;
    else S.failed = err.message || "No se pudo cargar el chat.";
  } finally {
    S.loading = false;
    paint();
    paintBadge();
  }
}

// Recoge lo que haya llegado desde el último mensaje (por si algún evento en directo se perdió).
async function catchUp() {
  if (S.refreshing || S.missing || S.loading) return;
  S.refreshing = (async () => {
    try {
      const last = S.messages.at(-1)?.created_at;
      let query = sb().from("chat_messages").select("*").order("created_at", { ascending: true }).limit(100);
      if (last) query = query.gt("created_at", last);
      const { data, error } = await query;
      if (error) throw error;
      for (const m of data ?? []) onMessage(m, { silent: false });
      const open = S.messages.filter((m) => m.kind === "alerta").slice(-20).map((m) => m.id);
      const before = [...S.acks.values()].reduce((n, l) => n + l.length, 0);
      mergeAcks(await fetchAcks(open));
      if ([...S.acks.values()].reduce((n, l) => n + l.length, 0) !== before) paintAlerts();
    } catch (err) {
      console.warn("Chat:", err.message || err);
    } finally {
      S.refreshing = null;
    }
  })();
  return S.refreshing;
}

function subscribe() {
  if (S.channel || !sb()) return;
  try {
    S.channel = sb()
      .channel("viaje-chat")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (e) => onMessage(e.new))
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_messages" }, (e) => onDeleted(e.old?.id))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_acks" }, (e) => onAck(e.new))
      .subscribe();
  } catch (err) {
    console.warn("Chat en directo:", err.message || err);
  }
  // Si el canal en directo falla, esto recoge lo que falte (más a menudo con el chat a la vista).
  S.timer = setInterval(() => !document.hidden && catchUp(), 20_000);
}

function unsubscribe() {
  clearInterval(S.timer);
  S.timer = null;
  try {
    if (S.channel) sb()?.removeChannel?.(S.channel);
  } catch {
    /* ya cerrado */
  }
  S.channel = null;
}

function onMessage(m, { silent = false } = {}) {
  if (!m?.id || !insertMessage(m)) return;
  ensureAttachments();
  const mine = isMine(m);
  if (S.visible && !document.hidden) {
    appendEl(m, mine);
    markSeen();
  } else if (!silent) {
    paintBadge();
  }
  if (!mine && m.kind === "alerta" && (!m.to_users || m.to_users.includes(me()))) receiveAlert(m);
}

function onDeleted(id) {
  if (!id) return;
  const i = S.messages.findIndex((m) => m.id === id);
  if (i < 0) return;
  S.messages.splice(i, 1);
  S.acks.delete(id);
  q(`[data-mid="${CSS.escape(id)}"]`)?.remove();
  tidyDays();
  paintBadge();
}

function onAck(a) {
  if (!a?.message_id) return;
  mergeAcks([a]);
  paintAlerts(a.message_id);
}

// ---------- alertas recibidas ----------

function receiveAlert(m) {
  const title = `🚨 ${m.name} manda una alerta`;
  const alert = ctx.actions.alert;
  if (typeof alert === "function") {
    alert({
      title,
      body: m.body,
      urgent: true,
      sticky: true,
      kind: "alerta",
      url: "#chat",
      id: `alerta-${m.id}`,
      dedupeKey: `alerta-${m.id}`, // la misma clave que usa el aviso del servidor: sale una sola vez
      actions: [
        { label: "Ver", url: "#chat", primary: true, onClick: () => ack(m.id, { quiet: true }) },
        { label: "Entendido", onClick: () => ack(m.id) },
      ],
    });
  } else {
    toast(`${title}: ${m.body}`, 12000);
    try {
      navigator.vibrate?.([500, 150, 500, 150, 900]);
    } catch {
      /* sin vibración */
    }
  }
}

async function ack(id, { quiet = false } = {}) {
  const have = S.acks.get(id) ?? [];
  if (have.some((a) => a.user_id === me())) return;
  try {
    const { error } = await sb().from("chat_acks").insert({ message_id: id, name: getName() || "Viajero" });
    if (error && error.code !== "23505") throw error;
    mergeAcks([{ message_id: id, user_id: me(), name: getName() || "Viajero", at: new Date().toISOString() }]);
    paintAlerts(id);
    // Si la alerta a pantalla completa sigue abierta (se confirmó desde el chat), se cierra: ya está atendida.
    document.querySelector(`.aviso-alert[data-id="${CSS.escape(`alerta-${id}`)}"] .aviso-btn:not(.primary)`)?.click();
  } catch (err) {
    if (!quiet) toast(err.message || "No se pudo confirmar la alerta.");
  }
}

// ---------- fotos y notas de voz de los mensajes ----------

// Las fotos y audios que llegan por el chat se cargan con el resto de datos del viaje; si aún no están, se pide un refresco.
let attachTimer = null;
function ensureAttachments() {
  const missing = S.messages.some((m) => (m.attached_photo && !state.photos.some((p) => p.id === m.attached_photo)) || (m.attached_audio && !(state.audios ?? []).some((a) => a.id === m.attached_audio)));
  if (!missing || attachTimer) return;
  attachTimer = setTimeout(async () => {
    attachTimer = null;
    try {
      await ctx.actions.refresh();
    } catch {
      /* se reintenta con el siguiente mensaje */
    }
    repaintAttachments();
  }, 1500);
}

// ---------- dibujo ----------

const avatar = (name) => `<span class="person-dot sm" style="--h:${hueOf(name)}" aria-hidden="true">${esc(String(name).charAt(0).toUpperCase())}</span>`;

function attachmentHtml(m) {
  const photo = m.attached_photo && state.photos.find((p) => p.id === m.attached_photo);
  const audio = m.attached_audio && (state.audios ?? []).find((a) => a.id === m.attached_audio);
  const photoUrl = photo?.thumb_url ?? m._photoUrl;
  let out = "";
  if (m.attached_photo) {
    out += photoUrl
      ? `<button type="button" class="chat-photo" data-chat="photo" data-id="${esc(m.attached_photo)}" aria-label="Ver la foto"><img src="${esc(photoUrl)}" alt="" loading="lazy" decoding="async"></button>`
      : `<span class="chat-wait">📷 Cargando la foto…</span>`;
  }
  if (m.attached_audio) {
    const url = audio?.audio_url ?? m._audioUrl;
    out += url
      ? `<div class="chat-audio"><span aria-hidden="true">🎤</span><audio controls preload="none" src="${esc(url)}"></audio><small>${esc(clock(audio?.seconds ?? m._seconds ?? 0))}</small></div>`
      : `<span class="chat-wait">🎤 Cargando el audio…</span>`;
  }
  return out;
}

function textHtml(m) {
  const mine = isMine(m);
  return `<div class="cmsg ${mine ? "mine" : ""} ${m._failed ? "is-failed" : ""} ${m._pending ? "is-pending" : ""}" data-mid="${esc(m.id)}">
    ${mine ? "" : avatar(m.name)}
    <div class="cbubble" data-chat="bubble">
      ${mine ? "" : `<strong class="cwho" style="--h:${hueOf(m.name)}">${esc(m.name)}</strong>`}
      ${attachmentHtml(m)}
      ${m.body ? `<p>${linkify(esc(m.body))}</p>` : ""}
      ${m._pending || m._failed ? "" : reactionBarHtml("chat", m.id)}
      <span class="cmeta">${m._failed ? `<button type="button" class="link-btn" data-chat="retry" data-id="${esc(m.id)}">No se envió · Reintentar</button>` : m._pending ? "Enviando…" : esc(timeOf(m.created_at))}
        ${mine && !m._pending && !m._failed ? `<button type="button" class="link-btn chat-del" data-chat="delete" data-id="${esc(m.id)}" aria-label="Borrar el mensaje">Borrar</button>` : ""}</span>
    </div>
  </div>`;
}

function alertHtml(m) {
  const mine = isMine(m);
  const acks = S.acks.get(m.id) ?? [];
  const mineAck = acks.some((a) => a.user_id === me());
  const to = m.to_users?.length ? m.to_users.map(nameOf).join(", ") : "todos";
  const seenBy = acks.filter((a) => a.user_id !== m.user_id).map((a) => a.name);
  const expected = m.to_users?.length ? m.to_users : [...knownPeople().keys()].filter((id) => id !== m.user_id);
  const missing = expected.filter((id) => !acks.some((a) => a.user_id === id)).map(nameOf);
  const status = seenBy.length ? `✓ Lo vieron: ${esc(seenBy.join(", "))}` : "Nadie la ha confirmado todavía";
  const pending = mine && missing.length ? `<span class="calert-missing">Faltan: ${esc(missing.join(", "))}</span>` : "";
  const action = !mine && !mineAck && (!m.to_users || m.to_users.includes(me())) ? `<button type="button" class="calert-ok" data-chat="ack" data-id="${esc(m.id)}">Entendido</button>` : !mine && mineAck ? `<span class="calert-you">✓ Lo viste</span>` : "";
  return `<div class="calert" data-mid="${esc(m.id)}" data-kind="alerta">
    <div class="calert-head"><span aria-hidden="true">🚨</span><strong>${mine ? "Tu alerta" : `Alerta de ${esc(m.name)}`}</strong><small>para ${esc(to)} · ${esc(timeOf(m.created_at))}</small></div>
    <p class="calert-body">${esc(m.body)}</p>
    <div class="calert-foot"><span class="calert-acks">${status}</span>${pending}${action}${mine ? `<button type="button" class="link-btn chat-del" data-chat="delete" data-id="${esc(m.id)}">Borrar</button>` : ""}</div>
  </div>`;
}

const messageHtml = (m) => (m.kind === "alerta" ? alertHtml(m) : textHtml(m));

function listHtml() {
  if (!S.messages.length) return `<div class="chat-empty"><span aria-hidden="true">👋</span><strong>Todavía no hay mensajes</strong><p>Escribe para saludar a la familia. Con el botón rojo «Alerta» puedes avisar a todos de golpe.</p></div>`;
  let day = "";
  let out = S.hasMore ? `<button type="button" class="chat-more" data-chat="more">Ver mensajes anteriores</button>` : "";
  for (const m of S.messages) {
    const key = dayKey(m.created_at);
    if (key !== day) {
      day = key;
      out += `<div class="chat-day" data-day="${esc(key)}"><span>${esc(dayLabel(m.created_at))}</span></div>`;
    }
    out += messageHtml(m);
  }
  return out;
}

const list = () => q("#chat-list");
const nearBottom = () => {
  const el = list();
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 90;
};
function toBottom() {
  const el = list();
  if (el) el.scrollTop = el.scrollHeight;
  S.unseenBelow = 0;
  paintPill();
}

// Un mensaje nuevo al final (sin repintar los demás: así no se corta un audio que suena).
function appendEl(m, mine) {
  const el = list();
  if (!el) return;
  if (el.querySelector(".chat-empty")) el.innerHTML = "";
  const stick = mine || nearBottom();
  const key = dayKey(m.created_at);
  const days = el.querySelectorAll(".chat-day");
  if (days.item(days.length - 1)?.dataset.day !== key) el.insertAdjacentHTML("beforeend", `<div class="chat-day" data-day="${esc(key)}"><span>${esc(dayLabel(m.created_at))}</span></div>`);
  el.querySelector(`[data-mid="${CSS.escape(m.id)}"]`)?.remove();
  el.insertAdjacentHTML("beforeend", messageHtml(m));
  if (stick) toBottom();
  else {
    S.unseenBelow++;
    paintPill();
  }
}

// Quita los rótulos de día que se hayan quedado sin mensajes.
function tidyDays() {
  const el = list();
  if (!el) return;
  for (const day of el.querySelectorAll(".chat-day")) {
    const next = day.nextElementSibling;
    if (!next || next.classList.contains("chat-day")) day.remove();
  }
  if (!S.messages.length) el.innerHTML = listHtml();
}

function paintAlerts(id = null) {
  const el = list();
  if (!el) return;
  for (const m of S.messages) {
    if (m.kind !== "alerta" || (id && m.id !== id)) continue;
    const node = el.querySelector(`[data-mid="${CSS.escape(m.id)}"]`);
    if (node) node.outerHTML = alertHtml(m);
  }
}

function repaintAttachments() {
  const el = list();
  if (!el) return;
  for (const m of S.messages) {
    if (!m.attached_photo && !m.attached_audio) continue;
    const node = el.querySelector(`[data-mid="${CSS.escape(m.id)}"]`);
    if (!node || (!node.querySelector(".chat-wait") && !m._photoUrl)) continue;
    const playing = [...node.querySelectorAll("audio")].some((a) => !a.paused);
    if (!playing) node.outerHTML = messageHtml(m);
  }
}

function paintPill() {
  const pill = q("#chat-new");
  if (!pill) return;
  pill.hidden = S.unseenBelow <= 0;
  pill.textContent = `↓ ${S.unseenBelow} ${S.unseenBelow === 1 ? "mensaje nuevo" : "mensajes nuevos"}`;
}

// ---------- insignia de no leídos ----------

const seenAt = () => Date.parse(read(SEEN_KEY) ?? "") || 0;
function markSeen() {
  write(SEEN_KEY, S.messages.at(-1)?.created_at ?? new Date().toISOString());
  paintBadge();
}
function unread() {
  const t = seenAt();
  return S.messages.filter((m) => !isMine(m) && Date.parse(m.created_at) > t && (m.kind === "texto" || !m.to_users || m.to_users.includes(me()))).length;
}
export const chatUnread = unread;
function paintBadge() {
  const tab = document.querySelector('.tab[data-view="chat"]');
  if (!tab) return;
  let badge = tab.querySelector(".tab-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    badge.hidden = true;
    tab.append(badge);
  }
  const n = S.visible ? 0 : unread();
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.classList.toggle("has-alert", S.messages.some((m) => m.kind === "alerta" && !isMine(m) && Date.parse(m.created_at) > seenAt()));
  tab.setAttribute("aria-label", n ? `Chat, ${n} sin leer` : "Chat");
}

// ---------- estructura de la pantalla ----------

function buildUi() {
  const el = root();
  if (!el || el.dataset.ready) return;
  el.dataset.ready = "1";
  el.innerHTML = `<div class="chat-shell">
    <div class="chat-status" id="chat-status" hidden></div>
    <div class="chat-list" id="chat-list" role="log" aria-live="polite" aria-label="Mensajes del chat"></div>
    <button type="button" class="chat-new" id="chat-new" hidden></button>
    <div class="chat-compose" id="chat-compose">
      <div class="chat-alert" id="chat-alert" hidden></div>
      <div class="chat-previews" id="chat-previews" hidden></div>
      <div class="chat-rec" id="chat-rec" hidden></div>
      <div class="chat-emoji" id="chat-emoji" hidden></div>
      <div class="chat-tools" id="chat-tools">
        <button type="button" class="chat-tool is-alert" data-chat="alert-open" aria-expanded="false"><span aria-hidden="true">🚨</span><span>Alerta</span></button>
        <button type="button" class="chat-tool" data-chat="camera">${icon("camera", 17)}<span>Foto</span></button>
        <button type="button" class="chat-tool" data-chat="gallery">${icon("images", 17)}<span>Galería</span></button>
        ${canRecord() ? `<button type="button" class="chat-tool" data-chat="mic"><span aria-hidden="true">🎤</span><span>Audio</span></button>` : ""}
        <button type="button" class="chat-tool" data-chat="emoji" aria-expanded="false" aria-label="Emojis"><span aria-hidden="true">😀</span></button>
      </div>
      <form class="chat-form" id="chat-form" autocomplete="off">
        <textarea id="chat-input" rows="1" maxlength="1000" placeholder="Escribe un mensaje…" enterkeyhint="send" aria-label="Mensaje"></textarea>
        <button type="submit" class="chat-send" aria-label="Enviar el mensaje">${icon("send", 20)}</button>
      </form>
    </div>
  </div>`;
  el.addEventListener("click", onClick);
  // Los botones del chat no le quitan el foco al texto (como en cualquier chat): si lo hicieran, al tocar «Enviar», una alerta rápida
  // o «Reintentar» con el teclado abierto, el teclado se cerraría, la pantalla se recolocaría y el toque caería en otro sitio.
  el.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });
  el.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.target.id === "chat-form") send();
  });
  const input = el.querySelector("#chat-input");
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
  list().addEventListener("scroll", () => {
    if (nearBottom()) {
      S.unseenBelow = 0;
      paintPill();
    }
  });
  fitViewport();
  window.visualViewport?.addEventListener("resize", fitViewport);
  window.visualViewport?.addEventListener("scroll", fitViewport);
}

// Con el teclado abierto el área visible se encoge: el chat se ajusta a ella para que escribir no deje el cuadro tapado.
function fitViewport() {
  const el = root();
  const vv = window.visualViewport;
  if (!el || !vv) return;
  const top = el.getBoundingClientRect().top - (vv.offsetTop || 0);
  el.style.setProperty("--chat-h", `${Math.max(240, Math.round(vv.height - Math.max(0, top)))}px`);
}

function autosize() {
  const input = q("#chat-input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

// Estado general: cargando, error, sin tablas, demo… y la lista.
function paint() {
  const el = root();
  if (!el) return;
  buildUi();
  const status = q("#chat-status");
  const compose = q("#chat-compose");
  const demo = ctx.store?.mode !== "supabase";
  let message = "";
  if (demo) message = "El chat necesita la versión conectada a Supabase. En el modo demo no hay con quién hablar.";
  else if (S.missing) message = "Falta un paso para activar el chat: ejecutar <b>todo_en_uno.sql</b> en Supabase (SQL Editor). No hace daño repetirlo.";
  else if (S.failed) message = `No se pudo cargar el chat. <button type="button" class="link-btn" data-chat="reload">Reintentar</button>`;
  status.hidden = !message;
  status.innerHTML = message;
  compose.hidden = Boolean(demo || S.missing);
  const box = list();
  if (S.loading && !S.messages.length) box.innerHTML = `<div class="chat-empty"><span aria-hidden="true">💬</span><strong>Cargando el chat…</strong></div>`;
  else if (demo || S.missing) box.innerHTML = "";
  else {
    const stick = nearBottom();
    box.innerHTML = listHtml();
    if (stick || S.visible) toBottom();
  }
  paintComposer();
}

function paintComposer() {
  const previews = q("#chat-previews");
  if (!previews) return;
  const items = [];
  if (S.photo) items.push(`<span class="pv"><img src="${esc(S.photo.url)}" alt="Foto para enviar"><button type="button" class="mini-x" data-chat="clear-photo" aria-label="Quitar la foto">✕</button></span>`);
  if (S.audio) items.push(`<span class="pv pv-audio"><audio controls src="${esc(S.audio.url)}"></audio><small>${esc(clock(S.audio.seconds))}</small><button type="button" class="mini-x" data-chat="clear-audio" aria-label="Quitar el audio">✕</button></span>`);
  previews.hidden = !items.length;
  previews.innerHTML = items.join("");
  const recording = Boolean(S.recording);
  const rec = q("#chat-rec");
  rec.hidden = !recording;
  rec.innerHTML = recording
    ? `<span class="rec-dot" aria-hidden="true"></span><strong>Grabando <span id="chat-rec-t">${esc(clock(S.recSeconds))}</span></strong><button type="button" class="btn small primary" data-chat="rec-stop">Parar</button><button type="button" class="btn small ghost" data-chat="rec-cancel">Cancelar</button>`
    : "";
  q("#chat-tools").hidden = recording;
  q("#chat-form").hidden = recording;
  q("#chat-send")?.toggleAttribute("disabled", S.sending);
  paintAlertPanel();
}

// ---------- el panel de «Alerta» ----------

function paintAlertPanel() {
  const panel = q("#chat-alert");
  const toggle = q('[data-chat="alert-open"]');
  if (!panel) return;
  toggle?.setAttribute("aria-expanded", String(S.alertOpen));
  panel.hidden = !S.alertOpen || Boolean(S.recording);
  if (panel.hidden) return;
  const people = others();
  const prev = panel.querySelector("#chat-alert-text")?.value ?? "";
  const keep = panel.querySelector("#chat-alert-text") === document.activeElement;
  const picked = S.alertTo.size;
  const wait = Math.max(0, Math.ceil((S.alertUntil - Date.now()) / 1000));
  const target = picked ? `${picked} ${picked === 1 ? "persona" : "personas"}` : people.length ? `todos (${people.length})` : "todos";
  panel.innerHTML = `<div class="chat-alert-head"><strong>🚨 Enviar una alerta</strong><small>Hace sonar el móvil de quien la reciba, aunque lo tenga en silencio de avisos.</small></div>
    <div class="chat-templates" role="group" aria-label="Alertas rápidas">${TEMPLATES.map(([e, t]) => `<button type="button" class="chip-btn" data-chat="template" data-text="${esc(t)}"><span aria-hidden="true">${e}</span> ${esc(t)}</button>`).join("")}</div>
    <input id="chat-alert-text" maxlength="200" placeholder="Escribe la alerta…" value="${esc(prev)}" aria-label="Mensaje de la alerta" autocomplete="off">
    <div class="chat-to" role="group" aria-label="A quién se envía"><span class="chat-to-label">Para:</span>
      <button type="button" class="chip-btn ${picked ? "" : "is-on"}" data-chat="to-all" aria-pressed="${!picked}">Todos</button>
      ${people.map(([id, name]) => `<button type="button" class="chip-btn ${S.alertTo.has(id) ? "is-on" : ""}" data-chat="to" data-id="${esc(id)}" aria-pressed="${S.alertTo.has(id)}">${esc(name)}</button>`).join("")}</div>
    <div class="chat-alert-actions"><button type="button" class="btn ghost" data-chat="alert-close">Cancelar</button>
      <button type="button" class="btn danger-solid" data-chat="alert-send" ${S.alertBusy || wait ? "disabled" : ""}>${S.alertBusy ? "Enviando…" : wait ? `Espera ${wait} s` : `🚨 Enviar a ${esc(target)}`}</button></div>`;
  if (keep) {
    const input = panel.querySelector("#chat-alert-text");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

let alertTick = null;
function tickAlert() {
  clearInterval(alertTick);
  alertTick = setInterval(() => {
    paintAlertPanel();
    if (Date.now() >= S.alertUntil) clearInterval(alertTick);
  }, 1000);
}

async function sendAlert() {
  const text = (q("#chat-alert-text")?.value ?? "").trim();
  if (!text) return toast("Escribe el mensaje de la alerta.");
  const ids = [...S.alertTo];
  const count = ids.length || others().length;
  const who = ids.length ? ids.map(nameOf).join(", ") : "todos";
  if (!confirm(`¿Enviar la alerta «${text}» a ${who}?${count ? `\n\nSonará en ${count} ${count === 1 ? "móvil" : "móviles"}.` : ""}`)) return;
  S.alertBusy = true;
  paintAlertPanel();
  try {
    const { data, error } = await sb().rpc("send_alert", { p_body: text, p_to: ids.length ? ids : null, p_name: getName() || null });
    if (error) throw error;
    S.alertOpen = false;
    S.alertTo.clear();
    S.alertUntil = Date.now() + ALERT_GAP_MS;
    const { data: row } = await sb().from("chat_messages").select("*").eq("id", data).maybeSingle();
    if (row) onMessage(row, { silent: true });
    toast("🚨 Alerta enviada.");
  } catch (err) {
    toast(isMissingTable(err) || /send_alert/i.test(err.message || "") ? "Falta ejecutar todo_en_uno.sql en Supabase para enviar alertas." : err.message || "No se pudo enviar la alerta.");
    if (/Espera unos segundos/.test(err.message || "")) {
      S.alertUntil = Date.now() + ALERT_GAP_MS;
      tickAlert();
    }
  } finally {
    S.alertBusy = false;
    paintAlertPanel();
    if (S.alertUntil > Date.now()) tickAlert();
  }
}

// ---------- enviar mensajes ----------

async function send(retry = null) {
  if (S.sending && !retry) return;
  const input = q("#chat-input");
  const body = retry ? retry.body : (input.value ?? "").trim();
  if (!retry && !body && !S.photo && !S.audio) return;
  if (!getName()) return toast("Pon tu nombre en tu perfil para escribir en el chat.");
  const id = retry?.id ?? crypto.randomUUID();
  const draft = retry ? retry._draft ?? null : { photo: S.photo, audio: S.audio };
  const m = retry ?? { id, user_id: me(), name: getName(), kind: "texto", body, to_users: null, attached_photo: null, attached_audio: null, created_at: new Date().toISOString() };
  if (!retry) {
    if (draft.photo) m._photoUrl = draft.photo.url;
    if (draft.audio) Object.assign(m, { _audioUrl: draft.audio.url, _seconds: draft.audio.seconds });
    S.photo = null;
    S.audio = null;
    input.value = "";
    autosize();
    S.messages.push(m);
  }
  m._pending = true;
  m._failed = false;
  S.sending = true;
  paintComposer();
  appendEl(m, true);
  try {
    // Primero los adjuntos (foto o audio), luego el mensaje que los lleva.
    if (draft?.photo && !m.attached_photo) m.attached_photo = await ctx.store.addPhoto({ ...(await prepareImage(draft.photo.file)) });
    if (draft?.audio && !m.attached_audio) m.attached_audio = await ctx.store.addAudio({ blob: draft.audio.blob, seconds: draft.audio.seconds, mime: draft.audio.mime });
    const row = { id: m.id, name: m.name, body: m.body, ...(m.attached_photo && { attached_photo: m.attached_photo }), ...(m.attached_audio && { attached_audio: m.attached_audio }) };
    const { error } = await sb().from("chat_messages").insert(row);
    if (error && error.code !== "23505") throw error;
    m._pending = false;
    S.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    markSeen();
    if (m.attached_photo || m.attached_audio) ctx.actions.refresh?.(); // para que la foto o el audio enviados salgan con su dirección firmada
  } catch (err) {
    console.warn("Chat:", err.message || err);
    m._pending = false;
    m._failed = true;
    m._draft = draft;
    toast(isMissingTable(err) ? "Falta ejecutar todo_en_uno.sql en Supabase para usar el chat." : "No se pudo enviar. Toca «Reintentar» en el mensaje.");
  } finally {
    S.sending = false;
    const node = q(`[data-mid="${CSS.escape(m.id)}"]`);
    if (node) node.outerHTML = messageHtml(m);
    paintComposer();
  }
}

async function deleteMessage(id) {
  const m = S.messages.find((x) => x.id === id);
  if (!m) return;
  if (!confirm(m.kind === "alerta" ? "¿Borrar esta alerta?" : "¿Borrar este mensaje?")) return;
  try {
    const { error } = await sb().from("chat_messages").delete().eq("id", id);
    if (error) throw error;
    onDeleted(id);
  } catch (err) {
    toast(err.message || "No se pudo borrar.");
  }
}

// ---------- foto y audio ----------

async function choosePhoto(camera) {
  const [file] = await pickFiles({ camera });
  if (!file) return;
  if (S.photo) URL.revokeObjectURL(S.photo.url);
  S.photo = { file, url: URL.createObjectURL(file) };
  paintComposer();
}

async function startMic() {
  if (S.recording) return;
  S.audio && URL.revokeObjectURL(S.audio.url);
  S.audio = null;
  S.recSeconds = 0;
  try {
    S.recording = await startRecording({
      onTick: (s) => {
        S.recSeconds = s;
        const t = q("#chat-rec-t");
        if (t) t.textContent = clock(s);
      },
      onCancel: () => {
        S.recording = null;
        paintComposer();
      },
    });
  } catch (err) {
    toast(err.message || "No se pudo grabar.");
  }
  paintComposer();
}

async function stopMic(cancel) {
  const handle = S.recording;
  if (!handle) return;
  const recorded = cancel ? await handle.cancel() : await handle.stop();
  S.recording = null;
  if (recorded) S.audio = { ...recorded, url: URL.createObjectURL(recorded.blob) };
  paintComposer();
}

// ---------- eventos ----------

async function onClick(event) {
  if (handleReactionClick(event)) return; // «me gusta» y reacciones de los mensajes
  const picked = event.target.closest("[data-emoji-pick]");
  if (picked && picked.closest("#chat-emoji")) {
    const input = q("#chat-input");
    insertAtCursor(input, picked.dataset.emojiPick);
    rememberEmoji(picked.dataset.emojiPick);
    autosize();
    input.focus();
    return;
  }
  const target = event.target.closest("[data-chat]");
  if (!target) return;
  const { chat, id, text } = { ...target.dataset };
  switch (chat) {
    case "camera":
      return choosePhoto(true);
    case "gallery":
      return choosePhoto(false);
    case "clear-photo":
      S.photo && URL.revokeObjectURL(S.photo.url);
      S.photo = null;
      return paintComposer();
    case "clear-audio":
      S.audio && URL.revokeObjectURL(S.audio.url);
      S.audio = null;
      return paintComposer();
    case "mic":
      return startMic();
    case "emoji": {
      const panel = q("#chat-emoji");
      const open = panel.hidden;
      panel.hidden = !open;
      panel.innerHTML = open ? emojiPanelHtml() : "";
      target.setAttribute("aria-expanded", String(open));
      return;
    }
    case "rec-stop":
      return stopMic(false);
    case "rec-cancel":
      return stopMic(true);
    case "photo":
      return showPhoto(id);
    case "alert-open":
      S.alertOpen = !S.alertOpen;
      paintAlertPanel();
      if (S.alertOpen) {
        if (S.alertUntil > Date.now()) tickAlert();
        q("#chat-alert-text")?.focus();
      }
      return;
    case "alert-close":
      S.alertOpen = false;
      return paintAlertPanel();
    case "template": {
      const input = q("#chat-alert-text");
      input.value = text;
      input.focus();
      return;
    }
    case "to-all":
      S.alertTo.clear();
      return paintAlertPanel();
    case "to":
      if (S.alertTo.has(id)) S.alertTo.delete(id);
      else S.alertTo.add(id);
      return paintAlertPanel();
    case "alert-send":
      return sendAlert();
    case "ack":
      return ack(id);
    case "delete":
      return deleteMessage(id);
    case "retry": {
      const m = S.messages.find((x) => x.id === id);
      return m && send(m);
    }
    case "more": {
      target.disabled = true;
      try {
        const rows = await fetchMessages(S.messages[0]?.created_at);
        for (const m of rows) insertMessage(m);
        S.hasMore = rows.length === PAGE;
        mergeAcks(await fetchAcks(rows.filter((m) => m.kind === "alerta").map((m) => m.id)));
        const el = list();
        const before = el.scrollHeight;
        el.innerHTML = listHtml();
        el.scrollTop = el.scrollHeight - before;
        ensureAttachments();
      } catch (err) {
        target.disabled = false;
        toast(err.message || "No se pudieron cargar.");
      }
      return;
    }
    case "reload":
      return load();
    case "bubble":
      return; // (la acción «Borrar» se ve siempre en los mensajes propios)
    default:
  }
}

// ---------- ciclo de vida (lo llama app.js) ----------

export function initChat() {
  buildUi();
  paint();
  q("#chat-new")?.addEventListener("click", toBottom);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (S.started) catchUp();
    if (S.visible) markSeen();
  });
}

// Arranca la carga y el tiempo real cuando se puede (sesión iniciada, viajero y Supabase). Se llama en cada pintado; es barato.
export function syncChat() {
  if (canChat()) {
    if (!S.started) {
      S.started = true;
      subscribe();
      load();
    }
  } else if (S.started) {
    S.started = false;
    unsubscribe();
    S.messages = [];
    S.acks.clear();
    paintBadge();
  }
  paintBadge();
}

// La pestaña Chat pasa a verse.
export function enterChat() {
  S.visible = true;
  buildUi();
  fitViewport();
  if (!S.started) paint();
  markSeen();
  paintBadge();
  paintAlerts();
  requestAnimationFrame(() => {
    fitViewport();
    toBottom();
  });
  if (S.started) catchUp();
}

export function leaveChat() {
  if (!S.visible) return;
  S.visible = false;
  cancelAllRecordings();
  S.recording = null;
  paintComposer();
  paintBadge();
}
