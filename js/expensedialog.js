// Diálogo para añadir, editar y borrar un gasto repartido.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, esc, guarded, toast, schemaHint, money, todayIso } from "./util.js";
import { getName } from "./store.js";

import { people, canonical, cents, fromCents } from "./ledger.js";
import { requireName } from "./dialogs.js";
import { prepareImage } from "./images.js";
import { pickFiles } from "./media.js";
import { orderedPresets, presetFor, bumpPreset, QUICK_AMOUNTS, quickLabel } from "./gastopresets.js";
import { categoryPickerHtml, guessCategory, newColumnsError, isCategory, categoryColumnMissing } from "./categorias.js";
import { startLocation, locationFields, initLocationRow, suggestPlace } from "./gastoloc.js";

const dialog = $("#expense-dialog");
const form = $("#expense-form");
let names = [];
let editingId = null;
let activityId = null;
let saving = false; // evita guardar dos veces el mismo gasto con un doble toque
let kind = "gasto"; // "gasto" o "compra"
let ticket = null; // foto del ticket elegida { file, url }

let catChoice = ""; // categoría elegida (clave) o "" = sin categoría (se calcula por las palabras del concepto)
let catSource = ""; // "preset" si la puso un atajo, "user" si la tocó la persona
let catSig = "";
let presetOrder = []; // los atajos del tipo actual, de más a menos usados (se calcula al abrir y al cambiar de tipo)

const chip = (type, name, value, checked) =>
  `<label class="pick"><input type="${type}" name="${name}" value="${esc(value)}" ${checked ? "checked" : ""}><span>${esc(value)}</span></label>`;

function renderPeople({ payer, split }) {
  $("#expense-payer").innerHTML = names.map((n) => chip("radio", "paid_by", n, n === payer)).join("");
  $("#expense-split").innerHTML = names.map((n) => chip("checkbox", "split", n, split.includes(n))).join("");
  preview();
}

const selectedSplit = () => [...form.querySelectorAll("[name=split]:checked")].map((i) => i.value);

// "Cada uno paga 12,50 €": se actualiza al escribir el importe o cambiar quién entra.
function preview() {
  const total = cents(form.elements.amount.value);
  const n = selectedSplit().length;
  const hint = $("#expense-hint");
  if (!(total > 0) || !n) {
    hint.textContent = n ? "" : "Elige al menos una persona.";
    return;
  }
  const base = Math.floor(total / n);
  const rest = total - base * n;
  hint.textContent = `A partes iguales: ${money.format(fromCents(base))} cada uno${rest ? ` (${rest} ${rest === 1 ? "persona paga" : "personas pagan"} 1 céntimo más)` : ""}.`;
}

// Los atajos del tipo actual (los más usados primero); el que coincide con lo escrito sale marcado. Cada uno fija concepto y categoría.
function renderPresets() {
  const typed = form.elements.title.value.trim().toLowerCase();
  $("#expense-presets").innerHTML = presetOrder
    .map(([emoji, label]) => `<button type="button" class="preset" data-preset="${esc(label)}" aria-pressed="${typed === label.toLowerCase()}"><span aria-hidden="true">${emoji}</span> ${esc(label)}</button>`)
    .join("");
}

// Fila «Categoría»: las ocho y «Sin categoría». Mientras no se elija ninguna, la que se calcula por el concepto sale sugerida.
function renderCategory({ reveal = false } = {}) {
  const suggestion = guessCategory(form.elements.title.value, kind === "compra" ? form.elements.place.value : "");
  const sig = `${catChoice}|${suggestion}`;
  const box = $("#expense-cat");
  if (sig === catSig && !reveal && box.firstChild) return;
  catSig = sig;
  const scroll = box.querySelector(".cat-chips")?.scrollLeft ?? 0;
  box.innerHTML = categoryPickerHtml({ choice: catChoice, suggestion });
  const row = box.querySelector(".cat-chips");
  if (!row) return;
  row.scrollLeft = scroll;
  const on = reveal && row.querySelector('[aria-pressed="true"]:not(.is-none)');
  if (on) row.scrollLeft = Math.max(0, on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2); // la elegida a la vista, sin mover el diálogo
}

