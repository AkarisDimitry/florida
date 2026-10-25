// Funciones que devuelven HTML (ya escapado) para cada vista. No tocan el mapa ni los diálogos.
import { config } from "./config.js";
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import {
  $, esc, hasCoords, categoryOf, utc, capitalize, todayIso, fmtDayLong, fmtDayShort, money, formatKm,
  stars, dayColor, groupBy,
} from "./util.js";
import { allDays, byTime, locatedStops, stopsOfDay, foodStops, totalCost, photosNewestFirst, currentRoutes } from "./trip.js";
import { directionsUrl } from "./geo.js";
import { getName } from "./store.js";

const { trip } = config;

// ---------- cabecera ----------

function countdown() {
  if (!trip.start) return "";
  const diff = Math.round((utc(trip.start) - utc(todayIso())) / 864e5);
  if (diff > 1) return `faltan ${diff} días`;
  if (diff === 1) return "falta 1 día";
  if (!trip.end || todayIso() <= trip.end) return "¡de viaje!";
  return "viaje terminado";
}

export function renderHeader() {
  document.title = trip.name;
  $("#trip-name").textContent = trip.name;
  $("#trip-sub").textContent = [trip.destination, countdown()].filter(Boolean).join(" · ");
  const name = getName();
  $("#session-btn").textContent = (name || ctx.store?.user?.email || "?").charAt(0).toUpperCase();
  $("#session-btn").title = name || ctx.store?.user?.email || "Entrar";

  const banner = $("#banner");
  const message = state.offline
    ? "Sin conexión: se muestra la última copia guardada en este dispositivo."
    : ctx.store?.mode === "demo"
      ? "Modo demo: lo que añadas se guarda solo en este navegador. Conecta Supabase en js/config.js para compartirlo."
      : "";
  banner.hidden = !message;
  banner.textContent = message;
}

// ---------- bloques comunes ----------

// `text` y `buttonHtml` son HTML ya escapado.
export function gate(title, text, buttonHtml = "") {
  return `<div class="gate"><div class="gate-art">${icon("map", 34)}</div><h2>${esc(title)}</h2><p>${text}</p>${buttonHtml}</div>`;
}

export const enterButton = `<button class="btn primary" data-action="profile">Entrar</button>`;

const stat = (label, value, iconName) =>
  `<div class="stat"><span class="stat-ico">${icon(iconName, 18)}</span><div><span class="stat-label">${esc(label)}</span><strong>${esc(value)}</strong></div></div>`;

const starsHtml = (n) => `<span class="stars" title="${n} de 5" aria-label="${n} de 5 estrellas">${stars(n)}</span>`;

function mapsSearchUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

// ---------- itinerario ----------

