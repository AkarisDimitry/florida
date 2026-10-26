// Ayudas de IA (✨): asistente del viaje, pie de foto con visión, traducir, resumen del día e ideas para los juegos. Este módulo es el
// núcleo ligero: habla con la Edge Function `ia` (supabase/functions/ia/index.ts, que guarda la clave de Anthropic y los cupos), sabe si
// hay IA disponible, pide el permiso de privacidad la primera vez, dibuja los botones ✨ que otros módulos meten en sus plantillas y
// atiende sus clics (un solo escuchador en el documento, con `data-ia="…"`). Lo pesado (el diálogo del asistente y el del resumen del día,
// con el contexto del viaje) está en ia-dialogos.js y se carga solo al usarlo.
//
// Reglas: todo aparece SOLO si la función está desplegada con su clave (GET ?status=1) y la persona es viajera; los botones están siempre
// en el HTML con `data-ia-only` y el CSS los esconde mientras la IA no esté disponible (así no hay que repintar nada cuando se sabe).
// Nada de lo que se manda se guarda; la clave nunca llega al navegador. Sin Supabase (modo demo) no hay IA.
import { config } from "./config.js";
import { state, ctx } from "./state.js";
import { esc, toast, hasCoords } from "./util.js";
import { nearest } from "./geo.js";

const $ = (selector, root = document) => root.querySelector(selector);
const CONSENT_KEY = "viaje.ia.aviso";
const fnUrl = () => `${String(config.supabase.url || "").replace(/\/+$/, "")}/functions/v1/ia`;
const supabaseMode = () => ctx.store?.mode === "supabase";
const signedIn = () => supabaseMode() && Boolean(ctx.store.user) && state.member !== false;

// Lo que se sabe de la IA: estado de la función, el último cupo devuelto, mi uso de hoy y (administradores) el estado de todos.
export const S = { status: null, checkedAt: 0, checking: null, quota: null, usage: null, admin: null, probe: null, limitsError: "" };

export class IaError extends Error {
  constructor(message, code = "error", quota = null) {
    super(message);
    this.code = code;
    this.quota = quota;
  }
}

// ---------- disponibilidad ----------

// Apagada a propósito en config.js (`ia: { enabled: false }`): ni botones, ni tarjeta en Ajustes, ni consultas a la función.
export const iaDisabled = () => config.ia?.enabled === false;

export const iaAvailable = () => !iaDisabled() && signedIn() && S.status?.configured === true && S.status?.tables !== false;

function applyAvailability() {
  document.documentElement.dataset.iaOk = iaAvailable() ? "on" : "";
}

// ¿Está la función desplegada y con clave? Se pregunta una vez por sesión (y cada 10 minutos); con error de red, cada minuto.
export function refreshStatus(force = false) {
  if (!supabaseMode() || iaDisabled()) return Promise.resolve(null);
  if (S.checking) return S.checking;
  const age = Date.now() - S.checkedAt;
  if (!force && S.status && S.status.deployed && age < 10 * 60_000) return Promise.resolve(S.status);
  if (!force && age < 60_000 && S.checkedAt) return Promise.resolve(S.status);
  S.checking = (async () => {
    let status;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    try {
      const res = await fetch(`${fnUrl()}?status=1`, { headers: { apikey: config.supabase.anonKey }, cache: "no-store", signal: ctl.signal });
      if (!res.ok) status = { deployed: false, http: res.status };
      else {
        const json = await res.json().catch(() => ({}));
        status = { deployed: true, configured: Boolean(json.configured), tables: json.tables ?? null };
      }
    } catch {
      status = { deployed: false, http: 0 };
    } finally {
      clearTimeout(timer);
    }
    S.status = status;
    S.checkedAt = Date.now();
    applyAvailability();
    paintSettings();
    return status;
  })().finally(() => {
    S.checking = null;
  });
  return S.checking;
}

