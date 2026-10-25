// Diálogos: actividad (con búsqueda de lugar y ubicación), perfil, visor de fotos y panel de datos.
import { config } from "./config.js";
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, $$, esc, hasCoords, CATEGORIES, guarded, toast, schemaHint, authHint, fmtStamp, fmtStampWallClock } from "./util.js";
import { getName, setName } from "./store.js";
import { defaultDay, photoTime, photosNewestFirst } from "./trip.js";
import { currentPosition, nearest, reversePlace, searchPlaces } from "./geo.js";
import { EXPORTERS } from "./export.js";
import { settings, setSetting } from "./settings.js";

const activityDialog = $("#activity-dialog");
const activityForm = $("#activity-form");
const profileDialog = $("#profile-dialog");
const profileForm = $("#profile-form");
const lightbox = $("#lightbox");
const dataDialog = $("#data-dialog");
const settingsDialog = $("#settings-dialog");
const pdfDialog = $("#pdf-dialog");
const pdfForm = $("#pdf-form");

// ---------- perfil ----------

export function openProfile() {
  const needsEmail = ctx.store.mode === "supabase" && !ctx.store.user;
  const signedIn = ctx.store.mode === "supabase" && ctx.store.user;
  profileForm.elements.name.value = getName();
  profileForm.elements.email.required = needsEmail;
  $("#email-field").hidden = !needsEmail;
  $("#signout-btn").hidden = !signedIn;
  $("#profile-title").textContent = needsEmail ? "Entrar" : "Tu perfil";
  $("#profile-hint").textContent = needsEmail
    ? "Te enviaremos un enlace al correo; ábrelo en este mismo dispositivo."
    : signedIn
      ? `Has entrado como ${ctx.store.user.email}. La sesión se queda guardada en este dispositivo: no hace falta volver a entrar.`
      : "Tu nombre aparece junto a lo que añades y comentas.";
  $("#profile-submit").textContent = needsEmail ? "Enviar enlace" : "Guardar";
  profileDialog.showModal();
}

export function requireName() {
  if (getName()) return true;
  toast("Primero dinos tu nombre.");
  openProfile();
  return false;
}

// ---------- actividad ----------

let searchResults = [];

function setLocation(lat, lng) {
  const has = Number.isFinite(lat) && Number.isFinite(lng);
  activityForm.elements.lat.value = has ? lat : "";
  activityForm.elements.lng.value = has ? lng : "";
  $("#loc-chip").hidden = !has;
  $("#loc-text").innerHTML = has ? `${icon("pin", 14)} ${lat.toFixed(4)}, ${lng.toFixed(4)}` : "";
}

const numberOrNull = (value) => (value === "" || value == null ? null : Number(value));

function readDraft() {
  const f = new FormData(activityForm);
  return Object.fromEntries(["title", "day", "start_time", "category", "cost", "place", "notes", "lat", "lng", "rating"].map((k) => [k, f.get(k) ?? ""]));
}

function fillForm(v) {
  const e = activityForm.elements;
  e.title.value = v.title ?? "";
  e.day.value = v.day ?? "";
  e.start_time.value = v.start_time ? String(v.start_time).slice(0, 5) : "";
  e.category.value = v.category ?? "otro";
  e.cost.value = v.cost ?? "";
  e.place.value = v.place ?? "";
  e.notes.value = v.notes ?? "";
  setLocation(numberOrNull(v.lat), numberOrNull(v.lng));
  for (const radio of $$("[name=rating]", activityForm)) radio.checked = radio.value === String(v.rating ?? "");
  $("#geo-results").hidden = true;
}

// Rellena el nombre del lugar a partir de las coordenadas, sin pisar lo que haya escrito la persona.
async function suggestPlaceName(lat, lng) {
  try {
    const found = await reversePlace(lat, lng);
    if (found && !activityForm.elements.place.value) activityForm.elements.place.value = found.name;
  } catch {
    /* el nombre es opcional */
  }
}

