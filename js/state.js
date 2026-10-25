// Estado compartido entre módulos. `ctx` guarda las piezas que se crean al arrancar (store, mapa)
// y las acciones de app.js que otros módulos necesitan llamar sin importar app.js (evita ciclos).
export const VIEWS = ["map", "plan", "photos", "games", "album"];
const HASHES = { "#mapa": "map", "#plan": "plan", "#fotos": "photos", "#juegos": "games", "#album": "album", "#comida": "plan", "#cuentas": "plan", "#gastos": "plan", "#maleta": "plan" };
// El Itinerario tiene cuatro secciones: los días, dónde comimos, las cuentas (gastos y compras) y la lista de la maleta.
export const PLAN_TABS = ["days", "food", "expenses", "packing"];
const PLAN_HASHES = { "#comida": "food", "#cuentas": "expenses", "#gastos": "expenses", "#maleta": "packing" };
export const hashOf = (view, planTab = "days") => {
  if (view === "plan") return { food: "#comida", expenses: "#cuentas", packing: "#maleta" }[planTab] ?? "#plan";
  return Object.keys(HASHES).find((h) => HASHES[h] === view && !PLAN_HASHES[h]);
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
  audios: [], // notas de voz (adjuntos.sql)
  attach: false, // false si en Supabase falta ejecutar adjuntos.sql (fotos y audios en comentarios y actividades)
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
  facts: {}, // día -> curiosidad de la zona (Wikipedia) para las ideas
  ideaShift: 0, // «Otro reto»
  ideaPage: 0, // «Más ideas»
  live: [], // posiciones compartidas por los viajeros
  presence: [], // quién está en línea y cuándo se vio por última vez (presencia.sql)
  presenceOn: false, // false si en Supabase falta ejecutar presencia.sql
  sharing: false, // estoy compartiendo mi ubicación
  me: null, // mi última posición conocida { lat, lng }
  cuentas: "todo", // filtro de Cuentas: todo | gasto | compra
  filter: { q: "", cat: "" }, // búsqueda y filtro del itinerario
  selectedStop: null,
  selectedPhoto: null, // foto resaltada en el mapa
  playing: false,
  game: null, // juego abierto en la pestaña Juegos (null = la lista de juegos)
  games: {}, // resumen de cada juego para el álbum (lo rellena cada juego al cargar)
  loginStep: null, // null (pedir correo) o "code" (esperando el enlace o el código del correo)
  loginEmail: "",
  pendingShared: null, // texto de un lugar compartido que espera a que la persona ponga su nombre

  lightboxId: null,
  open: new Set(), // actividades con los comentarios desplegados
  drafts: {}, // comentario a medio escribir, por actividad
  editingId: null,
};

export const ctx = { store: null, map: null, actions: {} };