// Lo llama app.js en cada pintado: comprueba la IA cuando hay sesión de viajero y mantiene el interruptor del CSS.
export function syncIa() {
  if (!iaDisabled() && signedIn()) refreshStatus();
  applyAvailability();
}

// ---------- llamadas a la función ----------

const asBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

// Una foto reducida (JPEG, lado largo ≤ `max` px, ≤ 380 KB) lista para mandar a la IA. Acepta un Blob/File; los metadatos se pierden al
// pasar por <canvas>.
export async function toIaImage(blob, { max = 512 } = {}) {
  if (!(blob instanceof Blob)) throw new IaError("No hay foto que enviar.", "bad_request");
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new IaError("No se pudo leer la foto.", "bad_request"));
      el.src = url;
    });
    const ratio = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5, 0.4]) {
      const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (out && out.size <= 380 * 1024) return { data: await asBase64(out) };
    }
    throw new IaError("La foto pesa demasiado para la IA.", "too_large");
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Llama a la función. Devuelve el JSON de la respuesta o lanza un IaError con un mensaje ya en español. Recuerda el cupo que devuelve.
export async function callIa(task, payload = {}, { timeoutMs = 70_000 } = {}) {
  if (!signedIn()) throw new IaError("La IA solo está disponible con la sesión iniciada.", "no_session");
  const session = await ctx.store.sb.auth.getSession().catch(() => null);
  const token = session?.data?.session?.access_token;
  if (!token) throw new IaError("Tu sesión ha caducado: vuelve a entrar.", "no_session");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  let json = null;
  try {
    res = await fetch(fnUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.supabase.anonKey, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ task, ...payload }),
      signal: ctl.signal,
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    throw err?.name === "AbortError"
      ? new IaError("La IA ha tardado demasiado. Prueba otra vez.", "timeout")
      : new IaError("No hay conexión con la IA. Revisa tu internet y prueba otra vez.", "network");
  } finally {
    clearTimeout(timer);
  }
  if (json?.quota) S.quota = json.quota;
  if (res.ok && json?.ok) return json;
  if (json?.code === "not_configured" && S.status) {
    S.status.configured = false;
    applyAvailability();
  }
  if (res.status === 404 && !json?.code) throw new IaError("La función de IA no está desplegada en Supabase todavía. Avisa a quien administra el viaje.", "not_deployed");
  throw Object.assign(new IaError(json?.error || `La IA ha fallado (${res.status}). Prueba en un minuto.`, json?.code || "error", json?.quota ?? null), { data: json });
}

// ---------- aviso de privacidad (la primera vez) ----------

const consented = () => {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
};

export function ensureConsent() {
  if (consented()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let dlg = $("#ia-consent");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "ia-consent";
      dlg.className = "ia-consent";
      dlg.innerHTML = `<form method="dialog">
        <div class="dialog-head"><h2>✨ Antes de empezar</h2></div>
        <p>Las ayudas con ✨ envían a <strong>Anthropic</strong> (la empresa que hace la IA Claude) el texto o la foto que elijas, para generar la respuesta.</p>
        <p class="hint">No se guardan en la web ni en la base de datos del viaje. Cada persona tiene un número de ayudas al día. La IA puede equivocarse: comprueba horarios y precios antes de fiarte.</p>
        <div class="dialog-actions"><button type="submit" value="cancel" class="btn ghost">Ahora no</button><button type="submit" value="ok" class="btn primary" autofocus>Entendido, seguir</button></div>
      </form>`;
      document.body.append(dlg);
    }
    dlg.returnValue = "";
    dlg.addEventListener(
      "close",
      () => {
        const ok = dlg.returnValue === "ok";
        if (ok) {
          try {
            localStorage.setItem(CONSENT_KEY, "1");
          } catch {
            /* sin almacenamiento: se volverá a preguntar */
          }
        }
        resolve(ok);
      },
      { once: true },
    );
    dlg.showModal();
  });
}

