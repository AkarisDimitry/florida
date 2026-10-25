// Vista "Álbum" de la página: se genera sola a partir de lo que hay en el viaje. Devuelve HTML ya escapado.
import { icon } from "./icons.js";
import { esc, hasCoords, utc, money, formatKm, fmtDate, fmtStamp, stars, safeFormat } from "./util.js";
import { buildAlbum } from "./album.js";
import { mapImage } from "./mapimage.js";
import { directionsUrl } from "./geo.js";
import { gate, weatherChip } from "./views.js";
import { nearbyWiki } from "./places.js";
import { hueOf } from "./ledger.js";

let current = null; // el álbum que se está mostrando; hydrateAlbum() lo usa para dibujar los mapas

const timeFmt = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" });
const timeFmtWall = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const photoTime = (p) => safeFormat(p.taken_at ? timeFmtWall : timeFmt, p.taken_at || p.created_at);
const starRow = (n) => `<span class="stars" aria-label="${n} de 5 estrellas">${stars(n)}</span>`;
const number = (n) => n.toFixed(1).replace(".", ",");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function tile(label, value, iconName) {
  return `<div class="stat"><span class="stat-ico">${icon(iconName, 18)}</span><div><span class="stat-label">${esc(label)}</span><strong>${esc(value)}</strong></div></div>`;
}

function photoStrip(photos, className = "") {
  if (!photos.length) return "";
  return `<div class="album-photos ${className}">${photos
    .map(
      (p) => `<button type="button" class="album-photo" data-action="open-photo" data-id="${esc(p.id)}" aria-label="Abrir foto de ${esc(p.created_by_name || "un viajero")}">
        <img src="${esc(p.thumb_url)}" alt="${esc(p.caption || "")}" loading="lazy" decoding="async" onload="this.classList.add('loaded')">
        <span class="album-photo-cap">${p.caption ? esc(p.caption) : `${esc(p.created_by_name || "")}${p.created_by_name ? " · " : ""}${esc(photoTime(p))}${hasCoords(p) ? ` ${icon("pin", 11)}` : ""}`}</span>
      </button>`,
    )
    .join("")}</div>`;
}

function hero(album) {
  const { trip, cover, stats } = album;
  const dates = trip.start && trip.end ? `${fmtDate.format(utc(trip.start))} – ${fmtDate.format(utc(trip.end))}` : "";
  const collage = cover.length
    ? `<div class="album-collage n${Math.min(cover.length, 5)}">${cover.map((p, i) => `<img src="${esc(i === 0 ? p.full_url || p.thumb_url : p.thumb_url)}" alt="" decoding="async">`).join("")}</div>`
    : "";
  const chips = [
    plural(stats.days, "día", "días"),
    stats.places ? plural(stats.places, "lugar", "lugares") : "",
    stats.km ? formatKm(stats.km) : "",
    stats.photos ? plural(stats.photos, "foto", "fotos") : "",
  ].filter(Boolean);
  return `<section class="album-hero ${cover.length ? "" : "is-plain"}">
    ${collage}
    <div class="album-hero-text">
      <p class="eyebrow">Álbum del viaje</p>
      <h2>${esc(trip.name)}</h2>
      <p class="album-hero-sub">${esc([trip.destination, dates].filter(Boolean).join(" · "))}</p>
      <div class="album-hero-chips">${chips.map((c) => `<span>${esc(c)}</span>`).join("")}</div>
    </div>
  </section>
  <div class="album-actions">
    <button class="btn primary" data-action="album-pdf">${icon("download", 18)} Descargar PDF</button>
    <p class="hint">Se actualiza solo con lo que vayáis añadiendo.</p>
  </div>`;
}

