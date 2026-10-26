// «Estado de la base de datos» (Ajustes, solo administradores): qué partes del instalador (todo_en_uno.sql) están activas en Supabase y
// cuáles faltan. Sin esto, cuando falta una parte la web simplemente no ofrece esa función y nadie sabe por qué. Cada parte se comprueba con
// una consulta de solo lectura a una de sus tablas (o columnas): si la base de datos responde «no existe», esa parte falta.
import { state, ctx } from "./state.js";
import { config } from "./config.js";
import { $, esc, toast } from "./util.js";

// [id, nombre que ve la persona, tabla, columna (opcional), qué da, en construcción (opcional)]
export const PARTS = [
  ["fotos", "Fotos", "photos", null, "subir y ver fotos"],
  ["extras", "Gastos y maleta", "expenses", null, "repartir gastos y la lista de la maleta"],
  ["acceso", "Acceso con aprobación", "access_requests", null, "pedir y aprobar entradas"],
  ["vivo", "Ubicación en vivo", "live_locations", null, "ver dónde está cada uno"],
  ["presencia", "Quién está en línea", "presence", null, "ver quién tiene la web abierta"],
  ["adjuntos", "Notas de voz y fotos en comentarios", "audios", null, "responder con foto o audio"],
  ["compras", "Compras con ticket", "expenses", "kind", "la lista de compras de Cuentas"],
  ["categorias", "Categorías de gasto", "expenses", "category", "«¿En qué gastamos?» y los gastos en el mapa"],
  ["bateria", "Batería de la familia", "presence", "battery", "ver la batería de cada móvil"],
  ["chat", "Chat y alertas", "chat_messages", null, "el chat y el botón de alerta"],
  ["chat_respuestas", "Responder citando en el chat", "chat_messages", "reply_to", "arrastrar un mensaje para responderlo"],
  ["reacciones", "Reacciones y emojis", "reactions", null, "♡ y emojis en comentarios, fotos y chat"],
  ["valoraciones", "Estrellas en las fotos", "photo_ratings", null, "puntuar fotos (también en la batalla)"],
  ["avisos", "Avisos en el móvil", "push_outbox", null, "notificaciones y campana de novedades"],
  // Una función de Supabase (no una tabla): se pega aparte en Supabase → Edge Functions. [id, nombre, null, null, qué da, en construcción, función?parámetros, qué hacer si falta, archivo con su código]
  ["fn_push", "Función de avisos (push)", null, null, "enviar las notificaciones al móvil aunque la web esté cerrada", false, "push?key=1", "Falta desplegar la función `push`: Supabase → Edge Functions → Deploy a new function → Via Editor (código en supabase/functions/push/index.ts, con «Verify JWT» desactivado)", "supabase/functions/push/index.ts"],
  ["juego_batalla", "Batalla de fotos", "battles", null, "el juego de la batalla de fotos"],
  ["juego_bolsa", "Bolsa de valores", "market_quotes", null, "el juego de la bolsa con precios reales"],
  ["juego_bingo", "Bingo del viaje", "bingo_cells", null, "el juego del bingo"],
  ["dibujos", "Álbum de dibujos", "drawings", null, "el juego de dibujar y compartir dibujos"],
  ["ia", "Ayudas de IA", "ia_usage", null, "el asistente, los pies de foto y traducir (necesita además la clave de la IA: Ajustes → IA)"],
  ["fn_ia", "Función de la IA", null, null, "responder al asistente, los pies de foto y las traducciones", false, "ia?status=1", "Falta desplegar la función `ia`: Supabase → Edge Functions → Deploy a new function → Via Editor, nombre `ia`, con «Verify JWT» desactivado (el código se copia con el botón de abajo)", "supabase/functions/ia/index.ts"],
  ["encuentro", "Punto de encuentro", "meetups", null, "fijar un punto en el mapa para juntaros", true],
];

const SEEN_KEY = "viaje.estadoAvisado";
const DAY = 24 * 3600 * 1000;
const S = { running: false, result: null, at: 0, section: null, notified: false };

