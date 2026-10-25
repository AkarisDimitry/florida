// Juego «Bolsa de valores»: cada viajero recibe 200.000 $ de mentira y compra y vende 10 activos inventados con temática de
// viaje. Contrato del módulo en docs/JUEGOS.md; SQL y reglas en supabase/juego_bolsa.sql.
//
// Quién manda: la base de datos. Los precios son una función de la hora (market_price), las cuentas y las operaciones solo se
// escriben con place_trade / join_market / reset_market, y el ranking, las posiciones y el coste medio los calculan
// invest_leaderboard e invest_positions. Aquí solo se piden esos datos y se pintan; el navegador nunca envía un precio.
import { state, ctx } from "../state.js";
import { icon } from "../icons.js";
import { esc, toast, ago } from "../util.js";
import { getName } from "../store.js";
import { hueOf } from "../ledger.js";

export const meta = { id: "bolsa", title: "Bolsa de valores", emoji: "📈", blurb: "200.000 $ de mentira cada uno: compra, vende y mira qué hacen los demás." };

const START_CASH = 200_000;
const POLL_MS = 15_000; // refresco mientras el juego está abierto y la pestaña visible
const SLOW_MS = 55_000; // los precios cambian cada minuto: mini gráficos y gráfico grande se piden como mucho una vez por minuto
const FEED_STEP = 20;
const RANGES = [[24, "24 h"], [48, "48 h"], [168, "7 días"]];
const QUICK_BUY = [1000, 10_000, 50_000];
const QUICK_SELL = [[0.25, "Un cuarto"], [0.5, "La mitad"], [1, "Todo"]];
const MISSING = new Set(["42883", "42P01", "PGRST202", "PGRST205"]); // función o tabla inexistente: falta ejecutar el SQL

// ---------- formato (español) ----------

