-- Ubicación en vivo entre viajeros (opcional). Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql.
--
-- Cada viajero que activa "Compartir mi ubicación" guarda aquí SU última posición (una sola fila por persona,
-- que se va sobrescribiendo). Solo la ven los viajeros autorizados y solo si tiene menos de 30 minutos, así que
-- una posición vieja deja de verse sola para los demás. Al dejar de compartir, la fila se borra.
-- Para eliminar del todo las posiciones viejas (opcional):
--   delete from public.live_locations where updated_at < now() - interval '1 day';

create table public.live_locations (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text check (char_length(name) <= 40),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy real check (accuracy >= 0),
  updated_at timestamptz not null default now()
);

-- La hora la pone siempre el servidor: nadie puede falsear que su posición es "reciente".
create or replace function public.touch_live_location()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger live_locations_touch
  before insert or update on public.live_locations
  for each row execute function public.touch_live_location();

revoke all on public.live_locations from anon, authenticated;
grant select, insert, update, delete on public.live_locations to authenticated;
alter table public.live_locations enable row level security;

-- Cada uno ve siempre la suya (hace falta para poder actualizarla o borrarla aunque haya caducado);
-- las de los demás, solo si tienen menos de 30 minutos.
create policy live_select on public.live_locations
  for select to authenticated
  using (public.is_member() and (user_id = auth.uid() or updated_at > now() - interval '30 minutes'));
create policy live_insert on public.live_locations
  for insert to authenticated
  with check (public.is_member() and user_id = auth.uid());
create policy live_update on public.live_locations
  for update to authenticated
  using (public.is_member() and user_id = auth.uid())
  with check (public.is_member() and user_id = auth.uid());
create policy live_delete on public.live_locations
  for delete to authenticated
  using (user_id = auth.uid());

alter publication supabase_realtime add table public.live_locations;
