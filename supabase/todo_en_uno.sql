-- TODO EN UNO: schema + fotos + mapa + extras + acceso + vivo, en el orden correcto.
-- Pegar completo en Supabase -> SQL Editor y pulsar Run. Se puede repetir sin problema: cada parte solo se
-- aplica si falta (en la pestaña Messages/Results se ve cuáles se aplicaron y cuáles ya estaban).
-- Después, nombrar al primer administrador (imprescindible para aprobar solicitudes de acceso)
-- y, si quieres, autorizar ya a otros viajeros (ver docs/DESPLIEGUE.md):
--   insert into public.members (email, is_admin) values ('tu@correo.com', true)
--     on conflict (email) do update set is_admin = true;
--   insert into public.members (email) values ('amigo@correo.com') on conflict do nothing;
-- Generado con docs/generar_sql_todo_en_uno.sh a partir de los archivos sueltos de esta carpeta.

-- ======================================================================
-- schema.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.members') is null then
    raise notice 'Aplicando schema.sql...';
    execute $parte_schema$
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

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
revoke all on public.activities, public.comments from anon, authenticated;
grant select, insert, update, delete on public.activities to authenticated;
grant select, insert, delete on public.comments to authenticated; -- los comentarios no se editan

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
$parte_schema$;
  else
    raise notice 'schema.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- fotos.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.photos') is null then
    raise notice 'Aplicando fotos.sql...';
    execute $parte_fotos$
-- Fotos del viaje: tabla, almacén privado y permisos.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql (usa public.is_member()).
-- Las fotos se guardan en el bucket privado `photos`, en la carpeta del usuario que las sube:
--   <user_id>/<foto_id>.jpg      (versión grande, máx. 1600 px)
--   <user_id>/<foto_id>_t.jpg    (miniatura, máx. 400 px)

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  thumb_path text not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now()
);

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios
-- (mapa.sql añade después la actualización de la ubicación).
revoke all on public.photos from anon, authenticated;
grant select, insert, delete on public.photos to authenticated;
alter table public.photos enable row level security;

-- Todos los viajeros ven las fotos y suben las suyas; cada uno borra solo las suyas.
create policy photos_select on public.photos
  for select to authenticated using (public.is_member());
create policy photos_insert on public.photos
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());
create policy photos_delete on public.photos
  for delete to authenticated using (public.is_member() and created_by = auth.uid());

-- ---------- almacén de archivos ----------

-- Privado (se muestra con enlaces temporales), solo JPEG, máx. 5 MB por archivo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

create policy photos_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.is_member());

create policy photos_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

create policy photos_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- tiempo real ----------

alter publication supabase_realtime add table public.photos;
$parte_fotos$;
  else
    raise notice 'fotos.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- mapa.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'photos' and column_name = 'lat') then
    raise notice 'Aplicando mapa.sql...';
    execute $parte_mapa$
-- Mapa, rutas y valoraciones: columnas nuevas.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql y fotos.sql. Una sola vez.
--
-- Privacidad: las coordenadas de las fotos las ven todos los viajeros autorizados (nadie más).
-- Los archivos de imagen NO llevan ubicación: se les quita al subirlos; solo se guardan estas columnas.

-- ---------- actividades: lugar en el mapa y valoración ----------

alter table public.activities
  add column lat double precision,
  add column lng double precision,
  add column rating smallint;

alter table public.activities
  add constraint activities_lat_range check (lat between -90 and 90),
  add constraint activities_lng_range check (lng between -180 and 180),
  add constraint activities_latlng_pair check ((lat is null) = (lng is null)),
  add constraint activities_rating_range check (rating between 1 and 5);

-- ---------- fotos: dónde y cuándo se tomaron ----------

alter table public.photos
  add column lat double precision,
  add column lng double precision,
  add column taken_at timestamptz; -- hora de reloj de la cámara (EXIF), guardada tal cual como UTC

alter table public.photos
  add constraint photos_lat_range check (lat between -90 and 90),
  add constraint photos_lng_range check (lng between -180 and 180),
  add constraint photos_latlng_pair check ((lat is null) = (lng is null));

-- Cada viajero puede colocar, mover o quitar la ubicación de SUS fotos (y solo esas dos columnas).
grant update (lat, lng) on public.photos to authenticated;
create policy photos_update on public.photos
  for update to authenticated
  using (public.is_member() and created_by = auth.uid())
  with check (public.is_member() and created_by = auth.uid());
