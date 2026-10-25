// Edge Function «push»: envía el aviso (Web Push) al móvil de cada viajero aunque tenga la web cerrada.
//
// Para publicarla (sin terminal): panel de Supabase → Edge Functions → «Deploy a new function» → «Via Editor» → nombre `push`
// → pegar ESTE archivo entero → DESACTIVAR «Verify JWT» → Deploy. Más detalle en docs/DESPLIEGUE.md, «Avisos en el móvil».
//
// Cómo funciona:
//   · La base de datos (avisos.sql) escribe cada novedad en public.push_outbox y llama aquí con POST {"outbox_id": "<uuid>"}.
//   · La función reserva esa fila (rpc push_claim), pide a quién enviar (rpc push_targets: viajeros actuales, sin el autor, con sus
//     preferencias y silencios), cifra y envía con la librería web-push, y anota el resultado (rpc push_report): marca la novedad
//     como enviada y borra los dispositivos que ya no existen (404/410).
//   · Las claves VAPID se crean solas la primera vez (GET ?key=1) y se guardan en public.push_config, una tabla a la que solo
//     llega esta función (con la clave de servicio, que Supabase ya le da: nadie tiene que copiar ni pegar secretos).
//   · La web pide la clave PÚBLICA con GET <esta función>?key=1.
//
// Seguridad: como las claves nuevas de Supabase (sb_publishable_…) no son JWT, la función se despliega SIN «Verify JWT», así que la
// puede llamar cualquiera. Por eso es inocua: solo procesa una fila que YA existe en push_outbox (la crean los disparadores de la
// base de datos o un viajero con «Enviar aviso de prueba»), una sola vez, y nunca envía texto recibido en la petición. No se puede
// usar para mandar mensajes propios ni para borrar nada.
//
// El código está dividido en una parte «pura» (sin Deno ni red: construir el mensaje, decidir urgencia y duración, repartir el envío
// y clasificar las respuestas) y el arranque. La parte pura se prueba en Node (docs/pruebas-sql/README.md, «Pruebas de la función»).

import webpush from "npm:web-push@3.6.7";
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const Deno: any;

// ---------- parte pura ----------

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Max-Age": "86400",
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutboxRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  tag: string | null;
  image_path: string | null;
  urgent: boolean;
  created_at: string;
}

export interface Target {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface Payload {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string;
  tag: string;
  urgent: boolean;
  image: string | null;
  ts: number;
}

// El mensaje que recibe el service worker (sw.js). `url` siempre es un enlace interno de la web («#fotos»…).
export function buildPayload(row: OutboxRow, imageUrl: string | null = null): Payload {
  const ts = Date.parse(row.created_at);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body ?? "",
    url: row.url && /^#[a-z0-9_-]{1,30}(\?[a-z0-9_]{1,10}=[A-Za-z0-9_-]{1,64})?$/.test(row.url) ? row.url : "#mapa",
    tag: row.tag || `${row.kind}-${row.id}`,
    urgent: Boolean(row.urgent),
    image: imageUrl,
    ts: Number.isFinite(ts) ? ts : 0,
  };
}

// Urgentes: prioridad alta y una hora de vida (si el móvil está apagado más tiempo ya no tiene sentido). El resto: normal y un día.
export function sendOptions(urgent: boolean, timeout = 15000): { TTL: number; urgency: "high" | "normal"; timeout: number } {
  return urgent ? { TTL: 3600, urgency: "high", timeout } : { TTL: 86400, urgency: "normal", timeout };
}

export type Outcome = "ok" | "gone" | "failed";