function statsBlock(album) {
  const { stats, highlights } = album;
  const tiles = [
    tile("Días con recuerdos", stats.days, "calendar"),
    tile("Lugares", stats.places, "pin"),
    tile(stats.kmByRoad ? "Kilómetros por carretera" : "Kilómetros", stats.km ? formatKm(stats.km) : "—", "car"),
    tile("Fotos", `${stats.photos}${stats.photosLocated ? ` (${stats.photosLocated} con ubicación)` : ""}`, "camera"),
    tile("Gasto anotado", money.format(stats.spent), "download"),
    tile("Sitios para comer", stats.foodPlaces ? `${stats.foodPlaces}${stats.foodAverage ? ` · ${number(stats.foodAverage)} ★` : ""}` : "—", "food"),
  ];
  const facts = [
    highlights.topFood ? `<li>Mejor valorado para comer: <strong>${esc(highlights.topFood.title)}</strong> ${starRow(highlights.topFood.rating)}</li>` : "",
    highlights.busiest ? `<li>Día con más planes: <strong>${esc(highlights.busiest.title)}</strong> (${highlights.busiest.activities.length})</li>` : "",
    highlights.longest ? `<li>Día de más carretera: <strong>${esc(highlights.longest.title)}</strong> (${formatKm(highlights.longest.km)})</li>` : "",
    highlights.priciest ? `<li>Mayor gasto: <strong>${esc(highlights.priciest.title)}</strong> (${esc(money.format(highlights.priciest.cost))})</li>` : "",
    stats.authors.length ? `<li>Viajeros que han aportado: <strong>${esc(stats.authors.join(", "))}</strong></li>` : "",
    stats.comments ? `<li>${plural(stats.comments, "comentario", "comentarios")} en las actividades</li>` : "",
  ].filter(Boolean);
  return `<section class="album-sec"><h3>El viaje en cifras</h3><div class="stats">${tiles.join("")}</div>${facts.length ? `<ul class="album-facts">${facts.join("")}</ul>` : ""}</section>`;
}

function awardsBlock(album) {
  if (!album.awards.length) return "";
  return `<section class="album-sec"><h3>Premios del viaje</h3><div class="awards">${album.awards
    .map((a) => `<div class="award"><span class="award-emoji" aria-hidden="true">${a.emoji}</span><div><small>${esc(a.title)}</small><strong>${esc(a.winner)}</strong><span>${esc(a.detail)}</span></div></div>`)
    .join("")}</div></section>`;
}

function ledgerBlock(album) {
  const l = album.ledger;
  if (!l) return "";
  const dot = (name) => `<span class="person-dot" style="--h:${hueOf(name)}" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>`;
  return `<section class="album-sec"><h3>Cuentas entre viajeros</h3>
    <p class="album-total"><strong>${esc(money.format(l.total))}</strong><span>en ${plural(l.count, "gasto repartido", "gastos repartidos")}</span></p>
    <h4>Para quedar en paz</h4>
    ${l.payments.length
      ? `<ul class="settle">${l.payments.map((p) => `<li>${dot(p.from)}<span class="settle-names"><b>${esc(p.from)}</b> ${icon("arrowRight", 15)} <b>${esc(p.to)}</b></span><strong>${esc(money.format(p.amount))}</strong></li>`).join("")}</ul>`
      : `<p class="settle-ok">🎉 Todos en paz: nadie debe nada.</p>`}
    <h4>Lo que pagó cada uno</h4>
    <ul class="people">${l.rows
      .map((r) => `<li class="person">${dot(r.name)}<div class="person-body"><strong>${esc(r.name)}</strong><p>Pagó ${esc(money.format(r.paid))} · le tocan ${esc(money.format(r.owed))}</p></div><span class="balance ${r.balance > 0.004 ? "is-plus" : r.balance < -0.004 ? "is-minus" : ""}">${r.balance > 0.004 ? "+" : r.balance < -0.004 ? "−" : ""}${esc(money.format(Math.abs(r.balance)))}</span></li>`)
      .join("")}</ul>
  </section>`;
}

const mapPlaceholder = (id, label, action = "") =>
  `<button type="button" class="album-map" data-album-map="${esc(id)}" ${action} aria-label="${esc(label)}"><span class="album-map-msg">Dibujando el mapa…</span></button>`;

