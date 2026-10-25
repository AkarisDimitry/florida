// «Ideas para hoy»: sugerencias y retos divertidos para el itinerario, calculados en el propio navegador a partir del tiempo,
// la hora, lo que ya hay apuntado y la zona (sin servidores de inteligencia artificial ni claves).
import { config } from "./config.js";
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { esc, todayIso, formatTemp } from "./util.js";
import { photoDay } from "./album.js";
import { locatedStops, allDays, tripPhotos } from "./trip.js";

const { trip } = config;

// Retos del viaje: el de cada día es el mismo para todos (se elige por la fecha); «Otro reto» baraja solo en tu móvil.
const CHALLENGES = [
  "Encuentra algo de color rosa y hazle una foto.",
  "Foto de grupo con todos haciendo la misma pose rara.",
  "Prueba un sabor de helado que nunca hayas probado.",
  "Pide el plato más raro de la carta y compartid un bocado.",
  "Haz una foto del atardecer… sin filtros.",
  "Aprende una palabra nueva del lugar y úsala hoy.",
  "Selfie con la cara que pone cada uno cuando tiene hambre.",
  "Encuentra tu letra inicial en un cartel y fotografíala.",
  "Cuenta cuántos perros ves durante un paseo y apunta el récord.",
  "Un abrazo de grupo con el monumento o el sitio más bonito de hoy.",
  "Foto de tus zapatos en el sitio más curioso que encuentres.",
  "Pide a un desconocido que os haga una foto… pero sin dar instrucciones.",
  "Encuentra algo que te recuerde a casa.",
  "Foto de una sombra divertida.",
  "Elige entre todos el «plato del día» y dadle una nota del 1 al 10.",
  "Buscad un espejo o un reflejo y haced una foto desde ahí.",
  "Foto de grupo saltando a la de tres.",
  "Encuentra tres cosas de colores distintos del arcoíris.",
  "Haz una foto del detalle más pequeño que veas (una hoja, un azulejo…).",
  "Dad una nota a tu café, zumo o refresco y compartidla en un comentario.",
  "Imita la estatua o el cartel que más os guste y fotografiadlo.",
  "Escribe un comentario con lo más gracioso que haya pasado hoy.",
  "Foto «antes y después»: el mismo sitio por la mañana y por la tarde.",
  "Encuentra algo que sea exactamente de tu color favorito.",
  "Probad una bebida o un snack de aquí que ninguno conozca.",
];

// Pequeño generador pseudoaleatorio con semilla (misma fecha ⇒ mismo reto para todos).
function hash(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

// El día sobre el que dar ideas: hoy si se está de viaje; el primer día antes del viaje; nada después.
function focusDay() {
  const today = todayIso();
  if (!trip.start) return null;
  if (today < trip.start) return trip.start;
  if (trip.end && today > trip.end) return null;
  return today;
}

const minutes = (hhmm) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : null);

