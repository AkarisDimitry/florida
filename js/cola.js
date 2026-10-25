// Cola de subida de fotos sin conexión.
// Cada foto (ya reducida por prepareImage) se guarda PRIMERO en IndexedDB y se muestra en la galería con «⏳ En cola»; después
// se intenta subir. Si no hay señal (o el servidor falla un momento) se queda guardada en el móvil y se sube sola al volver la red,
// sin duplicados: la foto lleva un id generado aquí y `store.addPhoto` es idempotente (mismo id → mismos archivos, y si la fila
// ya existía, es que un intento anterior sí llegó). Las fotos de comentarios, actividades, tickets y juegos NO pasan por aquí.
//
// Datos en IndexedDB `viaje-cola`: `fotos` (metadatos + miniatura), `blobs` (la foto grande) y `meta` (candado de respaldo).
// Se guardan ArrayBuffer (no Blob) porque es lo que Safari maneja sin sorpresas.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { esc, toast, schemaHint, hasCoords, fmtStamp, $ } from "./util.js";
import { photoTime } from "./trip.js";
import { getName } from "./store.js";

const DB_NAME = "viaje-cola";
const LOCK = "viaje-cola-subida";
const MAX_PHOTOS = 100; // límite de la cola (por dispositivo)
const MAX_BYTES = 150 * 1024 * 1024;
const SOFT_LIMIT = 8; // fallos seguidos del servidor (5xx, 429) antes de pasar a «No se pudo subir»
const UNKNOWN_LIMIT = 4; // lo mismo para errores que no sabemos clasificar
const UPLOAD_MS = 75_000; // tiempo máximo de un intento (el móvil con una barra de cobertura puede colgarse minutos)
const LEASE_MS = 30_000;

// ---------- estado del módulo ----------

let available = false; // hay IndexedDB y se pudo abrir
let list = []; // metadatos de la cola (todas las cuentas de este dispositivo), por orden de llegada
const urls = new Map(); // id -> URL local de la miniatura
const ghosts = new Map(); // id -> { until }: subidas que esperan a que la foto real aparezca en la galería (cambio sin parpadeo)
const fresh = new Set(); // ids cuyo mosaico real se pinta ya visible (sin el fundido de entrada)
const uploadedIds = new Map(); // id -> { located }: subidas desde que se abrió la app
let blocked = null; // null | "auth" | "name": por qué no se puede subir ahora
let running = null;
let timer = null;
let batches = 0; // subidas lanzadas desde uploadFiles: ellas mismas avisan del resultado
let doneNote = null; // { text, until }: «✅ Se subieron las 3 fotos», unos segundos
let persistAsked = false;
let seqCounter = 0;
let dialog = null;
let detailId = null;
const me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let bc = null;

export class ColaError extends Error {
  constructor(message, kind) {
    super(message);
    this.colaKind = kind; // "full" | "quota"
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const bySeq = (a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1);
const backoff = (tries) => Math.min(300, 5 * 3 ** Math.max(0, tries - 1)) * 1000; // 5 s, 15 s, 45 s, 135 s, 5 min

// EXIF guarda la hora de reloj de la cámara sin huso y la app la trata como UTC («taken_at»): se reproduce esa convención.
function wallClockIso(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())).toISOString();
}

const supabaseMode = () => ctx.store?.mode === "supabase";
export const usable = () => available && supabaseMode();
const userId = () => ctx.store?.user?.id ?? null;
// Las fotos de otra cuenta del mismo móvil se conservan, pero no se ven ni se suben. Las guardadas sin sesión (p. ej. recibidas
// desde la galería con la sesión caducada) las adopta quien entre.
const mine = (e) => e.user_id == null || e.user_id === userId();
const mineList = () => list.filter(mine);
const active = () => mineList().filter((e) => e.state !== "error");
const errored = () => mineList().filter((e) => e.state === "error");

// ---------- IndexedDB ----------

let dbp = null;
function openDb() {
  dbp ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("Este navegador no permite guardar fotos sin conexión."));
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      return reject(err);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("fotos", { keyPath: "id" });
      db.createObjectStore("blobs", { keyPath: "id" });
      db.createObjectStore("meta", { keyPath: "k" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      db.onclose = () => (dbp = null);
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("No se pudo abrir el almacenamiento del móvil."));
    req.onblocked = () => reject(new Error("El almacenamiento del móvil está bloqueado por otra pestaña."));
  }).catch((err) => {
    dbp = null;
    throw err;
  });
  return dbp;
}

