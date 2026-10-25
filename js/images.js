// Prepara una foto antes de subirla:
//   1. lee la ubicación GPS y la fecha de los metadatos EXIF (con exifr, cargado solo cuando hace falta)
//   2. genera una versión grande y una miniatura, ambas JPEG
// La imagen que se sube pasa por <canvas>, así que NO conserva los metadatos: la ubicación solo
// queda guardada como coordenadas en la base de datos, visible únicamente para los viajeros.
const EXIFR = "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.esm.mjs";
const FULL_SIDE = 1600;
const THUMB_SIDE = 400;

export async function prepareImage(file) {
  const meta = await readMetadata(file);
  const img = await loadImage(file);
  return {
    full: await scale(img, FULL_SIDE, 0.82),
    thumb: await scale(img, THUMB_SIDE, 0.7),
    ...meta,
  };
}

// Devuelve { lat, lng, taken_at } con lo que haya; nunca falla (una foto sin metadatos es normal).
// Ojo: EXIF guarda la hora local de la cámara sin huso horario y exifr la devuelve como si fuera UTC;
// por eso `taken_at` es la hora "de reloj" de la foto y se muestra en UTC, sin convertirla.
export async function readMetadata(file) {
  const meta = {};
  let exifr;
  try {
    const mod = await import(EXIFR);
    exifr = mod.default ?? mod;
  } catch (err) {
    console.warn("No se pudo cargar el lector de metadatos:", err.message || err);
    return meta;
  }
  try {
    const gps = await exifr.gps(file);
    if (Number.isFinite(gps?.latitude) && Number.isFinite(gps?.longitude)) {
      meta.lat = Number(gps.latitude.toFixed(6));
      meta.lng = Number(gps.longitude.toFixed(6));
    }
  } catch (err) {
    console.warn("Sin ubicación EXIF:", err.message || err);
  }
  try {
    const tags = await exifr.parse(file); // la versión "lite" no admite `pick`
    const taken = tags?.DateTimeOriginal ?? tags?.CreateDate;
    if (taken instanceof Date && !Number.isNaN(taken.getTime())) meta.taken_at = taken.toISOString();
  } catch (err) {
    console.warn("Sin fecha EXIF:", err.message || err);
  }
  return meta;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`No se pudo leer «${file.name}». ¿Es una imagen JPG, PNG o WebP?`));
    };
    img.src = url;
  });
}

function scale(img, maxSide, quality) {
  const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * ratio);
  canvas.height = Math.round(img.naturalHeight * ratio);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // los PNG con transparencia no deben quedar negros en JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No se pudo comprimir la imagen"))), "image/jpeg", quality),
  );
}
