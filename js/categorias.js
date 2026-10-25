// Categorías de gasto («¿En qué gastamos?»): la lista cerrada (la misma que admite la base de datos), la categoría de un gasto
// (la guardada o, en los antiguos, una inferida por las palabras del concepto), los totales por categoría y por persona, y el
// HTML de la tarjeta de Cuentas y del álbum. Todo en céntimos (con el reparto de ledger.js): ningún importe pasa por decimales.
import { state, ctx } from "./state.js";
import { esc, money, reducedMotion } from "./util.js";
import { cents, fromCents, shares, isValid, hueOf, clean } from "./ledger.js";

// `color` es el tono para papel (PDF); en pantalla los colores salen de css/categorias.css, que los adapta al tema oscuro.
export const CATEGORIES = [
  { key: "nafta", emoji: "⛽", label: "Nafta", color: "#b45309" },
  { key: "comida", emoji: "🍽️", label: "Comida", color: "#dc2626" },
  { key: "salidas", emoji: "🎟️", label: "Salidas", color: "#7c3aed" },
  { key: "transporte", emoji: "🚕", label: "Transporte", color: "#2563eb" },
  { key: "alojamiento", emoji: "🏨", label: "Alojamiento", color: "#0f766e" },
  { key: "compras", emoji: "🛒", label: "Compras", color: "#4d7c0f" },
  { key: "salud", emoji: "💊", label: "Salud", color: "#db2777" },
  { key: "otros", emoji: "🧾", label: "Otros", color: "#64748b" },
];
const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));
export const isCategory = (key) => BY_KEY.has(key);
export const categoryInfo = (key) => BY_KEY.get(key) ?? BY_KEY.get("otros");

// ---------- inferencia por palabras (para los gastos que no guardaron categoría) ----------

// Sin acentos ni mayúsculas: «Café» y «cafe» son lo mismo.
export const plain = (text) => String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const words = (list) => new RegExp(`\\b(?:${list.join("|")})\\b`);
// Cada regla: categoría, palabras y si es «débil» (una palabra genérica como «compra» solo vale si no hay otra pista).
// En empate manda la primera categoría de la lista (por eso «uber eats» es comida y «uber» a secas, transporte).
const RULES = [
  ["nafta", words(["naftas?", "gasolinas?", "gasolineras?", "combustibles?", "diesel", "gasoil", "tanque", "gas", "gas station", "estacion de servicio", "estaciones de servicio", "ypf", "shell", "chevron", "exxon"])],
  ["comida", words(["comidas?", "cenas?", "cenar", "cenamos", "almuerzos?", "almorzar", "almorzamos", "desayunos?", "desayunar", "meriendas?", "brunch", "lunch", "dinner", "breakfast", "restaurantes?", "restaurant", "parrilla", "cafes?", "cafeterias?", "cafecito", "bebidas?", "cervezas?", "vinos?", "tragos?", "gaseosas?", "refrescos?", "jugos?", "agua", "pizzas?", "pizzerias?", "hamburguesas?", "burgers?", "helados?", "heladerias?", "postres?", "sandwich(?:es)?", "empanadas?", "asado", "tacos?", "sushi", "snacks?", "supers?", "supermercados?", "mercados?", "almacen", "panaderias?", "pan", "frutas?", "verduras?", "hielo", "bar", "comer", "food", "uber eats", "rappi", "pedidos ya", "doordash", "delivery", "publix", "starbucks", "mcdonalds?", "burger king", "dunkin", "wendys?", "chipotle"])],
  ["salidas", words(["entradas?", "parques?", "disney\\w*", "universal", "magic kingdom", "epcot", "seaworld", "museos?", "salidas?", "playas?", "cines?", "shows?", "conciertos?", "teatros?", "zoologicos?", "zoo", "acuarios?", "paseos?", "excursion(?:es)?", "tours?", "airboat", "kayak", "cruceros?", "fiestas?", "boliches?", "discotecas?", "casino", "karaoke", "mini ?golf", "bowling", "aquatica"])],
  ["transporte", words(["peajes?", "tolls?", "sunpass", "e-?zpass", "telepeaje", "estacionamientos?", "parking", "parquimetros?", "cochera", "valet", "taxis?", "uber", "lyft", "cabify", "remis", "bus", "colectivos?", "omnibus", "autobus(?:es)?", "micros?", "tren(?:es)?", "metro", "subte", "vuelos?", "avion(?:es)?", "pasajes?", "aeropuertos?", "ferry", "traslados?", "transfer", "equipaje", "alquiler de (?:auto|coche|carro)s?", "auto de alquiler", "auto alquilado", "coche de alquiler", "rent a car", "renta de (?:auto|carro)s?", "rental car", "car rental"])],
  ["alojamiento", words(["hotel(?:es)?", "alojamientos?", "airbnb", "hostels?", "hospedajes?", "motel(?:es)?", "resort", "posada", "cabanas?", "habitacion(?:es)?", "booking", "check-?in", "apartamentos?", "departamentos?", "deptos?", "vrbo", "alquiler de (?:casa|depto|departamento|apartamento)"])],
  ["compras", words(["souvenirs?", "recuerdos?", "regalos?", "ropa", "remeras?", "camisetas?", "zapatillas", "calzado", "zapatos", "outlet", "mall", "shopping", "juguetes?", "perfumes?", "electronica", "gorras?", "mochilas?", "valijas?", "bolsos?"])],
  ["salud", words(["farmacias?", "medic\\w*", "remedios?", "pastillas?", "botiquin", "curitas?", "tiritas?", "vendajes?", "repelente", "aspirina", "ibuprofeno", "paracetamol", "analgesicos?", "doctor(?:a)?", "hospital", "clinica", "dentista", "urgencias", "seguro medico", "asistencia al viajero", "protector(?:es)?", "bloqueador(?:es)?", "bronceador(?:es)?", "sunscreen", "walgreens", "cvs", "vacunas?", "covid", "crema solar"])],
  ["compras", words(["compras?", "comprar", "compramos", "tienda"]), true],
];

