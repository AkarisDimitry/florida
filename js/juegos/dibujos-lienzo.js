// El lienzo del «Álbum de dibujos»: un diálogo a pantalla completa para dibujar con el dedo (o el lápiz o el ratón).
// El dibujo es una LISTA DE TRAZOS en un espacio lógico fijo de 1000×1000: así se ve igual en cualquier móvil, no se pierde al girar la
// pantalla o cambiar el tamaño (se vuelve a pintar desde los trazos) y se exporta a cualquier resolución sin pérdida.
// La goma borra de verdad (no pinta del color del fondo): los trazos viven en una capa transparente y el fondo se pone debajo, así se
// puede cambiar de fondo después de borrar.
// Este módulo no sabe nada de Supabase: al pulsar «Guardar» llama a `save({ full, thumb, prompt, version })` (lo pone dibujos.js) y,
// si falla, enseña el error y deja el dibujo intacto para reintentar.
import { icon } from "../icons.js";
import { esc } from "../util.js";

export const LOGICAL = 1000; // lado del espacio lógico en el que se guardan los trazos
export const FULL_SIDE = 1200; // el dibujo que se sube
export const THUMB_SIDE = 400; // y su miniatura
const FULL_QUALITY = 0.88;
const THUMB_QUALITY = 0.8;
const MAX_POINTS = 6000; // por trazo (un garabato eterno no debe agotar la memoria)
const MAX_HISTORY = 400; // pasos que se pueden deshacer (se piden al menos 30)
const MIN_STEP = 1.2; // separación mínima entre puntos (en el espacio lógico) para no llenar el trazo de puntos casi iguales
const MAX_BACKING = 1500; // píxeles máximos del lienzo en pantalla (en móviles con mucha densidad no hace falta más)

export const COLORS = [
  ["#111827", "Negro"], ["#ffffff", "Blanco"], ["#ef4444", "Rojo"], ["#f97316", "Naranja"], ["#facc15", "Amarillo"], ["#84cc16", "Verde lima"],
  ["#16a34a", "Verde"], ["#06b6d4", "Turquesa"], ["#2563eb", "Azul"], ["#7c3aed", "Violeta"], ["#ec4899", "Rosa"], ["#92400e", "Marrón"],
];
export const WIDTHS = [[6, "Fino"], [14, "Medio"], [28, "Grueso"], [52, "Enorme"]];
export const BACKGROUNDS = [["#ffffff", "Blanco"], ["#fbf3df", "Papel"], ["#cfe9ff", "Cielo"]];

// Ideas para dibujar (el viaje de la familia): se enseñan de nueve en nueve y se pueden barajar.
export const TOPICS = [
  ["🦩", "Un flamenco"], ["🚗", "Nuestro coche"], ["🏖️", "La playa"], ["🦀", "El cangrejo"], ["🍕", "Mi comida favorita"],
  ["🐊", "Un cocodrilo simpático"], ["🌴", "Una palmera"], ["🌅", "El atardecer"], ["🍦", "Un helado gigante"], ["🧳", "Mi maleta"],
  ["🐬", "Un delfín saltando"], ["🏨", "El hotel"], ["🐙", "Un pulpo con gafas de sol"], ["👨‍👩‍👧", "La familia de viaje"], ["✈️", "El avión"],
  ["🏴‍☠️", "Un pirata"], ["🗺️", "El mapa del tesoro"], ["🐶", "Mi mascota"], ["🦈", "Un tiburón amistoso"], ["🏰", "Un castillo de arena"],
  ["⛵", "Un barco"], ["⛈️", "Una tormenta tropical"], ["🤳", "Mi selfie"], ["👒", "Mi sombrero de playa"], ["🛸", "Un OVNI en la playa"],
  ["🐉", "Un dragón de vacaciones"], ["🤖", "Un robot en la playa"], ["🎡", "La noria"], ["🌈", "Un arcoíris"], ["⭐", "El mejor momento del viaje"],
];
const SHOWN_TOPICS = 9;

// ---------- trazos: pintar ----------

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function setup(c, s, k) {
  c.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
  c.strokeStyle = c.fillStyle = s.tool === "eraser" ? "#000" : s.color;
  c.lineWidth = s.width * k;
  c.lineCap = c.lineJoin = "round";
}

