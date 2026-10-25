// Avisos con la web cerrada (Web Push): permiso del navegador, suscripción, guardado en la base de datos y, para los
// administradores, el registro automático de la función `push`. No pinta nada: lo usa js/avisos.js.
// Todo tolera que falte el SQL (avisos.sql) o la función (supabase/functions/push): devuelve un motivo en vez de lanzar errores.
import { config } from "./config.js";

const SYNC_KEY = "viaje.avisos.sync";

export const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
// En iPhone el Web Push solo existe con la web instalada en la pantalla de inicio (iOS 16.4 o más).
export const iosNeedsInstall = () => ios() && !standalone();
export const supported = () => "serviceWorker" in navigator && Boolean(window.PushManager) && "Notification" in window; // Boolean: una propiedad presente pero vacía tampoco cuenta
export const permission = () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

export const functionUrl = () => `${String(config.supabase.url || "").replace(/\/+$/, "")}/functions/v1/push`;

const bytes = (b64u) => {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const sameKey = (sub, key) => {
  const k = sub?.options?.applicationServerKey;
  if (!k) return true; // el navegador no lo dice: no se puede comparar
  const a = new Uint8Array(k), b = bytes(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

// El service worker que registra app.js (solo en https). Sin él no hay avisos con la web cerrada.
export async function registration(waitMs = 4000) {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration().catch(() => null);
  if (existing?.active) return existing;
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), waitMs))]).catch(() => null);
}

export async function currentSubscription() {
  if (!supported()) return null;
  const reg = await registration(1200);
  return reg ? reg.pushManager.getSubscription().catch(() => null) : null;
}

// ¿Existe la tabla/función? (el SQL aún sin ejecutar da estos errores)
export const missing = (error) => Boolean(error) && (["42P01", "PGRST205", "PGRST202", "42883"].includes(error.code) || /does not exist|schema cache|could not find (the )?(table|function)/i.test(error.message || ""));

// Pregunta a la función por su clave (y de paso se la crea si es la primera vez). Devuelve { ok, status, publicKey }.
export async function probeFunction(timeoutMs = 7000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${functionUrl()}?key=1`, { headers: { apikey: config.supabase.anonKey }, signal: ctl.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json().catch(() => ({}));
    return json.publicKey ? { ok: true, status: res.status, publicKey: json.publicKey } : { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// La clave pública VAPID: primero la guardada en la base de datos; si aún no existe, se la pide a la función.
export async function fetchKey(sb, { probe = true } = {}) {
  try {
    const { data, error } = await sb.rpc("push_public_key");
    if (!error && data) return data;
  } catch {
    /* se intenta con la función */
  }
  if (!probe) return null;
  const res = await probeFunction();
  return res.ok ? res.publicKey : null;
}

async function save(sb, sub) {
  const json = sub.toJSON();
  const { error } = await sb.rpc("push_subscribe", { p_endpoint: json.endpoint, p_p256dh: json.keys?.p256dh, p_auth: json.keys?.auth, p_user_agent: navigator.userAgent });
  if (error) throw error;
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ endpoint: json.endpoint, at: Date.now() }));
  } catch {
    /* sin almacenamiento */
  }
}

async function subscribeAndSave(sb) {
  const reg = await registration();
  if (!reg) return { ok: false, reason: "nosw" };
  const key = await fetchKey(sb);
  if (!key) return { ok: false, reason: "nokey" };
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  try {
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  } catch (err) {
    return { ok: false, reason: "subscribe", message: err?.message || String(err) };
  }
  try {
    await save(sb, sub);
  } catch (err) {
    return missing(err) ? { ok: false, reason: "nosql" } : { ok: false, reason: "save", message: err?.message || String(err) };
  }
  return { ok: true };
}

// Botón «Activar avisos en este móvil». Tiene que llamarse desde un toque (el permiso exige un gesto de la persona).
export async function enable(sb) {
  if (!supported()) return { ok: false, reason: iosNeedsInstall() ? "ios" : "unsupported" };
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm === "denied") return { ok: false, reason: "denied" };
  if (perm !== "granted") return { ok: false, reason: "dismissed" };
  return subscribeAndSave(sb);
}

export async function disable(sb) {
  const sub = await currentSubscription();
  if (!sub) return { ok: true };
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  try {
    await sb.from("push_subscriptions").delete().eq("endpoint", endpoint);
  } catch {
    /* si falla, el servidor lo borrará cuando el navegador lo rechace (410) */
  }
  try {
    localStorage.removeItem(SYNC_KEY);
  } catch {
    /* sin almacenamiento */
  }
  return { ok: true };
}

// Al abrir la web: si el permiso ya está concedido, comprueba (en silencio) que la suscripción del navegador sigue existiendo y está
// guardada en la base de datos; si cambió o falta, la rehace/guarda. Devuelve { subscribed, reason? }.
export async function sync(sb) {
  if (!supported() || Notification.permission !== "granted") return { subscribed: false, reason: Notification.permission };
  const reg = await registration();
  if (!reg) return { subscribed: false, reason: "nosw" };
  let sub = await reg.pushManager.getSubscription().catch(() => null);
  if (!sub) {
    const r = await subscribeAndSave(sb);
    return { subscribed: r.ok, reason: r.reason };
  }
  const key = await fetchKey(sb, { probe: false });
  if (key && !sameKey(sub, key)) {
    const r = await subscribeAndSave(sb);
    return { subscribed: r.ok, reason: r.reason };
  }
  try {
    const { data, error } = await sb.from("push_subscriptions").select("id").eq("endpoint", sub.endpoint).limit(1);
    if (error) return missing(error) ? { subscribed: false, reason: "nosql" } : { subscribed: true };
    if (!data?.length) await save(sb, sub);
  } catch (err) {
    return { subscribed: true, reason: "check", message: err?.message };
  }
  return { subscribed: true };
}

// Administradores: deja registrada la dirección de la función en la base de datos si hace falta (en silencio y sin repetir si ya está).
// Devuelve { status, functionOk, probe, registered } con lo que ha encontrado; nunca lanza.
export async function adminSetup(sb) {
  const out = { status: null, functionOk: false, probe: null, registered: false, sql: true };
  try {
    const first = await sb.rpc("push_status");
    if (first.error) {
      out.sql = !missing(first.error);
      return out;
    }
    out.status = first.data;
    const wanted = functionUrl();
    if (out.status?.function_url === wanted && out.status?.has_keys) {
      out.functionOk = true;
      return out;
    }
    out.probe = await probeFunction();
    out.functionOk = out.probe.ok;
    if (out.probe.ok && out.status?.function_url !== wanted) {
      const set = await sb.rpc("push_set_function_url", { p_url: wanted });
      out.registered = !set.error;
    }
    if (out.probe.ok || out.registered) {
      const again = await sb.rpc("push_status");
      if (!again.error) out.status = again.data;
    }
  } catch {
    /* sin red: se vuelve a intentar la próxima vez */
  }
  return out;
}
