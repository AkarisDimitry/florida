// Comentarios con hilos: se comenta una actividad o una foto, se responde a un comentario y cada mensaje puede llevar
// una foto (hecha con la cámara o de la galería) o una nota de voz. Devuelve HTML ya escapado; los eventos los gestiona
// `commentActions` (se unen a las acciones de app.js) y `submitComment`.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { esc, toast, ago, schemaHint } from "./util.js";
import { hueOf } from "./ledger.js";
import { prepareImage } from "./images.js";
import { pickFiles, canRecord, startRecording, cancelAllRecordings, clock } from "./media.js";
import { reactionBarHtml } from "./reacciones.js";
import { emojiPanelHtml, insertAtCursor, rememberEmoji } from "./emojis.js";

// Estado de cada caja de escribir (clave: "a:<id de actividad>" o "p:<id de foto>"): foto, audio, grabación y a quién responde.
const boxes = new Map();
const box = (key) => {
  if (!boxes.has(key)) boxes.set(key, { photo: null, audio: null, recording: null, starting: false, seconds: 0, reply: null, busy: false, emoji: false });
  return boxes.get(key);
};
const parseKey = (key) => ({ kind: key[0] === "p" ? "photo" : "activity", id: key.slice(2) });

const audioOf = (id) => state.audios.find((a) => a.id === id);
const photoOf = (id) => state.photos.find((p) => p.id === id);

function attachmentHtml(c) {
  const photo = c.attached_photo && photoOf(c.attached_photo);
  const audio = c.attached_audio && audioOf(c.attached_audio);
  return `${photo ? `<button type="button" class="cm-photo" data-action="open-photo" data-id="${esc(photo.id)}" aria-label="Ver la foto"><img src="${esc(photo.thumb_url)}" alt="" loading="lazy" decoding="async"></button>` : ""}
    ${audio ? `<div class="cm-audio"><span aria-hidden="true">🎤</span>${audio.audio_url ? `<audio controls preload="none" src="${esc(audio.audio_url)}"></audio>` : `<small>Cargando el audio…</small>`}<small>${esc(clock(audio.seconds))}</small></div>` : ""}`;
}

function commentHtml(c, key, replies = []) {
  const mine = c.created_by === ctx.store?.user?.id;
  const name = c.created_by_name || "Alguien";
  return `<li class="cm ${c.reply_to ? "is-reply" : ""}">
    <span class="person-dot sm" style="--h:${hueOf(name)}" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>
    <div class="cm-body">
      <p class="cm-text"><span class="who">${esc(name)}</span>${c.body ? ` ${esc(c.body)}` : ""}</p>
      ${attachmentHtml(c)}
      <div class="cm-meta"><small>${esc(ago(Date.parse(c.created_at) || Date.now()))}</small>
        ${!c.reply_to ? `<button type="button" class="link-btn" data-action="compose-reply" data-key="${esc(key)}" data-id="${esc(c.id)}">Responder</button>` : ""}
        ${mine ? `<button type="button" class="mini-x" title="Borrar" aria-label="Borrar el comentario" data-action="del-comment" data-id="${esc(c.id)}">✕</button>` : ""}</div>
      ${reactionBarHtml("comment", c.id)}
      ${replies.length ? `<ul class="cm-replies">${replies.map((r) => commentHtml(r, key)).join("")}</ul>` : ""}
    </div></li>`;
}

// Los comentarios de una actividad o de una foto, en hilos de un solo nivel (comentario + sus respuestas).
export function commentsOf(kind, id) {
  return state.comments.filter((c) => (kind === "photo" ? c.on_photo === id : c.activity_id === id));
}