// Una transacción: `work(stores, set)` lanza las peticiones de golpe (sin awaits en medio: Safari cierra la transacción) y
// entrega el resultado con set(). Se reintenta una vez si el navegador había cerrado la conexión.
async function idb(names, mode, work, retry = true) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(names, mode);
    } catch (err) {
      dbp = null;
      return retry && err?.name === "InvalidStateError" ? resolve(idb(names, mode, work, false)) : reject(err);
    }
    let result;
    t.oncomplete = () => resolve(result);
    t.onabort = () => reject(t.error || new DOMException("Transacción cancelada", "AbortError"));
    try {
      work(names.map((n) => t.objectStore(n)), (value) => (result = value));
    } catch (err) {
      try {
        t.abort();
      } catch {
        /* ya cerrada */
      }
      reject(err);
    }
  });
}

const getMeta = () => idb(["fotos"], "readonly", ([f], set) => { const r = f.getAll(); r.onsuccess = () => set(r.result); });
const putEntry = (meta, full) => idb(["fotos", "blobs"], "readwrite", ([f, b]) => { f.put(meta); b.put({ id: meta.id, full }); });
const delEntry = (id) => idb(["fotos", "blobs"], "readwrite", ([f, b]) => { f.delete(id); b.delete(id); });
const getFull = (id) => idb(["blobs"], "readonly", ([b], set) => { const r = b.get(id); r.onsuccess = () => set(r.result?.full ?? null); });
const patchEntry = (id, fields) =>
  idb(["fotos"], "readwrite", ([f], set) => {
    const r = f.get(id);
    r.onsuccess = () => {
      const row = r.result;
      if (!row) return;
      Object.assign(row, typeof fields === "function" ? fields(row) : fields);
      f.put(row);
      set(row);
    };
  });

function bufferOf(blob) {
  if (blob.arrayBuffer) return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

// ---------- lista en memoria ----------

async function reload() {
  let rows;
  try {
    rows = await getMeta();
  } catch (err) {
    console.warn("Cola de fotos: no se pudo leer el almacenamiento:", err?.message || err);
    return;
  }
  rows.sort(bySeq);
  const ids = new Set(rows.map((r) => r.id));
  for (const [id, url] of urls) {
    if (ids.has(id) || ghosts.has(id)) continue;
    URL.revokeObjectURL(url);
    urls.delete(id);
  }
  for (const row of rows) if (!urls.has(row.id) && row.thumb) urls.set(row.id, URL.createObjectURL(new Blob([row.thumb], { type: "image/jpeg" })));
  list = rows;
}

async function patch(id, fields) {
  const row = await patchEntry(id, fields).catch(() => null);
  if (row) list = list.map((e) => (e.id === id ? row : e));
  return row;
}

// ---------- avisos a la pantalla ----------

let repaintTimer = null;
function announce({ remote = false } = {}) {
  updateChip();
  if (!remote) bc?.postMessage({ t: "changed", from: me });
  clearTimeout(repaintTimer);
  repaintTimer = setTimeout(repaint, 40);
}

function repaint() {
  updateChip();
  renderDetail();
  const showsQueue = state.view === "photos" || (state.view === "plan" && state.planTab === "days");
  if (showsQueue) ctx.actions.render?.();
}

function updateChip() {
  const chip = $("#cola-chip");
  if (!chip) return;
  const n = active().length;
  const bad = errored().length;
  chip.hidden = !usable() || !(n || bad);
  if (chip.hidden) return;
  chip.classList.toggle("is-error", !n && bad > 0);
  chip.querySelector(".cola-chip-n").textContent = String(n || bad);
  chip.querySelector(".cola-chip-ico").textContent = n ? "⏳" : "⚠️";
  const label = n ? `${plural(n, "foto esperando", "fotos esperando")} señal` : `${plural(bad, "foto sin subir", "fotos sin subir")}`;
  chip.setAttribute("aria-label", `${label}. Toca para verlas`);
  chip.title = label;
}

// ---------- errores ----------

// Qué hacer con un fallo: "net" (red / sin conexión) y "server" (5xx, 429) → se reintenta; "auth" → hay que renovar la sesión;
// "fatal" (permisos, tamaño, tipo…) → «No se pudo subir» sin bucles; "unknown" → pocos reintentos y después, igual que fatal.
function classify(err) {
  const message = String(err?.message || err || "");
  const status = Number(err?.status ?? 0) || 0;
  const code = String(err?.code ?? "");
  const both = `${message} ${code}`;
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed|err_internet|err_network|timed? ?out|tiempo agotado|aborterror|signal is aborted|sin conexi|offline/i.test(message) || (status === 0 && /^(FetchError|TypeError)/.test(message))) {
    return { kind: "net", reason: "Sin conexión" };
  }
  if (/row-level security|violates row-level|permission denied|\b42501\b/i.test(both) || status === 403) {
    return { kind: "fatal", perm: true, reason: "No tienes permiso para subir fotos. Pide a quien organiza el viaje que revise tu acceso." };
  }
  if (status === 401 || /jwt|invalid token|token (is )?expired|exp claim|\bPGRST30[123]\b|not authenticated|session.*(expired|missing)|refresh token/i.test(both)) {
    return { kind: "auth", reason: "La sesión ha caducado" };
  }
  if (status === 413 || /payload too large|exceeded the maximum allowed size|entity too large|too large/i.test(message)) {
    return { kind: "fatal", reason: "La foto pesa demasiado para el servidor." };
  }
  if (status === 415 || /mime type|unsupported media|not supported/i.test(message)) {
    return { kind: "fatal", reason: "El servidor no acepta este tipo de archivo." };
  }
  if (status === 408 || status === 429 || status >= 500 || /bad gateway|service unavailable|gateway time-?out|internal server error|upstream|too many requests/i.test(message)) {
    return { kind: "server", reason: status === 429 ? "El servidor pide ir más despacio (demasiadas peticiones)" : `El servidor no responde bien${status ? ` (código ${status})` : ""}` };
  }
  const hinted = schemaHint(err);
  if (hinted !== err) return { kind: "fatal", reason: hinted.message };
  if (status >= 400 && status < 500) return { kind: "fatal", reason: message.slice(0, 160) || `El servidor rechazó la foto (código ${status})` };
  return { kind: "unknown", reason: message.slice(0, 160) || "Error desconocido" };
}

