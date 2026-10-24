// Reduce una foto en el navegador antes de subirla: una versión grande y una miniatura, ambas JPEG.
// Pasar por <canvas> descarta los metadatos EXIF (incluida la ubicación GPS).
const FULL_SIDE = 1600;
const THUMB_SIDE = 400;

export async function prepareImage(file) {
  const img = await loadImage(file);
  return {
    full: await scale(img, FULL_SIDE, 0.82),
    thumb: await scale(img, THUMB_SIDE, 0.7),
  };
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