function entry(a, color) {
  const place = a.place
    ? hasCoords(a)
      ? `<a href="${esc(directionsUrl(a.lat, a.lng))}" target="_blank" rel="noopener">${esc(a.place)}</a>`
      : esc(a.place)
    : "";
  const meta = [a.start_time ? esc(a.start_time.slice(0, 5)) : "", place, a.cost != null ? esc(money.format(a.cost)) : "", a.rating ? starRow(a.rating) : "", a.created_by_name ? `por ${esc(a.created_by_name)}` : ""].filter(Boolean);
  const added = safeFormat(fmtStamp, a.created_at);
  const data = [hasCoords(a) ? `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}` : "", added ? `añadido el ${added}` : ""].filter(Boolean);
  return `<article class="entry" style="--c:${color}">
    <span class="entry-badge ${a.order ? "is-num" : ""}" title="${esc(a.cat.label)}">${a.order ?? a.cat.emoji}</span>
    <div class="entry-body">
      <h4>${a.order ? `${a.cat.emoji} ` : ""}${esc(a.title)}</h4>
      ${meta.length ? `<p class="entry-meta">${meta.join(" · ")}</p>` : ""}
      ${a.notes ? `<p class="entry-notes">${esc(a.notes)}</p>` : ""}
      ${photoStrip(a.photos)}
      ${a.comments.map((c) => `<blockquote class="quote"><p>${esc(c.body)}</p><cite>${esc(c.created_by_name || "Alguien")}</cite></blockquote>`).join("")}
      ${data.length ? `<p class="entry-data">${esc(data.join(" · "))}</p>` : ""}
    </div>
  </article>`;
}

function chapter(c) {
  const facts = [plural(c.activities.length, "actividad", "actividades"), c.km ? `${formatKm(c.km)}${c.route?.road ? "" : " en línea recta"}` : "", c.cost ? money.format(c.cost) : ""].filter(Boolean);
  return `<section class="chapter" style="--c:${c.color}">
    <header class="chapter-head">
      <span class="chapter-num">Día ${c.number}</span>
      <h3>${esc(c.title)}</h3>
      ${c.city ? `<p class="chapter-place">${icon("pin", 13)} ${esc(c.city)}</p>` : ""}
      <p>${esc(facts.join(" · "))}</p>
      ${weatherChip(c.day, { withRain: true })}
    </header>
    ${c.summary ? `<p class="day-summary">${esc(c.summary)}</p>` : ""}
    ${c.stops.length ? mapPlaceholder(`day:${c.day}`, `Mapa de ${c.title}: ver el día en el mapa`, `data-action="day-on-map" data-day="${esc(c.day)}"`) : ""}
    ${c.center ? `<section class="wiki" data-wiki="${c.center.lat},${c.center.lng}"></section>` : ""}
    ${c.activities.map((a) => entry(a, c.color)).join("")}
    ${c.loosePhotos.length ? `<div class="entry-loose"><h4>Más fotos del día</h4>${photoStrip(c.loosePhotos)}</div>` : ""}
  </section>`;
}

function expenses(album) {
  const { expenses: e } = album;
  if (!e.total) return "";
  const maxCat = e.byCategory[0]?.total || 1;
  const maxDay = Math.max(...e.byDay.map((d) => d.total), 1);
  const bar = (label, value, max, color) =>
    `<div class="bar-row"><span class="bar-label">${label}</span><div class="bar"><i style="width:${Math.max(3, (value / max) * 100)}%;${color ? `background:${color}` : ""}"></i></div><span class="bar-val">${esc(money.format(value))}</span></div>`;
  return `<section class="album-sec"><h3>Gastos</h3>
    <p class="album-total"><strong>${esc(money.format(e.total))}</strong><span>en total${e.daysWithCost > 1 ? ` · ${esc(money.format(e.perDay))} de media por día con gastos` : ""}</span></p>
    <h4>Por tipo</h4><div class="bars">${e.byCategory.map((c) => bar(`${c.emoji} ${esc(c.label)}`, c.total, maxCat)).join("")}</div>
    ${e.byDay.length > 1 ? `<h4>Por día</h4><div class="bars">${e.byDay.map((d) => bar(esc(d.label), d.total, maxDay, d.color)).join("")}</div>` : ""}
    <h4>Los mayores</h4>
    <ol class="album-top">${e.top.map((a) => `<li><span>${esc(a.title)}</span><strong>${esc(money.format(a.cost))}</strong></li>`).join("")}</ol>
  </section>`;
}

