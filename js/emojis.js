// Emojis: los 12 que se pueden usar como reacción (tienen que ser EXACTAMENTE los de la restricción de supabase/reacciones.sql; una
// prueba lo comprueba) y un selector de emojis para escribir comentarios y mensajes. Sin estado ni dependencias del resto de la web.

export const REACTION_EMOJIS = ["❤️", "👍", "😂", "😮", "😢", "🔥", "🙏", "👏", "🎉", "😍", "🤔", "👎"];

export const EMOJI_GROUPS = [
  ["Caras", ["😀", "😁", "😂", "🤣", "😊", "😍", "😘", "😎", "🤩", "🥳", "😅", "😉", "🙂", "🙃", "😋", "😜", "🤔", "😴", "😮", "😢", "😭", "😡", "🥶", "🥵"]],
  ["Gestos", ["👍", "👎", "👏", "🙌", "🙏", "💪", "👌", "✌️", "🤞", "🤝", "👋", "🫶", "🤗", "🙈"]],
  ["Corazones", ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💕", "💖", "💯", "✨", "🔥", "🎉", "🎊"]],
  ["Viaje", ["☀️", "🌴", "🏖️", "🌊", "🐊", "🦩", "🚗", "✈️", "🧳", "🗺️", "📍", "📸", "🏨", "⛽", "🎢", "🏰"]],
  ["Comida", ["🍕", "🍔", "🌮", "🍟", "🍦", "🍩", "🍺", "🍹", "☕", "🥗", "🍓", "🍉"]],
];

const RECENT_KEY = "viaje.emojisRecientes";
const MAX_RECENT = 12;

export function recentEmojis() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((e) => typeof e === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmojis().filter((e) => e !== emoji)].slice(0, MAX_RECENT)));
  } catch {
    /* sin almacenamiento: solo se pierde la lista de recientes */
  }
}

const btn = (emoji, extra) => `<button type="button" class="emoji-btn" data-emoji-pick="${emoji}" ${extra} aria-label="Emoji ${emoji}">${emoji}</button>`;

// Panel con los emojis recientes y todos los grupos. `extra` son atributos que se copian a cada botón (por ejemplo data-key="…").
export function emojiPanelHtml(extra = "") {
  const recent = recentEmojis();
  return `<div class="emoji-panel" role="group" aria-label="Elegir un emoji">
    ${recent.length ? `<p class="emoji-title">Recientes</p><div class="emoji-grid">${recent.map((e) => btn(e, extra)).join("")}</div>` : ""}
    ${EMOJI_GROUPS.map(([name, list]) => `<p class="emoji-title">${name}</p><div class="emoji-grid">${list.map((e) => btn(e, extra)).join("")}</div>`).join("")}
  </div>`;
}

// Mete `text` en un campo de texto donde está el cursor (o al final) y deja el cursor detrás. Devuelve el texto nuevo.
export function insertAtCursor(input, text) {
  const value = input.value ?? "";
  const max = Number(input.maxLength);
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : value.length;
  let next = value.slice(0, start) + text + value.slice(end);
  if (Number.isFinite(max) && max > 0 && next.length > max) next = value; // no cabe: se deja como estaba
  if (next === value) return value;
  input.value = next;
  const caret = start + text.length;
  try {
    input.setSelectionRange(caret, caret);
  } catch {
    /* campos sin selección */
  }
  return next;
}
