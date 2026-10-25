// Reparto de gastos entre viajeros. Los "viajeros" son nombres de texto libre (los mismos que aparecen como autores).
// Todo se calcula en céntimos para que el redondeo sea exacto y igual en todos los dispositivos.
import { state } from "./state.js";
import { getName } from "./store.js";

export const cents = (amount) => Math.round(Number(amount) * 100);
export const fromCents = (c) => c / 100;

const clean = (name) => String(name ?? "").trim().replace(/\s+/g, " ").slice(0, 40);

// Nombres conocidos, sin duplicar por mayúsculas ("ana" y "Ana" son la misma persona). Conserva la primera grafía.
export function people(extra = []) {
  const seen = new Map();
  const add = (name) => {
    const n = clean(name);
    if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  };
  add(getName());
  for (const list of [state.expenses, state.checklist, state.activities, state.comments, state.photos]) {
    for (const item of list) add(item.created_by_name);
  }
  for (const e of state.expenses) {
    add(e.paid_by);
    for (const name of e.split ?? []) add(name);
  }
  for (const name of extra) add(name);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "es"));
}

// Devuelve la grafía conocida de un nombre (o la limpia si es nuevo).
export function canonical(name) {
  const n = clean(name);
  const known = people().find((p) => p.toLowerCase() === n.toLowerCase());
  if (known) return known;
  // Un nombre nuevo escrito todo en minúsculas ("marta") se guarda con inicial mayúscula.
  return n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}

// Un gasto sin importe, sin pagador o sin nadie con quien repartir no se puede contar (solo puede venir de datos antiguos).
export const isValid = (e) => Number.isFinite(Number(e.amount)) && Number(e.amount) > 0 && clean(e.paid_by) !== "" && (e.split ?? []).some((n) => clean(n) !== "");

// Parte de un gasto que le toca a cada persona (en céntimos). El resto de repartir se da de uno en uno,
// empezando por el primero de la lista, así el resultado no depende del dispositivo.
export function shares(expense) {
  const total = cents(expense.amount);
  const names = [...new Map((expense.split ?? []).filter((n) => clean(n)).map((n) => [clean(n).toLowerCase(), clean(n)])).values()];
  if (!names.length) return new Map();
  const base = Math.floor(total / names.length);
  const extra = total - base * names.length;
  return new Map(names.map((n, i) => [n, base + (i < extra ? 1 : 0)]));
}

// Para cada persona: lo que pagó, lo que le toca y la diferencia (positiva = le deben dinero).
export function balances(expenses = state.expenses) {
  const table = new Map(); // nombre en minúsculas -> { name, paid, owed }
  const row = (name) => {
    const key = clean(name).toLowerCase();
    if (!table.has(key)) table.set(key, { name: clean(name), paid: 0, owed: 0 });
    return table.get(key);
  };
  for (const e of expenses.filter(isValid)) {
    row(e.paid_by).paid += cents(e.amount);
    for (const [name, c] of shares(e)) row(name).owed += c;
  }
  return [...table.values()]
    .map((r) => ({ ...r, balance: r.paid - r.owed }))
    .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, "es"));
}

// Pagos mínimos para que todos queden en paz. Cada grupo de personas cuyos saldos suman cero se salda por separado
// y necesita (personas - 1) pagos como mucho, así que el mínimo total sale de partir a todos en el mayor número posible
// de grupos así. Con hasta 16 personas con saldo se busca ese reparto exacto; con más, se agrupa de forma aproximada.
export function settlements(rows = balances()) {
  const people = rows.filter((r) => r.balance !== 0).map((r) => ({ name: r.name, balance: r.balance }));
  const groups = people.length <= 16 ? zeroSumGroups(people) : [people];
  const payments = [];
  for (const group of groups) payments.push(...settleGroup(group));
  return payments;
}

// Parte la lista en el mayor número de grupos de suma cero (programación dinámica sobre subconjuntos).
function zeroSumGroups(people) {
  const n = people.length;
  if (n === 0) return [];
  const size = 1 << n;
  const sum = new Int32Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sum[mask] = sum[mask & (mask - 1)] + people[low].balance;
  }
  const best = new Int8Array(size);
  const from = new Int8Array(size);
  for (let mask = 1; mask < size; mask++) {
    let top = -1;
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      if (best[mask ^ (1 << i)] > top) {
        top = best[mask ^ (1 << i)];
        pick = i;
      }
    }
    best[mask] = top + (sum[mask] === 0 ? 1 : 0);
    from[mask] = pick;
  }
  // Se recupera el orden en que se fueron añadiendo las personas; los cortes donde la suma acumulada es cero separan los grupos.
  const order = [];
  for (let mask = size - 1; mask; mask ^= 1 << from[mask]) order.push(from[mask]);
  order.reverse();
  const groups = [];
  let current = [];
  let running = 0;
  for (const i of order) {
    current.push(people[i]);
    running += people[i].balance;
    if (running === 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

// El que más debe paga al que más le deben, y así hasta saldar el grupo.
function settleGroup(group) {
  const debtors = group.filter((r) => r.balance < 0).map((r) => ({ name: r.name, left: -r.balance }));
  const creditors = group.filter((r) => r.balance > 0).map((r) => ({ name: r.name, left: r.balance }));
  const byLeft = (a, b) => b.left - a.left || a.name.localeCompare(b.name, "es");
  const payments = [];
  while (debtors.length && creditors.length) {
    debtors.sort(byLeft);
    creditors.sort(byLeft);
    const d = debtors[0];
    const c = creditors[0];
    const amount = Math.min(d.left, c.left);
    payments.push({ from: d.name, to: c.name, cents: amount });
    d.left -= amount;
    c.left -= amount;
    if (d.left === 0) debtors.shift();
    if (c.left === 0) creditors.shift();
  }
  return payments;
}

export const totalCents = (expenses = state.expenses) => expenses.filter(isValid).reduce((sum, e) => sum + cents(e.amount), 0);

// Color estable para cada nombre (avatares).
export function hueOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
