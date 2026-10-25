// Diálogo para añadir, editar y borrar un gasto repartido.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, esc, guarded, toast, schemaHint, money, todayIso } from "./util.js";
import { getName } from "./store.js";

import { people, canonical, cents, fromCents } from "./ledger.js";
import { requireName } from "./dialogs.js";

const dialog = $("#expense-dialog");
const form = $("#expense-form");
let names = [];
let editingId = null;
let activityId = null;
let saving = false; // evita guardar dos veces el mismo gasto con un doble toque

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

// `from` es una actividad (para repartir su coste) o un gasto existente (para editarlo).
export function openExpense({ id, fromActivity } = {}) {
  if (!requireName()) return;
  const expense = state.expenses.find((e) => e.id === id);
  const activity = state.activities.find((a) => a.id === fromActivity);
  editingId = expense?.id ?? null;
  activityId = expense?.activity_id ?? activity?.id ?? null;
  $("#expense-heading").textContent = expense ? "Editar gasto" : "Nuevo gasto";
  $("#expense-delete").hidden = !expense;
  form.reset();

  const me = canonical(getName());
  names = people([...(expense?.split ?? []), expense?.paid_by].filter(Boolean));
  if (!names.length) names = [me];
  const everyone = names.slice();
  form.elements.title.value = expense?.title ?? activity?.title ?? "";
  form.elements.amount.value = expense ? Number(expense.amount) : activity?.cost ?? "";
  form.elements.day.value = expense?.day ?? activity?.day ?? todayIso(); // un gasto se apunta el día en que se paga
  renderPeople({ payer: expense ? canonical(expense.paid_by) : me, split: expense ? expense.split.map(canonical) : everyone });
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
  form.addEventListener("input", preview);
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
      if (editingId) expense.id = editingId;
      saving = true;
      try {
        await ctx.store.saveExpense(expense);
      } catch (err) {
        throw schemaHint(err);
      } finally {
        saving = false;
      }
      dialog.close();
      await ctx.actions.refresh();
    }),
  );
  $("#expense-delete").addEventListener(
    "click",
    guarded(async () => {
      if (!editingId || !confirm("¿Borrar este gasto? El reparto se recalculará.")) return;
      await ctx.store.deleteExpense(editingId);
      dialog.close();
      await ctx.actions.refresh();
    }),
  );
}
