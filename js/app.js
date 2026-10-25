import { state, ctx, VIEWS, hashOf, viewOfHash, planTabOfHash, persist } from "./state.js";
import { createStore, getName, setName } from "./store.js";
import { createMap } from "./map.js";
import { prepareImage } from "./images.js";
import { icon } from "./icons.js";
import { $, $$, esc, guarded, toast, hasCoords, reducedMotion, schemaHint, authHint, utc, capitalize, fmtDayShort } from "./util.js";
import { allDays, locatedStops, stopsOfDay, currentRoutes, onRoutesChange, photosNewestFirst, dayTargets, friendsNow } from "./trip.js";
import { loadWeather } from "./weather.js";
import { startSharing, stopSharing } from "./live.js";
import { cityName } from "./places.js";
import { currentPosition } from "./geo.js";
import { settings, onSettingChange } from "./settings.js";
import { renderHeader, renderPlan, renderPhotos, renderFood, renderChips, renderSheet, gate } from "./views.js";
import { initDialogs, openActivity, openProfile, openPdfOptions, requireName, showPhoto, refreshLightbox } from "./dialogs.js";
import { initExpenseDialog, openExpense } from "./expensedialog.js";
import { ledgerText, TYPICAL_ITEMS } from "./extras.js";
import { canonical } from "./ledger.js";
import { dayPlanText, parseSharedPlace } from "./share.js";
import { initDiscover, openDiscover } from "./discover.js";
import { initAccess, openAccess, refreshAccess } from "./accessdialog.js";
import { startPresence, stopPresence, refreshPeople } from "./presence.js";
import { initPeople, refreshPeopleDialog } from "./people.js";
import { renderAlbum, hydrateAlbum, stopHydrating } from "./albumview.js";

const main = $("#main");
const mapView = $("#map-view");
const SNAPSHOT_KEY = "viaje.copia";

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const theme = () => (settings.theme === "auto" ? (darkQuery.matches ? "dark" : "light") : settings.theme);
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
  persist(SNAPSHOT_KEY, { activities: state.activities, comments: state.comments, photos, expenses: state.expenses, checklist: state.checklist, member: true });
}

const isNetworkError = (err) => err instanceof TypeError || /fetch|network|failed to/i.test(err?.message || "");