function dot(c, p, s, k) {
  c.beginPath();
  c.arc(p[0] * k, p[1] * k, (s.width * k) / 2, 0, Math.PI * 2);
  c.fill();
}

// Pinta un trazo entero (k = píxeles por unidad lógica). Curvas suaves por los puntos medios: el mismo dibujo que se va haciendo en vivo.
export function paintStroke(c, s, k) {
  const p = s.pts;
  if (!p.length) return;
  c.save();
  setup(c, s, k);
  if (p.length === 1) dot(c, p[0], s, k);
  else {
    c.beginPath();
    c.moveTo(p[0][0] * k, p[0][1] * k);
    if (p.length === 2) c.lineTo(p[1][0] * k, p[1][1] * k);
    else {
      let m = mid(p[0], p[1]);
      c.lineTo(m[0] * k, m[1] * k);
      for (let i = 1; i < p.length - 1; i++) {
        m = mid(p[i], p[i + 1]);
        c.quadraticCurveTo(p[i][0] * k, p[i][1] * k, m[0] * k, m[1] * k);
      }
      c.lineTo(p[p.length - 1][0] * k, p[p.length - 1][1] * k);
    }
    c.stroke();
  }
  c.restore();
}

// Lo mismo, pero solo el trocito nuevo cuando se acaba de añadir el último punto (para dibujar en vivo sin repintar todo).
function paintTail(c, s, k, final) {
  const p = s.pts;
  const n = p.length;
  if (n < 2) return;
  c.save();
  setup(c, s, k);
  c.beginPath();
  if (final) {
    // el final del trazo: de la mitad del último tramo al último punto
    const m = n === 2 ? mid(p[0], p[1]) : mid(p[n - 2], p[n - 1]);
    c.moveTo(m[0] * k, m[1] * k);
    c.lineTo(p[n - 1][0] * k, p[n - 1][1] * k);
  } else if (n === 2) {
    const m = mid(p[0], p[1]);
    c.moveTo(p[0][0] * k, p[0][1] * k);
    c.lineTo(m[0] * k, m[1] * k);
  } else {
    const a = mid(p[n - 3], p[n - 2]);
    const b = mid(p[n - 2], p[n - 1]);
    c.moveTo(a[0] * k, a[1] * k);
    c.quadraticCurveTo(p[n - 2][0] * k, p[n - 2][1] * k, b[0] * k, b[1] * k);
  }
  c.stroke();
  c.restore();
}

// ---------- el motor: trazos, deshacer y rehacer, fondo ----------

