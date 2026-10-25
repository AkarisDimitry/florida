// Funciones que devuelven HTML (ya escapado) para cada vista. No tocan el mapa ni los diálogos.
import { config } from "./config.js";
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import {
  $, esc, hasCoords, categoryOf, utc, capitalize, todayIso, fmtDayLong, fmtDayShort, fmtDate, money, formatKm, formatTemp,
  stars, dayColor, groupBy, CATEGORIES,
} from "./util.js";
import { allDays, byTime, locatedStops, stopsOfDay, totalCost, photosNewestFirst, tripPhotos, currentRoutes, friendsNow } from "./trip.js";
import { directionsUrl, distanceKm } from "./geo.js";
import { getName } from "./store.js";
import { describeWeather, packingTips, WEATHER_KIND } from "./weather.js";
import { buildAlbum, photoDay } from "./album.js";
import { planNav, renderExpenses, renderPacking } from "./extras.js";
import { onlineCount } from "./people.js";
import { encuentroChip, encuentroButton } from "./encuentro.js";
import { threadHtml, commentsOf } from "./comments.js";
import { clock } from "./media.js";
import { renderIdeas } from "./ideas.js";
import { totalCents, fromCents } from "./ledger.js";
import { mergeQueued, queuedTile, colaBand, isFresh } from "./cola.js";
import { locateHintHtml } from "./ubicar.js";
import { ratingBadgeHtml, topRatedHtml } from "./valoraciones.js";

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

  // Botón «en línea»: cuántos viajeros hay conectados ahora (solo con la base de datos compartida y presencia.sql).
  const showPeople = ctx.store?.mode === "supabase" && state.member && state.presenceOn;
  $("#people-btn").hidden = !showPeople;
  if (showPeople) $("#people-count").textContent = String(onlineCount());

  // Aviso para quien administra: solicitudes de acceso esperando aprobación (también como punto rojo en el avatar).
  const pending = state.isAdmin ? state.requests.filter((r) => r.status === "pending").length : 0;
  $("#session-btn").dataset.badge = pending ? String(pending) : "";

  const banner = $("#banner");
  const message = state.offline
    ? "Sin conexión: se muestra la última copia guardada en este dispositivo."
    : ctx.store?.mode === "demo"
      ? "Modo demo: lo que añadas (fotos incluidas) solo lo ves tú, en este navegador. Para compartirlo entre viajeros hay que conectar Supabase (ver docs/DESPLIEGUE.md)."
      : "";
  if (!state.offline && pending) {
    banner.innerHTML = `<button type="button" class="banner-btn" data-action="open-access">${icon("share", 16)} ${pending === 1 ? "1 persona espera" : `${pending} personas esperan`} que apruebes su acceso <u>Ver</u></button>`;
    banner.hidden = false;
  } else {
    banner.hidden = !message;
    banner.textContent = message;
  }
}

// ---------- bloques comunes ----------

// `text` y `buttonHtml` son HTML ya escapado.
export function gate(title, text, buttonHtml = "") {
  return `<div class="gate"><div class="gate-art">${icon("map", 34)}</div><h2>${esc(title)}</h2><p>${text}</p>${buttonHtml}</div>`;
}

export const enterButton = `<button class="btn primary" data-action="profile">Entrar</button>`;

