// Cámara y micrófono: elegir o hacer una foto y grabar una nota de voz. Todo desde el navegador, sin librerías.

// Abre la cámara (en el móvil) o el selector de archivos. Devuelve la lista de archivos elegidos ([] si se cancela).
// Tiene que llamarse directamente desde un toque: iOS no deja abrir el selector pasado un instante.
export function pickFiles({ camera = false, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "image/*", multiple });
    if (camera) input.setAttribute("capture", "environment"); // el atributo, no la propiedad: algunos navegadores solo reconocen el atributo
    input.style.display = "none";
    document.body.append(input);
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish([...input.files]));
    input.addEventListener("cancel", () => finish([]));
    // Navegadores sin el evento "cancel": al volver el foco sin archivos se da por cancelado (con margen para el "change").
    window.addEventListener("focus", () => setTimeout(() => !input.files?.length && finish([]), 1500), { once: true });
    input.click();
  });
}

export const canRecord = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

const MIME_TRIES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
const pickMime = () => MIME_TRIES.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) ?? "";

export const MAX_SECONDS = 120; // las notas de voz duran como mucho 2 minutos (≈ 1 MB), muy por debajo del límite de 5 MB

// Grabaciones en curso: si la persona cambia de pestaña, cierra el diálogo o bloquea el móvil, se cancelan (si no, la luz del
// micrófono se quedaría encendida sin que la barra de «Grabando» siguiera en pantalla).
const active = new Set();
export function cancelAllRecordings() {
  for (const recording of [...active]) recording.cancel();
}
document.addEventListener("visibilitychange", () => document.hidden && cancelAllRecordings());
addEventListener("pagehide", cancelAllRecordings);

// Empieza a grabar. Devuelve { stop() -> Promise<{ blob, seconds, mime }>, cancel() }. `onCancel` avisa de que la grabación se
// canceló (por quien sea) para que quien la pidió limpie su estado.
export async function startRecording({ onTick, onCancel } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error(err?.name === "NotAllowedError" ? "No hay permiso para usar el micrófono. Actívalo en los ajustes del navegador." : "No se pudo usar el micrófono.");
  }
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  const mime = pickMime();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
  } catch {
    stopTracks(); // si no se puede grabar, el micrófono no debe quedar abierto
    throw new Error("Este navegador no puede grabar audio.");
  }
  const chunks = [];
  const started = Date.now();
  let cancelled = false;
  let timer;
  let finish;
  const result = new Promise((resolve) => (finish = resolve));
  const handle = {
    stop() {
      if (recorder.state !== "inactive") recorder.stop();
      return result;
    },
    cancel() {
      const was = !cancelled && recorder.state !== "inactive";
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
      else {
        stopTracks();
        active.delete(handle);
      }
      if (was) onCancel?.();
      return result;
    },
  };
  recorder.ondataavailable = (event) => event.data?.size && chunks.push(event.data);
  recorder.onstop = () => {
    clearInterval(timer);
    stopTracks();
    active.delete(handle);
    // El tipo va sin parámetros ("audio/webm", no "audio/webm;codecs=opus"): es lo que acepta el almacén.
    const type = (recorder.mimeType || mime || "audio/webm").split(";")[0];
    // La duración es lo grabado (no el reloj: si el móvil se suspendió, el reloj saldría exagerado), entre 1 s y el tope.
    const seconds = Math.min(MAX_SECONDS, Math.max(1, Math.round((Date.now() - started) / 1000)));
    finish(cancelled ? null : { blob: new Blob(chunks, { type }), seconds, mime: type });
  };
  try {
    recorder.start();
  } catch {
    stopTracks();
    throw new Error("No se pudo empezar a grabar.");
  }
  active.add(handle);
  timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    onTick?.(Math.min(seconds, MAX_SECONDS));
    if (seconds >= MAX_SECONDS && recorder.state !== "inactive") recorder.stop();
  }, 250);
  return handle;
}

export const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