// Clave que más probablemente corresponde a un texto, o null si ninguna palabra coincide. Gana la palabra que aparece antes
// («Estacionamiento del hotel» → transporte, «Desayuno en el hotel» → comida) y las genéricas solo si no hay otra.
function guessFrom(text) {
  const t = plain(text);
  let best = null;
  for (const [key, re, weak = false] of RULES) {
    const at = t.search(re);
    if (at < 0) continue;
    if (!best || (best.weak && !weak) || (best.weak === weak && at < best.at)) best = { key, at, weak };
  }
  return best?.key ?? null;
}

// Por el concepto; si no dice nada, por la tienda (una compra en «Publix» o en «Shell»). null = sin pistas.
export const guessCategory = (title, place = "") => guessFrom(title) ?? guessFrom(place);

// La categoría de un gasto: la guardada o, si falta (gastos antiguos), la inferida; «otros» si no hay pistas.
export const categoryOf = (expense) => (isCategory(expense?.category) ? expense.category : guessCategory(expense?.title, expense?.place) ?? "otros");
export const isGuessed = (expense) => !isCategory(expense?.category);

// ¿Faltan en Supabase las columnas nuevas de expenses (category, lat y lng: todo_en_uno.sql sin ejecutar)? Si ya hay gastos y
// ninguno trae la clave, sí. Con la base en modo demo las columnas siempre están.
export const categoryColumnMissing = () => ctx.store?.mode === "supabase" && state.expenses.length > 0 && state.expenses.every((e) => !("category" in e));
// Error de guardado por esas columnas ausentes (PostgREST: «Could not find the 'category' column of 'expenses' in the schema cache»;
// Postgres: «column "lat" of relation "expenses" does not exist»).
export const newColumnsError = (err) => /'(?:category|lat|lng)' column of 'expenses'|column "(?:category|lat|lng)" of relation "expenses"|expenses\.(?:category|lat|lng)\b.*does not exist/i.test(err?.message || String(err));

// Fila de la categoría del diálogo de gastos: las ocho como botones (una marcada) y «Sin categoría». `suggestion` es la que se
// calcula por el concepto: sale con borde discontinuo mientras no se elija otra, y se guarda solo si se toca.
export function categoryPickerHtml({ choice = "", suggestion = null } = {}) {
  const chip = (c) => {
    const on = choice === c.key;
    return `<button type="button" class="cat-chip cat-${c.key} ${!choice && suggestion === c.key ? "is-suggested" : ""}" data-cat-pick="${c.key}" aria-pressed="${on}"><span aria-hidden="true">${c.emoji}</span> ${esc(c.label)}</button>`;
  };
  const none = `<button type="button" class="cat-chip is-none" data-cat-pick="" aria-pressed="${!choice}">Sin categoría</button>`;
  const status = choice
    ? `Se guardará en: ${categoryInfo(choice).label}`
    : suggestion
      ? `Si no eliges, se calcula por el concepto: ${categoryInfo(suggestion).label}`
      : "Si no eliges, se calcula por el concepto";
  return `<legend>Categoría <small>${esc(status)}</small></legend><div class="cat-chips">${CATEGORIES.map(chip).join("")}${none}</div>`;
}

// ---------- totales ----------