const stat = (label, value, iconName, action = "") => {
  const body = `<span class="stat-ico">${icon(iconName, 18)}</span><div><span class="stat-label">${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  return action ? `<button type="button" class="stat is-link" data-action="${action}">${body}</button>` : `<div class="stat">${body}</div>`;
};

const starsHtml = (n) => `<span class="stars" title="${n} de 5" aria-label="${n} de 5 estrellas">${stars(n)}</span>`;

function mapsSearchUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

// ---------- tiempo y panel "Hoy" ----------

export function weatherChip(day, { withRain = false } = {}) {
  const w = state.weather.get(day);
  if (!w || w.tmax == null) return "";
  const [emoji, label] = describeWeather(w.code);
  const rain = w.rain != null && w.rain >= 0.1 ? `, lluvia ${w.rain.toFixed(1).replace(".", ",")} mm` : "";
  const title = `${label}: máx. ${formatTemp(w.tmax)}, mín. ${formatTemp(w.tmin)}${rain}. ${WEATHER_KIND[w.kind]}.`;
  const prob = withRain && w.prob != null ? `<small class="wx-rain">💧 ${w.prob}%</small>` : "";
  return `<span class="wx wx-${w.kind}" title="${esc(title)}"><span class="wx-ico">${emoji}</span>${esc(formatTemp(w.tmax))}<small>/${esc(formatTemp(w.tmin))}</small>${prob}</span>`;
}

const two = (n) => String(n).padStart(2, "0");

// Capa decorativa del panel "Hoy" según el tiempo (solo CSS; se desactiva con "sin animaciones").
function fxKind(code) {
  if (code == null) return "";
  if (code <= 1) return "sun";
  if (code === 2) return "partly";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  return "rain";
}
const drops = (n, extra = "") => Array.from({ length: n }, (_, i) => `<i style="left:${(i * 37 + 11) % 100}%;animation-delay:${-((i * 53) % 100) / 40}s;animation-duration:${0.8 + ((i * 29) % 50) / 100}s${extra}"></i>`).join("");
function weatherFx(w) {
  const kind = fxKind(w?.code);
  if (!kind) return "";
  const inner = {
    sun: `<b class="rays"></b>`,
    partly: `<b class="rays"></b><b class="cloud c1"></b><b class="cloud c2"></b>`,
    cloud: `<b class="cloud c1"></b><b class="cloud c2"></b><b class="cloud c3"></b>`,
    fog: `<b class="band b1"></b><b class="band b2"></b><b class="band b3"></b>`,
    rain: `<b class="cloud c1"></b>${drops(16)}`,
    storm: `<b class="cloud c1 dark"></b>${drops(18)}<b class="flash"></b>`,
    snow: `<b class="cloud c1"></b>${drops(20, ";width:6px;height:6px")}`,
  }[kind];
  return `<div class="fx fx-${kind}" aria-hidden="true">${inner}</div>`;
}

function tripPhase() {
  const today = todayIso();
  if (!trip.start) return "none";
  if (today < trip.start) return "before";
  if (trip.end && today > trip.end) return "after";
  return "during";
}

export function renderToday() {
  const phase = tripPhase();
  if (phase === "none") return "";
  const today = todayIso();
  const days = allDays();

  if (phase === "before") {
    const diff = Math.round((utc(trip.start) - utc(today)) / 864e5);
    const tips = packingTips(days.slice(0, 7).map((d) => state.weather.get(d)));
    const sun = state.weather.get(trip.start);
    return `<section class="today is-before">${weatherFx(sun)}
      <div class="today-top">
        <div><p class="eyebrow">Cuenta atrás</p><h2>${diff === 1 ? "Mañana empieza el viaje" : `Faltan ${diff} días`}</h2>
        <p class="today-sub">${esc([trip.destination, `${fmtDate.format(utc(trip.start))}`].filter(Boolean).join(" · "))}</p></div>
        ${weatherChip(trip.start)}
      </div>
      ${tips.length ? `<p class="today-label">Para la maleta, según el tiempo típico de esas fechas${sun?.kind === "forecast" ? " (previsión)" : ""}</p><div class="today-tips">${tips.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
    </section>`;
  }

  if (phase === "after") {
    return `<section class="today is-after">
      <p class="eyebrow">Viaje terminado</p><h2>¡Qué viaje!</h2>
      <p class="today-sub">Todo lo que habéis recogido ya está en el álbum, listo para descargar en PDF.</p>
      <div class="today-actions"><button class="btn" data-action="go-album">${icon("book", 16)} Ver el álbum</button></div>
    </section>`;
  }

  const acts = state.activities.filter((a) => a.day === today).sort(byTime);
  const now = `${two(new Date().getHours())}:${two(new Date().getMinutes())}`;
  const next = acts.find((a) => a.start_time && a.start_time.slice(0, 5) >= now) ?? acts.find((a) => !a.start_time);
  const w = state.weather.get(today);
  const city = state.places[today];
  const photosToday = tripPhotos().filter((p) => photoDay(p) === today).length;
  const spent = acts.reduce((s, a) => s + (a.cost || 0), 0);
  const far = next && hasCoords(next) && state.me ? formatKm(distanceKm(state.me, next)) : "";
  const nextBlock = next
    ? `<div class="today-next">
        <p class="today-label">${next.start_time && next.start_time.slice(0, 5) >= now ? "Lo siguiente" : "Sin hora fija"}</p>
        <h3>${categoryOf(next.category).emoji} ${esc(next.title)}</h3>
        <p>${esc([next.start_time?.slice(0, 5), next.place, far && `a ${far} en línea recta`].filter(Boolean).join(" · "))}</p>
        <div class="today-actions">
          ${hasCoords(next) ? `<a class="btn small" href="${esc(directionsUrl(next.lat, next.lng))}" target="_blank" rel="noopener">${icon("navigate", 15)} Cómo llegar</a><button class="btn small" data-action="show-on-map" data-id="${esc(next.id)}">${icon("map", 15)} En el mapa</button>` : ""}
          ${hasCoords(next) && !state.me ? `<button class="btn small" data-action="locate-me">${icon("locate", 15)} ¿A cuánto estoy?</button>` : ""}
        </div>
      </div>`
    : `<div class="today-next"><p class="today-label">Planes de hoy</p><h3>${acts.length ? "Ya no quedan más planes por hoy" : "Hoy no hay planes apuntados"}</h3></div>`;
  return `<section class="today is-during">${weatherFx(w)}
    <div class="today-top">
      <div><p class="eyebrow">Hoy · día ${days.indexOf(today) + 1} de ${days.length}</p><h2>${esc(capitalize(fmtDayLong.format(utc(today))))}</h2>${city ? `<p class="today-sub">${icon("pin", 14)} ${esc(city)}</p>` : ""}</div>
      ${weatherChip(today, { withRain: true })}
    </div>
    ${w?.sunrise ? `<p class="today-sun">🌅 ${esc(w.sunrise)} · 🌇 ${esc(w.sunset)}</p>` : ""}
    ${nextBlock}
    <div class="today-stats"><span>${icon("route", 15)} ${acts.length} ${acts.length === 1 ? "plan" : "planes"}</span><span>${icon("download", 15)} ${esc(money.format(spent))}</span><span>${icon("camera", 15)} ${photosToday} ${photosToday === 1 ? "foto" : "fotos"}</span></div>
    <div class="today-actions"><button class="btn small primary" data-action="camera">${icon("camera", 15)} Hacer foto</button><button class="btn small" data-action="add" data-day="${esc(today)}">${icon("plus", 15)} Añadir plan</button>${encuentroButton()}</div>
  </section>`;
}