// ---------- trozos de HTML que otros módulos meten en sus plantillas ----------

// «✨» pequeño en la cabecera de un día del Itinerario.
export const iaDayButton = (day) => `<button type="button" class="icon-btn sm ia-icon" data-ia-only data-ia="summary" data-day="${esc(day)}" title="Resumen del día con IA" aria-label="Resumen del día con IA">✨</button>`;
// Botón con texto para el capítulo de un día del Álbum.
export const iaDayTextButton = (day) => `<button type="button" class="btn small ia-btn" data-ia-only data-ia="summary" data-day="${esc(day)}">✨ Resumen del día con IA</button>`;
// Fila del Itinerario para abrir el asistente.
export const iaAssistantRow = () => `<button type="button" class="btn ia-ask" data-ia-only data-ia="assistant"><span aria-hidden="true">✨</span> Preguntar al asistente del viaje</button>`;
export const iaIdeaButton = (which, label) => `<button type="button" class="btn small ia-btn" data-ia-only data-ia="${esc(which)}">✨ ${esc(label)}</button>`;

// ---------- traducir ----------

const T = new Map(); // "comment:<id>" / "chat:<id>" -> { st: "loading" | "done" | "error", text, target, show, error }
const translatable = (text) => /\p{L}{2}/u.test(text) && text.length <= 2000;
const LANG = { es: "español", en: "inglés" };

function trInner(key) {
  const t = T.get(key);
  if (!t) return `<button type="button" class="ia-tr-btn" data-ia="translate"><span aria-hidden="true">🌐</span> Traducir</button>`;
  if (t.st === "loading") return `<span class="ia-tr-wait" role="status"><span aria-hidden="true">🌐</span> Traduciendo…</span>`;
  if (t.st === "error") return `<span class="ia-tr-err" role="alert">${esc(t.error)}</span> <button type="button" class="ia-tr-btn" data-ia="translate">Reintentar</button>`;
  if (!t.show) return `<button type="button" class="ia-tr-btn" data-ia="translate"><span aria-hidden="true">🌐</span> Ver traducción</button>`;
  return `<div class="ia-tr-box" lang="${esc(t.target)}"><small>🌐 Traducción al ${esc(LANG[t.target] ?? t.target)}</small><p>${esc(t.text)}</p><button type="button" class="ia-tr-btn" data-ia="translate-hide">Ver original</button></div>`;
}

// El hueco de «Traducir» de un comentario o de un mensaje del chat. Lo dibuja con lo que ya se tradujo (la caché vive en memoria).
export function iaTranslateHtml(kind, id, text) {
  const body = String(text ?? "").trim();
  if (!id || !translatable(body)) return "";
  const key = `${kind}:${id}`;
  return `<div class="ia-tr" data-ia-only data-ia-tr="${esc(key)}" data-ia-text="${esc(body)}">${trInner(key)}</div>`;
}

function paintTr(key) {
  for (const el of document.querySelectorAll(`[data-ia-tr="${CSS.escape(key)}"]`)) el.innerHTML = trInner(key);
}

async function translate(el) {
  const box = el.closest("[data-ia-tr]");
  if (!box || !iaAvailable()) return;
  const key = box.dataset.iaTr;
  const cached = T.get(key);
  if (cached?.st === "done") {
    cached.show = true;
    return paintTr(key);
  }
  if (cached?.st === "loading") return;
  if (!(await ensureConsent())) return;
  T.set(key, { st: "loading" });
  paintTr(key);
  try {
    const out = await callIa("translate", { text: box.dataset.iaText });
    T.set(key, { st: "done", text: out.text, target: out.target, show: true });
  } catch (err) {
    T.set(key, { st: "error", error: err.message });
    if (/^quota_/.test(err.code)) toast(err.message);
  }
  paintTr(key);
}

// ---------- pie de foto (visor de fotos) ----------