const CUR = { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", useGrouping: "always" };
const usd2 = new Intl.NumberFormat("es", CUR);
const usd0 = new Intl.NumberFormat("es", { ...CUR, minimumFractionDigits: 0, maximumFractionDigits: 0 });
// Cantidades: las operaciones admiten 6 decimales, pero en pantalla se enseñan solo los que hacen falta para leerlas bien.
const qtyFmts = [6, 3, 2].map((d) => new Intl.NumberFormat("es", { maximumFractionDigits: d, useGrouping: "always" }));
const pctFmt = [0, 1, 2].map((d) => new Intl.NumberFormat("es", { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (n) => usd2.format(n);
const money0 = (n) => usd0.format(n);
const fmtQty = (n) => qtyFmts[Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 1 : 0].format(n);
const units = (n) => `${fmtQty(n)} ${Number(n) === 1 ? "unidad" : "unidades"}`;
// El signo sale del valor ya redondeado: -0,001 se ve como «0,00», no como «−0,00».
const sign = (n, d = 2) => {
  const r = Math.round(Math.abs(n) * 10 ** d);
  return r === 0 ? 0 : n > 0 ? 1 : -1;
};
const trend = (n, d = 2) => ["down", "flat", "up"][sign(n, d) + 1];
const ARROW = { up: "▲", down: "▼", flat: "–" };
const signCh = (n, d = 2) => ["−", "", "+"][sign(n, d) + 1];
const sMoney = (n, f = money) => `${signCh(n)}${f(Math.abs(n))}`;
const sPct = (n, d = 2) => `${signCh(n, d)}${pctFmt[d].format(Math.abs(n))} %`;
// Para el álbum (PDF): sin símbolos raros ni espacios especiales.
const plain = (text) => String(text).replace(/[  ]/g, " ").replace(/−/g, "-");
const delta = (n, text, d = 2) => {
  const t = trend(n, d);
  return `<span class="bolsa-delta ${t}"><span aria-hidden="true">${ARROW[t]}</span>${esc(text)}</span>`;
};
const avatar = (name, size = "") => `<span class="person-dot ${size}" style="--h:${hueOf(name)}" aria-hidden="true">${esc(String(name).charAt(0).toUpperCase())}</span>`;
const ordinal = (n) => `${n}.º`;

// ---------- estado del módulo ----------

const S = {
  active: false, // el juego está abierto
  loaded: false,
  loading: false,
  again: false, // llegó otra petición de carga mientras se cargaba
  missing: false, // faltan las funciones o tablas: ejecutar todo_en_uno.sql
  error: "", // no se pudo cargar nada todavía
  stale: false, // el último refresco falló: se ven los últimos datos
  tab: "market", // market | portfolio | players
  player: null, // user_id del jugador cuya cartera se mira (pestaña Jugadores)
  feedShown: FEED_STEP,
  assets: [],
  sparks: {}, // símbolo -> [{t, price}]
  sparksAt: 0,
  board: [],
  positions: [],
  feed: [], // últimas operaciones de todos
  mine: [], // mis últimas operaciones
  playerTrades: [],
  playerFor: null, // de quién son las operaciones de playerTrades (para no decir «ninguna» mientras cargan)
  best: null,
  worst: null,
  lightAt: 0,
  lightTried: 0, // última vez que summary() pidió los datos por su cuenta
  dirty: false, // se salió del juego: lo cargado puede haber quedado atrás
  sheet: null, // ficha abierta: { symbol, side, choice, text, hours }
  history: [],
  historyKey: "",
  historyAt: 0,
  busy: false, // enviando una operación o un reinicio
  joining: false,
  result: null, // última operación hecha en la ficha (lo que devolvió place_trade)
  err: "", // error del servidor mostrado dentro de la ficha
  timer: null,
  channel: null,
  nudgeTimer: null,
  sig: "",
  sheetScroll: 0,
  focusSheet: false,
  animateSheet: false, // la ficha solo se anima al abrirse, no en cada repintado
  reveal: false, // llevar el botón de confirmar a la vista tras elegir un importe
  refocus: "",
};

const sb = () => ctx.store?.sb;
const myId = () => ctx.store?.user?.id ?? null;
const me = () => S.board.find((b) => b.user_id === myId()) ?? null;
const asset = (symbol) => S.assets.find((a) => a.symbol === symbol) ?? null;
const holding = (uid, symbol) => S.positions.find((p) => p.user_id === uid && p.symbol === symbol) ?? null;
const rerender = () => ctx.actions?.render?.();
const repaint = () => S.active && rerender();

export const available = () => !S.missing;

// ---------- acceso a datos ----------

const isMissing = (e) => MISSING.has(e?.code) || /could not find the (function|table)|schema cache/i.test(e?.message || "");
const friendly = (err) => {
  const m = String(err?.message || err || "");
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) return "No hay conexión con el servidor. Inténtalo de nuevo en un momento.";
  return m || "Algo ha fallado. Inténtalo de nuevo.";
};

async function rpc(name, args) {
  const { data, error } = await sb().rpc(name, args);
  if (error) {
    if (isMissing(error)) S.missing = true;
    throw error;
  }
  return data;
}
async function rows(query) {
  const { data, error } = await query;
  if (error) {
    if (isMissing(error)) S.missing = true;
    throw error;
  }
  return data ?? [];
}
const trades = () => sb().from("invest_trades").select("*");

// Lo mínimo para el ranking, la etiqueta de la lista y el álbum.
async function loadLight() {
  const [board, bw] = await Promise.all([rpc("invest_leaderboard"), rpc("invest_best_worst")]);
  S.board = board ?? [];
  S.best = (bw ?? []).find((r) => r.kind === "best") ?? null;
  S.worst = (bw ?? []).find((r) => r.kind === "worst") ?? null;
  S.lightAt = Date.now();
  S.dirty = false;
  const s = summary();
  if (s) state.games.bolsa = s;
  else delete state.games.bolsa;
}

const groupSparks = (list) => {
  const out = {};
  for (const r of list ?? []) (out[r.symbol] ??= []).push({ t: r.t, price: Number(r.price) });
  for (const k of Object.keys(out)) out[k].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return out;
};
const histKey = () => (S.sheet ? `${S.sheet.symbol}:${S.sheet.hours}` : "");

async function loadHistory() {
  if (!S.sheet) return;
  const key = histKey();
  const { symbol, hours } = S.sheet;
  const data = await rpc("market_history", { p_symbol: symbol, p_hours: hours, p_points: 96 });
  if (histKey() !== key) return; // se cambió de activo o de periodo mientras llegaba
  S.history = (data ?? []).map((p) => ({ t: p.t, price: Number(p.price) }));
  S.historyKey = key;
  S.historyAt = Date.now();
}

// Una consulta pequeña por cosa; todas a la vez. Si entra otra petición mientras se carga, se repite al terminar.
async function loadAll({ force = false } = {}) {
  if (!sb()) return;
  if (S.loading) {
    S.again = true;
    return;
  }
  S.loading = true;
  try {
    const slow = force || Date.now() - S.sparksAt > SLOW_MS || !Object.keys(S.sparks).length;
    const uid = myId();
    const pl = S.player;
    const [assets, board, positions, feed, mine, bw, sparks, playerTrades] = await Promise.all([
      rpc("market_prices"),
      rpc("invest_leaderboard"),
      rpc("invest_positions"),
      rows(trades().order("id", { ascending: false }).limit(60)),
      uid ? rows(trades().eq("user_id", uid).order("id", { ascending: false }).limit(40)) : [],
      rpc("invest_best_worst"),
      slow ? rpc("market_sparks", { p_hours: 24, p_points: 24 }) : null,
      pl ? rows(trades().eq("user_id", pl).order("id", { ascending: false }).limit(40)) : [],
    ]);
    if (S.sheet && (force || S.historyKey !== histKey() || Date.now() - S.historyAt > SLOW_MS)) await loadHistory().catch(() => {});
    Object.assign(S, { assets, board, positions, feed, mine, playerTrades, playerFor: pl });
    S.best = (bw ?? []).find((r) => r.kind === "best") ?? null;
    S.worst = (bw ?? []).find((r) => r.kind === "worst") ?? null;
    if (sparks) {
      S.sparks = groupSparks(sparks);
      S.sparksAt = Date.now();
    }
    S.lightAt = Date.now();
    S.dirty = false;
    S.loaded = true;
    S.error = "";
    S.stale = false;
    const s = summary();
    if (s) state.games.bolsa = s;
    else delete state.games.bolsa;
  } catch (err) {
    if (!S.missing) console.warn("Bolsa:", err?.message || err);
    if (S.loaded) S.stale = true;
    else S.error = friendly(err);
  } finally {
    S.loading = false;
  }
  const sig = JSON.stringify([S.assets, S.board, S.positions, S.feed, S.mine, S.playerTrades, S.history.length && S.history[S.history.length - 1], S.sparksAt, S.error, S.stale, S.missing]);
  const changed = sig !== S.sig;
  S.sig = sig;
  // No se repinta mientras se escribe un importe (el teclado del móvil no debe saltar); el resumen se actualiza sin repintar.
  if (document.activeElement?.matches?.("[data-keep^=bolsa]")) refreshPlanDom();
  else if (changed || S.missing) repaint();
  if (S.again) {
    S.again = false;
    loadAll();
  }
}

// Consulta ligera desde la lista de juegos: para «Tú: +3,2 %» y para el álbum.
export async function peek() {
  if (!sb()) return;
  try {
    await loadLight();
  } catch (err) {
    if (!S.missing) console.warn("Bolsa:", err?.message || err);
  }
  if (state.view === "games" && !state.game) rerender();
}

// ---------- ciclo de vida ----------

const tick = () => {
  if (!document.hidden && !S.busy) loadAll();
};
const onVisible = () => {
  if (!document.hidden) tick();
};
const onKey = (event) => {
  if (event.key === "Escape" && S.sheet && !S.busy) closeSheet();
};
const nudge = () => {
  clearTimeout(S.nudgeTimer);
  S.nudgeTimer = setTimeout(tick, 500);
};

export function enter() {
  S.active = true;
  S.sheet = null;
  S.result = null;
  S.err = "";
  S.sig = "";
  loadAll({ force: true });
  clearInterval(S.timer);
  S.timer = setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("keydown", onKey);
  if (!S.channel && sb()) {
    // Tiempo real opcional: las operaciones nuevas (y el reinicio) llegan al instante. Sin él, vale el refresco cada 15 s.
    try {
      S.channel = sb().channel("viaje-bolsa").on("postgres_changes", { event: "*", schema: "public", table: "invest_trades" }, nudge).subscribe();
    } catch (err) {
      console.warn("Bolsa: sin tiempo real:", err?.message || err);
    }
  }
}

export function leave() {
  S.active = false;
  clearInterval(S.timer);
  clearTimeout(S.nudgeTimer);
  S.timer = null;
  document.removeEventListener("visibilitychange", onVisible);
  document.removeEventListener("keydown", onKey);
  if (S.channel) {
    try {
      sb()?.removeChannel(S.channel);
    } catch {
      /* ya estaba cerrado */
    }
    S.channel = null;
  }
  S.sheet = null;
  S.dirty = true;
  document.body.style.overflow = "";
}

// ---------- etiqueta de la lista y álbum ----------

export const badge = () => {
  if (S.missing || !S.lightAt) return "";
  const mine = me();
  return mine ? `Tú: ${sPct(Number(mine.pnl_pct), 1)}` : "Entra y recibe 200.000 $";
};

// Podio, mejor y peor operación (ganancia frente al precio de hoy; ver juego_bolsa.sql), jugador más activo y operaciones.
// Es síncrona: usa lo último que se cargó. Si el álbum se abre sin haber pasado por el juego (o hace más de un minuto, o se
// salió del juego), pide los datos en segundo plano (como mucho cada 10 s) y vuelve a pintar el álbum cuando llegan.
export function summary() {
  const old = !S.lightAt || S.dirty || Date.now() - S.lightAt > 60_000;
  if (old && sb() && !S.missing && Date.now() - S.lightTried > 10_000) {
    S.lightTried = Date.now();
    loadLight().then(() => state.view === "album" && S.board.length && rerender(), () => {});
  }
  const ops = S.board.reduce((n, b) => n + Number(b.trades_count || 0), 0);
  if (!ops) return null;
  const line = (r) => `${r.name} ${r.side === "buy" ? "compró" : "vendió"} ${fmtQty(r.qty)} ${r.asset_name ?? r.symbol} a ${money(r.price)} (${sMoney(Number(r.gain))} frente al precio de hoy)`;
  const top = S.board.slice(0, 3);
  const busiest = [...S.board].sort((a, b) => b.trades_count - a.trades_count)[0];
  const lines = top.map((b, i) => `${ordinal(i + 1)} ${b.name}: ${money0(b.total)} (${sPct(Number(b.pnl_pct))})`);
  if (S.best) lines.push(`Mejor operación: ${line(S.best)}`);
  if (S.worst && S.worst.id !== S.best?.id) lines.push(`Peor operación: ${line(S.worst)}`);
  const highlights = [
    { label: "Ganador", value: `${top[0].name} (${money0(top[0].total)}, ${sPct(Number(top[0].pnl_pct))})` },
    { label: "Jugador más activo", value: `${busiest.name} (${busiest.trades_count} operaciones)` },
    { label: "Operaciones", value: String(ops) },
  ];
  return { lines: lines.map(plain), highlights: highlights.map((h) => ({ label: h.label, value: plain(h.value) })), images: [] };
}

// ---------- gráficos (SVG sin dependencias) ----------

function spark(points) {
  const W = 84;
  const H = 28;
  if (!points || points.length < 2) return `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true"></svg>`;
  const v = points.map((p) => p.price);
  const lo = Math.min(...v);
  const range = Math.max(...v) - lo || 1;
  const d = v.map((y, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * (W - 4) + 2).toFixed(1)} ${(H - 3 - ((y - lo) / range) * (H - 6)).toFixed(1)}`).join("");
  return `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

function chart(points, hours, name) {
  if (!points || points.length < 2) return `<div class="bolsa-chart is-empty" role="status">Cargando el gráfico…</div>`;
  const W = 320;
  const H = 150;
  const v = points.map((p) => p.price);
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const pad = (hi - lo || hi * 0.01) * 0.12;
  const min = lo - pad;
  const max = hi + pad;
  const y = (p) => H - ((p - min) / (max - min)) * H;
  const line = v.map((p, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * W).toFixed(1)} ${y(p).toFixed(1)}`).join("");
  const first = v[0];
  const last = v[v.length - 1];
  const t = trend(last / first - 1);
  const label = hours === 168 ? "7 días" : `${hours} horas`;
  return `<div class="bolsa-chart ${t}" role="img" aria-label="Gráfico de ${esc(name)} en ${label}: empezó en ${money(first)}, ahora está en ${money(last)}; máximo ${money(hi)}, mínimo ${money(lo)}.">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <line class="grid" x1="0" x2="${W}" y1="${H * 0.25}" y2="${H * 0.25}"/><line class="grid" x1="0" x2="${W}" y1="${H * 0.5}" y2="${H * 0.5}"/><line class="grid" x1="0" x2="${W}" y1="${H * 0.75}" y2="${H * 0.75}"/>
        <path class="area" d="${line}L${W} ${H}L0 ${H}Z"/><path class="line" d="${line}" vector-effect="non-scaling-stroke"/>
      </svg>
      <span class="bolsa-chart-hi">${esc(money(hi))}</span><span class="bolsa-chart-lo">${esc(money(lo))}</span>
      <span class="bolsa-dot" style="top:${((y(last) / H) * 100).toFixed(1)}%"></span>
    </div>
    <div class="bolsa-chart-axis" aria-hidden="true"><span>hace ${hours === 168 ? "7 días" : `${hours} h`}</span><span>ahora</span></div>`;
}

// ---------- operar: cálculo de la operación (la base de datos lo vuelve a comprobar todo) ----------

function parseAmount(text) {
  let t = String(text).replace(/[\s$€]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

// Todo en enteros (céntimos y millonésimas de unidad) para que el total sea exacto al céntimo, como en el servidor.
const totalC = (qMicro, priceC) => Math.round((qMicro * priceC) / 1e6);
function microFor(budgetC, priceC) {
  let q = Math.floor((budgetC * 1e6) / priceC);
  while (q > 0 && totalC(q, priceC) > budgetC) q--;
  return q;
}

// Devuelve { ok, qty, total, text, note } o { ok:false, msg } según lo elegido en la ficha.
function planFor(priceOverride) {
  const sh = S.sheet;
  const a = sh && asset(sh.symbol);
  const mine = me();
  if (!sh?.side || !a || !mine) return null;
  const price = priceOverride ?? Number(a.price);
  const priceC = Math.round(price * 100);
  const cash = Number(mine.cash);
  const cashC = Math.round(cash * 100);
  const pos = holding(myId(), sh.symbol);
  const held = pos ? Number(pos.qty) : 0;
  const heldMicro = Math.round(held * 1e6);
  const MAX_MICRO = 1e12;
  if (sh.side === "buy") {
    let budgetC = null;
    if (sh.choice?.kind === "cash") budgetC = cashC;
    else if (sh.choice?.kind === "usd") budgetC = sh.choice.value * 100;
    else if (sh.text.trim()) {
      const v = parseAmount(sh.text);
      if (v == null) return { ok: false, msg: "Escribe un importe con números, por ejemplo 5000." };
      budgetC = Math.round(v * 100);
    }
    if (budgetC == null) return { ok: false, msg: "Elige cuánto quieres comprar o escribe un importe." };
    if (budgetC > cashC) return { ok: false, msg: `No tienes tanto dinero: tienes ${money(cash)}.` };
    if (budgetC < 100) return { ok: false, msg: "La operación mínima es de 1 $." };
    const q = Math.min(microFor(budgetC, priceC), MAX_MICRO);
    const total = totalC(q, priceC) / 100;
    if (q <= 0 || total < 1) return { ok: false, msg: "La operación mínima es de 1 $." };
    return { ok: true, qty: q / 1e6, total, text: `Comprarás ≈ ${units(q / 1e6)} por ${money(total)}`, note: `Precio ahora: ${money(price)} por unidad. Te quedarán ${money(cash - total)}.` };
  }
  if (!heldMicro) return { ok: false, msg: "No tienes unidades de este activo para vender." };
  let q = null;
  if (sh.choice?.kind === "frac") q = sh.choice.value === 1 ? heldMicro : Math.floor(heldMicro * sh.choice.value);
  else if (sh.text.trim()) {
    const v = parseAmount(sh.text);
    if (v == null) return { ok: false, msg: "Escribe un importe con números, por ejemplo 5000." };
    q = Math.min(Math.floor((Math.round(v * 100) * 1e6) / priceC), heldMicro);
  }
  if (q == null) return { ok: false, msg: "Elige cuánto quieres vender o escribe un importe." };
  const all = q >= heldMicro;
  const total = totalC(q, priceC) / 100;
  if (q <= 0 || (total < 1 && !all)) return { ok: false, msg: "La operación mínima es de 1 $." };
  return {
    ok: true,
    qty: all ? held : q / 1e6,
    total,
    text: `Venderás ${all ? "todo: " : ""}${units(all ? held : q / 1e6)} y recibirás ≈ ${money(total)}`,
    note: `Precio ahora: ${money(price)} por unidad. ${all ? "Te quedarás sin este activo." : `Te quedarán ${units(held - q / 1e6)}.`}`,
  };
}

// Mientras se escribe se actualiza solo el resumen y el botón, sin repintar la página (el campo no pierde el foco).
function refreshPlanDom() {
  const box = document.getElementById("bolsa-plan");
  const btn = document.getElementById("bolsa-confirm");
  if (!box || !btn || !S.sheet) return;
  const plan = planFor();
  box.innerHTML = planHtml(plan);
  btn.disabled = !plan?.ok || S.busy;
}
const planHtml = (plan) => (plan?.ok ? `<strong>${esc(plan.text)}</strong><small>${esc(plan.note)}</small>` : `<span>${esc(plan?.msg ?? "")}</span>`);

async function placeTrade() {
  const sh = S.sheet;
  if (!sh?.side || S.busy) return;
  const plan = planFor();
  if (!plan?.ok) return;
  S.busy = true;
  S.err = "";
  S.result = null;
  rerender();
  try {
    // El precio lo pone el servidor al ejecutar; antes se pide el vigente para calcular la cantidad con él.
    let current = Number(await rpc("market_price", { p_symbol: sh.symbol }));
    let attempt = 0;
    for (;;) {
      attempt++;
      const p = planFor(current) ?? plan;
      try {
        const data = await rpc("place_trade", { p_symbol: sh.symbol, p_side: sh.side, p_qty: Number(p.qty.toFixed(6)) });
        S.result = Array.isArray(data) ? data[0] : data;
        break;
      } catch (err) {
        // «Todo mi efectivo» justo al cambiar de minuto: el precio subió unos céntimos y ya no alcanza. Se repite una vez.
        if (attempt < 2 && sh.choice?.kind === "cash" && /No tienes suficiente dinero/.test(err?.message || "")) {
          current = Number(await rpc("market_price", { p_symbol: sh.symbol }));
          continue;
        }
        throw err;
      }
    }
    Object.assign(sh, { side: null, choice: null, text: "" });
    S.reveal = "live";
    await loadAll({ force: true });
  } catch (err) {
    S.err = friendly(err);
    S.reveal = "live";
    if (!S.sheet) toast(S.err);
  } finally {
    S.busy = false;
    repaint();
  }
}

// ---------- fichas HTML ----------

const tile = (emoji) => `<span class="bolsa-tile" aria-hidden="true">${esc(emoji)}</span>`;

function assetRow(a) {
  const pos = holding(myId(), a.symbol);
  const ch = Number(a.change_24h_pct);
  const t = trend(ch);
  return `<button type="button" class="bolsa-asset" data-action="bolsa-open" data-symbol="${esc(a.symbol)}" aria-label="${esc(a.name)}: ${esc(money(a.price))}, ${esc(sPct(ch))} en 24 horas. Abrir la ficha">
    ${tile(a.emoji)}
    <span class="bolsa-name"><strong>${esc(a.name)}</strong><small>${esc(a.symbol)}${pos ? ` · Tienes ${esc(fmtQty(pos.qty))}` : ""}</small></span>
    <span class="bolsa-spark ${t}">${spark(S.sparks[a.symbol])}</span>
    <span class="bolsa-px">${esc(money(a.price))}</span>
    <span class="bolsa-chg">${delta(ch, sPct(ch))}</span>
  </button>`;
}

function positionRow(p) {
  const a = asset(p.symbol);
  const cost = Number(p.value) - Number(p.pnl);
  const pct = cost > 0 ? (Number(p.pnl) / cost) * 100 : 0;
  return `<button type="button" class="bolsa-asset bolsa-pos" data-action="bolsa-open" data-symbol="${esc(p.symbol)}" aria-label="${esc(a?.name ?? p.symbol)}: ${esc(units(p.qty))}, valen ${esc(money(p.value))}. Abrir la ficha">
    ${tile(a?.emoji ?? "📊")}
    <span class="bolsa-name"><strong>${esc(a?.name ?? p.symbol)}</strong><small>${esc(units(p.qty))} · coste medio ${esc(money(p.avg_cost))}</small></span>
    <span class="bolsa-px">${esc(money(p.value))}</span>
    <span class="bolsa-chg">${delta(Number(p.pnl), `${sMoney(Number(p.pnl))} (${sPct(pct)})`)}</span>
  </button>`;
}

function tradeLine(t, mineList = false) {
  const a = asset(t.symbol);
  const buy = t.side === "buy";
  const mine = t.user_id === myId();
  const who = mineList ? "" : mine ? `<b>Tú</b> ` : `<b>${esc(t.name)}</b> `;
  const verb = mineList ? (buy ? "Compraste" : "Vendiste") : mine ? (buy ? "compraste" : "vendiste") : buy ? "compró" : "vendió";
  return `<li class="bolsa-trade">
    ${mineList ? `<span class="bolsa-tradeico ${buy ? "up" : "down"}" aria-hidden="true">${buy ? "+" : "−"}</span>` : avatar(t.name)}
    <p>${who}${verb} <b>${esc(fmtQty(t.qty))}</b> <span aria-hidden="true">${esc(a?.emoji ?? "")}</span> ${esc(a?.name ?? t.symbol)} a <b>${esc(money(t.price))}</b>
      <small>Total ${esc(money(t.total))} · ${esc(ago(Date.parse(t.created_at)))}</small></p>
  </li>`;
}

const empty = (emoji, title, text, button = "") => `<div class="bolsa-empty"><span aria-hidden="true">${emoji}</span><strong>${esc(title)}</strong><p>${esc(text)}</p>${button}</div>`;

function hero(mine) {
  const total = Number(mine.total);
  const gain = total - START_CASH;
  const pct = Number(mine.pnl_pct);
  const t = trend(gain);
  const rank = S.board.findIndex((b) => b.user_id === mine.user_id) + 1;
  const word = t === "up" ? "Vas ganando" : t === "down" ? "Vas perdiendo" : "Sin cambios";
  return `<section class="bolsa-hero" aria-label="Mi patrimonio">
    <p class="eyebrow">Mi patrimonio</p>
    <h2 class="bolsa-total">${esc(money(total))}</h2>
    <p class="bolsa-pill ${t}"><span aria-hidden="true">${ARROW[t]}</span> ${esc(word)}: ${esc(sMoney(gain))} (${esc(sPct(pct))})</p>
    <dl class="bolsa-hero-stats">
      <div><dt>Efectivo</dt><dd>${esc(money0(mine.cash))}</dd></div>
      <div><dt>En activos</dt><dd>${esc(money0(mine.holdings_value))}</dd></div>
      <div><dt>Puesto</dt><dd>${S.board.length > 1 ? `${esc(ordinal(rank))} de ${S.board.length}` : "—"}</dd></div>
    </dl>
  </section>`;
}

const joinCard = () => `<section class="bolsa-join" aria-label="Entrar a la bolsa">
    <span class="bolsa-join-art" aria-hidden="true">📈</span>
    <h2>Entra a la bolsa</h2>
    <p>Recibes <strong>200.000 $</strong> de mentira para comprar y vender. Todos ven lo que hacen los demás: ¡gana quien tenga más al final!</p>
    <button type="button" class="btn primary bolsa-big" data-action="bolsa-join" ${S.joining ? "disabled" : ""}>${S.joining ? "Entrando…" : "Entrar"}</button>
  </section>`;

function tabs() {
  const t = [["market", "Mercado"], ["portfolio", "Mi cartera"], ["players", "Jugadores"]];
  return `<div class="segmented bolsa-tabs" role="group" aria-label="Secciones de la bolsa">${t
    .map(([k, label]) => `<button type="button" data-action="bolsa-tab" data-tab="${k}" aria-pressed="${S.tab === k}">${label}</button>`)
    .join("")}</div>`;
}

function marketTab() {
  return `<p class="hint bolsa-note">Los precios se mueven cada minuto y son iguales para todos. Toca un activo para ver su gráfico y operar.</p>
    <div class="bolsa-assets">${S.assets.map(assetRow).join("")}</div>`;
}

function portfolioTab(mine) {
  if (!mine) return empty("🧾", "Aún no estás dentro", "Entra a la bolsa para tener tu propia cartera.");
  const own = S.positions.filter((p) => p.user_id === mine.user_id);
  const list = own.length
    ? `<div class="bolsa-assets">${own.map(positionRow).join("")}</div>`
    : empty("🛒", "Todavía no tienes activos", `Tienes ${money(mine.cash)} en efectivo. Mira el mercado y compra tu primer activo.`, `<button type="button" class="btn primary" data-action="bolsa-tab" data-tab="market">Ver el mercado</button>`);
  const ops = S.mine.length ? `<ul class="bolsa-trades">${S.mine.slice(0, 15).map((t) => tradeLine(t, true)).join("")}</ul>` : `<p class="hint">Todavía no has hecho ninguna operación.</p>`;
  return `<h3 class="sec-title">Mis activos</h3>${list}<h3 class="sec-title">Mis operaciones</h3>${ops}`;
}

function rankRow(b, i) {
  const medal = ["🥇", "🥈", "🥉"][i];
  const pct = Number(b.pnl_pct);
  const mine = b.user_id === myId();
  return `<button type="button" class="bolsa-rank ${mine ? "is-me" : ""}" data-action="bolsa-player" data-id="${esc(b.user_id)}" aria-label="${esc(ordinal(i + 1))} ${esc(b.name)}: ${esc(money0(b.total))}. Ver su cartera">
    <span class="bolsa-pos-n" aria-hidden="true">${medal ?? i + 1}</span>
    ${avatar(b.name, "lg")}
    <span class="bolsa-name"><strong>${esc(b.name)}${mine ? ` <small class="you">tú</small>` : ""}</strong><small>${esc(String(b.trades_count))} ${Number(b.trades_count) === 1 ? "operación" : "operaciones"}</small></span>
    <span class="bolsa-px">${esc(money0(b.total))}</span>
    <span class="bolsa-chg">${delta(pct, sPct(pct))}</span>
  </button>`;
}

function playersTab() {
  if (S.player) return playerDetail();
  const feed = S.feed.slice(0, S.feedShown);
  const admin = state.isAdmin
    ? `<h3 class="sec-title">Administración</h3><div class="bolsa-admin"><p class="hint">Borra todas las operaciones y devuelve 200.000 $ a cada jugador. No se puede deshacer.</p>
        <button type="button" class="btn danger" data-action="bolsa-reset" ${S.busy ? "disabled" : ""}>${icon("trash", 16)} Reiniciar la bolsa</button></div>`
    : "";
  return `<h3 class="sec-title">Clasificación</h3>
    ${S.board.length ? `<div class="bolsa-ranking">${S.board.map(rankRow).join("")}</div>` : empty("👥", "Nadie ha entrado todavía", "Sé el primero en entrar a la bolsa.")}
    <h3 class="sec-title">Actividad reciente</h3>
    ${feed.length ? `<ul class="bolsa-trades">${feed.map((t) => tradeLine(t)).join("")}</ul>` : `<p class="hint">Todavía no se ha hecho ninguna operación.</p>`}
    ${S.feed.length > S.feedShown ? `<button type="button" class="btn small bolsa-more" data-action="bolsa-more">Ver más</button>` : ""}${admin}`;
}

function playerDetail() {
  const i = S.board.findIndex((b) => b.user_id === S.player);
  const b = S.board[i];
  const back = `<button type="button" class="btn small" data-action="bolsa-player-back">${icon("chevronL", 16)} Todos los jugadores</button>`;
  if (!b) return `${back}${empty("🤷", "No se encuentra a este jugador", "Puede que se haya reiniciado la bolsa.")}`;
  const gain = Number(b.total) - START_CASH;
  const t = trend(gain);
  const own = S.positions.filter((p) => p.user_id === b.user_id);
  return `${back}
    <section class="bolsa-player">
      ${avatar(b.name, "lg")}
      <div class="bolsa-name"><strong>${esc(b.name)}${b.user_id === myId() ? ` <small class="you">tú</small>` : ""}</strong><small>${esc(ordinal(i + 1))} de ${S.board.length} · ${esc(String(b.trades_count))} ${Number(b.trades_count) === 1 ? "operación" : "operaciones"}</small></div>
      <strong class="bolsa-player-total">${esc(money(b.total))}</strong>
      <p class="bolsa-pill ${t}"><span aria-hidden="true">${ARROW[t]}</span> ${esc(sMoney(gain))} (${esc(sPct(Number(b.pnl_pct)))})</p>
      <p class="hint">Efectivo ${esc(money(b.cash))} · en activos ${esc(money(b.holdings_value))}</p>
    </section>
    <h3 class="sec-title">Su cartera</h3>
    ${own.length ? `<div class="bolsa-assets">${own.map(positionRow).join("")}</div>` : `<p class="hint">No tiene ningún activo ahora mismo.</p>`}
    <h3 class="sec-title">Sus operaciones</h3>
    ${S.playerTrades.length ? `<ul class="bolsa-trades">${S.playerTrades.slice(0, 20).map((x) => tradeLine(x)).join("")}</ul>` : `<p class="hint">${S.playerFor === S.player ? "Todavía no ha hecho ninguna operación." : "Cargando sus operaciones…"}</p>`}`;
}

// ---------- ficha de un activo ----------

function sheetHtml() {
  const sh = S.sheet;
  const a = asset(sh.symbol);
  if (!a) return "";
  const mine = me();
  const pos = holding(myId(), sh.symbol);
  const ch = Number(a.change_24h_pct);
  const t = trend(ch);
  const pct = pos && Number(pos.value) - Number(pos.pnl) > 0 ? (Number(pos.pnl) / (Number(pos.value) - Number(pos.pnl))) * 100 : 0;
  const position = pos
    ? `<p class="bolsa-position"><strong>Tu posición:</strong> ${esc(units(pos.qty))} · valen ${esc(money(pos.value))} ${delta(Number(pos.pnl), `${sMoney(Number(pos.pnl))} (${sPct(pct)})`)}</p>`
    : `<p class="bolsa-position">${mine ? "Todavía no tienes de este activo." : ""}</p>`;
  let action;
  if (!mine) {
    action = `<div class="notice bolsa-joinnote"><p><strong>Para operar, primero entra a la bolsa</strong> y recibe 200.000 $.</p></div>
      <button type="button" class="btn primary bolsa-big" data-action="bolsa-join" ${S.joining ? "disabled" : ""}>${S.joining ? "Entrando…" : "Entrar"}</button>`;
  } else {
    action = `<div class="bolsa-sides">
        <button type="button" class="btn bolsa-big bolsa-buy" data-action="bolsa-side" data-side="buy" aria-pressed="${sh.side === "buy"}" ${S.busy ? "disabled" : ""}>Comprar</button>
        <button type="button" class="btn bolsa-big bolsa-sell" data-action="bolsa-side" data-side="sell" aria-pressed="${sh.side === "sell"}" ${S.busy || !pos ? "disabled" : ""}>Vender</button>
      </div>${pos ? "" : `<p class="hint bolsa-hint-sell">Para vender primero tienes que comprar.</p>`}`;
  }
  const result = S.result ? resultHtml(S.result) : "";
  const trade = mine && sh.side ? tradeForm(sh, mine, pos) : "";
  const enter = S.animateSheet ? " is-entering" : "";
  S.animateSheet = false;
  return `<div class="bolsa-overlay${enter}">
    <div class="bolsa-backdrop" data-action="bolsa-close"></div>
    <section class="bolsa-sheet${sh.side ? " is-trading" : ""}" role="dialog" aria-modal="true" aria-labelledby="bolsa-sheet-title">
      <div class="bolsa-sheet-scroll">
        <header class="bolsa-sheet-head">
          ${tile(a.emoji)}
          <div class="bolsa-name"><h3 id="bolsa-sheet-title">${esc(a.name)}</h3><small>${esc(a.symbol)}</small></div>
          <button type="button" class="icon-btn" id="bolsa-close" data-action="bolsa-close" aria-label="Cerrar la ficha">${icon("x", 20)}</button>
        </header>
        <div class="bolsa-sheet-price"><strong>${esc(money(a.price))}</strong>${delta(ch, `${sPct(ch)} en 24 h`)}</div>
        ${chart(S.historyKey === histKey() ? S.history : [], sh.hours, a.name)}
        <div class="segmented bolsa-ranges" role="group" aria-label="Periodo del gráfico">${RANGES.map(([h, label]) => `<button type="button" data-action="bolsa-range" data-hours="${h}" aria-pressed="${sh.hours === h}">${label}</button>`).join("")}</div>
        ${position}
        ${action}
        ${trade}
        <div class="bolsa-live" role="status" aria-live="polite">${S.err ? `<p class="bolsa-error" role="alert">${esc(S.err)}</p>` : ""}${result}</div>
      </div>
    </section>
  </div>`;
}

function tradeForm(sh, mine, pos) {
  const buy = sh.side === "buy";
  const cash = Number(mine.cash);
  const plan = planFor();
  const chip = (kind, value, label, off) =>
    `<button type="button" class="bolsa-chip" data-action="bolsa-pick" data-kind="${kind}" data-value="${value}" aria-pressed="${sh.choice?.kind === kind && sh.choice.value === value}" ${off || S.busy ? "disabled" : ""}>${esc(label)}</button>`;
  const chips = buy
    ? QUICK_BUY.map((v) => chip("usd", v, money0(v), v > cash)).join("") + chip("cash", 1, "Todo mi efectivo", cash < 1)
    : QUICK_SELL.map(([f, label]) => chip("frac", f, label, !pos)).join("");
  return `<form class="bolsa-trade-form" data-form="bolsa-trade" autocomplete="off" novalidate>
    <p class="bolsa-form-title">${buy ? `¿Cuánto quieres comprar? <small>Tienes ${esc(money(cash))}</small>` : `¿Cuánto quieres vender? <small>Tienes ${esc(units(pos?.qty ?? 0))}</small>`}</p>
    <div class="bolsa-chips ${buy ? "four" : "three"}">${chips}</div>
    <label>Otro importe (en $, opcional)
      <input type="text" inputmode="decimal" enterkeyhint="done" placeholder="Por ejemplo 5000" data-keep="bolsa-amount" name="amount" value="${esc(sh.text)}" ${S.busy ? "disabled" : ""}>
    </label>
    <div class="bolsa-plan" id="bolsa-plan" aria-live="polite">${planHtml(plan)}</div>
    <div class="bolsa-form-actions">
      <button type="button" class="btn ghost" data-action="bolsa-side" data-side="" ${S.busy ? "disabled" : ""}>Cancelar</button>
      <button type="submit" class="btn primary bolsa-big" id="bolsa-confirm" ${plan?.ok && !S.busy ? "" : "disabled"}>${S.busy ? "Enviando…" : buy ? "Confirmar compra" : "Confirmar venta"}</button>
    </div>
  </form>`;
}

function resultHtml(r) {
  const a = asset(r.symbol);
  const buy = r.side === "buy";
  const hora = new Date(r.created_at).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const cash = me()?.cash;
  return `<div class="bolsa-result"><strong><span aria-hidden="true">✅</span> ${buy ? "Compra hecha" : "Venta hecha"}</strong>
    <p>${buy ? "Compraste" : "Vendiste"} <b>${esc(units(r.qty))}</b> de ${esc(a?.name ?? r.symbol)} a <b>${esc(money(r.price))}</b> cada una (precio oficial de las ${esc(hora)}).</p>
    <p>${buy ? "Has pagado" : "Has cobrado"} <b>${esc(money(r.total))}</b>.${cash != null ? ` Ahora tienes ${esc(money(cash))} en efectivo.` : ""}</p></div>`;
}

// ---------- pantalla ----------

// Identifica el botón o campo con el foco para devolvérselo cuando la página se repinta (el HTML se sustituye entero).
const focusKey = (el) => {
  if (!el?.closest?.(".bolsa")) return "";
  if (el.id) return `#${el.id}`;
  if (!el.dataset?.action) return "";
  return `[data-action="${el.dataset.action}"]` + ["symbol", "tab", "side", "kind", "value", "hours", "id"].map((k) => (el.dataset[k] != null ? `[data-${k}="${CSS.escape(el.dataset[k])}"]` : "")).join("");
};

export function render() {
  // La ficha tiene su propio scroll: se guarda antes de que la página se repinte y se recupera después.
  const old = document.querySelector(".bolsa-sheet-scroll");
  if (old) S.sheetScroll = old.scrollTop;
  S.refocus = focusKey(document.activeElement);
  queueMicrotask(afterRender);
  if (S.missing) return "";
  if (!S.loaded) {
    return S.error
      ? `<div class="notice bolsa-fail">${icon("file", 18)}<p><strong>No se pudo cargar la bolsa.</strong> ${esc(S.error)}</p></div><button type="button" class="btn primary" data-action="bolsa-retry">Reintentar</button>`
      : `<div class="bolsa-loading" role="status" aria-label="Cargando la bolsa"><i></i><i></i><i></i></div>`;
  }
  const mine = me();
  const body = S.tab === "market" ? marketTab() : S.tab === "portfolio" ? portfolioTab(mine) : playersTab();
  return `<div class="bolsa">
    ${S.stale ? `<p class="hint bolsa-stale">Sin conexión con el servidor: se ven los últimos datos.</p>` : ""}
    ${mine ? hero(mine) : joinCard()}
    ${tabs()}
    <div class="bolsa-body">${body}</div>
    ${S.sheet ? sheetHtml() : ""}
  </div>`;
}

function afterRender() {
  const open = Boolean(S.sheet);
  document.body.style.overflow = open && S.active ? "hidden" : "";
  const scroll = document.querySelector(".bolsa-sheet-scroll");
  if (scroll) scroll.scrollTop = S.sheetScroll;
  if (S.focusSheet) {
    S.focusSheet = false;
    S.refocus = "#bolsa-close";
  }
  if (S.reveal) {
    const target = S.reveal === "live" ? document.querySelector(".bolsa-live") : document.getElementById("bolsa-confirm");
    S.reveal = false;
    target?.scrollIntoView({ block: "nearest" });
  }
  if (S.refocus && (!document.activeElement || document.activeElement === document.body)) document.querySelector(S.refocus)?.focus({ preventScroll: true });
}

function closeSheet() {
  S.sheet = null;
  S.err = "";
  S.result = null;
  S.sheetScroll = 0;
  rerender();
}

// ---------- acciones ----------

async function join() {
  if (S.joining) return;
  if (!getName()) {
    toast("Primero dinos tu nombre.");
    document.getElementById("session-btn")?.click(); // abre el perfil, donde se escribe el nombre
    return;
  }
  S.joining = true;
  rerender();
  try {
    await rpc("join_market", { p_name: getName() });
    await loadAll({ force: true });
    toast("¡Listo! Tienes 200.000 $ para invertir.", 3500);
  } catch (err) {
    S.err = friendly(err);
    toast(S.err);
  } finally {
    S.joining = false;
    repaint();
  }
}

async function openSheet(symbol) {
  if (!asset(symbol)) return;
  S.sheet = { symbol, side: null, choice: null, text: "", hours: 48 };
  S.result = null;
  S.err = "";
  S.history = [];
  S.historyKey = "";
  S.sheetScroll = 0;
  S.focusSheet = true;
  S.animateSheet = true;
  rerender();
  try {
    await loadHistory();
  } catch (err) {
    console.warn("Bolsa: sin gráfico:", err?.message || err);
  }
  repaint();
}

export const actions = {
  "bolsa-tab": ({ tab }) => {
    S.tab = tab;
    S.player = null;
    rerender();
  },
  "bolsa-join": join,
  "bolsa-retry": async () => {
    S.error = "";
    rerender();
    await loadAll({ force: true });
    repaint();
  },
  "bolsa-open": ({ symbol }) => openSheet(symbol),
  "bolsa-close": () => !S.busy && closeSheet(),
  "bolsa-side": ({ side }) => {
    if (!S.sheet || S.busy) return;
    S.sheet.side = side || null;
    S.sheet.choice = null;
    S.sheet.text = "";
    S.err = "";
    S.result = null;
    S.reveal = Boolean(side);
    rerender();
  },
  "bolsa-pick": ({ kind, value }) => {
    if (!S.sheet || S.busy) return;
    S.sheet.choice = { kind, value: Number(value) };
    S.sheet.text = "";
    S.err = "";
    S.reveal = true;
    rerender();
  },
  "bolsa-range": async ({ hours }) => {
    if (!S.sheet) return;
    S.sheet.hours = Number(hours);
    rerender();
    try {
      await loadHistory();
    } catch (err) {
      console.warn("Bolsa: sin gráfico:", err?.message || err);
    }
    repaint();
  },
  "bolsa-player": async ({ id }) => {
    S.player = id;
    S.playerTrades = [];
    S.playerFor = null;
    rerender();
    try {
      S.playerTrades = await rows(trades().eq("user_id", id).order("id", { ascending: false }).limit(40));
      S.playerFor = id;
    } catch (err) {
      toast(friendly(err));
    }
    repaint();
  },
  "bolsa-player-back": () => {
    S.player = null;
    rerender();
  },
  "bolsa-more": () => {
    S.feedShown = Math.min(S.feedShown + FEED_STEP, 60);
    rerender();
  },
  "bolsa-reset": async () => {
    if (S.busy || !confirm("¿Reiniciar la bolsa? Se borrarán todas las operaciones y todos los jugadores volverán a tener 200.000 $. No se puede deshacer.")) return;
    S.busy = true;
    rerender();
    try {
      const n = await rpc("reset_market");
      S.player = null;
      await loadAll({ force: true });
      toast(`Bolsa reiniciada: ${n} ${Number(n) === 1 ? "jugador vuelve" : "jugadores vuelven"} a tener 200.000 $.`);
    } catch (err) {
      toast(friendly(err));
    } finally {
      S.busy = false;
      repaint();
    }
  },
};

// ---------- formularios ----------

export const onSubmit = async (event) => {
  const form = event.target.closest?.('[data-form="bolsa-trade"]');
  if (!form) return false;
  event.preventDefault();
  await placeTrade();
  return true;
};

export const onInput = async (event) => {
  const input = event.target;
  if (!input?.matches?.('[data-keep="bolsa-amount"]')) return false;
  if (!S.sheet) return true;
  S.sheet.text = input.value;
  S.sheet.choice = null; // lo escrito sustituye al botón rápido que hubiera
  S.err = "";
  for (const chip of document.querySelectorAll(".bolsa-chip")) chip.setAttribute("aria-pressed", "false");
  refreshPlanDom();
  return true;
};

export const onChange = async () => false;