// Por categoría: { total, count, guessed, rows: [{ ...categoría, cents, count, guessed }] } (solo las que tienen gastos, de mayor a menor).
export function categoryTotals(expenses = state.expenses) {
  const rows = new Map(CATEGORIES.map((c) => [c.key, { ...c, cents: 0, count: 0, guessed: 0 }]));
  let total = 0;
  let count = 0;
  let guessed = 0;
  for (const e of expenses.filter(isValid)) {
    const row = rows.get(categoryOf(e));
    const c = cents(e.amount);
    row.cents += c;
    row.count++;
    total += c;
    count++;
    if (isGuessed(e)) {
      row.guessed++;
      guessed++;
    }
  }
  return { total, count, guessed, rows: [...rows.values()].filter((r) => r.count).sort((a, b) => b.cents - a.cents) };
}

// Por persona: «owed» = lo que le toca a cada uno (su parte del reparto), «paid» = lo que adelantó. Los nombres se unen sin
// distinguir mayúsculas y salen con la grafía de balances() (se anota primero al que pagó, igual que allí).
// → { total, rows: [{ name, cents, byCat: Map(clave → céntimos) }] } (solo quien suma algo, de más a menos).
export function categoryPeople(expenses = state.expenses, mode = "owed") {
  const table = new Map();
  const row = (name) => {
    const key = clean(name).toLowerCase();
    if (!table.has(key)) table.set(key, { name: clean(name), cents: 0, byCat: new Map() });
    return table.get(key);
  };
  const add = (person, key, c) => {
    person.cents += c;
    person.byCat.set(key, (person.byCat.get(key) ?? 0) + c);
  };
  for (const e of expenses.filter(isValid)) {
    const key = categoryOf(e);
    const payer = row(e.paid_by);
    const split = shares(e);
    for (const name of split.keys()) row(name);
    if (mode === "paid") add(payer, key, cents(e.amount));
    else for (const [name, c] of split) add(row(name), key, c);
  }
  const rows = [...table.values()].filter((p) => p.cents > 0).sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name, "es"));
  return { total: rows.reduce((s, p) => s + p.cents, 0), rows };
}

// Todo lo que necesitan el álbum y el PDF.
export const categorySummary = (expenses = state.expenses) => ({ ...categoryTotals(expenses), owed: categoryPeople(expenses, "owed"), paid: categoryPeople(expenses, "paid") });

// ---------- HTML (ya escapado) ----------

const eur = (c) => money.format(fromCents(c));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pct = (c, total) => {
  const p = total ? (c * 100) / total : 0;
  return p > 0 && p < 1 ? "<1 %" : `${Math.round(p)} %`;
};
const dot = (name) => `<span class="person-dot" style="--h:${hueOf(name)}" aria-hidden="true">${esc(String(name).charAt(0).toUpperCase())}</span>`;

// Barras por categoría. Con `interactive`, cada fila es un botón que filtra la lista de gastos de Cuentas.
export function categoryBars(summary, { interactive = false, selected = "" } = {}) {
  const max = summary.rows[0]?.cents || 1;
  const row = (r) => {
    const inner = `<span class="cat-top"><span class="cat-name"><span aria-hidden="true">${r.emoji}</span> ${esc(r.label)}</span><strong class="cat-amount">${esc(eur(r.cents))}</strong></span>
      <span class="cat-bar" aria-hidden="true"><i style="width:${Math.max(3, (r.cents / max) * 100)}%"></i></span>
      <small class="cat-meta">${pct(r.cents, summary.total)} · ${plural(r.count, "apunte", "apuntes")}</small>`;
    return interactive
      ? `<button type="button" class="cat-row cat-${r.key}" data-action="cat-filter" data-cat="${r.key}" aria-pressed="${selected === r.key}">${inner}</button>`
      : `<div class="cat-row is-static cat-${r.key}">${inner}</div>`;
  };
  return `<div class="cat-list">${summary.rows.map(row).join("")}</div>`;
}

// Por persona: para cada una, su total, una barra apilada con sus categorías (la longitud compara a unas personas con otras)
// y el detalle en texto (así también se entiende sin distinguir colores y no hace falta una tabla ancha).
export function categoryPeopleHtml(data) {
  const max = data.rows[0]?.cents || 1;
  const order = CATEGORIES.map((c) => c.key);
  return `<ul class="cat-people">${data.rows
    .map((p) => {
      const parts = [...p.byCat].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
      const label = parts.map(([k, c]) => `${categoryInfo(k).label} ${eur(c)}`).join(", ");
      return `<li class="cat-person">
        <div class="cat-person-head">${dot(p.name)}<strong>${esc(p.name)}</strong><span class="cat-amount">${esc(eur(p.cents))}</span></div>
        <div class="cat-stack" style="width:${Math.max(4, (p.cents / max) * 100)}%" role="img" aria-label="${esc(`${p.name}: ${label}`)}">${parts.map(([k, c]) => `<i class="cat-${k}" style="flex:${c} 1 0"></i>`).join("")}</div>
        <ul class="cat-legend">${parts.map(([k, c]) => `<li class="cat-${k}"><span class="cat-dot" aria-hidden="true"></span><span aria-hidden="true">${categoryInfo(k).emoji}</span> ${esc(categoryInfo(k).label)} <b>${esc(eur(c))}</b></li>`).join("")}</ul>
      </li>`;
    })
    .join("")}</ul>`;
}