const suggestEl = () => $("#ia-suggest");
const clearSuggest = () => {
  const box = suggestEl();
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
    delete box.dataset.photo;
  }
};

function captionHint(photo) {
  const day = String(photo.taken_at || photo.created_at || "").slice(0, 10);
  const near = hasCoords(photo) ? nearest(photo, state.activities.filter(hasCoords), 0.4) : null;
  return [day ? `Foto del ${day}` : "", near?.title ? `cerca de «${near.title}»` : ""].filter(Boolean).join(", ");
}

async function suggestCaption(button) {
  const photo = state.photos.find((p) => p.id === state.lightboxId);
  if (!photo || !iaAvailable()) return;
  if (!(await ensureConsent())) return;
  const box = suggestEl();
  button.disabled = true;
  box.hidden = false;
  box.dataset.photo = photo.id;
  box.innerHTML = `<span class="ia-tr-wait" role="status">✨ Pensando en pies de foto…</span>`;
  try {
    const blob = await (await fetch(photo.thumb_url || photo.full_url)).blob();
    const image = await toIaImage(blob, { max: 400 });
    const out = await callIa("caption", { image, hint: captionHint(photo) });
    if (box.dataset.photo !== photo.id) return; // se cambió de foto mientras tanto
    box.innerHTML = `<p class="ia-hint">Toca uno para ponerlo en el pie (no se guarda hasta pulsar «Guardar»):</p>${out.items
      .map((text) => `<button type="button" class="ia-sugg" data-ia="pick-caption" data-text="${esc(text)}">${esc(text)}</button>`)
      .join("")}${quotaHint(" ")}`;
    box.scrollIntoView({ block: "nearest", behavior: "smooth" }); // las propuestas pueden quedar bajo el borde del visor
  } catch (err) {
    if (box.dataset.photo === photo.id) box.innerHTML = `<span class="ia-tr-err" role="alert">${esc(err.message)}</span>`;
  } finally {
    button.disabled = false;
  }
}

function pickCaption(el) {
  const input = $("#lb-caption-form")?.elements?.caption;
  if (!input) return;
  input.value = String(el.dataset.text || "").slice(0, 200);
  input.focus();
}

// «Te quedan N» según el último cupo recibido.
export function quotaHint(prefix = "") {
  const q = S.quota;
  if (!q || q.kind_limit == null) return "";
  const left = Math.max(0, Math.min(q.kind_limit - q.kind_used, q.total_limit - q.total_used));
  return `<small class="ia-quota">${esc(prefix)}Te ${left === 1 ? "queda 1 petición" : `quedan ${left} peticiones`} de esta ayuda hoy.</small>`;
}

// ---------- ideas para los juegos ----------

async function battleIdeas(button) {
  const input = $('[data-keep="batalla-tema"]');
  if (!input || !iaAvailable()) return;
  if (!(await ensureConsent())) return;
  button.disabled = true;
  const old = button.innerHTML;
  button.textContent = "✨ Pensando…";
  try {
    const avoid = [...document.querySelectorAll(".bt-chip")].map((b) => b.textContent.trim()).concat(input.value.trim()).filter(Boolean);
    const out = await callIa("ideas", { kind: "battle", count: 5, avoid });
    const [first, ...rest] = out.items;
    input.value = first.slice(0, Number(input.maxLength) > 0 ? input.maxLength : 120);
    input.dispatchEvent(new Event("input", { bubbles: true })); // para que el juego recuerde el tema
    let extra = $("#ia-battle-extra");
    if (!extra) {
      extra = document.createElement("div");
      extra.id = "ia-battle-extra";
      extra.className = "ia-chips";
      button.closest("[data-ia-line]")?.after(extra);
    }
    extra.innerHTML = rest.map((text) => `<button type="button" class="chip is-link" data-ia="fill-battle" data-text="${esc(text)}">${esc(text)}</button>`).join("");
    input.focus();
  } finally {
    button.disabled = false;
    button.innerHTML = old;
  }
}