// 2xx: enviado. 404 y 410: la suscripción ya no existe (se borra). Cualquier otra cosa (429, 5xx, red caída, clave rechazada…) es un
// fallo pasajero o de configuración: NO se borra el dispositivo.
export function classify(status: number | undefined): Outcome {
  if (typeof status === "number" && status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "gone";
  return "failed";
}

export interface Sender {
  sendNotification(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: Record<string, unknown>): Promise<{ statusCode: number }>;
}

export interface DeliveryResult {
  sent: number;
  ok: string[];
  gone: string[];
  failed: number;
  statuses: string[];
}

// Envía el mismo mensaje a todos los destinos, de ocho en ocho. Un fallo de uno no afecta a los demás.
export async function deliverAll(lib: Sender, targets: Target[], payload: Payload, vapid: { subject: string; publicKey: string; privateKey: string }, concurrency = 8): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, ok: [], gone: [], failed: 0, statuses: [] };
  const body = JSON.stringify(payload);
  const options = { ...sendOptions(payload.urgent), vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } };
  for (let i = 0; i < targets.length; i += concurrency) {
    await Promise.all(
      targets.slice(i, i + concurrency).map(async (t) => {
        let status: number | undefined;
        try {
          const res = await lib.sendNotification({ endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } }, body, options);
          status = res?.statusCode;
        } catch (err) {
          const e = err as { statusCode?: number; code?: string; message?: string };
          status = typeof e?.statusCode === "number" ? e.statusCode : undefined;
          if (status === undefined) result.statuses.push(String(e?.code || "red"));
        }
        const outcome = classify(status);
        if (outcome === "ok") {
          result.sent++;
          result.ok.push(t.endpoint);
        } else if (outcome === "gone") {
          result.gone.push(t.endpoint);
        } else {
          result.failed++;
          if (status !== undefined) result.statuses.push(String(status));
        }
      }),
    );
  }
  return result;
}

// «2 fallaron (429, 500)»; vacío si todo fue bien. Sin direcciones de dispositivos.
export function summarize(r: DeliveryResult): string | null {
  if (!r.failed) return null;
  const kinds = [...new Set(r.statuses)].slice(0, 4).join(", ");
  return `${r.failed} ${r.failed === 1 ? "falló" : "fallaron"}${kinds ? ` (${kinds})` : ""}`;
}

export interface Deps {
  rpc(name: string, args: Record<string, unknown>): Promise<any>; // lanza si la base de datos da error
  signImage(path: string, seconds: number): Promise<string | null>;
  webpush: Sender & { generateVAPIDKeys(): { publicKey: string; privateKey: string } };
  subject: string;
}

const KEY_RE_PUBLIC = /^[A-Za-z0-9_-]{87}$/;
const KEY_RE_PRIVATE = /^[A-Za-z0-9_-]{43}$/;

// Las claves VAPID: se leen de la base de datos y, si todavía no hay, se generan y se guardan (la primera en guardar gana: una
// segunda llamada a la vez recibe las mismas).
export async function ensureKeys(deps: Deps): Promise<{ publicKey: string; privateKey: string }> {
  const first = (await deps.rpc("push_config_get", {}))?.[0];
  if (first?.vapid_public && first?.vapid_private) return { publicKey: first.vapid_public, privateKey: first.vapid_private };
  const fresh = deps.webpush.generateVAPIDKeys();
  if (!KEY_RE_PUBLIC.test(fresh.publicKey) || !KEY_RE_PRIVATE.test(fresh.privateKey)) throw new Error("Claves VAPID con un formato inesperado");
  const saved = (await deps.rpc("push_config_init", { p_public: fresh.publicKey, p_private: fresh.privateKey }))?.[0];
  if (!saved?.vapid_public || !saved?.vapid_private) throw new Error("No se pudieron guardar las claves VAPID");
  return { publicKey: saved.vapid_public, privateKey: saved.vapid_private };
}

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

