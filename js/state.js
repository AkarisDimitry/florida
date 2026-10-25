// Estado compartido entre módulos. `ctx` guarda las piezas que se crean al arrancar (store, mapa)
// y las acciones de app.js que otros módulos necesitan llamar sin importar app.js (evita ciclos).
export const VIEWS = ["map", "plan", "photos", "food"];
const HASHES = { "#mapa": "map", "#plan": "plan", "#fotos": "photos", "#comida": "food" };
export const hashOf = (view) => Object.keys(HASHES).find((h) => HASHES[h] === view);
export const viewOfHash = (hash) => HASHES[hash];

const read = (key, fallback) => {
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
  member: true,
  offline: false,

  view: HASHES[location.hash] ?? "map",
  day: null, // día elegido en el mapa (AAAA-MM-DD); null = todo el viaje
  layers: { stops: true, routes: true, photos: true, ...read("viaje.capas", {}) },
  roadMode: read("viaje.rutaCarretera", true), // true = ruta por carretera, false = línea recta
  selectedStop: null,
  selectedPhoto: null, // foto resaltada en el mapa
  playing: false,

  lightboxId: null,
  open: new Set(), // actividades con los comentarios desplegados
  drafts: {}, // comentario a medio escribir, por actividad
  editingId: null,
};

export const ctx = { store: null, map: null, actions: {} };