// ---------- subida ----------

const withTimeout = (promise, ms) =>
  Promise.race([promise, wait(ms).then(() => Promise.reject(new TypeError("Tiempo agotado: la conexión es demasiado lenta")))]);

// ¿Hay una sesión válida? true | false (no hay: hay que entrar) | "wait" (no se sabe ahora: red o renovación en curso).
// Subir sin sesión sería subir como anónimo: el almacén respondería «sin permiso» y la foto parecería rechazada de verdad.
async function sessionState() {
  const sb = ctx.store.sb;
  if (!sb) return false;
  const got = await Promise.race([sb.auth.getSession().then((r) => r.data?.session ?? null, () => null), wait(8000).then(() => "wait")]);
  if (got === "wait") return "wait";
  if (!got) return false;
  if (got.expires_at && got.expires_at * 1000 < Date.now() + 15_000) return refreshSession();
  return true;
}

async function refreshSession() {
  const sb = ctx.store.sb;
  const r = await Promise.race([sb.auth.refreshSession().then((x) => x, (error) => ({ error })), wait(10_000).then(() => "wait")]);
  if (r === "wait") return "wait";
  if (r?.error) return classify(r.error).kind === "net" ? "wait" : false;
  return true;
}

// Candado para que dos pestañas no vacíen la cola a la vez: Web Locks si existen; si no, un «alquiler» en IndexedDB que caduca.
async function withLock(fn) {
  if (navigator.locks?.request) return navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? fn() : "busy"));
  const now = Date.now();
  const got = await idb(["meta"], "readwrite", ([m], set) => {
    const r = m.get("lease");
    r.onsuccess = () => {
      const lease = r.result;
      const free = !lease || lease.until < now || lease.owner === me;
      if (free) m.put({ k: "lease", owner: me, until: now + LEASE_MS });
      set(free);
    };
  }).catch(() => false);
  if (!got) return "busy";
  const renew = setInterval(() => idb(["meta"], "readwrite", ([m]) => m.put({ k: "lease", owner: me, until: Date.now() + LEASE_MS })).catch(() => {}), LEASE_MS / 3);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await idb(["meta"], "readwrite", ([m]) => {
      const r = m.get("lease");
      r.onsuccess = () => r.result?.owner === me && m.delete("lease");
    }).catch(() => {});
  }
}

export function flush({ manual = false } = {}) {
  if (!usable()) return Promise.resolve({ uploaded: 0, stopped: true });
  if (running) return manual ? running.then(() => flush({ manual })) : running; // «Subir ahora» no se pierde si ya había un vaciado en marcha
  running = (async () => {
    let out = { uploaded: 0, stopped: true, worked: false };
    try {
      const res = await withLock(() => drain(manual));
      out = res === "busy" ? { uploaded: 0, stopped: true, busy: true, worked: false } : res;
    } catch (err) {
      console.warn("Cola de fotos:", err?.message || err);
    } finally {
      running = null;
      arm();
      if (out.worked) announce(); // sin trabajo no se repinta (flush se llama en cada refresco)
    }
    // Solo se avisa de lo que esperó (sin señal, o tras un fallo): una subida normal, a la primera, no hace ruido.
    if (out.deferred) {
      const left = active().length;
      const n = out.deferred;
      const text = left ? `✅ Se ${n === 1 ? "subió 1 foto" : `subieron ${n} fotos`}. Quedan ${left} esperando.` : n === 1 ? "✅ Se subió la foto" : `✅ Se subieron las ${n} fotos`;
      if (!left) noteDone(n);
      if (!document.hidden && !batches) toast(text, 4500);
    }
    return out;
  })();
  return running;
}