// Importes rápidos: un toque rellena la cantidad; «Otro» lleva el cursor al campo.
function renderQuick() {
  $("#expense-quick").innerHTML = `${QUICK_AMOUNTS.map((n) => `<button type="button" class="quick" data-amount="${n}" aria-pressed="false">${esc(quickLabel(n))}</button>`).join("")}<button type="button" class="quick" data-amount="other" aria-pressed="false">Otro</button>`;
  syncQuick();
}
function syncQuick() {
  const value = form.elements.amount.value.trim();
  const current = Number(value);
  for (const button of $("#expense-quick").querySelectorAll("button")) {
    const other = button.dataset.amount === "other";
    button.setAttribute("aria-pressed", String(other ? value !== "" && current > 0 && !QUICK_AMOUNTS.includes(current) : current === Number(button.dataset.amount)));
  }
}

// Cambia entre gasto y compra: el campo de tienda solo sale en las compras; la foto del ticket, en las dos.
function setKind(next) {
  kind = next;
  presetOrder = orderedPresets(kind);
  renderPresets();
  renderCategory();
  for (const button of form.querySelectorAll("#expense-kind button")) button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
  const purchase = kind === "compra";
  $("#expense-heading").textContent = editingId ? `Editar ${purchase ? "compra" : "gasto"}` : purchase ? "Nueva compra" : "Nuevo gasto";
  $("#expense-title-label").textContent = purchase ? "¿Qué habéis comprado?" : "Concepto";
  form.elements.title.placeholder = purchase ? "Pan, fruta y agua" : "Cena en el puerto";
  $("#expense-place-field").hidden = !purchase;
  renderTicket();
  if (purchase) suggestPlace(); // en una compra, la tienda se propone con el sitio donde se está
}

// Foto del ticket o recibo de un gasto o una compra (opcional): se sube al guardar y queda enlazada a ese apunte.
function renderTicket() {
  const box = $("#expense-ticket");
  box.hidden = !state.attach;
  if (box.hidden) return;
  const saved = editingId ? state.photos.filter((p) => p.expense_id === editingId) : [];
  box.innerHTML = `<legend>Foto del ticket o recibo (opcional)</legend>
    ${saved.length || ticket ? `<div class="compose-previews">${saved.map((p) => `<span class="pv"><a href="${esc(p.full_url)}" target="_blank" rel="noopener" aria-label="Ver el ticket en grande"><img src="${esc(p.thumb_url)}" alt="Ticket"></a>${p.created_by === ctx.store?.user?.id || ctx.store?.mode === "demo" ? `<button type="button" class="mini-x" data-tk="del" data-id="${esc(p.id)}" aria-label="Borrar el ticket">✕</button>` : ""}</span>`).join("")}${ticket ? `<span class="pv is-new"><img src="${esc(ticket.url)}" alt="Ticket nuevo"><button type="button" class="mini-x" data-tk="clear" aria-label="Quitar la foto">✕</button></span>` : ""}</div>` : ""}
    <div class="compose-bar"><button type="button" class="tool" data-tk="cam">${icon("camera", 17)}<span>Hacer foto</span></button><button type="button" class="tool" data-tk="gal">${icon("images", 17)}<span>Elegir foto</span></button></div>`;
}

// `from` es una actividad (para repartir su coste) o un gasto existente (para editarlo).
export function openExpense({ id, fromActivity, kind: wanted } = {}) {
  if (!requireName()) return;
  const expense = state.expenses.find((e) => e.id === id);
  const activity = state.activities.find((a) => a.id === fromActivity);
  editingId = expense?.id ?? null;
  activityId = expense?.activity_id ?? activity?.id ?? null;
  $("#expense-delete").hidden = !expense;
  if (ticket) URL.revokeObjectURL(ticket.url);
  ticket = null;
  form.reset();

  const me = canonical(getName());
  names = people([...(expense?.split ?? []), expense?.paid_by].filter(Boolean));
  if (!names.length) names = [me];
  const everyone = names.slice();
  form.elements.title.value = expense?.title ?? activity?.title ?? "";
  form.elements.amount.value = expense ? Number(expense.amount) : activity?.cost ?? "";
  form.elements.day.value = expense?.day ?? activity?.day ?? todayIso(); // un gasto se apunta el día en que se paga
  form.elements.place.value = expense?.place ?? "";
  catChoice = isCategory(expense?.category) ? expense.category : "";
  catSource = catChoice ? "user" : "";
  catSig = "";
  setKind(expense ? expense.kind || "gasto" : wanted === "compra" ? "compra" : "gasto");
  renderPeople({ payer: expense ? canonical(expense.paid_by) : me, split: expense ? expense.split.map(canonical) : everyone });
  renderCategory({ reveal: true });
  renderQuick();
  startLocation({ expense, activity }); // al apuntar uno nuevo se pide la posición (un gasto antiguo sin ubicación no la recibe solo)
  dialog.showModal();
  if (!expense && !activity) form.elements.title.focus();
}