export function ideasFor(day) {
  const during = day === todayIso();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const w = state.weather.get(day);
  const acts = state.activities.filter((a) => a.day === day);
  const first = locatedStops().find((s) => s.day === day);
  const where = first ? { lat: first.lat, lng: first.lng, label: first.title } : state.me ? { ...state.me, label: "tu ubicación" } : null;
  const ideas = [];
  const near = (kind, label) => ({ label, action: "ideas-discover", data: { kind, ...(where ? { lat: where.lat, lng: where.lng, place: where.label } : {}) } });
  const typical = w?.kind === "typical" ? "Suele hacer " : "Hoy hará ";

  // 1. Según el tiempo
  if (w?.tmax != null) {
    const rainy = (w.prob ?? 0) >= 50 || (w.rain ?? 0) >= 5 || [61, 63, 65, 80, 81, 82, 95, 96, 99].includes(w.code);
    if (rainy) ideas.push({ emoji: "☔", title: "Plan B para la lluvia", text: `${typical}${w.prob != null ? `${w.prob} % de probabilidad de lluvia` : "lluvia"}: buen día para un museo, un acuario o el cine.`, ...near("see", "Ver sitios cerca") });
    else if (w.tmax >= 29) ideas.push({ emoji: "🍦", title: "¡Qué calor!", text: `${typical}${formatTemp(w.tmax)}: helado, playa o piscina. Agua y protector solar a mano.`, ...near("outdoor", "Ver sitios al aire libre") });
    else if (w.tmax <= 12) ideas.push({ emoji: "☕", title: "Hace fresquito", text: `${typical}${formatTemp(w.tmax)}: abrigo, y un sitio con chocolate caliente.`, ...near("food", "Buscar dónde comer o beber") });
    else ideas.push({ emoji: "🌤️", title: "Buen tiempo para pasear", text: `${typical}${formatTemp(w.tmax)}: ideal para estar fuera, explorar a pie y hacer fotos.`, ...near("outdoor", "Ver sitios al aire libre") });
  }

  // 2. La hora dorada
  if (w?.sunset && (!during || nowMin < minutes(w.sunset))) {
    ideas.push({ emoji: "🌇", title: "La mejor luz del día", text: `El sol se pone a las ${w.sunset}${w.kind === "typical" ? " (aproximado)" : ""}. Llegad a un buen sitio media hora antes: es la hora de la foto bonita.`, ...near("outdoor", "Buscar un buen sitio") });
  }

  // 3. Comida
  if (during || day === trip.start) {
    const meals = acts.filter((a) => a.category === "comida").map((a) => minutes(a.start_time));
    const lunchPlanned = meals.some((m) => m == null || (m >= 12 * 60 && m <= 16 * 60));
    const dinnerPlanned = meals.some((m) => m == null || m >= 18 * 60);
    if (!lunchPlanned && (!during || nowMin < 16 * 60)) ideas.push({ emoji: "🍽️", title: "¿Ya sabéis dónde comer?", text: "No hay ninguna comida apuntada para hoy. Mirad qué hay cerca y añadidlo al plan.", ...near("food", "Buscar restaurantes cerca") });
    else if (!dinnerPlanned && (!during || nowMin < 21 * 60)) ideas.push({ emoji: "🌙", title: "¿Y la cena?", text: "Todavía no hay cena apuntada. Elegid entre todos y ponedle nota después.", ...near("food", "Buscar restaurantes cerca") });
  }

  // 4. Una curiosidad de la zona (se carga sola en segundo plano)
  const fact = state.facts[day];
  if (fact) ideas.push({ emoji: "🤓", title: `¿Sabías que…? ${fact.title}`, text: fact.extract, link: fact.url });

  // 5. Foto del día
  if (during && nowMin > 11 * 60 && !tripPhotos().some((p) => photoDay(p) === day)) {
    ideas.push({ emoji: "📸", title: "Todavía no hay fotos de hoy", text: "Haced una de grupo antes de que acabe el día: dentro de un año os alegraréis.", action: "camera", data: {}, label: "Hacer una foto" });
  }

  // 6. Antes del viaje
  if (!during) {
    if (!state.checklist.length) ideas.push({ emoji: "🧳", title: "Empezad la lista de la maleta", text: "Cada uno puede marcar lo que lleva y se ve en tiempo real. Hay una lista de «lo típico» para empezar.", action: "plan-tab", data: { tab: "packing" }, label: "Abrir la maleta" });
    if (!allDays().length || !state.activities.length) ideas.push({ emoji: "🗺️", title: "Apuntad el primer plan", text: "Un sitio, una comida o una reserva. Si lo marcáis en el mapa saldrá en la ruta.", action: "add", data: { day }, label: "Añadir un plan" });
  }

  // 7. El reto del día (siempre)
  const index = (hash(`${day}|${trip.name}`) + state.ideaShift) % CHALLENGES.length;
  const challenge = CHALLENGES[index];
  ideas.push({ emoji: "🎯", title: "Reto del día", text: challenge, action: "ideas-challenge", data: { text: challenge }, label: "Hacer la foto del reto", more: true });
  return ideas;
}

export function renderIdeas() {
  const day = focusDay();
  if (!day) return "";
  const all = ideasFor(day);
  const challenge = all.find((i) => i.more);
  const others = all.filter((i) => !i.more);
  // Hasta 2 ideas útiles (rotan con «Más ideas») y siempre el reto.
  const start = others.length ? state.ideaPage % others.length : 0;
  const picked = others.length > 2 ? [others[start], others[(start + 1) % others.length]] : others;
  const card = (i) => `<article class="idea">
      <span class="idea-emoji" aria-hidden="true">${i.emoji}</span>
      <div class="idea-body"><strong>${esc(i.title)}</strong><p>${esc(i.text)}</p>
        <div class="idea-actions">
          ${i.action ? `<button type="button" class="btn small ${i.more ? "primary" : ""}" data-action="${esc(i.action)}" ${Object.entries(i.data ?? {}).map(([k, v]) => `data-${esc(k)}="${esc(v)}"`).join(" ")}>${esc(i.label)}</button>` : ""}
          ${i.link ? `<a class="btn small" href="${esc(i.link)}" target="_blank" rel="noopener">Leer más</a>` : ""}
          ${i.more ? `<button type="button" class="btn small ghost" data-action="ideas-other-challenge">Otro reto</button>` : ""}
        </div></div></article>`;
  return `<section class="ideas" aria-label="Ideas para hoy"><header><h3>💡 ${day === todayIso() ? "Ideas para hoy" : "Ideas para el viaje"}</h3>${others.length > 2 ? `<button type="button" class="link-btn" data-action="ideas-more">Más ideas ${icon("chevronR", 14)}</button>` : ""}</header>${[...picked, challenge].filter(Boolean).map(card).join("")}</section>`;
}

export const ideasActions = {
  "ideas-more": () => {
    state.ideaPage++;
    ctx.actions.render();
  },
  "ideas-other-challenge": () => {
    state.ideaShift++;
    ctx.actions.render();
  },
  "ideas-discover": ({ kind, lat, lng, place }) => ctx.actions.openDiscover(Number.isFinite(Number(lat)) && lat ? { lat: Number(lat), lng: Number(lng), label: place } : null, kind),
  "ideas-challenge": ({ text }) => ctx.actions.cameraChallenge(text),
};