export function threadHtml(kind, id) {
  const key = `${kind === "photo" ? "p" : "a"}:${id}`;
  const all = commentsOf(kind, id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const top = all.filter((c) => !c.reply_to);
  const repliesOf = (parent) => all.filter((c) => c.reply_to && c.reply_to === parent.id);
  return `${top.length ? `<ul class="comments cm-list">${top.map((c) => commentHtml(c, key, repliesOf(c))).join("")}</ul>` : ""}${composerHtml(key)}`;
}

function composerHtml(key) {
  const b = box(key);
  const attach = state.attach; // las fotos y audios en comentarios necesitan adjuntos.sql
  // Solo se responde a un comentario que existe y es de primer nivel; si lo borraron (en otro móvil, por ejemplo) se descarta.
  const parent = b.reply && state.comments.find((c) => c.id === b.reply && !c.reply_to);
  if (b.reply && !parent) b.reply = null;
  const draft = state.drafts[key] ?? "";
  const previews = [
    b.photo ? `<span class="pv"><img src="${esc(b.photo.url)}" alt="Foto adjunta"><button type="button" class="mini-x" data-action="compose-clear-photo" data-key="${esc(key)}" aria-label="Quitar la foto">✕</button></span>` : "",
    b.audio ? `<span class="pv pv-audio"><audio controls src="${esc(b.audio.url)}"></audio><small>${esc(clock(b.audio.seconds))}</small><button type="button" class="mini-x" data-action="compose-clear-audio" data-key="${esc(key)}" aria-label="Quitar el audio">✕</button></span>` : "",
  ].join("");
  if (b.recording) {
    return `<form class="comment-form compose is-recording" data-key="${esc(key)}"><div class="rec-bar"><span class="rec-dot" aria-hidden="true"></span><strong>Grabando <span data-rec="${esc(key)}">${esc(clock(b.seconds))}</span></strong>
      <button type="button" class="btn small primary" data-action="compose-stop" data-key="${esc(key)}">Parar</button>
      <button type="button" class="btn small ghost" data-action="compose-cancel-rec" data-key="${esc(key)}">Cancelar</button></div></form>`;
  }
  return `<form class="comment-form compose" data-key="${esc(key)}">
    ${parent ? `<p class="reply-note">Respondiendo a <b>${esc(parent.created_by_name || "alguien")}</b> <button type="button" class="link-btn" data-action="compose-cancel-reply" data-key="${esc(key)}">Cancelar</button></p>` : ""}
    <input name="body" maxlength="1000" placeholder="${parent ? "Escribe tu respuesta…" : "Escribe un comentario…"}" value="${esc(draft)}" ${attach ? "" : "required"} enterkeyhint="send" autocomplete="off">
    ${previews ? `<div class="compose-previews">${previews}</div>` : ""}
    ${b.emoji ? emojiPanelHtml(`data-action="compose-emoji-pick" data-key="${esc(key)}"`) : ""}
    <div class="compose-bar">
      <button type="button" class="tool" data-action="compose-emoji" data-key="${esc(key)}" aria-expanded="${b.emoji}" aria-label="Emojis"><span aria-hidden="true">😀</span></button>
      ${attach ? `<button type="button" class="tool" data-action="compose-camera" data-key="${esc(key)}">${icon("camera", 17)}<span>Foto</span></button>
      <button type="button" class="tool" data-action="compose-gallery" data-key="${esc(key)}">${icon("images", 17)}<span>Galería</span></button>
      ${canRecord() ? `<button type="button" class="tool" data-action="compose-mic" data-key="${esc(key)}"><span aria-hidden="true">🎤</span><span>Audio</span></button>` : ""}` : ""}
      <button class="btn small primary" type="submit" ${b.busy ? "disabled" : ""}>${b.busy ? "Enviando…" : "Enviar"}</button>
    </div></form>`;
}

// Un cambio hecho por la persona se ve al instante, aunque suene un audio (el repintado de fondo sí espera).
const rerender = () => ctx.actions.render({ user: true });

// Cancela las grabaciones en curso (al cambiar de pestaña, de foto o al cerrar un diálogo): así no queda el micrófono encendido.
export const cancelRecordings = cancelAllRecordings;

// Si una foto o un audio ya subidos se descartan antes de enviar el comentario, se borran también del viaje.
function discardUploaded(id, find, method) {
  const row = id && find(id);
  if (row) ctx.store[method](row).then(() => ctx.actions.refresh()).catch(() => {});
}

async function choosePhoto(key, camera) {
  const [file] = await pickFiles({ camera });
  if (!file) return;
  const b = box(key);
  if (b.photo) URL.revokeObjectURL(b.photo.url);
  b.photo = { file, url: URL.createObjectURL(file) };
  rerender();
}

export const commentActions = {
  "compose-camera": ({ key }) => choosePhoto(key, true),
  "compose-gallery": ({ key }) => choosePhoto(key, false),
  "compose-clear-photo": ({ key }) => {
    const b = box(key);
    if (b.photo) URL.revokeObjectURL(b.photo.url);
    discardUploaded(b.photo?.id, photoOf, "deletePhoto");
    b.photo = null;
    rerender();
  },
  "compose-clear-audio": ({ key }) => {
    const b = box(key);
    if (b.audio) URL.revokeObjectURL(b.audio.url);
    discardUploaded(b.audio?.id, audioOf, "deleteAudio");
    b.audio = null;
    rerender();
  },
  "compose-mic": async ({ key }) => {
    const b = box(key);
    if (b.recording || b.starting) return; // un segundo toque mientras llega el permiso no abre otra grabadora
    b.starting = true;
    try {
      b.seconds = 0;
      if (b.audio) {
        URL.revokeObjectURL(b.audio.url); // grabar de nuevo sustituye la nota anterior
        discardUploaded(b.audio.id, audioOf, "deleteAudio");
        b.audio = null;
      }
      b.recording = await startRecording({
        onTick: (s) => {
          b.seconds = s;
          for (const el of document.querySelectorAll(`[data-rec="${CSS.escape(key)}"]`)) el.textContent = clock(s);
        },
        onCancel: () => {
          b.recording = null;
          rerender();
        },
      });
    } finally {
      b.starting = false;
    }
    rerender();
  },
  "compose-stop": async ({ key }) => {
    const b = box(key);
    const recorded = await b.recording?.stop();
    b.recording = null;
    if (recorded) b.audio = { ...recorded, url: URL.createObjectURL(recorded.blob) };
    rerender();
  },
  "compose-cancel-rec": async ({ key }) => {
    const b = box(key);
    await b.recording?.cancel();
    b.recording = null;
    rerender();
  },
  "compose-emoji": ({ key }) => {
    const b = box(key);
    b.emoji = !b.emoji;
    rerender();
  },
  // Un emoji al texto que se está escribiendo (donde esté el cursor). No se repinta: así el texto, el cursor y el teclado se quedan como están.
  "compose-emoji-pick": ({ key, emojiPick }) => {
    const input = document.querySelector(`.comment-form[data-key="${CSS.escape(key)}"] input[name=body], .lb-thread .comment-form[data-key="${CSS.escape(key)}"] input[name=body]`);
    if (!input || !emojiPick) return;
    state.drafts[key] = insertAtCursor(input, emojiPick);
    rememberEmoji(emojiPick);
    input.focus();
  },
  "compose-reply": ({ key, id }) => {
    box(key).reply = id;
    rerender();
    document.querySelector(`.comment-form[data-key="${CSS.escape(key)}"] input[name=body]`)?.focus();
  },
  "compose-cancel-reply": ({ key }) => {
    box(key).reply = null;
    rerender();
  },
};

// Envía el comentario (con su foto o audio, si los lleva). Devuelve true si el formulario era de comentarios.
export async function submitComment(form) {
  const key = form.dataset.key;
  if (!key) return false;
  const b = box(key);
  if (b.busy) return true;
  const { kind, id } = parseKey(key);
  const body = (form.elements.body?.value ?? "").trim();
  if (!body && !b.photo && !b.audio) {
    toast("Escribe algo o añade una foto o un audio.");
    return true;
  }
  b.busy = true;
  rerender();
  try {
    // Lo ya subido en un intento anterior que falló se reutiliza (si no, cada reintento dejaría otra foto suelta).
    let partial = false;
    try {
      if (b.photo && !b.photo.id) {
        const prepared = await prepareImage(b.photo.file);
        b.photo.id = await ctx.store.addPhoto({ ...prepared, ...(kind === "activity" ? { activity_id: id } : {}) });
        partial = true;
      }
      if (b.audio && !b.audio.id) {
        b.audio.id = await ctx.store.addAudio({ blob: b.audio.blob, seconds: b.audio.seconds, mime: b.audio.mime, ...(kind === "activity" ? { activity_id: id } : {}) });
        partial = true;
      }
      // Si el comentario al que se respondía ya no existe, se envía como comentario nuevo.
      const reply_to = b.reply && state.comments.some((c) => c.id === b.reply && !c.reply_to) ? b.reply : null;
      await ctx.store.addComment({ ...(kind === "photo" ? { on_photo: id } : { activity_id: id }), body, reply_to, attached_photo: b.photo?.id ?? null, attached_audio: b.audio?.id ?? null });
    } catch (err) {
      if (partial) ctx.actions.refresh().catch(() => {}); // para que lo ya subido se pueda quitar desde la pantalla
      throw schemaHint(err);
    }
    if (b.photo) URL.revokeObjectURL(b.photo.url);
    if (b.audio) URL.revokeObjectURL(b.audio.url);
    Object.assign(b, { photo: null, audio: null, reply: null });
    delete state.drafts[key];
    if (form.elements.body) form.elements.body.value = ""; // si el repintado se aplaza (suena un audio), el texto no debe quedar para reenviarse
    state.open.add(kind === "activity" ? id : key);
    await ctx.actions.refresh();
  } finally {
    b.busy = false;
    rerender();
  }
  return true;
}

// Los comentarios y todas sus respuestas (la base de datos borra las respuestas junto con el comentario).
export function withReplies(list) {
  const ids = new Set(list.map((c) => c.id));
  return [...list, ...state.comments.filter((c) => c.reply_to && ids.has(c.reply_to) && !ids.has(c.id))];
}

// Fotos y audios adjuntos a esos comentarios (se crearon con ellos, así que se van con ellos).
export function attachmentsOf(list) {
  const photos = [];
  const audios = [];
  for (const c of list) {
    const photo = c.attached_photo && photoOf(c.attached_photo);
    const audio = c.attached_audio && audioOf(c.attached_audio);
    if (photo && !photos.includes(photo)) photos.push(photo);
    if (audio && !audios.includes(audio)) audios.push(audio);
  }
  return { photos, audios };
}

// Borra esas fotos y audios (archivo y fila). Si alguno falla no se detiene: lo importante, el comentario, ya se borró.
export async function removeAttachments({ photos = [], audios = [] }) {
  for (const audio of audios) await ctx.store.deleteAudio(audio).catch((err) => console.error(err));
  for (const photo of photos) await ctx.store.deletePhoto(photo).catch((err) => console.error(err));
}

// Al borrar un comentario se borran también sus respuestas (la base de datos lo hace, y puede haber respuestas de otras
// personas) y los adjuntos de todos ellos.
export async function deleteComment(id) {
  const comment = state.comments.find((c) => c.id === id);
  if (!comment) return;
  const doomed = withReplies([comment]);
  const replies = doomed.length - 1;
  if (!confirm(replies ? `¿Borrar este comentario? También se borrarán sus ${replies === 1 ? "respuesta" : `${replies} respuestas`}.` : "¿Borrar este comentario?")) return;
  const attachments = attachmentsOf(doomed);
  await ctx.store.deleteComment(comment);
  await removeAttachments(attachments);
  await ctx.actions.refresh();
}
