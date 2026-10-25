// Gastos y compras con ubicación en el mapa: un marcador (💸 gasto, 🛒 compra) en el sitio donde se pagó y, al tocarlo, una tarjeta con el
// concepto, el importe, quién pagó y el día. Se enciende y apaga con el interruptor «Gastos» de las capas. map.js solo llama a sync().
import { state } from "./state.js";
import { esc, money, utc, capitalize, fmtDayShort, hasCoords, reducedMotion } from "./util.js";
import { isValid } from "./ledger.js";
import { categoryOf, categoryInfo } from "./categorias.js";

const ML = () => window.maplibregl;
// El marcador se dibuja un poco abajo y a la derecha del punto (offset): así no tapa el pin del lugar ni la miniatura de la foto que suele haber justo ahí.
const MAX_PINS = 80;

// Los gastos que se pueden poner en el mapa (con importe, pagador y reparto válidos, y con ubicación).
export const mapExpenses = () => state.expenses.filter((e) => isValid(e) && hasCoords(e));

const emojiOf = (e) => (e.kind === "compra" ? "🛒" : "💸");
// Gastos a menos de ~10 m se juntan en un solo marcador (con contador) y la tarjeta los lista todos.
const cellOf = (e) => `${e.lat.toFixed(4)},${e.lng.toFixed(4)}`;
const day = (iso) => capitalize(fmtDayShort.format(utc(iso)));

function cardHtml(list) {
  const total = list.reduce((s, e) => s + Math.round(Number(e.amount) * 100), 0);
  const head = list.length === 1 ? (list[0].kind === "compra" ? "🛒 Compra" : "💸 Gasto") : `💸 ${list.length} apuntes aquí · ${money.format(total / 100)}`;
  const item = (e) => {
    const c = categoryInfo(categoryOf(e));
    return `<li><button type="button" class="gasto-item" data-id="${esc(e.id)}" aria-label="Abrir: ${esc(e.title)}">
      <span class="gasto-line"><strong>${esc(e.title)}</strong><b>${esc(money.format(Number(e.amount)))}</b></span>
      <small>Pagó ${esc(e.paid_by)} · ${esc(day(e.day))} · ${c.emoji} ${esc(c.label)}${e.place ? ` · ${esc(e.place)}` : ""}</small>
    </button></li>`;
  };
  return `<div class="gasto-card"><p class="gasto-head">${head}</p><ul>${list.map(item).join("")}</ul><button type="button" class="btn small ghost gasto-close" data-close-card>Cerrar</button></div>`;
}

export function createExpensePins(container) {
  const pins = new Map(); // celda -> { el, marker, sig }
  let popup = null;

  function closeCard() {
    popup?.remove();
    popup = null;
  }

  function openCard(map, list) {
    closeCard();
    const first = list[0];
    popup = new (ML().Popup)({ closeButton: false, closeOnClick: true, focusAfterOpen: false, anchor: "bottom", maxWidth: "300px", offset: 26, className: `gasto-popup cat-${categoryOf(first)}` })
      .setLngLat([first.lng, first.lat])
      .setHTML(cardHtml(list))
      .addTo(map);
    const el = popup.getElement();
    el.addEventListener("click", async (event) => {
      if (event.target.closest("[data-close-card]")) return closeCard();
      const id = event.target.closest("[data-id]")?.dataset.id;
      if (!id) return;
      closeCard();
      const { openExpense } = await import("./expensedialog.js"); // se carga al usarlo (evita un ciclo con el diálogo)
      openExpense({ id });
    });
    popup.on("close", () => {
      if (popup?.getElement() === el) popup = null;
    });
    // El marcador baja un poco del centro del mapa: la tarjeta (que sale encima) queda a la vista, sin chocar con los botones de arriba ni con la hoja de lugares.
    map.easeTo({ center: [first.lng, first.lat], offset: [0, Math.min(110, container.clientHeight * 0.15)], duration: reducedMotion() ? 0 : 350 });
  }

  function sync(map, show) {
    if (!map) return;
    const groups = new Map();
    if (show) {
      for (const e of mapExpenses()) {
        const key = cellOf(e);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
    }
    const wanted = [...groups].slice(0, MAX_PINS);
    const keep = new Set(wanted.map(([key]) => key));
    for (const [key, pin] of pins) {
      if (!keep.has(key)) {
        pin.marker.remove();
        pins.delete(key);
      }
    }
    if (!show || !groups.size) closeCard();
    for (const [key, list] of wanted) {
      const first = list[0];
      const sig = list.map((e) => `${e.id}:${e.amount}:${e.title}:${e.paid_by}:${e.day}:${e.kind}:${e.category}:${e.place}`).join("|");
      let pin = pins.get(key);
      if (!pin) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "gasto-pin";
        pin = { el, sig: "", list, marker: new (ML().Marker)({ element: el, anchor: "center", offset: [15, 15] }).setLngLat([first.lng, first.lat]).addTo(map) };
        el.addEventListener("click", (event) => {
          event.stopPropagation(); // el clic no llega al mapa (que lo usa para elegir un punto o cerrar la tarjeta)
          openCard(map, pin.list);
        });
        pins.set(key, pin);
      }
      pin.list = list;
      pin.marker.setLngLat([first.lng, first.lat]);
      if (pin.sig !== sig) {
        pin.sig = sig;
        pin.el.className = `gasto-pin cat-${categoryOf(first)}`;
        pin.el.innerHTML = `<span aria-hidden="true">${emojiOf(first)}</span>${list.length > 1 ? `<i class="gasto-count">${list.length}</i>` : ""}`;
        pin.el.setAttribute("aria-label", list.length === 1 ? `${first.kind === "compra" ? "Compra" : "Gasto"}: ${first.title}, ${money.format(Number(first.amount))}` : `${list.length} gastos en este sitio`);
        pin.el.title = list.length === 1 ? `${first.title} · ${money.format(Number(first.amount))}` : `${list.length} gastos aquí`;
      }
    }
  }

  return { sync, closeCard };
}