const sb = () => ctx.store?.sb;
const isMissing = (error) =>
  ["42P01", "PGRST205", "42703", "PGRST204"].includes(error?.code) || /does not exist|schema cache|could not find the (table|column)/i.test(error?.message || "");

// Una función de Supabase (Edge Function) está desplegada si responde. Una que no existe no devuelve las cabeceras CORS, así que el navegador
// la ve como un error de red: aquí eso cuenta como «falta».
async function probeFunction(spec) {
  try {
    const response = await fetch(`${config.supabase.url}/functions/v1/${spec}`);
    if (response.status === 404) return "missing";
    // La función `ia` (?status=1) dice si tiene guardada la clave de la IA: desplegada sin clave no sirve de nada.
    if (spec.startsWith("ia?") && response.ok) {
      const data = await response.json().catch(() => null);
      if (data && data.configured === false) return ["missing", "La función `ia` está desplegada, pero falta guardar la clave: Supabase → Edge Functions → Secrets → ANTHROPIC_API_KEY (la clave se crea en console.anthropic.com y se guarda solo ahí, nunca en la web ni en el chat)"];
    }
    return "ok";
  } catch {
    return navigator.onLine === false ? "unknown" : "missing";
  }
}

async function probe([, , table, column, , , fn]) {
  if (fn) return probeFunction(fn);
  try {
    const { error } = await sb().from(table).select(column ?? "*", { head: true }).limit(1);
    if (!error) return "ok";
    return isMissing(error) ? "missing" : "ok"; // otro error (permisos, red…): la parte existe o no se puede saber; no se alarma
  } catch {
    return "unknown";
  }
}

// Con la IA apagada en config.js (`ia: { enabled: false }`) sus partes no se comprueban ni se avisa de ellas.
const activeParts = () => PARTS.filter((p) => !(config.ia?.enabled === false && (p[0] === "ia" || p[0] === "fn_ia")));

export async function checkParts() {
  if (!sb() || S.running) return S.result;
  S.running = true;
  try {
    const parts = activeParts();
    const states = await Promise.all(parts.map(probe));
    // Una sonda puede devolver [estado, qué hacer] para explicar mejor qué falta (p. ej. la clave de la IA).
    S.result = parts.map((p, i) => {
      const [state, fix] = Array.isArray(states[i]) ? states[i] : [states[i], ""];
      return { id: p[0], label: p[1], gives: p[4], building: Boolean(p[5]), fix: fix || p[7] || "", code: fix ? "" : p[8] ?? "", state }; // con un texto propio (p. ej. «falta la clave») la función ya está desplegada: no se ofrece su código
    });
    S.at = Date.now();
  } finally {
    S.running = false;
  }
  return S.result;
}

const missingParts = () => (S.result ?? []).filter((p) => p.state === "missing" && !p.building);

function paint() {
  const body = $("#estado-body");
  if (!body) return;
  if (!S.result) {
    body.innerHTML = `<p class="hint">Comprobando…</p>`;
    return;
  }
  const missing = missingParts();
  const rows = S.result
    .map(
      (p) => `<li class="estado-${p.state === "missing" ? "missing" : p.state === "unknown" ? "unknown" : "ok"}">
        <span class="estado-ico" aria-hidden="true">${p.state === "missing" ? (p.building ? "🚧" : "⚠️") : p.state === "unknown" ? "❔" : "✅"}</span>
        <span class="estado-txt"><strong>${esc(p.label)}</strong><small>${p.state === "missing" ? (p.building ? "En construcción: todavía no se instala" : p.fix ? esc(p.fix) : `Falta · ${esc(p.gives)}`) : esc(p.gives)}</small>${p.state === "missing" && p.code && !p.building ? `<button type="button" class="btn small" data-estado="code" data-code="${esc(p.code)}">Copiar el código</button>` : ""}</span>
      </li>`,
    )
    .join("");
  body.innerHTML = `<p class="estado-resumen ${missing.length ? "is-warn" : "is-ok"}" role="status">${
    missing.length
      ? `Falta${missing.length === 1 ? "" : "n"} <strong>${missing.length}</strong> ${missing.length === 1 ? "cosa" : "cosas"} por activar en Supabase: ${esc(missing.map((p) => p.label).join(", "))}.`
      : "Todo lo que ofrece la web está activo en Supabase ✅"
  }</p>
    ${
      missing.length
        ? `<p class="hint">Las partes de base de datos se activan con el instalador: pulsa «Copiar el instalador», abre Supabase → <b>SQL Editor</b> → New query, pega (Cmd+V / Ctrl+V) y pulsa <b>Run</b>. No hace daño repetirlo: solo aplica lo que falta. Las funciones (como la de avisos) se pegan aparte en Supabase → <b>Edge Functions</b>; cada una explica abajo qué hacer.</p>
           <div class="estado-actions"><button type="button" class="btn primary" data-estado="copy">Copiar el instalador (SQL)</button></div>`
        : ""
    }
    <ul class="estado-list">${rows}</ul>
    <div class="estado-actions"><button type="button" class="btn small" data-estado="again">Comprobar otra vez</button></div>`;
}

