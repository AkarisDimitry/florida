// Controlador del mapa (MapLibre GL, cargado por <script> desde index.html).
// app.js le pasa los datos con update(); este módulo no conoce el estado de la app.
import { config } from "./config.js";
import { reducedMotion, sleep, categoryOf } from "./util.js";
import { distanceKm, geolocationMessage } from "./geo.js";

const ML = () => window.maplibregl;
const EMPTY = { type: "FeatureCollection", features: [] };
const TRANSPARENT = "rgba(0,0,0,0)";
const ROUTE_LAYERS = ["routes-casing", "routes-solid", "routes-dashed", "routes-arrows"];
const PHOTO_CELL = 64; // px: fotos más cercanas que esto se agrupan en una sola miniatura
const MAX_PHOTO_PINS = 60;

// Degradado de la línea animada: colorea hasta el progreso `t` (0–1) y deja el resto transparente.
const gradient = (color, t) => {
  if (t <= 0.001) return ["interpolate", ["linear"], ["line-progress"], 0, TRANSPARENT, 1, TRANSPARENT];
  if (t >= 0.998) return ["interpolate", ["linear"], ["line-progress"], 0, color, 1, color];
  return ["interpolate", ["linear"], ["line-progress"], 0, color, t, color, t + 0.0005, TRANSPARENT, 1, TRANSPARENT];
};
const lineWidth = (small, large) => ["interpolate", ["linear"], ["zoom"], 4, small, 12, large];
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const lineFeature = (coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } });

function arrowImage() {
  const size = 32;
  const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
  const g = canvas.getContext("2d");
  g.lineCap = g.lineJoin = "round";
  g.beginPath();
  g.moveTo(11, 8);
  g.lineTo(21, 16);
  g.lineTo(11, 24);
  g.strokeStyle = "rgba(0,0,0,.35)";
  g.lineWidth = 6;
  g.stroke();
  g.strokeStyle = "#fff";
  g.lineWidth = 3.5;
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + distanceKm({ lng: coords[i - 1][0], lat: coords[i - 1][1] }, { lng: coords[i][0], lat: coords[i][1] }));
  }
  return cum;
}

function pointAt(coords, cum, d) {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
}

