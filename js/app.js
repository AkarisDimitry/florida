import { state, ctx, VIEWS, hashOf, viewOfHash, persist } from "./state.js";
import { createStore } from "./store.js";
import { createMap } from "./map.js";
import { prepareImage } from "./images.js";
import { icon } from "./icons.js";
import { $, $$, esc, guarded, toast, hasCoords, reducedMotion, schemaHint, utc, capitalize, fmtDayShort } from "./util.js";
import { allDays, locatedStops, stopsOfDay, currentRoutes, onRoutesChange, photosNewestFirst } from "./trip.js";
import { renderHeader, renderPlan, renderPhotos, renderFood, renderChips, renderSheet, gate, enterButton } from "./views.js";
import { initDialogs, openActivity, openProfile, requireName, showPhoto, refreshLightbox } from "./dialogs.js";

const main = $("#main");
const mapView = $("#map-view");
const SNAPSHOT_KEY = "viaje.copia";

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const theme = () => (darkQuery.matches ? "dark" : "light");
const dayLabel = (day) => capitalize(fmtDayShort.format(utc(day)));

// ---------- datos ----------

function readSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(SNAPSHOT_KEY));
  } catch {
    return null;
  }
}

// Última copia buena de los datos, para poder consultar el itinerario sin cobertura (los enlaces de las
// fotos caducan, así que no se guardan).
function saveSnapshot() {
  const photos = state.photos.map(({ full_url, thumb_url, ...meta }) => meta);
  persist(SNAPSHOT_KEY, { activities: state.activities, comments: state.comments, photos, member: true });
}

const isNetworkError = (err) => err instanceof TypeError || /fetch|network|failed to/i.test(err?.message || "");

async function refresh() {
  const supabase = ctx.store.mode === "supabase";
  try {
    if (supabase && !ctx.store.user) {
      Object.assign(state, { activities: [], comments: [], photos: [], member: true, offline: false });
      localStorage.removeItem(SNAPSHOT_KEY);
    } else {
      Object.assign(state, await ctx.store.load(), { offline: false });
      if (supabase && state.member) saveSnapshot();
    }
  } catch (err) {
    const snapshot = supabase ? readSnapshot() : null;
    if (snapshot && isNetworkError(err)) Object.assign(state, snapshot, { offline: true });
    else {
      console.error(err);
      toast(err.message || "No se pudieron cargar los datos");
    }
  }
  render();
}

let refreshTimer;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
};

// ---------- vistas ----------

function gateHtml() {
  if (ctx.store.mode === "supabase" && !ctx.store.user) {
    return gate("Web privada", "Entra con tu correo para ver el viaje. Te enviaremos un enlace de acceso.", enterButton);
  }
  if (!state.member) {
    return gate(
      "Aún no tienes acceso",
      `Has entrado como <strong>${esc(ctx.store.user.email)}</strong>, pero ese correo no figura en la lista de viajeros. Pide a quien organiza el viaje que lo añada.`,
    );
  }
  return "";
}

let renderedView = null;
let mapWasVisible = false;
let mapFitted = false;

