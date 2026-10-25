// Secciones del Itinerario además de los días: reparto de gastos y lista de la maleta. Devuelven HTML ya escapado.
import { state } from "./state.js";
import { icon } from "./icons.js";
import { esc, money, utc, capitalize, fmtDayShort } from "./util.js";
import { getName } from "./store.js";
import { packingTips } from "./weather.js";
import { allDays } from "./trip.js";
import { balances, settlements, totalCents, shares, canonical, people, hueOf, cents, fromCents } from "./ledger.js";

const eur = (c) => money.format(fromCents(c));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const avatar = (name, size = "") => `<span class="person-dot ${size}" style="--h:${hueOf(name)}" aria-hidden="true">${esc(String(name).charAt(0).toUpperCase())}</span>`;

// ---------- navegación del Itinerario ----------

export function planNav() {
  const done = state.checklist.filter((i) => i.done).length;
  const tabs = [
    ["days", "calendar", "Días", ""],
    ["expenses", "wallet", "Gastos", state.expenses.length ? String(state.expenses.length) : ""],
    ["packing", "bag", "Maleta", state.checklist.length ? `${done}/${state.checklist.length}` : ""],
  ];
  return `<nav class="subnav" aria-label="Secciones del itinerario">${tabs
    .map(
      ([key, ico, label, badge]) =>
        `<button type="button" class="${state.planTab === key ? "is-on" : ""}" data-action="plan-tab" data-tab="${key}" aria-pressed="${state.planTab === key}">${icon(ico, 17)}<span>${label}</span>${badge ? `<small>${esc(badge)}</small>` : ""}</button>`,
    )
    .join("")}</nav>`;
}

const missingExtras = () =>
  state.extras
    ? ""
    : `<div class="notice">${icon("file", 18)}<p><strong>Falta una parte de la base de datos.</strong> Ejecuta <code>supabase/extras.sql</code> en Supabase (SQL Editor) para poder guardar gastos y la lista de la maleta. Mientras tanto no se guardará nada.</p></div>`;

// ---------- gastos ----------

// Texto con las cuentas, para pegarlo en el chat del grupo.
export function ledgerText() {
  const rows = balances();
  const pay = settlements(rows);
  const lines = [`💶 Cuentas de «${document.title}»`, `Total gastado: ${eur(totalCents())} en ${plural(state.expenses.length, "gasto", "gastos")}`, ""];
  if (pay.length) {
    lines.push("Para quedar en paz:");
    for (const p of pay) lines.push(`• ${p.from} paga ${eur(p.cents)} a ${p.to}`);
  } else lines.push("Todos en paz: nadie debe nada 🎉");
  lines.push("", "Saldo de cada uno:");
  for (const r of rows) lines.push(`• ${r.name}: pagó ${eur(r.paid)}, le toca ${eur(r.owed)} (${r.balance > 0 ? "le deben " : r.balance < 0 ? "debe " : "al día"}${r.balance ? eur(Math.abs(r.balance)) : ""})`);
  return lines.join("\n");
}

function myLine(rows) {
  const me = canonical(getName());
  const mine = rows.find((r) => r.name.toLowerCase() === me.toLowerCase());
  if (!mine) return "";
  const text = mine.balance > 0 ? `Te deben ${eur(mine.balance)}` : mine.balance < 0 ? `Debes ${eur(-mine.balance)}` : "Estás al día";
  return `<p class="ledger-me ${mine.balance > 0 ? "is-plus" : mine.balance < 0 ? "is-minus" : ""}">${esc(text)}</p>`;
}