function card(a, comments, index) {
  const cat = categoryOf(a.category);
  const located = hasCoords(a);
  const chips = [];
  if (a.place && located) chips.push(`<button class="chip is-link" data-action="show-on-map" data-id="${esc(a.id)}">${icon("pin", 14)} ${esc(a.place)}</button>`);
  else if (a.place) chips.push(`<a class="chip is-link" href="${esc(mapsSearchUrl(a.place))}" target="_blank" rel="noopener">${icon("pin", 14)} ${esc(a.place)}</a>`);
  else if (located) chips.push(`<button class="chip is-link" data-action="show-on-map" data-id="${esc(a.id)}">${icon("pin", 14)} Ver en el mapa</button>`);
  if (located) chips.push(`<a class="chip is-link" href="${esc(directionsUrl(a.lat, a.lng))}" target="_blank" rel="noopener">${icon("navigate", 14)} Cómo llegar</a>`);
  if (a.cost != null) chips.push(`<span class="chip">${esc(money.format(a.cost))}</span>`);
  if (a.rating) chips.push(`<span class="chip">${starsHtml(a.rating)}</span>`);
  if (a.created_by_name) chips.push(`<span class="chip muted">${esc(a.created_by_name)}</span>`);

  const commentItems = comments
    .map(
      (c) => `<li>
        <span class="who">${esc(c.created_by_name || "Alguien")}</span> ${esc(c.body)}
        ${c.created_by === ctx.store?.user?.id ? `<button class="mini-x" title="Borrar comentario" aria-label="Borrar comentario" data-action="del-comment" data-id="${esc(c.id)}">✕</button>` : ""}
      </li>`,
    )
    .join("");

  return `<article class="card" style="--i:${index}">
    <div class="card-rail">
      <span class="card-time">${esc(a.start_time ? a.start_time.slice(0, 5) : "—")}</span>
      <span class="card-emoji" title="${esc(cat.label)}">${cat.emoji}</span>
    </div>
    <div class="card-body">
      <div class="card-top">
        <h3>${esc(a.title)}</h3>
        <div class="card-actions">
          <button class="icon-btn sm" title="Editar" aria-label="Editar" data-action="edit" data-id="${esc(a.id)}">${icon("edit", 16)}</button>
          <button class="icon-btn sm" title="Borrar" aria-label="Borrar" data-action="delete" data-id="${esc(a.id)}">${icon("trash", 16)}</button>
        </div>
      </div>
      ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
      ${a.notes ? `<p class="card-notes">${esc(a.notes)}</p>` : ""}
      <details data-id="${esc(a.id)}" ${state.open.has(a.id) ? "open" : ""}>
        <summary>${icon("chat", 16)} Comentarios <span class="count">${comments.length}</span></summary>
        ${commentItems ? `<ul class="comments">${commentItems}</ul>` : ""}
        <form class="comment-form" data-activity="${esc(a.id)}">
          <input name="body" maxlength="1000" required placeholder="Escribe un comentario…" value="${esc(state.drafts[a.id] || "")}">
          <button class="btn small primary" type="submit">Enviar</button>
        </form>
      </details>
    </div>
  </article>`;
}

export function renderPlan() {
  const routes = currentRoutes();
  const km = routes.reduce((sum, r) => sum + r.km, 0);
  const roadRoutes = routes.some((r) => r.road);
  const stats = `<div class="stats">
    ${stat("Cuenta atrás", countdown() ? capitalize(countdown()) : "—", "calendar")}
    ${stat("Actividades", state.activities.length, "route")}
    ${stat("Gasto anotado", money.format(totalCost()), "download")}
    ${stat(roadRoutes ? "Recorrido por carretera" : "Recorrido", km ? formatKm(km) : "—", "car")}
  </div>`;

  const days = allDays();
  if (!days.length) {
    return (
      stats +
      gate("Todavía no hay nada", "Añade la primera actividad del viaje.", `<button class="btn primary" data-action="add" data-day="${todayIso()}">${icon("plus", 18)} Añadir actividad</button>`)
    );
  }

  const commentsByActivity = groupBy(state.comments, (c) => c.activity_id);
  const activitiesByDay = groupBy([...state.activities].sort(byTime), (a) => a.day);
  const routeByDay = new Map(routes.map((r) => [r.day, r]));
  let index = 0;

  const sections = days.map((day, i) => {
    const items = activitiesByDay.get(day) ?? [];
    const route = routeByDay.get(day);
    const sub = [items.length ? `${items.length} ${items.length === 1 ? "plan" : "planes"}` : "Sin planes", route ? `${formatKm(route.km)}${route.road ? "" : " en línea recta"}` : ""].filter(Boolean).join(" · ");
    return `<section class="day" style="--c:${dayColor(i)}">
      <header class="day-head">
        <span class="day-dot"></span>
        <div class="day-title"><h2>${esc(capitalize(fmtDayLong.format(utc(day))))}</h2><p class="day-sub">${esc(sub)}</p></div>
        <div class="day-tools">
          ${items.some(hasCoords) ? `<button class="icon-btn sm" title="Ver el día en el mapa" aria-label="Ver el día en el mapa" data-action="day-on-map" data-day="${esc(day)}">${icon("map", 18)}</button>` : ""}
          <button class="icon-btn sm accent" title="Añadir actividad" aria-label="Añadir actividad" data-action="add" data-day="${esc(day)}">${icon("plus", 18)}</button>
        </div>
      </header>
      ${items.length ? items.map((a) => card(a, commentsByActivity.get(a.id) ?? [], index++)).join("") : `<p class="empty">Sin planes todavía.</p>`}
    </section>`;
  });
  return stats + sections.join("");
}

