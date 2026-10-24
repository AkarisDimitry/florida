-- Esquema de Supabase para la web del viaje.
-- Ejecutar completo, una sola vez, en Supabase → SQL Editor.
-- Modelo de acceso: solo pueden leer y escribir los correos listados en `members`.

-- ---------- viajeros autorizados ----------

create table public.members (
  email text primary key check (email = lower(email))
);
alter table public.members enable row level security;
-- Sin políticas ni permisos: la web no puede leer ni escribir `members`.
-- Se gestiona desde el SQL Editor o el Table Editor.
revoke all on public.members from anon, authenticated;

create or replace function public.is_member()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.members where email = lower(auth.jwt() ->> 'email'));
$$;
revoke all on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- Añadir viajeros (en minúsculas):
-- insert into public.members (email) values ('ana@ejemplo.com'), ('luis@ejemplo.com');

-- ---------- actividades ----------

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  start_time time,
  title text not null check (char_length(title) between 1 and 120),
  category text not null default 'otro'
    check (category in ('comida', 'visita', 'transporte', 'alojamiento', 'ocio', 'otro')),
  place text check (char_length(place) <= 200),
  cost numeric(10, 2) check (cost >= 0),
  notes text check (char_length(notes) <= 2000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger activities_touch_updated_at
  before update on public.activities
  for each row execute function public.touch_updated_at();

-- ---------- comentarios ----------

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now()
);
create index comments_activity_id_idx on public.comments (activity_id);

-- ---------- permisos y RLS ----------

revoke all on public.activities, public.comments from anon;
grant select, insert, update, delete on public.activities, public.comments to authenticated;

alter table public.activities enable row level security;
alter table public.comments enable row level security;

-- Cualquier viajero puede ver, añadir, editar y borrar actividades.
create policy activities_select on public.activities
  for select to authenticated using (public.is_member());
create policy activities_insert on public.activities
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());
create policy activities_update on public.activities
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy activities_delete on public.activities
  for delete to authenticated using (public.is_member());

-- Comentarios: todos leen y comentan; cada uno borra solo los suyos.
create policy comments_select on public.comments
  for select to authenticated using (public.is_member());
create policy comments_insert on public.comments
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());
create policy comments_delete on public.comments
  for delete to authenticated using (public.is_member() and created_by = auth.uid());

-- ---------- tiempo real ----------

alter publication supabase_realtime add table public.activities, public.comments;
