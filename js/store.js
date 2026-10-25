// Capa de datos. Dos implementaciones con la misma interfaz:
//   - local:    localStorage, para probar sin servidor (modo demo)
//   - supabase: base de datos compartida con login por enlace al correo
import { config } from "./config.js";

const SUPABASE_ESM = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
const NAME_KEY = "viaje.nombre";

export const getName = () => {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
};
export const setName = (name) => {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* sin almacenamiento: se pedirá de nuevo */ }
};

export async function createStore(onChange) {
  const { url, anonKey } = config.supabase;
  return url && anonKey ? supabaseStore(onChange) : localStore(onChange);
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

function localStore(onChange) {
  const ACT = "viaje.actividades";
  const COM = "viaje.comentarios";
  const PHO = "viaje.fotos";
  const read = (key) => {
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      throw new Error("El navegador se ha quedado sin espacio para el modo demo. Con Supabase no existe este límite.");
    }
    onChange();
  };
  const now = () => new Date().toISOString();

  return {
    mode: "demo",
    user: { id: "local", email: null },
    async signIn() {},
    async signOut() {},
    async load() {
      const photos = read(PHO).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { activities: read(ACT), comments: read(COM), photos, member: true };
    },
    async addPhoto({ full, thumb, lat = null, lng = null, taken_at = null }) {
      const photo = {
        id: crypto.randomUUID(),
        full_url: await blobToDataUrl(full),
        thumb_url: await blobToDataUrl(thumb),
        lat,
        lng,
        taken_at,
        created_by: "local",
        created_by_name: getName(),
        created_at: now(),
      };
      write(PHO, [...read(PHO), photo]);
    },
    async updatePhoto(id, { lat, lng }) {
      write(PHO, read(PHO).map((p) => (p.id === id ? { ...p, lat, lng } : p)));
    },
    async deletePhoto(photo) {
      write(PHO, read(PHO).filter((p) => p.id !== photo.id));
    },
    async saveActivity(a) {
      const list = read(ACT);
      const i = list.findIndex((x) => x.id === a.id);
      if (i >= 0) list[i] = { ...list[i], ...a, updated_at: now() };
      else list.push({ ...a, id: crypto.randomUUID(), created_by: "local", created_by_name: getName(), created_at: now() });
      write(ACT, list);
    },
    async deleteActivity(id) {
      write(COM, read(COM).filter((c) => c.activity_id !== id));
      write(ACT, read(ACT).filter((a) => a.id !== id));
    },
    async addComment(activity_id, body) {
      const list = read(COM);
      list.push({ id: crypto.randomUUID(), activity_id, body, created_by: "local", created_by_name: getName(), created_at: now() });
      write(COM, list);
    },
    async deleteComment(id) {
      write(COM, read(COM).filter((c) => c.id !== id));
    },
  };
}

async function supabaseStore(onChange) {
  const { createClient } = await import(SUPABASE_ESM);
  const sb = createClient(config.supabase.url, config.supabase.anonKey);
  const bucket = sb.storage.from("photos");
  const check = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  // El bucket es privado: las imágenes se muestran con enlaces firmados temporales.
  // Se reutilizan mientras sigan vigentes para que el navegador no vuelva a descargar las fotos en cada refresco.
  const SIGN_SECONDS = 6 * 3600;
  const signed = new Map(); // ruta -> { url, expires }
  async function signUrls(paths) {
    const now = Date.now();
    const missing = paths.filter((p) => !(signed.get(p)?.expires > now));
    if (missing.length) {
      const results = check(await bucket.createSignedUrls(missing, SIGN_SECONDS));
      const expires = now + (SIGN_SECONDS - 3600) * 1000;
      for (const { path, signedUrl } of results) if (signedUrl) signed.set(path, { url: signedUrl, expires });
    }
    return (path) => signed.get(path)?.url ?? "";
  }

  const store = {
    mode: "supabase",
    user: null,
    async signIn(email) {
      const emailRedirectTo = location.origin + location.pathname;
      check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo } }));
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async load() {
      const member = check(await sb.rpc("is_member"));
      if (!member) return { activities: [], comments: [], photos: [], member: false };
      const [activities, comments, rows] = await Promise.all([
        sb.from("activities").select("*").then(check),
        sb.from("comments").select("*").order("created_at").then(check),
        sb.from("photos").select("*").order("created_at", { ascending: false }).then(check),
      ]);
      const urlOf = await signUrls(rows.flatMap((p) => [p.path, p.thumb_path]));
      const photos = rows.map((p) => ({ ...p, full_url: urlOf(p.path), thumb_url: urlOf(p.thumb_path) }));
      return { activities, comments, photos, member: true };
    },
    async addPhoto({ full, thumb, lat = null, lng = null, taken_at = null }) {
      const id = crypto.randomUUID();
      // La carpeta es el id del usuario: las políticas de Storage solo dejan subir y borrar en la propia.
      const path = `${store.user.id}/${id}.jpg`;
      const thumb_path = `${store.user.id}/${id}_t.jpg`;
      const contentType = "image/jpeg";
      check(await bucket.upload(path, full, { contentType }));
      check(await bucket.upload(thumb_path, thumb, { contentType }));
      const row = { id, path, thumb_path, lat, lng, taken_at, created_by_name: getName() };
      const { error } = await sb.from("photos").insert(row);
      if (error) {
        await bucket.remove([path, thumb_path]);
        throw error;
      }
    },
    async updatePhoto(id, { lat, lng }) {
      const rows = check(await sb.from("photos").update({ lat, lng }).eq("id", id).select("id"));
      // Con RLS, un UPDATE sin permiso no da error: simplemente no toca ninguna fila.
      if (!rows.length) throw new Error("Solo quien subió la foto puede cambiar su ubicación.");
    },
    async deletePhoto(photo) {
      // Primero los archivos: si algo falla, la fila sigue ahí y se puede reintentar el borrado.
      check(await bucket.remove([photo.path, photo.thumb_path]));
      check(await sb.from("photos").delete().eq("id", photo.id));
    },
    async saveActivity({ id, ...fields }) {
      if (id) check(await sb.from("activities").update(fields).eq("id", id));
      else check(await sb.from("activities").insert({ ...fields, created_by_name: getName() }));
    },
    async deleteActivity(id) {
      check(await sb.from("activities").delete().eq("id", id));
    },
    async addComment(activity_id, body) {
      check(await sb.from("comments").insert({ activity_id, body, created_by_name: getName() }));
    },
    async deleteComment(id) {
      check(await sb.from("comments").delete().eq("id", id));
    },
  };

  store.user = (await sb.auth.getSession()).data.session?.user ?? null;
  sb.auth.onAuthStateChange((_event, session) => {
    store.user = session?.user ?? null;
    onChange();
  });
  sb.channel("viaje")
    .on("postgres_changes", { event: "*", schema: "public", table: "activities" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, onChange)
    .subscribe();

  return store;
}
