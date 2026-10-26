// Pestaña «Juegos»: la lista de juegos y el puente con cada uno. Cada juego es un módulo de esta carpeta que cumple el
// contrato descrito en docs/JUEGOS.md (meta, available, render, actions, enter/leave/peek, onSubmit/onInput/onChange, summary).
import { state, ctx } from "../state.js";
import { icon } from "../icons.js";
import { esc } from "../util.js";
import * as batalla from "./batalla.js";
import * as bolsa from "./bolsa.js";
import * as bingo from "./bingo.js";
import * as dibujos from "./dibujos.js";

export const GAMES = [batalla, bolsa, bingo, dibujos];
const byId = (id) => GAMES.find((g) => g.meta.id === id);

// Los juegos son compartidos entre viajeros, así que necesitan la base de datos (no el modo demo).
export const gamesAvailable = () => ctx.store?.mode === "supabase" && Boolean(ctx.store.sb);

export function renderJuegos() {
  if (!gamesAvailable()) {
    return `<div class="page-head"><div><h2>Juegos</h2><p class="page-sub">Para pasarlo bien durante el viaje</p></div></div>
      <div class="gate"><div class="gate-art">${icon("gamepad", 34)}</div><h2>Los juegos necesitan la base de datos compartida</h2>
      <p>Se juega entre todos los viajeros, así que hace falta conectar Supabase (ver docs/DESPLIEGUE.md).</p></div>`;
  }
  const game = state.game && byId(state.game);
  if (game) {
    const { id, title, emoji } = game.meta;
    return `<div class="game-head"><button type="button" class="btn small" data-action="close-game">${icon("chevronL", 16)} Juegos</button><h2><span aria-hidden="true">${emoji}</span> ${esc(title)}</h2></div>
      <div class="game game-${id}">${game.available() ? game.render() : missingTables(game)}</div>`;
  }
  return `<div class="page-head"><div><h2>Juegos</h2><p class="page-sub">Retos y competiciones del viaje. Todo cuenta para el álbum final.</p></div></div>
    <div class="game-grid">${GAMES.map((g) => {
      const badge = g.badge?.() ?? "";
      return `<button type="button" class="game-card" data-action="open-game" data-game="${g.meta.id}">
        <span class="game-emoji" aria-hidden="true">${g.meta.emoji}</span>
        <span class="game-text"><strong>${esc(g.meta.title)}</strong><small>${esc(g.meta.blurb)}</small>${badge ? `<span class="game-badge">${esc(badge)}</span>` : ""}</span>
      </button>`;
    }).join("")}</div>`;
}

const missingTables = (game) =>
  `<div class="notice">${icon("file", 18)}<p><strong>Falta una parte de la base de datos.</strong> Ejecuta <code>supabase/todo_en_uno.sql</code> en Supabase (SQL Editor) para activar «${esc(game.meta.title)}». No hace daño repetirlo.</p></div>`;

// Acciones que se unen a las de app.js: las del hub y las de cada juego (sus nombres empiezan por el id del juego).
export const gameActions = {
  "open-game": ({ game }) => {
    state.game = game;
    ctx.actions.render();
  },
  "close-game": () => {
    state.game = null;
    ctx.actions.render();
  },
  ...Object.assign({}, ...GAMES.map((g) => g.actions ?? {})),
};

// Entrar o salir de un juego (o de la pestaña): cada juego arranca o para aquí sus consultas periódicas.
let active = null;
let hubPeeked = false;
export function syncGames() {
  const inGames = state.view === "games" && gamesAvailable();
  const want = inGames ? state.game : null;
  if (want !== active) {
    if (active) byId(active)?.leave?.();
    active = want;
    if (active) byId(active)?.enter?.();
  }
  if (inGames && !state.game && !hubPeeked) {
    hubPeeked = true;
    for (const g of GAMES) g.peek?.(); // consultas pequeñas para las etiquetas de la lista («Reto abierto»…)
  }
  if (!inGames) hubPeeked = false;
}

// Los formularios y campos de los juegos los gestiona cada módulo (devuelve true si el evento era suyo).
export async function gameEvent(kind, event) {
  for (const g of GAMES) {
    if (await g[kind]?.(event)) return true;
  }
  return false;
}

// Datos para el álbum: una entrada por juego que tenga algo que contar (ver docs/JUEGOS.md).
export function gameSummaries() {
  return GAMES.map((g) => {
    try {
      const s = g.summary?.();
      return s ? { id: g.meta.id, title: g.meta.title, emoji: g.meta.emoji, ...s } : null;
    } catch (err) {
      console.error(err); // un juego con un dato raro no debe dejar sin álbum ni PDF a los demás
      return null;
    }
  }).filter(Boolean);
}
