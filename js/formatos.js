// Formatos de foto. El formato se reconoce por el CONTENIDO del archivo (no por la extensión ni por el tipo que declare el sistema:
// una foto HEIC elegida en Chrome de escritorio llega con el tipo vacío). Si el navegador sabe dibujarla (JPEG, PNG, WebP, GIF,
// BMP, AVIF… y HEIC en Safari) se usa tal cual; si no (HEIC/HEIF en Chrome, Firefox, Edge y Android) se convierte a JPEG con un
// decodificador que se descarga solo en ese momento (heic2any, de jsDelivr, versión fija). images.js dibuja el resultado en un
// <canvas> y lo sube siempre como JPEG.
const HEIC_SCRIPT = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";

// Lo que acepta el selector de fotos: cualquier imagen y, por si el sistema filtra por extensión, las menos comunes.
// En iPhone/iPad se deja solo `image/*`: así iOS convierte él mismo las fotos HEIC a JPEG al elegirlas (si el selector nombra
// .heic, iOS entrega el original sin convertir).
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const PHOTO_ACCEPT = IOS ? "image/*" : "image/*,.heic,.heif,.avif";

const LABELS = { jpeg: "JPEG", png: "PNG", gif: "GIF", webp: "WebP", bmp: "BMP", tiff: "TIFF", heic: "HEIC/HEIF", avif: "AVIF", svg: "SVG", pdf: "PDF", video: "vídeo" };
const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"];

// { kind, label }: kind en minúsculas (jpeg, png, heic…) o "unknown".
export async function sniffFormat(file) {
  let head = new Uint8Array(0);
  try {
    head = new Uint8Array(await file.slice(0, 96).arrayBuffer());
  } catch {
    /* no se puede leer: se juzga por el nombre */
  }
  const ascii = (from, to) => String.fromCharCode(...head.slice(from, to));
  let kind = "unknown";
  if (head[0] === 0xff && head[1] === 0xd8) kind = "jpeg";
  else if (head[0] === 0x89 && ascii(1, 4) === "PNG") kind = "png";
  else if (ascii(0, 4) === "GIF8") kind = "gif";
  else if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") kind = "webp";
  else if (ascii(0, 2) === "BM" && head[6] === 0 && head[7] === 0) kind = "bmp";
  else if ((ascii(0, 2) === "II" && head[2] === 42 && head[3] === 0) || (ascii(0, 2) === "MM" && head[2] === 0 && head[3] === 42)) kind = "tiff";
  else if (ascii(4, 8) === "ftyp") {
    const brands = ascii(8, 96).match(/.{4}/g) ?? [];
    if (brands.some((b) => b === "avif" || b === "avis")) kind = "avif";
    else if (brands.some((b) => HEIC_BRANDS.includes(b))) kind = "heic";
    else if (/^(mp4|qt|isom|M4V|3gp)/i.test(ascii(8, 12))) kind = "video";
  } else if (ascii(0, 4) === "%PDF") kind = "pdf";
  else if (/^\s*(<\?xml|<svg)/i.test(ascii(0, 64))) kind = "svg";
  if (kind !== "unknown") return { kind, label: LABELS[kind] };
  // Sin firma conocida: se mira lo que diga el sistema.
  const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name || "")?.[1]?.toLowerCase();
  const byName = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp", tif: "tiff", tiff: "tiff", heic: "heic", heif: "heic", avif: "avif", svg: "svg" }[ext];
  if (byName) return { kind: byName, label: LABELS[byName], byName: true };
  return { kind: "unknown", label: ext ? ext.toUpperCase() : file.type ? file.type.replace(/^.*\//, "").toUpperCase() : "desconocido" };
}

export class PhotoFormatError extends Error {
  constructor(format, detail = "") {
    super(detail || `No se pudo leer esta foto (formato ${format.label}). Prueba con otra o haz una captura de pantalla.`);
    this.name = "PhotoFormatError";
    this.format = format;
  }
}

// ---------- decodificador de HEIC/HEIF (carga perezosa) ----------

// Se carga como <script> clásico (el paquete es UMD y deja `heic2any` global): si falla la red, un fallo no queda guardado y se puede
// volver a intentar más tarde, cosa que no pasa con import() dinámico.
let heicLoader = null;
function loadHeic() {
  if (typeof window.heic2any === "function") return Promise.resolve(window.heic2any);
  heicLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = HEIC_SCRIPT;
    script.async = true;
    script.onload = () => (typeof window.heic2any === "function" ? resolve(window.heic2any) : reject(new Error("decodificador sin función")));
    script.onerror = () => reject(new Error("no se pudo descargar el decodificador"));
    document.head.append(script);
  }).catch((err) => {
    heicLoader = null; // se vuelve a intentar la próxima vez
    document.querySelectorAll(`script[src="${HEIC_SCRIPT}"]`).forEach((el) => el.remove());
    throw err;
  });
  return heicLoader;
}

async function heicToJpeg(file, format) {
  let convert;
  try {
    convert = await loadHeic();
  } catch (err) {
    console.warn("No se pudo cargar el decodificador de HEIC:", err?.message || err);
    throw new PhotoFormatError(format, "Esta foto es HEIC y tu navegador no la lee. Para convertirla hace falta conexión una vez (se descarga un conversor); inténtalo de nuevo con señal, o haz una captura de pantalla.");
  }
  try {
    const out = await convert({ blob: new Blob([file], { type: "image/heic" }), toType: "image/jpeg", quality: 0.92 });
    return Array.isArray(out) ? out[0] : out;
  } catch (err) {
    console.warn("Conversión de HEIC fallida:", err?.message || err);
    throw new PhotoFormatError(format);
  }
}

// ---------- decodificación ----------

// La orientación EXIF se aplica sola al dibujar un <img> (todos los navegadores actuales); con ImageBitmap se pide a propósito.
function viaImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      img.naturalWidth && img.naturalHeight ? resolve(img) : reject(new Error("sin tamaño"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("no decodificable"));
    };
    img.src = url;
  });
}

async function viaBitmap(blob) {
  if (typeof createImageBitmap !== "function") throw new Error("sin createImageBitmap");
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  if (!bitmap.width || !bitmap.height) throw new Error("sin tamaño");
  return bitmap;
}

// Devuelve algo que se pueda dibujar con drawImage (HTMLImageElement o ImageBitmap) ya con la orientación correcta.
// `onConvert` avisa de que va a tardar (descarga y conversión de un HEIC).
export async function decodePhoto(file, { onConvert } = {}) {
  const format = await sniffFormat(file);
  if (format.kind === "video") throw new PhotoFormatError(format, "Eso es un vídeo, no una foto. Elige una imagen.");
  if (format.kind === "pdf") throw new PhotoFormatError(format, "Eso es un PDF, no una foto. Elige una imagen.");
  try {
    return await viaImg(file);
  } catch {
    /* el navegador no la dibuja tal cual */
  }
  if (format.kind === "heic") {
    onConvert?.(format);
    const jpeg = await heicToJpeg(file, format);
    try {
      return await viaImg(jpeg);
    } catch {
      throw new PhotoFormatError(format);
    }
  }
  try {
    return await viaBitmap(file);
  } catch {
    throw new PhotoFormatError(format);
  }
}
