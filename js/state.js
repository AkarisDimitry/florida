// Estado compartido entre módulos. `ctx` guarda las piezas que se crean al arrancar (store, mapa)
// y las acciones de app.js que otros módulos necesitan llamar sin importar app.js (evita ciclos).
export const VIEWS = ["map", "plan", "photos", "food", "album"];
const HASHES = { "#mapa": "map", "#plan": "plan", "#fotos": "photos", "#comida": "food", "#album": "album", "#gastos": "plan", "#maleta": "plan" };
// El Itinerario tiene tres secciones: los días, el reparto de gastos y la lista de la maleta.
export const PLAN_TABS = ["days", "expenses", "packing"];
const PLAN_HASHES = { "#gastos": "expenses", "#maleta": "packing" };
export const hashOf = (view, planTab = "days") => {
  if (view === "plan") return planTab === "expenses" ? "#gastos" : planTab === "packing" ? "#maleta" : "#plan";
  return Object.keys(HASHES).find((h) => HASHES[h] === view);
};
export const viewOfHash = (hash) => HASHES[hash];
export const planTabOfHash = (hash) => PLAN_HASHES[hash] ?? "days";

export const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
export const persist = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sin almacenamiento: la preferencia no se recuerda */
  }
};

export const state = {
  activities: [],
  comments: [],
  photos: [],
  expenses: [], // gastos repartidos entre viajeros (extras.sql)
  checklist: [], // lista de la maleta (extras.sql)
  extras: true, // false si en Supabase falta ejecutar extras.sql
  member: true,
  isAdmin: false, // administrador: aprueba solicitudes de acceso (acceso.sql)
  requests: [], // solicitudes de acceso (solo las ve un administrador)
  myRequest: null, // mi solicitud de acceso, si aún no soy miembro
  access: false, // false si en Supabase falta ejecutar acceso.sql
  offline: false,

  view: HASHES[location.hash] ?? "map",
  planTab: PLAN_HASHES[location.hash] ?? "days", // sección del Itinerario
  day: null, // día elegido en el mapa (AAAA-MM-DD); null = todo el viaje
  layers: { stops: true, routes: true, photos: true, friends: true, ...read("viaje.capas", {}) },
  roadMode: read("viaje.rutaCarretera", true), // true = ruta por carretera, false = línea recta
  weather: new Map(), // día -> tiempo (weather.js)
  places: {}, // día -> ciudad
  live: [], // posiciones compartidas por los viajeros
  sharing: false, // estoy compartiendo mi ubicación
  me: null, // mi última posición conocida { lat, lng }
  filter: { q: "", cat: "" }, // búsqueda y filtro del itinerario
  selectedStop: null,
  selectedPhoto: null, // foto resaltada en el mapa
  playing: false,
  pendingShared: null, // texto de un lugar compartido que espera a que la persona ponga su nombre

  lightboxId: null,
  open: new Set(), // actividades con los comentarios desplegados
  drafts: {}, // comentario a medio escribir, por actividad
  editingId: null,
};

export const ctx = { store: null, map: null, actions: {} };