// ---------- tarjeta «¿En qué gastamos?» de Cuentas ----------

// Lo que se ve en la tarjeta (se conserva al repintar): la categoría que filtra la lista, «Todos / Por persona» y «le toca / pagó».
export const catView = { cat: "", mode: "todos", by: "owed" };

// El filtro solo vale mientras haya gastos de esa categoría (si se borran o se cambian, no puede quedar la lista vacía sin salida).
const activeCat = () => (catView.cat && state.expenses.some((e) => isValid(e) && categoryOf(e) === catView.cat) ? catView.cat : "");
export const matchesCategory = (e) => !activeCat() || categoryOf(e) === activeCat();

const segmented = (label, current, action, key, options) =>
  `<div class="segmented cat-switch" role="group" aria-label="${esc(label)}">${options.map(([value, text]) => `<button type="button" data-action="${action}" data-${key}="${value}" aria-pressed="${current === value}">${esc(text)}</button>`).join("")}</div>`;

export function renderCategoryCard() {
  const sum = categoryTotals();
  if (!sum.total) {
    return `<section class="cat-card" aria-label="¿En qué gastamos?"><h3 class="cat-title">¿En qué gastamos?</h3><p class="hint">Todavía no hay gastos con importe para resumir por categoría.</p></section>`;
  }
  const people = catView.mode === "personas";
  const data = people ? categoryPeople(state.expenses, catView.by) : null;
  const body = people
    ? `${segmented("Qué sumar por persona", catView.by, "cat-by", "by", [["owed", "Lo que le toca"], ["paid", "Lo que pagó"]])}
       <p class="hint">${catView.by === "owed" ? "La parte del reparto que corresponde a cada uno." : "Lo que adelantó cada uno al pagar."}</p>
       ${data.rows.length ? categoryPeopleHtml(data) : `<p class="hint">Nadie suma todavía.</p>`}`
    : `<p class="hint">Toca una categoría para ver solo esos gastos.</p>${categoryBars(sum, { interactive: true, selected: activeCat() })}`;
  return `<section class="cat-card" aria-label="¿En qué gastamos?">
    <h3 class="cat-title">¿En qué gastamos?</h3>
    <p class="cat-total">${esc(eur(sum.total))}</p>
    <p class="cat-sub">${esc(plural(sum.count, "apunte", "apuntes"))} · ${esc(plural(sum.rows.length, "categoría", "categorías"))}</p>
    ${segmented("Cómo verlo", catView.mode, "cat-mode", "mode", [["todos", "Todos"], ["personas", "Por persona"]])}
    ${body}
    ${sum.guessed ? `<p class="hint cat-foot">${esc(plural(sum.guessed, "apunte", "apuntes"))} sin categoría guardada: se ${sum.guessed === 1 ? "calcula" : "calculan"} por las palabras del concepto.</p>` : ""}
  </section>`;
}

// Aviso sobre la lista de gastos cuando se filtra por una categoría.
export function categoryNote() {
  const key = activeCat();
  if (!key) return "";
  const c = categoryInfo(key);
  return `<div class="cat-note cat-${key}" id="cat-list"><span>Mostrando solo <b><span aria-hidden="true">${c.emoji}</span> ${esc(c.label)}</b></span><button type="button" class="link-btn" data-action="cat-clear">Ver todo</button></div>`;
}

export const categoryActions = {
  "cat-filter": ({ cat }) => {
    catView.cat = catView.cat === cat ? "" : isCategory(cat) ? cat : "";
    ctx.actions.render();
    // La lista queda debajo de la tarjeta: se baja hasta ella para que se vea qué ha hecho el toque.
    if (catView.cat) requestAnimationFrame(() => document.getElementById("cat-list")?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" }));
  },
  "cat-clear": () => {
    catView.cat = "";
    ctx.actions.render();
  },
  "cat-mode": ({ mode }) => {
    catView.mode = mode === "personas" ? "personas" : "todos";
    ctx.actions.render();
  },
  "cat-by": ({ by }) => {
    catView.by = by === "paid" ? "paid" : "owed";
    ctx.actions.render();
  },
};