export function openActivity({ id, day, category, lat, lng, title, place, notes, searchQuery } = {}) {
  if (!requireName()) return;
  const a = state.activities.find((x) => x.id === id);
  state.editingId = a?.id ?? null;
  $("#activity-title").textContent = a ? "Editar actividad" : "Nueva actividad";
  activityForm.reset();
  fillForm({ ...(a ?? {}), day: a?.day ?? day ?? defaultDay(), category: a?.category ?? category ?? "otro", lat: a?.lat ?? lat, lng: a?.lng ?? lng, title: a?.title ?? title, place: a?.place ?? place, notes: a?.notes ?? notes });
  activityDialog.showModal();
  if (!a && Number.isFinite(lat) && !place) suggestPlaceName(lat, lng);
  if (!a && searchQuery && !Number.isFinite(lat)) guarded(() => runSearch(searchQuery))(); // lugar compartido sin coordenadas: se busca por el nombre
}

// Sesga la búsqueda hacia donde ya hay lugares (o hacia la vista inicial del mapa).
function searchBias() {
  const located = state.activities.filter(hasCoords);
  if (!located.length) return { lng: config.map.center[0], lat: config.map.center[1] };
  return { lat: located.reduce((s, a) => s + a.lat, 0) / located.length, lng: located.reduce((s, a) => s + a.lng, 0) / located.length };
}

async function runSearch(override) {
  const query = (typeof override === "string" ? override : activityForm.elements.place.value).trim();
  if (query.length < 3) return toast("Escribe al menos 3 letras del lugar.");
  const button = $("#geo-search");
  button.disabled = true;
  const list = $("#geo-results");
  try {
    searchResults = await searchPlaces(query, searchBias());
    list.innerHTML = searchResults.length
      ? searchResults.map((r, i) => `<li><button type="button" data-i="${i}"><strong>${esc(r.name)}</strong><span>${esc(r.detail)}</span></button></li>`).join("")
      : `<li class="none">Sin resultados. Prueba con otro nombre o elige el punto en el mapa.</li>`;
    list.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function bindActivityDialog() {
  const e = activityForm.elements;
  e.category.innerHTML = Object.entries(CATEGORIES)
    .map(([value, c]) => `<option value="${value}">${c.emoji} ${c.label}</option>`)
    .join("");

  $("#geo-search").addEventListener("click", guarded(runSearch));
  e.place.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    guarded(runSearch)();
  });
  $("#geo-results").addEventListener("click", (event) => {
    const result = searchResults[event.target.closest("button")?.dataset.i];
    if (!result) return;
    e.place.value = result.name;
    if (!e.title.value.trim()) e.title.value = result.name;
    setLocation(result.lat, result.lng);
    $("#geo-results").hidden = true;
  });

  $("#loc-clear").addEventListener("click", () => setLocation(null, null));
  $("#rating-clear").addEventListener("click", () => $$("[name=rating]", activityForm).forEach((r) => (r.checked = false)));
  $("#loc-here").addEventListener(
    "click",
    guarded(async () => {
      const pos = await currentPosition();
      setLocation(pos.lat, pos.lng);
      if (!e.place.value) suggestPlaceName(pos.lat, pos.lng);
    }),
  );
  $("#loc-pick").addEventListener(
    "click",
    guarded(async () => {
      const draft = readDraft();
      activityDialog.close();
      const spot = await ctx.actions.pickOnMap("Toca el mapa para elegir el lugar");
      fillForm({ ...draft, ...(spot ?? {}) });
      activityDialog.showModal();
      if (spot && !draft.place) suggestPlaceName(spot.lat, spot.lng);
    }),
  );

  activityForm.addEventListener(
    "submit",
    guarded(async (event) => {
      event.preventDefault();
      const f = new FormData(activityForm);
      const activity = {
        day: f.get("day"),
        start_time: f.get("start_time") || null,
        title: f.get("title").trim(),
        category: f.get("category"),
        place: f.get("place").trim() || null,
        lat: numberOrNull(f.get("lat")),
        lng: numberOrNull(f.get("lng")),
        cost: numberOrNull(f.get("cost")),
        rating: numberOrNull(f.get("rating")),
        notes: f.get("notes").trim() || null,
      };
      if (state.editingId) activity.id = state.editingId;
      try {
        await ctx.store.saveActivity(activity);
      } catch (err) {
        throw schemaHint(err);
      }
      activityDialog.close();
      await ctx.actions.refresh();
    }),
  );
}

// ---------- visor de fotos ----------

const captionForm = $("#lb-caption-form");
let captionFor = null;