export const kick = () => {
  flush().catch(() => {});
};

// Tras subir una foto se vuelven a pedir los datos (así su miniatura real sustituye a la local); si llegan varias seguidas, una sola vez.
let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => ctx.actions.refresh?.(), 900);
}

async function drain(manual) {
  const out = { uploaded: 0, stopped: false };
  let refreshed = false;
  for (let guard = 0; guard < 500; guard++) {
    await reload();
    // Con el candado en la mano, nadie más está subiendo: lo que quedó como «subiendo» es de un intento que se cortó.
    for (const e of list) if (e.state === "uploading") await patch(e.id, { state: "waiting", next_at: 0 });
    const now = Date.now();
    const next = mineList().find((e) => e.state === "waiting" && (manual || (e.next_at || 0) <= now));
    if (!next) break;
    if (!manual && navigator.onLine === false) {
      out.stopped = true;
      break; // sin conexión: se salta el intento (volverá a intentarlo al volver la red)
    }
    if (!getName()) {
      blocked = "name";
      out.stopped = true;
      break;
    }
    const session = await sessionState();
    if (session === "wait") {
      await patch(next.id, { next_at: Date.now() + backoff((next.tries || 0) + 1), last_error: "Sin conexión" });
      out.stopped = true;
      break;
    }
    if (!session) {
      blocked = "auth";
      out.stopped = true;
      break;
    }
    blocked = null;
    if (next.user_id == null) await patch(next.id, { user_id: userId() });
    const deferred = (next.tries || 0) > 0 || Date.now() - next.created_ms > 20_000;
    out.worked = true;
    const result = await attempt(next, refreshed);
    if (result === "ok") {
      out.uploaded++;
      if (deferred) out.deferred = (out.deferred || 0) + 1;
      refreshed = false;
      refreshSoon();
    } else if (result === "again") refreshed = true;
    else if (result === "retry" || result === "auth") {
      out.stopped = true;
      break;
    }
    // "next": una foto rechazada de verdad no frena a las demás
  }
  return out; // los datos se vuelven a pedir con refreshSoon(), que también cambia el mosaico local por el real
}

async function attempt(e, alreadyRefreshed) {
  const store = ctx.store;
  const row = await patch(e.id, { state: "uploading", tries: (e.tries || 0) + 1, last_try: Date.now() });
  if (!row) return "next"; // la descartaron en otra pestaña
  announce();
  try {
    const buffer = await getFull(e.id);
    if (!buffer) throw Object.assign(new Error("Falta el archivo de la foto en el móvil"), { status: 400 });
    // Una foto sin fecha EXIF que esperó un buen rato se sube con la hora en que se hizo, no con la de la subida.
    const taken_at = e.taken_at ?? (Date.now() - e.created_ms > 120_000 ? wallClockIso(e.created_ms) : null);
    await withTimeout(
      store.addPhoto({
        full: new Blob([buffer], { type: "image/jpeg" }),
        thumb: new Blob([e.thumb], { type: "image/jpeg" }),
        lat: e.lat ?? null,
        lng: e.lng ?? null,
        taken_at,
        id: e.id,
        owner: e.user_id || userId(),
        filesDone: Boolean(e.files_ok), // los archivos ya subidos no se vuelven a mandar en cada reintento
        onFiles: (ok) => patch(e.id, { files_ok: ok }),
      }),
      UPLOAD_MS,
    );
    if (e.caption) {
      // El pie es un extra: si falla de verdad se ignora (como antes); si fue la red, se repite todo (es idempotente).
      try {
        await withTimeout(store.updatePhoto(e.id, { caption: e.caption }), 20_000);
      } catch (err) {
        if (["net", "server"].includes(classify(err).kind)) throw err;
      }
    }
  } catch (err) {
    return fail(e, err, alreadyRefreshed);
  }
  await delEntry(e.id).catch(() => {});
  list = list.filter((x) => x.id !== e.id);
  ghosts.set(e.id, { until: Date.now() + 120_000, entry: e }); // el mosaico local se queda hasta que llegue el real
  uploadedIds.set(e.id, { located: hasCoords(e) });
  bc?.postMessage({ t: "uploaded", from: me });
  announce();
  return "ok";
}