export function createEngine(canvas, { onChange } = {}) {
  const view = canvas.getContext("2d");
  const ink = document.createElement("canvas"); // capa transparente con los trazos
  const inkCtx = ink.getContext("2d");
  let px = 0; // lado del lienzo en píxeles reales
  let strokes = []; // trazos terminados
  let undo = []; // pasos para deshacer: { type: "add", stroke } | { type: "clear", strokes }
  let redo = [];
  let current = null; // trazo en curso
  let bg = BACKGROUNDS[0][0];
  let version = 0; // sube con cada cambio del dibujo (trazos o fondo): sirve para saber si hay algo sin guardar
  let raf = 0;
  const tool = { kind: "pen", color: COLORS[8][0], width: WIDTHS[1][0] };

  const changed = () => {
    version++;
    onChange?.();
  };
  const k = () => px / LOGICAL;

  function compose() {
    raf = 0;
    if (!px) return;
    view.setTransform(1, 0, 0, 1, 0, 0);
    view.globalCompositeOperation = "source-over";
    view.fillStyle = bg;
    view.fillRect(0, 0, px, px);
    view.drawImage(ink, 0, 0);
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(compose);
  };

  function redraw() {
    if (!px) return;
    inkCtx.setTransform(1, 0, 0, 1, 0, 0);
    inkCtx.clearRect(0, 0, px, px);
    for (const s of strokes) paintStroke(inkCtx, s, k());
    if (current) paintStroke(inkCtx, current, k());
    compose();
  }

  const strokeWidth = () => (tool.kind === "eraser" ? Math.max(24, tool.width * 1.6) : tool.width);

  return {
    get version() { return version; },
    get isEmpty() { return strokes.length === 0; },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; },
    get drawing() { return Boolean(current); },
    get background() { return bg; },
    get strokeCount() { return strokes.length; },
    get tool() { return { ...tool }; },
    setTool(next) { Object.assign(tool, next); },
    setBackground(color) {
      if (color === bg) return;
      bg = color;
      compose();
      changed();
    },
    // Tamaño real del lienzo (en píxeles): se llama al abrir, al girar y al cambiar de tamaño. Los trazos se vuelven a pintar.
    resize(side) {
      const next = Math.max(1, Math.min(MAX_BACKING, Math.round(side)));
      if (next === px) return;
      px = canvas.width = canvas.height = ink.width = ink.height = next;
      redraw();
    },
    // Empieza un trazo en un punto lógico {x, y}. Devuelve false si ya hay uno en curso.
    begin(x, y) {
      if (current) return false;
      current = { tool: tool.kind, color: tool.color, width: strokeWidth(), pts: [[x, y]] };
      paintStroke(inkCtx, current, k()); // un toque suelto deja un punto
      schedule();
      return true;
    },
    extend(x, y) {
      if (!current || current.pts.length >= MAX_POINTS) return;
      const last = current.pts[current.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < MIN_STEP) return;
      current.pts.push([x, y]);
      paintTail(inkCtx, current, k(), false);
      schedule();
    },
    end(x, y) {
      if (!current) return;
      const s = current;
      current = null;
      if (x != null) {
        const last = s.pts[s.pts.length - 1];
        if (s.pts.length < MAX_POINTS && Math.hypot(x - last[0], y - last[1]) >= MIN_STEP) s.pts.push([x, y]);
      }
      paintTail(inkCtx, s, k(), true);
      strokes.push(s);
      undo.push({ type: "add", stroke: s });
      if (undo.length > MAX_HISTORY) undo.shift();
      redo = [];
      schedule();
      changed();
    },
    undo() {
      const op = undo.pop();
      if (!op) return false;
      if (op.type === "add") strokes = strokes.filter((s) => s !== op.stroke);
      else strokes = [...op.strokes];
      redo.push(op);
      redraw();
      changed();
      return true;
    },
    redo() {
      const op = redo.pop();
      if (!op) return false;
      if (op.type === "add") strokes = [...strokes, op.stroke];
      else strokes = [];
      undo.push(op);
      redraw();
      changed();
      return true;
    },
    // «Borrar todo»: también se puede deshacer.
    clear() {
      if (!strokes.length) return false;
      undo.push({ type: "clear", strokes: [...strokes] });
      if (undo.length > MAX_HISTORY) undo.shift();
      redo = [];
      strokes = [];
      redraw();
      changed();
      return true;
    },
    // JPEG con el fondo opaco, a partir de los trazos (no del lienzo en pantalla): sale nítido a cualquier tamaño.
    async exportJpeg(side, quality) {
      const out = document.createElement("canvas");
      out.width = out.height = side;
      const layer = document.createElement("canvas");
      layer.width = layer.height = side;
      const lc = layer.getContext("2d");
      const scale = side / LOGICAL;
      for (const s of strokes) paintStroke(lc, s, scale);
      const oc = out.getContext("2d");
      oc.fillStyle = bg;
      oc.fillRect(0, 0, side, side);
      oc.drawImage(layer, 0, 0);
      return new Promise((resolve, reject) => out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No se pudo preparar el dibujo. Inténtalo de nuevo."))), "image/jpeg", quality));
    },
    // Para las pruebas: los trazos tal cual.
    dump() { return { strokes: strokes.map((s) => ({ ...s, pts: s.pts.map((p) => [...p]) })), bg }; },
  };
}

// ---------- el diálogo ----------

const PREF_KEY = "viaje.dibujos.pref";
const readPref = () => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {};
  } catch {
    return {};
  }
};
const writePref = (pref) => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    /* sin almacenamiento: solo se pierde lo recordado */
  }
};
const isColor = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

let open = null; // solo hay un lienzo abierto a la vez