export function showPhoto(id) {
  const photos = photosNewestFirst();
  const i = photos.findIndex((p) => p.id === id);
  if (i < 0) {
    if (lightbox.open) lightbox.close();
    return;
  }
  const photo = photos[i];
  state.lightboxId = id;
  const own = photo.created_by === ctx.store.user?.id;
  const located = hasCoords(photo);

  const img = $("#lightbox-img");
  if (img.getAttribute("src") !== photo.full_url) img.src = photo.full_url;
  img.alt = `Foto de ${photo.created_by_name || "un viajero"}`;

  // taken_at es la hora de reloj de la cámara (se guarda como UTC sin convertir); created_at es un instante real.
  const when = (photo.taken_at ? fmtStampWallClock : fmtStamp).format(new Date(photoTime(photo)));
  $("#lightbox-caption").textContent = `${photo.created_by_name || "Alguien"} · ${photo.taken_at ? "tomada el" : "subida el"} ${when}`;
  const near = located ? nearest(photo, state.activities.filter(hasCoords), 0.4) : null;
  $("#lightbox-where").innerHTML = located
    ? `${icon("pin", 14)} ${near ? `Cerca de «${esc(near.title)}»` : `${photo.lat.toFixed(4)}, ${photo.lng.toFixed(4)}`}`
    : "Sin ubicación";

  const note = $("#lightbox-note");
  note.hidden = !photo.caption;
  note.textContent = photo.caption ? `“${photo.caption}”` : "";
  $("#lb-caption-btn").hidden = !own;
  $("#lb-caption-btn").innerHTML = `${icon("edit", 15)} ${photo.caption ? "Editar pie" : "Añadir pie"}`;
  if (captionForm.hidden === false && captionFor !== id) captionForm.hidden = true; // al cambiar de foto se cierra el editor
  $("#lb-prev").disabled = i === 0;
  $("#lb-next").disabled = i === photos.length - 1;
  $("#lb-open").href = photo.full_url;
  $("#lb-delete").hidden = !own;
  $("#lb-map").hidden = !located;
  $("#lb-here").hidden = !own || located;
  $("#lb-pick").hidden = !own;
  $("#lb-pick").innerHTML = `${icon("pin", 15)} ${located ? "Cambiar ubicación" : "Elegir en el mapa"}`;
  $("#lb-unplace").hidden = !own || !located;
  if (!lightbox.open) lightbox.showModal();
}

export function refreshLightbox() {
  if (lightbox.open) showPhoto(state.lightboxId);
}

function stepPhoto(delta) {
  const photos = photosNewestFirst();
  const next = photos[photos.findIndex((p) => p.id === state.lightboxId) + delta];
  if (next) showPhoto(next.id);
}

function bindLightbox() {
  $("#lb-map").innerHTML = `${icon("map", 15)} Ver en el mapa`;
  $("#lb-here").innerHTML = `${icon("locate", 15)} Usar mi ubicación`;
  const selected = () => state.lightboxId;
  const place = async (spot) => {
    await ctx.store.updatePhoto(selected(), { lat: spot?.lat ?? null, lng: spot?.lng ?? null });
    await ctx.actions.refresh();
  };

  // Pie de foto (solo la persona que la subió).
  $("#lb-caption-btn").addEventListener("click", () => {
    const photo = state.photos.find((p) => p.id === selected());
    if (!photo) return;
    captionFor = photo.id;
    captionForm.elements.caption.value = photo.caption ?? "";
    captionForm.hidden = false;
    captionForm.elements.caption.focus();
  });
  $("#lb-caption-cancel").addEventListener("click", () => (captionForm.hidden = true));
  captionForm.addEventListener(
    "submit",
    guarded(async (event) => {
      event.preventDefault();
      const caption = captionForm.elements.caption.value.trim() || null;
      try {
        await ctx.store.updatePhoto(captionFor, { caption });
      } catch (err) {
        throw schemaHint(err);
      }
      captionForm.hidden = true;
      await ctx.actions.refresh();
    }),
  );
  captionForm.addEventListener("keydown", (event) => event.stopPropagation()); // las flechas mueven el cursor, no la foto

  // Deslizar con el dedo para pasar de foto.
  let touch = null;
  const stage = $(".lightbox-stage");
  stage.addEventListener("touchstart", (event) => (touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null), { passive: true });
  stage.addEventListener("touchend", (event) => {
    if (!touch) return;
    const dx = event.changedTouches[0].clientX - touch.x;
    const dy = event.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepPhoto(dx < 0 ? 1 : -1);
  });

  $("#lb-prev").addEventListener("click", () => stepPhoto(-1));
  $("#lb-next").addEventListener("click", () => stepPhoto(1));
  lightbox.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") stepPhoto(-1);
    else if (event.key === "ArrowRight") stepPhoto(1);
  });
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) lightbox.close();
  });

  $("#lb-map").addEventListener("click", () => {
    const id = selected();
    lightbox.close();
    ctx.actions.focusPhotoOnMap(id);
  });
  $("#lb-here").addEventListener("click", guarded(async () => place(await currentPosition())));
  $("#lb-pick").addEventListener(
    "click",
    guarded(async () => {
      const id = selected();
      lightbox.close();
      const spot = await ctx.actions.pickOnMap("Toca el mapa para colocar la foto");
      if (spot) await place(spot);
      showPhoto(id);
    }),
  );
  $("#lb-unplace").addEventListener(
    "click",
    guarded(async () => {
      if (confirm("¿Quitar la ubicación de esta foto?")) await place(null);
    }),
  );
  $("#lb-delete").addEventListener(
    "click",
    guarded(async () => {
      const photo = state.photos.find((p) => p.id === selected());
      if (!photo || !confirm("¿Borrar esta foto? No se puede deshacer.")) return;
      await ctx.store.deletePhoto(photo);
      lightbox.close();
      await ctx.actions.refresh();
    }),
  );
}