// ---------- itinerario ----------

const searchText = (a) => [a.title, a.place, a.notes, a.created_by_name, categoryOf(a.category).label].filter(Boolean).join(" ").toLowerCase();

function card(a, comments, index) {
  const cat = categoryOf(a.category);
  const located = hasCoords(a);
  const chips = [];
  if (a.place && located) chips.push(`<button class="chip is-link" data-action="show-on-map" data-id="${esc(a.id)}">${icon("pin", 14)} ${esc(a.place)}</button>`);
  else if (a.place) chips.push(`<a class="chip is-link" href="${esc(mapsSearchUrl(a.place))}" target="_blank" rel="noopener">${icon("pin", 14)} ${esc(a.place)}</a>`);
  else if (located) chips.push(`<button class="chip is-link" data-action="show-on-map" data-id="${esc(a.id)}">${icon("pin", 14)} Ver en el mapa</button>`);
  if (located) chips.push(`<a class="chip is-link" href="${esc(directionsUrl(a.lat, a.lng))}" target="_blank" rel="noopener">${icon("navigate", 14)} Cómo llegar</a>`);
  if (a.cost != null) chips.push(`<span class="chip">${esc(money.format(a.cost))}</span>`);
  if (a.cost > 0) {
    chips.push(state.expenses.some((e) => e.activity_id === a.id)
      ? `<button class="chip is-link" data-action="go-expenses">${icon("wallet", 14)} Repartido</button>`
      : `<button class="chip is-link" data-action="split-activity" data-id="${esc(a.id)}">${icon("wallet", 14)} Repartir</button>`);
  }
  if (a.rating) chips.push(`<span class="chip">${starsHtml(a.rating)}</span>`);
  if (a.created_by_name) chips.push(`<span class="chip muted">${esc(a.created_by_name)}</span>`);

  // Fotos y notas de voz adjuntas a la actividad (las que llegaron dentro de un comentario se ven en su comentario).
  const inComment = (key, id) => state.comments.some((c) => c[key] === id);
  const photos = state.photos.filter((p) => p.activity_id === a.id && !inComment("attached_photo", p.id));
  const audios = state.audios.filter((x) => x.activity_id === a.id && !inComment("attached_audio", x.id));
  const media =
    photos.length || audios.length
      ? `<div class="card-media">${photos.map((p) => `<button type="button" class="cm-photo" data-action="open-photo" data-id="${esc(p.id)}" aria-label="Ver la foto"><img src="${esc(p.thumb_url)}" alt="${esc(p.caption || "")}" loading="lazy" decoding="async"></button>`).join("")}
        ${audios.map((x) => `<div class="cm-audio"><span aria-hidden="true">🎤</span>${x.audio_url ? `<audio controls preload="none" src="${esc(x.audio_url)}"></audio>` : "<small>Cargando el audio…</small>"}<small>${esc(x.created_by_name || "")} · ${esc(clock(x.seconds))}</small>${x.created_by === ctx.store?.user?.id ? `<button type="button" class="mini-x" data-action="del-audio" data-id="${esc(x.id)}" aria-label="Borrar el audio">✕</button>` : ""}</div>`).join("")}</div>`
      : "";
  const thread = commentsOf("activity", a.id);

  return `<article class="card" style="--i:${index}" data-cat="${esc(a.category)}" data-search="${esc(searchText(a))}">
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
      ${media}
      <details data-id="${esc(a.id)}" ${state.open.has(a.id) ? "open" : ""}>
        <summary>${icon("chat", 16)} Comentarios <span class="count">${thread.length}</span></summary>
        ${threadHtml("activity", a.id)}
      </details>
    </div>
  </article>`;
}

