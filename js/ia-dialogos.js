// Los dos diálogos grandes de la IA: el asistente del viaje (conversación) y el resumen del día (un párrafo de diario que se puede editar,
// copiar o compartir). Se cargan solo cuando se usan (ia.js los importa al tocar ✨). Aquí también se reúne el «contexto del viaje» que se
// manda a la IA (ia-contexto.js lo recorta a lo que cabe). Nada se guarda: la conversación vive en la memoria de esta pestaña y el resumen
// no se escribe en la base de datos.
import { config } from "./config.js";
import { state } from "./state.js";
import { esc, toast, money, todayIso, utc, capitalize, fmtDayLong, categoryOf as activityCategory } from "./util.js";
import { allDays } from "./trip.js";
import { photoDay } from "./album.js";
import { describeWeather } from "./weather.js";
import { isValid, people } from "./ledger.js";
import { categoryOf as expenseCategory, categoryInfo } from "./categorias.js";
import { buildTripContext, buildDayContext, QUICK_QUESTIONS } from "./ia-contexto.js";
import { callIa, quotaHint, iaAvailable } from "./ia.js";

const $ = (selector, root = document) => root.querySelector(selector);

// Lo que hay en el viaje, en la forma que espera ia-contexto.js.
export function tripData() {
  return {
    trip: { name: config.trip.name, destination: config.trip.destination, start: config.trip.start, end: config.trip.end },
    today: todayIso(),
    days: allDays(),
    activities: state.activities,
    comments: state.comments,
    photos: state.photos,
    photoDay,
    expenses: state.expenses.filter(isValid).map((e) => ({ id: e.id, day: e.day, title: e.title, amount: Number(e.amount), paid_by: e.paid_by, category: categoryInfo(expenseCategory(e)).label.toLowerCase() })),
    weather: Object.fromEntries(state.weather ?? []),
    places: state.places ?? {},
    people: people(),
    money: (n) => money.format(n),
    categoryLabel: (key) => activityCategory(key).label,
    weatherLabel: (code) => describeWeather(code)[1],
  };
}

const copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado.", 2500);
  } catch {
    toast("No se pudo copiar. Selecciona el texto y cópialo a mano.");
  }
};

function dialog(id, className, html) {
  let dlg = $(`#${id}`);
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = id;
    dlg.className = className;
    dlg.setAttribute("aria-label", id === "ia-dialog" ? "Asistente del viaje" : "Resumen del día");
    dlg.innerHTML = html;
    document.body.append(dlg);
    dlg.addEventListener("click", (event) => {
      if (event.target === dlg || event.target.closest("[data-ia-close]")) dlg.close(); // tocar fuera, o ✕ / «Cerrar»
    });
  }
  return dlg;
}

// ---------- el asistente del viaje ----------

const A = { turns: [], busy: false, error: "", retry: "" };

const assistantHtml = `
  <div class="dialog-head"><h2>✨ Asistente del viaje</h2><button type="button" class="icon-btn" data-ia-close aria-label="Cerrar">✕</button></div>
  <div class="ia-thread" id="ia-thread" role="log" aria-live="polite" aria-label="Conversación"></div>
  <div class="ia-quick" id="ia-quick" role="group" aria-label="Preguntas rápidas"></div>
  <form class="ia-form" id="ia-form" autocomplete="off">
    <textarea name="q" rows="1" maxlength="1000" enterkeyhint="send" placeholder="Pregunta lo que quieras sobre el viaje…" aria-label="Tu pregunta"></textarea>
    <button type="submit" class="btn primary" id="ia-send">Enviar</button>
  </form>
  <p class="ia-foot" id="ia-foot"></p>`;

