// Panel del administrador: solicitudes de acceso pendientes (aprobar o rechazar), añadir viajeros por correo y quitarlos.
// Solo se abre si state.isAdmin; las operaciones las hace la base de datos con funciones que vuelven a comprobarlo.
import { state, ctx } from "./state.js";
import { icon } from "./icons.js";
import { $, esc, guarded, toast, schemaHint, fmtStamp, safeFormat } from "./util.js";
import { hueOf } from "./ledger.js";

const dialog = $("#access-dialog");
let members = null; // null = cargando

const dot = (text) => `<span class="person-dot" style="--h:${hueOf(text)}" aria-hidden="true">${esc(String(text).charAt(0).toUpperCase())}</span>`;

function requestRow(r, { denied = false } = {}) {
  const when = safeFormat(fmtStamp, r.created_at);
  return `<li class="req">${dot(r.name || r.email)}
    <div class="req-text"><strong>${esc(r.name || r.email)}</strong><small>${esc(r.name ? `${r.email} · ` : "")}${esc(when)}</small></div>
    <div class="req-actions">
      <button type="button" class="btn small primary" data-approve="${esc(r.email)}">${icon("check", 15)} Aprobar</button>
      ${denied ? "" : `<button type="button" class="btn small" data-deny="${esc(r.email)}">Rechazar</button>`}
    </div></li>`;
}

export function renderAccess() {
  const pending = state.requests.filter((r) => r.status === "pending");
  const denied = state.requests.filter((r) => r.status === "denied");
  const list = (items, empty) => (items.length ? `<ul class="reqs">${items.join("")}</ul>` : `<p class="hint">${empty}</p>`);
  $("#access-body").innerHTML = `
    <section><h3>Esperan tu aprobación <span class="count">${pending.length}</span></h3>
      ${list(pending.map((r) => requestRow(r)), "Nadie está esperando. Quien entre con su correo y no esté en la lista podrá pedir acceso, y lo verás aquí.")}</section>
    ${denied.length ? `<section><h3>Rechazadas <span class="count">${denied.length}</span></h3>${list(denied.map((r) => requestRow(r, { denied: true })), "")}</section>` : ""}
    <section><h3>Añadir por correo</h3>
      <form id="access-add" class="input-row"><input name="email" type="email" required maxlength="254" placeholder="amigo@correo.com" autocomplete="off" aria-label="Correo de la persona"><button class="btn primary small" type="submit">${icon("plus", 15)} Añadir</button></form>
      <p class="hint">Puede entrar directamente con ese correo, sin pedir acceso.</p></section>
    <section><h3>Viajeros ${members ? `<span class="count">${members.length}</span>` : ""}</h3>
      ${members === null ? `<p class="hint">Cargando…</p>` : list(members.map((m) => `<li class="req">${dot(m.email)}<div class="req-text"><strong>${esc(m.email)}</strong>${m.is_admin ? `<small>Administrador</small>` : ""}</div>${m.is_admin ? "" : `<div class="req-actions"><button type="button" class="btn small danger" data-remove="${esc(m.email)}">Quitar</button></div>`}</li>`), "Todavía no hay viajeros.")}</section>
    <p class="hint credits">No se avisa por correo: cuando alguien pida acceso verás un punto rojo en tu foto de perfil y un aviso arriba.</p>`;
}

async function loadMembers() {
  try {
    members = await ctx.store.listMembers();
  } catch (err) {
    members = [];
    throw schemaHint(err);
  }
}

export const refreshAccess = () => dialog.open && renderAccess();

export async function openAccess() {
  if (!state.isAdmin) return;
  members = null;
  renderAccess();
  dialog.showModal();
  await guarded(async () => {
    await loadMembers();
    renderAccess();
  })();
}

// Tras cada cambio: se vuelve a pedir todo y se repinta el panel.
async function changed(message) {
  await ctx.actions.refresh();
  await loadMembers().catch(() => {});
  renderAccess();
  if (message) toast(message, 3500);
}

export function initAccess() {
  $("#access-btn").addEventListener("click", () => {
    $("#data-dialog").close();
    openAccess();
  });
  $("#access-body").addEventListener(
    "click",
    guarded(async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const { approve, deny, remove } = button.dataset;
      try {
        if (approve) {
          await ctx.store.approveAccess(approve);
          await changed(`${approve} ya puede entrar`);
        } else if (deny) {
          await ctx.store.denyAccess(deny);
          await changed("Solicitud rechazada");
        } else if (remove) {
          if (!confirm(`¿Quitar a ${remove}? Dejará de ver el viaje; sus fotos y comentarios se quedan.`)) return;
          await ctx.store.removeMember(remove);
          await changed(`${remove} ya no tiene acceso`);
        }
      } catch (err) {
        throw schemaHint(err);
      }
    }),
  );
  $("#access-body").addEventListener(
    "submit",
    guarded(async (event) => {
      if (event.target.id !== "access-add") return;
      event.preventDefault();
      const email = event.target.elements.email.value.trim();
      try {
        await ctx.store.addMember(email);
      } catch (err) {
        throw schemaHint(err);
      }
      await changed(`${email.toLowerCase()} añadido`);
    }),
  );
}