// ---------- ajustes y opciones del PDF ----------

function syncSettings() {
  for (const group of $$("[data-setting]")) {
    for (const button of $$("button", group)) button.setAttribute("aria-pressed", String(String(settings[group.dataset.setting]) === button.dataset.value));
  }
}

export function openSettings() {
  syncSettings();
  $("#live-section").hidden = ctx.store?.mode !== "supabase";
  $("#live-toggle").checked = Boolean(state.sharing);
  settingsDialog.showModal();
}

export function openPdfOptions() {
  for (const name of ["pdfMaps", "pdfComments", "pdfWiki", "pdfAppendix"]) pdfForm.elements[name].checked = settings[name];
  pdfForm.elements.pdfQuality.value = settings.pdfQuality;
  const canShareFiles = typeof navigator.canShare === "function" && navigator.canShare({ files: [new File(["x"], "album.pdf", { type: "application/pdf" })] });
  $("#pdf-share").hidden = !canShareFiles;
  pdfDialog.showModal();
}

function bindSettings() {
  $("#settings-btn").innerHTML = `<span class="list-ico">${icon("layers", 20)}</span><span class="list-text"><strong>Ajustes</strong><small>Tema, unidades (km o millas, °C o °F), animaciones, ubicación en vivo</small></span>`;
  $("#settings-btn").addEventListener("click", () => {
    dataDialog.close();
    openSettings();
  });
  settingsDialog.addEventListener("click", (event) => {
    const button = event.target.closest("[data-setting] button");
    if (!button) return;
    setSetting(button.closest("[data-setting]").dataset.setting, button.dataset.value);
    syncSettings();
  });

  const run = (share) =>
    guarded(async () => {
      for (const name of ["pdfMaps", "pdfComments", "pdfWiki", "pdfAppendix"]) setSetting(name, pdfForm.elements[name].checked);
      setSetting("pdfQuality", pdfForm.elements.pdfQuality.value);
      pdfDialog.close();
      await ctx.actions.exportPdf({ share });
    });
  pdfForm.addEventListener("submit", (event) => {
    event.preventDefault();
    run(false)();
  });
  $("#pdf-share").addEventListener("click", run(true));
}

// ---------- datos y móvil ----------

export function openData() {
  $("#demo-hint").hidden = ctx.store?.mode !== "demo";
  const pending = state.requests.filter((r) => r.status === "pending").length;
  $("#access-btn").hidden = !state.isAdmin;
  $("#access-btn").innerHTML = `<span class="list-ico">${icon("share", 20)}</span><span class="list-text"><strong>Viajeros y solicitudes${pending ? ` · ${pending} pendiente${pending === 1 ? "" : "s"}` : ""}</strong><small>Aprobar a quien pide acceso, añadir o quitar viajeros</small></span>`;
  dataDialog.showModal();
}

