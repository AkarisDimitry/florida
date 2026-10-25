// Aviso de «hay una versión nueva». La web se actualiza sola cada vez que se abre (el service worker pide siempre los archivos a la
// red), pero una app que se queda abierta días en el móvil no se enteraría. Aquí se compara version.json (que se renueva con cada
// publicación) al volver a la app y cada 10 minutos; si cambió, sale un aviso discreto con el botón «Actualizar».
const FILE = "version.json";
const EVERY_MS = 10 * 60_000;
let current = null;
let shown = false;

async function fetchVersion() {
  try {
    const response = await fetch(`${FILE}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.version === "string" && data.version ? data.version : null;
  } catch {
    return null; // sin conexión o sin archivo: no se avisa de nada
  }
}

function show() {
  if (shown) return;
  shown = true;
  const bar = document.createElement("div");
  bar.className = "update-bar";
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span aria-hidden="true">✨</span><strong>Hay una versión nueva de la app</strong><button type="button" class="update-go">Actualizar</button><button type="button" class="update-later" aria-label="Más tarde">✕</button>`;
  bar.querySelector(".update-go").addEventListener("click", async () => {
    try {
      await (await navigator.serviceWorker?.getRegistration())?.update();
    } catch {
      /* se recarga igualmente */
    }
    location.reload();
  });
  bar.querySelector(".update-later").addEventListener("click", () => {
    bar.remove();
    shown = false; // vuelve a avisar dentro de un rato si sigue habiendo versión nueva
    current = null;
    fetchVersion().then((v) => (current = v ?? current));
  });
  document.body.append(bar);
}

async function check() {
  if (document.hidden || !current) return;
  const latest = await fetchVersion();
  if (latest && latest !== current) show();
}

export async function initUpdates() {
  current = await fetchVersion();
  if (!current) return;
  document.addEventListener("visibilitychange", check);
  setInterval(check, EVERY_MS);
}