export function renderExpenses() {
  const head = (extra = "") => `<div class="page-head"><div><h2>Gastos</h2><p class="page-sub">Quién pagó qué y cuánto debe cada uno</p></div>
    <div class="head-actions">${extra}<button class="btn small primary" data-action="add-expense">${icon("plus", 16)} Añadir gasto</button></div></div>`;
  if (!state.expenses.length) {
    return `${head()}${missingExtras()}<div class="gate"><div class="gate-art">${icon("wallet", 34)}</div><h2>Todavía no hay gastos</h2>
      <p>Apunta lo que paga cada uno (cena, gasolina, alojamiento…) y la web calcula quién le debe a quién para que todos queden en paz.</p>
      <button class="btn primary" data-action="add-expense">${icon("plus", 18)} Añadir el primer gasto</button></div>`;
  }

  const rows = balances();
  const pay = settlements(rows);
  const total = totalCents();
  const everyone = new Set(rows.map((r) => r.name.toLowerCase())).size;
  const maxPaid = Math.max(...rows.map((r) => r.paid), 1);

  const hero = `<section class="ledger-hero">
    <p class="eyebrow">Cuentas del viaje</p>
    <h2>${esc(eur(total))}</h2>
    <p>${esc(plural(state.expenses.length, "gasto", "gastos"))} · ${esc(plural(everyone, "persona", "personas"))} · ${esc(eur(Math.round(total / Math.max(everyone, 1))))} por persona</p>
    ${myLine(rows)}
  </section>`;

  const settle = pay.length
    ? `<ul class="settle">${pay
        .map((p) => `<li>${avatar(p.from)}<span class="settle-names"><b>${esc(p.from)}</b> ${icon("arrowRight", 15)} <b>${esc(p.to)}</b></span><strong>${esc(eur(p.cents))}</strong></li>`)
        .join("")}</ul>`
    : `<p class="settle-ok">🎉 ¡Estáis en paz! Nadie debe nada.</p>`;

  const person = rows
    .map(
      (r) => `<li class="person">
      ${avatar(r.name, "lg")}
      <div class="person-body"><strong>${esc(r.name)}</strong>${r.name.toLowerCase() === canonical(getName()).toLowerCase() ? ` <small class="you">tú</small>` : ""}
        <p>Pagó ${esc(eur(r.paid))} · le tocan ${esc(eur(r.owed))}</p>
        <div class="bar thin"><i style="width:${Math.max(3, (r.paid / maxPaid) * 100)}%; background:hsl(${hueOf(r.name)} 65% 48%)"></i></div></div>
      <span class="balance ${r.balance > 0 ? "is-plus" : r.balance < 0 ? "is-minus" : ""}">${r.balance > 0 ? "+" : r.balance < 0 ? "−" : ""}${esc(eur(Math.abs(r.balance)))}</span>
    </li>`,
    )
    .join("");

  const byDay = new Map();
  for (const e of [...state.expenses].sort((a, b) => b.day.localeCompare(a.day) || b.created_at.localeCompare(a.created_at))) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }
  const days = [...byDay]
    .map(
      ([day, list]) => `<section class="exp-day"><h4>${esc(capitalize(fmtDayShort.format(utc(day))))} <small>${esc(eur(list.reduce((s, e) => s + cents(e.amount), 0)))}</small></h4>
      ${list
        .map((e) => {
          const split = [...shares(e).keys()];
          const who = split.length === everyone ? "entre todos" : `entre ${split.length}`;
          return `<button type="button" class="exp" data-action="edit-expense" data-id="${esc(e.id)}">
            ${avatar(e.paid_by)}
            <span class="exp-text"><strong>${esc(e.title)}</strong><small>Pagó ${esc(e.paid_by)} · ${esc(who)}${e.activity_id ? " · de una actividad" : ""}</small></span>
            <span class="exp-amount">${esc(money.format(Number(e.amount)))}</span>
          </button>`;
        })
        .join("")}</section>`,
    )
    .join("");

  const touch = typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches;
  return `${head(`<button class="btn small" data-action="share-ledger">${icon(touch ? "share" : "copy", 16)} ${touch ? "Compartir" : "Copiar"} resumen</button>`)}${missingExtras()}
    <div class="ledger-grid">
      <div class="ledger-side">${hero}
        <h3 class="sec-title">Para quedar en paz</h3>${settle}
        <h3 class="sec-title">Saldo de cada uno</h3><ul class="people">${person}</ul></div>
      <div class="ledger-main"><h3 class="sec-title">Gastos</h3>${days}</div>
    </div>`;
}

// ---------- maleta ----------

export const TYPICAL_ITEMS = [
  "Pasaportes o DNI", "Billetes y reservas", "Seguro de viaje", "Tarjetas y algo de efectivo", "Cargadores y cables", "Batería externa",
  "Adaptador de enchufe", "Gafas de sol", "Protector solar", "Botiquín básico", "Calzado cómodo", "Bañador", "Chaqueta", "Carnet de conducir",
];

const stripEmoji = (text) => text.replace(/^[^\p{L}\p{N}]+/u, "").trim();