function nearestIndex(coords, stop) {
  let best = 0;
  let bestD = Infinity;
  coords.forEach(([lng, lat], i) => {
    const d = (lng - stop.lng) ** 2 + (lat - stop.lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export function createMap({ container, onStop, onPhoto, onLongPress }) {
  let map = null;
  let failure = null;
  let theme = "light";
  let data = { stops: [], photos: [], routes: [], layers: { stops: true, routes: true, photos: true }, activeDay: null, selected: null, selectedPhoto: null };
  const stopPins = new Map(); // id -> { marker, el, sig }
  const photoPins = new Map(); // id de la foto representante -> { marker, el, group }
  const friendPins = new Map(); // id del viajero -> { marker, el }
  let animToken = 0;
  let animHide = null; // día cuya ruta se oculta mientras se dibuja con animación
  let runner = null;
  let playing = false;
  let onPlayEnd = null;
  let picking = null;
  let watchId = null;
  let meMarker = null;
  let lastMe = null;

  // ---------- arranque ----------

  function init(initialTheme) {
    if (map) return true;
    if (failure) return false;
    if (!ML()) {
      failure = new Error("No se pudo cargar la librería del mapa. Revisa la conexión.");
      return false;
    }
    theme = initialTheme;
    try {
      map = new (ML().Map)({
        container,
        style: config.map.styles[theme],
        center: config.map.center,
        zoom: config.map.zoom,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch (err) {
      failure = new Error("Este navegador no puede mostrar el mapa (necesita WebGL).");
      console.error(err);
      return false;
    }
    map.touchZoomRotate.disableRotation();
    map.addControl(new (ML().AttributionControl)({ compact: true }), "top-left");
    // La atribución nace desplegada; se pliega al botón (i) para no tapar el mapa. Sigue accesible al tocarlo.
    map.once("idle", () => {
      const attribution = container.querySelector(".maplibregl-ctrl-attrib");
      attribution?.removeAttribute("open");
      attribution?.classList.remove("maplibregl-compact-show");
    });
    map.on("style.load", () => {
      addOverlays();
      applyRoutes();
    });
    map.on("moveend", renderPhotoPins);
    map.on("resize", renderPhotoPins);
    map.on("error", (e) => console.warn("Mapa:", e.error?.message || e));
    map.on("click", (e) => {
      if (!picking) return;
      const { resolve } = picking;
      picking = null;
      container.classList.remove("is-picking");
      resolve({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    setupLongPress();
    return true;
  }

  function addOverlays() {
    if (!map.hasImage("route-arrow")) map.addImage("route-arrow", arrowImage(), { pixelRatio: 2 });
    const layout = { "line-cap": "round", "line-join": "round" };
    map.addSource("routes", { type: "geojson", data: EMPTY });
    map.addLayer({
      id: "routes-casing",
      type: "line",
      source: "routes",
      layout,
      paint: { "line-color": theme === "dark" ? "#0b1220" : "#ffffff", "line-width": lineWidth(4.5, 10), "line-opacity": ["*", ["get", "opacity"], 0.85] },
    });
    map.addLayer({
      id: "routes-solid",
      type: "line",
      source: "routes",
      filter: ["==", ["get", "road"], true],
      layout,
      paint: { "line-color": ["get", "color"], "line-width": lineWidth(2.5, 6), "line-opacity": ["get", "opacity"] },
    });
    map.addLayer({
      id: "routes-dashed",
      type: "line",
      source: "routes",
      filter: ["==", ["get", "road"], false],
      layout: { "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": lineWidth(2.5, 5), "line-opacity": ["get", "opacity"], "line-dasharray": [1.4, 1.6] },
    });
    map.addLayer({
      id: "routes-arrows",
      type: "symbol",
      source: "routes",
      minzoom: 7,
      layout: { "symbol-placement": "line", "symbol-spacing": 120, "icon-image": "route-arrow", "icon-size": 0.75, "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-opacity": ["get", "opacity"] },
    });
    map.addSource("anim", { type: "geojson", data: EMPTY, lineMetrics: true });
    map.addLayer({
      id: "anim-line",
      type: "line",
      source: "anim",
      layout,
      paint: { "line-width": lineWidth(4, 8), "line-gradient": gradient("#0ea5e9", 0) },
    });
  }

  // ---------- datos ----------

  function update(next) {
    data = { ...data, ...next };
    if (!map) return;
    applyRoutes();
    syncStopPins();
    renderPhotoPins();
    syncFriendPins();
  }

  function applyRoutes() {
    let source;
    try {
      source = map?.getSource("routes");
    } catch {
      return;
    }
    if (!source) return;
    source.setData({
      type: "FeatureCollection",
      features: data.routes.map((r) => ({
        type: "Feature",
        properties: { color: r.color, road: r.road, opacity: r.day === animHide ? 0.12 : data.activeDay && r.day !== data.activeDay ? 0.2 : 0.95 },
        geometry: { type: "LineString", coordinates: r.coords },
      })),
    });
    const visibility = data.layers.routes ? "visible" : "none";
    for (const id of ROUTE_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
  }

  function syncStopPins() {
    const want = new Map((data.layers.stops ? data.stops : []).map((s) => [s.id, s]));
    for (const [id, pin] of stopPins) {
      if (!want.has(id)) {
        pin.marker.remove();
        stopPins.delete(id);
      }
    }
    let i = 0;
    for (const stop of want.values()) {
      const sig = `${stop.category}|${stop.order}|${stop.color}`;
      let pin = stopPins.get(stop.id);
      if (!pin) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "pin";
        el.style.setProperty("--d", `${Math.min(i, 12) * 55}ms`);
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          onStop?.(el.dataset.id);
        });
        pin = { el, sig: "", marker: new (ML().Marker)({ element: el, anchor: "bottom" }).setLngLat([stop.lng, stop.lat]).addTo(map) };
        stopPins.set(stop.id, pin);
      }
      if (pin.sig !== sig) {
        pin.sig = sig;
        pin.el.style.setProperty("--c", stop.color);
        pin.el.innerHTML = `<span class="pin-body"><svg viewBox="0 0 40 50" width="40" height="50" aria-hidden="true"><path d="M20 48C20 48 4 32 4 19a16 16 0 0 1 32 0c0 13-16 29-16 29z"/></svg><span class="pin-emoji">${categoryOf(stop.category).emoji}</span></span><span class="pin-n">${stop.order}</span>`;
      }
      pin.el.dataset.id = stop.id;
      pin.el.title = stop.title;
      pin.el.setAttribute("aria-label", stop.title);
      pin.marker.setLngLat([stop.lng, stop.lat]);
      pin.el.classList.toggle("is-dim", Boolean(data.activeDay) && stop.day !== data.activeDay);
      pin.el.classList.toggle("is-active", stop.id === data.selected);
      i++;
    }
  }

  // Viajeros que comparten su ubicación: círculo con su inicial y cuánto hace de la última posición.
  const ago = (iso) => {
    const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    return min < 1 ? "ahora" : `hace ${min} min`;
  };
  const hue = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  function syncFriendPins() {
    const want = new Map((data.layers.friends === false ? [] : data.friends ?? []).map((f) => [f.user_id, f]));
    for (const [id, pin] of friendPins) {
      if (!want.has(id)) {
        pin.marker.remove();
        friendPins.delete(id);
      }
    }
    for (const friend of want.values()) {
      let pin = friendPins.get(friend.user_id);
      if (!pin) {
        const el = document.createElement("div");
        el.className = "friend";
        el.innerHTML = `<span class="friend-dot"></span><span class="friend-tag"></span>`;
        pin = { el, marker: new (ML().Marker)({ element: el, anchor: "top", offset: [0, -18] }).setLngLat([friend.lng, friend.lat]).addTo(map) };
        friendPins.set(friend.user_id, pin);
      }
      const name = friend.name || "Viajero";
      pin.el.style.setProperty("--h", hue(name));
      pin.el.querySelector(".friend-dot").textContent = name.charAt(0).toUpperCase();
      pin.el.querySelector(".friend-tag").textContent = `${name} · ${ago(friend.updated_at)}`;
      pin.marker.setLngLat([friend.lng, friend.lat]);
    }
  }

  // Miniaturas de fotos: se agrupan en celdas de pantalla, así que al alejar el mapa se juntan
  // (con contador) y al acercarlo se separan.
  function renderPhotoPins() {
    if (!map) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const cells = new Map();
    for (const photo of data.layers.photos ? data.photos : []) {
      const pt = map.project([photo.lng, photo.lat]);
      if (pt.x < -PHOTO_CELL || pt.y < -PHOTO_CELL || pt.x > w + PHOTO_CELL || pt.y > h + PHOTO_CELL) continue;
      const key = `${Math.floor(pt.x / PHOTO_CELL)}:${Math.floor(pt.y / PHOTO_CELL)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(photo);
    }
    const groups = [...cells.values()].slice(0, MAX_PHOTO_PINS);
    const keep = new Set(groups.map((g) => g[0].id));
    for (const [id, pin] of photoPins) {
      if (!keep.has(id)) {
        pin.marker.remove();
        photoPins.delete(id);
      }
    }
    for (const group of groups) {
      const rep = group[0]; // la primera es la más reciente (app.js ordena así)
      let pin = photoPins.get(rep.id);
      if (!pin) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "photo-pin";
        el.innerHTML = `<span class="photo-pin-body"><img alt="" decoding="async"><span class="photo-count" hidden></span></span>`;
        if (rep.thumb_url) el.querySelector("img").src = rep.thumb_url;
        el.setAttribute("aria-label", "Ver foto");
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          const members = pin.group;
          if (members.length === 1 || map.getZoom() >= 16.5) return onPhoto?.(members[0].id);
          const bounds = members.reduce((b, p) => b.extend([p.lng, p.lat]), new (ML().LngLatBounds)([members[0].lng, members[0].lat], [members[0].lng, members[0].lat]));
          map.fitBounds(bounds, { padding: 90, maxZoom: 17, duration: reducedMotion() ? 0 : 700 });
        });
        pin = { el, group, marker: new (ML().Marker)({ element: el }).setLngLat([rep.lng, rep.lat]).addTo(map) };
        photoPins.set(rep.id, pin);
      }
      pin.group = group;
      const lng = group.reduce((s, p) => s + p.lng, 0) / group.length;
      const lat = group.reduce((s, p) => s + p.lat, 0) / group.length;
      pin.marker.setLngLat([lng, lat]);
      const count = pin.el.querySelector(".photo-count");
      count.hidden = group.length < 2;
      count.textContent = `+${group.length - 1}`;
      pin.el.classList.toggle("is-active", group.some((p) => p.id === data.selectedPhoto));
    }
  }

  // ---------- cámara ----------

  function padding() {
    const h = container.clientHeight;
    const w = container.clientWidth;
    return { top: Math.min(130, h * 0.2), bottom: Math.min(290, h * 0.42), left: Math.min(40, w * 0.1), right: Math.min(70, w * 0.15) };
  }

  function fit(coords, { maxZoom = 15, duration } = {}) {
    if (!map || !coords.length) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new (ML().LngLatBounds)(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: padding(), maxZoom, duration: duration ?? (reducedMotion() ? 0 : 1100) });
  }

  function flyTo(lat, lng, zoom = 14) {
    if (!map) return;
    map.flyTo({ center: [lng, lat], zoom, padding: { bottom: 170 }, duration: reducedMotion() ? 0 : 1300, curve: 1.5, essential: true });
  }

  function resize() {
    map?.resize();
  }

  function setTheme(next) {
    if (!map || next === theme) return;
    theme = next;
    // Sin `diff`: así el estilo se recarga entero y se vuelve a emitir "style.load", que reañade rutas y flechas
    // (con el modo por diferencias MapLibre borra las capas propias y no avisa).
    map.setStyle(config.map.styles[theme], { diff: false });
  }

  // ---------- animaciones de ruta ----------

  function animate(duration, step, token, easing = ease) {
    return new Promise((resolve) => {
      if (duration <= 0) {
        step(1);
        return resolve();
      }
      const start = performance.now();
      const frame = (now) => {
        if (token !== animToken) return resolve();
        const p = Math.min(1, (now - start) / duration);
        step(easing(p));
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  function clearAnim() {
    try {
      map?.getSource("anim")?.setData(EMPTY);
    } catch {
      /* el estilo se está recargando */
    }
  }

  function cleanupPlayback() {
    runner?.remove();
    runner = null;
    animHide = null;
    clearAnim();
    applyRoutes();
    if (playing) {
      playing = false;
      onPlayEnd?.();
      onPlayEnd = null;
    }
  }

  function stopPlayback() {
    animToken++;
    cleanupPlayback();
  }

  // Dibuja la ruta de un día "creciendo" desde su inicio.
  async function drawIn(coords, color, day) {
    if (!map || reducedMotion() || coords.length < 2 || !map.getSource("anim")) return;
    stopPlayback();
    const token = ++animToken;
    animHide = day;
    applyRoutes();
    map.getSource("anim").setData(lineFeature(coords));
    await animate(1200, (p) => map.setPaintProperty("anim-line", "line-gradient", gradient(color, p)), token);
    if (token !== animToken) return;
    animHide = null;
    applyRoutes();
    clearAnim();
  }

  function pulse(id) {
    const pin = stopPins.get(id);
    if (!pin) return;
    pin.el.classList.remove("is-hit");
    void pin.el.offsetWidth;
    pin.el.classList.add("is-hit");
    setTimeout(() => pin.el.classList.remove("is-hit"), 1500);
  }

  // Recorre las rutas con un coche que avanza mientras la línea se va coloreando.
  // segments: [{ day, color, coords, stops: [{ id, lat, lng }] }]
  async function play(segments, hooks = {}) {
    if (!map || !segments.length || !map.getSource("anim")) return false;
    stopPlayback();
    const token = ++animToken;
    playing = true;
    onPlayEnd = hooks.onEnd ?? null;
    const car = document.createElement("div");
    car.className = "runner";
    car.innerHTML = "<span>🚗</span>";
    runner = new (ML().Marker)({ element: car }).setLngLat(segments[0].coords[0]).addTo(map);

    for (const seg of segments) {
      if (token !== animToken) return true;
      hooks.onSegment?.(seg);
      animHide = seg.day;
      applyRoutes();
      fit(seg.coords);
      await sleep(reducedMotion() ? 0 : 1300);
      if (token !== animToken) return true;

      map.getSource("anim").setData(lineFeature(seg.coords));
      runner.setLngLat(seg.coords[0]);
      const cum = cumulative(seg.coords);
      const total = cum[cum.length - 1] || 1;
      const reach = (seg.stops ?? []).map((s) => ({ id: s.id, at: cum[nearestIndex(seg.coords, s)] / total, done: false }));
      const duration = reducedMotion() ? 0 : Math.min(15000, Math.max(3500, total * 30));
      await animate(
        duration,
        (p) => {
          map.setPaintProperty("anim-line", "line-gradient", gradient(seg.color, p));
          runner?.setLngLat(pointAt(seg.coords, cum, p * total));
          for (const r of reach) {
            if (!r.done && p >= r.at) {
              r.done = true;
              pulse(r.id);
              hooks.onStop?.(r.id);
            }
          }
        },
        token,
        (p) => p,
      );
      if (token !== animToken) return true;
      await sleep(reducedMotion() ? 0 : 700);
    }
    if (token === animToken) cleanupPlayback();
    return true;
  }

  // ---------- elegir un punto tocando el mapa ----------

  function pick() {
    cancelPick();
    container.classList.add("is-picking");
    return new Promise((resolve) => {
      picking = { resolve };
    });
  }

  function cancelPick() {
    if (picking) {
      const { resolve } = picking;
      picking = null;
      resolve(null);
    }
    container.classList.remove("is-picking");
  }

  function setupLongPress() {
    let timer = null;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    const start = (e) => {
      if (picking || e.points?.length > 1) return;
      cancel();
      const { lat, lng } = e.lngLat;
      timer = setTimeout(() => {
        timer = null;
        onLongPress?.({ lat, lng });
      }, 650);
    };
    map.on("mousedown", start);
    map.on("touchstart", start);
    for (const type of ["mouseup", "touchend", "touchcancel", "movestart", "zoomstart"]) map.on(type, cancel);
    map.on("contextmenu", (e) => {
      if (!picking) onLongPress?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
  }

  // ---------- mi ubicación ----------

  function locate({ onError, onPosition } = {}) {
    if (!map || watchId != null) return;
    if (!navigator.geolocation) return onError?.(new Error("Este navegador no puede obtener la ubicación."));
    let first = true;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lngLat = [pos.coords.longitude, pos.coords.latitude];
        lastMe = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        onPosition?.(lastMe);
        if (!meMarker) {
          const el = document.createElement("div");
          el.className = "me";
          el.innerHTML = "<span></span>";
          meMarker = new (ML().Marker)({ element: el }).setLngLat(lngLat).addTo(map);
        } else meMarker.setLngLat(lngLat);
        if (first) {
          first = false;
          map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), 14), duration: reducedMotion() ? 0 : 1000 });
        }
      },
      (err) => {
        // Si te quedas quieto o pierdes señal un rato el navegador avisa con un "tiempo agotado": no es un fallo grave.
        if (err.code !== 1) return console.warn("Mi ubicación:", err.message);
        stopLocate();
        onError?.(new Error(geolocationMessage(err)));
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
  }

  function stopLocate() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    meMarker?.remove();
    meMarker = null;
  }

  return {
    init,
    update,
    fit,
    flyTo,
    resize,
    setTheme,
    drawIn,
    play,
    stopPlayback,
    pick,
    cancelPick,
    locate,
    stopLocate,
    isLocating: () => watchId != null,
    isPlaying: () => playing,
    myPosition: () => lastMe,
    center: () => {
      const c = map?.getCenter();
      return c ? { lat: c.lat, lng: c.lng } : null;
    },
    error: () => failure,
    ready: () => Boolean(map),
  };
}