function renderAssistant() {
  const thread = $("#ia-thread");
  if (!thread) return;
  const items = A.turns.map((t, i) =>
    t.role === "user"
      ? `<div class="ia-msg is-user"><p class="ia-msg-text">${esc(t.content)}</p></div>`
      : `<div class="ia-msg is-bot"><p class="ia-msg-text">${esc(t.content)}</p><button type="button" class="link-btn" data-ia-copy="${i}">Copiar</button></div>`,
  );
  if (!A.turns.length && !A.busy && !A.error) {
    items.push(`<div class="ia-empty"><span aria-hidden="true">✨</span><p>Pregúntame lo que quieras sobre el viaje: qué hacer mañana, dónde cenar, qué hacer si llueve, ideas de fotos…</p><p class="hint">Conozco lo que está apuntado en la web: los planes, el tiempo, los gastos, las fotos y los comentarios.</p></div>`);
  }
  if (A.busy) items.push(`<div class="ia-msg is-bot is-wait" role="status"><p class="ia-msg-text"><span class="ia-dots" aria-hidden="true"><i></i><i></i><i></i></span> Pensando…</p></div>`);
  if (A.error) items.push(`<div class="ia-msg is-error" role="alert"><p class="ia-msg-text">${esc(A.error)}</p>${A.retry ? `<button type="button" class="btn small" data-ia-retry>Reintentar</button>` : ""}</div>`);
  thread.innerHTML = items.join("");
  thread.scrollTop = thread.scrollHeight;
  $("#ia-send").disabled = A.busy;
  $("#ia-foot").innerHTML = `${A.turns.length ? `<button type="button" class="link-btn" data-ia-reset>Empezar de nuevo</button> · ` : ""}La IA puede equivocarse: comprueba horarios y precios. ${quotaHint()}`;
}

async function ask(text) {
  const q = String(text ?? "").trim().slice(0, 1000);
  if (!q || A.busy || !iaAvailable()) return;
  A.error = "";
  A.retry = "";
  // Los últimos turnos (como mucho 6 mensajes de antes + la pregunta nueva): lo único que se manda aparte del contexto.
  const history = A.turns.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 2900) }));
  A.turns.push({ role: "user", content: q });
  A.busy = true;
  renderAssistant();
  try {
    const out = await callIa("assistant", { context: buildTripContext(tripData()), messages: [...history, { role: "user", content: q }] });
    A.turns.push({ role: "assistant", content: out.text });
  } catch (err) {
    A.turns.pop(); // la pregunta que no llegó no queda en la conversación
    A.error = err.message || "La IA no ha podido responder.";
    A.retry = /^quota_|no_session|not_member|not_configured|not_deployed|sql_missing/.test(err.code) ? "" : q;
    const field = $("#ia-form")?.elements.q;
    if (field && !field.value) field.value = q;
  } finally {
    A.busy = false;
    renderAssistant();
  }
}

export function openAssistant() {
  if (!iaAvailable()) return;
  const dlg = dialog("ia-dialog", "ia-dialog", assistantHtml);
  if (!dlg.dataset.bound) {
    dlg.dataset.bound = "1";
    const form = $("#ia-form");
    const field = form.elements.q;
    $("#ia-quick").innerHTML = QUICK_QUESTIONS.map((q, i) => `<button type="button" class="chip is-link ia-chip" data-ia-quick="${i}">${esc(q.label)}</button>`).join("");
    const grow = () => {
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
    };
    field.addEventListener("input", grow);
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = field.value;
      if (!text.trim() || A.busy) return;
      field.value = "";
      grow();
      ask(text);
    });
    dlg.addEventListener("click", (event) => {
      const quick = event.target.closest("[data-ia-quick]");
      if (quick) return void ask(QUICK_QUESTIONS[Number(quick.dataset.iaQuick)]?.text);
      const copyBtn = event.target.closest("[data-ia-copy]");
      if (copyBtn) return void copy(A.turns[Number(copyBtn.dataset.iaCopy)]?.content ?? "");
      if (event.target.closest("[data-ia-retry]")) return void ask(A.retry);
      if (event.target.closest("[data-ia-reset]")) {
        A.turns = [];
        A.error = "";
        A.retry = "";
        renderAssistant();
      }
    });
  }
  A.error = A.busy ? A.error : "";
  renderAssistant();
  if (!dlg.open) dlg.showModal();
  if (matchMedia("(pointer: fine)").matches) $("#ia-form").elements.q.focus(); // en el móvil no se abre el teclado solo
}

// ---------- el resumen del día ----------

const R = { day: "", token: 0, busy: false, edited: false };

