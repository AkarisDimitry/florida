// Ubicación en vivo: mientras está activada, la posición de este dispositivo se publica para los demás viajeros.
// Funciona solo con la app abierta (los navegadores pausan el GPS en segundo plano) y mantiene la pantalla
// encendida para que siga enviando. Se envía como mucho cada 20 s si te mueves más de 15 m, y cada 60 s si no.
import { state, ctx } from "./state.js";
import { distanceKm, geolocationMessage } from "./geo.js";

let watchId = null;
let wakeLock = null;
let last = { t: 0, lat: 0, lng: 0 };

async function lockScreen() {
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
  } catch {
    wakeLock = null; // sin permiso o sin soporte: se sigue compartiendo igualmente
  }
}

// Al volver a la app el navegador suelta el bloqueo de pantalla: se vuelve a pedir.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && watchId != null) lockScreen();
});

export const isSharing = () => watchId != null;

// onError: fallos puntuales (avisan pero se sigue compartiendo). onFatal: ya no se puede seguir (permiso denegado).
export function startSharing({ onError, onFatal } = {}) {
  if (watchId != null) return;
  if (!navigator.geolocation) throw new Error("Este navegador no puede obtener la ubicación.");
  last = { t: 0, lat: 0, lng: 0 };
  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      state.me = here;
      const now = Date.now();
      const movedMeters = last.t ? distanceKm(last, here) * 1000 : Infinity;
      if (last.t && now - last.t < 60_000 && (now - last.t < 20_000 || movedMeters < 15)) return;
      last = { t: now, ...here };
      try {
        await ctx.store.shareLocation(here);
      } catch (err) {
        onError?.(err);
      }
    },
    (err) => {
      // Un "tiempo agotado" o "posición no disponible" es normal si te quedas quieto o pierdes señal un rato:
      // solo se deja de compartir si se deniega el permiso.
      if (err.code === 1) onFatal?.(new Error(geolocationMessage(err)));
      else console.warn("Ubicación en vivo:", err.message);
    },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
  lockScreen();
}

export async function stopSharing() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  try {
    await wakeLock?.release();
  } catch {
    /* ya estaba suelto */
  }
  wakeLock = null;
  await ctx.store.stopSharing();
}