function fillBattle(el) {
  const input = $('[data-keep="batalla-tema"]');
  if (!input) return;
  input.value = String(el.dataset.text || "").slice(0, Number(input.maxLength) > 0 ? input.maxLength : 120);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

async function bingoIdeas(button) {
  const inputs = [...document.querySelectorAll("[data-edit]")];
  if (inputs.length !== 25 || !iaAvailable()) return;
  if (!confirm("La IA va a proponer retos nuevos y cambiará los textos de este formulario (no se guarda nada hasta que pulses «Guardar retos»). ¿Seguir?")) return;
  if (!(await ensureConsent())) return;
  button.disabled = true;
  const old = button.innerHTML;
  button.textContent = "✨ Pensando…";
  try {
    const out = await callIa("ideas", { kind: "bingo", count: 25, avoid: inputs.map((i) => i.value.trim()).filter(Boolean).slice(0, 40) });
    out.items.slice(0, 25).forEach((text, i) => {
      if (inputs[i]?.isConnected) inputs[i].value = text.slice(0, 120);
    });
    toast(`La IA ha propuesto ${out.items.length} retos. Revísalos y pulsa «Guardar retos».`, 7000);
  } finally {
    button.disabled = false;
    button.innerHTML = old;
  }
}

// ---------- ajustes: tarjeta «IA» ----------

const STEPS = [
  "Crea una cuenta en https://console.anthropic.com y añade saldo (es de pago: con 5 € hay de sobra para todo el viaje).",
  "En «API keys» crea una clave (empieza por sk-ant-…) y cópiala.",
  "En Supabase → Edge Functions → Secrets → «Add new secret»: nombre ANTHROPIC_API_KEY y, como valor, la clave. No la pegues en ningún otro sitio (ni aquí, ni en el chat, ni en GitHub).",
  "En Supabase → Edge Functions → «Deploy a new function» → «Via Editor» → nombre ia → pega el contenido de code/supabase/functions/ia/index.ts → desactiva «Verify JWT» → Deploy.",
  "En el SQL Editor de Supabase pega y ejecuta code/supabase/todo_en_uno.sql (no hace daño repetirlo).",
  "Vuelve aquí y pulsa «Probar».",
];
const KIND_LABELS = { total: "Por persona y día (todas las ayudas)", global: "Todo el viaje, por día", assistant: "Asistente del viaje", caption: "Pie de foto", translate: "Traducir", summary: "Resumen del día", ideas: "Ideas para juegos", describe: "Describir fotos" };
const KIND_ORDER = ["total", "global", "assistant", "caption", "translate", "summary", "ideas", "describe"];
const PRICE_NOTE = "Uso normal: céntimos al día. Con los límites por defecto, el máximo posible para 5 personas son unos 6 $ al día (ver docs/DESPLIEGUE.md).";

const check = (ok, text) => `<li class="${ok ? "is-ok" : "is-no"}"><span aria-hidden="true">${ok ? "✓" : "✗"}</span> ${esc(text)}</li>`;

function usageLine() {
  const u = S.usage;
  if (!u) return "";
  return `<p class="ia-usage">Hoy has usado <strong>${Number(u.total_used) || 0}</strong> de <strong>${Number(u.limits?.total) || 0}</strong> peticiones de IA.</p>`;
}

function adminHtml() {
  const st = S.status ?? {};
  const ready = st.deployed && st.configured && st.tables !== false;
  const list = `<ul class="ia-check">${check(Boolean(st.deployed), st.deployed ? "Función «ia» desplegada" : "Falta desplegar la función «ia»")}${check(Boolean(st.configured), st.configured ? "Clave de Anthropic guardada" : "Falta la clave ANTHROPIC_API_KEY en los Secrets")}${check(st.tables !== false && Boolean(st.deployed), st.tables === false ? "Falta ejecutar todo_en_uno.sql" : "Base de datos preparada")}</ul>`;
  const steps = ready ? "" : `<ol class="ia-steps">${STEPS.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  const probe = S.probe
    ? `<div class="ia-probe" role="status">${S.probe.map((r) => `<p class="${r.ok ? "is-ok" : "is-no"}">${r.ok ? "✓" : "✗"} ${esc(r.label)}: ${esc(r.text)}</p>`).join("")}</div>`
    : "";
  const a = S.admin;
  const today = a
    ? `<h4>Uso de hoy</h4><p class="hint">${Number(a.global_used) || 0} de ${Number(a.limits?.global) || 0} peticiones entre todos.</p>${
        a.people?.length ? `<ul class="ia-people">${a.people.map((p) => `<li><span>${esc(String(p.email || "").split("@")[0] || "alguien")}</span><strong>${Number(p.total) || 0}</strong></li>`).join("")}</ul>` : `<p class="hint">Nadie ha usado la IA hoy.</p>`
      }`
    : "";
  const limits =
    a && ready
      ? `<h4>Límites por día</h4><form class="ia-limits" data-ia-form="limits">${KIND_ORDER.map((k) => `<label><span>${esc(KIND_LABELS[k])}</span><input type="number" inputmode="numeric" min="0" max="100000" step="1" name="${k}" value="${Number(a.limits?.[k]) || 0}"></label>`).join("")}
        <p class="hint">0 apaga esa ayuda. ${esc(PRICE_NOTE)}</p>${S.limitsError ? `<p class="ia-tr-err" role="alert">${esc(S.limitsError)}</p>` : ""}<button type="submit" class="btn small primary">Guardar límites</button></form>`
      : "";
  return `<h3>✨ IA</h3>
    <p class="hint">${ready ? "Las ayudas de IA están activadas: asistente del viaje, pie de foto, traducir, resumen del día e ideas para los juegos." : "Las ayudas de IA aún no están activadas. Son opcionales y se pagan por uso (céntimos)."}</p>
    ${list}${steps}
    <div class="ia-actions">${ready ? "" : `<button type="button" class="btn small" data-ia="copy-steps">Copiar los pasos</button>`}<button type="button" class="btn small ${ready ? "primary" : ""}" data-ia="probe" ${S.probe === "wait" ? "disabled" : ""}>Probar</button></div>${probe}${usageLine()}${today}${limits}`;
}

function memberHtml() {
  return `<h3>✨ IA</h3><p class="hint">Las ayudas con ✨ están activadas. Envían a Anthropic el texto o la foto que elijas y no se guardan.</p>${usageLine()}`;
}

function paintSettings() {
  const sec = $("#ia-section");
  if (!sec) return;
  if (iaDisabled() || !signedIn() || !S.status) {
    sec.hidden = true;
    return;
  }
  const admin = state.isAdmin;
  if (!admin && !iaAvailable()) {
    sec.hidden = true; // quien no administra no ve nada mientras la IA no esté lista
    return;
  }
  sec.hidden = false;
  if (S.probe === "wait") {
    sec.querySelector('[data-ia="probe"]')?.setAttribute("disabled", "");
    return;
  }
  sec.innerHTML = admin ? adminHtml() : memberHtml();
}

// Lo llama dialogs.js al abrir Ajustes: vuelve a mirar el estado y carga el gasto de hoy.
export async function iaSettingsOpen() {
  if (iaDisabled() || !signedIn()) return;
  S.probe = null; // el resultado de una prueba anterior ya no vale
  await refreshStatus(true);
  paintSettings();
  if (iaAvailable()) {
    await loadUsage();
    paintSettings();
  }
}

async function loadUsage() {
  const sb = ctx.store?.sb;
  if (!sb) return;
  const mine = await sb.rpc("ia_my_usage").then(({ data, error }) => (error ? null : data), () => null);
  if (mine) S.usage = mine;
  if (state.isAdmin) {
    const all = await sb.rpc("ia_admin_status").then(({ data, error }) => (error ? null : data), () => null);
    if (all) S.admin = all;
  }
}

// «Probar» (administradores): una llamada mínima a cada modelo, de punta a punta, sin gastar el cupo de nadie.
async function probe() {
  S.probe = "wait";
  const btn = $('#ia-section [data-ia="probe"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Probando…";
  }
  const show = (results) =>
    ["fast", "smart"].map((tier) => {
      const r = results?.[tier] ?? {};
      return { ok: Boolean(r.ok), label: tier === "fast" ? "Modelo rápido" : "Modelo capaz", text: r.ok ? `${r.model} (${r.ms} ms)` : `${r.error || "sin respuesta"}${r.detail ? ` [${r.detail}]` : ""}` };
    });
  try {
    const out = await callIa("ping", {}, { timeoutMs: 80_000 });
    S.probe = show(out.results);
    toast("✓ La IA funciona de punta a punta.");
  } catch (err) {
    S.probe = err.data?.results ? show(err.data.results) : [{ ok: false, label: "Prueba", text: err.message }];
    toast(err.data?.results ? "La prueba ha fallado: mira el detalle en Ajustes → IA." : err.message);
  }
  await refreshStatus(true);
  paintSettings();
}

async function saveLimits(form) {
  const limits = {};
  for (const k of KIND_ORDER) {
    const v = form.elements[k]?.value;
    if (v !== undefined && v !== "") limits[k] = Number(v);
  }
  S.limitsError = "";
  const { error } = await ctx.store.sb.rpc("ia_set_limits", { p_limits: limits });
  if (error) {
    S.limitsError = /ia_set_limits|schema cache/i.test(error.message || "") ? "Falta ejecutar todo_en_uno.sql en Supabase." : error.message || "No se pudieron guardar los límites.";
  } else toast("Límites guardados.");
  await loadUsage();
  paintSettings();
}

// ---------- ganchos para otros módulos ----------

const TASKS = ["assistant", "caption", "translate", "summary", "ideas", "describe"];

// Pide una ayuda a la IA con cupo: iaAsk({ task, text, image, … }). `task` es una de las seis; `text` es la pregunta o el texto a traducir;
// `image` (Blob o File) para caption y describe. Devuelve el JSON de la respuesta ({ text } o { items }) o lanza un error en español.
export async function iaAsk({ task, text = "", image = null, context = "", day = "", kind = "", count, avoid, target, hint } = {}) {
  if (!iaAvailable()) throw new IaError("La IA no está disponible ahora mismo.", "unavailable");
  if (!TASKS.includes(task)) throw new IaError("Esa ayuda de IA no existe.", "bad_request");
  if (!(await ensureConsent())) throw new IaError("Has cancelado el envío a la IA.", "cancelled");
  switch (task) {
    case "assistant":
      return callIa(task, { context, messages: [{ role: "user", content: String(text) }] });
    case "translate":
      return callIa(task, { text: String(text), ...(target ? { target } : {}) });
    case "caption":
    case "describe":
      return callIa(task, { image: await toIaImage(image), ...(hint ? { hint } : {}) });
    case "summary":
      return callIa(task, { context, day });
    default:
      return callIa(task, { kind, ...(count ? { count } : {}), ...(avoid ? { avoid } : {}), ...(hint ? { hint } : {}) });
  }
}

// Una frase corta sobre lo que se ve en la foto («Parece un flamenco rosa en la playa»).
export async function iaDescribeImage(blob, hint = "") {
  const out = await iaAsk({ task: "describe", image: blob, hint });
  return String(out.text ?? "");
}

export const iaApi = { iaAvailable, iaAsk, iaDescribeImage };

// ---------- eventos ----------

const lazyDialogs = () => import("./ia-dialogos.js");

const ACTIONS = {
  assistant: async (el) => {
    if (!iaAvailable()) return;
    el.closest("dialog:not(#ia-dialog)")?.close();
    if (await ensureConsent()) (await lazyDialogs()).openAssistant();
  },
  summary: async (el) => {
    if (!iaAvailable()) return;
    if (await ensureConsent()) (await lazyDialogs()).openSummary(el.dataset.day);
  },
  translate: (el) => translate(el),
  "translate-hide": (el) => {
    const key = el.closest("[data-ia-tr]")?.dataset.iaTr;
    if (key && T.get(key)) {
      T.get(key).show = false;
      paintTr(key);
    }
  },
  caption: (el) => suggestCaption(el),
  "pick-caption": pickCaption,
  "battle-idea": (el) => battleIdeas(el),
  "fill-battle": fillBattle,
  "bingo-ideas": (el) => bingoIdeas(el),
  probe: () => probe(),
  "copy-steps": async () => {
    try {
      await navigator.clipboard.writeText(`Para activar las ayudas de IA:\n${STEPS.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
      toast("Pasos copiados.");
    } catch {
      toast("No se pudo copiar. Selecciona el texto y cópialo a mano.");
    }
  },
};