$parte_mapa$;
  else
    raise notice 'mapa.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- extras.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.expenses') is null then
    raise notice 'Aplicando extras.sql...';
    execute $parte_extras$
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
$parte_extras$;
  else
    raise notice 'extras.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- acceso.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.access_requests') is null then
    raise notice 'Aplicando acceso.sql...';
    execute $parte_acceso$
-- Solicitud de acceso con aprobación: administradores, solicitudes y gestión de viajeros.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql (usa public.members y auth.jwt()). Una sola vez.
-- No depende de fotos.sql, mapa.sql, extras.sql ni vivo.sql: se puede añadir a una base que ya los tenía.
--
-- Flujo: cualquiera puede iniciar sesión con su correo, pero solo los correos de `members` ven el viaje. Quien no
-- es viajero puede PEDIR ACCESO (public.request_access); los administradores ven las solicitudes pendientes y las
-- aprueban o rechazan (aprobar = añadir el correo a `members`), y también pueden añadir o quitar viajeros directamente.
--
-- Contenido:
--   1. public.members.is_admin   columna nueva (los clientes siguen sin poder leer ni escribir `members`).
--   2. public.is_admin()         ¿el correo de la sesión es de un administrador?
--   3. public.access_requests    solicitudes de acceso (lectura con RLS; NINGUNA escritura directa).
--   4. Funciones RPC             request_access, approve_access, deny_access, add_member, remove_member, list_members.
--
-- Primer administrador (imprescindible: sin él nadie puede aprobar solicitudes). En el SQL Editor, con tu correo en
-- minúsculas, UNA de estas dos:
--   update public.members set is_admin = true where email = 'tu@correo.com';        -- si ya es viajero
--   insert into public.members (email, is_admin) values ('tu@correo.com', true)     -- si todavía no está
--     on conflict (email) do update set is_admin = true;
-- Por diseño, nadie puede nombrar ni quitar administradores desde la web: se hace así, desde el SQL Editor.
--
-- Seguridad: el correo de quien pide acceso y de quien decide sale SIEMPRE del JWT firmado por Supabase Auth
-- (auth.jwt() ->> 'email'), nunca de un parámetro ni de user_metadata (que el usuario puede editar).

-- ---------- administradores ----------

-- Los clientes no tienen ningún permiso sobre `members` (schema.sql): la columna nueva tampoco se les concede.
alter table public.members
  add column is_admin boolean not null default false;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.members
    where email = lower(auth.jwt() ->> 'email') and is_admin
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- solicitudes de acceso ----------

create table public.access_requests (
  email text primary key check (email = lower(email) and char_length(email) <= 254),
  name text check (char_length(name) <= 40),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  decided_by text,            -- correo del administrador que decidió
  decided_at timestamptz
);

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y solo se da lectura.
-- Nadie escribe directamente (ni siquiera los administradores): todo pasa por las funciones de abajo, que toman el
-- correo del JWT y comprueban quién es administrador.
revoke all on public.access_requests from anon, authenticated;
grant select on public.access_requests to authenticated;
alter table public.access_requests enable row level security;

-- Cada uno ve solo su solicitud (para saber si está pendiente o rechazada); los administradores ven todas.
create policy access_requests_select on public.access_requests
  for select to authenticated
  using (email = lower(auth.jwt() ->> 'email') or public.is_admin());

-- ---------- pedir acceso ----------

-- Para cualquier usuario con sesión. Devuelve el estado resultante: 'pending', 'denied' o 'approved'.
--  · Si ya es viajero devuelve 'approved' y no guarda nada.
--  · Si no, crea la solicitud 'pending'. Si ya existía, solo se actualiza el nombre: una solicitud 'denied' NO vuelve
--    a 'pending' por pedirla otra vez (solo un administrador puede reabrirla aprobándola).
--  · Excepción: una solicitud 'approved' de alguien que ya NO es viajero (lo quitó remove_member y quedó el histórico)
--    vuelve a 'pending'; si no, se quedaría con un 'approved' falso y sin que ningún administrador viera su petición.
-- El nombre se normaliza: espacios y saltos de línea repetidos pasan a uno, sin espacios en los extremos, máx. 40
-- caracteres. Si llega vacío, se conserva el que ya hubiera.
create or replace function public.request_access(p_name text default null)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
  v_name text;
  v_status text;
