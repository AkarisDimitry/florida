import { config } from "./config.js";
import { createStore, getName, setName } from "./store.js";
import { prepareImage } from "./images.js";

const { trip } = config;
const $ = (selector) => document.querySelector(selector);

const CATEGORIES = {
  comida: "🍽️",
  visita: "🏛️",
  transporte: "🚆",
  alojamiento: "🏨",
  ocio: "🎉",
  otro: "📌",
};
const CATEGORY_LABELS = {
  comida: "Comida",
  visita: "Visita",
  transporte: "Transporte",
  alojamiento: "Alojamiento",
  ocio: "Ocio",
  otro: "Otro",
};

const state = {
  activities: [],
  comments: [],
  photos: [],
  member: true,
  view: location.hash === "#fotos" ? "photos" : "plan",
  lightboxId: null,
  open: new Set(), // actividades con los comentarios desplegados
  drafts: {}, // comentario a medio escribir, por actividad
  editingId: null,
};
let store;

const dayFmt = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shortFmt = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const uploadedFmt = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
const money = new Intl.NumberFormat("es", { style: "currency", currency: trip.currency || "EUR" });

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function toast(message, ms = 5000) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(err);
      toast(err.message || "Algo ha fallado");
    }
  };
}

// ---------- vista ----------

function countdown() {
  if (!trip.start) return "—";
  const diff = Math.round((utc(trip.start) - utc(todayIso())) / 864e5);
  if (diff > 1) return `Faltan ${diff} días`;
  if (diff === 1) return "Falta 1 día";
  if (!trip.end || todayIso() <= trip.end) return "¡De viaje!";
  return "Viaje terminado";
}

function allDays() {
  const days = new Set(state.activities.map((a) => a.day));
  if (trip.start && trip.end) {
    for (let t = utc(trip.start).getTime(); t <= utc(trip.end).getTime(); t += 864e5) {
      days.add(new Date(t).toISOString().slice(0, 10));
    }
  }
  return [...days].sort();
}

function byTime(a, b) {
  return (a.start_time || "99:99").localeCompare(b.start_time || "99:99") || a.created_at.localeCompare(b.created_at);
}