function onClick(event) {
  const el = event.target.closest?.("[data-ia]");
  if (!el) {
    if (event.target.closest?.("#lb-prev, #lb-next, #lb-caption-btn, #lb-caption-cancel, #lightbox .lightbox-close")) clearSuggest();
    return;
  }
  const run = ACTIONS[el.dataset.ia];
  if (!run) return;
  event.preventDefault();
  Promise.resolve(run(el, event)).catch((err) => {
    console.warn("IA:", err?.message || err);
    toast(err?.message || "La IA no ha podido con eso.");
  });
}

function onSubmit(event) {
  const form = event.target.closest?.("[data-ia-form]");
  if (!form) return;
  event.preventDefault();
  Promise.resolve(form.dataset.iaForm === "limits" ? saveLimits(form) : null).catch((err) => toast(err?.message || "No se pudo guardar."));
}

// Las piezas fijas de la página donde cuelgan los botones ✨: Ajustes (tarjeta IA), el visor de fotos (pie de foto) y el menú de datos.
function mount() {
  const settings = $("#settings-dialog");
  if (settings && !$("#ia-section")) {
    const sec = document.createElement("section");
    sec.id = "ia-section";
    sec.className = "ia-section";
    sec.hidden = true;
    (settings.querySelector(".credits") ?? settings.lastElementChild)?.before(sec);
  }
  const form = $("#lb-caption-form");
  if (form && !$("#ia-suggest")) {
    form.insertAdjacentHTML(
      "beforeend",
      `<button type="button" class="btn small ia-btn ia-caption-btn" data-ia-only data-ia="caption">✨ Sugerir un pie de foto</button><div id="ia-suggest" class="ia-suggest" data-ia-only hidden aria-live="polite"></div>`,
    );
  }
  // Al pasar a otra foto del visor (flechas o deslizando) las propuestas de pie de la anterior desaparecen.
  const img = $("#lightbox-img");
  if (img && !img.dataset.iaWatch) {
    img.dataset.iaWatch = "1";
    new MutationObserver(() => {
      const box = suggestEl();
      if (box?.dataset.photo && box.dataset.photo !== state.lightboxId) clearSuggest();
    }).observe(img, { attributes: true, attributeFilter: ["src"] });
  }
  const list = $("#data-dialog .action-list");
  if (list && !$("#ia-menu-btn")) {
    list.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" class="list-btn" id="ia-menu-btn" data-ia-only data-ia="assistant"><span class="list-ico" aria-hidden="true">✨</span><span class="list-text"><strong>Asistente del viaje</strong><small>Pregunta qué hacer, dónde cenar, plan B si llueve…</small></span></button>`,
    );
  }
}

document.addEventListener("click", onClick);
document.addEventListener("submit", onSubmit);
mount();
