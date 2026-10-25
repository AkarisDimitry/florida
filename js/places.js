// Datos automáticos de los lugares: ciudad de cada día (Nominatim) y curiosidades cercanas (Wikipedia).
// Los resultados se guardan en el navegador: las consultas se hacen una sola vez por zona.
import { read, persist } from "./state.js";
import { reverseCity } from "./geo.js";

const KEY = "viaje.lugares";
const cache = read(KEY, {});
const cell = (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`;
const save = (key, value) => {
  cache[key] = value;
  persist(KEY, cache);
  return value;
};

export async function cityName(lat, lng) {
  const key = `c:${cell(lat, lng)}`;
  if (key in cache) return cache[key];
  const name = await reverseCity(lat, lng);
  return name ? save(key, name) : null; // si falla no se guarda: se reintenta otro día
}

// Hasta `limit` artículos de Wikipedia (en español) cerca de unas coordenadas.
export async function nearbyWiki(lat, lng, limit = 3) {
  const key = `w:${cell(lat, lng)}:${limit}`;
  if (cache[key]) return cache[key];
  for (const radius of [2500, 9000]) {
    const url = new URL("https://es.wikipedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query", generator: "geosearch", ggscoord: `${lat}|${lng}`, ggsradius: String(radius), ggslimit: String(limit),
      prop: "extracts|pageimages", exintro: "1", explaintext: "1", exchars: "240", piprop: "thumbnail", pithumbsize: "240",
      format: "json", formatversion: "2", origin: "*",
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Wikipedia respondió ${response.status}`);
    const pages = (await response.json()).query?.pages ?? [];
    if (!pages.length) continue;
    return save(
      key,
      pages
        .sort((a, b) => a.index - b.index)
        .map((p) => ({
          title: p.title,
          extract: (p.extract ?? "").replace(/\s+/g, " ").trim(),
          url: `https://es.wikipedia.org/wiki/${encodeURIComponent(p.title.replaceAll(" ", "_"))}`,
          thumb: p.thumbnail?.source ?? null,
        })),
    );
  }
  return save(key, []);
}