export function renderPlan() {
  const nav = planNav();
  if (state.planTab === "food") return nav + renderFood();
  if (state.planTab === "expenses") return nav + renderExpenses();
  if (state.planTab === "packing") return nav + renderPacking();
  return nav + renderDays();
}

function renderDays() {
  const routes = currentRoutes();
  const km = routes.reduce((sum, r) => sum + r.km, 0);
  const roadRoutes = routes.some((r) => r.road);
  const spent = state.expenses.length
    ? stat("Gastos repartidos", money.format(fromCents(totalCents())), "wallet", "go-expenses")
    : stat("Costes anotados", money.format(totalCost()), "wallet", "go-expenses");
  const stats = `<div class="stats">
    ${stat("Días del viaje", allDays().length || "—", "calendar")}
    ${stat("Actividades", state.activities.length, "route")}
    ${spent}
    ${stat(roadRoutes ? "Recorrido por carretera" : "Recorrido", km ? formatKm(km) : "—", "car", km ? "go-map" : "")}
  </div>`;

  const days = allDays();
  if (!days.length) {
    return `<div class="plan-grid"><aside class="plan-aside">${colaBand()}${renderToday()}${stats}</aside><div class="plan-main">${gate("Todavía no hay nada", "Añade la primera actividad del viaje.", `<button class="btn primary" data-action="add" data-day="${todayIso()}">${icon("plus", 18)} Añadir actividad</button>`)}</div></div>`;
  }

  const commentsByActivity = groupBy(state.comments, (c) => c.activity_id);
  const activitiesByDay = groupBy([...state.activities].sort(byTime), (a) => a.day);
  const routeByDay = new Map(routes.map((r) => [r.day, r]));
  let index = 0;
  const chips = [`<button class="chip-filter ${state.filter.cat ? "" : "is-on"}" data-action="filter-cat" data-cat="">Todo</button>`]
    .concat(Object.entries(CATEGORIES).map(([key, c]) => `<button class="chip-filter ${state.filter.cat === key ? "is-on" : ""}" data-action="filter-cat" data-cat="${key}">${c.emoji} ${c.label}</button>`))
    .join("");
  const filters = `<div class="plan-filters">
    <label class="search"><span class="search-ico">${icon("search", 16)}</span><input id="plan-search" data-keep="plan-search" type="search" placeholder="Buscar actividades, lugares, notas…" value="${esc(state.filter.q)}" autocomplete="off" enterkeyhint="search"></label>
    <div class="filter-row">${chips}</div>
  </div>
  <p class="empty filter-empty" hidden>Ningún plan coincide con la búsqueda.</p>`;

  const sections = days.map((day, i) => {
    const items = activitiesByDay.get(day) ?? [];
    const route = routeByDay.get(day);
    const sub = [state.places[day], items.length ? `${items.length} ${items.length === 1 ? "plan" : "planes"}` : "Sin planes", route ? `${formatKm(route.km)}${route.road ? "" : " en línea recta"}` : ""].filter(Boolean).join(" · ");
    return `<section class="day" style="--c:${dayColor(i)}">
      <header class="day-head">
        <span class="day-dot"></span>
        <div class="day-title"><h2>${esc(capitalize(fmtDayLong.format(utc(day))))}</h2><p class="day-sub">${weatherChip(day)}<span>${esc(sub)}</span></p></div>
        <div class="day-tools">
          ${items.length ? `<button class="icon-btn sm" title="Compartir el plan del día" aria-label="Compartir el plan del día" data-action="share-day" data-day="${esc(day)}">${icon("share", 17)}</button>` : ""}
          ${items.some(hasCoords) ? `<button class="icon-btn sm" title="Ver el día en el mapa" aria-label="Ver el día en el mapa" data-action="day-on-map" data-day="${esc(day)}">${icon("map", 18)}</button>` : ""}
          <button class="icon-btn sm accent" title="Añadir actividad" aria-label="Añadir actividad" data-action="add" data-day="${esc(day)}">${icon("plus", 18)}</button>
        </div>
      </header>
      ${items.length ? items.map((a) => card(a, commentsByActivity.get(a.id) ?? [], index++)).join("") : `<p class="empty">Sin planes todavía.</p>`}
    </section>`;
  });
  return `<div class="plan-grid"><aside class="plan-aside">${colaBand()}${renderToday()}${renderIdeas()}${stats}</aside><div class="plan-main">${filters}${sections.join("")}</div></div>`;
}