async function fail(e, err, alreadyRefreshed) {
  console.warn("Cola de fotos: no se pudo subir:", err?.message || err);
  let c = classify(err);
  // Un «sin permiso» con la sesión a medio renovar es una sesión caducada, no una foto rechazada.
  if (c.kind === "fatal" && c.perm && (await sessionState()) !== true) c = { kind: "auth", reason: "La sesión ha caducado" };
  const tries = (e.tries || 0) + 1;
  if (c.kind === "auth") {
    if (!alreadyRefreshed) {
      const ok = await refreshSession();
      if (ok === true) {
        await patch(e.id, { state: "waiting", next_at: 0 });
        return "again";
      }
      if (ok === "wait") {
        await patch(e.id, { state: "waiting", next_at: Date.now() + backoff(tries), last_error: "Sin conexión" });
        return "retry";
      }
    }
    blocked = "auth";
    await patch(e.id, { state: "waiting", next_at: Date.now() + 60_000, last_error: c.reason });
    return "auth";
  }
  if (c.kind === "net") {
    await patch(e.id, { state: "waiting", next_at: Date.now() + backoff(tries), last_error: c.reason });
    return "retry";
  }
  if (c.kind === "server" || c.kind === "unknown") {
    const soft = (e.soft || 0) + 1;
    if (soft >= (c.kind === "server" ? SOFT_LIMIT : UNKNOWN_LIMIT)) {
      await patch(e.id, { state: "error", soft, last_error: c.reason });
      return "next";
    }
    await patch(e.id, { state: "waiting", soft, next_at: Date.now() + backoff(tries), last_error: c.reason });
    return "retry";
  }
  await patch(e.id, { state: "error", last_error: c.reason });
  return "next";
}

// Programa el siguiente intento: cuando toque el retroceso, y como mucho cada 60 s mientras haya algo pendiente.
function arm() {
  clearTimeout(timer);
  const open = active().filter((e) => e.state === "waiting");
  if (!usable() || !open.length) return;
  const next = Math.min(...open.map((e) => e.next_at || 0));
  timer = setTimeout(kick, Math.min(60_000, Math.max(1500, next - Date.now())));
}

// Al volver la red o la app a primer plano se intenta ya, sin esperar al retroceso.
async function retryNow() {
  await reload();
  for (const e of mineList()) if (e.state === "waiting" && e.next_at) await patch(e.id, { next_at: 0, tries: 0 });
  kick();
}

// ---------- guardar ----------

// Guarda una foto ya preparada (prepareImage) y devuelve su entrada. No sube: eso lo hace kick()/flush().
export async function enqueue(prepared, { caption = null } = {}) {
  if (!available) throw new Error("Este navegador no permite guardar fotos sin conexión.");
  await reload();
  const bytes = prepared.full.size + prepared.thumb.size;
  const used = list.reduce((sum, e) => sum + (e.bytes || 0), 0);
  if (list.length >= MAX_PHOTOS || used + bytes > MAX_BYTES) {
    throw new ColaError(`La cola de fotos está llena (${MAX_PHOTOS} fotos o ${Math.round(MAX_BYTES / 1048576)} MB esperando señal). Cuando se suban las que hay podrás añadir más.`, "full");
  }
  const full = await bufferOf(prepared.full);
  const thumb = await bufferOf(prepared.thumb);
  const entry = {
    id: crypto.randomUUID(),
    seq: Date.now() * 1000 + (seqCounter++ % 1000),
    user_id: userId(),
    name: getName(),
    state: "waiting",
    tries: 0,
    soft: 0,
    next_at: 0,
    last_error: null,
    created_ms: Date.now(),
    taken_at: prepared.taken_at ?? null,
    lat: prepared.lat ?? null,
    lng: prepared.lng ?? null,
    loc: prepared.locSource ?? (Number.isFinite(prepared.lat) ? "foto" : null), // de dónde salió la ubicación: "foto" (GPS) o "dispositivo"
    caption: caption || null,
    bytes: full.byteLength + thumb.byteLength,
    thumb,
  };
  try {
    await putEntry(entry, full);
  } catch (err) {
    if (err?.name === "QuotaExceededError" || /quota/i.test(err?.message || "")) {
      throw new ColaError("No cabe más en el almacenamiento de este móvil. Libera espacio, o espera a tener señal para que se suban las fotos que ya están guardadas.", "quota");
    }
    throw new Error(`No se pudo guardar la foto en el móvil: ${err?.message || err}`);
  }
  await reload();
  setTimeout(() => announce(), 4100); // si en 4 s no se subió, aparece la banda
  if (!persistAsked) {
    persistAsked = true;
    navigator.storage?.persist?.().catch(() => {}); // pide al navegador que no borre las fotos pendientes si necesita espacio
  }
  announce();
  return entry;
}