function renderHeader() {
  document.title = trip.name;
  $("#trip-name").textContent = trip.name;
  $("#destination").textContent = trip.destination;
  $("#trip-dates").textContent =
    trip.start && trip.end ? `${shortFmt.format(utc(trip.start))} – ${shortFmt.format(utc(trip.end))}` : "Fechas por definir";
  $("#session-btn").textContent = getName() || store.user?.email || "Entrar";
  for (const tab of document.querySelectorAll(".tabs [data-view]")) {
    if (tab.dataset.view === state.view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }

  const total = state.activities.reduce((sum, a) => sum + (a.cost || 0), 0);
  $("#stats").innerHTML = [
    ["Cuenta atrás", countdown()],
    ["Actividades", state.activities.length],
    ["Gasto anotado", money.format(total)],
  ]
    .map(([label, value]) => `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`)
    .join("");

  const banner = $("#banner");
  banner.hidden = store.mode !== "demo";
  banner.textContent =
    "Modo demo: lo que añadas se guarda solo en este navegador. Conecta Supabase en js/config.js para compartirlo (ver docs/DESPLIEGUE.md).";
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

// `text` y `buttonHtml` son HTML ya escapado.
function gate(title, text, buttonHtml = "") {
  return `<div class="gate"><h2>${esc(title)}</h2><p>${text}</p>${buttonHtml}</div>`;
}

const enterButton = `<button class="btn primary" data-action="profile">Entrar</button>`;

function card(a, comments) {
  const mapsUrl = a.place ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.place)}` : "";
  const meta = [
    a.place ? `<a href="${esc(mapsUrl)}" target="_blank" rel="noopener">📍 ${esc(a.place)}</a>` : "",
    a.cost != null ? esc(money.format(a.cost)) : "",
    a.created_by_name ? `por ${esc(a.created_by_name)}` : "",
  ].filter(Boolean);

  const commentItems = comments
    .map(
      (c) => `<li>
        <span class="who">${esc(c.created_by_name || "Alguien")}</span> ${esc(c.body)}
        ${c.created_by === store.user?.id ? `<button class="icon" title="Borrar comentario" data-action="del-comment" data-id="${esc(c.id)}">✕</button>` : ""}
      </li>`,
    )
    .join("");

  return `<article class="card">
    <div class="card-main">
      <div class="time">${esc(a.start_time ? a.start_time.slice(0, 5) : "—")}</div>
      <div class="body">
        <h3>${CATEGORIES[a.category] || CATEGORIES.otro} ${esc(a.title)}</h3>
        ${meta.length ? `<p class="meta">${meta.join(" · ")}</p>` : ""}
        ${a.notes ? `<p class="notes">${esc(a.notes)}</p>` : ""}
      </div>
      <div class="actions">
        <button class="icon" title="Editar" data-action="edit" data-id="${esc(a.id)}">✏️</button>
        <button class="icon" title="Borrar" data-action="delete" data-id="${esc(a.id)}">🗑️</button>
      </div>
    </div>
    <details data-id="${esc(a.id)}" ${state.open.has(a.id) ? "open" : ""}>
      <summary>💬 Comentarios (${comments.length})</summary>
      ${commentItems ? `<ul class="comments">${commentItems}</ul>` : ""}
      <form class="comment-form" data-activity="${esc(a.id)}">
        <input name="body" maxlength="1000" required placeholder="Escribe un comentario…" value="${esc(state.drafts[a.id] || "")}">
        <button class="btn small primary" type="submit">Enviar</button>
      </form>
    </details>
  </article>`;
}

function renderPhotos() {
  const grid = state.photos.length
    ? `<div class="photo-grid">${state.photos
        .map(
          (p) => `<button class="photo" data-action="open-photo" data-id="${esc(p.id)}">
            <img src="${esc(p.thumb_url)}" loading="lazy" alt="Foto de ${esc(p.created_by_name || "un viajero")}">
          </button>`,
        )
        .join("")}</div>`
    : `<p class="empty">Aún no hay fotos. ¡Sube la primera!</p>`;
  return `<section>
    <div class="day-head">
      <h2>Fotos (${state.photos.length})</h2>
      <button class="btn small primary" data-action="upload">📷 Subir fotos</button>
    </div>
    ${grid}
  </section>`;
}

function renderMain() {
  if (store.mode === "supabase" && !store.user) {
    return gate("Web privada", "Entra con tu correo para ver el viaje. Te enviaremos un enlace de acceso.", enterButton);
  }
  if (!state.member) {
    return gate(
      "Aún no tienes acceso",
      `Has entrado como <strong>${esc(store.user.email)}</strong>, pero ese correo no figura en la lista de viajeros. Pide a quien organiza el viaje que lo añada.`,
    );
  }

  if (state.view === "photos") return renderPhotos();

  const days = allDays();
  if (!days.length) {
    return gate(
      "Todavía no hay nada",
      "Añade la primera actividad del viaje.",
      `<button class="btn primary" data-action="add" data-day="${todayIso()}">+ Añadir actividad</button>`,
    );
  }

  const commentsByActivity = groupBy(state.comments, (c) => c.activity_id);
  const activitiesByDay = groupBy([...state.activities].sort(byTime), (a) => a.day);

  return days
    .map((day) => {
      const items = activitiesByDay.get(day) ?? [];
      return `<section class="day">
        <div class="day-head">
          <h2>${esc(capitalize(dayFmt.format(utc(day))))}</h2>
          <button class="btn small" data-action="add" data-day="${esc(day)}">+ Añadir</button>
        </div>
        ${items.length ? items.map((a) => card(a, commentsByActivity.get(a.id) ?? [])).join("") : `<p class="empty">Sin planes todavía.</p>`}
      </section>`;
    })
    .join("");
}

function render() {
  const main = $("#main");
  // Un refresco remoto no debe quitarle el foco a quien está escribiendo un comentario.
  const typing = document.activeElement?.closest?.(".comment-form");
  const typingId = typing?.dataset.activity;

  renderHeader();
  main.innerHTML = renderMain();

  if (typingId) {
    const input = main.querySelector(`.comment-form[data-activity="${CSS.escape(typingId)}"] input`);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
  if (lightbox.open) showPhoto(state.lightboxId);
}

async function refresh() {
  try {
    if (store.mode === "supabase" && !store.user) Object.assign(state, { activities: [], comments: [], photos: [], member: true });
    else Object.assign(state, await store.load());
  } catch (err) {
    console.error(err);
    toast(err.message || "No se pudieron cargar los datos");
  }
  render();
}

let refreshTimer;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
};

// ---------- diálogos ----------

const activityDialog = $("#activity-dialog");
const activityForm = $("#activity-form");
const profileDialog = $("#profile-dialog");
const profileForm = $("#profile-form");

$("#activity-form [name=category]").innerHTML = Object.entries(CATEGORY_LABELS)
  .map(([value, label]) => `<option value="${value}">${CATEGORIES[value]} ${label}</option>`)
  .join("");

for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => button.closest("dialog").close());
}

function openProfile() {
  const needsEmail = store.mode === "supabase" && !store.user;
  const signedIn = store.mode === "supabase" && store.user;
  profileForm.elements.name.value = getName();
  profileForm.email.required = needsEmail;
  $("#email-field").hidden = !needsEmail;
  $("#signout-btn").hidden = !signedIn;
  $("#profile-title").textContent = needsEmail ? "Entrar" : "Tu perfil";
  $("#profile-hint").textContent = needsEmail
    ? "Te enviaremos un enlace al correo; ábrelo en este mismo dispositivo."
    : "Tu nombre aparece junto a lo que añades y comentas.";
  $("#profile-submit").textContent = needsEmail ? "Enviar enlace" : "Guardar";
  profileDialog.showModal();
}

function requireName() {
  if (getName()) return true;
  toast("Primero dinos tu nombre.");
  openProfile();
  return false;
}

function openActivity({ id, day } = {}) {
  if (!requireName()) return;
  const a = state.activities.find((x) => x.id === id);
  state.editingId = a?.id ?? null;
  $("#activity-title").textContent = a ? "Editar actividad" : "Nueva actividad";
  activityForm.reset();
  activityForm.day.value = a?.day ?? day ?? todayIso();
  activityForm.start_time.value = a?.start_time?.slice(0, 5) ?? "";
  activityForm.elements.title.value = a?.title ?? "";
  activityForm.category.value = a?.category ?? "otro";
  activityForm.cost.value = a?.cost ?? "";
  activityForm.place.value = a?.place ?? "";
  activityForm.notes.value = a?.notes ?? "";
  activityDialog.showModal();
}

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
      cost: f.get("cost") === "" ? null : Number(f.get("cost")),
      notes: f.get("notes").trim() || null,
    };
    if (state.editingId) activity.id = state.editingId;
    await store.saveActivity(activity);
    activityDialog.close();
    await refresh();
  }),
);

profileForm.addEventListener(
  "submit",
  guarded(async (event) => {
    event.preventDefault();
    const f = new FormData(profileForm);
    setName(f.get("name").trim());
    if (store.mode === "supabase" && !store.user) {
      await store.signIn(f.get("email").trim());
      toast("Listo: revisa tu correo y abre el enlace de acceso.");
    }
    profileDialog.close();
    render();
  }),
);

$("#signout-btn").addEventListener(
  "click",
  guarded(async () => {
    await store.signOut();
    profileDialog.close();
  }),
);

$("#session-btn").addEventListener("click", openProfile);

// ---------- eventos de la lista ----------

const main = $("#main");

main.addEventListener(
  "click",
  guarded(async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id, day } = button.dataset;

    if (action === "profile") openProfile();
    else if (action === "upload") {
      if (requireName()) $("#photo-input").click();
    } else if (action === "open-photo") showPhoto(id);
    else if (action === "add") openActivity({ day });
    else if (action === "edit") openActivity({ id });
    else if (action === "delete") {
      const a = state.activities.find((x) => x.id === id);
      if (confirm(`¿Borrar «${a?.title}»? También se borrarán sus comentarios.`)) {
        await store.deleteActivity(id);
        await refresh();
      }
    } else if (action === "del-comment") {
      await store.deleteComment(id);
      await refresh();
    }
  }),
);

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
    await store.addComment(id, body);
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

// ---------- fotos y pestañas ----------

for (const tab of document.querySelectorAll(".tabs [data-view]")) {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    history.replaceState(null, "", state.view === "photos" ? "#fotos" : location.pathname + location.search);
    render();
  });
}

$("#photo-input").addEventListener(
  "change",
  guarded(async (event) => {
    const input = event.target;
    const files = [...input.files];
    input.value = "";
    const failed = [];
    for (const [i, file] of files.entries()) {
      toast(`Subiendo foto ${i + 1} de ${files.length}…`, 60000);
      try {
        await store.addPhoto(await prepareImage(file));
        await refresh();
      } catch (err) {
        console.error(err);
        failed.push(err.message || file.name);
      }
    }
    if (failed.length) toast(`${failed.length} de ${files.length} sin subir: ${failed[0]}`, 8000);
    else toast(files.length === 1 ? "Foto subida" : `${files.length} fotos subidas`);
  }),
);

const lightbox = $("#lightbox");

function showPhoto(id) {
  const i = state.photos.findIndex((p) => p.id === id);
  if (i < 0) {
    if (lightbox.open) lightbox.close();
    return;
  }
  const photo = state.photos[i];
  state.lightboxId = id;
  const img = $("#lightbox-img");
  if (img.getAttribute("src") !== photo.full_url) img.src = photo.full_url;
  img.alt = `Foto de ${photo.created_by_name || "un viajero"}`;
  $("#lightbox-caption").textContent = `${photo.created_by_name || "Alguien"} · ${uploadedFmt.format(new Date(photo.created_at))}`;
  $("#lb-open").href = photo.full_url;
  $("#lb-delete").hidden = photo.created_by !== store.user?.id;
  // Las fotos van de la más nueva a la más antigua: "anterior" es la de la izquierda en la cuadrícula.
  $("#lb-prev").disabled = i === 0;
  $("#lb-next").disabled = i === state.photos.length - 1;
  if (!lightbox.open) lightbox.showModal();
}

function stepPhoto(delta) {
  const i = state.photos.findIndex((p) => p.id === state.lightboxId);
  const next = state.photos[i + delta];
  if (next) showPhoto(next.id);
}

$("#lb-prev").addEventListener("click", () => stepPhoto(-1));
$("#lb-next").addEventListener("click", () => stepPhoto(1));
lightbox.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") stepPhoto(-1);
  else if (event.key === "ArrowRight") stepPhoto(1);
});
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox) lightbox.close();
});
$("#lb-delete").addEventListener(
  "click",
  guarded(async () => {
    const photo = state.photos.find((p) => p.id === state.lightboxId);
    if (!photo || !confirm("¿Borrar esta foto? No se puede deshacer.")) return;
    await store.deletePhoto(photo);
    lightbox.close();
    await refresh();
  }),
);

// Al volver a la pestaña del navegador se recargan los datos (por si se perdió algún aviso en tiempo real
// y para renovar los enlaces temporales de las fotos).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && store) scheduleRefresh();
});

// ---------- arranque ----------

try {
  store = await createStore(scheduleRefresh);
  await refresh();
} catch (err) {
  console.error(err);
  $("#session-btn").hidden = true;
  $("#main").innerHTML = gate("No se pudo arrancar", esc(err.message || String(err)));
}
