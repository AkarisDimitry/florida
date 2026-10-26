// Arrastrar un mensaje del chat hacia un lado para responderlo citándolo (como en WhatsApp). El mensaje sigue al dedo con un poco de
// resistencia, aparece una flecha ↩ detrás y, al soltar pasado el umbral, se llama a `onReply(id)`. Solo con el dedo o el lápiz: con el
// ratón no (arrastrar seleccionaría texto); en el ordenador está el botón «Responder» de cada mensaje.
//
// Cómo no estorba al desplazamiento: los mensajes llevan `touch-action: pan-y`, así que el navegador sigue haciendo el scroll vertical él
// solo y a nosotros solo nos llegan los movimientos horizontales; si el gesto es más vertical que horizontal se abandona al instante.
const LOCK_PX = 10; // cuánto hay que moverse para decidir si es un arrastre horizontal
const TRIGGER_PX = 64; // cuánto hay que arrastrar (con el dedo) para que cuente como «responder»
const MAX_SHIFT = 72; // lo máximo que se desplaza el mensaje
const NOT_FROM = "audio, input, textarea, select, a, [data-chat=goto], [data-emoji-pick]"; // arrastrar desde aquí no responde

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function initSwipeReply(list, { canReply, onReply }) {
  let drag = null;
  let blockClickUntil = 0;

  function finish(fire) {
    const d = drag;
    drag = null;
    if (!d) return;
    try {
      d.row.releasePointerCapture?.(d.pointer);
    } catch {
      /* ya soltado */
    }
    if (!d.locked) return;
    blockClickUntil = Date.now() + 350; // el dedo que se levanta al final de un arrastre no cuenta como toque en un botón
    const { row, icon } = d;
    row.classList.remove("is-dragging");
    row.style.transition = reduced() ? "none" : "transform 0.18s ease-out";
    row.style.transform = "";
    setTimeout(() => {
      row.style.transition = "";
      icon.remove();
    }, 200);
    if (fire && d.armed) onReply(d.id);
  }

  list.addEventListener("pointerdown", (event) => {
    if (drag || event.pointerType === "mouse" || !event.isPrimary) return;
    const row = event.target.closest?.(".cmsg");
    if (!row || event.target.closest(NOT_FROM) || !canReply(row.dataset.mid)) return;
    drag = { row, id: row.dataset.mid, pointer: event.pointerId, x: event.clientX, y: event.clientY, locked: false, armed: false, icon: null, dir: 0 };
  });

  list.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.locked) {
      if (Math.abs(dy) > LOCK_PX && Math.abs(dy) > Math.abs(dx) * 0.7) {
        drag = null; // es un desplazamiento vertical: el navegador se encarga
        return;
      }
      if (Math.abs(dx) < LOCK_PX || Math.abs(dx) < Math.abs(dy) * 1.4) return; // todavía no está claro
      drag.locked = true;
      drag.dir = Math.sign(dx);
      drag.row.classList.add("is-dragging");
      try {
        drag.row.setPointerCapture?.(drag.pointer);
      } catch {
        /* sin captura: se sigue con los eventos de la lista */
      }
      const icon = document.createElement("span");
      icon.className = `cswipe-ico is-${drag.dir > 0 ? "left" : "right"}`;
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "↩";
      drag.row.append(icon);
      drag.icon = icon;
    }
    // Solo cuenta lo que se arrastra hacia el lado en que empezó.
    const pull = Math.max(0, dx * drag.dir);
    const shift = Math.min(MAX_SHIFT, pull * 0.8);
    const progress = Math.min(1, pull / TRIGGER_PX);
    drag.row.style.transform = `translateX(${drag.dir * shift}px)`;
    drag.icon.style.opacity = String(progress);
    drag.icon.style.setProperty("--p", String(progress));
    const armed = pull >= TRIGGER_PX;
    if (armed !== drag.armed) {
      drag.armed = armed;
      drag.icon.classList.toggle("is-armed", armed);
      if (armed) {
        try {
          navigator.vibrate?.(12);
        } catch {
          /* sin vibración */
        }
      }
    }
    event.preventDefault?.();
  });

  list.addEventListener("pointerup", (event) => drag && event.pointerId === drag.pointer && finish(true));
  list.addEventListener("pointercancel", (event) => drag && event.pointerId === drag.pointer && finish(false));
  // Un arrastre no debe pulsar el botón sobre el que terminó el dedo.
  list.addEventListener(
    "click",
    (event) => {
      if (Date.now() < blockClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
}