// ---------- fotos ----------

export function renderPhotos() {
  const photos = mergeQueued(photosNewestFirst()); // + las que esperan señal en el móvil (cola.js)
  const waiting = photos.filter((p) => p.queued && p.qstate !== "done").length;
  const real = photos.length - waiting;
  const located = photos.filter((p) => hasCoords(p) && !(p.queued && p.qstate !== "done")).length;
  const head = `<div class="page-head">
    <div><h2>Fotos</h2><p class="page-sub">${real} ${real === 1 ? "foto" : "fotos"}${real ? ` · ${located} con ubicación` : ""}${waiting ? ` · ${waiting} en cola` : ""}</p></div>
    <div class="head-actions">
      ${located ? `<button class="btn small" data-action="photos-on-map">${icon("map", 16)} Ver en el mapa</button>` : ""}
      <button class="btn small" data-action="upload">${icon("images", 16)} Elegir fotos</button>
      <button class="btn small primary" data-action="camera">${icon("camera", 16)} Hacer foto</button>
    </div>
  </div>`;
  const band = colaBand();
  if (!photos.length) {
    return head + band + gate("Aún no hay fotos", "Sube las primeras: si traen ubicación GPS, aparecerán en el mapa donde se tomaron.", `<button class="btn primary" data-action="camera">${icon("camera", 18)} Hacer una foto</button> <button class="btn" data-action="upload">${icon("images", 18)} Elegir fotos</button>`);
  }
  // Se agrupan por día siguiendo el mismo orden que el visor (de la más reciente a la más antigua).
  const groups = [];
  for (const p of photos) {
    const day = photoDay(p);
    if (groups.at(-1)?.day === day) groups.at(-1).items.push(p);
    else groups.push({ day, items: [p] });
  }
  let n = 0;
  const html = groups
    .map((g) => {
      const label = g.day ? capitalize(fmtDayShort.format(utc(g.day))) : "Sin fecha";
      const thumbs = g.items
        .map(
          (p, k) => p.queued
            ? queuedTile(p, { featured: k === 0 && g.items.length >= 4, delay: Math.min(n++, 24) })
            : `<button class="photo ${k === 0 && g.items.length >= 4 ? "is-featured" : ""}" style="--i:${Math.min(n++, 24)}" data-action="open-photo" data-id="${esc(p.id)}" aria-label="Abrir foto de ${esc(p.created_by_name || "un viajero")}">
            <img ${isFresh(p.id) ? 'class="loaded" ' : ""}src="${esc(k === 0 && g.items.length >= 4 ? p.full_url || p.thumb_url : p.thumb_url)}" alt="${esc(p.caption || "")}" loading="lazy" decoding="async" onload="this.classList.add('loaded')">
            ${hasCoords(p) ? `<span class="geo-badge" title="Con ubicación">${icon("pin", 13)}</span>` : ""}
            ${ratingBadgeHtml(p.id)}
          </button>`,
        )
        .join("");
      return `<section class="photo-day"><h3>${esc(label)} <small>${g.items.length} ${g.items.length === 1 ? "foto" : "fotos"}</small></h3><div class="photo-grid">${thumbs}</div></section>`;
    })
    .join("");
  return head + band + topRatedHtml() + html;
}

