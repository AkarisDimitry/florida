// Ubicación por defecto de las fotos. Orden: (1) el GPS que traiga la propia foto (EXIF, lo lee images.js); (2) si no trae, la posición
// del dispositivo EN EL MOMENTO de elegir o hacer la foto (no al vaciar la cola, que puede ser horas después); (3) si no hay permiso
// o falla, la foto sigue sin ubicación y no se bloquea nada. Se puede apagar en Ajustes. Solo es aproximada para una foto antigua de la
// galería sin GPS (es la posición de ahora), y quien la subió puede moverla o quitarla desde el visor.
import { settings } from "./settings.js";
import { toast } from "./util.js";

const FRESH_MS = 120_000; // una posición de hace menos de 2 minutos vale para las siguientes fotos (no se vuelve a pedir)
const WAIT_MS = 9_000; // espera máxima si el permiso ya estaba concedido
const WAIT_PROMPT_MS = 20_000; // y si el navegador está preguntando (la persona necesita tiempo para contestar)
const NOTE_KEY = "viaje.avisoUbicacionFotos";
const NOTE_TEXT = "📍 Se guardará dónde estás para ver la foto en el mapa";

let last = null; // { lat, lng, at }
let pending = null; // petición en curso (varias fotos a la vez comparten una)
let failedAt = 0; // último fallo: durante unos segundos no se insiste (así un permiso denegado no retrasa cada lote)

export const photoLocationEnabled = () => settings.locatePhotos !== false && Boolean(navigator.geolocation);

const noteSeen = () => {
  try {
    return localStorage.getItem(NOTE_KEY) === "1";
  } catch {
    return true;
  }
};
const markNoteSeen = () => {
  try {
    localStorage.setItem(NOTE_KEY, "1");
  } catch {
    /* sin almacenamiento: se explicará otra vez */
  }
};

async function permission() {
  try {
    return (await navigator.permissions?.query({ name: "geolocation" }))?.state ?? "unknown";
  } catch {
    return "unknown"; // Safari antiguo: no se puede consultar
  }
}

// { lat, lng } de ahora mismo, o null. Nunca lanza ni espera para siempre.
export async function capturePhotoPosition() {
  if (!photoLocationEnabled()) return null;
  if (last && Date.now() - last.at < FRESH_MS) return last;
  if (pending) return pending;
  if (Date.now() - failedAt < 30_000) return null;
  pending = (async () => {
    const state = await permission();
    if (state === "denied") {
      failedAt = Date.now();
      return null;
    }
    // La primera vez, y solo si el navegador va a preguntar, se explica para qué es.
    if (state !== "granted" && !noteSeen()) {
      markNoteSeen();
      toast(NOTE_TEXT, 6000);
    }
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), state === "granted" ? WAIT_MS : WAIT_PROMPT_MS);
      try {
        navigator.geolocation.getCurrentPosition(
          (p) => {
            clearTimeout(timer);
            resolve({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)), at: Date.now() });
          },
          () => {
            clearTimeout(timer);
            resolve(null);
          },
          { enableHighAccuracy: false, timeout: 8000, maximumAge: FRESH_MS },
        );
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
    if (got) last = got;
    else failedAt = Date.now();
    return got;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

// Para un lote de fotos: una sola petición de posición por lote (se pide la primera vez que una foto no trae GPS).
export function batchLocator() {
  let promise = null;
  return {
    // Rellena lat/lng de `prepared` si le faltan; devuelve de dónde salieron: "foto" (EXIF), "dispositivo" o null.
    async fill(prepared) {
      if (Number.isFinite(prepared.lat) && Number.isFinite(prepared.lng)) return "foto";
      if (!photoLocationEnabled()) return null;
      promise ??= capturePhotoPosition();
      const here = await promise;
      if (!here) return null;
      prepared.lat = here.lat;
      prepared.lng = here.lng;
      return "dispositivo";
    },
  };
}