// El código de una función de Supabase, listo para pegar en Edge Functions → Deploy a new function → Via Editor.
async function copyCode(path) {
  try {
    const response = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await navigator.clipboard.writeText(await response.text());
    toast("Código copiado ✅ Pégalo en Supabase → Edge Functions → Deploy a new function → Via Editor (con «Verify JWT» desactivado).", 9000);
  } catch (err) {
    toast(`No se pudo copiar (${err.message || err}). Ábrelo a mano: archivo ${path} del proyecto.`, 9000);
  }
}

async function copyInstaller() {
  try {
    const response = await fetch(`supabase/todo_en_uno.sql?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await navigator.clipboard.writeText(await response.text());
    toast("Instalador copiado ✅ Ahora pégalo en Supabase → SQL Editor y pulsa Run.", 7000);
  } catch (err) {
    toast(`No se pudo copiar (${err.message || err}). Ábrelo a mano: archivo supabase/todo_en_uno.sql del proyecto.`, 9000);
  }
}

function build() {
  if (S.section) return S.section;
  const dialog = $("#settings-dialog");
  if (!dialog) return null;
  const section = document.createElement("section");
  section.id = "estado-section";
  section.hidden = true;
  section.innerHTML = `<h3>Estado de la base de datos</h3><div id="estado-body"></div>`;
  dialog.insertBefore(section, dialog.querySelector(".credits"));
  section.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-estado]")?.dataset.estado;
    if (action === "copy") await copyInstaller();
    if (action === "code") await copyCode(event.target.closest("[data-code]").dataset.code);
    if (action === "again") {
      S.result = null;
      paint();
      await checkParts();
      paint();
    }
  });
  new MutationObserver(async () => {
    if (!dialog.open) return;
    section.hidden = !(state.isAdmin && ctx.store?.mode === "supabase");
    if (section.hidden) return;
    paint();
    if (!S.result || Date.now() - S.at > 60_000) {
      await checkParts();
      paint();
    }
  }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
  S.section = section;
  return section;
}

// Lo llama app.js en cada pintado. Para administradores, una vez al día avisa si falta alguna parte.
export function syncEstado() {
  build();
  if (S.notified || !state.isAdmin || ctx.store?.mode !== "supabase" || !sb()) return;
  S.notified = true;
  let last = 0;
  try {
    last = Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    /* sin almacenamiento */
  }
  if (Date.now() - last < DAY) return;
  checkParts().then(() => {
    const missing = missingParts();
    if (!missing.length) return;
    try {
      localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch {
      /* sin almacenamiento */
    }
    toast(`Falta${missing.length === 1 ? "" : "n"} ${missing.length} ${missing.length === 1 ? "cosa" : "cosas"} por activar en Supabase (${missing.slice(0, 3).map((p) => p.label).join(", ")}${missing.length > 3 ? "…" : ""}). Mira Ajustes → Estado de la base de datos.`, 12000);
  });
}