async function refresh() {
  const supabase = ctx.store.mode === "supabase";
  try {
    if (supabase && !ctx.store.user) {
      Object.assign(state, { activities: [], comments: [], photos: [], expenses: [], checklist: [], isAdmin: false, requests: [], myRequest: null, member: true, offline: false });
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
  refreshEnvironment();
  syncPresence();
}

// Solo cambió quién está en línea o dónde está: recarga ligera (no vuelve a pedir actividades, fotos, etc.).
let peopleTimer;
const schedulePeople = () => {
  clearTimeout(peopleTimer);
  peopleTimer = setTimeout(refreshPeople, 400);
};

// Repinta solo lo que muestra personas: el botón de la cabecera, los viajeros en el mapa y el panel «Viajeros».
function applyPeople() {
  renderHeader();
  if (state.view === "map" && ctx.map?.ready()) {
    pushMapData();
    $("#map-chips").innerHTML = renderChips();
  }
  refreshPeopleDialog();
}

// La presencia solo corre con sesión iniciada y siendo viajero autorizado.
function syncPresence() {
  if (ctx.store.mode === "supabase" && ctx.store.user && state.member && state.presenceOn) startPresence(applyPeople);
  else stopPresence();
}

let refreshTimer;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
};

// ---------- vistas ----------

// Pantalla de entrada: nombre y correo en dos campos, sin diálogos. Después, el enlace del correo o su código de 6 cifras.
const EMAIL_KEY = "viaje.correo";
const rememberedEmail = () => {
  try {
    return localStorage.getItem(EMAIL_KEY) || "";
  } catch {
    return "";
  }
};

function loginGate() {
  const d = state.drafts;
  const email = state.loginEmail || d.login_email || rememberedEmail();
  if (state.loginStep === "code") {
    return `<div class="gate login"><div class="gate-art">${icon("check", 34)}</div>
      <h2>Revisa tu correo</h2>
      <p>Hemos enviado un mensaje a <strong>${esc(email)}</strong> (mira también en «spam»). Pulsa el enlace <strong>desde este mismo móvil</strong>, o escribe aquí el código de 6 cifras que trae.</p>
      <form class="login-form" data-form="code">
        <input name="code" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="go" maxlength="10" placeholder="Código del correo" aria-label="Código del correo" required value="${esc(d.login_code || "")}">
        <button class="btn primary" type="submit">Entrar con el código</button>
      </form>
      <button class="link-btn" data-action="login-back">Usar otro correo o enviarlo de nuevo</button></div>`;
  }
  return `<div class="gate login"><div class="gate-art">${icon("map", 34)}</div>
    <h2>Entra al viaje</h2>
    <p>Escribe tu nombre y tu correo y te enviamos un enlace. <strong>Solo hace falta una vez:</strong> la sesión se queda guardada en este dispositivo.</p>
    <form class="login-form" data-form="login">
      <input name="name" maxlength="40" autocomplete="given-name" placeholder="Tu nombre" aria-label="Tu nombre" required value="${esc(d.login_name ?? getName())}">
      <input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" enterkeyhint="send" placeholder="Tu correo" aria-label="Tu correo" required value="${esc(email)}">
      <button class="btn primary" type="submit">Enviar enlace de acceso</button>
    </form></div>`;
}

function gateHtml() {
  if (ctx.store.mode === "supabase" && !ctx.store.user) return loginGate();
  if (!state.member) {
    const r = state.myRequest;
    let text = `Has entrado como <strong>${esc(ctx.store.user.email)}</strong>, pero ese correo aún no está en la lista de viajeros.`;
    let button = "";
    if (!state.access) text += " Pide a quien organiza el viaje que te añada.";
    else if (r?.status === "pending") {
      text += " Tu solicitud de acceso está <strong>pendiente</strong>: quien organiza el viaje tiene que aprobarla. Cuando lo haga, pulsa «Comprobar de nuevo».";
      button = `<button class="btn primary" data-action="recheck-access">Comprobar de nuevo</button>`;
    } else if (r?.status === "denied") text += " Tu solicitud de acceso fue rechazada. Si crees que es un error, habla con quien organiza el viaje.";
    else {
      text += " Puedes pedir acceso: quien organiza el viaje lo recibirá y podrá aprobarlo.";
      button = `<button class="btn primary" data-action="request-access">Pedir acceso</button>`;
    }
    return gate("Aún no tienes acceso", text, button);
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
    const typingPack = Boolean(document.activeElement?.matches?.(".pack-form input[name=text]"));
    let html = gated;
    try {
      html ||= { plan: renderPlan, photos: renderPhotos, food: renderFood, album: renderAlbum }[view]();
    } catch (err) {
      // Un dato raro no debe dejar la sección en blanco.
      console.error(err);
      html = gate("No se pudo mostrar esta sección", esc(err.message || String(err)));
    }
    main.innerHTML = html;
    if (view === "plan") applyPlanFilter();
    if (view === "album") hydrateAlbum(main);
    else stopHydrating();
    if (typingId) {
      const input = main.querySelector(`.comment-form[data-activity="${CSS.escape(typingId)}"] input`);
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
    if (typingPack) {
      const input = main.querySelector(".pack-form input[name=text]");
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
  refreshAccess();
}

// ---------- datos automáticos: tiempo y ciudad de cada día ----------

let environmentKey = "";
async function refreshEnvironment() {
  const targets = dayTargets();
  const key = JSON.stringify(targets.map((t) => [t.day, t.lat.toFixed(1), t.lng.toFixed(1)]));
  if (key === environmentKey) return;
  environmentKey = key;
  if (!targets.length) {
    Object.assign(state, { weather: new Map(), places: {} });
    return;
  }
  try {
    state.weather = await loadWeather(targets);
    render();
    // Las ciudades van de una en una (Nominatim pide ir despacio) y se guardan en el navegador.
    for (const t of targets) {
      if (key !== environmentKey) return; // los datos cambiaron mientras tanto
      const name = await cityName(t.lat, t.lng).catch(() => null);
      if (name && state.places[t.day] !== name) {
        state.places[t.day] = name;
        if (state.view !== "map") render();
      }
    }
    render();
  } catch (err) {
    console.warn("Datos automáticos no disponibles:", err.message || err);
    environmentKey = ""; // se reintenta en el próximo refresco
  }
}

// Filtro del itinerario: oculta tarjetas y días sin repintar (así no se pierde el foco al escribir).
function applyPlanFilter() {
  const q = state.filter.q.trim().toLowerCase();
  const cat = state.filter.cat;
  const filtering = Boolean(q || cat);
  let shown = 0;
  for (const section of main.querySelectorAll(".day")) {
    let any = false;
    for (const card of section.querySelectorAll(".card")) {
      const match = (!cat || card.dataset.cat === cat) && (!q || card.dataset.search.includes(q));
      card.hidden = !match;
      any ||= match;
      if (match) shown++;
    }
    section.hidden = filtering && !any;
  }
  const none = main.querySelector(".filter-empty");
  if (none) none.hidden = !filtering || shown > 0;
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
    friends: friendsNow(),
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
  $("#live-switch-row").hidden = ctx.store?.mode !== "supabase";
  $("#live-switch").checked = state.sharing;
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

function setView(view, planTab = "days") {
  const tab = view === "plan" ? planTab : "days";
  if (view === state.view && tab === state.planTab) return;
  state.view = view;
  state.planTab = tab;
  history.replaceState(null, "", `${location.pathname}${location.search}${hashOf(view, tab)}`);
  window.scrollTo(0, 0);
  navigator.vibrate?.(8);
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

// Lleva al mapa a donde ha compartido su ubicación otro viajero.
function focusPerson(lat, lng) {
  state.day = null;
  setView("map");
  if (ctx.map.ready()) ctx.map.flyTo(lat, lng, 15);
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
  "album-pdf": () => openPdfOptions(),
  "go-album": () => setView("album"),
  "locate-me": async () => {
    const pos = await currentPosition();
    state.me = { lat: pos.lat, lng: pos.lng };
    render();
  },
  "filter-cat": ({ cat }) => {
    state.filter.cat = cat || "";
    for (const chip of main.querySelectorAll(".chip-filter")) chip.classList.toggle("is-on", (chip.dataset.cat || "") === state.filter.cat);
    applyPlanFilter();
  },
  "fit-friends": () => {
    const coords = [...friendsNow().map((f) => [f.lng, f.lat]), ...(state.me ? [[state.me.lng, state.me.lat]] : [])];
    if (coords.length) ctx.map.fit(coords, { maxZoom: 14 });
  },
  "select-day": ({ day }) => selectDay(day),
  "select-stop": ({ id }) => selectStop(id),
  "cancel-pick": () => ctx.map.cancelPick(),

  "login-back": () => {
    state.loginStep = null;
    delete state.drafts.login_code;
    render();
  },
  "request-access": async () => {
    if (!requireName()) return;
    try {
      await ctx.store.requestAccess(getName());
    } catch (err) {
      throw schemaHint(err);
    }
    toast("Solicitud enviada: quien organiza el viaje la verá en la web.", 6000);
    await refresh();
  },
  "recheck-access": async () => {
    await refresh();
    if (!state.member) toast("Todavía pendiente de aprobación.", 3500);
  },
  "open-access": () => openAccess(),
  "plan-tab": ({ tab }) => setView("plan", tab),
  "go-expenses": () => setView("plan", "expenses"),
  "go-map": () => setView("map"),
  "add-expense": () => openExpense(),
  "edit-expense": ({ id }) => openExpense({ id }),
  "split-activity": ({ id }) => openExpense({ fromActivity: id }),
  "share-ledger": () => shareText(ledgerText(), "Cuentas del viaje"),
  "share-day": ({ day }) => shareText(dayPlanText(day), "Plan del día"),
  "toggle-pack": async ({ id }) => {
    const item = state.checklist.find((i) => i.id === id);
    if (!item || !requireName()) return;
    navigator.vibrate?.(10);
    await ctx.store.saveChecklistItem({ id, done: !item.done, done_by_name: item.done ? null : getName() });
    await refresh();
  },
  "delete-pack": async ({ id }) => {
    await ctx.store.deleteChecklistItem(id);
    await refresh();
  },
  "add-pack": async ({ text }) => {
    if (!requireName()) return;
    await addPackItems([text]);
  },
  "add-typical-pack": async () => {
    if (!requireName()) return;
    await addPackItems(TYPICAL_ITEMS);
  },
};

let packBusy = false; // un segundo toque mientras se guarda no debe repetir los elementos
async function addPackItems(texts, assigned_to = null) {
  if (packBusy) return 0;
  packBusy = true;
  try {
    return await addPackItemsNow(texts, assigned_to);
  } finally {
    packBusy = false;
  }
}

async function addPackItemsNow(texts, assigned_to) {
  const have = new Set(state.checklist.map((i) => i.text.trim().toLowerCase()));
  const fresh = [...new Set(texts.map((t) => t.trim()).filter(Boolean))].filter((t) => !have.has(t.toLowerCase()));
  try {
    for (const text of fresh) await ctx.store.saveChecklistItem({ text, assigned_to, done: false });
  } catch (err) {
    throw schemaHint(err);
  }
  await refresh();
  return fresh.length;
}

// En el móvil se abre la hoja de compartir; en el ordenador (donde esa hoja suele ser poco útil) se copia el texto.
async function shareText(text, title) {
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado: ya puedes pegarlo en el chat del grupo");
  } catch {
    toast("No se pudo copiar el texto.");
  }
}

const onAction = guarded(async (event) => {
  if (event.target.closest("a[href]")) return; // los enlaces (cómo llegar, abrir) siguen su curso
  const element = event.target.closest("[data-action]");
  if (!element) return;
  await actions[element.dataset.action]?.({ ...element.dataset });
});
main.addEventListener("click", onAction);
$("#banner").addEventListener("click", onAction);
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
    const loginForm = event.target.closest(".login-form");
    if (loginForm) {
      event.preventDefault();
      const button = loginForm.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        if (loginForm.dataset.form === "login") {
          const name = loginForm.elements.name.value.trim();
          const email = loginForm.elements.email.value.trim().toLowerCase();
          if (!name || !email) return;
          setName(name);
          try {
            localStorage.setItem(EMAIL_KEY, email);
          } catch {
            /* sin almacenamiento: se escribirá de nuevo */
          }
          try {
            await ctx.store.signIn(email);
          } catch (err) {
            throw authHint(err);
          }
          state.loginEmail = email;
          state.loginStep = "code";
          toast("Enlace enviado. Revisa tu correo.", 6000);
          render();
        } else {
          try {
            await ctx.store.verifyCode(state.loginEmail || rememberedEmail(), loginForm.elements.code.value);
          } catch {
            throw new Error("El código no es correcto o ya caducó. Revisa el último correo o pide uno nuevo.");
          }
          state.loginStep = null;
          delete state.drafts.login_code;
          toast("¡Listo! Ya has entrado y no hará falta repetirlo.", 4000);
        }
      } finally {
        button.disabled = false;
      }
      return;
    }
    const packForm = event.target.closest(".pack-form");
    if (packForm) {
      event.preventDefault();
      if (!requireName()) return;
      const text = packForm.text.value.trim();
      if (!text) return;
      delete state.drafts.pack;
      delete state.drafts.packWho;
      const who = packForm.assigned_to.value ? canonical(packForm.assigned_to.value) : null;
      await addPackItems([text], who);
      return;
    }
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
// La persona elegida en "quién lo lleva" también se conserva si la página se repinta (p. ej. por un cambio ajeno).
main.addEventListener("change", (event) => {
  if (event.target.closest(".pack-form") && event.target.name === "assigned_to") state.drafts.packWho = event.target.value;
});
main.addEventListener("input", (event) => {
  if (event.target.id === "plan-search") {
    state.filter.q = event.target.value;
    applyPlanFilter();
    return;
  }
  if (event.target.closest(".login-form")) state.drafts[`login_${event.target.name}`] = event.target.value;
  if (event.target.closest(".pack-form") && event.target.name === "text") state.drafts.pack = event.target.value;
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
const TABS = { map: ["map", "Mapa"], plan: ["calendar", "Itinerario"], photos: ["camera", "Fotos"], food: ["food", "Comida"], album: ["book", "Álbum"] };
for (const tab of $$(".tab")) {
  const [ico, label] = TABS[tab.dataset.view];
  tab.innerHTML = `${icon(ico, 22)}<span>${label}</span>`;
  tab.addEventListener("click", () => setView(tab.dataset.view));
}
$("#data-btn").innerHTML = icon("more", 22);
$(".people-ico").innerHTML = icon("users", 17);
$("#fab-fit").innerHTML = icon("fit", 22);
$("#fab-locate").innerHTML = icon("locate", 22);
$("#fab-layers").innerHTML = icon("layers", 22);
$("#fab-discover").innerHTML = icon("compass", 22);

// controles del mapa
$("#fab-play").addEventListener("click", guarded(togglePlay));
$("#fab-fit").addEventListener("click", () => selectDay(null));
$("#fab-discover").addEventListener("click", () => openDiscover());
$("#fab-locate").addEventListener("click", () => {
  if (ctx.map.isLocating()) {
    ctx.map.stopLocate();
    toast("Ubicación desactivada", 2500);
  } else {
    ctx.map.locate({
      onPosition: (pos) => (state.me = pos),
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

// subida de fotos (desde el selector o desde "Compartir" en la galería del móvil)
async function uploadFiles(files) {
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
}

$("#photo-input").addEventListener(
  "change",
  guarded(async (event) => {
    const input = event.target;
    const files = [...input.files];
    input.value = "";
    await uploadFiles(files);
  }),
);

// Fotos recibidas con "Compartir" desde la galería (Android, app instalada): las guardó el service worker.
async function receiveSharedPhotos() {
  if (!new URLSearchParams(location.search).has("compartido")) return;
  history.replaceState(null, "", `${location.pathname}#fotos`);
  const cache = await caches.open("viaje-compartido");
  const requests = await cache.keys();
  const files = await Promise.all(
    requests.map(async (request) => {
      const response = await cache.match(request);
      const blob = await response.blob();
      return new File([blob], decodeURIComponent(response.headers.get("X-Nombre") || "foto.jpg"), { type: blob.type });
    }),
  );
  for (const request of requests) await cache.delete(request);
  if (!files.length) return;
  setView("photos");
  if (ctx.store.mode === "supabase" && !ctx.store.user) return toast("Inicia sesión y vuelve a compartir las fotos.", 8000);
  if (!getName()) return toast("Pon tu nombre en el perfil y vuelve a compartir las fotos.", 8000);
  toast(`Recibidas ${files.length} ${files.length === 1 ? "foto" : "fotos"} desde la galería`, 2500);
  await uploadFiles(files);
}

// Un sitio compartido desde otra app (p. ej. Google Maps → Compartir → Viaje): se propone como actividad nueva.
async function receiveSharedPlace() {
  const text = new URLSearchParams(location.search).get("lugar");
  if (!text) return;
  history.replaceState(null, "", `${location.pathname}#plan`);
  if (ctx.store.mode === "supabase" && !ctx.store.user) return toast("Inicia sesión y vuelve a compartir el lugar.", 8000);
  // Sin nombre en el perfil no se puede crear nada: se guarda el lugar y se retoma al poner el nombre.
  if (!getName()) {
    state.pendingShared = text;
    toast("Pon tu nombre para añadir el lugar compartido.", 8000);
    return openProfile();
  }
  openSharedPlace(text);
}

function openSharedPlace(text) {
  const place = parseSharedPlace(text);
  setView("plan");
  openActivity({ day: state.day || undefined, ...place, searchQuery: place.query });
}

function resumeSharedPlace() {
  const text = state.pendingShared;
  if (!text || !getName()) return;
  state.pendingShared = null;
  openSharedPlace(text);
}

// ---------- ubicación en vivo ----------

function syncSharingUi() {
  $("#live-chip").hidden = !state.sharing;
  $("#live-switch").checked = state.sharing;
  $("#live-toggle").checked = state.sharing;
}

async function setSharing(on) {
  if (on === state.sharing) return syncSharingUi();
  try {
    if (on) {
      if (ctx.store.mode !== "supabase") toast("Compartir la ubicación necesita conectar Supabase (ver docs/DESPLIEGUE.md).");
      else if (requireName() && confirm("Los demás viajeros verán tu posición en el mapa mientras tengas la app abierta con esto activado. ¿Compartir mi ubicación?")) {
        startSharing({
          onError: (err) => toast(err.message), // p. ej. no se pudo enviar una posición: se sigue intentando
          onFatal: (err) => {
            toast(err.message);
            setSharing(false);
          },
        });
        state.sharing = true;
        toast("Compartiendo tu ubicación con los viajeros");
      }
    } else {
      state.sharing = false;
      await stopSharing();
      toast("Has dejado de compartir tu ubicación", 3000);
    }
  } catch (err) {
    state.sharing = false;
    toast(err.message || "No se pudo cambiar la ubicación en vivo");
  }
  syncSharingUi();
  refreshPeople();
}

$("#live-switch").addEventListener("change", (event) => setSharing(event.target.checked));
$("#live-toggle").addEventListener("change", (event) => setSharing(event.target.checked));
$("#live-chip").addEventListener("click", () => confirm("¿Dejar de compartir tu ubicación con los viajeros?") && setSharing(false));
// Las etiquetas "hace 3 min" de los viajeros se renuevan cada medio minuto.
setInterval(() => {
  if (state.view === "map" && ctx.map?.ready() && friendsNow().length) pushMapData();
}, 30_000);

let pdfBusy = false;
async function exportPdf(options) {
  if (pdfBusy) return toast("Ya se está preparando el PDF…");
  pdfBusy = true;
  try {
    await (await import("./pdf.js")).exportAlbumPdf(options);
  } finally {
    pdfBusy = false;
  }
}

onSettingChange((key) => {
  if (key === "theme") ctx.map?.setTheme(theme());
  if (ctx.store) render();
});

// Con el teclado del móvil abierto se esconde la barra de pestañas flotante (en CSS), para que no tape el campo.
const isTextField = (el) => Boolean(el?.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]), textarea, select") && !el.closest("dialog"));
document.addEventListener("focusin", (event) => document.body.classList.toggle("typing", isTextField(event.target)));
document.addEventListener("focusout", () => setTimeout(() => document.body.classList.toggle("typing", isTextField(document.activeElement)), 60));

// ---------- arranque ----------

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ctx.store) scheduleRefresh();
});
// Enlaces como «…/#fotos» (accesos directos de la app instalada, marcadores) cambian de vista.
window.addEventListener("hashchange", () => {
  const view = viewOfHash(location.hash);
  if (view && ctx.store) setView(view, planTabOfHash(location.hash));
});
darkQuery.addEventListener("change", () => ctx.map?.setTheme(theme()));
initDialogs();
initExpenseDialog();
initDiscover();
initAccess();
initPeople();

try {
  ctx.actions = { refresh, render, pickOnMap, focusPhotoOnMap, exportPdf, resumeSharedPlace, setSharing, focusPerson, showCodeStep: (email) => { state.loginEmail = email; state.loginStep = "code"; render(); } };
  ctx.store = await createStore(scheduleRefresh, schedulePeople);
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
  // Avisa a la red de seguridad de index.html de que esta versión de los archivos ha arrancado bien.
  document.documentElement.dataset.appReady = "1";
  try {
    sessionStorage.removeItem("viaje.recargaSinCache");
  } catch {
    /* sin sessionStorage */
  }
  await refresh();
  await receiveSharedPhotos().catch((err) => console.warn("Fotos compartidas:", err.message || err));
  await receiveSharedPlace().catch((err) => console.warn("Lugar compartido:", err.message || err));
} catch (err) {
  console.error(err);
  $("#session-btn").hidden = true;
  main.hidden = false;
  main.innerHTML = gate("No se pudo arrancar", `${esc(err.message || String(err))}<br><br>Si la web se acaba de actualizar, recárgala sin caché (Ctrl/Cmd + Mayús + R).`);
}

// Instalación y uso sin conexión: solo en HTTPS (en local se evita para no cachear versiones viejas).
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Sin service worker:", err.message));
}