// Vaciado de las subidas lanzadas por uploadFiles: mientras dura, es uploadFiles quien avisa del resultado.
export function beginBatch() {
  batches++;
  return () => {
    batches = Math.max(0, batches - 1);
  };
}

// Espera a que las fotos `ids` se hayan subido o no puedan seguir ahora (sin conexión, error, otra pestaña…).
export async function settle(ids) {
  for (let i = 0; i < 40; i++) {
    const res = await flush();
    await reload();
    const left = list.filter((e) => ids.includes(e.id) && e.state !== "error");
    if (!left.length || res.stopped) break;
  }
  await reload();
  const uploaded = ids.filter((id) => uploadedIds.has(id));
  const rest = ids.map((id) => list.find((e) => e.id === id)).filter(Boolean);
  return {
    uploaded: uploaded.length,
    located: uploaded.filter((id) => uploadedIds.get(id).located).length,
    failed: rest.filter((e) => e.state === "error").map((e) => e.last_error || "Error desconocido"),
    queued: rest.filter((e) => e.state !== "error").length,
    reason: rest.find((e) => e.state !== "error" && e.last_error)?.last_error ?? "",
  };
}

export function noteDone(n) {
  doneNote = { text: n === 1 ? "✅ Se subió la foto" : `✅ Se subieron las ${n} fotos`, until: Date.now() + 7000 };
  setTimeout(() => announce(), 7100);
}

// ---------- pantalla ----------

// Fotos en cola como si fueran fotos de la galería (para pintarlas junto a las demás), más las recién subidas que esperan al cambio.
export function queuedPhotos() {
  const pseudo = (id, e, qstate) => ({
    id,
    queued: true,
    qstate,
    thumb_url: urls.get(id) ?? "",
    full_url: urls.get(id) ?? "",
    taken_at: e.taken_at ?? null,
    created_at: new Date(e.created_ms).toISOString(),
    lat: e.lat ?? null,
    lng: e.lng ?? null,
    created_by_name: e.name || getName(),
    caption: e.caption || null,
    real: state.photos.some((p) => p.id === id),
  });
  const out = mineList().map((e) => pseudo(e.id, e, e.state));
  for (const [id, g] of ghosts) if (g.entry) out.push(pseudo(id, g.entry, "done"));
  return out;
}

// La galería con las fotos en cola mezcladas en su sitio (la foto recién subida sustituye a su mosaico local, en la misma posición).
export function mergeQueued(real) {
  const queued = queuedPhotos();
  if (!queued.length) return real;
  const ids = new Set(queued.map((p) => p.id));
  return [...real.filter((p) => !ids.has(p.id)), ...queued].sort((a, b) => photoTime(b).localeCompare(photoTime(a)));
}

export const isFresh = (id) => fresh.has(id);
export const blockedReason = () => blocked;
export const queuedCount = () => active().length;

const BADGES = { waiting: "⏳ En cola", uploading: "⬆️ Subiendo…", error: "⚠️ Sin subir", done: "" };

// Mosaico de una foto en cola (mismo aspecto que los de la galería, con su insignia).
export function queuedTile(p, { featured = false, delay = 0 } = {}) {
  const action = p.qstate === "done" && p.real ? "open-photo" : "cola-open";
  const badge = BADGES[p.qstate];
  const label = p.qstate === "error" ? "Foto sin subir: toca para ver qué pasó" : p.qstate === "done" ? "Foto subida" : "Foto en cola, esperando para subirse";
  return `<button class="photo is-queued is-${p.qstate} ${featured ? "is-featured" : ""}" style="--i:${delay}" data-action="${action}" data-id="${esc(p.id)}" aria-label="${label}">
    <img class="loaded" src="${esc(p.thumb_url)}" alt="">
    ${badge ? `<span class="cola-badge">${badge}</span>` : ""}
    ${hasCoords(p) ? `<span class="geo-badge" title="Con ubicación">${icon("pin", 13)}</span>` : ""}
  </button>`;
}

