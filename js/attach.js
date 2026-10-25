// Fotos y notas de voz de una actividad, dentro del formulario de «Nueva actividad» / «Editar actividad».
// Lo que se elige se guarda en un borrador y se sube al pulsar «Guardar» (cuando ya existe el id de la actividad).
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, esc, toast, schemaHint } from "./util.js";
import { prepareImage } from "./images.js";
import { pickFiles, canRecord, startRecording, clock } from "./media.js";

const draft = { photos: [], audio: null, recording: null, starting: false, seconds: 0 };
let editingId = null;

const revoke = () => {
  for (const p of draft.photos) URL.revokeObjectURL(p.url);
  if (draft.audio) URL.revokeObjectURL(draft.audio.url);
};

export function resetActivityDraft(activityId = null) {
  revoke();
  draft.recording?.cancel();
  Object.assign(draft, { photos: [], audio: null, recording: null, starting: false, seconds: 0 });
  editingId = activityId;
  renderActivityAttachments();
}

export const hasDraft = () => draft.photos.length > 0 || Boolean(draft.audio);

// Lo que ya tiene la actividad (al editar): sus fotos y audios, sin los que vinieron dentro de un comentario.
function existing() {
  if (!editingId) return { photos: [], audios: [] };
  const inComment = (key, id) => state.comments.some((c) => c[key] === id);
  return {
    photos: state.photos.filter((p) => p.activity_id === editingId && !inComment("attached_photo", p.id)),
    audios: state.audios.filter((a) => a.activity_id === editingId && !inComment("attached_audio", a.id)),
  };
}

export function renderActivityAttachments() {
  const box = $("#act-attach");
  box.hidden = !state.attach; // sin adjuntos.sql no se ofrece
  if (!state.attach) return;
  const mine = ctx.store?.user?.id;
  const { photos, audios } = existing();
  const have = [
    ...photos.map((p) => `<span class="pv"><img src="${esc(p.thumb_url)}" alt="">${p.created_by === mine ? `<button type="button" class="mini-x" data-att="del-photo" data-id="${esc(p.id)}" aria-label="Borrar la foto">✕</button>` : ""}</span>`),
    ...audios.map((a) => `<span class="pv pv-audio">${a.audio_url ? `<audio controls preload="none" src="${esc(a.audio_url)}"></audio>` : ""}<small>${esc(clock(a.seconds))}</small>${a.created_by === mine ? `<button type="button" class="mini-x" data-att="del-audio" data-id="${esc(a.id)}" aria-label="Borrar el audio">✕</button>` : ""}</span>`),
  ];
  const added = [
    ...draft.photos.map((p, i) => `<span class="pv is-new"><img src="${esc(p.url)}" alt="Foto nueva"><button type="button" class="mini-x" data-att="rm-photo" data-i="${i}" aria-label="Quitar la foto">✕</button></span>`),
    draft.audio ? `<span class="pv pv-audio is-new"><audio controls src="${esc(draft.audio.url)}"></audio><small>${esc(clock(draft.audio.seconds))}</small><button type="button" class="mini-x" data-att="rm-audio" aria-label="Quitar el audio">✕</button></span>` : "",
  ];
  const bar = draft.recording
    ? `<div class="rec-bar"><span class="rec-dot" aria-hidden="true"></span><strong>Grabando <span data-rec="act">${esc(clock(draft.seconds))}</span></strong><button type="button" class="btn small primary" data-att="stop">Parar</button><button type="button" class="btn small ghost" data-att="cancel">Cancelar</button></div>`
    : `<div class="compose-bar"><button type="button" class="tool" data-att="cam">${icon("camera", 17)}<span>Hacer foto</span></button><button type="button" class="tool" data-att="gal">${icon("images", 17)}<span>Elegir fotos</span></button>${canRecord() ? `<button type="button" class="tool" data-att="mic"><span aria-hidden="true">🎤</span><span>Grabar audio</span></button>` : ""}</div>`;
  box.innerHTML = `<legend>Fotos y notas de voz</legend>
    ${have.length ? `<div class="compose-previews">${have.join("")}</div>` : ""}
    ${added.some(Boolean) ? `<div class="compose-previews">${added.join("")}</div>` : ""}
    ${bar}`;
}

async function choose(camera) {
  const files = await pickFiles({ camera, multiple: !camera });
  for (const file of files) draft.photos.push({ file, url: URL.createObjectURL(file) });
  if (files.length) renderActivityAttachments();
}

export function initAttach() {
  $("#act-attach").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-att]");
    if (!button) return;
    const { att, i, id } = button.dataset;
    try {
      if (att === "cam") await choose(true);
      else if (att === "gal") await choose(false);
      else if (att === "rm-photo") {
        URL.revokeObjectURL(draft.photos[Number(i)].url);
        draft.photos.splice(Number(i), 1);
        renderActivityAttachments();
      } else if (att === "rm-audio") {
        URL.revokeObjectURL(draft.audio.url);
        draft.audio = null;
        renderActivityAttachments();
      } else if (att === "mic") {
        if (draft.recording || draft.starting) return; // un segundo toque no abre otra grabadora
        draft.starting = true;
        try {
          draft.seconds = 0;
          if (draft.audio) {
            URL.revokeObjectURL(draft.audio.url); // grabar de nuevo sustituye la nota anterior
            draft.audio = null;
          }
          draft.recording = await startRecording({
            onTick: (s) => {
              draft.seconds = s;
              for (const el of document.querySelectorAll('[data-rec="act"]')) el.textContent = clock(s);
            },
            onCancel: () => {
              draft.recording = null;
              renderActivityAttachments();
            },
          });
        } finally {
          draft.starting = false;
        }
        renderActivityAttachments();
      } else if (att === "stop" || att === "cancel") {
        const recorded = att === "stop" ? await draft.recording?.stop() : await draft.recording?.cancel();
        draft.recording = null;
        if (recorded) draft.audio = { ...recorded, url: URL.createObjectURL(recorded.blob) };
        renderActivityAttachments();
      } else if (att === "del-photo" || att === "del-audio") {
        if (!confirm(att === "del-photo" ? "¿Borrar esta foto?" : "¿Borrar esta nota de voz?")) return;
        if (att === "del-photo") await ctx.store.deletePhoto(state.photos.find((p) => p.id === id));
        else await ctx.store.deleteAudio(state.audios.find((a) => a.id === id));
        await ctx.actions.refresh();
        renderActivityAttachments();
      }
    } catch (err) {
      toast(err.message || "No se pudo completar");
    }
  });
}

// Sube lo elegido a la actividad ya guardada. Devuelve cuántos adjuntos fallaron y el motivo del último (la actividad ya está
// guardada). Copia lo elegido al empezar: si se cierra el diálogo mientras sube, el borrador puede vaciarse.
export async function uploadActivityDraft(activityId) {
  const photos = [...draft.photos];
  const audio = draft.audio;
  let failed = 0;
  let reason = "";
  const fail = (err) => {
    failed++;
    reason = schemaHint(err).message;
    console.error(err);
  };
  for (const [i, p] of photos.entries()) {
    toast(`Subiendo foto ${i + 1} de ${photos.length}…`, 60000);
    try {
      await ctx.store.addPhoto({ ...(await prepareImage(p.file)), activity_id: activityId });
    } catch (err) {
      fail(err);
    }
  }
  if (audio) {
    toast("Subiendo la nota de voz…", 60000);
    try {
      await ctx.store.addAudio({ blob: audio.blob, seconds: audio.seconds, mime: audio.mime, activity_id: activityId });
    } catch (err) {
      fail(err);
    }
  }
  return { failed, reason };
}