begin
  -- Sesiones sin correo (p. ej. inicio de sesión anónimo de Supabase) no pueden pedir acceso.
  if v_email is null or v_email = '' then
    raise exception 'La sesión no tiene correo: inicia sesión con tu correo para pedir acceso' using errcode = '42501';
  end if;

  if public.is_member() then
    return 'approved';
  end if;

  v_name := nullif(btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), '');

  insert into public.access_requests as r (email, name)
  values (v_email, v_name)
  on conflict (email) do update
    set name = coalesce(excluded.name, r.name),
        status = case when r.status = 'approved' then 'pending' else r.status end,
        decided_by = case when r.status = 'approved' then null else r.decided_by end,
        decided_at = case when r.status = 'approved' then null else r.decided_at end
  returning r.status into v_status;

  return v_status;
end;
$$;
revoke all on function public.request_access(text) from public, anon;
grant execute on function public.request_access(text) to authenticated;

-- ---------- decisiones de los administradores ----------

-- Aprueba una solicitud: añade el correo a `members` (sin permisos de administrador) y la marca 'approved'.
-- Es idempotente: aprobar de nuevo no cambia quién ni cuándo la aprobó. Exige que la solicitud exista.
create or replace function public.approve_access(p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email, E' \t\r\n'));
  v_admin text := lower(auth.jwt() ->> 'email');
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if not exists (select 1 from public.access_requests where email = v_email) then
    raise exception 'No hay solicitud de ese correo';
  end if;

  insert into public.members (email) values (v_email) on conflict do nothing;
  update public.access_requests
    set status = 'approved', decided_by = v_admin, decided_at = now()
    where email = v_email and status <> 'approved';
end;
$$;
revoke all on function public.approve_access(text) from public, anon;
grant execute on function public.approve_access(text) to authenticated;

-- Rechaza una solicitud. Si esa persona ya es viajera NO se le quita el acceso (para eso está remove_member).
create or replace function public.deny_access(p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email, E' \t\r\n'));
  v_admin text := lower(auth.jwt() ->> 'email');
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if not exists (select 1 from public.access_requests where email = v_email) then
    raise exception 'No hay solicitud de ese correo';
  end if;

  update public.access_requests
    set status = 'denied', decided_by = v_admin, decided_at = now()
    where email = v_email and status <> 'denied';
end;
$$;
revoke all on function public.deny_access(text) from public, anon;
grant execute on function public.deny_access(text) to authenticated;

-- ---------- gestión directa de viajeros ----------

-- Añade un viajero sin que haya pedido acceso (si lo había pedido, su solicitud pasa a 'approved').
-- No cambia a nadie a administrador: si el correo ya era viajero (o administrador), no se toca.
create or replace function public.add_member(p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email, E' \t\r\n'));
  v_admin text := lower(auth.jwt() ->> 'email');
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_email is null or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Correo no válido: se espera algo como nombre@dominio.com (máx. 254 caracteres)' using errcode = '22023';
  end if;

  insert into public.members (email) values (v_email) on conflict do nothing;
  update public.access_requests
    set status = 'approved', decided_by = v_admin, decided_at = now()
    where email = v_email and status <> 'approved';
end;
$$;
revoke all on function public.add_member(text) from public, anon;
grant execute on function public.add_member(text) to authenticated;

-- Quita un viajero. Nunca a un administrador (ni a uno mismo): así siempre queda al menos uno. La solicitud aprobada
-- que hubiera se deja como está (histórico); si esa persona vuelve a pedir acceso, request_access la reabre.
create or replace function public.remove_member(p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email, E' \t\r\n'));
  v_is_admin boolean;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  select m.is_admin into v_is_admin from public.members m where m.email = v_email for update;
  if not found then
    raise exception 'Ese correo no es de ningún viajero';
  end if;
  if v_is_admin then
    raise exception 'No se puede quitar a un administrador';
  end if;

  delete from public.members where email = v_email;
end;
$$;
revoke all on function public.remove_member(text) from public, anon;
grant execute on function public.remove_member(text) to authenticated;

-- Lista de viajeros (la web no puede leer `members`), ordenada por correo.
create or replace function public.list_members()
returns table (email text, is_admin boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query select m.email, m.is_admin from public.members m order by m.email;
end;
$$;
revoke all on function public.list_members() from public, anon;
grant execute on function public.list_members() to authenticated;

-- ---------- tiempo real ----------

-- Los administradores ven llegar solicitudes nuevas (y cada solicitante ve cambiar la suya) sin recargar:
-- Realtime respeta la política de lectura de arriba.
alter publication supabase_realtime add table public.access_requests;
$parte_acceso$;
  else
    raise notice 'acceso.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- vivo.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.live_locations') is null then
    raise notice 'Aplicando vivo.sql...';
    execute $parte_vivo$
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
$parte_vivo$;
  else
    raise notice 'vivo.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;