// ---------- fotos ----------

export function renderPhotos() {
  const photos = photosNewestFirst();
  const located = photos.filter(hasCoords).length;
  const head = `<div class="page-head">
    <div><h2>Fotos</h2><p class="page-sub">${photos.length} ${photos.length === 1 ? "foto" : "fotos"}${photos.length ? ` · ${located} con ubicación` : ""}</p></div>
    <div class="head-actions">
      ${located ? `<button class="btn small" data-action="photos-on-map">${icon("map", 16)} Ver en el mapa</button>` : ""}
      <button class="btn small primary" data-action="upload">${icon("camera", 16)} Subir fotos</button>
    </div>
  </div>`;
  if (!photos.length) {
    return head + gate("Aún no hay fotos", "Sube las primeras: si traen ubicación GPS, aparecerán en el mapa donde se tomaron.", `<button class="btn primary" data-action="upload">${icon("camera", 18)} Subir fotos</button>`);
  }
  const grid = photos
    .map(
      (p, i) => `<button class="photo" style="--i:${Math.min(i, 24)}" data-action="open-photo" data-id="${esc(p.id)}" aria-label="Abrir foto de ${esc(p.created_by_name || "un viajero")}">
        <img src="${esc(p.thumb_url)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')">
        ${hasCoords(p) ? `<span class="geo-badge" title="Con ubicación">${icon("pin", 13)}</span>` : ""}
      </button>`,
    )
    .join("");
  return `${head}<div class="photo-grid">${grid}</div>`;
}

// ---------- dónde comimos ----------

export function renderFood() {
  const list = foodStops();
  if (!list.length) {
    return gate(
      "Dónde comimos",
      "Aquí aparecerán los sitios donde comáis. Crea una actividad de tipo «Comida», ponle ubicación y valóralo.",
      `<button class="btn primary" data-action="add" data-day="${todayIso()}" data-category="comida">${icon("plus", 18)} Añadir un sitio</button>`,
    );
  }
  const spent = list.reduce((s, a) => s + (a.cost || 0), 0);
  const rated = list.filter((a) => a.rating);
  const average = rated.length ? rated.reduce((s, a) => s + a.rating, 0) / rated.length : null;
  const days = allDays();
  const summary = `<div class="stats three">
    ${stat("Sitios", list.length, "food")}
    ${stat("Gastado", money.format(spent), "download")}
    ${stat("Valoración media", average ? `${average.toFixed(1).replace(".", ",")} ★` : "—", "star")}
  </div>`;
  const cards = list
    .map((a, i) => {
      const located = hasCoords(a);
      const color = dayColor(days.indexOf(a.day));
      return `<article class="card food-card" style="--i:${i}; --c:${color}">
        <div class="card-rail"><span class="card-emoji">🍽️</span></div>
        <div class="card-body">
          <div class="card-top"><h3>${esc(a.title)}</h3>
            <div class="card-actions"><button class="icon-btn sm" title="Editar" aria-label="Editar" data-action="edit" data-id="${esc(a.id)}">${icon("edit", 16)}</button></div>
          </div>
          <p class="food-when"><span class="day-dot"></span>${esc(capitalize(fmtDayShort.format(utc(a.day))))}${a.start_time ? ` · ${esc(a.start_time.slice(0, 5))}` : ""}</p>
          <div class="chips">
            ${a.rating ? `<span class="chip">${starsHtml(a.rating)}</span>` : ""}
            ${a.cost != null ? `<span class="chip">${esc(money.format(a.cost))}</span>` : ""}
            ${a.place ? `<span class="chip muted">${esc(a.place)}</span>` : ""}
            ${located ? `<button class="chip is-link" data-action="show-on-map" data-id="${esc(a.id)}">${icon("pin", 14)} Ver en el mapa</button>` : ""}
            ${located ? `<a class="chip is-link" href="${esc(directionsUrl(a.lat, a.lng))}" target="_blank" rel="noopener">${icon("navigate", 14)} Cómo llegar</a>` : ""}
          </div>
          ${a.notes ? `<p class="card-notes">${esc(a.notes)}</p>` : ""}
        </div>
      </article>`;
    })
    .join("");
  return `<div class="page-head"><div><h2>Dónde comimos</h2><p class="page-sub">Todos los sitios de comida del viaje</p></div>
    <div class="head-actions"><button class="btn small primary" data-action="add" data-day="${todayIso()}" data-category="comida">${icon("plus", 16)} Añadir</button></div></div>
    ${summary}${cards}`;
}