const summaryHtml = `
  <div class="dialog-head"><h2 id="ia-sum-title">✨ Resumen del día</h2><button type="button" class="icon-btn" data-ia-close aria-label="Cerrar">✕</button></div>
  <p class="hint" id="ia-sum-hint">Un párrafo de diario con lo planeado y lo vivido ese día. Puedes cambiarlo antes de copiarlo o compartirlo; no se guarda en ningún sitio.</p>
  <div class="ia-sum-wait" id="ia-sum-wait" role="status" hidden><span class="ia-dots" aria-hidden="true"><i></i><i></i><i></i></span> Escribiendo el resumen…</div>
  <p class="ia-tr-err" id="ia-sum-error" role="alert" hidden></p>
  <textarea id="ia-sum-text" rows="9" maxlength="3000" aria-label="Resumen del día (se puede editar)" hidden></textarea>
  <p class="hint ia-sum-count" id="ia-sum-count" hidden></p>
  <div class="dialog-actions ia-sum-actions">
    <button type="button" class="btn small" id="ia-sum-again" hidden>Otra versión</button>
    <button type="button" class="btn small" id="ia-sum-copy" hidden>Copiar</button>
    <button type="button" class="btn small primary" id="ia-sum-share" hidden>Compartir</button>
    <button type="button" class="btn small ghost" data-ia-close>Cerrar</button>
  </div>
  <p class="ia-foot" id="ia-sum-foot"></p>`;

const words = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

function paintSummary({ wait = false, error = "" } = {}) {
  const text = $("#ia-sum-text");
  const hasText = Boolean(text.value.trim());
  $("#ia-sum-wait").hidden = !wait;
  $("#ia-sum-error").hidden = !error;
  $("#ia-sum-error").textContent = error;
  text.hidden = wait || !hasText;
  $("#ia-sum-count").hidden = text.hidden;
  $("#ia-sum-count").textContent = `${words(text.value)} palabras`;
  $("#ia-sum-copy").hidden = text.hidden;
  $("#ia-sum-share").hidden = text.hidden || !navigator.share;
  const again = $("#ia-sum-again");
  again.hidden = wait;
  again.textContent = hasText || error ? "Otra versión" : "Escribir el resumen";
  again.disabled = wait;
  $("#ia-sum-foot").innerHTML = `La IA puede equivocarse: revisa el texto. ${quotaHint()}`;
}

async function generateSummary() {
  if (R.busy) return;
  const text = $("#ia-sum-text");
  if (R.edited && text.value.trim() && !confirm("Has cambiado el texto. ¿Sustituirlo por una versión nueva?")) return;
  const label = capitalize(fmtDayLong.format(utc(R.day)));
  const context = buildDayContext(tripData(), R.day);
  if (!context) {
    paintSummary({ error: "No hay nada apuntado ese día todavía: añade planes, fotos o comentarios y vuelve a probar." });
    return;
  }
  const token = ++R.token;
  R.busy = true;
  paintSummary({ wait: true });
  try {
    const out = await callIa("summary", { context, day: label });
    if (token !== R.token) return; // se cerró o se cambió de día mientras tanto
    text.value = out.text;
    R.edited = false;
    paintSummary();
  } catch (err) {
    if (token === R.token) paintSummary({ error: err.message || "La IA no ha podido escribir el resumen." });
  } finally {
    if (token === R.token) R.busy = false;
  }
}

export function openSummary(day) {
  if (!iaAvailable() || !day) return;
  const context = buildDayContext(tripData(), day);
  if (!context) {
    toast("No hay nada apuntado ese día todavía: añade planes, fotos o comentarios y vuelve a probar.", 6000);
    return;
  }
  const dlg = dialog("ia-sum-dialog", "ia-dialog ia-sum-dialog", summaryHtml);
  if (!dlg.dataset.bound) {
    dlg.dataset.bound = "1";
    const text = $("#ia-sum-text");
    text.addEventListener("input", () => {
      R.edited = true;
      $("#ia-sum-count").textContent = `${words(text.value)} palabras`;
    });
    $("#ia-sum-again").addEventListener("click", () => generateSummary());
    $("#ia-sum-copy").addEventListener("click", () => copy(text.value.trim()));
    $("#ia-sum-share").addEventListener("click", async () => {
      try {
        await navigator.share({ title: $("#ia-sum-title").textContent.replace("✨ ", ""), text: text.value.trim() });
      } catch (err) {
        if (err?.name !== "AbortError") toast("No se pudo compartir. Prueba con «Copiar».");
      }
    });
    dlg.addEventListener("close", () => {
      R.token++; // lo que llegue ahora se descarta
      R.busy = false;
    });
  }
  R.day = day;
  R.edited = false;
  R.busy = false;
  $("#ia-sum-text").value = "";
  $("#ia-sum-title").textContent = `✨ ${capitalize(fmtDayLong.format(utc(day)))}`;
  paintSummary();
  dlg.showModal();
  generateSummary();
}
