-- Extras: reparto de gastos, lista de la maleta y pies de foto.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql, fotos.sql y mapa.sql (usa public.is_member(),
-- public.touch_updated_at(), public.activities y public.photos con su política photos_update). Una sola vez.
-- No depende de vivo.sql.
--
-- Contenido:
--   1. public.expenses         gastos y reparto entre viajeros (los "viajeros" son nombres de texto libre).
--   2. public.checklist_items  lista de la maleta compartida.
--   3. public.photos.caption   pie de foto (lo edita solo quien subió la foto).
--   4. Tiempo real para las dos tablas nuevas.

-- ---------- función auxiliar: lista de nombres válida ----------

-- Los CHECK no admiten subconsultas, así que la validación de `split` vive en una función `immutable`:
-- una lista de una dimensión, de 1 a 30 nombres, ninguno nulo y cada uno de 1 a 40 caracteres.
create or replace function public.names_ok(names text[])
returns boolean
language sql immutable parallel safe set search_path = ''
as $$
  select names is not null
    and coalesce(array_ndims(names), 0) = 1
    and cardinality(names) between 1 and 30
    and not exists (
      select 1 from unnest(names) as n where n is null or char_length(n) not between 1 and 40
    );
$$;
-- Igual que is_member(): anon no la ejecuta. `authenticated` sí necesita EXECUTE, porque Postgres comprueba ese
-- permiso con el rol que inserta o actualiza cuando evalúa el CHECK (sin él, el INSERT falla con "permission denied").
revoke all on function public.names_ok(text[]) from public, anon;
grant execute on function public.names_ok(text[]) to authenticated;

-- ---------- gastos ----------

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  -- `amount > 0` por sí solo deja pasar 'NaN' (numeric lo ordena por encima de todo), de ahí el segundo término.
  amount numeric(10, 2) not null check (amount > 0 and amount <> 'NaN'),
  day date not null,
  paid_by text not null check (char_length(paid_by) between 1 and 40),   -- quién pagó
  split text[] not null check (public.names_ok(split)),                  -- entre quiénes se reparte
  activity_id uuid references public.activities (id) on delete set null, -- opcional: actividad a la que pertenece
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index expenses_day_idx on public.expenses (day);

create trigger expenses_touch_updated_at
  before update on public.expenses
  for each row execute function public.touch_updated_at();

-- ---------- lista de la maleta ----------

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) between 1 and 120),
  done boolean not null default false,
  assigned_to text check (char_length(assigned_to) <= 40), -- null = "lo llevamos entre todos"
  done_by_name text check (char_length(done_by_name) <= 40),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now()
);

-- ---------- permisos y RLS ----------

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
-- UPDATE se concede por columnas: no se pueden cambiar `id`, `created_by`, `created_at` ni `updated_at`
-- (esta última la pone el disparador).
revoke all on public.expenses, public.checklist_items from anon, authenticated;
grant select, insert, delete on public.expenses to authenticated;
grant update (title, amount, day, paid_by, split, activity_id) on public.expenses to authenticated;
grant select, insert, delete on public.checklist_items to authenticated;
grant update (text, done, assigned_to, done_by_name) on public.checklist_items to authenticated;

alter table public.expenses enable row level security;
alter table public.checklist_items enable row level security;

-- Igual que las actividades: cualquier viajero puede ver, añadir, editar y borrar (también lo que creó otro).
create policy expenses_select on public.expenses
  for select to authenticated using (public.is_member());
create policy expenses_insert on public.expenses
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());
create policy expenses_update on public.expenses
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy expenses_delete on public.expenses
  for delete to authenticated using (public.is_member());

-- Lo mismo para la maleta.
create policy checklist_select on public.checklist_items
  for select to authenticated using (public.is_member());
create policy checklist_insert on public.checklist_items
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());
create policy checklist_update on public.checklist_items
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy checklist_delete on public.checklist_items
  for delete to authenticated using (public.is_member());

-- ---------- fotos: pie de foto ----------

alter table public.photos
  add column caption text check (char_length(caption) <= 200);

-- Solo se concede la columna nueva (lat y lng ya están concedidas por mapa.sql). La política photos_update de
-- mapa.sql (using y with check: is_member() y created_by = auth.uid()) filtra por fila, no por columna, así que
-- ya limita este permiso a las fotos propias: no hace falta tocarla.
grant update (caption) on public.photos to authenticated;

-- ---------- tiempo real ----------

-- (photos ya está en la publicación: los cambios de pie de foto llegan por ahí.)
alter publication supabase_realtime add table public.expenses, public.checklist_items;
