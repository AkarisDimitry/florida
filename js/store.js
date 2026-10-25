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

// onChange: cambió algo importante (se recarga todo). onPeople: solo cambió quién está en línea o dónde está (recarga ligera).
export async function createStore(onChange, onPeople = onChange) {
  const { url, anonKey } = config.supabase;
  return url && anonKey ? supabaseStore(onChange, onPeople) : localStore(onChange);
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
  const EXP = "viaje.gastos";
  const PCK = "viaje.maleta";
  const AUD = "viaje.audios";
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
    async verifyCode() {},
    async signOut() {},
    async shareLocation() {},
    async stopSharing() {},
    async heartbeat() {},
    async stopHeartbeat() {},
    async loadPeople() {
      return { live: [], presence: [], presenceOn: false };
    },
    async load() {
      const photos = read(PHO).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { activities: read(ACT), comments: read(COM), photos, live: [], presence: [], presenceOn: false, expenses: read(EXP), checklist: read(PCK), audios: read(AUD), attach: true, extras: true, isAdmin: false, requests: [], myRequest: null, access: false, member: true };
    },
    async addPhoto({ full, thumb, lat = null, lng = null, taken_at = null, activity_id = null, expense_id = null }) {
      const photo = {
        id: crypto.randomUUID(),
        full_url: await blobToDataUrl(full),
        thumb_url: await blobToDataUrl(thumb),
        lat,
        lng,
        taken_at,
        activity_id,
        expense_id,
        created_by: "local",
        created_by_name: getName(),
        created_at: now(),
      };
      write(PHO, [...read(PHO), photo]);
      return photo.id;
    },
    async addAudio({ blob, seconds, activity_id = null }) {
      const audio = { id: crypto.randomUUID(), audio_url: await blobToDataUrl(blob), seconds, activity_id, created_by: "local", created_by_name: getName(), created_at: now() };
      write(AUD, [...read(AUD), audio]);
      return audio.id;
    },
    // Igual que la base de datos: el comentario que se queda vacío sin su audio se va (con sus respuestas).
    async deleteAudio(audio) {
      const comments = read(COM);
      const gone = new Set(comments.filter((c) => c.attached_audio === audio.id && !c.body && !c.attached_photo).map((c) => c.id));
      for (const c of comments) if (c.reply_to && gone.has(c.reply_to)) gone.add(c.id);
      write(COM, comments.filter((c) => !gone.has(c.id)).map((c) => (c.attached_audio === audio.id ? { ...c, attached_audio: null } : c)));
      write(AUD, read(AUD).filter((a) => a.id !== audio.id));
    },
    async updatePhoto(id, fields) {
      write(PHO, read(PHO).map((p) => (p.id === id ? { ...p, ...fields } : p)));
    },
    async saveExpense(e) {
      const list = read(EXP);
      const i = list.findIndex((x) => x.id === e.id);
      if (i >= 0) {
        list[i] = { ...list[i], ...e, updated_at: now() };
        write(EXP, list);
        return e.id;
      }
      const id = crypto.randomUUID();
      list.push({ ...e, id, created_by: "local", created_by_name: getName(), created_at: now() });
      write(EXP, list);
      return id;
    },
    async deleteExpense(id) {
      write(EXP, read(EXP).filter((x) => x.id !== id));
    },
    async saveChecklistItem(item) {
      const list = read(PCK);
      const i = list.findIndex((x) => x.id === item.id);
      if (i >= 0) list[i] = { ...list[i], ...item };
      else list.push({ done: false, assigned_to: null, done_by_name: null, ...item, id: crypto.randomUUID(), created_by: "local", created_by_name: getName(), created_at: now() });
      write(PCK, list);
    },
    async deleteChecklistItem(id) {
      write(PCK, read(PCK).filter((x) => x.id !== id));
    },
    // Igual que la base de datos: se van los comentarios de la foto y los que se quedan vacíos al quitarla (con sus respuestas).
    async deletePhoto(photo) {
      const comments = read(COM);
      const gone = new Set(comments.filter((c) => c.on_photo === photo.id || (c.attached_photo === photo.id && !c.body && !c.attached_audio)).map((c) => c.id));
      for (const c of comments) if (c.reply_to && gone.has(c.reply_to)) gone.add(c.id);
      write(COM, comments.filter((c) => !gone.has(c.id)).map((c) => (c.attached_photo === photo.id ? { ...c, attached_photo: null } : c)));
      write(PHO, read(PHO).filter((p) => p.id !== photo.id));
    },
    // Devuelve el id de la actividad (nuevo o existente) para poder adjuntarle fotos y audios.
    async saveActivity(a) {
      const list = read(ACT);
      const i = list.findIndex((x) => x.id === a.id);
      if (i >= 0) {
        list[i] = { ...list[i], ...a, updated_at: now() };
        write(ACT, list);
        return a.id;
      }
      const id = crypto.randomUUID();
      list.push({ ...a, id, created_by: "local", created_by_name: getName(), created_at: now() });
      write(ACT, list);
      return id;
    },
    async deleteActivity(id) {
      write(COM, read(COM).filter((c) => c.activity_id !== id));
      write(EXP, read(EXP).map((e) => (e.activity_id === id ? { ...e, activity_id: null } : e)));
      write(PHO, read(PHO).map((p) => (p.activity_id === id ? { ...p, activity_id: null } : p)));
      write(AUD, read(AUD).filter((a) => a.activity_id !== id));
      write(ACT, read(ACT).filter((a) => a.id !== id));
    },
    // Un comentario cuelga de una actividad (`activity_id`) o de una foto (`on_photo`), puede responder a otro (`reply_to`)
    // y llevar una foto o una nota de voz adjuntas.
    async addComment({ activity_id = null, on_photo = null, body = "", reply_to = null, attached_photo = null, attached_audio = null }) {
      const list = read(COM);
      list.push({ id: crypto.randomUUID(), activity_id, on_photo, body, reply_to, attached_photo, attached_audio, created_by: "local", created_by_name: getName(), created_at: now() });
      write(COM, list);
    },
    // Borra el comentario y sus respuestas; sus fotos y audios los quita quien llama (`removeAttachments`, en comments.js).
    async deleteComment(comment) {
      const gone = new Set([comment.id, ...read(COM).filter((c) => c.reply_to === comment.id).map((c) => c.id)]);
      write(COM, read(COM).filter((c) => !gone.has(c.id)));
    },
  };
}