// Abre el lienzo. `save` recibe { full, thumb, prompt, version } y devuelve una promesa (lanza un Error con el motivo si falla).
// Devuelve una promesa que se cumple al cerrarse el lienzo: true si se guardó el dibujo.
export function openLienzo({ save, onDiscard } = {}) {
  if (open) return open.promise;
  const pref = readPref();
  const E = {
    step: "tema", // tema | lienzo
    prompt: "",
    customTopic: false, // el chip «Dibujo libre» o un tema escrito
    ideas: shuffle(TOPICS).slice(0, SHOWN_TOPICS),
    kind: "pen",
    color: isColor(pref.color) ? pref.color : COLORS[8][0],
    width: WIDTHS.some((w) => w[0] === pref.width) ? pref.width : WIDTHS[1][0],
    bg: BACKGROUNDS.some((b) => b[0] === pref.bg) ? pref.bg : BACKGROUNDS[0][0],
    layer: "tema", // lo que hay encima del lienzo: tema | confirm-clear | confirm-cancel | ""
    busy: false,
    status: "",
    statusKind: "",
    savedVersion: 0,
    saved: false,
  };
  const dlg = document.createElement("dialog");
  dlg.className = "dib-editor";
  dlg.setAttribute("aria-labelledby", "dib-ed-title");
  dlg.innerHTML = `
    <header class="dib-head">
      <h2 id="dib-ed-title" class="dib-sr" tabindex="-1">Dibujar</h2>
      <button type="button" class="btn dib-cancel" data-dib="cancel">${icon("x", 18)} Cancelar</button>
      <button type="button" class="dib-topic-btn" data-dib="topic" aria-label="Tema del dibujo: cambiar"></button>
      <button type="button" class="btn primary dib-save" data-dib="save"><span aria-hidden="true">✅</span> Guardar</button>
    </header>
    <div class="dib-stage"><canvas class="dib-canvas" role="img" aria-label="Lienzo de dibujo: dibuja con el dedo sobre este recuadro"></canvas></div>
    <section class="dib-tools" aria-label="Herramientas de dibujo"></section>
    <p class="dib-status" role="status" aria-live="polite"></p>
    <div class="dib-layer" hidden></div>`;
  document.body.append(dlg);
  document.documentElement.classList.add("dib-lock");

  const canvas = dlg.querySelector("canvas");
  const stage = dlg.querySelector(".dib-stage");
  const tools = dlg.querySelector(".dib-tools");
  const layerEl = dlg.querySelector(".dib-layer");
  const statusEl = dlg.querySelector(".dib-status");
  const topicBtn = dlg.querySelector(".dib-topic-btn");
  const saveBtn = dlg.querySelector(".dib-save");
  const cancelBtn = dlg.querySelector(".dib-cancel");

  const engine = createEngine(canvas, { onChange: () => paintTools() });
  engine.setTool({ kind: E.kind, color: E.color, width: E.width });
  engine.setBackground(E.bg);
  E.savedVersion = engine.version; // el fondo elegido de entrada no cuenta como «cambios sin guardar»
  const dirty = () => engine.version !== E.savedVersion;

  let resolve;
  const promise = new Promise((r) => (resolve = r));
  open = { promise };

  // Red de seguridad: si se intenta salir de la página (botón «atrás» de Android, recargar…) con un dibujo sin guardar, el navegador pregunta.
  const warnLeave = (event) => {
    if (dirty() && !engine.isEmpty && !E.saved) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", warnLeave);

  function close() {
    window.removeEventListener("beforeunload", warnLeave);
    ro.disconnect();
    window.removeEventListener("resize", fit);
    window.removeEventListener("orientationchange", fit);
    if (dlg.open) dlg.close();
    dlg.remove();
    document.documentElement.classList.remove("dib-lock");
    open = null;
    resolve(E.saved);
  }

  // ----- tamaño: el lienzo es cuadrado y ocupa todo lo que cabe en la zona central -----
  function fit() {
    const cs = getComputedStyle(stage);
    const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const side = Math.floor(Math.min(w, h));
    if (!(side > 40)) return;
    canvas.style.width = canvas.style.height = `${side}px`;
    engine.resize(side * Math.min(window.devicePixelRatio || 1, 3));
  }
  const ro = new ResizeObserver(fit);
  ro.observe(stage);
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);

  // ----- pintar las partes de la pantalla que cambian -----
  const topicLabel = () => (E.prompt ? E.prompt : "Dibujo libre");
  function paintHead() {
    topicBtn.innerHTML = `<span aria-hidden="true">🎯</span><span class="dib-topic-text">${esc(topicLabel())}</span>`;
    topicBtn.setAttribute("aria-label", `Tema del dibujo: ${topicLabel()}. Tocar para cambiarlo`);
    saveBtn.disabled = E.busy;
    cancelBtn.disabled = E.busy;
    topicBtn.disabled = E.busy;
  }

  function paintTools() {
    const dis = E.busy ? " disabled" : "";
    const colorRow = COLORS.map(
      ([c, name]) => `<button type="button" class="dib-sw${c === "#ffffff" ? " is-white" : ""}" style="--c:${c}" data-dib="color" data-value="${c}" aria-label="Color ${name}" aria-pressed="${E.kind === "pen" && E.color.toLowerCase() === c}"${dis}></button>`,
    ).join("");
    const custom = !COLORS.some(([c]) => c === E.color.toLowerCase());
    tools.innerHTML = `
      <div class="dib-row dib-row-tools">
        <button type="button" class="dib-tool" data-dib="pen" aria-pressed="${E.kind === "pen"}"${dis}><span class="dib-ico" aria-hidden="true">✏️</span><span>Lápiz</span></button>
        <button type="button" class="dib-tool" data-dib="eraser" aria-pressed="${E.kind === "eraser"}"${dis}><span class="dib-ico" aria-hidden="true">🧽</span><span>Goma</span></button>
        <button type="button" class="dib-tool" data-dib="undo"${engine.canUndo && !E.busy ? "" : " disabled"}><span class="dib-ico" aria-hidden="true">↶</span><span>Deshacer</span></button>
        <button type="button" class="dib-tool" data-dib="redo"${engine.canRedo && !E.busy ? "" : " disabled"}><span class="dib-ico" aria-hidden="true">↷</span><span>Rehacer</span></button>
        <button type="button" class="dib-tool" data-dib="clear"${engine.isEmpty || E.busy ? " disabled" : ""}><span class="dib-ico" aria-hidden="true">🗑️</span><span>Borrar todo</span></button>
      </div>
      <div class="dib-colors" role="group" aria-label="Colores">${colorRow}</div>
      <div class="dib-row dib-row-widths" role="group" aria-label="Grosor del trazo">
        ${WIDTHS.map(([w, name]) => `<button type="button" class="dib-wd" data-dib="width" data-value="${w}" aria-label="Trazo ${name.toLowerCase()}" aria-pressed="${E.width === w}"${dis}><i style="--d:${Math.round(4 + w * 0.42)}px"></i></button>`).join("")}
        <label class="dib-custom${custom && E.kind === "pen" ? " is-on" : ""}" aria-label="Elegir otro color"><input type="color" data-dib="custom" value="${esc(E.color)}"${dis}><span aria-hidden="true">🎨</span></label>
      </div>
      <div class="dib-row dib-row-bg" role="group" aria-label="Fondo del dibujo">
        ${BACKGROUNDS.map(([c, name]) => `<button type="button" class="dib-bg" style="--c:${c}" data-dib="bg" data-value="${c}" aria-pressed="${engine.background === c}"${dis}><i aria-hidden="true"></i> ${name}</button>`).join("")}
      </div>`;
  }

  function paintStatus() {
    statusEl.textContent = E.status;
    statusEl.className = `dib-status${E.statusKind ? ` is-${E.statusKind}` : ""}`;
    if (E.statusKind === "error") statusEl.setAttribute("role", "alert");
    else statusEl.setAttribute("role", "status");
  }
  function say(text, kind = "") {
    E.status = text;
    E.statusKind = kind;
    paintStatus();
  }

  function paintLayer({ focus = true } = {}) {
    const kindOfLayer = E.layer;
    layerEl.hidden = !kindOfLayer;
    stage.toggleAttribute("inert", Boolean(kindOfLayer));
    tools.toggleAttribute("inert", Boolean(kindOfLayer));
    if (!kindOfLayer) {
      layerEl.innerHTML = "";
      return;
    }
    if (kindOfLayer === "tema") {
      layerEl.innerHTML = `
        <div class="dib-panel dib-topic-panel" role="group" aria-labelledby="dib-topic-title">
          <h3 id="dib-topic-title">¿Qué vas a dibujar?</h3>
          <p class="dib-hint">Elige una idea, escribe la tuya o dibuja lo que quieras. El tema es opcional.</p>
          <div class="dib-chips">${E.ideas.map(([e, t]) => `<button type="button" class="dib-chip${E.prompt === t ? " is-on" : ""}" data-dib="pick-topic" data-value="${esc(t)}"><span aria-hidden="true">${e}</span> ${esc(t)}</button>`).join("")}</div>
          <button type="button" class="btn dib-wide" data-dib="shuffle"><span aria-hidden="true">🎲</span> Otras ideas</button>
          <form class="dib-own" data-dib-form="topic">
            <label for="dib-own-input">O escribe tu tema</label>
            <div class="dib-own-row"><input id="dib-own-input" name="topic" maxlength="80" autocomplete="off" placeholder="Mi tema" value="${E.customTopic ? esc(E.prompt) : ""}"><button type="submit" class="btn primary">Usar</button></div>
          </form>
          <button type="button" class="btn dib-wide" data-dib="free"><span aria-hidden="true">🎨</span> Dibujo libre (sin tema)</button>
          ${engine.isEmpty ? "" : `<button type="button" class="btn ghost dib-wide" data-dib="back">Volver al dibujo</button>`}
        </div>`;
      if (focus) layerEl.querySelector(".dib-chip")?.focus();
    } else {
      const clear = kindOfLayer === "confirm-clear";
      layerEl.innerHTML = `
        <div class="dib-panel dib-confirm" role="alertdialog" aria-labelledby="dib-conf-title" aria-describedby="dib-conf-text">
          <h3 id="dib-conf-title">${clear ? "¿Borrar todo el dibujo?" : "¿Salir sin guardar?"}</h3>
          <p id="dib-conf-text" class="dib-hint">${clear ? "Se quitará todo lo que has dibujado. Después podrás deshacerlo con «Deshacer»." : "Tu dibujo todavía no está en el álbum y se perdería."}</p>
          <div class="dib-conf-actions">
            <button type="button" class="btn big" data-dib="conf-no">${clear ? "No, seguir" : "Seguir dibujando"}</button>
            <button type="button" class="btn big danger" data-dib="conf-yes">${clear ? "Sí, borrar todo" : "Salir sin guardar"}</button>
          </div>
        </div>`;
      if (focus) layerEl.querySelector("[data-dib=conf-no]")?.focus();
    }
  }

  function setLayer(name, opts) {
    E.layer = name;
    paintLayer(opts);
  }

  // ----- acciones -----
  function chooseTopic(text, custom = false) {
    E.prompt = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    E.customTopic = custom && Boolean(E.prompt);
    E.step = "lienzo";
    paintHead();
    setLayer("", { focus: false });
    dlg.querySelector("#dib-ed-title")?.focus();
    requestAnimationFrame(fit);
  }

  function askCancel() {
    if (E.busy) return;
    if (!dirty() || engine.isEmpty) return doDiscard();
    setLayer("confirm-cancel");
  }
  function doDiscard() {
    onDiscard?.();
    close();
  }

  async function doSave() {
    if (E.busy) return;
    if (engine.isEmpty) {
      say("Todavía no has dibujado nada. ¡Dibuja algo y guárdalo!", "warn");
      return;
    }
    E.busy = true; // síncrono: un doble toque no guarda dos veces
    say("Guardando el dibujo…", "busy");
    paintHead();
    paintTools();
    const version = engine.version;
    try {
      const full = await engine.exportJpeg(FULL_SIDE, FULL_QUALITY);
      const thumb = await engine.exportJpeg(THUMB_SIDE, THUMB_QUALITY);
      await save({ full, thumb, prompt: E.prompt || null, version });
      E.saved = true;
      E.savedVersion = engine.version;
      close();
    } catch (err) {
      console.warn("Dibujos: no se pudo guardar:", err?.message || err);
      E.busy = false;
      say(err?.message || "No se pudo guardar el dibujo. Inténtalo de nuevo.", "error");
      paintHead();
      paintTools();
    }
  }

  const actions = {
    cancel: askCancel,
    save: doSave,
    topic: () => setLayer("tema"),
    "pick-topic": (el) => chooseTopic(el.dataset.value),
    shuffle: () => {
      const rest = shuffle(TOPICS.filter(([, t]) => !E.ideas.some(([, u]) => u === t)));
      E.ideas = [...rest, ...shuffle(E.ideas)].slice(0, SHOWN_TOPICS);
      paintLayer({ focus: false });
      layerEl.querySelector("[data-dib=shuffle]")?.focus();
    },
    free: () => chooseTopic("", false),
    back: () => setLayer(""),
    pen: () => setTool({ kind: "pen" }),
    eraser: () => setTool({ kind: "eraser" }),
    color: (el) => setTool({ kind: "pen", color: el.dataset.value }),
    width: (el) => setTool({ width: Number(el.dataset.value) }),
    bg: (el) => {
      engine.setBackground(el.dataset.value);
      persist();
    },
    undo: () => engine.undo(),
    redo: () => engine.redo(),
    clear: () => {
      if (!engine.isEmpty) setLayer("confirm-clear");
    },
    "conf-no": () => setLayer(""),
    "conf-yes": () => {
      if (E.layer === "confirm-clear") {
        engine.clear();
        setLayer("");
      } else doDiscard();
    },
  };

  function setTool(next) {
    Object.assign(E, next);
    engine.setTool({ kind: E.kind, color: E.color, width: E.width });
    persist();
    paintTools();
  }
  const persist = () => writePref({ color: E.color, width: E.width, bg: engine.background });

  dlg.addEventListener("click", (event) => {
    const el = event.target.closest("[data-dib]");
    if (!el || el.disabled || el.matches("input")) return;
    actions[el.dataset.dib]?.(el);
  });
  // El selector de color del sistema se queda abierto mientras se elige: en «input» solo se cambia el color del lápiz y la pantalla
  // se repinta al terminar («change»), si no el selector se cerraría solo.
  dlg.addEventListener("input", (event) => {
    if (!event.target.matches?.("input[data-dib=custom]")) return;
    E.kind = "pen";
    E.color = event.target.value;
    engine.setTool({ kind: "pen", color: E.color });
  });
  dlg.addEventListener("change", (event) => {
    if (event.target.matches?.("input[data-dib=custom]")) setTool({ kind: "pen", color: event.target.value });
  });
  dlg.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-dib-form=topic]");
    if (!form) return;
    event.preventDefault();
    const text = String(new FormData(form).get("topic") ?? "").trim();
    if (text) chooseTopic(text, true);
  });
  // Escape y «atrás» no tiran el dibujo sin avisar
  dlg.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (E.layer.startsWith("confirm")) setLayer("");
    else if (E.layer === "tema" && !engine.isEmpty) setLayer(""); // vuelve al dibujo
    else askCancel();
  });
  dlg.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !E.layer && event.target.tagName !== "INPUT") {
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? engine.redo() : engine.undo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        engine.redo();
      }
    }
  });
  dlg.addEventListener("contextmenu", (event) => event.target === canvas && event.preventDefault());

  // ----- dibujar con el dedo, el lápiz o el ratón (Pointer Events) -----
  let pointer = null;
  const point = (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * LOGICAL;
    const y = ((ev.clientY - r.top) / r.height) * LOGICAL;
    return [Math.max(0, Math.min(LOGICAL, x)), Math.max(0, Math.min(LOGICAL, y))];
  };
  canvas.addEventListener("pointerdown", (ev) => {
    if (E.busy || E.layer || pointer !== null) return; // un solo dedo a la vez: el segundo se ignora
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    ev.preventDefault();
    pointer = ev.pointerId;
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* sin captura: se sigue con lo que llegue al lienzo */
    }
    const [x, y] = point(ev);
    engine.begin(x, y);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (ev.pointerId !== pointer) return;
    ev.preventDefault();
    const list = ev.getCoalescedEvents?.() ?? [];
    for (const e of list.length ? list : [ev]) {
      const [x, y] = point(e);
      engine.extend(x, y);
    }
  });
  const finish = (ev) => {
    if (ev.pointerId !== pointer) return;
    pointer = null;
    const [x, y] = point(ev);
    const last = ev.type === "pointerup"; // solo el levantar el dedo trae el último punto fiable
    engine.end(last ? x : null, last ? y : null);
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* ya liberado */
    }
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("lostpointercapture", (ev) => {
    if (ev.pointerId === pointer) finish(ev);
  });

  // ----- arrancar -----
  paintHead();
  paintTools();
  paintStatus();
  paintLayer({ focus: false });
  dlg.showModal();
  layerEl.querySelector(".dib-chip")?.focus();
  requestAnimationFrame(fit);

  dlg.__dib = { engine, state: E }; // para las pruebas
  return promise;
}