// Sugerencias de la maleta según el tiempo previsto (o típico) del viaje, sin repetir lo que ya está en la lista.
export function packingSuggestions() {
  const have = new Set(state.checklist.map((i) => i.text.trim().toLowerCase()));
  const weather = allDays().slice(0, 14).map((d) => state.weather.get(d));
  return packingTips(weather).map(stripEmoji).filter((t) => t && !have.has(t.toLowerCase()));
}

function packingItem(item) {
  return `<li class="pack ${item.done ? "is-done" : ""}">
    <button type="button" class="pack-check" data-action="toggle-pack" data-id="${esc(item.id)}" aria-pressed="${Boolean(item.done)}" aria-label="${item.done ? "Marcar como pendiente" : "Marcar como listo"}: ${esc(item.text)}">${icon("check", 16)}</button>
    <span class="pack-text">${esc(item.text)}${item.done && item.done_by_name ? ` <small>· ${esc(item.done_by_name)}</small>` : ""}</span>
    ${item.assigned_to ? `<span class="chip muted">${esc(item.assigned_to)}</span>` : ""}
    <button type="button" class="icon-btn sm" data-action="delete-pack" data-id="${esc(item.id)}" aria-label="Quitar de la lista: ${esc(item.text)}">${icon("x", 16)}</button>
  </li>`;
}

export function renderPacking() {
  const items = state.checklist;
  const done = items.filter((i) => i.done).length;
  const names = people();
  const suggestions = packingSuggestions();
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const progress = `<section class="pack-hero ${items.length && done === items.length ? "is-full" : ""}">
    <div><p class="eyebrow">Lista de la maleta</p><h2>${items.length ? `${done} de ${items.length} listo` : "Empieza la lista"}</h2>
    <p>${items.length ? (done === items.length ? "🎉 ¡Todo preparado!" : `Faltan ${items.length - done} por preparar`) : "Todos pueden añadir y marcar cosas: se ve en tiempo real."}</p></div>
    <div class="ring" style="--p:${pct}"><span>${pct}%</span></div>
  </section>`;

  const form = `<form class="pack-form" data-form="pack">
    <input name="text" required maxlength="120" placeholder="Añadir a la lista (p. ej. paraguas)" autocomplete="off" enterkeyhint="done" value="${esc(state.drafts.pack || "")}">
    <select name="assigned_to" aria-label="Quién lo lleva"><option value="">Para todos</option>${names.map((n) => `<option ${n === state.drafts.packWho ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
    <button class="btn primary small" type="submit">${icon("plus", 16)} Añadir</button>
  </form>`;

  const chips = [
    ...suggestions.map((t) => `<button type="button" class="chip-filter" data-action="add-pack" data-text="${esc(t)}">${icon("sparkle", 13)} ${esc(t)}</button>`),
    TYPICAL_ITEMS.some((t) => !new Set(items.map((i) => i.text.trim().toLowerCase())).has(t.toLowerCase())) ? `<button type="button" class="chip-filter" data-action="add-typical-pack">${icon("plus", 13)} Añadir lo típico</button>` : "",
  ].join("");

  const pending = items.filter((i) => !i.done);
  const finished = items.filter((i) => i.done);
  const group = (title, list) => (list.length ? `<h3 class="sec-title">${esc(title)} <small>${list.length}</small></h3><ul class="packs">${list.map(packingItem).join("")}</ul>` : "");
  // Lo asignado a cada persona va aparte del "para todos".
  const shared = pending.filter((i) => !i.assigned_to);
  // "ana" y "Ana" son la misma persona: se agrupa sin distinguir mayúsculas y se muestra la grafía conocida.
  const perPerson = [...new Map(pending.filter((i) => i.assigned_to).map((i) => [i.assigned_to.trim().toLowerCase(), canonical(i.assigned_to)])).values()].sort((a, b) => a.localeCompare(b, "es"));
  const sections = [
    group("Por preparar", shared),
    ...perPerson.map((n) => group(`Lo lleva ${n}`, pending.filter((i) => i.assigned_to?.trim().toLowerCase() === n.toLowerCase()))),
    group("Listo", finished),
  ].join("");

  return `<div class="page-head"><div><h2>Maleta</h2><p class="page-sub">Qué llevar, compartido con todos</p></div></div>
    ${missingExtras()}${progress}${form}${chips ? `<div class="pack-suggest"><p class="hint">${suggestions.length ? "Sugerencias según el tiempo de esos días:" : "Atajos:"}</p><div class="filter-row wrap">${chips}</div></div>` : ""}${sections}`;
}