const EXPORT_ITEMS = [
  ["pdf", "book", "Álbum del viaje", "PDF con mapas, fotos, gastos, comidas y comentarios"],
  ["json", "file", "Copia completa", "Actividades, comentarios, gastos, maleta y datos de fotos (JSON)"],
  ["csv", "file", "Actividades en hoja de cálculo", "CSV para Excel, Numbers o Google Sheets"],
  ["gastos", "wallet", "Gastos repartidos", "CSV con quién pagó cada gasto y entre quién se reparte"],
  ["gpx", "route", "Ruta y lugares", "GPX para apps de navegación y Google Earth"],
  ["geojson", "map", "Mapa", "GeoJSON con lugares, fotos y rutas (QGIS, etc.)"],
  ["ics", "calendarPlus", "Calendario del móvil", "ICS: añade el itinerario a tu calendario"],
  ["zip", "images", "Todas las fotos", "ZIP con las fotos y un CSV con sus ubicaciones"],
];

function bindDataDialog() {
  $("#export-list").innerHTML = EXPORT_ITEMS.map(
    ([kind, ico, title, sub]) =>
      `<button type="button" class="list-btn" data-export="${kind}"><span class="list-ico">${icon(ico, 20)}</span><span class="list-text"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span></button>`,
  ).join("");
  $("#export-list").addEventListener(
    "click",
    guarded(async (event) => {
      const kind = event.target.closest("[data-export]")?.dataset.export;
      if (!kind) return;
      if (kind === "pdf") {
        dataDialog.close();
        return openPdfOptions();
      }
      // El PDF y el ZIP tardan: se cierra el panel para ver el progreso, que se muestra encima de la página.
      if (kind === "zip" || kind === "pdf") dataDialog.close();
      await EXPORTERS[kind]();
      if (kind !== "zip" && kind !== "pdf") toast("Archivo descargado");
    }),
  );

  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $("#ios-hint").hidden = !(ios && !standalone);

  const installButton = $("#install-btn");
  installButton.innerHTML = `<span class="list-ico">${icon("phone", 20)}</span><span class="list-text"><strong>Instalar la app</strong><small>Icono en la pantalla de inicio y acceso sin conexión</small></span>`;
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstall = event;
    installButton.hidden = standalone;
  });
  installButton.addEventListener(
    "click",
    guarded(async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      installButton.hidden = true;
    }),
  );

  const shareButton = $("#share-btn");
  shareButton.innerHTML = `<span class="list-ico">${icon("share", 20)}</span><span class="list-text"><strong>Compartir el enlace</strong><small>Envíaselo a quien viaja contigo</small></span>`;
  shareButton.addEventListener(
    "click",
    guarded(async () => {
      const url = location.origin + location.pathname;
      if (navigator.share) {
        try {
          await navigator.share({ title: config.trip.name, text: `Mira el viaje: ${config.trip.name}`, url });
        } catch (err) {
          if (err.name !== "AbortError") throw err;
        }
      } else {
        await navigator.clipboard.writeText(url);
        toast("Enlace copiado");
      }
    }),
  );
}

// ---------- arranque ----------

export function initDialogs() {
  for (const el of $$("[data-icon]")) el.innerHTML = icon(el.dataset.icon);
  for (const button of $$("[data-close]")) button.addEventListener("click", () => button.closest("dialog").close());

  $("#geo-search").innerHTML = `${icon("search", 15)} Buscar`;
  $("#loc-here").innerHTML = `${icon("locate", 15)} Mi ubicación`;
  $("#loc-pick").innerHTML = `${icon("pin", 15)} Elegir en el mapa`;

  profileForm.addEventListener(
    "submit",
    guarded(async (event) => {
      event.preventDefault();
      const f = new FormData(profileForm);
      setName(f.get("name").trim());
      if (ctx.store.mode === "supabase" && !ctx.store.user) {
        try {
          await ctx.store.signIn(f.get("email").trim());
        } catch (err) {
          throw authHint(err);
        }
        ctx.actions.showCodeStep?.(f.get("email").trim().toLowerCase());
        toast("Listo: revisa tu correo y abre el enlace de acceso.");
      }
      profileDialog.close();
      ctx.actions.render();
      ctx.actions.resumeSharedPlace?.();
    }),
  );
  $("#signout-btn").addEventListener(
    "click",
    guarded(async () => {
      await ctx.store.stopHeartbeat?.().catch(() => {}); // deja de aparecer en línea antes de cerrar la sesión
      await ctx.store.signOut();
      profileDialog.close();
    }),
  );
  $("#session-btn").addEventListener("click", openProfile);
  $("#data-btn").addEventListener("click", openData);

  bindActivityDialog();
  bindLightbox();
  bindDataDialog();
  bindSettings();
}