// Procesa UNA novedad que ya existe en push_outbox. Idempotente: si ya se envió o la está procesando otra llamada, no hace nada.
export async function processOutbox(deps: Deps, outboxId: string): Promise<{ status: "sent" | "skipped"; sent?: number; gone?: number; failed?: number }> {
  const claimed = (await deps.rpc("push_claim", { p_outbox: outboxId }))?.[0] as OutboxRow | undefined;
  if (!claimed) return { status: "skipped" };
  try {
    const targets = ((await deps.rpc("push_targets", { p_outbox: outboxId })) ?? []) as Target[];
    if (!targets.length) {
      await deps.rpc("push_report", { p_outbox: outboxId, p_sent: 0, p_gone: null, p_error: null, p_ok: null });
      return { status: "sent", sent: 0, gone: 0, failed: 0 };
    }
    const keys = await ensureKeys(deps);
    // La foto grande de la notificación: un enlace firmado de 12 horas del almacén privado.
    let image: string | null = null;
    if (claimed.image_path) {
      try {
        image = await deps.signImage(claimed.image_path, 12 * 3600);
      } catch {
        image = null; // la foto es un extra: sin ella se envía igual
      }
    }
    const result = await deliverAll(deps.webpush, targets, buildPayload(claimed, image), { subject: deps.subject, ...keys });
    await deps.rpc("push_report", {
      p_outbox: outboxId,
      p_sent: result.sent,
      p_gone: result.gone.length ? result.gone : null,
      p_error: summarize(result),
      p_ok: result.ok.length ? result.ok : null,
    });
    return { status: "sent", sent: result.sent, gone: result.gone.length, failed: result.failed };
  } catch (err) {
    // Que se vea en push_status por qué no salió, en vez de dejar la novedad a medias.
    try {
      await deps.rpc("push_report", { p_outbox: outboxId, p_sent: 0, p_gone: null, p_error: `Error en la función: ${(err as Error)?.message ?? err}`.slice(0, 280), p_ok: null });
    } catch {
      /* sin base de datos no se puede anotar */
    }
    throw err;
  }
}

export function makeHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    try {
      const url = new URL(req.url);
      if (req.method === "GET") {
        if (url.searchParams.get("key") === "1") {
          const { publicKey } = await ensureKeys(deps);
          return reply({ ok: true, publicKey });
        }
        return reply({ ok: true, service: "push" });
      }
      if (req.method !== "POST") return reply({ ok: false, error: "Método no permitido" }, 405);
      let body: any;
      try {
        body = await req.json();
      } catch {
        return reply({ ok: false, error: "Se esperaba JSON" }, 400);
      }
      const id = typeof body?.outbox_id === "string" ? body.outbox_id.trim() : "";
      if (!UUID_RE.test(id)) return reply({ ok: false, error: "Falta outbox_id (un uuid)" }, 400);
      return reply({ ok: true, ...(await processOutbox(deps, id.toLowerCase())) });
    } catch (err) {
      console.error("push:", (err as Error)?.message ?? err);
      return reply({ ok: false, error: "No se pudo procesar el aviso" }, 500);
    }
  };
}

// ---------- arranque (solo dentro de Supabase / Deno) ----------

export function depsFromEnv(env: { get(name: string): string | undefined }): Deps {
  const url = env.get("SUPABASE_URL") ?? "";
  const key = env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  let origin = "https://example.invalid";
  try {
    origin = new URL(url).origin;
  } catch {
    /* sin URL válida: el servicio de avisos del navegador puede rechazar el contacto, pero la función no se rompe */
  }
  return {
    async rpc(name, args) {
      const { data, error } = await db.rpc(name, args);
      if (error) throw new Error(`${name}: ${error.message}`);
      return data;
    },
    async signImage(path, seconds) {
      const { data, error } = await db.storage.from("photos").createSignedUrl(path, seconds);
      if (error) throw new Error(error.message);
      return data?.signedUrl ?? null;
    },
    webpush: webpush as unknown as Deps["webpush"],
    subject: origin, // un contacto https válido para el servicio de avisos del navegador
  };
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  Deno.serve((req: Request) => {
    handler ??= makeHandler(depsFromEnv(Deno.env));
    return handler(req);
  });
}