function foodBlock(album) {
  if (!album.food.length) return "";
  return `<section class="album-sec"><h3>Dónde comimos</h3>
    <ol class="rank">${album.food
      .map((f, i) => {
        const place = f.place && f.place !== f.title ? esc(f.place) : "";
        const meta = [esc(f.dayTitle), place, f.cost != null ? esc(money.format(f.cost)) : ""].filter(Boolean);
        return `<li class="rank-item">
          <span class="rank-n">${i + 1}</span>
          <div class="rank-body"><strong>${esc(f.title)}</strong> ${f.rating ? starRow(f.rating) : ""}<p>${meta.join(" · ")}</p>${photoStrip(f.photos.slice(0, 3), "small")}</div>
        </li>`;
      })
      .join("")}</ol>
  </section>`;
}

export function renderAlbum() {
  const album = buildAlbum();
  current = album;
  if (album.isEmpty) {
    return gate(
      "Tu álbum se irá llenando",
      "Cuando añadáis actividades, lugares, fotos y gastos, aquí aparecerá el álbum del viaje, listo para descargar en PDF.",
      `<button class="btn primary" data-action="add" data-day="">${icon("plus", 18)} Añadir la primera actividad</button>`,
    );
  }
  const overview = album.routes.length || album.placeIndex.length ? `<section class="album-sec"><h3>El recorrido</h3>${mapPlaceholder("overview", "Mapa de todo el recorrido")}</section>` : "";
  const orphans = album.orphans.length ? `<section class="album-sec"><h3>Más recuerdos</h3>${photoStrip(album.orphans)}</section>` : "";
  return `<div class="album">
    ${hero(album)}
    ${statsBlock(album)}
    ${awardsBlock(album)}
    ${overview}
    ${album.chapters.map(chapter).join("")}
    ${expenses(album)}
    ${ledgerBlock(album)}
    ${foodBlock(album)}
    ${orphans}
    <p class="album-foot">Álbum generado automáticamente el ${esc(safeFormat(fmtStamp, album.generatedAt))} a partir de ${plural(album.stats.activities, "actividad", "actividades")}, ${plural(album.stats.photos, "foto", "fotos")} y ${plural(album.stats.comments, "comentario", "comentarios")}.</p>
  </div>`;
}

// ---------- mapas: se dibujan al llegar a ellos al hacer scroll ----------

let observer = null;

function mapOptions(id) {
  if (id === "overview") return { stops: current.placeIndex, routes: current.routes, width: 900, height: 520, numbered: false };
  const chapterOf = current.chapters.find((c) => `day:${c.day}` === id);
  return chapterOf ? { stops: chapterOf.stops, routes: chapterOf.route ? [chapterOf.route] : [], width: 900, height: 520, numbered: true } : null;
}

async function fillMap(element) {
  const options = current && mapOptions(element.dataset.albumMap);
  if (!options) return;
  element.classList.add("is-loading");
  const url = await mapImage(options);
  element.classList.remove("is-loading");
  if (!element.isConnected) return;
  if (url) {
    element.classList.add("is-ready");
    element.innerHTML = `<img src="${url}" alt="" decoding="async">`;
  } else {
    element.classList.add("is-failed");
    element.innerHTML = `<span class="album-map-msg">No se pudo dibujar el mapa (hace falta conexión)</span>`;
  }
}

async function fillWiki(element) {
  const [lat, lng] = element.dataset.wiki.split(",").map(Number);
  const items = await nearbyWiki(lat, lng).catch(() => []);
  if (!items.length || !element.isConnected) return;
  element.innerHTML = `<h4>Cerca de aquí · Wikipedia</h4>${items
    .map(
      (i) => `<a class="wiki-item" href="${esc(i.url)}" target="_blank" rel="noopener">${i.thumb ? `<img src="${esc(i.thumb)}" alt="" loading="lazy" decoding="async">` : ""}<div><strong>${esc(i.title)}</strong><span>${esc(i.extract)}</span></div></a>`,
    )
    .join("")}<small>Texto de Wikipedia, licencia CC BY-SA 4.0.</small>`;
}

export function hydrateAlbum(root) {
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (entry.target.dataset.wiki) fillWiki(entry.target);
        else fillMap(entry.target);
      }
    },
    { rootMargin: "250px" },
  );
  for (const element of root.querySelectorAll("[data-album-map], [data-wiki]")) observer.observe(element);
}

export function stopHydrating() {
  observer?.disconnect();
  observer = null;
}