async function supabaseStore(onChange, onPeople) {
  const { createClient } = await import(SUPABASE_ESM);
  // La sesión se guarda en este dispositivo y se renueva sola: se entra una vez y no hace falta volver a pedir nada.
  const sb = createClient(config.supabase.url, config.supabase.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const bucket = sb.storage.from("photos");
  const audioBucket = sb.storage.from("audio");
  const check = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  // El bucket es privado: las imágenes se muestran con enlaces firmados temporales.
  // Se reutilizan mientras sigan vigentes para que el navegador no vuelva a descargar las fotos en cada refresco.
  const SIGN_SECONDS = 6 * 3600;
  const signed = { photos: new Map(), audio: new Map() }; // almacén -> (ruta -> { url, expires })
  async function signUrls(paths, name = "photos") {
    const cache = signed[name];
    const now = Date.now();
    const missing = paths.filter((p) => p && !(cache.get(p)?.expires > now));
    if (missing.length) {
      const results = check(await (name === "audio" ? audioBucket : bucket).createSignedUrls(missing, SIGN_SECONDS));
      const expires = now + (SIGN_SECONDS - 3600) * 1000;
      for (const { path, signedUrl } of results) if (signedUrl) cache.set(path, { url: signedUrl, expires });
    }
    return (path) => cache.get(path)?.url ?? "";
  }

  // Cada tabla opcional tiene su propio canal y solo se escucha si existe: una suscripción a una tabla que falta
  // podría hacer fallar todo el canal, y las actividades, comentarios y fotos no deben depender de ellas.
  const available = { live: false, extras: false, access: false, audios: false };
  const lastOptional = { live_locations: [], presence: [], expenses: [], checklist_items: [], access_requests: [], audios: [] };
  const subscribed = new Set();
  function subscribeOptional() {
    for (const [group, tables] of [["live", ["live_locations"]], ["extras", ["expenses", "checklist_items"]], ["access", ["access_requests"]], ["audios", ["audios"]]]) {
      if (!available[group] || subscribed.has(group)) continue;
      subscribed.add(group);
      let channel = sb.channel(`viaje-${group}`);
      // Las posiciones en vivo llegan cada pocos segundos: solo se refresca la lista de personas, no todos los datos.
      for (const table of tables) channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, group === "live" ? onPeople : onChange);
      channel.subscribe();
    }
  }

    // Las tablas opcionales (vivo.sql, extras.sql y acceso.sql): si faltan, la web sigue funcionando sin esa función. Solo cuenta
    // como "falta" el error de tabla inexistente; un fallo pasajero (red, 500…) conserva lo último que se cargó.
    const optional = (table, order) => {
      const query = sb.from(table).select("*");
      return (order ? query.order(order) : query).then(
        ({ data, error }) => {
          if (!error) {
            lastOptional[table] = data;
            return { data, missing: false, failed: false };
          }
          const missing = ["42P01", "PGRST205"].includes(error.code) || /does not exist|schema cache|could not find the table/i.test(error.message || "");
          return { data: missing ? [] : lastOptional[table], missing, failed: !missing };
        },
        () => ({ data: lastOptional[table], missing: false, failed: true }),
      );
    };

  const store = {
    mode: "supabase",
    sb, // el cliente de Supabase, para los juegos (js/juegos/)
    user: null,
    async signIn(email) {
      const emailRedirectTo = location.origin + location.pathname;
      check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo } }));
    },
    // Alternativa al enlace: el código de 6 cifras del mismo correo se escribe dentro de la app. Sirve cuando el enlace se
    // abre en otro navegador (p. ej. en iPhone la app instalada guarda sus datos aparte de Safari).
    async verifyCode(email, code) {
      const { error } = await sb.auth.verifyOtp({ email, token: String(code).replace(/\s+/g, ""), type: "email" });
      if (error) throw error;
      // Pide al navegador que no borre la sesión guardada cuando necesite espacio.
      navigator.storage?.persist?.().catch(() => {});
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async load() {
      const member = check(await sb.rpc("is_member"));
      const none = { activities: [], comments: [], photos: [], live: [], presence: [], presenceOn: false, audios: [], attach: false, expenses: [], checklist: [], extras: true, isAdmin: false, requests: [], myRequest: null };
      if (!member) {
        // Sin ser miembro solo se ve la propia solicitud de acceso (si acceso.sql está ejecutado).
        const mine = await optional("access_requests");
        available.access = !mine.missing && !mine.failed;
        subscribeOptional();
        return { ...none, member: false, access: !mine.missing, myRequest: mine.data?.[0] ?? null };
      }
      const [activities, comments, rows, live, presence, expenses, checklist, audioRows] = await Promise.all([
        sb.from("activities").select("*").then(check),
        sb.from("comments").select("*").order("created_at").then(check),
        sb.from("photos").select("*").order("created_at", { ascending: false }).then(check),
        optional("live_locations"),
        optional("presence"),
        optional("expenses", "created_at"),
        optional("checklist_items", "created_at"),
        optional("audios", "created_at"),
      ]);
      // Solo los administradores consultan (y escuchan) las solicitudes de acceso.
      const isAdmin = await sb.rpc("is_admin").then(({ data, error }) => !error && data === true, () => false);
      const asked = isAdmin ? await optional("access_requests", "created_at") : { data: [], missing: false, failed: false };
      available.access = isAdmin && !asked.missing && !asked.failed;
      available.live = !live.missing && !live.failed;
      available.extras = !expenses.missing && !expenses.failed && !checklist.missing && !checklist.failed;
      available.audios = !audioRows.missing && !audioRows.failed; // las notas de voz de una actividad llegan a los demás al instante
      subscribeOptional();
      const urlOf = await signUrls(rows.flatMap((p) => [p.path, p.thumb_path]));
      const photos = rows.map((p) => ({ ...p, full_url: urlOf(p.path), thumb_url: urlOf(p.thumb_path) }));
      const audioUrl = await signUrls((audioRows.data ?? []).map((a) => a.path), "audio").catch(() => () => "");
      const audios = (audioRows.data ?? []).map((a) => ({ ...a, audio_url: audioUrl(a.path) }));
      return { activities, comments, photos, live: live.data ?? [], presence: presence.data ?? [], presenceOn: !presence.missing, audios, attach: !audioRows.missing, expenses: expenses.data ?? [], checklist: checklist.data ?? [], extras: !expenses.missing && !checklist.missing, isAdmin, requests: asked.data ?? [], myRequest: null, access: isAdmin || !asked.missing, member: true };
    },
    async addPhoto({ full, thumb, lat = null, lng = null, taken_at = null, activity_id = null, expense_id = null }) {
      const id = crypto.randomUUID();
      // La carpeta es el id del usuario: las políticas de Storage solo dejan subir y borrar en la propia.
      const path = `${store.user.id}/${id}.jpg`;
      const thumb_path = `${store.user.id}/${id}_t.jpg`;
      const contentType = "image/jpeg";
      check(await bucket.upload(path, full, { contentType }));
      check(await bucket.upload(thumb_path, thumb, { contentType }));
      const row = { id, path, thumb_path, lat, lng, taken_at, created_by_name: getName(), ...(activity_id && { activity_id }), ...(expense_id && { expense_id }) };
      const { error } = await sb.from("photos").insert(row);
      if (error) {
        await bucket.remove([path, thumb_path]);
        throw error;
      }
      return id;
    },
    // Nota de voz: el archivo va al almacén privado `audio` (carpeta del usuario) y su fila a `audios`.
    async addAudio({ blob, seconds, mime = "audio/webm", activity_id = null }) {
      const id = crypto.randomUUID();
      const ext = /mp4|aac|m4a/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : /mpeg/.test(mime) ? "mp3" : /wav/.test(mime) ? "wav" : "webm";
      const path = `${store.user.id}/${id}.${ext}`;
      check(await audioBucket.upload(path, blob, { contentType: mime.split(";")[0] }));
      const { error } = await sb.from("audios").insert({ id, path, seconds, created_by_name: getName(), ...(activity_id && { activity_id }) });
      if (error) {
        await audioBucket.remove([path]);
        throw error;
      }
      return id;
    },
    async deleteAudio(audio) {
      check(await sb.from("audios").delete().eq("id", audio.id));
      await audioBucket.remove([audio.path]);
    },
    async updatePhoto(id, fields) {
      const rows = check(await sb.from("photos").update(fields).eq("id", id).select("id"));
      // Con RLS, un UPDATE sin permiso no da error: simplemente no toca ninguna fila.
      if (!rows.length) throw new Error("Solo quien subió la foto puede cambiarla.");
    },
    async saveExpense({ id, ...fields }) {
      if (id) {
        check(await sb.from("expenses").update(fields).eq("id", id));
        return id;
      }
      const created = crypto.randomUUID(); // id propio: un doble toque no puede crear dos gastos
      check(await sb.from("expenses").insert({ id: created, ...fields, created_by_name: getName() }));
      return created;
    },
    async deleteExpense(id) {
      check(await sb.from("expenses").delete().eq("id", id));
    },
    async saveChecklistItem({ id, ...fields }) {
      if (id) check(await sb.from("checklist_items").update(fields).eq("id", id));
      else check(await sb.from("checklist_items").insert({ ...fields, created_by_name: getName() }));
    },
    async deleteChecklistItem(id) {
      check(await sb.from("checklist_items").delete().eq("id", id));
    },
    // Acceso: las escribe la base de datos con funciones (solo los administradores aprueban, rechazan, añaden y quitan).
    async requestAccess(name) {
      return check(await sb.rpc("request_access", { p_name: name }));
    },
    async approveAccess(email) {
      check(await sb.rpc("approve_access", { p_email: email }));
    },
    async denyAccess(email) {
      check(await sb.rpc("deny_access", { p_email: email }));
    },
    async addMember(email) {
      check(await sb.rpc("add_member", { p_email: email }));
    },
    async removeMember(email) {
      check(await sb.rpc("remove_member", { p_email: email }));
    },
    async listMembers() {
      return check(await sb.rpc("list_members"));
    },
    // Quién está en línea: cada cliente envía un latido cada ~45 s (la hora la pone el servidor) y se consulta cada 30 s.
    async heartbeat(name) {
      check(await sb.from("presence").upsert({ user_id: store.user.id, name }, { onConflict: "user_id" }));
    },
    async stopHeartbeat() {
      check(await sb.from("presence").delete().eq("user_id", store.user.id));
    },
    async loadPeople() {
      const [live, presence] = await Promise.all([optional("live_locations"), optional("presence")]);
      return { live: live.data ?? [], presence: presence.data ?? [], presenceOn: !presence.missing };
    },
    async shareLocation({ lat, lng, accuracy }) {
      check(await sb.from("live_locations").upsert({ user_id: store.user.id, name: getName(), lat, lng, accuracy: accuracy ?? null }, { onConflict: "user_id" }));
    },
    async stopSharing() {
      check(await sb.from("live_locations").delete().eq("user_id", store.user.id));
    },
    async deletePhoto(photo) {
      // Primero los archivos: si algo falla, la fila sigue ahí y se puede reintentar el borrado.
      check(await bucket.remove([photo.path, photo.thumb_path]));
      check(await sb.from("photos").delete().eq("id", photo.id));
    },
    // Devuelve el id de la actividad (nuevo o existente) para poder adjuntarle fotos y audios. El id nuevo se genera aquí:
    // así un doble toque no puede crear dos actividades distintas.
    async saveActivity({ id, ...fields }) {
      if (id) {
        check(await sb.from("activities").update(fields).eq("id", id));
        return id;
      }
      const created = crypto.randomUUID();
      check(await sb.from("activities").insert({ id: created, ...fields, created_by_name: getName() }));
      return created;
    },
    async deleteActivity(id) {
      check(await sb.from("activities").delete().eq("id", id));
    },
    async addComment({ activity_id = null, on_photo = null, body = "", reply_to = null, attached_photo = null, attached_audio = null }) {
      check(
        await sb.from("comments").insert({
          body,
          created_by_name: getName(),
          ...(activity_id && { activity_id }),
          ...(on_photo && { on_photo }),
          ...(reply_to && { reply_to }),
          ...(attached_photo && { attached_photo }),
          ...(attached_audio && { attached_audio }),
        }),
      );
    },
    // Borra el comentario (la base de datos borra también sus respuestas); sus fotos y audios los quita quien llama
    // (`removeAttachments`, en comments.js), porque hacen falta sus rutas de archivo.
    async deleteComment(comment) {
      check(await sb.from("comments").delete().eq("id", comment.id));
    },
  };

  store.user = (await sb.auth.getSession()).data.session?.user ?? null;
  sb.auth.onAuthStateChange((event, session) => {
    store.user = session?.user ?? null;
    if (event === "SIGNED_IN" && session) navigator.storage?.persist?.().catch(() => {});
    onChange();
  });
  sb.channel("viaje")
    .on("postgres_changes", { event: "*", schema: "public", table: "activities" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, onChange)
    .subscribe();

  return store;
}