function addPerson() {
  const input = $("#expense-new-person");
  // Si ya está en la lista (con otras mayúsculas) se usa esa grafía, para que su casilla quede marcada.
  const typed = canonical(input.value);
  const name = names.find((n) => n.toLowerCase() === typed.toLowerCase()) ?? typed;
  input.value = "";
  if (!name) return;
  const payer = form.querySelector("[name=paid_by]:checked")?.value;
  const split = selectedSplit();
  if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  renderPeople({ payer, split: [...split, name] });
}

export function initExpenseDialog() {
  $("#expense-add-person").innerHTML = `${icon("plus", 15)} Añadir`;
  $("#expense-add-person").addEventListener("click", addPerson);
  $("#expense-new-person").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    addPerson();
  });
  $("#expense-all").addEventListener("click", () => {
    for (const input of form.querySelectorAll("[name=split]")) input.checked = true;
    preview();
  });
  $("#expense-presets").addEventListener("click", (event) => {
    const label = event.target.closest("[data-preset]")?.dataset.preset;
    if (!label) return;
    const preset = presetFor(kind, label);
    form.elements.title.value = label;
    if (preset) {
      catChoice = preset[2]; // el atajo fija también la categoría
      catSource = "preset";
    }
    renderPresets();
    renderCategory({ reveal: true });
    suggestPlace();
    // Con el concepto puesto, lo que falta es el importe. En el móvil no se abre el teclado (taparía los importes rápidos y el botón
    // de guardar): ahí se elige con un toque; con ratón, el cursor salta al campo.
    if (!form.elements.amount.value && !matchMedia("(pointer: coarse)").matches) form.elements.amount.focus();
  });
  $("#expense-cat").addEventListener("click", (event) => {
    const button = event.target.closest("[data-cat-pick]");
    if (!button) return;
    catChoice = button.dataset.catPick;
    catSource = "user";
    renderCategory();
  });
  $("#expense-quick").addEventListener("click", (event) => {
    const amount = event.target.closest("[data-amount]")?.dataset.amount;
    if (!amount) return;
    if (amount === "other") {
      form.elements.amount.focus();
      form.elements.amount.select();
      return;
    }
    form.elements.amount.value = amount;
    preview();
    syncQuick();
  });
  $("#expense-kind").addEventListener("click", (event) => {
    const button = event.target.closest("[data-kind]");
    if (button) setKind(button.dataset.kind);
  });
  $("#expense-ticket").addEventListener("click", async (event) => {
    const action = event.target.closest("[data-tk]")?.dataset.tk;
    if (!action) return;
    if (action === "del") {
      const photo = state.photos.find((p) => p.id === event.target.closest("[data-id]")?.dataset.id);
      if (!photo || !confirm("¿Borrar la foto de este ticket?")) return;
      await ctx.store.deletePhoto(photo);
      await ctx.actions.refresh();
    } else if (action === "clear") {
      URL.revokeObjectURL(ticket.url);
      ticket = null;
    } else {
      const [file] = await pickFiles({ camera: action === "cam" });
      if (!file) return;
      if (ticket) URL.revokeObjectURL(ticket.url);
      ticket = { file, url: URL.createObjectURL(file) };
    }
    renderTicket();
  });
  form.elements.title.addEventListener("input", () => {
    // Si la categoría venía de un atajo y se escribe otro concepto, ya no vale: se vuelve a calcular por las palabras.
    if (catSource === "preset" && presetFor(kind, form.elements.title.value)?.[2] !== catChoice) {
      catChoice = "";
      catSource = "";
    }
    renderPresets();
    renderCategory();
  });
  form.elements.place.addEventListener("input", () => renderCategory());
  form.addEventListener("input", () => {
    preview();
    syncQuick();
  });
  initLocationRow({ formEl: form, dialogEl: dialog, getKind: () => kind });
  form.addEventListener("change", preview);

  form.addEventListener(
    "submit",
    guarded(async (event) => {
      event.preventDefault();
      if (saving) return;
      const f = new FormData(form);
      const split = selectedSplit();
      const paid_by = f.get("paid_by");
      const amount = Number(f.get("amount"));
      const title = f.get("title").trim();
      if (!title) return toast("Escribe en qué se gastó.");
      if (!paid_by) return toast("Elige quién pagó.");
      if (!split.length) return toast("Elige entre quién se reparte.");
      if (!(amount > 0)) return toast("El importe tiene que ser mayor que cero.");
      const expense = { title, amount: Math.round(amount * 100) / 100, day: f.get("day"), paid_by, split, activity_id: activityId };
      // `kind` y `place` solo se envían si hacen falta: así los gastos normales siguen guardándose aunque aún no esté compras.sql.
      const place = (f.get("place") ?? "").trim();
      const wasPurchase = editingId && (state.expenses.find((e) => e.id === editingId)?.kind ?? "gasto") === "compra";
      if (kind === "compra" || wasPurchase) expense.kind = kind;
      // Al pasar de compra a gasto la tienda se borra; en una compra se guarda lo escrito (o se vacía si se borró).
      const hadPlace = state.expenses.find((e) => e.id === editingId)?.place;
      if (kind === "compra" ? place || hadPlace : hadPlace) expense.place = kind === "compra" ? place || null : null;
      // La categoría y la ubicación (lat, lng) solo se envían si hay algo que guardar o quitar: así un gasto sigue guardándose
      // aunque en Supabase aún no esté categorias.sql.
      const previous = state.expenses.find((e) => e.id === editingId);
      if (!categoryColumnMissing()) {
        if (catChoice) expense.category = catChoice;
        else if (previous?.category) expense.category = null; // eligió «Sin categoría» en uno que la tenía: se calcula por el concepto
      }
      Object.assign(expense, locationFields());
      if (editingId) expense.id = editingId;
      saving = true;
      try {
        let id;
        try {
          id = await ctx.store.saveExpense(expense);
        } catch (err) {
          const extra = ["category", "lat", "lng"].filter((k) => k in expense);
          if (!extra.length || !newColumnsError(err)) throw schemaHint(err);
          // Falta categorias.sql: se guarda igual, sin esas columnas, y se avisa de qué falta.
          const plain = { ...expense };
          for (const k of extra) delete plain[k];
          try {
            id = await ctx.store.saveExpense(plain);
          } catch (err2) {
            throw schemaHint(err2);
          }
          toast(`Se guardó, pero sin ${["category", "lat"].filter((k) => k in expense).map((k) => (k === "category" ? "la categoría" : "la ubicación")).join(" ni ")}: falta ejecutar supabase/todo_en_uno.sql en Supabase (no hace daño repetirlo).`, 9000);
        }
        bumpPreset(kind, title); // los atajos más usados salen primero la próxima vez
        if (ticket) {
          try {
            await ctx.store.addPhoto({ ...(await prepareImage(ticket.file)), expense_id: id });
          } catch (err) {
            toast(`Se guardó, pero la foto del ticket no se pudo subir: ${schemaHint(err).message}`, 8000);
          }
        }
        dialog.close();
        await ctx.actions.refresh();
      } finally {
        saving = false;
      }
    }),
  );
  $("#expense-delete").addEventListener(
    "click",
    guarded(async () => {
      if (!editingId || !confirm("¿Borrar este gasto? El reparto se recalculará.")) return;
      const tickets = state.photos.filter((p) => p.expense_id === editingId); // la foto del ticket no tiene sentido sin el apunte
      await ctx.store.deleteExpense(editingId);
      for (const photo of tickets) await ctx.store.deletePhoto(photo).catch((err) => console.error(err));
      dialog.close();
      await ctx.actions.refresh();
    }),
  );
}