// Banda de aviso (Fotos y Hoy): fotos esperando, subiendo, sin subir o recién subidas.
export function colaBand() {
  if (!usable()) return "";
  const waiting = active();
  const bad = errored();
  const uploading = waiting.some((e) => e.state === "uploading");
  const offline = navigator.onLine === false;
  let html = "";
  // Con señal, una foto recién guardada se sube en un segundo: la banda solo sale si se demora (o si hay un problema).
  const calm = !offline && !blocked && waiting.every((e) => (e.tries || 0) <= 1 && !e.last_error && Date.now() - e.created_ms < 4000);
  if (waiting.length && !calm) {
    const n = waiting.length;
    if (blocked === "auth") {
      html += band("key", "is-error", "Tu sesión ha caducado", `Vuelve a entrar para subir ${plural(n, "foto", "fotos")}: siguen guardadas en el móvil.`, `<button class="btn small primary" data-action="profile">Entrar</button>`);
    } else if (blocked === "name") {
      html += band("edit", "is-error", "Falta tu nombre", `Ponlo en tu perfil y se subirán ${plural(n, "foto", "fotos")}.`, `<button class="btn small primary" data-action="profile">Poner nombre</button>`);
    } else if (uploading) {
      html += band("up", "is-busy", `Subiendo ${plural(n, "foto", "fotos")}…`, "", "");
    } else {
      const sub = offline ? "Sin conexión: las fotos se subirán solas cuando vuelva la señal" : "Se subirán solas en unos segundos";
      html += band("wait", offline ? "is-offline" : "is-wait", `${plural(n, "foto esperando", "fotos esperando")} señal`, sub, `<button class="btn small" data-action="cola-flush">Subir ahora</button>`);
    }
  } else if (doneNote && Date.now() < doneNote.until && !bad.length) {
    html += band("ok", "is-done", doneNote.text.replace(/^✅ /, ""), "", "");
  }
  if (bad.length) {
    html += band("warn", "is-error", plural(bad.length, "foto sin subir", "fotos sin subir"), "Toca la foto marcada para reintentarla o descartarla.", `<button class="btn small" data-action="cola-review">Revisar</button>`);
  }
  return html;
}

function band(kind, cls, title, sub, button) {
  const emoji = { wait: "⏳", up: "⬆️", key: "🔑", edit: "✏️", warn: "⚠️", ok: "✅" }[kind];
  return `<div class="cola-band ${cls}" role="status" data-cola-band="${kind}"><span class="cola-ico" aria-hidden="true">${emoji}</span><div class="cola-text"><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</div>${button}</div>`;
}

// En la pantalla de entrada: las fotos guardadas esperan a que la persona entre.
export function colaLoginNote() {
  if (!available || !list.length) return "";
  return `<p class="cola-login-note">⏳ Hay ${plural(list.length, "foto guardada", "fotos guardadas")} en este móvil: se subirán solas cuando entres.</p>`;
}

// ---------- detalle de una foto en cola ----------

const reasonText = (e) => e.last_error || "";

function detailHtml(e) {
  const offline = navigator.onLine === false;
  let status;
  let buttons;
  if (e.state === "error") {
    status = `<p class="cola-status is-error"><strong>No se pudo subir:</strong> ${esc(reasonText(e))}</p>`;
    buttons = `<button type="button" class="btn danger" data-cola="discard">Descartar</button><button type="button" class="btn primary" data-cola="retry">Reintentar</button>`;
  } else if (e.state === "uploading") {
    status = `<p class="cola-status"><strong>⬆️ Subiendo ahora…</strong></p>`;
    buttons = `<button type="button" class="btn danger" data-cola="discard">Descartar</button>`;
  } else {
    status = `<p class="cola-status"><strong>⏳ Esperando señal.</strong> ${offline ? "Sin conexión: se subirá sola cuando vuelva la red." : "Se subirá sola en unos segundos."}${e.last_error ? ` <small>Último intento: ${esc(reasonText(e))}.</small>` : ""}</p>`;
    buttons = `<button type="button" class="btn danger" data-cola="discard">Descartar</button><button type="button" class="btn primary" data-cola="now">Subir ahora</button>`;
  }
  const when = fmtStamp.format(new Date(e.created_ms));
  const meta = [`Hecha el ${when}`, hasCoords(e) ? (e.loc === "dispositivo" ? "con tu ubicación al hacerla" : "con ubicación") : "sin ubicación", `${Math.max(1, Math.round((e.bytes || 0) / 1024))} KB`, e.tries ? `${plural(e.tries, "intento", "intentos")}` : ""].filter(Boolean).join(" · ");
  return `<div class="dialog-head"><h2>Foto en cola</h2><button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon("x")}</button></div>
    <img class="cola-preview" src="${esc(urls.get(e.id) ?? "")}" alt="Foto en cola">
    ${status}
    <p class="hint">${esc(meta)}${e.caption ? ` · «${esc(e.caption)}»` : ""}</p>
    <div class="dialog-actions">${buttons}</div>`;
}

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "cola-dialog";
  document.body.append(dialog);
  dialog.addEventListener("click", async (event) => {
    if (event.target.closest("[data-close]")) return dialog.close();
    const act = event.target.closest("[data-cola]")?.dataset.cola;
    const id = detailId;
    if (!act || !id) return;
    if (act === "discard") {
      if (!confirm("¿Descartar esta foto? No se subirá y no se podrá recuperar.")) return;
      await discard(id);
      dialog.close();
    } else if (act === "retry" || act === "now") {
      await patch(id, { state: "waiting", soft: 0, tries: 0, next_at: 0, last_error: null });
      dialog.close();
      announce();
      await flush({ manual: true });
    }
  });
  dialog.addEventListener("close", () => (detailId = null));
  return dialog;
}