// ---------- mapa: chips de días y hoja inferior ----------

export function renderChips() {
  const days = allDays();
  const counts = new Map([...groupBy(locatedStops(days), (s) => s.day)].map(([day, list]) => [day, list.length]));
  const all = `<button class="chip-day ${state.day ? "" : "is-on"}" role="tab" aria-selected="${!state.day}" data-action="select-day" data-day="">Todo el viaje</button>`;
  return (
    all +
    days
      .map((day, i) => {
        const n = counts.get(day);
        return `<button class="chip-day ${state.day === day ? "is-on" : ""}" style="--c:${dayColor(i)}" role="tab" aria-selected="${state.day === day}" data-action="select-day" data-day="${esc(day)}">
          <span class="dot"></span>${esc(capitalize(fmtDayShort.format(utc(day))))}${n ? ` <b>${n}</b>` : ""}
        </button>`;
      })
      .join("")
  );
}

export function renderSheet() {
  const stops = state.day ? stopsOfDay(state.day) : locatedStops();
  if (!stops.length) {
    return `<div class="sheet-empty">
      <div class="gate-art sm">${icon("pin", 26)}</div>
      <div><strong>${state.day ? "Este día no tiene lugares en el mapa" : "Aún no hay lugares en el mapa"}</strong>
      <p>Mantén pulsado el mapa para añadir un lugar, o añade la ubicación a una actividad.</p></div>
      <button class="btn primary small" data-action="add" data-day="${esc(state.day || todayIso())}">${icon("plus", 16)} Añadir</button>
    </div>`;
  }
  const routes = currentRoutes();
  const route = state.day ? routes.find((r) => r.day === state.day) : null;
  // Solo kilómetros: el servidor público de rutas da tiempos poco fiables y no merece la pena mostrarlos.
  const km = state.day ? route?.km : routes.reduce((s, r) => s + r.km, 0);
  const allRoad = state.day ? route?.road : routes.length && routes.every((r) => r.road);
  const title = state.day ? capitalize(fmtDayLong.format(utc(state.day))) : "Todo el viaje";
  const facts = [
    `${stops.length} ${stops.length === 1 ? "lugar" : "lugares"}`,
    km ? `${icon("car", 14)} ${formatKm(km)}${allRoad ? "" : " en línea recta"}` : "",
  ].filter(Boolean);

  const cards = stops
    .map((s) => {
      const cat = categoryOf(s.category);
      const meta = [s.start_time?.slice(0, 5), s.place].filter(Boolean).join(" · ");
      return `<div class="stop-card ${s.id === state.selectedStop ? "is-on" : ""}" style="--c:${s.color}" data-action="select-stop" data-id="${esc(s.id)}" data-stop="${esc(s.id)}" role="button" tabindex="0">
        <span class="stop-n">${s.order}</span>
        <div class="stop-text"><p class="stop-title">${cat.emoji} ${esc(s.title)}</p><p class="stop-meta">${esc(meta || cat.label)}</p></div>
        <a class="stop-go" href="${esc(directionsUrl(s.lat, s.lng))}" target="_blank" rel="noopener" title="Cómo llegar" aria-label="Cómo llegar a ${esc(s.title)}">${icon("navigate", 17)}</a>
      </div>`;
    })
    .join("");
  return `<div class="sheet-head"><h2>${esc(title)}</h2><p>${facts.join(" · ")}</p></div><div class="sheet-track">${cards}</div>`;
}