function render() {
  renderHeader();
  const gated = gateHtml();
  const view = gated ? "gate" : state.view;
  document.body.dataset.view = view;
  const tabbar = $("#tabbar");
  tabbar.style.setProperty("--tab-i", Math.max(0, VIEWS.indexOf(state.view)));
  for (const tab of $$(".tab", tabbar)) {
    if (tab.dataset.view === state.view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }

  const showMap = view === "map";
  mapView.hidden = !showMap;
  main.hidden = showMap;
  if (!showMap && mapWasVisible) {
    ctx.map.stopPlayback();
    ctx.map.cancelPick();
  }

  if (showMap) {
    renderMapView(!mapWasVisible);
  } else {
    // Un refresco remoto no debe quitarle el foco a quien está escribiendo un comentario.
    const typingId = document.activeElement?.closest?.(".comment-form")?.dataset.activity;
    main.innerHTML = gated || { plan: renderPlan, photos: renderPhotos, food: renderFood }[view]();
    if (typingId) {
      const input = main.querySelector(`.comment-form[data-activity="${CSS.escape(typingId)}"] input`);
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
    main.classList.remove("enter");
    if (renderedView !== view) {
      void main.offsetWidth; // reinicia las animaciones de entrada solo al cambiar de vista
      main.classList.add("enter");
    }
  }
  mapWasVisible = showMap;
  renderedView = view;
  refreshLightbox();
}

// ---------- mapa ----------

function mapPhotos() {
  return photosNewestFirst().filter(hasCoords);
}

function pushMapData() {
  ctx.map.update({
    stops: locatedStops(),
    photos: mapPhotos(),
    routes: currentRoutes(),
    layers: state.layers,
    activeDay: state.day,
    selected: state.selectedStop,
    selectedPhoto: state.selectedPhoto,
  });
}

function allCoords() {
  return [...currentRoutes().flatMap((r) => r.coords), ...locatedStops().map((s) => [s.lng, s.lat]), ...(state.layers.photos ? mapPhotos().map((p) => [p.lng, p.lat]) : [])];
}

function renderMapView(becameVisible) {
  const map = ctx.map;
  if (!map.ready() && !map.init(theme())) {
    $("#map-chips").innerHTML = "";
    $("#map-sheet").innerHTML = `<div class="sheet-empty"><div><strong>No se puede mostrar el mapa</strong><p>${esc(map.error()?.message ?? "")}</p></div></div>`;
    return;
  }
  if (becameVisible) map.resize();
  pushMapData();

  $("#map-chips").innerHTML = renderChips();
  const sheet = $("#map-sheet");
  const scroll = sheet.querySelector(".sheet-track")?.scrollLeft ?? 0;
  sheet.innerHTML = renderSheet();
  const track = sheet.querySelector(".sheet-track");
  if (track) track.scrollLeft = scroll;
  syncMapControls();

  if (!mapFitted) {
    const coords = allCoords();
    if (coords.length) {
      mapFitted = true;
      map.fit(coords, { maxZoom: 13, duration: 0 });
    }
  }
}

function syncMapControls() {
  for (const input of $$("[data-layer]")) input.checked = state.layers[input.dataset.layer];
  for (const button of $$("[data-road]")) button.setAttribute("aria-pressed", String(button.dataset.road === String(state.roadMode)));
  const playing = ctx.map.isPlaying();
  $("#fab-play").innerHTML = icon(playing ? "pause" : "play", 22);
  $("#fab-play").classList.toggle("is-on", playing);
  $("#fab-play").setAttribute("aria-label", playing ? "Detener la reproducción" : "Reproducir el viaje");
  $("#fab-locate").classList.toggle("is-on", ctx.map.isLocating());
}

function showMapBanner(html, { cancellable = false } = {}) {
  const banner = $("#map-banner");
  banner.innerHTML = `<span>${html}</span>${cancellable ? `<button type="button" class="link-btn" data-action="cancel-pick">Cancelar</button>` : ""}`;
  banner.hidden = false;
}
const hideMapBanner = () => ($("#map-banner").hidden = true);

function fitAll() {
  const coords = allCoords();
  if (coords.length) ctx.map.fit(coords, { maxZoom: 13 });
}

function selectDay(day) {
  ctx.map.stopPlayback();
  state.day = day || null;
  state.selectedStop = null;
  render();
  if (!state.day) return fitAll();
  const route = currentRoutes().find((r) => r.day === state.day);
  const stops = stopsOfDay(state.day);
  ctx.map.fit(route ? route.coords : stops.map((s) => [s.lng, s.lat]));
  if (route) ctx.map.drawIn(route.coords, route.color, route.day);
}

function selectStop(id) {
  const stop = locatedStops().find((s) => s.id === id);
  if (!stop) return;
  state.selectedStop = id;
  render();
  ctx.map.flyTo(stop.lat, stop.lng, 15);
  $(`.stop-card[data-stop="${CSS.escape(id)}"]`)?.scrollIntoView({ inline: "center", block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

async function togglePlay() {
  if (ctx.map.isPlaying()) return ctx.map.stopPlayback();
  const routes = currentRoutes().filter((r) => !state.day || r.day === state.day);
  if (!routes.length) return toast("Para reproducir el viaje hacen falta al menos dos lugares con ubicación en el mismo día.");
  $("#layers-panel").hidden = true;
  const stopsById = new Map(locatedStops().map((s) => [s.id, s]));
  const started = ctx.map.play(
    routes.map((r) => ({ day: r.day, color: r.color, coords: r.coords, stops: stopsOfDay(r.day) })),
    {
      onSegment: (segment) => showMapBanner(`${icon("route", 16)} ${esc(dayLabel(segment.day))}`),
      onStop: (id) => showMapBanner(`${icon("pin", 16)} ${esc(stopsById.get(id)?.title ?? "")}`),
      onEnd: () => {
        hideMapBanner();
        syncMapControls();
      },
    },
  );
  syncMapControls();
  await started;
}

function setView(view) {
  if (view === state.view) return;
  state.view = view;
  history.replaceState(null, "", `${location.pathname}${location.search}${hashOf(view)}`);
  window.scrollTo(0, 0);
  render();
}

// Lleva a la persona al mapa para que toque un punto; vuelve a la vista de origen al terminar.
async function pickOnMap(text) {
  const previous = state.view;
  setView("map");
  if (!ctx.map.ready()) {
    toast("El mapa no está disponible.");
    setView(previous);
    return null;
  }
  showMapBanner(`${icon("pin", 16)} ${esc(text)}`, { cancellable: true });
  const spot = await ctx.map.pick();
  hideMapBanner();
  setView(previous);
  return spot;
}

function focusStopOnMap(id) {
  state.selectedStop = id;
  state.day = null;
  setView("map");
  render();
  selectStop(id);
}

function focusPhotoOnMap(id) {
  const photo = state.photos.find((p) => p.id === id);
  if (!hasCoords(photo)) return;
  state.selectedPhoto = id;
  setView("map");
  render();
  ctx.map.flyTo(photo.lat, photo.lng, 16.5);
  setTimeout(() => {
    if (state.selectedPhoto === id) {
      state.selectedPhoto = null;
      if (state.view === "map") pushMapData();
    }
  }, 7000);
}

// ---------- eventos ----------

const actions = {
  profile: () => openProfile(),
  upload: () => requireName() && $("#photo-input").click(),
  "open-photo": ({ id }) => showPhoto(id),
  add: ({ day, category }) => openActivity({ day: day || undefined, category }),
  edit: ({ id }) => openActivity({ id }),
  delete: async ({ id }) => {
    const a = state.activities.find((x) => x.id === id);
    if (confirm(`¿Borrar «${a?.title}»? También se borrarán sus comentarios.`)) {
      await ctx.store.deleteActivity(id);
      await refresh();
    }
  },
  "del-comment": async ({ id }) => {
    await ctx.store.deleteComment(id);
    await refresh();
  },
  "show-on-map": ({ id }) => focusStopOnMap(id),
  "day-on-map": ({ day }) => {
    setView("map");
    selectDay(day);
  },
  "photos-on-map": () => {
    setView("map");
    const coords = mapPhotos().map((p) => [p.lng, p.lat]);
    if (coords.length) ctx.map.fit(coords, { maxZoom: 14 });
  },
  "select-day": ({ day }) => selectDay(day),
  "select-stop": ({ id }) => selectStop(id),
  "cancel-pick": () => ctx.map.cancelPick(),
};

const onAction = guarded(async (event) => {
  if (event.target.closest("a[href]")) return; // los enlaces (cómo llegar, abrir) siguen su curso
  const element = event.target.closest("[data-action]");
  if (!element) return;
  await actions[element.dataset.action]?.({ ...element.dataset });
});
main.addEventListener("click", onAction);
$(".map-ui").addEventListener("click", onAction);
$(".map-ui").addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".stop-card")) {
    event.preventDefault();
    event.target.click();
  }
});

main.addEventListener(
  "submit",
  guarded(async (event) => {
    const form = event.target.closest(".comment-form");
    if (!form) return;
    event.preventDefault();
    if (!requireName()) return;
    const id = form.dataset.activity;
    const body = form.body.value.trim();
    if (!body) return;
    await ctx.store.addComment(id, body);
    delete state.drafts[id];
    state.open.add(id);
    await refresh();
  }),
);
main.addEventListener("input", (event) => {
  const form = event.target.closest(".comment-form");
  if (form) state.drafts[form.dataset.activity] = event.target.value;
});
// "toggle" no burbujea, por eso se escucha en la fase de captura.
main.addEventListener(
  "toggle",
  (event) => {
    const id = event.target.dataset?.id;
    if (!id) return;
    if (event.target.open) state.open.add(id);
    else state.open.delete(id);
  },
  true,
);

// pestañas
const TABS = { map: ["map", "Mapa"], plan: ["calendar", "Itinerario"], photos: ["camera", "Fotos"], food: ["food", "Comida"] };
for (const tab of $$(".tab")) {
  const [ico, label] = TABS[tab.dataset.view];
  tab.innerHTML = `${icon(ico, 22)}<span>${label}</span>`;
  tab.addEventListener("click", () => setView(tab.dataset.view));
}
$("#data-btn").innerHTML = icon("more", 22);
$("#fab-fit").innerHTML = icon("fit", 22);
$("#fab-locate").innerHTML = icon("locate", 22);
$("#fab-layers").innerHTML = icon("layers", 22);

// controles del mapa
$("#fab-play").addEventListener("click", guarded(togglePlay));
$("#fab-fit").addEventListener("click", () => selectDay(null));
$("#fab-locate").addEventListener("click", () => {
  if (ctx.map.isLocating()) {
    ctx.map.stopLocate();
    toast("Ubicación desactivada", 2500);
  } else {
    ctx.map.locate({
      onError: (err) => {
        toast(err.message);
        syncMapControls();
      },
    });
  }
  syncMapControls();
});
$("#fab-layers").addEventListener("click", () => {
  const panel = $("#layers-panel");
  panel.hidden = !panel.hidden;
  $("#fab-layers").setAttribute("aria-expanded", String(!panel.hidden));
  $("#fab-layers").classList.toggle("is-on", !panel.hidden);
});
$("#layers-panel").addEventListener("change", (event) => {
  const layer = event.target.dataset.layer;
  if (!layer) return;
  state.layers[layer] = event.target.checked;
  persist("viaje.capas", state.layers);
  pushMapData();
});
$("#layers-panel").addEventListener("click", (event) => {
  const road = event.target.closest("[data-road]")?.dataset.road;
  if (road == null) return;
  state.roadMode = road === "true";
  persist("viaje.rutaCarretera", state.roadMode);
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#layers-panel").hidden) $("#fab-layers").click();
});

// subida de fotos
$("#photo-input").addEventListener(
  "change",
  guarded(async (event) => {
    const input = event.target;
    const files = [...input.files];
    input.value = "";
    const failed = [];
    let uploaded = 0;
    let located = 0;
    for (const [i, file] of files.entries()) {
      toast(`Subiendo foto ${i + 1} de ${files.length}…`, 60000);
      try {
        const prepared = await prepareImage(file);
        try {
          await ctx.store.addPhoto(prepared);
        } catch (err) {
          throw schemaHint(err);
        }
        uploaded++;
        if (hasCoords(prepared)) located++;
        await refresh();
      } catch (err) {
        console.error(err);
        failed.push(err.message || file.name);
      }
    }
    if (failed.length) toast(`${failed.length} de ${files.length} sin subir: ${failed[0]}`, 8000);
    else if (located === uploaded) toast(uploaded === 1 ? "Foto subida, con su ubicación" : `${uploaded} fotos subidas, todas con ubicación`);
    else if (located === 0)
      toast("Subidas, pero ninguna trae ubicación. En iPhone, al elegirlas toca «Opciones» y activa «Ubicación». También puedes colocarlas a mano: abre la foto y elige el punto en el mapa.", 11000);
    else toast(`${uploaded} fotos subidas, ${located} con ubicación. Las demás se pueden colocar a mano desde el visor.`, 8000);
  }),
);

// ---------- arranque ----------

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ctx.store) scheduleRefresh();
});
// Enlaces como «…/#fotos» (accesos directos de la app instalada, marcadores) cambian de vista.
window.addEventListener("hashchange", () => {
  const view = viewOfHash(location.hash);
  if (view && ctx.store) setView(view);
});
darkQuery.addEventListener("change", () => ctx.map?.setTheme(theme()));
initDialogs();

try {
  ctx.actions = { refresh, render, pickOnMap, focusPhotoOnMap };
  ctx.store = await createStore(scheduleRefresh);
  ctx.map = createMap({
    container: $("#map"),
    onStop: selectStop,
    onPhoto: showPhoto,
    onLongPress: ({ lat, lng }) => {
      navigator.vibrate?.(15);
      openActivity({ day: state.day || undefined, lat, lng });
    },
  });
  onRoutesChange(render);
  await refresh();
} catch (err) {
  console.error(err);
  $("#session-btn").hidden = true;
  main.hidden = false;
  main.innerHTML = gate("No se pudo arrancar", esc(err.message || String(err)));
}

// Instalación y uso sin conexión: solo en HTTPS (en local se evita para no cachear versiones viejas).
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Sin service worker:", err.message));
}