// ---------- dónde comimos ----------

export function renderFood() {
  const list = buildAlbum().food; // mejor valorados primero, con las fotos hechas en cada sitio
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
          ${a.photos.length ? `<div class="food-photos">${a.photos.slice(0, 4).map((p) => `<button class="food-photo" data-action="open-photo" data-id="${esc(p.id)}" aria-label="Abrir foto"><img src="${esc(p.thumb_url)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')"></button>`).join("")}${a.photos.length > 4 ? `<span class="food-more">+${a.photos.length - 4}</span>` : ""}</div>` : ""}
        </div>
      </article>`;
    })
    .join("");
  return `<div class="page-head"><div><h2>Dónde comimos</h2><p class="page-sub">De mejor a peor valorado</p></div>
    <div class="head-actions"><button class="btn small primary" data-action="add" data-day="${todayIso()}" data-category="comida">${icon("plus", 16)} Añadir</button></div></div>
    ${summary}<div class="food-grid">${cards}</div>`;
}

// ---------- mapa: chips de días y hoja inferior ----------

export function renderChips() {
  const days = allDays();
  const counts = new Map([...groupBy(locatedStops(days), (s) => s.day)].map(([day, list]) => [day, list.length]));
  const friends = friendsNow();
  const live = friends.length ? `<button class="chip-day live" data-action="fit-friends"><span class="dot"></span>${friends.length} en vivo</button>` : "";
  const all = `<button class="chip-day ${state.day ? "" : "is-on"}" role="tab" aria-selected="${!state.day}" data-action="select-day" data-day="">Todo el viaje</button>`;
  return (
    encuentroChip() + // «📍 Punto de encuentro»: el primer botón de la fila (rojo si hay uno activo)
    live +
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
  const locateHint = locateHintHtml(state.day || "");
  if (!stops.length) {
    return `<div class="sheet-empty">
      <div class="gate-art sm">${icon("pin", 26)}</div>
      <div><strong>${state.day ? "Este día no tiene lugares en el mapa" : "Aún no hay lugares en el mapa"}</strong>
      <p>Mantén pulsado el mapa para añadir un lugar, o añade la ubicación a una actividad.</p>${locateHint}</div>
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
  const city = state.day ? state.places[state.day] : "";
  return `<div class="sheet-head"><h2>${esc(title)}${state.day ? weatherChip(state.day) : ""}</h2><p>${[city ? `${icon("pin", 13)} ${esc(city)}` : "", ...facts].filter(Boolean).join(" · ")}</p>${locateHint}</div><div class="sheet-track">${cards}</div>`;
}