function openDetail(id) {
  const e = list.find((x) => x.id === id);
  if (!e) return ghosts.has(id) ? toast("Esa foto ya se subió: aparecerá en unos segundos.", 3500) : undefined;
  detailId = id;
  ensureDialog().innerHTML = detailHtml(e);
  if (!dialog.open) dialog.showModal();
}

function renderDetail() {
  if (!dialog?.open || !detailId) return;
  const e = list.find((x) => x.id === detailId);
  if (!e) return dialog.close(); // ya se subió (o se descartó en otra pestaña)
  dialog.innerHTML = detailHtml(e);
}

async function discard(id) {
  const e = list.find((x) => x.id === id);
  await delEntry(id).catch(() => {});
  // Si sus archivos ya estaban en el servidor (la fila no llegó a crearse), no se dejan huérfanos.
  if (e?.files_ok && ctx.store?.sb && e.user_id) ctx.store.sb.storage.from("photos").remove([`${e.user_id}/${id}.jpg`, `${e.user_id}/${id}_t.jpg`]).catch(() => {});
  await reload();
  announce();
}

export const colaActions = {
  "cola-open": ({ id }) => openDetail(id),
  "cola-flush": async () => {
    const res = await flush({ manual: true });
    await reload();
    if (active().length && res.stopped) {
      toast(blocked === "auth" ? "Tu sesión ha caducado: vuelve a entrar y se subirán." : "Todavía no hay conexión. Las fotos se subirán solas cuando vuelva la señal.", 5000);
    }
  },
  "cola-review": () => {
    const first = errored()[0];
    if (first) openDetail(first.id);
  },
};

// ---------- cambio sin parpadeo: del mosaico local al real ----------

// Cuando la foto real ya está en los datos, se precarga su miniatura y solo entonces se quita el mosaico local.
export function settleGhosts() {
  for (const [id, g] of [...ghosts]) {
    if (g.settling) continue;
    const real = state.photos.find((p) => p.id === id);
    if (!real && Date.now() < g.until) continue;
    g.settling = true;
    const finish = () => {
      ghosts.delete(id);
      if (real) fresh.add(id);
      const url = urls.get(id);
      if (url && !list.some((e) => e.id === id)) {
        URL.revokeObjectURL(url);
        urls.delete(id);
      }
      announce();
      ctx.actions.render?.();
    };
    if (!real?.thumb_url) {
      finish();
      continue;
    }
    const img = new Image();
    const timeout = setTimeout(finish, 4000);
    img.onload = img.onerror = () => {
      clearTimeout(timeout);
      finish();
    };
    img.src = real.thumb_url;
  }
}

// Lo llama app.js tras cada carga de datos (antes de pintar): cambia los mosaicos locales por los reales y reanuda la subida.
export function colaSynced() {
  if (!available) return;
  settleGhosts();
  if (blocked && ctx.store?.user) blocked = null;
  if (active().length) kick();
}

// ---------- arranque ----------

export async function initCola() {
  try {
    await openDb();
    available = true;
    if (typeof BroadcastChannel === "function") {
      bc = new BroadcastChannel("viaje-cola");
      bc.onmessage = async (event) => {
        if (event.data?.from === me) return;
        await reload();
        announce({ remote: true });
        if (event.data?.t === "uploaded") ctx.actions.refresh?.();
      };
    }
    await reload();
    $("#cola-chip")?.addEventListener("click", () => {
      if (location.hash !== "#fotos") location.hash = "#fotos";
      else window.scrollTo(0, 0);
      kick();
    });
    addEventListener("online", () => {
      announce();
      retryNow();
    });
    addEventListener("offline", () => announce());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && active().length) retryNow();
    });
    addEventListener("pageshow", (event) => event.persisted && active().length && retryNow());
    updateChip();
    arm();
  } catch (err) {
    available = false;
    console.warn("Cola de fotos no disponible:", err?.message || err);
  }
  return available;
}

// Primer vaciado, ya con la sesión y los datos cargados.
export function colaStart() {
  if (!usable()) return;
  updateChip();
  if (active().length) kick();
}
