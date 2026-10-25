-- Quién está en línea (presencia entre viajeros). Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql
-- (solo necesita `members` y `is_member()`; no depende de ningún otro archivo). Una sola vez.
--
-- Mientras tiene la web abierta, cada cliente envía un "latido" cada ~45 s (un upsert de SU fila: user_id y name) y
-- el servidor anota la hora en `last_seen`. Un viajero se considera "en línea" si su último latido tiene menos de
-- ~100 s; si no, se muestra "visto hace X". Quien no quiera aparecer borra su propia fila.
-- Una sola fila por persona, que se va sobrescribiendo (igual que public.live_locations en vivo.sql).
--
-- No se usa Realtime Presence de Supabase porque sus canales públicos son accesibles con la clave pública
-- (la anon key va dentro de la web): cualquiera podría ver quién está conectado. Aquí la lista pasa por RLS y solo
-- la leen los viajeros autorizados.
--
-- Esta tabla NO se añade a la publicación `supabase_realtime`, a propósito: el cliente consulta la lista cada ~30 s y
-- cada persona escribe cada ~45 s; con Realtime, cada latido de cada viajero dispararía un evento a todos los demás.
--
-- Para eliminar del todo las filas viejas (opcional):
--   delete from public.presence where last_seen < now() - interval '30 days';

create table public.presence (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text check (char_length(name) <= 40),
  last_seen timestamptz not null default now()
);

-- La hora la pone siempre el servidor: nadie puede falsear que está en línea (ni que lo estuvo hace un momento).
create or replace function public.touch_presence()
returns trigger language plpgsql as $$
begin
  new.last_seen = now();
  return new;
end;
$$;

create trigger presence_touch
  before insert or update on public.presence
  for each row execute function public.touch_presence();

-- Permisos mínimos. Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo
-- los necesarios. `last_seen` no es escribible por el cliente (la pone el disparador; el valor por defecto de la
-- columna no necesita permiso de INSERT).
-- El cliente hace el latido con un upsert (PostgREST: INSERT ... ON CONFLICT (user_id) DO UPDATE SET
-- user_id = excluded.user_id, name = excluded.name), así que necesita UPDATE sobre `user_id` y `name`; las políticas
-- con `with check (user_id = auth.uid())` impiden usarlo para cambiar la fila a otro usuario.
revoke all on public.presence from anon, authenticated;
grant select, delete on public.presence to authenticated;
grant insert (user_id, name) on public.presence to authenticated;
grant update (user_id, name) on public.presence to authenticated;
alter table public.presence enable row level security;

-- Los viajeros autorizados ven a todos; cada uno solo escribe su propia fila.
-- Cada uno puede ver además SU fila aunque ya no sea viajero: hace falta para que pueda borrarla. Un DELETE con
-- WHERE (el de PostgREST/supabase-js siempre lo lleva) solo alcanza las filas que la política de lectura deja ver;
-- si la lectura exigiera ser viajero, `presence_delete` de abajo no borraría nada a quien ya no lo es (0 filas, sin
-- error). Lo único que ve alguien que no es viajero es su propia fila: nunca la de otros.
create policy presence_select on public.presence
  for select to authenticated
  using (public.is_member() or user_id = auth.uid());
create policy presence_insert on public.presence
  for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
create policy presence_update on public.presence
  for update to authenticated
  using (public.is_member() and user_id = auth.uid())
  with check (public.is_member() and user_id = auth.uid());
-- Borrar su fila (dejar de aparecer) no exige ser viajero, para que quien ya no lo sea pueda borrar su rastro.
create policy presence_delete on public.presence
  for delete to authenticated
  using (user_id = auth.uid());
