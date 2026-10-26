-- TODO EN UNO: schema + fotos + mapa + extras + acceso + vivo + presencia + adjuntos + compras + juegos, en el orden correcto.
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

-- ======================================================================
-- presencia.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.presence') is null then
    raise notice 'Aplicando presencia.sql...';
    execute $parte_presencia$
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
$parte_presencia$;
  else
    raise notice 'presencia.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- adjuntos.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.audios') is null then
    raise notice 'Aplicando adjuntos.sql...';
    execute $parte_adjuntos$
-- Adjuntos: fotos y notas de voz en las actividades y en los comentarios, comentarios sobre fotos y respuestas.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql, fotos.sql, mapa.sql y extras.sql (usa public.is_member(),
-- public.activities, public.expenses, public.photos con su política photos_update, y public.comments). Una sola vez.
-- No depende de compras.sql, vivo.sql, acceso.sql ni presencia.sql.
--
-- Contenido:
--   1. public.photos.activity_id / expense_id   foto adjunta a una actividad / foto del ticket de una compra.
--   2. public.audios                            notas de voz (tabla, permisos, RLS y tiempo real).
--   3. Bucket privado `audio`                   los archivos de audio, con las mismas reglas que `photos`.
--   4. public.comments                          comentarios sobre una actividad O sobre una foto, respuestas de un solo
--                                               nivel, y foto o audio adjuntos (el texto puede ir vacío si hay adjunto).
--
-- Decisiones que conviene conocer:
--   · Un comentario solo con foto o solo con audio (body vacío) deja de ser válido si desaparece su único adjunto.
--     Un `on delete set null` a secas haría fallar el borrado de la foto o del audio (la restricción
--     comments_body_or_attachment rechazaría el UPDATE interno), así que un disparador BEFORE DELETE borra antes esos
--     comentarios (y, en cascada, sus respuestas). Un comentario con texto, o con el otro adjunto, se queda y solo
--     pierde el adjunto borrado.
--   · Borrar un comentario borra sus respuestas (también las de otros viajeros): es el borrado en cascada de reply_to.
--   · Los archivos de Storage NO se borran desde SQL: si se borra una actividad, sus filas de `audios` desaparecen
--     (cascada) pero el archivo sigue en el bucket `audio`. La web debe borrarlo antes (policy audio_objects_delete).

-- ---------- 1. fotos: actividad y ticket ----------

-- Foto adjunta EXPLÍCITAMENTE a una actividad (distinta de la mera cercanía por fecha o lugar), y foto del ticket de
-- una compra. Si se borra la actividad o el gasto, la foto se queda y solo pierde el vínculo.
alter table public.photos
  add column activity_id uuid references public.activities (id) on delete set null,
  add column expense_id uuid references public.expenses (id) on delete set null;
create index photos_activity_id_idx on public.photos (activity_id);
create index photos_expense_id_idx on public.photos (expense_id);

-- Solo se conceden las dos columnas nuevas (lat, lng y caption ya lo están). La política photos_update (using y
-- with check: is_member() y created_by = auth.uid()) filtra por fila, no por columna, así que ya limita este permiso
-- a las fotos propias: no hace falta tocarla. El INSERT de photos es a nivel de tabla y ya incluye las dos columnas.
grant update (activity_id, expense_id) on public.photos to authenticated;

-- ---------- 2. notas de voz ----------

-- El archivo vive en el bucket privado `audio`, en la carpeta del usuario que lo graba: <user_id>/<audio_id>.<ext>
create table public.audios (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  seconds integer not null check (seconds between 1 and 600), -- duración, de 1 s a 10 min
  activity_id uuid references public.activities (id) on delete cascade, -- opcional: nota de voz de una actividad
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now()
);
create index audios_activity_id_idx on public.audios (activity_id);

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
-- Las notas de voz no se editan (sin UPDATE, ni siquiera por columnas): se borra y se vuelve a grabar.
revoke all on public.audios from anon, authenticated;
grant select, insert, delete on public.audios to authenticated;
alter table public.audios enable row level security;

-- Todos los viajeros las ven y suben las suyas; cada uno borra solo las suyas.
create policy audios_select on public.audios
  for select to authenticated using (public.is_member());
create policy audios_insert on public.audios
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());
create policy audios_delete on public.audios
  for delete to authenticated using (public.is_member() and created_by = auth.uid());

alter publication supabase_realtime add table public.audios;

-- ---------- 3. almacén de archivos de audio ----------

-- Privado (se reproduce con enlaces temporales), solo formatos de audio habituales, máx. 5 MB por archivo.
-- Al subir, la web debe enviar el tipo sin parámetros ('audio/webm', no 'audio/webm;codecs=opus').
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'audio', 'audio', false, 5242880,
  array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/wav']
)
on conflict (id) do nothing;

-- Igual que las de `photos`: leen los viajeros; suben y borran solo en su propia carpeta.
create policy audio_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'audio' and public.is_member());

create policy audio_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'audio' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

create policy audio_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'audio' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- 4. comentarios: sobre fotos, respuestas y adjuntos ----------

-- Hasta ahora: activity_id obligatorio, body de 1 a 1000 caracteres y nada más. Ahora un comentario cuelga de una
-- actividad O de una foto, puede responder a otro comentario y puede llevar una foto y/o una nota de voz.
alter table public.comments
  alter column activity_id drop not null,
  add column on_photo uuid references public.photos (id) on delete cascade,                -- comentario sobre una foto
  add column reply_to uuid references public.comments (id) on delete cascade,              -- respuesta a otro comentario
  add column attached_photo uuid references public.photos (id) on delete set null,
  add column attached_audio uuid references public.audios (id) on delete set null;

create index comments_on_photo_idx on public.comments (on_photo);
create index comments_reply_to_idx on public.comments (reply_to);
create index comments_attached_photo_idx on public.comments (attached_photo);
create index comments_attached_audio_idx on public.comments (attached_audio);

-- Restricción antigua de `body` (1 a 1000 caracteres): se busca por lo que comprueba (un CHECK de una sola columna,
-- `body`, que usa char_length), no por su nombre. En un Postgres normal se llama comments_body_check.
do $$
declare
  v_old record;
begin
  for v_old in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.comments'::regclass
      and c.contype = 'c'
      and c.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = c.conrelid and a.attname = 'body')]
      and pg_get_constraintdef(c.oid) like '%char_length(body)%'
  loop
    execute format('alter table public.comments drop constraint %I', v_old.conname);
    raise notice 'adjuntos.sql: restricción antigua de comments.body eliminada: %', v_old.conname;
  end loop;
end
$$;

-- Texto: por defecto vacío, de 0 a 1000 caracteres. Vacío solo si hay foto o audio adjuntos.
-- Los comentarios que ya existían (activity_id relleno, body de 1 a 1000, nada más) cumplen las tres restricciones.
alter table public.comments
  alter column body set default '',
  add constraint comments_body_len check (char_length(body) <= 1000),
  add constraint comments_body_or_attachment
    check (char_length(body) > 0 or attached_photo is not null or attached_audio is not null),
  add constraint comments_one_target check ((activity_id is not null) <> (on_photo is not null));

-- Respuestas: el comentario padre debe existir, ser del mismo destino (la misma actividad o la misma foto) y no ser
-- él mismo una respuesta (hilos de un solo nivel). Se ejecuta con los permisos de quien comenta: los viajeros ven
-- todos los comentarios, y quien no es viajero no ve ninguno (y su INSERT lo rechazaría la política de todos modos).
-- No hay UPDATE sobre comments, así que basta con comprobarlo al insertar.
create or replace function public.check_comment_reply()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_parent public.comments;
begin
  if new.reply_to is null then
    return new;
  end if;

  select * into v_parent from public.comments where id = new.reply_to;
  if not found then
    raise exception 'La respuesta debe ser a un comentario que exista' using errcode = 'foreign_key_violation';
  end if;
  if v_parent.reply_to is not null then
    raise exception 'No se puede responder a una respuesta: los hilos son de un solo nivel' using errcode = 'check_violation';
  end if;
  if v_parent.activity_id is distinct from new.activity_id or v_parent.on_photo is distinct from new.on_photo then
    raise exception 'La respuesta debe ser de la misma actividad o de la misma foto que el comentario original' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.check_comment_reply() from public, anon, authenticated;

create trigger comments_check_reply
  before insert on public.comments
  for each row execute function public.check_comment_reply();

-- Al borrar una foto o un audio, los comentarios que SOLO tenían ese adjunto (texto vacío y sin el otro adjunto)
-- se borran antes: si no, el `on delete set null` los dejaría sin nada y comments_body_or_attachment haría fallar el
-- borrado de la foto o del audio. Va BEFORE DELETE porque el `set null` de la clave foránea actúa después (AFTER).
-- security definer: quien borra su foto o su audio puede no ser el autor de ese comentario (un viajero puede adjuntar
-- la foto de otro), y las políticas de comments no le dejarían borrarlo.
create or replace function public.drop_comments_left_empty()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'photos' then
    delete from public.comments where attached_photo = old.id and body = '' and attached_audio is null;
  else
    delete from public.comments where attached_audio = old.id and body = '' and attached_photo is null;
  end if;
  return old;
end;
$$;
revoke all on function public.drop_comments_left_empty() from public, anon, authenticated;

create trigger photos_drop_empty_comments
  before delete on public.photos
  for each row execute function public.drop_comments_left_empty();
create trigger audios_drop_empty_comments
  before delete on public.audios
  for each row execute function public.drop_comments_left_empty();

-- Permisos y políticas de comments: sin cambios. Todos leen y comentan; cada uno borra solo los suyos; no se editan
-- (sin UPDATE, ni por columnas). El INSERT es a nivel de tabla y ya incluye las columnas nuevas; las políticas
-- (is_member() y created_by = auth.uid()) filtran por fila, no por columna. comments ya está en supabase_realtime.
$parte_adjuntos$;
  else
    raise notice 'adjuntos.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- compras.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'kind') then
    raise notice 'Aplicando compras.sql...';
    execute $parte_compras$
-- Compras y gastos: distinguir una compra (algo que se compró en una tienda) de un gasto (una cuenta, un taxi...)
-- en el reparto de gastos.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de extras.sql (añade columnas a public.expenses). Una sola vez.
-- No depende de adjuntos.sql ni de ningún otro archivo: se puede aplicar antes, después o sin él.
--
-- Contenido (todo en public.expenses):
--   · kind   'gasto' (por defecto) o 'compra'. Los gastos que ya existían quedan como 'gasto'.
--   · place  tienda o sitio donde se compró (texto libre, opcional, máx. 120 caracteres).
-- El reparto (paid_by, split, amount) es el mismo para los dos tipos: solo cambia cómo se muestran.
-- (La foto del ticket de una compra se ata con photos.expense_id, que añade adjuntos.sql.)

alter table public.expenses
  add column kind text not null default 'gasto' check (kind in ('gasto', 'compra')),
  add column place text check (char_length(place) <= 120);

-- UPDATE se concede por columnas (extras.sql): se añaden solo las dos nuevas. La política expenses_update
-- no filtra por autor (cualquier viajero edita cualquier gasto), así que `kind` y `place` se editan igual que
-- el resto de columnas. El INSERT ya es a nivel de tabla y las incluye; las políticas no cambian.
grant update (kind, place) on public.expenses to authenticated;
$parte_compras$;
  else
    raise notice 'compras.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- juego_batalla.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.battles') is null then
    raise notice 'Aplicando juego_batalla.sql...';
    execute $parte_juego_batalla$
-- Juego «Batalla de fotos». Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql y acceso.sql (usa public.is_member()
-- e public.is_admin()). Una sola vez. No depende de fotos.sql en la base: solo usa el almacén privado `photos` que ese
-- archivo crea (las políticas de Storage de la carpeta de cada usuario ya permiten subir y borrar las fotos del juego).
--
-- Cómo se juega: un viajero lanza un reto de foto («La sonrisa más rara»), todos envían UNA foto hecha con el móvil, se vota
-- en secreto la mejor (no la propia) y al terminar se muestra el podio. Hay una clasificación con las batallas terminadas.
--
-- Estados:   open (se envían fotos) → voting (se vota) → done (resultado). Solo avanza, y solo lo hace quien lanzó el reto
--            o un administrador (public.is_admin()). Como mucho UNA batalla sin terminar a la vez (lo garantiza un índice único).
--
-- Contenido:
--   1. Tablas       battles, battle_entries, battle_votes.
--   2. Permisos     sin escritura directa en battles ni battle_votes; en battle_entries el autor solo inserta su foto con la
--                   batalla en `open` y solo la borra mientras sigue en `open`.
--   3. Funciones    start_battle, start_voting, close_battle, cast_vote (escriben, security definer) y battle_results,
--                   battle_leaderboard, battle_progress (leen lo que RLS no deja leer o lo agregan; security definer).
--   4. Tiempo real  battles y battle_entries en supabase_realtime (los votos NO: sus eventos no deben delatar a nadie).
--
-- Seguridad: lo que no debe poder falsearse (quién vota, que no se vote la propia foto, un voto por persona, los estados) lo
-- decide la base de datos. Los votos de los demás no se pueden leer hasta que la batalla termina (RLS). Ojo: el anonimato de
-- las fotos DURANTE la votación es solo de la pantalla (las fotos y su autor se pueden leer; son del grupo y solo las ven
-- viajeros autorizados); lo que la base protege es el secreto de los votos.

-- ---------- batallas ----------

create table public.battles (
  id uuid primary key default gen_random_uuid(),
  prompt text not null check (char_length(prompt) between 1 and 120 and prompt = btrim(prompt)),
  status text not null default 'open' check (status in ('open', 'voting', 'done')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now(),
  voting_at timestamptz,
  closed_at timestamptz,
  -- Las marcas de tiempo acompañan al estado: una batalla `open` no tiene ninguna, `voting` tiene la de inicio de votación y
  -- `done` las dos.
  constraint battles_times_check check (
    (status = 'open' and voting_at is null and closed_at is null)
    or (status = 'voting' and voting_at is not null and closed_at is null)
    or (status = 'done' and voting_at is not null and closed_at is not null)
  )
);

-- Como mucho una batalla sin terminar: el índice único parcial sobre una constante admite una sola fila con status <> 'done',
-- aunque dos personas lancen un reto en el mismo instante.
create unique index battles_one_active_idx on public.battles ((true)) where status <> 'done';
create index battles_created_at_idx on public.battles (created_at desc);

-- ---------- fotos de la batalla ----------

-- Una foto por persona y batalla. Los archivos son <user_id>/batalla-<battle_id>.jpg y <user_id>/batalla-<battle_id>_t.jpg en
-- el almacén privado `photos`; la restricción obliga a que las rutas sean EXACTAMENTE esas, así nadie puede enseñar como
-- suyo un archivo de otro ni de otra carpeta.
create table public.battle_entries (
  id uuid primary key default gen_random_uuid(),
  battle_id uuid not null references public.battles (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text check (char_length(name) <= 40),
  path text not null,
  thumb_path text not null,
  created_at timestamptz not null default now(),
  constraint battle_entries_one_per_user unique (battle_id, user_id),
  -- Hace falta para que un voto solo pueda apuntar a una foto de SU MISMA batalla (clave foránea compuesta de battle_votes).
  constraint battle_entries_id_battle_key unique (id, battle_id),
  constraint battle_entries_path_check check (path = user_id::text || '/batalla-' || battle_id::text || '.jpg'),
  constraint battle_entries_thumb_check check (thumb_path = user_id::text || '/batalla-' || battle_id::text || '_t.jpg')
);

-- ---------- votos ----------

-- Un voto por persona y batalla (clave primaria). El cambio de voto es un UPDATE de entry_id que hace cast_vote.
create table public.battle_votes (
  battle_id uuid not null references public.battles (id) on delete cascade,
  voter_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  entry_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (battle_id, voter_id),
  -- La foto votada tiene que ser de la misma batalla (y si se borra la foto, se borran sus votos).
  constraint battle_votes_entry_fkey foreign key (entry_id, battle_id) references public.battle_entries (id, battle_id) on delete cascade
);
create index battle_votes_entry_idx on public.battle_votes (entry_id);

-- ---------- permisos y RLS ----------

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
revoke all on public.battles, public.battle_entries, public.battle_votes from anon, authenticated;
grant select on public.battles to authenticated;                    -- nadie escribe directamente: lo hacen las funciones
grant select, delete on public.battle_entries to authenticated;      -- sin UPDATE: una foto no se edita (se borra y se envía otra)
grant insert (battle_id, name, path, thumb_path) on public.battle_entries to authenticated; -- user_id, id y hora los pone la base
grant select on public.battle_votes to authenticated;                -- nadie vota directamente: lo hace cast_vote

alter table public.battles enable row level security;
alter table public.battle_entries enable row level security;
alter table public.battle_votes enable row level security;

-- Los viajeros autorizados ven las batallas y las fotos.
create policy battles_select on public.battles
  for select to authenticated using (public.is_member());
create policy battle_entries_select on public.battle_entries
  for select to authenticated using (public.is_member());

-- Cada uno inserta SU foto (user_id sale de auth.uid()) y solo con la batalla en `open`.
create policy battle_entries_insert on public.battle_entries
  for insert to authenticated
  with check (
    public.is_member() and user_id = auth.uid()
    and exists (select 1 from public.battles b where b.id = battle_id and b.status = 'open')
  );

-- Cada uno borra solo la suya y solo mientras la batalla sigue en `open` (después, la foto ya está en juego).
create policy battle_entries_delete on public.battle_entries
  for delete to authenticated
  using (
    public.is_member() and user_id = auth.uid()
    and exists (select 1 from public.battles b where b.id = battle_id and b.status = 'open')
  );

-- Votos: cada uno ve SIEMPRE el suyo; los de los demás, solo cuando la batalla ha terminado.
create policy battle_votes_select on public.battle_votes
  for select to authenticated
  using (
    public.is_member()
    and (voter_id = auth.uid() or exists (select 1 from public.battles b where b.id = battle_id and b.status = 'done'))
  );

-- Al insertar una foto se bloquea la fila de la batalla (FOR SHARE) y se comprueba que sigue en `open`: así una foto no se
-- cuela justo cuando alguien pasa la batalla a votación (start_voting pide el bloqueo exclusivo y espera a que termine el
-- INSERT). Además da un mensaje claro en vez de «violates row-level security policy».
create or replace function public.battle_entries_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  select b.status into v_status from public.battles b where b.id = new.battle_id for share;
  if not found then
    raise exception 'Esa batalla no existe';
  elsif v_status = 'voting' then
    raise exception 'Ya no se pueden enviar fotos: la votación ha empezado';
  elsif v_status <> 'open' then
    raise exception 'Ya no se pueden enviar fotos: la batalla ha terminado';
  end if;
  return new;
end;
$$;
revoke all on function public.battle_entries_guard() from public, anon, authenticated;

create trigger battle_entries_guard
  before insert on public.battle_entries
  for each row execute function public.battle_entries_guard();

-- ---------- lanzar y avanzar la batalla ----------

-- Lanza un reto nuevo. `p_name` es el nombre que se muestra («Lanzado por Ana»); como en el resto de la web lo manda la
-- página (la identidad real es created_by = auth.uid()). Devuelve el id de la batalla. Falla si ya hay una sin terminar.
create or replace function public.start_battle(p_prompt text, p_name text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_prompt text := btrim(regexp_replace(coalesce(p_prompt, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
  v_name text := nullif(btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), '');
  v_id uuid;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_prompt = '' then
    raise exception 'Escribe el tema del reto';
  end if;
  if char_length(v_prompt) > 120 then
    raise exception 'El tema es demasiado largo: máximo 120 caracteres';
  end if;
  if exists (select 1 from public.battles where status <> 'done') then
    raise exception 'Ya hay un reto en marcha. Cuando termine podrás lanzar otro';
  end if;
  begin
    insert into public.battles (prompt, created_by_name) values (v_prompt, v_name) returning id into v_id;
  exception when unique_violation then
    -- Dos personas lanzaron un reto a la vez: ganó la otra.
    raise exception 'Ya hay un reto en marcha. Cuando termine podrás lanzar otro';
  end;
  return v_id;
end;
$$;
revoke all on function public.start_battle(text, text) from public, anon;
grant execute on function public.start_battle(text, text) to authenticated;

-- open → voting. Solo quien lanzó el reto o un administrador.
create or replace function public.start_voting(p_battle uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_battle public.battles%rowtype;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into v_battle from public.battles where id = p_battle for update;
  if not found then
    raise exception 'Esa batalla no existe';
  end if;
  if v_battle.created_by is distinct from auth.uid() and not public.is_admin() then
    raise exception 'Solo quien lanzó el reto o un administrador puede empezar la votación' using errcode = '42501';
  end if;
  if v_battle.status = 'voting' then
    raise exception 'La votación ya ha empezado';
  elsif v_battle.status <> 'open' then
    raise exception 'La batalla ya ha terminado';
  end if;
  update public.battles set status = 'voting', voting_at = now() where id = p_battle;
end;
$$;
revoke all on function public.start_voting(uuid) from public, anon;
grant execute on function public.start_voting(uuid) to authenticated;

-- voting → done. Solo quien lanzó el reto o un administrador (se puede cerrar aunque falte gente por votar).
create or replace function public.close_battle(p_battle uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_battle public.battles%rowtype;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into v_battle from public.battles where id = p_battle for update;
  if not found then
    raise exception 'Esa batalla no existe';
  end if;
  if v_battle.created_by is distinct from auth.uid() and not public.is_admin() then
    raise exception 'Solo quien lanzó el reto o un administrador puede cerrar la batalla' using errcode = '42501';
  end if;
  if v_battle.status = 'open' then
    raise exception 'La votación todavía no ha empezado';
  elsif v_battle.status = 'done' then
    raise exception 'La batalla ya ha terminado';
  end if;
  update public.battles set status = 'done', closed_at = now() where id = p_battle;
end;
$$;
revoke all on function public.close_battle(uuid) from public, anon;
grant execute on function public.close_battle(uuid) to authenticated;

-- ---------- votar ----------

-- Vota (o cambia el voto a) una foto. La batalla se deduce de la foto. Reglas: solo con la batalla en `voting`, solo quienes
-- han enviado su foto (así en el resultado todos los votantes tienen nombre), nunca la propia, y un voto por batalla (votar
-- otra foto sustituye al anterior).
create or replace function public.cast_vote(p_entry uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_battle uuid;
  v_owner uuid;
  v_status text;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select e.battle_id, e.user_id into v_battle, v_owner from public.battle_entries e where e.id = p_entry;
  if not found then
    raise exception 'Esa foto no existe';
  end if;
  -- FOR SHARE: mientras se vota, nadie puede cerrar la batalla a la vez (close_battle pide el bloqueo exclusivo).
  select b.status into v_status from public.battles b where b.id = v_battle for share;
  if v_status = 'open' then
    raise exception 'La votación todavía no ha empezado';
  elsif v_status = 'done' then
    raise exception 'La batalla ya ha terminado: no se puede votar';
  end if;
  if v_owner = v_uid then
    raise exception 'No puedes votar tu propia foto';
  end if;
  if not exists (select 1 from public.battle_entries e where e.battle_id = v_battle and e.user_id = v_uid) then
    raise exception 'Solo votan quienes han enviado su foto';
  end if;
  insert into public.battle_votes (battle_id, voter_id, entry_id)
  values (v_battle, v_uid, p_entry)
  on conflict (battle_id, voter_id) do update set entry_id = excluded.entry_id, created_at = now();
end;
$$;
revoke all on function public.cast_vote(uuid) from public, anon;
grant execute on function public.cast_vote(uuid) to authenticated;

-- ---------- resultados ----------

-- Resultado de una batalla TERMINADA: una fila por foto con sus votos y su puesto (los empates comparten puesto: 1, 1, 3…).
-- Antes de que termine falla, para que nadie pueda ir contando votos.
create or replace function public.battle_results(p_battle uuid)
returns table (entry_id uuid, user_id uuid, name text, path text, thumb_path text, votes bigint, rank bigint)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_status text;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select b.status into v_status from public.battles b where b.id = p_battle;
  if not found then
    raise exception 'Esa batalla no existe';
  end if;
  if v_status <> 'done' then
    raise exception 'El resultado se verá cuando termine la batalla';
  end if;
  return query
    select e.id, e.user_id, e.name, e.path, e.thumb_path, count(v.voter_id)::bigint, rank() over (order by count(v.voter_id) desc)
    from public.battle_entries e
    left join public.battle_votes v on v.entry_id = e.id
    where e.battle_id = p_battle
    group by e.id
    order by 7, e.created_at, e.id;
end;
$$;
revoke all on function public.battle_results(uuid) from public, anon;
grant execute on function public.battle_results(uuid) to authenticated;

-- Clasificación del viaje, solo con batallas terminadas: por persona, victorias (primer puesto con al menos un voto; los
-- empates comparten la victoria), votos recibidos y batallas en las que ha participado. Ordenada por victorias, votos y
-- participaciones. El nombre es el de su última foto.
create or replace function public.battle_leaderboard()
returns table (user_id uuid, name text, wins bigint, votes bigint, battles bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    with tally as (
      select e.battle_id, e.user_id, e.name, e.created_at, count(v.voter_id) as n
      from public.battle_entries e
      join public.battles b on b.id = e.battle_id and b.status = 'done'
      left join public.battle_votes v on v.entry_id = e.id
      group by e.id
    ), ranked as (
      select t.*, rank() over (partition by t.battle_id order by t.n desc) as rk from tally t
    )
    select r.user_id,
           (array_agg(r.name order by r.created_at desc))[1],
           (count(*) filter (where r.rk = 1 and r.n > 0))::bigint,
           coalesce(sum(r.n), 0)::bigint,
           count(*)::bigint
    from ranked r
    group by r.user_id
    order by 3 desc, 4 desc, 5 desc, 2, 1;
end;
$$;
revoke all on function public.battle_leaderboard() from public, anon;
grant execute on function public.battle_leaderboard() to authenticated;

-- Cuántas fotos hay y cuántos votos se han emitido, SIN decir quién ha votado ni qué (los votos son secretos hasta el final).
-- Sirve para avisar a quien lanzó el reto de que ya han votado todos y puede cerrar.
create or replace function public.battle_progress(p_battle uuid)
returns table (participants bigint, voted bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if not exists (select 1 from public.battles b where b.id = p_battle) then
    raise exception 'Esa batalla no existe';
  end if;
  return query
    select (select count(*) from public.battle_entries e where e.battle_id = p_battle),
           (select count(*) from public.battle_votes v where v.battle_id = p_battle);
end;
$$;
revoke all on function public.battle_progress(uuid) from public, anon;
grant execute on function public.battle_progress(uuid) to authenticated;

-- ---------- tiempo real ----------

-- Las batallas y sus fotos llegan en directo (Realtime respeta las políticas de lectura). Los votos no se publican a propósito.
alter publication supabase_realtime add table public.battles, public.battle_entries;
$parte_juego_batalla$;
  else
    raise notice 'juego_batalla.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- juego_bolsa.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.market_quotes') is null then
    raise notice 'Aplicando juego_bolsa.sql...';
    execute $parte_juego_bolsa$
-- Juego «Bolsa de valores» con PRECIOS REALES y dinero ficticio. Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql
-- y acceso.sql (usa public.is_member() y public.is_admin()). Una sola vez. No depende de ningún otro archivo.
--
-- Cada viajero entra con 200.000 $ de mentira y compra y vende 12 activos REALES (acciones de Disney, Carnival, Royal
-- Caribbean, Marriott, Delta, Apple, Tesla, Nvidia, Amazon y Microsoft, y las criptomonedas Bitcoin y Ethereum) a su precio de
-- verdad y en directo. Todos ven las cuentas, las carteras y cada operación de todos (la transparencia es parte del juego).
--
-- QUIÉN MANDA: la base de datos. El navegador NUNCA envía un precio ni escribe cuentas u operaciones: los clientes solo pueden
-- LEER (con RLS: solo los viajeros) y todo lo que se escribe va por funciones `security definer` que toman al usuario de
-- auth.uid() y comprueban saldo, posición y precio.
--
-- DE DÓNDE SALEN LOS PRECIOS: de Yahoo Finance (https://query1.finance.yahoo.com/v8/finance/chart/<SÍMBOLO>), que no admite
-- peticiones desde el navegador (no tiene CORS), así que las hace la propia base de datos:
--   · pg_cron ejecuta CADA MINUTO public.market_tick();
--   · market_tick() (1) recoge las respuestas ya terminadas de net._http_response (pg_net) de las peticiones del minuto
--     anterior, las valida y guarda la cotización, y (2) lanza las nuevas con net.http_get (asíncrono).
--   · La última cotización buena queda en public.market_quotes (precio, cierre anterior, hora del último trade según Yahoo y
--     hora en que se recogió); cada cambio de precio se anota en public.market_history (se borra lo de más de 14 días).
--   · Se ignora todo lo raro (estado distinto de 200, JSON mal formado, precio no válido): se conserva el último precio bueno y
--     se anota el último error de cada símbolo (market_feed). Los administradores lo ven con market_status().
--   · Primera ronda: además se pide una vez el historial de 5 días por horas (range=5d&interval=1h) para que los gráficos no
--     empiecen vacíos.
--
-- ¿SE PUEDE OPERAR? («operable»): un activo se opera solo si su precio es FRESCO, y eso se deduce de los datos, sin calendario
-- (así vale con festivos):
--   · el recolector funciona: fetched_at (cuándo se recogió) de hace menos de 5 minutos; y
--   · el mercado está abierto: quoted_at (hora del último trade) a menos de 20 minutos de fetched_at. En fin de semana o fuera
--     de horario (EE. UU.: lunes a viernes, 9:30-16:00 hora de Nueva York) el último trade es viejo y las acciones quedan
--     «cerradas»; las criptomonedas no cierran.
--   place_trade NUNCA ejecuta a un precio no fresco y explica en español cuál es el caso (mercado cerrado o sin precios).
--   El ranking y las posiciones valoran siempre con la última cotización guardada (con el mercado cerrado vale el último cierre).
--
-- Si pg_net o pg_cron no están activados, la instalación NO falla: la bolsa queda instalada pero sin precios («Sin precios en
-- directo todavía»). Activa las extensiones en Dashboard → Database → Extensions (pg_net y pg_cron) y ejecuta:
--     select public.market_setup();
-- (también lo hace el botón «Actualizar ahora» que ven los administradores en la bolsa).
--
-- LÍMITE CONOCIDO: la dirección de Yahoo Finance no es una API oficial y gratuita con garantías: puede cambiar de formato, limitar
-- las peticiones (429) o bloquear las IP de Supabase. Si pasa, no se rompe nada: la bolsa deja de operar, avisa con «Sin
-- precios en directo todavía» y market_status() (administradores) enseña la última respuesta y el error de cada símbolo.
--
-- Contenido:
--   1. Migración desde la versión anterior (con activos inventados), si estaba instalada.
--   2. public.invest_assets, market_quotes, market_history, market_feed, market_requests y market_state.
--   3. Recolector: market_state_of, market_ingest, market_tick y market_setup (internas), market_status y market_refresh (admin).
--   4. public.invest_accounts e invest_trades (NINGUNA escritura directa).
--   5. Lectura para el cliente: market_prices, market_series, market_sparks, invest_leaderboard, invest_positions, invest_best_worst.
--   6. Escritura: join_market, place_trade y reset_market (solo administradores).
--   7. Tiempo real (invest_trades) y puesta en marcha (extensiones, trabajo de pg_cron y primera ronda).
--
-- OPERACIONES: la posición de un activo es Σ compras − Σ ventas del usuario. place_trade bloquea la fila de la cuenta (`for
-- update`) mientras opera: dos toques seguidos (o dos dispositivos) se ejecutan uno detrás de otro y no se puede gastar dos
-- veces el mismo dinero ni vender dos veces la misma posición. Cantidad: > 0, máx. 6 decimales y 1.000.000 de unidades por
-- operación. Precio: la cotización guardada redondeada a 2 decimales (se guarda con la operación, junto con su hora). Mínimo de
-- operación: 1 $ (salvo vender lo último que queda de una posición).
--
-- COSTE MEDIO (invest_positions.avg_cost): media ponderada móvil. Cada compra recalcula la media con lo que ya había; una venta
-- no la cambia (solo quita unidades); si se vende todo, se reinicia. La ganancia de una posición (pnl) es su valor actual menos
-- cantidad × coste medio.
--
-- MEJOR Y PEOR OPERACIÓN (invest_best_worst): ganancia de cada operación frente al precio de hoy: una compra gana (precio hoy −
-- precio pagado) × cantidad; una venta gana (precio vendido − precio hoy) × cantidad.

-- ---------- 1. migración desde la versión anterior (activos inventados) ----------

-- La versión anterior calculaba los precios con una fórmula y guardaba cuentas y operaciones de prueba. Se sustituye entera:
-- las cuentas se conservan (mismo nombre, otra vez con 200.000 $) y las operaciones se borran.
do $mig$
declare
  v_accounts int;
  v_trades int;
  r record;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invest_assets' and column_name = 'periods') then
    select count(*) into v_accounts from public.invest_accounts;
    select count(*) into v_trades from public.invest_trades;
    drop table if exists pg_temp.bolsa_cuentas_antiguas;
    create temp table bolsa_cuentas_antiguas as select user_id, name, created_at from public.invest_accounts;
    for r in select 'drop function public.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f from pg_proc p
             where p.pronamespace = 'public'::regnamespace
               and (p.proname like 'invest\_%' or p.proname like 'market\_%' or p.proname in ('join_market', 'place_trade', 'reset_market')) loop
      execute r.f;
    end loop;
    drop table public.invest_trades, public.invest_accounts, public.invest_assets cascade;
    raise notice 'Bolsa: se sustituye la versión con activos inventados por la de precios reales. Se reinician % operaciones de prueba y % cuentas (las cuentas se conservan y vuelven a tener 200.000 $).', v_trades, v_accounts;
  end if;
end
$mig$;

-- ---------- 2. activos, cotizaciones e historial ----------

create table public.invest_assets (
  -- Es el símbolo de Yahoo Finance y se usa tal cual en la dirección de la petición: solo letras, cifras, punto y guion.
  symbol text primary key check (symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,11}$'),
  name text not null check (char_length(name) between 1 and 40),
  emoji text not null check (char_length(emoji) between 1 and 8),
  kind text not null check (kind in ('accion', 'cripto')),
  sort smallint not null default 0
);

insert into public.invest_assets (symbol, name, emoji, kind, sort) values
  ('DIS',     'Disney',            '🏰', 'accion',  1),
  ('CCL',     'Carnival (cruceros)', '🚢', 'accion',  2),
  ('RCL',     'Royal Caribbean',   '⚓', 'accion',  3),
  ('MAR',     'Marriott (hoteles)', '🏨', 'accion',  4),
  ('DAL',     'Delta Air Lines',   '✈️', 'accion',  5),
  ('AAPL',    'Apple',             '🍎', 'accion',  6),
  ('TSLA',    'Tesla',             '🚗', 'accion',  7),
  ('NVDA',    'Nvidia',            '🎮', 'accion',  8),
  ('AMZN',    'Amazon',            '📦', 'accion',  9),
  ('MSFT',    'Microsoft',         '🪟', 'accion', 10),
  ('BTC-USD', 'Bitcoin',           '🪙', 'cripto', 11),
  ('ETH-USD', 'Ethereum',          '💎', 'cripto', 12);

-- Última cotización buena de cada activo. La escribe SOLO market_ingest (el recolector).
create table public.market_quotes (
  symbol text primary key references public.invest_assets (symbol),
  price numeric(14, 2) not null check (price > 0),
  prev_close numeric(14, 2) check (prev_close > 0),   -- cierre anterior (para la variación del día)
  quoted_at timestamptz not null,                      -- hora del último trade según Yahoo
  fetched_at timestamptz not null                      -- cuándo respondió Yahoo (se recogió)
);

-- Un punto cada vez que el precio cambia (y las horas de la carga inicial); se borra lo de más de 14 días.
create table public.market_history (
  symbol text not null references public.invest_assets (symbol),
  t timestamptz not null,
  price numeric(14, 2) not null check (price > 0),
  primary key (symbol, t)
);
create index market_history_t_idx on public.market_history (t);

-- Diagnóstico por símbolo (lo lee market_status, solo administradores).
create table public.market_feed (
  symbol text primary key references public.invest_assets (symbol),
  last_request_at timestamptz,
  last_ok_at timestamptz,
  last_status int,
  last_error text,
  last_error_at timestamptz,
  ok_count int not null default 0,
  error_count int not null default 0,
  backfilled_at timestamptz,
  backfill_tried_at timestamptz,
  backfill_error text
);
insert into public.market_feed (symbol) select symbol from public.invest_assets;

-- Peticiones lanzadas y todavía sin recoger: qué id de pg_net corresponde a qué símbolo.
create table public.market_requests (
  request_id bigint primary key,
  symbol text not null references public.invest_assets (symbol),
  kind text not null check (kind in ('quote', 'backfill')),
  requested_at timestamptz not null default now()
);

-- Una sola fila: cuándo corrió el recolector por última vez.
create table public.market_state (
  id boolean primary key default true check (id),
  last_tick_at timestamptz,
  last_tick_note text,
  last_prune_at timestamptz
);
insert into public.market_state default values;

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan. Los clientes leen (con RLS: solo los
-- viajeros) activos, cotizaciones e historial; el recolector y su diagnóstico no son accesibles para ellos (sin políticas).
revoke all on public.invest_assets, public.market_quotes, public.market_history, public.market_feed, public.market_requests, public.market_state from anon, authenticated;
grant select on public.invest_assets, public.market_quotes, public.market_history to authenticated;
alter table public.invest_assets enable row level security;
alter table public.market_quotes enable row level security;
alter table public.market_history enable row level security;
alter table public.market_feed enable row level security;
alter table public.market_requests enable row level security;
alter table public.market_state enable row level security;
create policy invest_assets_select on public.invest_assets for select to authenticated using (public.is_member());
create policy market_quotes_select on public.market_quotes for select to authenticated using (public.is_member());
create policy market_history_select on public.market_history for select to authenticated using (public.is_member());

-- ---------- ayudas internas (los clientes no las ejecutan) ----------

-- Dinero con formato español para los mensajes de error (10.000,50): no depende del idioma del servidor.
create or replace function public.invest_fmt(p_value numeric, p_decimals int default 2)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select replace(replace(replace(
    to_char(p_value, case when p_decimals = 0 then 'FM999,999,999,999,990' else 'FM999,999,999,999,990.' || repeat('0', p_decimals) end),
    ',', '#'), '.', ','), '#', '.');
$$;
revoke all on function public.invest_fmt(numeric, int) from public, anon, authenticated;

-- Nombre del jugador: espacios y saltos repetidos pasan a uno, sin espacios en los extremos y máx. 40 caracteres.
create or replace function public.invest_clean_name(p_name text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
$$;
revoke all on function public.invest_clean_name(text) from public, anon, authenticated;

-- ¿Cómo está un precio? 'none' (nunca llegó), 'stale' (el recolector no ha traído nada en 5 min: sin precios en directo),
-- 'closed' (llega, pero el último trade es de hace más de 20 min: mercado cerrado) o 'live' (operable).
create or replace function public.market_state_of(p_fetched timestamptz, p_quoted timestamptz, p_now timestamptz default clock_timestamp())
returns text
language sql stable set search_path = public, pg_temp
as $$
  select case
    when p_fetched is null or p_quoted is null then 'none'
    when p_fetched < p_now - interval '5 minutes' then 'stale'
    when p_quoted < p_fetched - interval '20 minutes' then 'closed'
    else 'live'
  end;
$$;
revoke all on function public.market_state_of(timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------- 3. recolector ----------

-- Valida UNA respuesta de Yahoo y guarda la cotización (o el error). Nunca falla: un error se anota y se conserva el último
-- precio bueno. p_kind 'quote' = precio actual (interval=1d&range=1d); 'backfill' = historial de 5 días por horas.
create or replace function public.market_ingest(p_symbol text, p_kind text, p_status int, p_content text, p_error text, p_timed_out boolean, p_created timestamptz)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_msg text;
  v_j jsonb;
  v_meta jsonb;
  v_price numeric;
  v_prev numeric;
  v_time numeric;
  v_quoted timestamptz;
  v_when timestamptz := coalesce(p_created, clock_timestamp());
  v_old public.market_quotes;
  v_rows int;
begin
  if coalesce(p_timed_out, false) then
    v_msg := 'Yahoo no respondió a tiempo';
  elsif p_error is not null then
    v_msg := 'Error de red: ' || left(p_error, 160);
  elsif p_status is null then
    v_msg := 'Respuesta sin código HTTP';
  elsif p_status = 404 then
    v_msg := 'Yahoo no conoce este símbolo (404)';
  elsif p_status = 429 then
    v_msg := 'Yahoo limita las peticiones (429)';
  elsif p_status <> 200 then
    v_msg := 'Yahoo respondió con el error HTTP ' || p_status;
  else
    begin
      v_j := p_content::jsonb;
    exception when others then
      v_msg := 'La respuesta de Yahoo no es un JSON válido';
    end;
  end if;

  if v_msg is null then
    v_meta := v_j #> '{chart,result,0,meta}';
    if jsonb_typeof(v_meta) is distinct from 'object' then
      v_msg := 'La respuesta de Yahoo no trae datos del activo';
    elsif upper(coalesce(v_meta ->> 'symbol', p_symbol)) <> upper(p_symbol) then
      v_msg := 'La respuesta es de otro símbolo (' || left(v_meta ->> 'symbol', 20) || ')';
    elsif coalesce(upper(v_meta ->> 'currency'), 'USD') <> 'USD' then
      v_msg := 'La moneda no es USD (' || left(v_meta ->> 'currency', 10) || ')';
    end if;
  end if;

  if v_msg is null and p_kind = 'backfill' then
    begin
      insert into public.market_history (symbol, t, price)
        select p_symbol, to_timestamp(ts.v::numeric) + interval '1 hour', round(c.v::numeric, 2)
        from jsonb_array_elements_text(v_j #> '{chart,result,0,timestamp}') with ordinality as ts(v, i)
        join jsonb_array_elements_text(v_j #> '{chart,result,0,indicators,quote,0,close}') with ordinality as c(v, i) on c.i = ts.i
        where c.v is not null and c.v::numeric >= 0.01 and c.v::numeric < 1000000000
          and to_timestamp(ts.v::numeric) + interval '1 hour' <= v_when
        on conflict (symbol, t) do nothing;
      get diagnostics v_rows = row_count;
      update public.market_feed set backfilled_at = v_when, backfill_error = null where symbol = p_symbol;
      return true;
    exception when others then
      v_msg := 'Historial inicial no válido: ' || left(sqlerrm, 120);
    end;
  end if;

  if v_msg is null and p_kind = 'quote' then
    begin
      if jsonb_typeof(v_meta -> 'regularMarketPrice') is distinct from 'number' then
        v_msg := 'La respuesta no trae precio';
      else
        v_price := (v_meta ->> 'regularMarketPrice')::numeric;
        if v_price < 0.005 or v_price >= 1000000000 then
          v_msg := 'Precio no válido (' || left(v_price::text, 24) || ')';
        end if;
      end if;
      if v_msg is null then
        if jsonb_typeof(v_meta -> 'chartPreviousClose') = 'number' and (v_meta ->> 'chartPreviousClose')::numeric >= 0.005 and (v_meta ->> 'chartPreviousClose')::numeric < 1000000000 then
          v_prev := (v_meta ->> 'chartPreviousClose')::numeric;
        end if;
        if jsonb_typeof(v_meta -> 'regularMarketTime') is distinct from 'number' then
          v_msg := 'La respuesta no trae la hora de la cotización';
        else
          v_time := (v_meta ->> 'regularMarketTime')::numeric;
          if v_time <= 0 or v_time > 4102444800 then
            v_msg := 'Hora de cotización no válida';
          else
            v_quoted := least(to_timestamp(v_time), v_when); -- una cotización no puede ser del futuro
          end if;
        end if;
      end if;
    exception when others then
      v_msg := 'Respuesta no válida: ' || left(sqlerrm, 120);
    end;
  end if;

  if v_msg is null and p_kind = 'quote' then
    select * into v_old from public.market_quotes where symbol = p_symbol;
    if not found then
      insert into public.market_quotes (symbol, price, prev_close, quoted_at, fetched_at)
        values (p_symbol, round(v_price, 2), round(v_prev, 2), v_quoted, v_when);
    elsif v_quoted >= v_old.quoted_at then
      update public.market_quotes
        set price = round(v_price, 2), prev_close = round(v_prev, 2), quoted_at = v_quoted, fetched_at = greatest(v_when, v_old.fetched_at)
        where symbol = p_symbol;
    else
      -- Yahoo devolvió algo más viejo que lo que ya hay: no se retrocede (el precio y su hora siguen siendo los buenos).
      update public.market_quotes set fetched_at = greatest(v_when, v_old.fetched_at) where symbol = p_symbol;
    end if;
    if v_old.symbol is null or v_quoted >= v_old.quoted_at then
      if v_old.symbol is null or v_old.price is distinct from round(v_price, 2) then
        insert into public.market_history (symbol, t, price) values (p_symbol, v_when, round(v_price, 2))
          on conflict (symbol, t) do update set price = excluded.price;
      end if;
    end if;
    update public.market_feed
      set last_ok_at = v_when, last_status = 200, ok_count = ok_count + 1
      where symbol = p_symbol;
    return true;
  end if;

  -- Algo falló: se anota y no se toca la última cotización buena.
  if p_kind = 'backfill' then
    update public.market_feed set backfill_error = v_msg where symbol = p_symbol;
  else
    update public.market_feed
      set last_status = p_status, last_error = v_msg, last_error_at = v_when, error_count = error_count + 1
      where symbol = p_symbol;
  end if;
  return false;
end;
$$;
revoke all on function public.market_ingest(text, text, int, text, text, boolean, timestamptz) from public, anon, authenticated;

-- Una ronda del recolector (la ejecuta pg_cron cada minuto): recoge lo que ha llegado y lanza las peticiones nuevas.
-- Nadie con sesión puede ejecutarla directamente (solo el dueño: pg_cron y las funciones de abajo).
create or replace function public.market_tick()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_ua constant text := 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
  v_url constant text := 'https://query1.finance.yahoo.com/v8/finance/chart/';
  v_headers jsonb;
  r record;
  v_id bigint;
  v_ok int := 0;
  v_err int := 0;
  v_lost int := 0;
  v_launched int := 0;
begin
  -- Si dos rondas coinciden (cron y el botón del administrador), la segunda se salta.
  if not pg_try_advisory_xact_lock(hashtext('market_tick')) then
    return jsonb_build_object('skipped', true);
  end if;
  if to_regclass('net._http_response') is null or to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is null then
    update public.market_state set last_tick_at = v_now, last_tick_note = 'Falta la extensión pg_net: actívala en Dashboard → Database → Extensions';
    return jsonb_build_object('error', 'Falta la extensión pg_net');
  end if;
  v_headers := jsonb_build_object('User-Agent', v_ua, 'Accept', 'application/json');

  -- 1) recoger las respuestas ya terminadas (de la más antigua a la más nueva, para no retroceder)
  for r in
    select q.request_id, q.symbol, q.kind, q.requested_at,
           h.id is not null as answered, h.status_code, h.content, h.error_msg, h.timed_out, h.created
    from public.market_requests q
    left join net._http_response h on h.id = q.request_id
    order by q.requested_at, q.request_id
  loop
    if r.answered then
      begin
        if public.market_ingest(r.symbol, r.kind, r.status_code, r.content, r.error_msg, r.timed_out, r.created) then
          v_ok := v_ok + 1;
        else
          v_err := v_err + 1;
        end if;
      exception when others then
        v_err := v_err + 1;
        update public.market_feed set last_error = 'Error interno: ' || left(sqlerrm, 120), last_error_at = v_now, error_count = error_count + 1 where symbol = r.symbol;
      end;
      delete from public.market_requests where request_id = r.request_id;
    elsif r.requested_at < v_now - interval '5 minutes' then
      -- Sin respuesta en 5 minutos: se da por perdida (si llegara después, se ignora) y se podrá pedir otra.
      v_lost := v_lost + 1;
      if r.kind = 'quote' then
        update public.market_feed set last_error = 'Sin respuesta de Yahoo en 5 minutos', last_error_at = v_now, error_count = error_count + 1 where symbol = r.symbol;
      else
        update public.market_feed set backfill_error = 'Sin respuesta de Yahoo en 5 minutos' where symbol = r.symbol;
      end if;
      delete from public.market_requests where request_id = r.request_id;
    end if;
  end loop;

  -- 2) lanzar las nuevas (una de precio por símbolo, y una sola vez la carga inicial del historial)
  for r in
    select a.symbol, f.backfilled_at, f.backfill_tried_at,
           exists (select 1 from public.market_requests q where q.symbol = a.symbol and q.kind = 'quote') as quote_pending,
           exists (select 1 from public.market_requests q where q.symbol = a.symbol and q.kind = 'backfill') as backfill_pending
    from public.invest_assets a join public.market_feed f on f.symbol = a.symbol
    order by a.sort
  loop
    begin
      if not r.quote_pending then
        v_id := net.http_get(url := v_url || r.symbol || '?interval=1d&range=1d', headers := v_headers, timeout_milliseconds := 10000);
        insert into public.market_requests (request_id, symbol, kind, requested_at) values (v_id, r.symbol, 'quote', v_now);
        update public.market_feed set last_request_at = v_now where symbol = r.symbol;
        v_launched := v_launched + 1;
      end if;
      if r.backfilled_at is null and not r.backfill_pending and (r.backfill_tried_at is null or r.backfill_tried_at < v_now - interval '30 minutes') then
        v_id := net.http_get(url := v_url || r.symbol || '?interval=1h&range=5d', headers := v_headers, timeout_milliseconds := 15000);
        insert into public.market_requests (request_id, symbol, kind, requested_at) values (v_id, r.symbol, 'backfill', v_now);
        update public.market_feed set backfill_tried_at = v_now where symbol = r.symbol;
        v_launched := v_launched + 1;
      end if;
    exception when others then
      update public.market_feed set last_error = 'No se pudo lanzar la petición: ' || left(sqlerrm, 120), last_error_at = v_now, error_count = error_count + 1 where symbol = r.symbol;
    end;
  end loop;

  -- 3) limpieza: el historial guarda 14 días (se revisa como mucho una vez por hora)
  if (select last_prune_at from public.market_state) is null or (select last_prune_at from public.market_state) < v_now - interval '1 hour' then
    delete from public.market_history where t < v_now - interval '14 days';
    delete from public.market_requests where requested_at < v_now - interval '1 day';
    update public.market_state set last_prune_at = v_now;
  end if;

  update public.market_state set last_tick_at = v_now, last_tick_note = format('%s respuestas buenas, %s con error, %s perdidas, %s peticiones nuevas', v_ok, v_err, v_lost, v_launched);
  return jsonb_build_object('ok', v_ok, 'errors', v_err, 'lost', v_lost, 'launched', v_launched);
end;
$$;
revoke all on function public.market_tick() from public, anon, authenticated;

-- Pone en marcha (o repara) el recolector: activa pg_net y pg_cron si hace falta (y se puede), programa el trabajo de pg_cron
-- (con nombre fijo: si ya existe se reemplaza, nunca se duplica) y lanza una ronda. Devuelve qué hay y qué falta.
-- Solo el dueño la ejecuta (SQL Editor: `select public.market_setup();`) o un administrador con market_refresh().
create or replace function public.market_setup()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_notes text[] := '{}';
  v_net boolean;
  v_cron boolean;
  v_scheduled boolean := false;
  v_tick jsonb;
begin
  if to_regclass('net._http_response') is null then
    begin
      execute 'create extension if not exists pg_net with schema extensions';
    exception when others then
      v_notes := v_notes || ('No se pudo activar pg_net (' || sqlerrm || '). Actívala en Dashboard → Database → Extensions.');
    end;
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    begin
      execute 'create extension if not exists pg_cron with schema pg_catalog';
    exception when others then
      v_notes := v_notes || ('No se pudo activar pg_cron (' || sqlerrm || '). Actívala en Dashboard → Database → Extensions.');
    end;
  end if;
  v_net := to_regclass('net._http_response') is not null and to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is not null;
  v_cron := to_regprocedure('cron.schedule(text,text,text)') is not null;
  if v_cron then
    begin
      execute $q$select cron.schedule('market_tick', '* * * * *', 'select public.market_tick()')$q$;
      v_scheduled := true;
    exception when others then
      v_notes := v_notes || ('No se pudo programar el trabajo de pg_cron: ' || sqlerrm);
    end;
  end if;
  if v_net then
    v_tick := public.market_tick();
  end if;
  return jsonb_build_object('pg_net', v_net, 'pg_cron', v_cron, 'scheduled', v_scheduled, 'tick', v_tick, 'notes', to_jsonb(v_notes));
end;
$$;
revoke all on function public.market_setup() from public, anon, authenticated;

-- Administradores: «Actualizar ahora». Repara lo que falte (extensiones y trabajo programado) y fuerza una ronda. Como pg_net
-- trabaja en segundo plano, las respuestas se recogen en la siguiente ronda (o llamando otra vez a los pocos segundos).
create or replace function public.market_refresh()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return public.market_setup();
end;
$$;
revoke all on function public.market_refresh() from public, anon;
grant execute on function public.market_refresh() to authenticated;

-- Administradores: cómo está el recolector (extensiones, trabajo programado, última ronda, cada activo y las últimas
-- respuestas de Yahoo). Sirve para ver por qué no llegan precios.
create or replace function public.market_status()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_net boolean := to_regclass('net._http_response') is not null;
  v_cron boolean := to_regclass('cron.job') is not null;
  v_job jsonb;
  v_resp jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_cron then
    begin
      select jsonb_build_object('schedule', j.schedule, 'active', j.active,
               'last_runs', coalesce((select jsonb_agg(jsonb_build_object('status', d.status, 'message', left(d.return_message, 160), 'start', d.start_time) order by d.start_time desc)
                                      from (select * from cron.job_run_details x where x.jobid = j.jobid order by x.start_time desc limit 3) d), '[]'::jsonb))
        into v_job from cron.job j where j.jobname = 'market_tick';
    exception when others then
      select jsonb_build_object('schedule', j.schedule, 'active', j.active) into v_job from cron.job j where j.jobname = 'market_tick';
    end;
  end if;
  if v_net then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status_code, 'timed_out', x.timed_out, 'error', x.error_msg, 'created', x.created, 'body', left(x.content, 160)) order by x.created desc), '[]'::jsonb)
      into v_resp from (select * from net._http_response order by created desc limit 8) x;
  end if;
  return jsonb_build_object(
    'now', v_now,
    'pg_net', v_net,
    'pg_cron', v_cron,
    'job', v_job,
    'last_tick_at', (select s.last_tick_at from public.market_state s),
    'last_tick_note', (select s.last_tick_note from public.market_state s),
    'pending_requests', (select count(*) from public.market_requests),
    'assets', (
      select jsonb_agg(jsonb_build_object(
        'symbol', a.symbol, 'kind', a.kind,
        'state', public.market_state_of(q.fetched_at, q.quoted_at, v_now),
        'price', q.price, 'quoted_at', q.quoted_at, 'fetched_at', q.fetched_at,
        'last_ok_at', f.last_ok_at, 'last_status', f.last_status, 'last_error', f.last_error, 'last_error_at', f.last_error_at,
        'ok_count', f.ok_count, 'error_count', f.error_count,
        'history_points', (select count(*) from public.market_history h where h.symbol = a.symbol),
        'backfilled_at', f.backfilled_at, 'backfill_error', f.backfill_error) order by a.sort)
      from public.invest_assets a
      left join public.market_quotes q on q.symbol = a.symbol
      left join public.market_feed f on f.symbol = a.symbol),
    'recent_responses', v_resp);
end;
$$;
revoke all on function public.market_status() from public, anon;
grant execute on function public.market_status() to authenticated;

-- ---------- 4. cuentas y operaciones ----------

create table public.invest_accounts (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- `<> 'NaN'`: en numeric, NaN se ordena por encima de todos los números y pasaría `cash >= 0`.
  cash numeric(14, 2) not null default 200000 check (cash >= 0 and cash <> 'NaN'),
  created_at timestamptz not null default now()
);

create table public.invest_trades (
  id bigint generated always as identity primary key, -- el orden de las operaciones de cada jugador (coste medio)
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40), -- su nombre cuando operó
  symbol text not null references public.invest_assets (symbol),
  side text not null check (side in ('buy', 'sell')),
  qty numeric(18, 6) not null check (qty > 0 and qty <= 1000000),
  price numeric(14, 2) not null check (price > 0),     -- la cotización de Yahoo a la que se ejecutó
  total numeric(14, 2) not null check (total >= 0),
  quoted_at timestamptz not null,                      -- hora de esa cotización (último trade en Yahoo)
  created_at timestamptz not null default clock_timestamp()
);
create index invest_trades_user_idx on public.invest_trades (user_id, symbol, id);

revoke all on public.invest_accounts, public.invest_trades from anon, authenticated;
revoke all on sequence public.invest_trades_id_seq from anon, authenticated;
grant select on public.invest_accounts, public.invest_trades to authenticated; -- solo lectura: escriben las funciones
alter table public.invest_accounts enable row level security;
alter table public.invest_trades enable row level security;

-- Todos los viajeros ven las cuentas y operaciones de todos.
create policy invest_accounts_select on public.invest_accounts
  for select to authenticated using (public.is_member());
create policy invest_trades_select on public.invest_trades
  for select to authenticated using (public.is_member());

-- ---------- 5. lectura para el cliente ----------

-- Todos los activos con su última cotización, la variación del día respecto al cierre anterior, cómo está el precio y si se
-- puede operar. Sin cotización todavía: precio nulo y estado 'none'. server_now permite al cliente calcular «hace 40 s» sin
-- depender de su reloj.
create or replace function public.market_prices()
returns table (symbol text, name text, emoji text, kind text, price numeric, prev_close numeric, change_day_pct numeric, quoted_at timestamptz, fetched_at timestamptz, state text, operable boolean, server_now timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select a.symbol, a.name, a.emoji, a.kind, q.price, q.prev_close,
           case when q.prev_close > 0 then round((q.price / q.prev_close - 1) * 100, 2) end,
           q.quoted_at, q.fetched_at, s.st, s.st = 'live', v_now
    from public.invest_assets a
    left join public.market_quotes q on q.symbol = a.symbol
    cross join lateral (select public.market_state_of(q.fetched_at, q.quoted_at, v_now) as st) s
    order by a.sort, a.symbol;
end;
$$;
revoke all on function public.market_prices() from public, anon;
grant execute on function public.market_prices() to authenticated;

-- Serie de precios REAL de un activo para dibujar el gráfico: p_points puntos repartidos entre hace p_hours horas y ahora, cada
-- uno con el último precio conocido en ese momento (los instantes anteriores al primer dato no salen). Límites: 1-336 horas y
-- 2-500 puntos. Ordenada por hora.
create or replace function public.market_series(p_symbol text, p_hours int default 48, p_points int default 96)
returns table (t timestamptz, price numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_sym text := upper(btrim(coalesce(p_symbol, '')));
  v_last timestamptz := clock_timestamp();
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 336 or p_points is null or p_points not between 2 and 500 then
    raise exception 'El historial admite de 1 a 336 horas y de 2 a 500 puntos';
  end if;
  if not exists (select 1 from public.invest_assets where symbol = v_sym) then
    raise exception 'Ese activo no existe en la bolsa';
  end if;
  return query
    select s.ts, h.price
    from (select v_last - (p_hours * 3600.0 * (p_points - 1 - i) / (p_points - 1)) * interval '1 second' as ts
          from generate_series(0, p_points - 1) as i) s
    cross join lateral (select x.price from public.market_history x where x.symbol = v_sym and x.t <= s.ts order by x.t desc limit 1) h
    order by s.ts;
end;
$$;
revoke all on function public.market_series(text, int, int) from public, anon;
grant execute on function public.market_series(text, int, int) to authenticated;

-- Los mini gráficos de todos los activos de una sola vez (una consulta en vez de doce). Límites: 1-336 horas y 2-60 puntos.
create or replace function public.market_sparks(p_hours int default 120, p_points int default 30)
returns table (symbol text, t timestamptz, price numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_last timestamptz := clock_timestamp();
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 336 or p_points is null or p_points not between 2 and 60 then
    raise exception 'Los mini gráficos admiten de 1 a 336 horas y de 2 a 60 puntos';
  end if;
  return query
    select a.symbol, s.ts, h.price
    from public.invest_assets a
    cross join lateral (select v_last - (p_hours * 3600.0 * (p_points - 1 - i) / (p_points - 1)) * interval '1 second' as ts
                        from generate_series(0, p_points - 1) as i) s
    cross join lateral (select x.price from public.market_history x where x.symbol = a.symbol and x.t <= s.ts order by x.t desc limit 1) h
    order by a.sort, a.symbol, s.ts;
end;
$$;
revoke all on function public.market_sparks(int, int) from public, anon;
grant execute on function public.market_sparks(int, int) to authenticated;

-- Posición de cada jugador en cada activo (solo lo que tiene ahora): cantidad y coste medio (media ponderada móvil; ver
-- arriba). Interna: la usan invest_positions e invest_leaderboard.
create or replace function public.invest_holdings()
returns table (user_id uuid, symbol text, qty numeric, avg_cost numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
  cur_user uuid;
  cur_symbol text;
  q numeric := 0;
  avg numeric := 0;
begin
  for r in select t.user_id as u, t.symbol as s, t.side as sd, t.qty as n, t.total as c
           from public.invest_trades t order by t.user_id, t.symbol, t.id loop
    if cur_user is distinct from r.u or cur_symbol is distinct from r.s then
      if cur_user is not null and q > 0 then
        user_id := cur_user; symbol := cur_symbol; qty := q; avg_cost := avg;
        return next;
      end if;
      cur_user := r.u; cur_symbol := r.s; q := 0; avg := 0;
    end if;
    if r.sd = 'buy' then
      avg := (q * avg + r.c) / (q + r.n);
      q := q + r.n;
    else
      q := q - r.n;
      if q <= 0 then q := 0; avg := 0; end if;
    end if;
  end loop;
  if cur_user is not null and q > 0 then
    user_id := cur_user; symbol := cur_symbol; qty := q; avg_cost := avg;
    return next;
  end if;
end;
$$;
revoke all on function public.invest_holdings() from public, anon, authenticated;

-- Todas las posiciones de todos: cantidad, coste medio, precio de la última cotización, valor y ganancia (valor − cantidad ×
-- coste medio). Valora con la última cotización guardada aunque el mercado esté cerrado.
create or replace function public.invest_positions()
returns table (user_id uuid, name text, symbol text, qty numeric, avg_cost numeric, price numeric, value numeric, pnl numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select h.user_id, ac.name, h.symbol, h.qty, round(h.avg_cost, 4), px.p,
           round(h.qty * px.p, 2),
           round(h.qty * px.p, 2) - round(h.qty * h.avg_cost, 2)
    from public.invest_holdings() h
    join public.invest_accounts ac on ac.user_id = h.user_id
    join public.invest_assets a on a.symbol = h.symbol
    left join public.market_quotes mq on mq.symbol = h.symbol
    cross join lateral (select coalesce(mq.price, round(h.avg_cost, 2)) as p) px
    order by ac.name, ac.user_id, a.sort, h.symbol;
end;
$$;
revoke all on function public.invest_positions() from public, anon;
grant execute on function public.invest_positions() to authenticated;

-- Clasificación: por jugador, efectivo + valor de sus posiciones = patrimonio (total), ganancia en % sobre los 200.000 $
-- iniciales y número de operaciones. Ordenada por patrimonio (y por nombre si empatan).
create or replace function public.invest_leaderboard()
returns table (user_id uuid, name text, cash numeric, holdings_value numeric, total numeric, pnl_pct numeric, trades_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    with pos as (select p.user_id, sum(p.value) as v from public.invest_positions() p group by p.user_id),
         cnt as (select t.user_id, count(*) as n from public.invest_trades t group by t.user_id)
    select a.user_id, a.name, a.cash, coalesce(pos.v, 0), a.cash + coalesce(pos.v, 0),
           round((a.cash + coalesce(pos.v, 0) - 200000) / 200000 * 100, 2),
           coalesce(cnt.n, 0)
    from public.invest_accounts a
    left join pos on pos.user_id = a.user_id
    left join cnt on cnt.user_id = a.user_id
    order by 5 desc, a.name, a.user_id;
end;
$$;
revoke all on function public.invest_leaderboard() from public, anon;
grant execute on function public.invest_leaderboard() to authenticated;

-- La mejor y la peor operación de todos (ver arriba cómo se mide). Dos filas ('best' y 'worst'), o ninguna si nadie ha operado
-- (con una sola operación, las dos son la misma).
create or replace function public.invest_best_worst()
returns table (kind text, id bigint, user_id uuid, name text, symbol text, side text, qty numeric, price numeric, total numeric, created_at timestamptz, price_now numeric, gain numeric, asset_name text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    with g as (
      select t.id, t.user_id, t.name, t.symbol, t.side, t.qty, t.price, t.total, t.created_at, px.p as price_now,
             round(case t.side when 'buy' then px.p - t.price else t.price - px.p end * t.qty, 2) as gain, a.name as asset_name
      from public.invest_trades t
      join public.invest_assets a on a.symbol = t.symbol
      left join public.market_quotes mq on mq.symbol = t.symbol
      cross join lateral (select coalesce(mq.price, t.price) as p) px
    )
    (select 'best'::text, g.* from g order by g.gain desc, g.id limit 1)
    union all
    (select 'worst'::text, g.* from g order by g.gain, g.id limit 1);
end;
$$;
revoke all on function public.invest_best_worst() from public, anon;
grant execute on function public.invest_best_worst() to authenticated;

-- ---------- 6. escritura: solo por estas funciones ----------

-- Entrar a la bolsa: crea la cuenta de quien llama con 200.000 $ si no la tenía (si ya la tenía, no cambia nada) y la
-- devuelve. El nombre se normaliza (≤ 40 caracteres); si llega vacío se usa «Viajero».
create or replace function public.join_market(p_name text default null)
returns public.invest_accounts
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_acc public.invest_accounts;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  insert into public.invest_accounts (user_id, name) values (v_uid, public.invest_clean_name(p_name))
    on conflict (user_id) do nothing;
  select * into v_acc from public.invest_accounts where user_id = v_uid;
  return v_acc;
end;
$$;
revoke all on function public.join_market(text) from public, anon;
grant execute on function public.join_market(text) to authenticated;

-- Comprar o vender. Siempre a la última cotización guardada (el servidor la tiene; el cliente no envía precio) y solo si es FRESCA
-- (ver arriba), y siempre como quien llama (auth.uid()). Devuelve la operación guardada. Los fallos explican en español qué pasó.
create or replace function public.place_trade(p_symbol text, p_side text, p_qty numeric)
returns public.invest_trades
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_side text := lower(btrim(coalesce(p_side, '')));
  v_asset public.invest_assets;
  v_acc public.invest_accounts;
  v_quote public.market_quotes;
  v_state text;
  v_held numeric;
  v_now timestamptz;
  v_total numeric;
  v_trade public.invest_trades;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_side not in ('buy', 'sell') then
    raise exception 'La operación debe ser una compra o una venta';
  end if;
  if p_qty is null or p_qty = 'NaN' or p_qty <= 0 then
    raise exception 'La cantidad debe ser mayor que 0';
  end if;
  if p_qty > 1000000 then
    raise exception 'La cantidad máxima por operación es de 1.000.000 de unidades';
  end if;
  if p_qty <> round(p_qty, 6) then
    raise exception 'La cantidad admite como máximo 6 decimales';
  end if;
  select * into v_asset from public.invest_assets where symbol = v_symbol;
  if not found then
    raise exception 'Ese activo no existe en la bolsa';
  end if;

  -- Se bloquea la cuenta hasta el final de la operación: otra operación del mismo jugador espera aquí y, al
  -- continuar, ya ve el saldo y las posiciones actualizados.
  select * into v_acc from public.invest_accounts where user_id = v_uid for update;
  if not found then
    raise exception 'Primero entra a la bolsa para recibir tus 200.000 $';
  end if;

  -- Solo a precio fresco: se lee UNA vez la cotización y de esa misma fila salen el estado, el precio y su hora.
  v_now := clock_timestamp();
  select * into v_quote from public.market_quotes where symbol = v_symbol;
  v_state := public.market_state_of(v_quote.fetched_at, v_quote.quoted_at, v_now);
  if v_state <> 'live' then
    if v_state = 'closed' and v_asset.kind = 'accion' then
      raise exception 'Mercado cerrado: las acciones de EE. UU. se operan de lunes a viernes, de 9:30 a 16:00 (hora de Nueva York). Último precio de % (%): % $. Mientras tanto puedes operar con Bitcoin y Ethereum.',
        v_asset.name, to_char(v_quote.quoted_at at time zone 'America/New_York', 'DD/MM HH24:MI "NY"'), public.invest_fmt(v_quote.price);
    end if;
    raise exception 'No hay precios en directo ahora mismo para %. Inténtalo en unos minutos.', v_asset.name;
  end if;
  v_total := round(p_qty * v_quote.price, 2);

  select coalesce(sum(case side when 'buy' then qty else -qty end), 0) into v_held
    from public.invest_trades where user_id = v_uid and symbol = v_symbol;

  -- Mínimo de 1 $ por operación; vender lo último que queda de una posición se permite aunque valga menos.
  if v_total < 1 and not (v_side = 'sell' and p_qty = v_held) then
    raise exception 'La operación mínima es de 1 $ (esta sería de % $)', public.invest_fmt(v_total);
  end if;

  if v_side = 'buy' then
    if v_acc.cash < v_total then
      raise exception 'No tienes suficiente dinero: esta compra cuesta % $ y tienes % $', public.invest_fmt(v_total), public.invest_fmt(v_acc.cash);
    end if;
    update public.invest_accounts set cash = cash - v_total where user_id = v_uid;
  else
    if v_held < p_qty then
      raise exception 'No tienes suficientes unidades: quieres vender % y tienes %', trim_scale(p_qty), trim_scale(v_held);
    end if;
    update public.invest_accounts set cash = cash + v_total where user_id = v_uid;
  end if;

  insert into public.invest_trades (user_id, name, symbol, side, qty, price, total, quoted_at, created_at)
    values (v_uid, v_acc.name, v_symbol, v_side, p_qty, v_quote.price, v_total, v_quote.quoted_at, v_now)
    returning * into v_trade;
  return v_trade;
end;
$$;
revoke all on function public.place_trade(text, text, numeric) from public, anon;
grant execute on function public.place_trade(text, text, numeric) to authenticated;

-- Reiniciar la bolsa: solo administradores. Borra todas las operaciones y deja a todos con 200.000 $ (las cuentas siguen y los
-- precios no se tocan). Devuelve cuántas cuentas se reiniciaron. (`where true`: las extensiones de seguridad de Supabase, como
-- pg_safeupdate, rechazan un UPDATE o DELETE sin WHERE.)
create or replace function public.reset_market()
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_accounts integer;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  delete from public.invest_trades where true;
  update public.invest_accounts set cash = 200000 where true;
  get diagnostics v_accounts = row_count;
  return v_accounts;
end;
$$;
revoke all on function public.reset_market() from public, anon;
grant execute on function public.reset_market() to authenticated;

-- ---------- 7. tiempo real y puesta en marcha ----------

-- Las operaciones nuevas llegan a todos sin recargar (Realtime respeta la política de lectura de arriba). Las cotizaciones no
-- se publican a propósito: son doce filas cada minuto y la pantalla las consulta cada ~20 s.
alter publication supabase_realtime add table public.invest_trades;

-- Cuentas de la versión anterior (si la había): se recrean con 200.000 $.
do $mig2$
declare
  v_n int;
begin
  if to_regclass('pg_temp.bolsa_cuentas_antiguas') is not null then
    insert into public.invest_accounts (user_id, name, cash, created_at)
      select user_id, name, 200000, created_at from pg_temp.bolsa_cuentas_antiguas;
    get diagnostics v_n = row_count;
    drop table pg_temp.bolsa_cuentas_antiguas;
    raise notice 'Bolsa: % cuentas conservadas con 200.000 $.', v_n;
  end if;
end
$mig2$;

-- Extensiones, trabajo de pg_cron y primera ronda. Si no se puede, NO falla la instalación: la bolsa queda sin precios hasta
-- que se activen pg_net y pg_cron (Dashboard → Database → Extensions) y se ejecute `select public.market_setup();`.
do $arranque$
declare
  v_r jsonb;
begin
  v_r := public.market_setup();
  if (v_r ->> 'pg_net')::boolean and (v_r ->> 'pg_cron')::boolean and (v_r ->> 'scheduled')::boolean then
    raise notice 'Bolsa: precios reales en marcha (pg_cron pide los precios a Yahoo Finance cada minuto; la primera ronda ya está lanzada).';
  else
    raise notice 'Bolsa instalada, pero SIN precios en directo todavía: pg_net=%, pg_cron=%, trabajo programado=%. Activa pg_net y pg_cron en Dashboard → Database → Extensions y ejecuta: select public.market_setup();', v_r ->> 'pg_net', v_r ->> 'pg_cron', v_r ->> 'scheduled';
  end if;
  if jsonb_array_length(v_r -> 'notes') > 0 then
    raise notice 'Bolsa: %', v_r -> 'notes';
  end if;
exception when others then
  raise notice 'Bolsa instalada, pero no se pudo poner en marcha el recolector de precios (%). Activa pg_net y pg_cron en Dashboard → Database → Extensions y ejecuta: select public.market_setup();', sqlerrm;
end
$arranque$;
$parte_juego_bolsa$;
  else
    raise notice 'juego_bolsa.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- juego_bingo.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.bingo_marks') is null then
    raise notice 'Aplicando juego_bingo.sql...';
    execute $parte_juego_bingo$
-- Juego «Bingo del viaje»: un cartón de 25 retos igual para todos; cada viajero marca un reto con una foto de prueba.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql (usa public.members e is_member()) y acceso.sql (usa is_admin()).
-- No depende de ningún otro SQL de juegos. Una sola vez (el todo en uno solo lo aplica si falta public.bingo_marks).
-- Las fotos de prueba van al bucket privado `photos` de fotos.sql, en la carpeta del usuario; sus políticas de Storage
-- (solo la propia carpeta, solo JPEG, máx. 5 MB) ya permiten esas rutas y no se tocan aquí.
--
-- Contenido:
--   1. public.bingo_cells      el cartón: 25 retos (idx 0..24), con los iniciales ya sembrados. Solo lectura para la web.
--   2. public.bingo_marks      una marca por persona y reto, con la foto de prueba. Se insertan y se borran; nunca se editan.
--   3. public.set_bingo_cell / set_bingo_cells   cambiar el texto de los retos (solo administradores).
--   4. public.bingo_progress() el resultado de cada jugador, calculado aquí (marcas, líneas, hora de la primera línea).
--
-- Casillas: se numeran por filas, idx = fila * 5 + columna (fila y columna de 0 a 4):
--      0  1  2  3  4
--      5  6  7  8  9
--     10 11 12 13 14
--     15 16 17 18 19
--     20 21 22 23 24
--
-- Definición de «línea»: cinco casillas en raya en las que el MISMO jugador tiene marca. Hay 12 posibles:
--   5 filas       (0-1-2-3-4, 5-6-7-8-9, 10-…-14, 15-…-19, 20-…-24),
--   5 columnas    (0-5-10-15-20, 1-6-11-16-21, 2-7-12-17-22, 3-8-13-18-23, 4-9-14-19-24) y
--   2 diagonales  (0-6-12-18-24 y 4-8-12-16-20).
-- Una casilla puede estar en varias líneas (la central, en cuatro): cada línea completa suma 1 a `lines`.
--   · first_line_at = cuándo completó su PRIMERA línea: de sus líneas completas, la que se cerró antes, y una línea se
--     cierra con su marca más reciente. Quien tiene la first_line_at más temprana es quien canta «¡Bingo!». Se calcula
--     con las marcas actuales: si alguien quita una marca y la rehace, esa línea vuelve a cerrarse (más tarde).
--   · full_at = «cartón lleno» (25 marcas): la hora de su marca más reciente; null mientras no esté lleno.
--
-- Seguridad: todo con RLS y permisos mínimos por columna; lo que no puede falsearse lo pone la base de datos.
--   · Cada uno inserta solo su marca (user_id = auth.uid()) y borra solo las suyas; nadie actualiza.
--   · La hora (created_at) la pone el servidor y el nombre se normaliza en un disparador (ver más abajo): nadie puede
--     fingir que marcó antes ni escribir con el nombre de otro jugador.
--   · Las rutas de las fotos están atadas al propio usuario y reto por una restricción: <user_id>/bingo-<cell>-<id>.jpg
--     (y …_t.jpg), así nadie puede presentar como prueba una foto subida por otra persona.
--   · Los retos solo los cambia un administrador, con funciones `security definer` que lo comprueban.
--   · Las funciones solo se pueden ejecutar con sesión iniciada (`authenticated`), nunca como anónimo.
--
-- Realtime: bingo_marks va en la publicación supabase_realtime (las marcas son pocas y poco frecuentes).

-- ---------- el cartón: 25 retos ----------

create table public.bingo_cells (
  idx smallint primary key,
  text text not null,
  constraint bingo_cells_idx_check check (idx between 0 and 24),
  constraint bingo_cells_text_check check (char_length(text) between 1 and 120 and text = btrim(text))
);

-- Los retos iniciales (el primer carácter es un emoji que la web enseña grande en la casilla). Un administrador puede
-- cambiarlos con set_bingo_cell / set_bingo_cells; el banco de ideas de reserva está en code/js/juegos/bingo.js.
insert into public.bingo_cells (idx, text) values
  (0,  '🌅 Ver un atardecer en la playa'),
  (1,  '🍽️ Probar algo que nunca has comido'),
  (2,  '🦩 Foto con un flamenco'),
  (3,  '🧭 Pedir indicaciones a un desconocido'),
  (4,  '😫 Un selfie con tu cara de cansado'),
  (5,  '🐊 Ver un animal salvaje o su estatua'),
  (6,  '🍦 Tomar un helado a deshoras'),
  (7,  '🚗 Cantar a gritos en el coche'),
  (8,  '🧢 Comprar un recuerdo absurdo'),
  (9,  '🌴 Foto bajo una palmera'),
  (10, '🛒 Pasear por un supermercado de aquí'),
  (11, '🪧 Foto con un cartel que no entiendes'),
  (12, '👨‍👩‍👧 Foto de grupo con todos'),
  (13, '🍕 Foto de tu plato más grande'),
  (14, '🌊 Meter los pies en el agua'),
  (15, '🚦 Foto de una señal de tráfico curiosa'),
  (16, '🏖️ Hacer algo con arena'),
  (17, '💃 Bailar donde no toca'),
  (18, '💤 Foto de alguien dormido en el coche'),
  (19, '🐚 Encontrar una concha bonita'),
  (20, '🌃 Foto de noche con luces de ciudad'),
  (21, '🥤 Brindar con una bebida local'),
  (22, '🧳 Tu maleta en un sitio inesperado'),
  (23, '🤳 Selfie con alguien que no conocías'),
  (24, '🏆 Un momento que no olvidarás');

-- ---------- las marcas ----------

create table public.bingo_marks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,                                        -- nombre del jugador (lo normaliza el disparador)
  cell smallint not null references public.bingo_cells (idx),
  path text not null,                                        -- foto de prueba, versión grande
  thumb_path text not null,                                  -- y su miniatura
  created_at timestamptz not null default now(),             -- la fija el disparador: el cliente no la escribe
  constraint bingo_marks_user_cell_key unique (user_id, cell),  -- una marca por persona y reto
  constraint bingo_marks_name_check check (char_length(name) between 1 and 40),
  constraint bingo_marks_paths_check check (
    path = user_id::text || '/bingo-' || cell::text || '-' || id::text || '.jpg'
    and thumb_path = user_id::text || '/bingo-' || cell::text || '-' || id::text || '_t.jpg'
  )
);

-- Antes de guardar una marca:
--   · created_at = hora del servidor (aunque el cliente mande otra).
--   · name: espacios y saltos de línea repetidos pasan a uno, sin espacios en los extremos; vacío = «Viajero».
--   · Un nombre que ya usa OTRA persona en el bingo (sin distinguir mayúsculas) se rechaza: así nadie puede marcar
--     haciéndose pasar por otro. (No es infalible —«Aná» no es «Ana»—, pero evita el suplantamiento evidente.)
-- Se ejecuta con los permisos de quien inserta: la política de lectura de abajo ya enseña todas las marcas a los
-- viajeros, y a quien no lo es no le dice nada (la política de INSERT lo rechaza después de todas formas).
create or replace function public.bingo_marks_prepare()
returns trigger
language plpgsql set search_path = public
as $$
begin
  new.created_at := now();
  new.name := coalesce(nullif(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), ''), 'Viajero');
  if exists (select 1 from public.bingo_marks o where o.user_id <> new.user_id and lower(o.name) = lower(new.name)) then
    raise exception 'Ese nombre ya lo usa otra persona en el bingo. Cambia tu nombre en tu perfil para poder jugar.' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function public.bingo_marks_prepare() from public, anon, authenticated;

create trigger bingo_marks_prepare
  before insert on public.bingo_marks
  for each row execute function public.bingo_marks_prepare();

-- ---------- permisos y RLS ----------

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
-- bingo_cells: solo lectura (los retos los cambian las funciones de abajo). bingo_marks: leer, borrar las propias e
-- insertar con estas columnas; `created_at` no está en la lista (la pone el disparador) y UPDATE no se concede.
revoke all on public.bingo_cells, public.bingo_marks from anon, authenticated;
grant select on public.bingo_cells to authenticated;
grant select, delete on public.bingo_marks to authenticated;
grant insert (id, user_id, name, cell, path, thumb_path) on public.bingo_marks to authenticated;
alter table public.bingo_cells enable row level security;
alter table public.bingo_marks enable row level security;

-- Los viajeros ven el cartón y las marcas de todos (es parte de la gracia).
create policy bingo_cells_select on public.bingo_cells
  for select to authenticated using (public.is_member());
create policy bingo_marks_select on public.bingo_marks
  for select to authenticated using (public.is_member());
-- Cada uno marca solo como él mismo y borra solo sus marcas (quitar la marca y volver a hacerla). No hay UPDATE.
create policy bingo_marks_insert on public.bingo_marks
  for insert to authenticated with check (public.is_member() and user_id = auth.uid());
create policy bingo_marks_delete on public.bingo_marks
  for delete to authenticated using (public.is_member() and user_id = auth.uid());

-- ---------- cambiar los retos (solo administradores) ----------

-- Normaliza el texto de un reto: espacios y saltos de línea repetidos pasan a uno y sin espacios en los extremos.
create or replace function public.bingo_clean_text(p_text text)
returns text
language sql immutable set search_path = public
as $$
  select btrim(regexp_replace(coalesce(p_text, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
$$;
revoke all on function public.bingo_clean_text(text) from public, anon, authenticated;

-- Cambia el texto de UN reto. Las marcas que ya tuviera se conservan (siguen con su foto bajo el texto nuevo).
create or replace function public.set_bingo_cell(p_idx smallint, p_text text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_text text := public.bingo_clean_text(p_text);
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_idx is null or p_idx not between 0 and 24 then
    raise exception 'La casilla tiene que ser un número de 0 a 24' using errcode = '22023';
  end if;
  if char_length(v_text) not between 1 and 120 then
    raise exception 'El reto debe tener entre 1 y 120 caracteres' using errcode = '22023';
  end if;
  update public.bingo_cells set text = v_text where idx = p_idx;
end;
$$;
revoke all on function public.set_bingo_cell(smallint, text) from public, anon;
grant execute on function public.set_bingo_cell(smallint, text) to authenticated;

-- Cambia los 25 retos de una vez (p_texts[1] es la casilla 0, y así hasta la 24). Todo o nada.
create or replace function public.set_bingo_cells(p_texts text[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_texts text[];
  i int;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_texts is null or array_ndims(p_texts) is distinct from 1 or cardinality(p_texts) <> 25 then
    raise exception 'Hacen falta exactamente 25 retos' using errcode = '22023';
  end if;
  for i in 1..25 loop
    v_texts[i] := public.bingo_clean_text(p_texts[i]);
    if char_length(v_texts[i]) not between 1 and 120 then
      raise exception 'El reto % debe tener entre 1 y 120 caracteres', i using errcode = '22023';
    end if;
  end loop;
  update public.bingo_cells c set text = v_texts[c.idx + 1];
end;
$$;
revoke all on function public.set_bingo_cells(text[]) from public, anon;
grant execute on function public.set_bingo_cells(text[]) to authenticated;

-- ---------- resultados ----------

-- Una fila por jugador con al menos una marca (nadie más aparece: la web no puede leer los nombres de `members`).
-- Orden: más líneas, más marcas, primera línea más temprana, y por último el nombre (así el orden es siempre el mismo).
-- Se ejecuta con los permisos de quien llama: lo que ve sale de la política de lectura de bingo_marks (un viajero
-- ve a todos; quien no es viajero, a nadie).
create or replace function public.bingo_progress()
returns table (user_id uuid, name text, marks integer, lines integer, first_line_at timestamptz, full_at timestamptz)
language sql stable set search_path = public
as $$
  with line_cells (cells) as (values
    (array[0, 1, 2, 3, 4]), (array[5, 6, 7, 8, 9]), (array[10, 11, 12, 13, 14]), (array[15, 16, 17, 18, 19]), (array[20, 21, 22, 23, 24]),  -- filas
    (array[0, 5, 10, 15, 20]), (array[1, 6, 11, 16, 21]), (array[2, 7, 12, 17, 22]), (array[3, 8, 13, 18, 23]), (array[4, 9, 14, 19, 24]),  -- columnas
    (array[0, 6, 12, 18, 24]), (array[4, 8, 12, 16, 20])                                                                                    -- diagonales
  ),
  done as (  -- líneas completas de cada jugador y cuándo se cerró cada una (su marca más reciente)
    select m.user_id, max(m.created_at) as closed_at
    from line_cells l
    join public.bingo_marks m on m.cell = any (l.cells)
    group by m.user_id, l.cells
    having count(*) = 5
  ),
  per_line as (
    select d.user_id, count(*)::integer as lines, min(d.closed_at) as first_line_at from done d group by d.user_id
  ),
  per_user as (
    select m.user_id,
           (array_agg(m.name order by m.created_at desc, m.id))[1] as name,  -- el nombre de su marca más reciente
           count(*)::integer as marks,
           max(m.created_at) as last_at
    from public.bingo_marks m
    group by m.user_id
  )
  select u.user_id, u.name, u.marks, coalesce(p.lines, 0), p.first_line_at, case when u.marks = 25 then u.last_at end
  from per_user u
  left join per_line p on p.user_id = u.user_id
  order by coalesce(p.lines, 0) desc, u.marks desc, p.first_line_at asc nulls last, u.name, u.user_id;
$$;
revoke all on function public.bingo_progress() from public, anon;
grant execute on function public.bingo_progress() to authenticated;

-- ---------- tiempo real ----------

alter publication supabase_realtime add table public.bingo_marks;
$parte_juego_bingo$;
  else
    raise notice 'juego_bingo.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- categorias.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'category') then
    raise notice 'Aplicando categorias.sql...';
    execute $parte_categorias$
-- Categoría y ubicación de cada gasto o compra: de qué es (nafta, comida, salidas…) para el resumen «¿En qué gastamos?» de Cuentas,
-- el álbum y el PDF, y dónde se pagó para que salga en el mapa.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de extras.sql (añade columnas a public.expenses). Una sola vez.
-- No depende de compras.sql, adjuntos.sql ni de ningún otro archivo: se puede aplicar antes, después o sin ellos.
--
-- Contenido (todo en public.expenses):
--   · category  una de ocho claves cerradas: nafta, comida, salidas, transporte, alojamiento, compras, salud, otros.
--               Puede ser nula: los gastos que ya existían se quedan sin categoría (no se tocan) y la web les calcula una por las
--               palabras del concepto («cena en el puerto» → comida). Solo se guarda lo que elige quien apunta el gasto.
--   · lat, lng  dónde se pagó (opcional; la web la pone sola al apuntar el gasto, si quien lo apunta lo deja, y se puede quitar o
--               mover). Mismas reglas que las coordenadas de las fotos y las actividades (rangos y pareja nula a la vez) y, además,
--               nunca (0, 0): es el «punto nulo» que devuelven los GPS sin señal, no un sitio del viaje.
-- El reparto (paid_by, split, amount) no cambia; las políticas RLS tampoco.
--
-- Privacidad: como las de las fotos, las coordenadas de un gasto las ven todos los viajeros autorizados (nadie más).

alter table public.expenses
  add column category text
    constraint expenses_category_check check (category in ('nafta', 'comida', 'salidas', 'transporte', 'alojamiento', 'compras', 'salud', 'otros')),
  add column lat double precision,
  add column lng double precision;
-- (Un CHECK deja pasar el nulo: así los gastos antiguos y los que se apuntan sin categoría o sin ubicación siguen siendo válidos.
-- Una cadena vacía, una clave con mayúsculas o con espacios y cualquier otra palabra se rechazan. Un valor NaN o infinito en lat o
-- lng tampoco cabe en los rangos.)

alter table public.expenses
  add constraint expenses_lat_range check (lat between -90 and 90),
  add constraint expenses_lng_range check (lng between -180 and 180),
  add constraint expenses_latlng_pair check ((lat is null) = (lng is null)),
  add constraint expenses_latlng_not_zero check (not (lat = 0 and lng = 0));

-- Permisos: INSERT y SELECT ya son a nivel de tabla (extras.sql), así que las columnas nuevas se pueden leer y escribir al apuntar un
-- gasto sin conceder nada más (y anon sigue sin nada: extras.sql le quitó todo). UPDATE se concede por columnas: se añaden solo las
-- tres nuevas. La política expenses_update no filtra por autor (cualquier viajero edita cualquier gasto), así que se editan igual
-- que el resto de columnas.
grant update (category, lat, lng) on public.expenses to authenticated;
$parte_categorias$;
  else
    raise notice 'categorias.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- avisos.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise notice 'Aplicando avisos.sql...';
    execute $parte_avisos$
-- Avisos del viaje: notificaciones en pantalla (alerta resaltada con sonido) y con la app cerrada (Web Push).
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql (usa public.members e is_member()) y acceso.sql (usa is_admin() y
-- members.is_admin). Una sola vez (el todo en uno solo lo aplica si falta public.push_subscriptions). Conviene que ya existan las
-- tablas de las que avisa (fotos, comentarios, actividades, gastos, solicitudes de acceso, batalla de fotos, bingo): cada aviso se
-- engancha solo a las que existan al instalar, y las que lleguen después se enganchan ejecutando `select public.push_install_triggers();`.
--
-- Cómo funciona (dos capas):
--   1. Cada novedad (foto, comentario, plan, gasto, solicitud de acceso, juego…) la escribe un disparador en public.push_outbox, que
--      es a la vez la «bandeja de salida» y el «feed de novedades». La web se suscribe por Realtime y enseña una alerta resaltada con
--      sonido a quien le corresponda (esta capa funciona con SOLO este SQL).
--   2. Si además hay una dirección de función registrada (public.push_config.function_url) y pg_net, push_notify avisa de forma
--      asíncrona a la Edge Function `push` (code/supabase/functions/push/index.ts), que envía el Web Push con la app cerrada.
--
-- Contenido:
--   1. public.push_config          claves VAPID y dirección de la función. NINGÚN permiso para los clientes (solo service_role).
--   2. public.push_subscriptions   dispositivos suscritos (cada uno ve y borra solo los suyos; se registran con push_subscribe).
--   3. public.push_prefs           preferencias de cada persona (categorías, sonido, silencio) y set_push_prefs.
--   4. public.push_outbox          novedades. Los viajeros leen solo lo que les corresponde; NADIE del cliente escribe.
--   5. Funciones para la web       push_public_key, push_subscribe, set_push_prefs, push_test y, solo administradores,
--                                  push_set_function_url y push_status.
--   6. Funciones internas          push_notify (la usan los disparadores y otras partes), push_claim, push_targets, push_report,
--                                  push_config_get y push_config_init (las usa la Edge Function con service_role).
--   7. Disparadores                foto, comentario, plan, gasto, acceso, juego (batalla de fotos y bingo).
--
-- Categorías (kind): foto, comentario, plan, gasto, acceso (solo administradores), juego, encuentro, bateria y chat (las tres últimas
-- las avisan otras partes llamando a push_notify), más 'alerta' (una alerta urgente del chat de la familia), 'prueba' (el botón
-- «Enviar aviso de prueba») y 'otro'.
-- Las ALERTAS ('alerta') y la prueba ignoran los interruptores por categoría Y el silencio de cada persona (son para «ven aquí» o «necesito
-- ayuda»): solo dejan de llegar a quien no es viajero, a quien ha hecho la alerta y a quien no tiene un dispositivo suscrito. 'alerta' no
-- se puede apagar en set_push_prefs (se ignora esa clave); 'chat' sí.
-- POR DEFECTO ESTÁ TODO ACTIVADO: quien nunca ha abierto Ajustes no tiene fila en push_prefs y recibe todas las categorías con sonido;
-- kinds solo guarda lo que la persona ha apagado (o vuelto a encender) a propósito. Se avisa a TODOS los viajeros menos a quien hizo
-- la acción (exclude_user); si solo hay un destinatario válido, no pasa nada especial.
--
-- CONTRATO con la parte «encuentro»: public.push_notify(p_kind text, p_title text, p_body text, p_url text default null,
--   p_exclude uuid default null, p_urgent boolean default false, p_image_path text default null, p_only uuid[] default null,
--   p_tag text default null, p_admins_only boolean default false, p_dedupe_key text default null, p_dedupe_seconds integer default 0)
--   returns uuid. No cambiar nombres ni tipos. Un `p_kind` desconocido se guarda como 'otro'.
--
-- REGLA DE ORO: un fallo al avisar (sin pg_net, sin dirección, error de red, una tabla rara…) NUNCA revierte ni hace fallar la acción
-- de la persona (subir una foto, comentar…): push_notify y todos los disparadores capturan cualquier error y solo lo anotan como aviso.
--
-- Seguridad:
--   · push_outbox, push_subscriptions y push_prefs: sin INSERT/UPDATE directo para los clientes; todo pasa por funciones.
--   · Las funciones internas no las puede ejecutar ningún cliente (ni authenticated ni anon): solo los disparadores (dueño) y
--     service_role. La Edge Function se despliega SIN verificar el JWT, así que solo puede procesar filas que ya existen en
--     push_outbox (y solo una vez: push_claim) y nunca envía contenido que no haya escrito un disparador o push_test.
--   · Las claves VAPID las genera la propia función la primera vez; la privada no sale nunca de push_config.
--   · La dirección de los dispositivos (endpoint) debe ser una dirección https con nombre de dominio normal (no IP, ni localhost,
--     ni puerto): evita que un viajero apunte al servidor de la función a una dirección interna.

-- ---------- extensión pg_net (para llamar a la función sin esperar) ----------

-- En Supabase suele venir activada. Si no se puede activar aquí, los avisos en pantalla funcionan igual; para los de la app
-- cerrada hay que activarla en Database → Extensions.
do $$
begin
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'avisos.sql: no se pudo activar pg_net (%). Actívala en Database → Extensions para los avisos con la app cerrada.', sqlerrm;
  end;
end
$$;

-- ---------- 1. configuración (solo el servidor) ----------

create table public.push_config (
  id smallint primary key default 1,
  vapid_public text,
  vapid_private text,
  function_url text,
  updated_at timestamptz not null default now(),
  constraint push_config_single check (id = 1),
  constraint push_config_public_check check (vapid_public is null or vapid_public ~ '^[A-Za-z0-9_-]{87}$'),
  constraint push_config_private_check check (vapid_private is null or vapid_private ~ '^[A-Za-z0-9_-]{43}$'),
  constraint push_config_keys_pair check ((vapid_public is null) = (vapid_private is null)),
  constraint push_config_function_url_check check (
    function_url is null
    or (char_length(function_url) <= 300
        and function_url ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}/functions/v1/push$'
        and function_url !~ '\.(internal|local|localhost)/')
  )
);
insert into public.push_config (id) values (1);

-- ---------- 2. dispositivos suscritos ----------

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  constraint push_subscriptions_endpoint_key unique (endpoint),
  -- https con un nombre de dominio normal: ni IP, ni localhost, ni puerto, ni usuario@, ni nombres internos.
  constraint push_subscriptions_endpoint_check check (
    char_length(endpoint) <= 1000
    and endpoint ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}/[^[:space:]]+$'
    and endpoint !~ '^https://[^/]*\.(internal|local|localhost)/'
  ),
  constraint push_subscriptions_p256dh_check check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  constraint push_subscriptions_auth_check check (auth ~ '^[A-Za-z0-9_-]{16,40}$'),
  constraint push_subscriptions_ua_check check (user_agent is null or char_length(user_agent) <= 300)
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ---------- 3. preferencias ----------

-- kinds: solo las categorías que la persona ha apagado o encendido a propósito; lo que no aparece cuenta como activo.
create table public.push_prefs (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  kinds jsonb not null default '{}'::jsonb,
  muted_until timestamptz,
  sound boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint push_prefs_kinds_check check (jsonb_typeof(kinds) = 'object' and pg_column_size(kinds) <= 600)
);

-- ---------- 4. novedades (bandeja de salida y feed) ----------

create table public.push_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  title text not null,
  body text not null default '',
  url text,                      -- solo un enlace interno de la web: «#fotos», «#plan?a=<id>»…
  tag text,                      -- las notificaciones con la misma etiqueta se sustituyen entre sí
  image_path text,               -- miniatura en el bucket privado `photos` (la función crea un enlace firmado)
  urgent boolean not null default false,
  exclude_user uuid,             -- quien lo hizo: no se le avisa a él (no hay clave foránea: es un dato histórico)
  only_users uuid[],             -- si no es nulo, solo estas personas
  admins_only boolean not null default false,
  dedupe_key text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,        -- la función lo está procesando
  sent_at timestamptz,           -- la función terminó (aunque no hubiera nadie a quien enviar)
  sent_count integer,
  error text,
  constraint push_outbox_kind_check check (kind in ('foto', 'comentario', 'plan', 'gasto', 'acceso', 'juego', 'encuentro', 'bateria', 'chat', 'alerta', 'prueba', 'otro')),
  constraint push_outbox_title_check check (char_length(title) between 1 and 120),
  constraint push_outbox_body_check check (char_length(body) <= 300),
  constraint push_outbox_url_check check (url ~ '^#[a-z0-9_-]{1,30}(\?[a-z0-9_]{1,10}=[A-Za-z0-9_-]{1,64})?$'),
  constraint push_outbox_tag_check check (char_length(tag) <= 80),
  constraint push_outbox_image_check check (char_length(image_path) <= 300 and image_path !~ '(^/|\.\.|[[:cntrl:]])'),
  constraint push_outbox_dedupe_check check (char_length(dedupe_key) <= 120),
  constraint push_outbox_error_check check (char_length(error) <= 300)
);
create index push_outbox_created_idx on public.push_outbox (created_at desc);
create index push_outbox_dedupe_idx on public.push_outbox (dedupe_key, created_at desc) where dedupe_key is not null;

-- ---------- permisos y RLS ----------

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
revoke all on public.push_config, public.push_subscriptions, public.push_prefs, public.push_outbox from anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;   -- se crean con push_subscribe; no se editan
grant select on public.push_prefs to authenticated;                   -- se escriben con set_push_prefs
grant select on public.push_outbox to authenticated;                  -- nadie escribe: lo hacen los disparadores
alter table public.push_config enable row level security;             -- sin políticas ni permisos: nadie del cliente la ve
alter table public.push_subscriptions enable row level security;
alter table public.push_prefs enable row level security;
alter table public.push_outbox enable row level security;

-- Cada uno ve y borra solo sus dispositivos (aunque ya no sea viajero: para poder borrar su rastro; un DELETE con WHERE solo
-- alcanza las filas que la política de lectura deja ver).
create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());
create policy push_prefs_select on public.push_prefs
  for select to authenticated using (user_id = auth.uid());

-- Las novedades las leen los viajeros, salvo lo que hizo uno mismo, lo dirigido a otras personas y lo de administradores.
create policy push_outbox_select on public.push_outbox
  for select to authenticated
  using (
    public.is_member()
    and exclude_user is distinct from auth.uid()
    and (only_users is null or auth.uid() = any (only_users))
    and (not admins_only or public.is_admin())
  );

-- ---------- ayudas internas ----------

-- Texto de una sola línea: espacios y saltos repetidos pasan a uno, sin espacios en los extremos y, si no cabe, termina en «…».
create or replace function public.push_clip(p_text text, p_max integer)
returns text
language sql immutable set search_path = public
as $$
  select case when char_length(t) > p_max then rtrim(left(t, greatest(p_max - 1, 1))) || '…' else t end
  from (select btrim(regexp_replace(coalesce(p_text, ''), '[[:space:][:cntrl:]]+', ' ', 'g')) as t) x;
$$;
revoke all on function public.push_clip(text, integer) from public, anon, authenticated;

-- Nombre de una persona para los textos: recortado y, si no hay, «Alguien».
create or replace function public.push_person(p_name text)
returns text
language sql immutable set search_path = public
as $$
  select coalesce(nullif(public.push_clip(p_name, 40), ''), 'Alguien');
$$;
revoke all on function public.push_person(text) from public, anon, authenticated;

-- «21 dic».
create or replace function public.push_day(p_day date)
returns text
language sql immutable set search_path = public
as $$
  select case when p_day is null then ''
    else extract(day from p_day)::int || ' ' || (array['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'])[extract(month from p_day)::int] end;
$$;
revoke all on function public.push_day(date) from public, anon, authenticated;

-- Importe sin moneda (la base de datos no conoce la moneda del viaje): «45» o «45,50».
create or replace function public.push_amount(p_amount numeric)
returns text
language sql immutable set search_path = public
as $$
  select case when p_amount is null then ''
    when p_amount = trunc(p_amount) then trunc(p_amount)::text
    else replace(to_char(p_amount, 'FM999999990.00'), '.', ',') end;
$$;
revoke all on function public.push_amount(numeric) from public, anon, authenticated;

-- ---------- push_notify: la función que escribe una novedad y avisa a la Edge Function ----------

-- Devuelve el id de la novedad (o el de la ya existente si se coalesce), o null si no se pudo crear. NUNCA lanza un error.
--  · p_dedupe_key y p_dedupe_seconds: si ya hay una novedad con esa clave de hace menos de p_dedupe_seconds segundos no se crea otra
--    (así 10 fotos seguidas son un solo aviso).
--  · p_exclude: a quién NO avisar (quien lo hizo). p_only: solo a esas personas. p_admins_only: solo a administradores.
--  · p_url: solo enlaces internos de la web («#fotos», «#plan?a=<id>»); otra cosa se guarda como nulo.
create or replace function public.push_notify(
  p_kind text,
  p_title text,
  p_body text,
  p_url text default null,
  p_exclude uuid default null,
  p_urgent boolean default false,
  p_image_path text default null,
  p_only uuid[] default null,
  p_tag text default null,
  p_admins_only boolean default false,
  p_dedupe_key text default null,
  p_dedupe_seconds integer default 0
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_kind text;
  v_title text;
  v_body text;
  v_url text;
  v_tag text;
  v_image text;
  v_key text;
  v_id uuid;
  v_function text;
begin
  -- Bloque externo: pase lo que pase, quien llama (un disparador o una función) sigue adelante.
  begin
    v_kind := case when p_kind in ('foto', 'comentario', 'plan', 'gasto', 'acceso', 'juego', 'encuentro', 'bateria', 'chat', 'alerta', 'prueba') then p_kind else 'otro' end;
    v_title := public.push_clip(p_title, 120);
    if v_title = '' then
      return null;
    end if;
    v_body := public.push_clip(p_body, 300);
    v_url := case when p_url ~ '^#[a-z0-9_-]{1,30}(\?[a-z0-9_]{1,10}=[A-Za-z0-9_-]{1,64})?$' then p_url end;
    v_tag := nullif(left(public.push_clip(p_tag, 80), 80), '');
    v_image := case when p_image_path is not null and char_length(p_image_path) <= 300 and p_image_path !~ '(^/|\.\.|[[:cntrl:]])' then p_image_path end;
    v_key := nullif(left(btrim(coalesce(p_dedupe_key, '')), 120), '');

    -- Coalescer ráfagas: dentro de la ventana no se crea otra novedad con la misma clave. El candado evita que dos transacciones
    -- simultáneas pasen la comprobación a la vez.
    if v_key is not null and coalesce(p_dedupe_seconds, 0) > 0 then
      perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
      select o.id into v_id
      from public.push_outbox o
      where o.dedupe_key = v_key and o.created_at > now() - make_interval(secs => least(p_dedupe_seconds, 86400))
      order by o.created_at desc
      limit 1;
      if v_id is not null then
        return v_id;
      end if;
    end if;

    insert into public.push_outbox (kind, title, body, url, tag, image_path, urgent, exclude_user, only_users, admins_only, dedupe_key)
    values (v_kind, v_title, v_body, v_url, v_tag, v_image, coalesce(p_urgent, false), p_exclude, p_only, coalesce(p_admins_only, false), v_key)
    returning id into v_id;

    -- Limpieza: las novedades de más de 30 días ya no hacen falta.
    delete from public.push_outbox where created_at < now() - interval '30 days';

    -- Avisar a la Edge Function (asíncrono). Si falla, la novedad queda igualmente para el feed y se anota el motivo.
    select c.function_url into v_function from public.push_config c where c.id = 1;
    if v_function is not null and exists (select 1 from public.push_subscriptions) then
      begin
        perform net.http_post(
          url := v_function,
          body := jsonb_build_object('outbox_id', v_id),
          headers := '{"Content-Type": "application/json"}'::jsonb,
          timeout_milliseconds := 5000
        );
      exception when others then
        raise warning 'push_notify: no se pudo llamar a la función de avisos: %', sqlerrm;
        update public.push_outbox set error = public.push_clip('No se pudo llamar a la función: ' || sqlerrm, 300) where id = v_id;
      end;
    end if;
    return v_id;
  exception when others then
    raise warning 'push_notify: %', sqlerrm;
    return null;
  end;
end;
$$;
revoke all on function public.push_notify(text, text, text, text, uuid, boolean, text, uuid[], text, boolean, text, integer) from public, anon, authenticated;

-- ---------- funciones para la Edge Function (service_role) ----------

-- Las claves VAPID. Si todavía no existen devuelve nulos.
create or replace function public.push_config_get()
returns table (vapid_public text, vapid_private text)
language sql stable security definer set search_path = public
as $$
  select c.vapid_public, c.vapid_private from public.push_config c where c.id = 1;
$$;
revoke all on function public.push_config_get() from public, anon, authenticated;

-- Guarda las claves recién generadas SOLO si aún no había (varias llamadas a la vez no se pisan) y devuelve las que valen.
create or replace function public.push_config_init(p_public text, p_private text)
returns table (vapid_public text, vapid_private text)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
begin
  insert into public.push_config as c (id, vapid_public, vapid_private)
  values (1, p_public, p_private)
  on conflict (id) do update
    set vapid_public = excluded.vapid_public, vapid_private = excluded.vapid_private, updated_at = now()
    where c.vapid_public is null;
  return query select c2.vapid_public, c2.vapid_private from public.push_config c2 where c2.id = 1;
end;
$$;
revoke all on function public.push_config_init(text, text) from public, anon, authenticated;

-- Reserva una novedad para enviarla: solo si existe, no se envió, es de las últimas 24 h y nadie la está procesando (la reserva
-- caduca a los 2 minutos por si la función se interrumpió). Devuelve la fila o nada: así un segundo aviso no duplica el envío.
create or replace function public.push_claim(p_outbox uuid)
returns table (id uuid, kind text, title text, body text, url text, tag text, image_path text, urgent boolean, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
begin
  return query
    update public.push_outbox o set claimed_at = now()
    where o.id = p_outbox
      and o.sent_at is null
      and o.created_at > now() - interval '1 day'
      and (o.claimed_at is null or o.claimed_at < now() - interval '2 minutes')
    returning o.id, o.kind, o.title, o.body, o.url, o.tag, o.image_path, o.urgent, o.created_at;
end;
$$;
revoke all on function public.push_claim(uuid) from public, anon, authenticated;

-- Los dispositivos que deben recibir una novedad: de viajeros actuales, sin quien la hizo, respetando «solo para», «solo
-- administradores», las categorías apagadas y el silencio de cada persona (la prueba se entrega siempre), y como mucho los 5
-- dispositivos más recientes de cada persona.
create or replace function public.push_targets(p_outbox uuid)
returns table (endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public
as $$
  with o as (
    select * from public.push_outbox where id = p_outbox and sent_at is null
  ),
  cand as (
    select s.endpoint, s.p256dh, s.auth,
           row_number() over (partition by s.user_id order by coalesce(s.last_ok_at, s.created_at) desc, s.id) as rn
    from o
    join public.push_subscriptions s on true
    join auth.users u on u.id = s.user_id
    join public.members m on m.email = lower(u.email)
    left join public.push_prefs p on p.user_id = s.user_id
    where s.user_id is distinct from o.exclude_user
      and (o.only_users is null or s.user_id = any (o.only_users))
      and (not o.admins_only or m.is_admin)
      and (
        o.kind in ('prueba', 'alerta')
        or ((p.kinds ->> o.kind) is distinct from 'false' and (p.muted_until is null or p.muted_until <= now()))
      )
  )
  select c.endpoint, c.p256dh, c.auth from cand c where c.rn <= 5;
$$;
revoke all on function public.push_targets(uuid) from public, anon, authenticated;

-- Resultado del envío: marca la novedad como enviada, borra los dispositivos que ya no existen (404/410) y anota los que
-- respondieron bien.
create or replace function public.push_report(p_outbox uuid, p_sent integer, p_gone text[] default null, p_error text default null, p_ok text[] default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.push_outbox
    set sent_at = now(),
        sent_count = greatest(coalesce(p_sent, 0), 0),
        error = nullif(public.push_clip(p_error, 300), '')
    where id = p_outbox;
  if p_gone is not null and cardinality(p_gone) > 0 then
    delete from public.push_subscriptions where endpoint = any (p_gone);
  end if;
  if p_ok is not null and cardinality(p_ok) > 0 then
    update public.push_subscriptions set last_ok_at = now() where endpoint = any (p_ok);
  end if;
end;
$$;
revoke all on function public.push_report(uuid, integer, text[], text, text[]) from public, anon, authenticated;

-- ---------- funciones para la web ----------

-- La clave pública VAPID (nula si la Edge Function aún no la ha generado: entonces la web se la pide a la función).
create or replace function public.push_public_key()
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_key text;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select c.vapid_public into v_key from public.push_config c where c.id = 1;
  return v_key;
end;
$$;
revoke all on function public.push_public_key() from public, anon;
grant execute on function public.push_public_key() to authenticated;

-- Guarda (o actualiza) el dispositivo de quien llama. Si el mismo navegador ya estaba registrado por otra persona (un móvil
-- compartido), pasa a ser de quien llama. Como mucho 5 dispositivos por persona: se borran los más antiguos.
create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_endpoint text := btrim(coalesce(p_endpoint, ''));
  v_p256dh text := btrim(coalesce(p_p256dh, ''));
  v_auth text := btrim(coalesce(p_auth, ''));
  v_id uuid;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if char_length(v_endpoint) > 1000
     or v_endpoint !~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}/[^[:space:]]+$'
     or v_endpoint ~ '^https://[^/]*\.(internal|local|localhost)/' then
    raise exception 'La dirección del dispositivo no es válida' using errcode = '22023';
  end if;
  if v_p256dh !~ '^[A-Za-z0-9_-]{80,100}$' or v_auth !~ '^[A-Za-z0-9_-]{16,40}$' then
    raise exception 'Las claves del dispositivo no son válidas' using errcode = '22023';
  end if;

  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, v_endpoint, v_p256dh, v_auth, nullif(public.push_clip(p_user_agent, 300), ''))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, created_at = now(), last_ok_at = null
  returning s.id into v_id;

  delete from public.push_subscriptions d
  where d.user_id = v_uid
    and d.id not in (select k.id from public.push_subscriptions k where k.user_id = v_uid order by k.created_at desc, k.id limit 5);
  return v_id;
end;
$$;
revoke all on function public.push_subscribe(text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text) to authenticated;

-- Guarda TODAS las preferencias de quien llama (la web manda siempre el conjunto completo):
--   p_kinds        objeto {categoría: true|false}. Solo valen las categorías conocidas y los valores true/false; lo demás se ignora.
--   p_sound        sonido de las alertas dentro de la app (nulo = sí).
--   p_muted_until  silenciar hasta esa hora (nulo o pasada = no silenciado; como mucho 31 días).
-- Devuelve lo guardado.
create or replace function public.set_push_prefs(p_kinds jsonb default null, p_sound boolean default null, p_muted_until timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_kinds jsonb;
  v_muted timestamptz;
  v_sound boolean := coalesce(p_sound, true);
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_kinds is not null and jsonb_typeof(p_kinds) <> 'object' then
    raise exception 'Las preferencias no son válidas' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_kinds
  from jsonb_each(coalesce(p_kinds, '{}'::jsonb)) e
  where e.key in ('foto', 'comentario', 'plan', 'gasto', 'acceso', 'juego', 'encuentro', 'bateria', 'chat')
    and jsonb_typeof(e.value) = 'boolean';
  v_muted := case when p_muted_until is null or p_muted_until <= now() then null else least(p_muted_until, now() + interval '31 days') end;

  insert into public.push_prefs as p (user_id, kinds, muted_until, sound, updated_at)
  values (v_uid, v_kinds, v_muted, v_sound, now())
  on conflict (user_id) do update
    set kinds = excluded.kinds, muted_until = excluded.muted_until, sound = excluded.sound, updated_at = now();
  return jsonb_build_object('kinds', v_kinds, 'muted_until', v_muted, 'sound', v_sound);
end;
$$;
revoke all on function public.set_push_prefs(jsonb, boolean, timestamptz) from public, anon;
grant execute on function public.set_push_prefs(jsonb, boolean, timestamptz) to authenticated;

-- Crea un aviso de prueba SOLO para quien llama (con espera entre pruebas). Devuelve el id de la novedad; la web puede leerla
-- para ver si se envió (sent_at, sent_count, error).
create or replace function public.push_test()
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if exists (select 1 from public.push_outbox o where o.kind = 'prueba' and o.only_users = array[v_uid] and o.created_at > now() - interval '8 seconds') then
    raise exception 'Espera unos segundos antes de enviar otra prueba' using errcode = '53400';
  end if;
  v_id := public.push_notify('prueba', '🔔 Aviso de prueba', 'Si lo ves, los avisos funcionan en este móvil.', null, null, false, null, array[v_uid], 'prueba', false, null, 0);
  if v_id is null then
    raise exception 'No se pudo crear el aviso de prueba';
  end if;
  return v_id;
end;
$$;
revoke all on function public.push_test() from public, anon;
grant execute on function public.push_test() to authenticated;

-- Registra la dirección de la Edge Function (solo administradores). Tiene que ser https://<dominio>/functions/v1/push. Nulo o vacío
-- la quita (los avisos con la app cerrada dejan de enviarse; los de pantalla siguen).
create or replace function public.push_set_function_url(p_url text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_url is not null and (
       char_length(v_url) > 300
       or v_url !~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}/functions/v1/push$'
       or v_url ~ '\.(internal|local|localhost)/') then
    raise exception 'La dirección tiene que ser https://tu-proyecto.supabase.co/functions/v1/push' using errcode = '22023';
  end if;
  insert into public.push_config as c (id, function_url) values (1, v_url)
  on conflict (id) do update set function_url = excluded.function_url, updated_at = now();
end;
$$;
revoke all on function public.push_set_function_url(text) from public, anon;
grant execute on function public.push_set_function_url(text) to authenticated;

-- Estado de los avisos para quien administra: qué falta y cómo van los últimos envíos. Nunca devuelve la clave privada.
create or replace function public.push_status()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_cfg public.push_config;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into v_cfg from public.push_config where id = 1;
  return jsonb_build_object(
    'has_keys', coalesce(v_cfg.vapid_public is not null, false),
    'function_url', v_cfg.function_url,
    'pg_net', to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null,
    'devices', (select count(*) from public.push_subscriptions),
    'people', (select count(distinct user_id) from public.push_subscriptions),
    'members', (select count(*) from public.members),
    'sent_24h', (select count(*) from public.push_outbox where sent_at is not null and coalesce(sent_count, 0) > 0 and created_at > now() - interval '1 day'),
    'errors_24h', (select count(*) from public.push_outbox where error is not null and created_at > now() - interval '1 day'),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('kind', r.kind, 'title', r.title, 'created_at', r.created_at, 'sent_at', r.sent_at, 'sent_count', r.sent_count, 'error', r.error) order by r.created_at desc)
      from (select * from public.push_outbox order by created_at desc limit 5) r
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.push_status() from public, anon;
grant execute on function public.push_status() to authenticated;

-- ---------- disparadores ----------
-- Todos son AFTER INSERT (o UPDATE de estado), security definer y a prueba de fallos: cualquier error (también uno al preparar los
-- textos) se queda en un aviso y la acción de la persona sigue su curso. Por eso NADA se calcula en el bloque `declare` (un error ahí
-- no lo recoge el `exception` de la propia función): todo va dentro del cuerpo. Leen las columnas con to_jsonb(new) para no depender de
-- que existan las partes opcionales (compras, adjuntos…). A quién llegan lo decide push_notify/push_targets: a todos los viajeros menos
-- a quien lo hizo (p_exclude = el autor).

-- Foto nueva (no los tickets de compra). Diez fotos seguidas de la misma persona son un solo aviso (3 minutos).
create or replace function public.push_on_photo()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
begin
  r := to_jsonb(new);
  if r ->> 'expense_id' is not null then
    return new;
  end if;
  perform public.push_notify('foto', '📷 ' || public.push_person(r ->> 'created_by_name') || ' subió fotos nuevas', 'Toca para verlas', '#fotos',
    (r ->> 'created_by')::uuid, false, r ->> 'thumb_path', null, 'foto', false,
    'foto:' || coalesce(r ->> 'created_by', r ->> 'created_by_name', ''), 180);
  return new;
exception when others then
  raise warning 'avisos (foto): %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.push_on_photo() from public, anon, authenticated;

-- Comentario nuevo, sobre una actividad o sobre una foto, y si es una respuesta o lleva foto o nota de voz.
create or replace function public.push_on_comment()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  v_name text;
  v_text text;
  v_reply boolean;
  v_photo boolean;
  v_audio boolean;
  v_title text;
  v_extra text;
  v_body text;
  v_url text;
  v_tag text;
  v_image text;
  v_activity text;
begin
  r := to_jsonb(new);
  v_name := public.push_person(r ->> 'created_by_name');
  v_text := public.push_clip(r ->> 'body', 140);
  v_reply := r ->> 'reply_to' is not null;
  v_photo := r ->> 'attached_photo' is not null;
  v_audio := r ->> 'attached_audio' is not null;
  if r ->> 'activity_id' is not null then
    select public.push_clip(a.title, 40) into v_activity from public.activities a where a.id = (r ->> 'activity_id')::uuid;
    v_title := '💬 ' || v_name || case when v_reply then ' respondió' else '' end || ' en «' || coalesce(v_activity, 'una actividad') || '»';
    v_url := '#plan?a=' || (r ->> 'activity_id');
    v_tag := 'comentario-' || (r ->> 'activity_id');
  else
    v_title := '💬 ' || v_name || case when v_reply then ' respondió en una foto' else ' comentó una foto' end;
    v_url := '#fotos';
    v_tag := 'comentario-' || coalesce(r ->> 'on_photo', 'foto');
    select p.thumb_path into v_image from public.photos p where p.id = (r ->> 'on_photo')::uuid;
  end if;
  if v_photo then
    select p.thumb_path into v_image from public.photos p where p.id = (r ->> 'attached_photo')::uuid;
  end if;
  v_extra := case when v_photo and v_audio then 'con una foto y una nota de voz' when v_photo then 'con una foto' when v_audio then 'con una nota de voz' else '' end;
  v_body := case
    when v_text <> '' and v_extra <> '' then v_text || ' (' || v_extra || ')'
    when v_text <> '' then v_text
    when v_extra <> '' then upper(left(v_extra, 1)) || substr(v_extra, 2)
    else '' end;
  perform public.push_notify('comentario', v_title, v_body, v_url, (r ->> 'created_by')::uuid, false, v_image, null, v_tag);
  return new;
exception when others then
  raise warning 'avisos (comentario): %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.push_on_comment() from public, anon, authenticated;

-- Actividad nueva en el plan. Varias seguidas de la misma persona (30 s) son un solo aviso.
create or replace function public.push_on_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
begin
  r := to_jsonb(new);
  perform public.push_notify('plan',
    '🗓️ ' || public.push_person(r ->> 'created_by_name') || ' añadió «' || public.push_clip(r ->> 'title', 50) || '» · ' || public.push_day((r ->> 'day')::date),
    public.push_clip(coalesce(left(r ->> 'start_time', 5) || ' ', '') || coalesce(r ->> 'place', ''), 120),
    '#plan?a=' || (r ->> 'id'), (r ->> 'created_by')::uuid, false, null, null, 'plan', false,
    'plan:' || coalesce(r ->> 'created_by', r ->> 'created_by_name', ''), 30);
  return new;
exception when others then
  raise warning 'avisos (plan): %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.push_on_activity() from public, anon, authenticated;

-- Gasto o compra nuevos. El importe va sin moneda (la base de datos no la conoce). Varios seguidos (20 s), un solo aviso.
create or replace function public.push_on_expense()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  v_purchase boolean;
  v_people integer;
  v_body text;
begin
  r := to_jsonb(new);
  v_purchase := r ->> 'kind' = 'compra';
  v_people := coalesce(jsonb_array_length(r -> 'split'), 0);
  v_body := public.push_clip(
    case when v_purchase and nullif(btrim(coalesce(r ->> 'place', '')), '') is not null then (r ->> 'place') || ' · ' else '' end
    || 'Pagó ' || public.push_person(r ->> 'paid_by') || case when v_people > 1 then ' · entre ' || v_people else '' end, 120);
  perform public.push_notify('gasto',
    case when v_purchase then '🛒 ' || public.push_person(r ->> 'created_by_name') || ' apuntó la compra «'
         else '💸 ' || public.push_person(r ->> 'created_by_name') || ' apuntó «' end
      || public.push_clip(r ->> 'title', 50) || '» · ' || public.push_amount((r ->> 'amount')::numeric),
    v_body, '#cuentas', (r ->> 'created_by')::uuid, false, null, null, 'gasto', false,
    'gasto:' || coalesce(r ->> 'created_by', r ->> 'created_by_name', ''), 20);
  return new;
exception when others then
  raise warning 'avisos (gasto): %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.push_on_expense() from public, anon, authenticated;

-- Solicitud de acceso nueva (o reabierta): solo a los administradores. Cada persona (correo) avisa como mucho una vez cada 10 minutos.
create or replace function public.push_on_access_request()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  v_name text;
begin
  r := to_jsonb(new);
  if r ->> 'status' <> 'pending' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(old) ->> 'status') is not distinct from (r ->> 'status') then
      return new;
    end if;
  end if;
  v_name := coalesce(nullif(public.push_clip(r ->> 'name', 40), ''), nullif(public.push_clip(split_part(r ->> 'email', '@', 1), 40), ''), 'Alguien');
  perform public.push_notify('acceso', '🔑 ' || v_name || ' pide entrar', 'Aprueba o rechaza su solicitud', '#acceso', null, false, null, null,
    'acceso-' || left(md5(coalesce(r ->> 'email', v_name)), 8), true, 'acceso:' || coalesce(r ->> 'email', v_name), 600);
  return new;
exception when others then
  raise warning 'avisos (acceso): %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.push_on_access_request() from public, anon, authenticated;

-- Batalla de fotos: reto nuevo, empieza la votación, resultado.
create or replace function public.push_on_battle()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  v_prompt text;
begin
  r := to_jsonb(new);
  v_prompt := public.push_clip(r ->> 'prompt', 90);
  if tg_op = 'INSERT' then
    perform public.push_notify('juego', '📸 ¡Reto de foto! ' || v_prompt, 'Lanzado por ' || public.push_person(r ->> 'created_by_name') || ' · haz tu foto en Juegos',
      '#juegos', (r ->> 'created_by')::uuid, false, null, null, 'batalla-' || (r ->> 'id'));
  elsif (to_jsonb(old) ->> 'status') is distinct from (r ->> 'status') then
    if r ->> 'status' = 'voting' then
      perform public.push_notify('juego', '🗳️ ¡Toca votar!', v_prompt, '#juegos', auth.uid(), false, null, null, 'batalla-' || (r ->> 'id'));
    elsif r ->> 'status' = 'done' then
      perform public.push_notify('juego', '🏆 Resultado de la batalla', v_prompt, '#juegos', auth.uid(), false, null, null, 'batalla-' || (r ->> 'id'));
    end if;
  end if;
  return new;
exception when others then
  raise warning 'avisos (batalla): %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.push_on_battle() from public, anon, authenticated;

-- Bingo: «marcó un reto» (varias seguidas, un aviso por minuto), «¡hizo LÍNEA!» y «¡BINGO!» (cartón lleno, urgente).
create or replace function public.push_on_bingo_mark()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r jsonb;
  v_name text;
  v_user uuid;
  v_cell integer;
  v_marks integer;
  v_lines integer;
  v_text text;
begin
  r := to_jsonb(new);
  v_name := public.push_person(r ->> 'name');
  v_user := (r ->> 'user_id')::uuid;
  v_cell := (r ->> 'cell')::integer;
  select count(*) into v_marks from public.bingo_marks m where m.user_id = v_user;
  -- Líneas completas que incluyen la casilla recién marcada (5 filas, 5 columnas y 2 diagonales).
  select count(*) into v_lines
  from (values
    (array[0, 1, 2, 3, 4]), (array[5, 6, 7, 8, 9]), (array[10, 11, 12, 13, 14]), (array[15, 16, 17, 18, 19]), (array[20, 21, 22, 23, 24]),
    (array[0, 5, 10, 15, 20]), (array[1, 6, 11, 16, 21]), (array[2, 7, 12, 17, 22]), (array[3, 8, 13, 18, 23]), (array[4, 9, 14, 19, 24]),
    (array[0, 6, 12, 18, 24]), (array[4, 8, 12, 16, 20])
  ) l (cells)
  where v_cell = any (l.cells)
    and (select count(*) from public.bingo_marks m where m.user_id = v_user and m.cell = any (l.cells)) = 5;

  if v_marks >= 25 then
    perform public.push_notify('juego', '🎉 ¡BINGO! ' || v_name || ' completó el cartón', 'Mira el cartón en Juegos', '#juegos', v_user, true, r ->> 'thumb_path', null,
      'bingo-' || v_user::text, false, 'bingo-lleno:' || v_user::text, 3600);
  elsif v_lines > 0 then
    perform public.push_notify('juego', '🎉 ¡' || v_name || ' hizo LÍNEA!', 'Mira el cartón en Juegos', '#juegos', v_user, false, r ->> 'thumb_path', null,
      'bingo-' || v_user::text, false, 'bingo-linea:' || v_user::text, 600);
  else
    select public.push_clip(c.text, 90) into v_text from public.bingo_cells c where c.idx = v_cell;
    perform public.push_notify('juego', '🎯 ' || v_name || ' marcó un reto', coalesce(v_text, ''), '#juegos', v_user, false, r ->> 'thumb_path', null,
      'bingo-' || v_user::text, false, 'bingo:' || v_user::text, 60);
  end if;
  return new;
exception when others then
  raise warning 'avisos (bingo): %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.push_on_bingo_mark() from public, anon, authenticated;

-- Engancha cada disparador a su tabla SI EXISTE (se puede repetir sin problema). Devuelve las tablas enganchadas. Solo se ejecuta
-- desde el SQL Editor (ningún cliente puede): `select public.push_install_triggers();`
create or replace function public.push_install_triggers()
returns text
language plpgsql set search_path = public
as $$
declare
  v record;
  v_done text[] := '{}';
begin
  for v in
    select * from (values
      ('photos', 'push_notify_photo', 'after insert', 'push_on_photo'),
      ('comments', 'push_notify_comment', 'after insert', 'push_on_comment'),
      ('activities', 'push_notify_activity', 'after insert', 'push_on_activity'),
      ('expenses', 'push_notify_expense', 'after insert', 'push_on_expense'),
      ('access_requests', 'push_notify_access_request', 'after insert or update of status', 'push_on_access_request'),
      ('battles', 'push_notify_battle', 'after insert or update of status', 'push_on_battle'),
      ('bingo_marks', 'push_notify_bingo_mark', 'after insert', 'push_on_bingo_mark')
    ) t (tbl, trg, ev, fn)
  loop
    if to_regclass('public.' || v.tbl) is not null then
      if exists (select 1 from pg_trigger g where g.tgname = v.trg and g.tgrelid = to_regclass('public.' || v.tbl)) then
        execute format('drop trigger %I on public.%I', v.trg, v.tbl);
      end if;
      execute format('create trigger %I %s on public.%I for each row execute function public.%I()', v.trg, v.ev, v.tbl, v.fn);
      v_done := array_append(v_done, v.tbl);
    end if;
  end loop;
  return array_to_string(v_done, ', ');
end;
$$;
revoke all on function public.push_install_triggers() from public, anon, authenticated;

select public.push_install_triggers();

-- ---------- service_role (la Edge Function) y tiempo real ----------

-- En Supabase existe el rol service_role (la Edge Function lo usa) y ya suele tener estos permisos; se conceden de forma explícita
-- por si el proyecto no los da por defecto. Si el rol no existe (una base sin Supabase) no se hace nada.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.push_config, public.push_subscriptions, public.push_prefs, public.push_outbox to service_role;
    grant execute on function public.push_config_get() to service_role;
    grant execute on function public.push_config_init(text, text) to service_role;
    grant execute on function public.push_claim(uuid) to service_role;
    grant execute on function public.push_targets(uuid) to service_role;
    grant execute on function public.push_report(uuid, integer, text[], text, text[]) to service_role;
  end if;
end
$$;

-- Las novedades llegan en directo (Realtime respeta la política de lectura de arriba: cada uno recibe solo las suyas).
alter publication supabase_realtime add table public.push_outbox;
$parte_avisos$;
  else
    raise notice 'avisos.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- bateria.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'presence' and column_name = 'battery') then
    raise notice 'Aplicando bateria.sql...';
    execute $parte_bateria$
-- Batería de los viajeros (opcional). Ejecutar en Supabase → SQL Editor DESPUÉS de presencia.sql (añade columnas a
-- public.presence). Una sola vez; el todo en uno solo lo aplica si todavía falta la columna `presence.battery`.
--
-- Qué hace: junto con su latido de «estoy en línea» (cada ~45 s), cada móvil envía su nivel de batería y si está cargando.
-- Los demás viajeros lo ven en el panel de personas («Ana · 🔋 23 %») y, cuando la batería de alguien baja del 20 %, a
-- todos les llega un aviso («🔋 Ana tiene poca batería»), para que el grupo se entere antes de que se apague el móvil.
--
-- Limitaciones honestas:
--   · Los navegadores solo dejan leer la batería en Chrome/Edge (Android y escritorio). Safari (iPhone) y Firefox NO lo
--     permiten: en esos móviles la columna queda vacía y la web lo dice con claridad.
--   · La batería sale del propio móvil, que la envía mientras la web está abierta: no es una garantía, es un dato aproximado.
--   · Quien no quiera compartirla la desactiva en su panel de personas; entonces se envía vacío (null).
--
-- Contenido:
--   1. presence.battery   nivel de 0 a 100 (null = no se comparte o no se puede leer).
--      presence.charging  true si está cargando (null = desconocido).
--   2. Permisos: solo estas dos columnas se añaden al INSERT y al UPDATE por columnas que ya tenía `presence`.
--   3. Aviso de batería baja: disparador sobre `presence` que, al cruzar el 20 % (o el 10 %) hacia abajo sin estar
--      cargando, pide un aviso a todos los demás con public.push_notify (de avisos.sql) SI existe. Es opcional y
--      nunca puede romper el latido: cualquier fallo al avisar se descarta con un warning.

-- ---------- 1. columnas ----------

alter table public.presence
  add column battery smallint check (battery between 0 and 100),
  add column charging boolean;

-- ---------- 2. permisos ----------

-- presencia.sql concede a `authenticated` INSERT y UPDATE solo en (user_id, name): el upsert de PostgREST necesita las dos
-- columnas en los dos sitios. Se añaden las dos nuevas igual. `last_seen` sigue sin ser escribible (la pone su disparador).
-- Las políticas de presence no cambian: cada uno solo escribe SU fila.
grant insert (battery, charging) on public.presence to authenticated;
grant update (battery, charging) on public.presence to authenticated;

-- ---------- 3. aviso de batería baja ----------

-- Al cruzar hacia abajo el 20 % (aviso normal) o el 10 % (aviso más serio) sin estar cargando. «Cruzar» significa que la
-- lectura anterior estaba por encima del umbral (o no existía): así una batería que se queda en el 15 % no repite el aviso
-- en cada latido. Además, push_notify agrupa avisos repetidos de la misma persona (dos horas por umbral).
-- Se ejecuta como dueño (security definer) porque push_notify no la puede llamar un viajero, y se envuelve en un bloque de
-- excepciones: un fallo al avisar (push_notify ausente, pg_net caído…) nunca debe impedir guardar el latido.
create or replace function public.presence_battery_alert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_low int;
  v_title text;
  v_who text := coalesce(nullif(btrim(new.name), ''), 'Un viajero');
begin
  if new.battery is null or coalesce(new.charging, false) then
    return new;
  end if;

  if new.battery <= 10 and (tg_op = 'INSERT' or old.battery is null or old.battery > 10 or coalesce(old.charging, false)) then
    v_low := 10;
    v_title := '🪫 ' || v_who || ' casi se queda sin batería (' || new.battery || ' %)';
  elsif new.battery <= 20 and (tg_op = 'INSERT' or old.battery is null or old.battery > 20 or coalesce(old.charging, false)) then
    v_low := 20;
    v_title := '🔋 ' || v_who || ' tiene poca batería (' || new.battery || ' %)';
  else
    return new;
  end if;

  begin
    -- Solo si avisos.sql está instalado; con otra firma o sin la función, no se avisa y listo.
    if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is not null then
      perform public.push_notify(
        'bateria', v_title, 'Quizá necesite un cargador. Toca para ver dónde está.', '#mapa',
        new.user_id, false, null, null, 'bateria-' || new.user_id::text || '-' || v_low, false,
        'bateria-' || new.user_id::text || '-' || v_low, 7200
      );
    end if;
  exception when others then
    raise warning 'presence_battery_alert: no se pudo avisar (%): %', sqlstate, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.presence_battery_alert() from public, anon, authenticated;

create trigger presence_battery_alert
  after insert or update of battery, charging on public.presence
  for each row
  when (new.battery is not null and new.battery <= 20)
  execute function public.presence_battery_alert();
$parte_bateria$;
  else
    raise notice 'bateria.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- chat.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.chat_messages') is null then
    raise notice 'Aplicando chat.sql...';
    execute $parte_chat$
-- Chat de la familia con alertas. Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql, fotos.sql y adjuntos.sql (usa
-- public.is_member(), public.photos y public.audios). Una sola vez; el todo en uno solo lo aplica si falta public.chat_messages.
-- No depende de avisos.sql: si está instalado, los mensajes y las alertas además llegan como notificación (public.push_notify);
-- si no, el chat funciona igual y se actualiza en directo con la web abierta.
--
-- Qué hay:
--   · Mensajes de texto, con una foto y/o una nota de voz opcionales (las mismas que ya se suben a las fotos y los audios del viaje).
--   · ALERTAS: un mensaje especial («ven aquí», «necesito ayuda») que hace sonar el móvil de todos (o de las personas elegidas) y
--     que cada destinatario confirma con «Entendido»; quien la envió ve quién la ha visto. Solo se envían con send_alert(), que
--     limita cuántas puede mandar cada persona (no es una barra libre para bromas).
--
-- Contenido:
--   1. public.chat_messages  los mensajes. Los de texto se insertan directamente (con RLS); las alertas, SOLO con send_alert().
--   2. public.chat_acks      quién ha confirmado cada alerta.
--   3. public.send_alert()   crea la alerta, limita el ritmo y pide el aviso a los demás.
--   4. Avisos de mensajes nuevos (si avisos.sql está) y limpieza de mensajes que se quedan vacíos al borrar su foto o su audio.
--
-- Privacidad: los viajeros autorizados leen todo el chat; una alerta dirigida a unas personas solo la ven ellas y quien la envió.
-- Tiempo real: chat_messages y chat_acks van en supabase_realtime (Realtime respeta las políticas de lectura).

-- ---------- 1. mensajes ----------

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  name text not null default 'Viajero' check (char_length(name) between 1 and 40),
  kind text not null default 'texto' check (kind in ('texto', 'alerta')),
  body text not null default '' check (char_length(body) <= 1000),
  -- Solo para alertas: a quién van (null = a todos). Lista de 1 a 40 personas, sin nulos.
  to_users uuid[] check (to_users is null or (array_ndims(to_users) = 1 and cardinality(to_users) between 1 and 40 and array_position(to_users, null) is null)),
  attached_photo uuid references public.photos (id) on delete set null,
  attached_audio uuid references public.audios (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Un mensaje de texto lleva texto o un adjunto (o los dos) y nunca destinatarios; una alerta lleva de 1 a 200 caracteres y
  -- ningún adjunto.
  constraint chat_messages_texto_check check (kind <> 'texto' or (to_users is null and (char_length(body) > 0 or attached_photo is not null or attached_audio is not null))),
  constraint chat_messages_alerta_check check (kind <> 'alerta' or (char_length(body) between 1 and 200 and attached_photo is null and attached_audio is null))
);
create index chat_messages_created_idx on public.chat_messages (created_at desc);
create index chat_messages_photo_idx on public.chat_messages (attached_photo);
create index chat_messages_audio_idx on public.chat_messages (attached_audio);

-- Antes de guardar: la hora la pone el servidor, el autor es quien llama y el nombre se normaliza (espacios repetidos a uno,
-- sin espacios en los extremos, máx. 40 caracteres; vacío = «Viajero»).
create or replace function public.chat_messages_prepare()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  new.created_at := now();
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;
  new.name := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
  new.body := case when new.kind = 'alerta' then btrim(regexp_replace(coalesce(new.body, ''), '[[:space:][:cntrl:]]+', ' ', 'g')) else btrim(coalesce(new.body, '')) end;
  return new;
end;
$$;
revoke all on function public.chat_messages_prepare() from public, anon, authenticated;
create trigger chat_messages_prepare
  before insert on public.chat_messages
  for each row execute function public.chat_messages_prepare();

-- ---------- 2. confirmaciones de las alertas ----------

create table public.chat_acks (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'Viajero' check (char_length(name) between 1 and 40),
  at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create or replace function public.chat_acks_prepare()
returns trigger
language plpgsql set search_path = public, pg_temp
as $$
begin
  new.at := now();
  new.name := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
  return new;
end;
$$;
revoke all on function public.chat_acks_prepare() from public, anon, authenticated;
create trigger chat_acks_prepare
  before insert on public.chat_acks
  for each row execute function public.chat_acks_prepare();

-- ---------- permisos y RLS ----------

revoke all on public.chat_messages, public.chat_acks from anon, authenticated;
-- Texto: se inserta directamente con estas columnas (kind, to_users, user_id y la hora no se pueden elegir). Alertas: send_alert().
grant select, delete on public.chat_messages to authenticated;
grant insert (id, name, body, attached_photo, attached_audio) on public.chat_messages to authenticated;
-- Confirmaciones: se crean con el id del mensaje y el nombre; no se editan ni se borran.
grant select on public.chat_acks to authenticated;
grant insert (message_id, name) on public.chat_acks to authenticated;
alter table public.chat_messages enable row level security;
alter table public.chat_acks enable row level security;

-- Se ve el chat de los viajeros; una alerta dirigida solo la ven sus destinatarios y su autor.
create policy chat_messages_select on public.chat_messages
  for select to authenticated
  using (public.is_member() and (kind = 'texto' or to_users is null or user_id = auth.uid() or auth.uid() = any (to_users)));

-- Cada uno escribe como él mismo y solo mensajes de texto; las fotos y audios adjuntos tienen que ser suyos.
create policy chat_messages_insert on public.chat_messages
  for insert to authenticated
  with check (
    public.is_member() and user_id = auth.uid() and kind = 'texto' and to_users is null
    and (attached_photo is null or exists (select 1 from public.photos p where p.id = attached_photo and p.created_by = auth.uid()))
    and (attached_audio is null or exists (select 1 from public.audios a where a.id = attached_audio and a.created_by = auth.uid()))
  );

-- Cada uno borra solo lo suyo (mensajes y alertas).
create policy chat_messages_delete on public.chat_messages
  for delete to authenticated
  using (public.is_member() and user_id = auth.uid());

-- Las confirmaciones las ve quien ve la alerta.
create policy chat_acks_select on public.chat_acks
  for select to authenticated
  using (public.is_member() and exists (select 1 from public.chat_messages m where m.id = message_id));

-- Cada uno confirma solo como él mismo, y solo alertas que puede ver (la subconsulta pasa por las políticas de chat_messages).
create policy chat_acks_insert on public.chat_acks
  for insert to authenticated
  with check (
    public.is_member() and user_id = auth.uid()
    and exists (select 1 from public.chat_messages m where m.id = message_id and m.kind = 'alerta')
  );

-- ---------- 3. enviar una alerta ----------

-- Crea una alerta de quien llama. `p_to` = a quién (null = a todos; si se da una lista, se quitan los repetidos, el propio autor y
-- quienes no son viajeros, y debe quedar al menos uno). Limita el ritmo: una alerta cada 15 s y, como mucho, 12 por hora y
-- persona. Pide el aviso a los demás con public.push_notify si existe (sin él, la alerta igualmente aparece en el chat y en la
-- web abierta de los demás). Un fallo al avisar nunca impide crear la alerta. Devuelve el id.
create or replace function public.send_alert(p_body text, p_to uuid[] default null, p_name text default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := btrim(regexp_replace(coalesce(p_body, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
  v_name text := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
  v_to uuid[] := null;
  v_id uuid;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_body = '' then
    raise exception 'Escribe el mensaje de la alerta';
  end if;
  if char_length(v_body) > 200 then
    raise exception 'La alerta admite como máximo 200 caracteres';
  end if;
  if p_to is not null then
    if array_ndims(p_to) is distinct from 1 or cardinality(p_to) > 40 then
      raise exception 'Elige a quién enviar la alerta (hasta 40 personas)';
    end if;
    select coalesce(array_agg(distinct u.id), '{}') into v_to
      from auth.users u
      join public.members m on m.email = lower(u.email)
      where u.id = any (p_to) and u.id <> v_uid;
    if cardinality(v_to) = 0 then
      raise exception 'Elige a quién enviar la alerta';
    end if;
  end if;
  -- Ritmo (con un bloqueo por persona para que dos toques seguidos no se salten el límite).
  perform pg_advisory_xact_lock(hashtextextended('send_alert:' || v_uid::text, 0));
  if exists (select 1 from public.chat_messages where user_id = v_uid and kind = 'alerta' and created_at > now() - interval '15 seconds') then
    raise exception 'Espera unos segundos antes de enviar otra alerta';
  end if;
  if (select count(*) from public.chat_messages where user_id = v_uid and kind = 'alerta' and created_at > now() - interval '1 hour') >= 12 then
    raise exception 'Has enviado muchas alertas seguidas. Espera un rato antes de mandar otra';
  end if;

  insert into public.chat_messages (user_id, name, kind, body, to_users) values (v_uid, v_name, 'alerta', v_body, v_to) returning id into v_id;

  begin
    if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is not null then
      perform public.push_notify('alerta', '🚨 ' || v_name || ' manda una alerta', v_body, '#chat', v_uid, true, null, v_to, 'alerta-' || v_id::text, false, null, 0);
    end if;
  exception when others then
    raise warning 'send_alert: no se pudo avisar (%): %', sqlstate, sqlerrm;
  end;
  return v_id;
end;
$$;
revoke all on function public.send_alert(text, uuid[], text) from public, anon;
grant execute on function public.send_alert(text, uuid[], text) to authenticated;

-- ---------- 4. avisos de mensajes nuevos y limpieza ----------

-- Cada mensaje de texto avisa a los demás (si avisos.sql está instalado). Las ráfagas de un mismo autor se agrupan: durante 30 s
-- solo el primer mensaje genera notificación. Nunca puede impedir guardar el mensaje.
create or replace function public.chat_messages_notify()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_text text;
begin
  v_text := case
    when new.body <> '' then left(new.body, 140)
    when new.attached_photo is not null then '📷 Foto'
    else '🎤 Nota de voz'
  end;
  begin
    if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is not null then
      perform public.push_notify('chat', '💬 ' || new.name, v_text, '#chat', new.user_id, false, null, null, 'chat', false, 'chat-' || coalesce(new.user_id::text, 'x'), 30);
    end if;
  exception when others then
    raise warning 'chat_messages_notify: no se pudo avisar (%): %', sqlstate, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.chat_messages_notify() from public, anon, authenticated;
create trigger chat_messages_notify
  after insert on public.chat_messages
  for each row when (new.kind = 'texto')
  execute function public.chat_messages_notify();

-- Al borrar una foto o un audio, los mensajes que SOLO tenían ese adjunto (sin texto ni el otro adjunto) se borran antes: si no,
-- el `on delete set null` los dejaría vacíos y chat_messages_texto_check haría fallar el borrado de la foto o del audio.
create or replace function public.drop_chat_left_empty()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'photos' then
    delete from public.chat_messages where kind = 'texto' and attached_photo = old.id and body = '' and attached_audio is null;
  else
    delete from public.chat_messages where kind = 'texto' and attached_audio = old.id and body = '' and attached_photo is null;
  end if;
  return old;
end;
$$;
revoke all on function public.drop_chat_left_empty() from public, anon, authenticated;
create trigger photos_drop_empty_chat
  before delete on public.photos
  for each row execute function public.drop_chat_left_empty();
create trigger audios_drop_empty_chat
  before delete on public.audios
  for each row execute function public.drop_chat_left_empty();

-- ---------- tiempo real ----------

alter publication supabase_realtime add table public.chat_messages, public.chat_acks;
$parte_chat$;
  else
    raise notice 'chat.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- chat_respuestas.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.chat_messages') is not null and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'reply_to') then
    raise notice 'Aplicando chat_respuestas.sql...';
    execute $parte_chat_respuestas$
-- Responder citando un mensaje del chat (arrastrar el mensaje hacia un lado, como en WhatsApp). Ejecutar en Supabase → SQL Editor
-- DESPUÉS de chat.sql (añade una columna a public.chat_messages). Una sola vez; el todo en uno solo la aplica si falta la columna
-- chat_messages.reply_to. Sin esta parte el chat funciona igual, solo que no se puede citar un mensaje.
--
-- Qué hay:
--   · Un mensaje de texto puede llevar `reply_to`: el id del mensaje de texto al que contesta. La web enseña esa cita encima del mensaje
--     (con quién lo escribió y las primeras palabras) y, al tocarla, lleva al original.
--   · Si el original se borra, la respuesta se queda con la cita «Este mensaje fue eliminado» (a propósito no hay clave foránea: el
--     `reply_to` sigue ahí y la web ve que ya no existe).
--   · Aviso al autor: quien recibe una respuesta ve «↩️ Ana te respondió» (en vez del aviso general del chat, para no sonar dos veces);
--     los demás reciben el aviso de siempre. Solo si avisos.sql está instalado; un fallo al avisar nunca impide guardar el mensaje.
--
-- Seguridad: solo se puede citar un mensaje de TEXTO que ya existe (no una alerta: sus destinatarios son privados), nunca el propio
-- mensaje, y las alertas no llevan cita. El autor y la hora los sigue poniendo el servidor.

-- ---------- 1. la columna ----------

alter table public.chat_messages add column reply_to uuid;
alter table public.chat_messages add constraint chat_messages_reply_check check (reply_to is null or (kind = 'texto' and reply_to <> id));
create index chat_messages_reply_idx on public.chat_messages (reply_to) where reply_to is not null;

-- ---------- 2. permisos y política ----------

-- La web inserta con estas columnas (las de antes más reply_to).
grant insert (reply_to) on public.chat_messages to authenticated;

-- La misma política de antes, más: si cita algo, tiene que ser un mensaje de texto que existe (la subconsulta pasa por la política de
-- lectura de chat_messages: los mensajes de texto los ve cualquier viajero).
drop policy chat_messages_insert on public.chat_messages;
create policy chat_messages_insert on public.chat_messages
  for insert to authenticated
  with check (
    public.is_member() and user_id = auth.uid() and kind = 'texto' and to_users is null
    and (attached_photo is null or exists (select 1 from public.photos p where p.id = attached_photo and p.created_by = auth.uid()))
    and (attached_audio is null or exists (select 1 from public.audios a where a.id = attached_audio and a.created_by = auth.uid()))
    -- (`chat_messages.reply_to` va calificado a propósito: dentro de la subconsulta, `reply_to` a secas sería la columna de `r`)
    and (reply_to is null or exists (select 1 from public.chat_messages r where r.id = chat_messages.reply_to and r.kind = 'texto'))
  );

-- ---------- 3. aviso al autor del mensaje respondido ----------

-- Sustituye al aviso de chat.sql: igual, pero si el mensaje responde a otra persona, a ella le llega «te respondió» y a las demás el aviso
-- de siempre (así nadie recibe dos notificaciones por el mismo mensaje). Las ráfagas de un mismo autor se siguen agrupando 30 s.
create or replace function public.chat_messages_notify()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_text text;
  v_orig uuid;
  v_others uuid[];
begin
  v_text := case
    when new.body <> '' then left(new.body, 140)
    when new.attached_photo is not null then '📷 Foto'
    else '🎤 Nota de voz'
  end;
  begin
    if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is not null then
      if new.reply_to is not null then
        select m.user_id into v_orig from public.chat_messages m where m.id = new.reply_to;
      end if;
      if v_orig is not null and v_orig is distinct from new.user_id then
        perform public.push_notify('chat', '↩️ ' || new.name || ' te respondió', v_text, '#chat', new.user_id, false, null, array[v_orig], 'respuesta-' || new.id::text, false, null, 0);
        select coalesce(array_agg(u.id), '{}') into v_others
          from auth.users u
          join public.members mb on mb.email = lower(u.email)
          where u.id <> v_orig and u.id is distinct from new.user_id;
        if cardinality(v_others) > 0 then
          perform public.push_notify('chat', '💬 ' || new.name, v_text, '#chat', new.user_id, false, null, v_others, 'chat', false, 'chat-' || coalesce(new.user_id::text, 'x'), 30);
        end if;
      else
        perform public.push_notify('chat', '💬 ' || new.name, v_text, '#chat', new.user_id, false, null, null, 'chat', false, 'chat-' || coalesce(new.user_id::text, 'x'), 30);
      end if;
    end if;
  exception when others then
    raise warning 'chat_messages_notify: no se pudo avisar (%): %', sqlstate, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.chat_messages_notify() from public, anon, authenticated;
$parte_chat_respuestas$;
  else
    raise notice 'chat_respuestas.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- reacciones.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.reactions') is null then
    raise notice 'Aplicando reacciones.sql...';
    execute $parte_reacciones$
-- Reacciones («me gusta» y emojis) en los comentarios, las fotos y los mensajes del chat. Ejecutar en Supabase → SQL Editor DESPUÉS de
-- schema.sql, fotos.sql y adjuntos.sql (usa public.is_member(), public.photos y public.comments). Una sola vez; el todo en uno solo la
-- aplica si falta public.reactions. Si chat.sql está instalado, también se puede reaccionar a los mensajes del chat; si no, esa parte
-- se omite. No depende de avisos.sql: si está instalado, el autor recibe una notificación cuando alguien reacciona a lo suyo.
--
-- Qué hay: una persona puede reaccionar a una cosa con hasta 6 emojis distintos (de una lista cerrada de 12: ❤️ 👍 😂 😮 😢 🔥 🙏 👏
-- 🎉 😍 🤔 👎), y quitarlos cuando quiera. Todos los viajeros ven quién ha reaccionado con qué.
--
-- Contenido:
--   1. public.reactions     una fila por persona, cosa y emoji. Se insertan y se borran; nunca se editan.
--   2. Disparadores         preparar la fila (hora del servidor, autor real, nombre normalizado, la cosa existe, límite de 6),
--                           limpiar las reacciones de lo que se borra y avisar al autor.
--
-- Seguridad: cada uno solo crea y borra SUS reacciones (RLS); el autor (user_id) y la hora los pone el servidor, así que no se puede
-- reaccionar «como otro»; el emoji está limitado a la lista (CHECK), y una reacción solo puede apuntar a algo que existe.
-- Tiempo real: reactions va en supabase_realtime (Realtime respeta la política de lectura).

-- ---------- 1. reacciones ----------

create table public.reactions (
  target_kind text not null check (target_kind in ('comment', 'photo', 'chat')),
  target_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'Viajero' check (char_length(name) between 1 and 40),
  -- Lista cerrada: la web usa exactamente estos 12 (js/emojis.js, REACTION_EMOJIS). Una prueba comprueba que coinciden.
  emoji text not null check (emoji in ('❤️', '👍', '😂', '😮', '😢', '🔥', '🙏', '👏', '🎉', '😍', '🤔', '👎')),
  created_at timestamptz not null default now(),
  primary key (target_kind, target_id, user_id, emoji)
);
create index reactions_target_idx on public.reactions (target_kind, target_id);

-- ---------- permisos y RLS ----------

revoke all on public.reactions from anon, authenticated;
grant select, delete on public.reactions to authenticated;
-- Se inserta con estas columnas; user_id y la hora los pone el servidor.
grant insert (target_kind, target_id, name, emoji) on public.reactions to authenticated;
alter table public.reactions enable row level security;

create policy reactions_select on public.reactions
  for select to authenticated using (public.is_member());
create policy reactions_insert on public.reactions
  for insert to authenticated with check (public.is_member() and user_id = auth.uid());
create policy reactions_delete on public.reactions
  for delete to authenticated using (public.is_member() and user_id = auth.uid());

-- ---------- 2. disparadores ----------

-- Antes de guardar: hora del servidor, autor real, nombre normalizado, la cosa tiene que existir y como mucho 6 emojis por persona
-- y cosa. Se ejecuta con los permisos del dueño porque las comprobaciones leen tablas que la persona quizá no ve entera.
create or replace function public.reactions_prepare()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
begin
  new.created_at := now();
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;
  new.name := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');

  if new.target_kind = 'comment' then
    select exists (select 1 from public.comments where id = new.target_id) into v_ok;
  elsif new.target_kind = 'photo' then
    select exists (select 1 from public.photos where id = new.target_id) into v_ok;
  elsif new.target_kind = 'chat' and to_regclass('public.chat_messages') is not null then
    -- Solo los mensajes de texto del chat (las alertas se confirman con «Entendido»).
    execute 'select exists (select 1 from public.chat_messages where id = $1 and kind = ''texto'')' into v_ok using new.target_id;
  else
    v_ok := false;
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'Eso ya no existe: no se puede reaccionar' using errcode = 'foreign_key_violation';
  end if;

  if (select count(*) from public.reactions r where r.target_kind = new.target_kind and r.target_id = new.target_id and r.user_id = new.user_id) >= 6 then
    raise exception 'Como mucho 6 reacciones distintas por persona. Quita alguna antes de añadir otra' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.reactions_prepare() from public, anon, authenticated;
create trigger reactions_prepare
  before insert on public.reactions
  for each row execute function public.reactions_prepare();

-- Al borrar una cosa se van sus reacciones (la tabla no tiene clave foránea porque apunta a tres tablas distintas).
create or replace function public.reactions_cleanup()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  delete from public.reactions where target_kind = tg_argv[0] and target_id = old.id;
  return old;
end;
$$;
revoke all on function public.reactions_cleanup() from public, anon, authenticated;
create trigger comments_reactions_cleanup after delete on public.comments for each row execute function public.reactions_cleanup('comment');
create trigger photos_reactions_cleanup after delete on public.photos for each row execute function public.reactions_cleanup('photo');
do $chat$
begin
  if to_regclass('public.chat_messages') is not null then
    create trigger chat_messages_reactions_cleanup after delete on public.chat_messages for each row execute function public.reactions_cleanup('chat');
  end if;
end
$chat$;

-- Avisa al autor de lo que ha recibido una reacción (si avisos.sql está instalado). Solo a él, nunca por reaccionar a lo propio, y las
-- ráfagas de la misma persona sobre la misma cosa se agrupan 60 s. Un fallo al avisar nunca impide guardar la reacción.
create or replace function public.reactions_notify()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_author uuid;
  v_text text;
  v_kind text;
  v_url text;
  v_what text;
begin
  begin
    if new.target_kind = 'comment' then
      select created_by, left(nullif(body, ''), 80) into v_author, v_text from public.comments where id = new.target_id;
      v_kind := 'comentario'; v_url := '#plan'; v_what := 'tu comentario';
    elsif new.target_kind = 'photo' then
      select created_by into v_author from public.photos where id = new.target_id;
      v_kind := 'foto'; v_url := '#fotos'; v_what := 'tu foto';
    elsif to_regclass('public.chat_messages') is not null then
      execute 'select user_id, left(nullif(body, ''''), 80) from public.chat_messages where id = $1' into v_author, v_text using new.target_id;
      v_kind := 'chat'; v_url := '#chat'; v_what := 'tu mensaje';
    end if;
    if v_author is null or v_author = new.user_id then
      return new;
    end if;
    if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is not null then
      perform public.push_notify(v_kind, new.emoji || ' ' || new.name || ' reaccionó a ' || v_what, coalesce(v_text, 'Toca para verlo'), v_url, new.user_id, false, null,
        array[v_author], 'reaccion-' || new.target_id::text, false, 'reaccion-' || new.target_id::text || '-' || new.user_id::text, 60);
    end if;
  exception when others then
    raise warning 'reactions_notify: no se pudo avisar (%): %', sqlstate, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.reactions_notify() from public, anon, authenticated;
create trigger reactions_notify
  after insert on public.reactions
  for each row execute function public.reactions_notify();

-- ---------- tiempo real ----------

alter publication supabase_realtime add table public.reactions;
$parte_reacciones$;
  else
    raise notice 'reacciones.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- valoraciones.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.photo_ratings') is null then
    raise notice 'Aplicando valoraciones.sql...';
    execute $parte_valoraciones$
-- Valoraciones con estrellas (1 a 5) de las fotos del viaje y de las fotos de la batalla. Ejecutar en Supabase → SQL Editor DESPUÉS de
-- schema.sql, fotos.sql y juego_batalla.sql (usa public.is_member(), public.photos y, para la batalla, public.battles y
-- public.battle_entries). Una sola vez; el todo en uno solo la aplica si falta public.photo_ratings. Si juego_batalla.sql no está, la
-- parte de la batalla se omite.
--
-- Qué hay:
--   · Fotos del viaje: cualquier viajero puntúa con 1 a 5 estrellas las fotos de los demás (no las suyas) y puede cambiar o quitar su
--     nota. Todos ven la nota media y cuántas valoraciones lleva cada foto.
--   · Batalla de fotos: durante la votación cada foto (menos la propia) se puntúa con estrellas, EN SECRETO igual que los votos, y al
--     cerrar la batalla se ve la nota media de cada foto. Si dos fotos empatan en votos, gana la de mejor nota media.
--
-- Contenido:
--   1. public.photo_ratings      una nota por persona y foto (se inserta, se cambia y se quita; RLS por persona).
--   2. public.battle_ratings     una nota por persona y foto de la batalla. Sin escritura directa: solo con rate_battle_entry().
--   3. public.rate_battle_entry  puntuar (o quitar la nota de) una foto de la batalla en votación.
--   4. public.battle_final       resultado de una batalla terminada con la nota media y el desempate por estrellas.
--
-- Seguridad: lo que no se puede falsear (quién puntúa, la hora, no puntuar lo propio, la nota de 1 a 5, puntuar solo con la batalla en
-- votación, la foto de la misma batalla) lo decide la base de datos. Las notas de la batalla de los demás no se pueden leer hasta que
-- termina (RLS). Tiempo real: photo_ratings va en supabase_realtime; battle_ratings no (sus eventos delatarían las notas).

-- ---------- 1. notas de las fotos del viaje ----------

create table public.photo_ratings (
  photo_id uuid not null references public.photos (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'Viajero' check (char_length(name) between 1 and 40),
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);

revoke all on public.photo_ratings from anon, authenticated;
grant select, delete on public.photo_ratings to authenticated;
-- La web puntúa con un upsert (PostgREST: INSERT … ON CONFLICT DO UPDATE SET photo_id, name, stars), que necesita UPDATE sobre esas tres.
grant insert (photo_id, name, stars) on public.photo_ratings to authenticated;
grant update (photo_id, name, stars) on public.photo_ratings to authenticated;
alter table public.photo_ratings enable row level security;

create policy photo_ratings_select on public.photo_ratings
  for select to authenticated using (public.is_member());
create policy photo_ratings_insert on public.photo_ratings
  for insert to authenticated with check (public.is_member() and user_id = auth.uid());
create policy photo_ratings_update on public.photo_ratings
  for update to authenticated using (public.is_member() and user_id = auth.uid()) with check (public.is_member() and user_id = auth.uid());
create policy photo_ratings_delete on public.photo_ratings
  for delete to authenticated using (public.is_member() and user_id = auth.uid());

-- Antes de guardar (al insertar y al cambiar): autor real, hora del servidor, nombre normalizado, nada de puntuar lo propio ni un ticket,
-- y la nota no puede cambiarse de foto ni de persona.
create or replace function public.photo_ratings_prepare()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  p public.photos;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if auth.uid() is not null then
      new.user_id := auth.uid();
    end if;
  else
    new.user_id := old.user_id;
    new.created_at := old.created_at;
    if new.photo_id <> old.photo_id then
      raise exception 'Una nota no se puede pasar a otra foto' using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  new.name := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
  select * into p from public.photos where id = new.photo_id;
  if found then
    if p.created_by is not null and p.created_by = new.user_id then
      raise exception 'No puedes valorar tu propia foto' using errcode = 'check_violation';
    end if;
    if p.expense_id is not null then
      raise exception 'La foto de un ticket no se valora' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.photo_ratings_prepare() from public, anon, authenticated;
create trigger photo_ratings_prepare
  before insert or update on public.photo_ratings
  for each row execute function public.photo_ratings_prepare();

alter publication supabase_realtime add table public.photo_ratings;

-- ---------- batalla de fotos (solo si está instalada) ----------

do $batalla$
begin
  if to_regclass('public.battle_entries') is null then
    raise notice 'valoraciones.sql: no está juego_batalla.sql, se omiten las notas de la batalla';
    return;
  end if;

  -- 2. notas de las fotos de la batalla
  create table public.battle_ratings (
    entry_id uuid not null,
    battle_id uuid not null,
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    stars smallint not null check (stars between 1 and 5),
    updated_at timestamptz not null default now(),
    primary key (entry_id, user_id),
    -- La foto puntuada tiene que ser de la misma batalla (y si se borra la foto o la batalla, se van sus notas).
    constraint battle_ratings_entry_fkey foreign key (entry_id, battle_id) references public.battle_entries (id, battle_id) on delete cascade
  );
  create index battle_ratings_battle_idx on public.battle_ratings (battle_id);

  revoke all on public.battle_ratings from anon, authenticated;
  grant select on public.battle_ratings to authenticated; -- nadie escribe directamente: lo hace rate_battle_entry
  alter table public.battle_ratings enable row level security;
  -- Cada uno ve SIEMPRE las suyas; las de los demás, solo cuando la batalla ha terminado (como los votos).
  create policy battle_ratings_select on public.battle_ratings
    for select to authenticated
    using (
      public.is_member()
      and (user_id = auth.uid() or exists (select 1 from public.battles b where b.id = battle_id and b.status = 'done'))
    );

  -- 3. puntuar una foto de la batalla. `p_stars` de 1 a 5; 0 o null quita la nota. Las mismas reglas que cast_vote: solo con la batalla
  -- en votación, solo quienes han enviado su foto y nunca la propia.
  create or replace function public.rate_battle_entry(p_entry uuid, p_stars int)
  returns void
  language plpgsql security definer set search_path = public
  as $f$
  declare
    v_uid uuid := auth.uid();
    v_battle uuid;
    v_owner uuid;
    v_status text;
  begin
    if v_uid is null or not public.is_member() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select e.battle_id, e.user_id into v_battle, v_owner from public.battle_entries e where e.id = p_entry;
    if not found then
      raise exception 'Esa foto no existe';
    end if;
    -- FOR SHARE: mientras se puntúa, nadie puede cerrar la batalla a la vez (close_battle pide el bloqueo exclusivo).
    select b.status into v_status from public.battles b where b.id = v_battle for share;
    if v_status = 'open' then
      raise exception 'La votación todavía no ha empezado';
    elsif v_status = 'done' then
      raise exception 'La batalla ya ha terminado: no se puede puntuar';
    end if;
    if v_owner = v_uid then
      raise exception 'No puedes puntuar tu propia foto';
    end if;
    if not exists (select 1 from public.battle_entries e where e.battle_id = v_battle and e.user_id = v_uid) then
      raise exception 'Solo puntúan quienes han enviado su foto';
    end if;
    if p_stars is null or p_stars = 0 then
      delete from public.battle_ratings where entry_id = p_entry and user_id = v_uid;
      return;
    end if;
    if p_stars not between 1 and 5 then
      raise exception 'La nota va de 1 a 5 estrellas';
    end if;
    insert into public.battle_ratings (entry_id, battle_id, user_id, stars)
    values (p_entry, v_battle, v_uid, p_stars)
    on conflict (entry_id, user_id) do update set stars = excluded.stars, updated_at = now();
  end;
  $f$;
  revoke all on function public.rate_battle_entry(uuid, int) from public, anon;
  grant execute on function public.rate_battle_entry(uuid, int) to authenticated;

  -- 4. resultado de una batalla TERMINADA con la nota media: una fila por foto. Se ordena por votos y, si empatan, por nota media
  -- (las que empatan en las dos cosas comparten puesto). Antes de que termine falla, para que nadie vaya sacando notas.
  create or replace function public.battle_final(p_battle uuid)
  returns table (entry_id uuid, user_id uuid, name text, path text, thumb_path text, votes bigint, avg_stars numeric, ratings bigint, rank bigint)
  language plpgsql stable security definer set search_path = public
  as $f$
  declare
    v_status text;
  begin
    if auth.uid() is null or not public.is_member() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select b.status into v_status from public.battles b where b.id = p_battle;
    if not found then
      raise exception 'Esa batalla no existe';
    end if;
    if v_status <> 'done' then
      raise exception 'El resultado se verá cuando termine la batalla';
    end if;
    return query
      with s as (
        select e.id as eid, e.user_id as uid, e.name as nm, e.path as pth, e.thumb_path as thp, e.created_at as at,
               (select count(*) from public.battle_votes v where v.entry_id = e.id)::bigint as vt,
               (select round(avg(r.stars), 2) from public.battle_ratings r where r.entry_id = e.id) as av,
               (select count(*) from public.battle_ratings r where r.entry_id = e.id)::bigint as rt
        from public.battle_entries e
        where e.battle_id = p_battle
      )
      select s.eid, s.uid, s.nm, s.pth, s.thp, s.vt, s.av, s.rt, rank() over (order by s.vt desc, coalesce(s.av, 0) desc)
      from s
      order by 9, s.at, s.eid;
  end;
  $f$;
  revoke all on function public.battle_final(uuid) from public, anon;
  grant execute on function public.battle_final(uuid) to authenticated;
end
$batalla$;
$parte_valoraciones$;
  else
    raise notice 'valoraciones.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- dibujos.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.drawings') is null then
    raise notice 'Aplicando dibujos.sql...';
    execute $parte_dibujos$
-- Juego «Álbum de dibujos»: cada viajero dibuja con el dedo, guarda el dibujo en un álbum compartido y todos lo ven y reaccionan.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql (usa public.is_member()), acceso.sql (usa is_admin()) y fotos.sql (el
-- bucket privado `photos`). Una sola vez; el todo en uno solo lo aplica si falta public.drawings. Si reacciones.sql está instalado
-- (va ANTES en el todo en uno), también se puede reaccionar a los dibujos; si no, esa parte se omite. No depende de avisos.sql: si
-- está instalado, al guardar un dibujo se avisa a los demás (public.push_notify).
--
-- Los archivos van al bucket `photos` (JPEG, máx. 5 MB), en la carpeta del usuario, y NO se registran en public.photos: los dibujos
-- no son fotos del viaje (no salen en Fotos, ni en el mapa, ni en el álbum de fotos). Las políticas de Storage de fotos.sql (solo la
-- carpeta propia, solo JPEG, máx. 5 MB) ya permiten estas rutas y no se tocan aquí:
--   <user_id>/dibujo-<id>.jpg      el dibujo (máx. 1200 px)
--   <user_id>/dibujo-<id>_t.jpg    su miniatura (400 px)
--
-- Contenido:
--   1. public.drawings   un dibujo por fila: autor, nombre, tema opcional y las dos rutas. Se insertan y se borran; nunca se editan.
--   2. Disparadores      preparar la fila (hora del servidor, nombre y tema normalizados, límite por persona) y avisar a los demás.
--   3. Reacciones        si existe public.reactions: admite target_kind 'drawing' (comprobación, aviso al autor y limpieza al borrar).
--
-- Seguridad: todo con RLS y permisos mínimos por columna; lo que no puede falsearse lo pone la base de datos.
--   · Cada uno guarda solo como él mismo (user_id = auth.uid()) y borra solo lo suyo; un administrador puede borrar cualquiera
--     (moderación). Nadie actualiza.
--   · La hora (created_at) la pone el servidor y el nombre y el tema se normalizan en un disparador.
--   · Las rutas de los archivos están atadas al propio usuario y al id del dibujo por una restricción, así nadie puede presentar
--     como suyo un archivo subido por otra persona (ni apuntar a un archivo cualquiera del almacén).
--   · Como mucho 300 dibujos por persona (el almacenamiento gratuito es de 1 GB): al llegar al límite avisa en español.
--
-- Nota: borrar un dibujo ajeno como administrador quita la fila, pero los archivos solo los puede borrar su dueño (política de
-- Storage): quedan sin enlazar y ocupan unos 100-200 KB. Borrar un usuario borra sus filas, no sus archivos.
-- Tiempo real: drawings va en supabase_realtime (las reacciones ya van en la suya).

-- ---------- 1. los dibujos ----------

create table public.drawings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,                                          -- nombre de quien dibuja (lo normaliza el disparador)
  prompt text,                                                 -- tema (opcional): «Un flamenco»; null = dibujo libre
  path text not null,                                          -- el dibujo, versión grande
  thumb_path text not null,                                    -- y su miniatura
  created_at timestamptz not null default now(),               -- la fija el disparador: el cliente no la escribe
  constraint drawings_name_check check (char_length(name) between 1 and 40),
  constraint drawings_prompt_check check (prompt is null or char_length(prompt) between 1 and 80),
  constraint drawings_paths_check check (
    path = user_id::text || '/dibujo-' || id::text || '.jpg'
    and thumb_path = user_id::text || '/dibujo-' || id::text || '_t.jpg'
  )
);
create index drawings_created_idx on public.drawings (created_at desc);
create index drawings_user_idx on public.drawings (user_id);

-- ---------- permisos y RLS ----------

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios. `created_at` no
-- está en la lista de INSERT (la pone el disparador) y UPDATE no se concede.
revoke all on public.drawings from anon, authenticated;
grant select, delete on public.drawings to authenticated;
grant insert (id, user_id, name, prompt, path, thumb_path) on public.drawings to authenticated;
alter table public.drawings enable row level security;

-- Los viajeros ven los dibujos de todos (es parte de la gracia).
create policy drawings_select on public.drawings
  for select to authenticated using (public.is_member());
-- Cada uno guarda solo como él mismo.
create policy drawings_insert on public.drawings
  for insert to authenticated with check (public.is_member() and user_id = auth.uid());
-- Cada uno borra lo suyo; un administrador, cualquiera.
create policy drawings_delete on public.drawings
  for delete to authenticated using (public.is_member() and (user_id = auth.uid() or public.is_admin()));

-- ---------- 2. disparadores ----------

-- Antes de guardar: hora del servidor; nombre (espacios y saltos de línea repetidos pasan a uno, sin espacios en los extremos, máx.
-- 40 caracteres; vacío = «Viajero») y tema (igual, máx. 80; vacío = sin tema) normalizados; y el límite de 300 dibujos por persona.
-- El candado evita que dos guardados simultáneos de la misma persona se pasen del límite. Se ejecuta con los permisos del dueño
-- para contar TODOS los dibujos de la persona, vea lo que vea su política.
create or replace function public.drawings_prepare()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  new.created_at := now();
  new.name := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
  new.prompt := nullif(btrim(left(btrim(regexp_replace(coalesce(new.prompt, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 80)), '');
  perform pg_advisory_xact_lock(hashtextextended('drawings:' || coalesce(new.user_id::text, ''), 0));
  if (select count(*) from public.drawings d where d.user_id = new.user_id) >= 300 then
    raise exception 'Has llegado al máximo de 300 dibujos. Borra alguno del álbum para poder guardar otro' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke all on function public.drawings_prepare() from public, anon, authenticated;
create trigger drawings_prepare
  before insert on public.drawings
  for each row execute function public.drawings_prepare();

-- Avisa a los demás de que hay un dibujo nuevo (si avisos.sql está instalado): a todos menos a quien lo hizo, con la miniatura, y las
-- ráfagas de la misma persona se agrupan 2 minutos (cinco dibujos seguidos = un aviso). Un fallo al avisar nunca impide guardar.
create or replace function public.drawings_notify()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  begin
    if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is not null then
      perform public.push_notify('juego',
        case when new.prompt is null then '🎨 ' || new.name || ' ha hecho un dibujo' else '🎨 ' || new.name || ' dibujó «' || new.prompt || '»' end,
        'Toca para verlo', '#juegos', new.user_id, false, new.thumb_path, null, 'dibujo-' || new.id::text, false, 'dibujo-' || new.user_id::text, 120);
    end if;
  exception when others then
    raise warning 'drawings_notify: no se pudo avisar (%): %', sqlstate, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.drawings_notify() from public, anon, authenticated;
create trigger drawings_notify
  after insert on public.drawings
  for each row execute function public.drawings_notify();

-- ---------- tiempo real ----------

alter publication supabase_realtime add table public.drawings;

-- ---------- 3. reacciones a los dibujos (solo si reacciones.sql está instalado) ----------

-- reactions.target_kind solo admitía 'comment', 'photo' y 'chat': se amplía con 'drawing'. Las funciones reactions_prepare y
-- reactions_notify se sustituyen por la MISMA versión de reacciones.sql con una rama más (no se toca reacciones.sql, que ya está
-- instalado en producción). Si instalas reacciones.sql DESPUÉS de este archivo, vuelve a ejecutar solo esta sección 3.
do $reac$
declare
  c record;
begin
  if to_regclass('public.reactions') is null then
    raise notice 'dibujos.sql: no está reacciones.sql, se omiten las reacciones a los dibujos';
    return;
  end if;

  -- La comprobación de target_kind (se busca por lo que dice, no solo por el nombre) se vuelve a crear con 'drawing'.
  for c in
    select conname from pg_constraint
    where conrelid = 'public.reactions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%target_kind%'
  loop
    execute format('alter table public.reactions drop constraint %I', c.conname);
  end loop;
  alter table public.reactions
    add constraint reactions_target_kind_check check (target_kind in ('comment', 'photo', 'chat', 'drawing'));

  -- Antes de guardar una reacción: la cosa tiene que existir (rama nueva: el dibujo) y como mucho 6 emojis por persona y cosa.
  create or replace function public.reactions_prepare()
  returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $f$
  declare
    v_ok boolean;
  begin
    new.created_at := now();
    if auth.uid() is not null then
      new.user_id := auth.uid();
    end if;
    new.name := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');

    if new.target_kind = 'comment' then
      select exists (select 1 from public.comments where id = new.target_id) into v_ok;
    elsif new.target_kind = 'photo' then
      select exists (select 1 from public.photos where id = new.target_id) into v_ok;
    elsif new.target_kind = 'drawing' then
      select exists (select 1 from public.drawings where id = new.target_id) into v_ok;
    elsif new.target_kind = 'chat' and to_regclass('public.chat_messages') is not null then
      -- Solo los mensajes de texto del chat (las alertas se confirman con «Entendido»).
      execute 'select exists (select 1 from public.chat_messages where id = $1 and kind = ''texto'')' into v_ok using new.target_id;
    else
      v_ok := false;
    end if;
    if not coalesce(v_ok, false) then
      raise exception 'Eso ya no existe: no se puede reaccionar' using errcode = 'foreign_key_violation';
    end if;

    if (select count(*) from public.reactions r where r.target_kind = new.target_kind and r.target_id = new.target_id and r.user_id = new.user_id) >= 6 then
      raise exception 'Como mucho 6 reacciones distintas por persona. Quita alguna antes de añadir otra' using errcode = 'check_violation';
    end if;
    return new;
  end;
  $f$;

  -- Avisa al autor de lo que ha recibido una reacción (rama nueva: «tu dibujo», categoría de juegos, a la pestaña Juegos).
  create or replace function public.reactions_notify()
  returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $f$
  declare
    v_author uuid;
    v_text text;
    v_kind text;
    v_url text;
    v_what text;
  begin
    begin
      if new.target_kind = 'comment' then
        select created_by, left(nullif(body, ''), 80) into v_author, v_text from public.comments where id = new.target_id;
        v_kind := 'comentario'; v_url := '#plan'; v_what := 'tu comentario';
      elsif new.target_kind = 'photo' then
        select created_by into v_author from public.photos where id = new.target_id;
        v_kind := 'foto'; v_url := '#fotos'; v_what := 'tu foto';
      elsif new.target_kind = 'drawing' then
        select user_id, left(prompt, 80) into v_author, v_text from public.drawings where id = new.target_id;
        v_kind := 'juego'; v_url := '#juegos'; v_what := 'tu dibujo';
      elsif new.target_kind = 'chat' and to_regclass('public.chat_messages') is not null then
        execute 'select user_id, left(nullif(body, ''''), 80) from public.chat_messages where id = $1' into v_author, v_text using new.target_id;
        v_kind := 'chat'; v_url := '#chat'; v_what := 'tu mensaje';
      end if;
      if v_author is null or v_author = new.user_id then
        return new;
      end if;
      if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is not null then
        perform public.push_notify(v_kind, new.emoji || ' ' || new.name || ' reaccionó a ' || v_what, coalesce(v_text, 'Toca para verlo'), v_url, new.user_id, false, null,
          array[v_author], 'reaccion-' || new.target_id::text, false, 'reaccion-' || new.target_id::text || '-' || new.user_id::text, 60);
      end if;
    exception when others then
      raise warning 'reactions_notify: no se pudo avisar (%): %', sqlstate, sqlerrm;
    end;
    return new;
  end;
  $f$;

  -- Al borrar un dibujo se van sus reacciones (la tabla no tiene clave foránea porque apunta a varias tablas).
  drop trigger if exists drawings_reactions_cleanup on public.drawings;
  create trigger drawings_reactions_cleanup
    after delete on public.drawings
    for each row execute function public.reactions_cleanup('drawing');
end
$reac$;
$parte_dibujos$;
  else
    raise notice 'dibujos.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;

-- ======================================================================
-- ia.sql  (se aplica solo si falta)
-- ======================================================================
do $instalar$
begin
  if to_regclass('public.ia_usage') is null then
    raise notice 'Aplicando ia.sql...';
    execute $parte_ia$
-- Ayudas de IA (asistente del viaje, pie de foto, traducir, resumen del día, ideas para los juegos): CUPOS por persona y por día.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql y acceso.sql (usa public.is_member(), public.is_admin(), public.members y
-- auth.users). Una sola vez; el todo en uno solo la aplica si falta public.ia_usage. No depende de ninguna otra parte.
--
-- Esta parte NO llama a la IA: lo hace la Edge Function `ia` (supabase/functions/ia/index.ts), que guarda la clave de Anthropic en los
-- «Secrets» de Supabase (nunca en la base de datos, el código ni la web). Aquí solo está lo que no debe poder falsear el navegador:
-- quién es viajero y cuántas peticiones lleva cada persona hoy. El texto y las fotos que se mandan a la IA NO se guardan en ninguna tabla.
--
-- Contenido:
--   1. public.ia_limits        límites por día, editables solo por administradores (ia_set_limits). Claves: `total` (por persona, todas las
--                              ayudas juntas), `global` (todo el viaje) y una por ayuda (assistant, caption, translate, summary, ideas, describe).
--   2. public.ia_usage         cuántas veces ha usado cada persona cada ayuda cada día. SIN ningún permiso para los clientes.
--   3. Funciones para la Edge Function (solo service_role): ia_who, ia_take, ia_refund.
--   4. Funciones para la web: ia_my_usage (mi gasto de hoy), ia_admin_status y ia_set_limits (solo administradores).
--
-- Cupos: ia_take(persona, ayuda) comprueba los tres límites (esa ayuda, el total de la persona y el global del viaje) y, si hay sitio,
-- cuenta la petición, todo bajo un bloqueo (advisory lock) para que dos peticiones a la vez nunca se pasen del límite. Si la IA falla
-- por su culpa (no por la de la persona) la Edge Function devuelve la petición con ia_refund. El día cambia a las 00:00 UTC (ia_today()).

-- ---------- 1. límites ----------

create table public.ia_limits (
  kind text primary key check (kind in ('total', 'global', 'assistant', 'caption', 'translate', 'summary', 'ideas', 'describe')),
  max_per_day integer not null check (max_per_day between 0 and 100000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

-- Por defecto: 60 peticiones al día por persona (30 del asistente, 20 de pie de foto, 40 de traducir, 10 de resumen, 20 de ideas y 20
-- de describir fotos) y 400 al día entre todos. 0 apaga esa ayuda.
insert into public.ia_limits (kind, max_per_day) values
  ('total', 60), ('global', 400), ('assistant', 30), ('caption', 20), ('translate', 40), ('summary', 10), ('ideas', 20), ('describe', 20)
on conflict (kind) do nothing;

revoke all on public.ia_limits from anon, authenticated;
grant select on public.ia_limits to authenticated; -- nadie escribe directamente: lo hace ia_set_limits
alter table public.ia_limits enable row level security;
create policy ia_limits_select on public.ia_limits
  for select to authenticated using (public.is_member());

-- ---------- 2. uso ----------

create table public.ia_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('assistant', 'caption', 'translate', 'summary', 'ideas', 'describe')),
  count integer not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day, kind)
);
create index ia_usage_day_idx on public.ia_usage (day);

-- Ningún permiso ni política: ni los viajeros ni los administradores leen ni escriben aquí directamente (solo las funciones de abajo).
revoke all on public.ia_usage from anon, authenticated;
alter table public.ia_usage enable row level security;

-- ---------- ayudas internas ----------

-- El día de los cupos. Cambiar «UTC» por una zona (p. ej. 'America/New_York') hace que el día empiece a medianoche allí.
create or replace function public.ia_today()
returns date
language sql stable
as $$ select (now() at time zone 'UTC')::date $$;
revoke all on function public.ia_today() from public, anon, authenticated;

-- El límite vigente de una clave (si alguien borrara su fila, vale el de por defecto).
create or replace function public.ia_limit_of(p_kind text)
returns integer
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select max_per_day from public.ia_limits where kind = p_kind),
    case p_kind when 'total' then 60 when 'global' then 400 when 'assistant' then 30 when 'caption' then 20 when 'translate' then 40
                when 'summary' then 10 when 'ideas' then 20 when 'describe' then 20 else 0 end
  );
$$;
revoke all on function public.ia_limit_of(text) from public, anon, authenticated;

-- ---------- 3. funciones para la Edge Function (solo service_role) ----------

-- ¿Este correo es viajero? ¿Y administrador? El correo sale del usuario que Supabase Auth acaba de validar, nunca de la petición.
create or replace function public.ia_who(p_email text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'member', exists (select 1 from public.members where email = lower(coalesce(p_email, ''))),
    'admin', exists (select 1 from public.members where email = lower(coalesce(p_email, '')) and is_admin)
  );
$$;
revoke all on function public.ia_who(text) from public, anon, authenticated;

-- Cuenta una petición de esa persona si queda cupo. Devuelve { ok, reason, ... }: reason = 'kind' (esa ayuda), 'total' (todas las de la
-- persona) o 'global' (todo el viaje) cuando no hay sitio; no cuenta nada en ese caso. Una a una (bloqueo): sin carreras.
create or replace function public.ia_take(p_user uuid, p_kind text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_day date := public.ia_today();
  v_kind_limit integer;
  v_total_limit integer;
  v_global_limit integer;
  v_kind_used integer;
  v_total_used integer;
  v_global_used integer;
  v_reason text;
begin
  if p_user is null then
    raise exception 'Falta la persona';
  end if;
  if p_kind is null or p_kind not in ('assistant', 'caption', 'translate', 'summary', 'ideas', 'describe') then
    raise exception 'Esa ayuda de IA no existe';
  end if;
  perform pg_advisory_xact_lock(727201);

  delete from public.ia_usage where day < v_day - 90; -- historial de tres meses (para el gasto de la semana y el cálculo del coste)

  v_kind_limit := public.ia_limit_of(p_kind);
  v_total_limit := public.ia_limit_of('total');
  v_global_limit := public.ia_limit_of('global');
  select coalesce(sum(count) filter (where kind = p_kind), 0), coalesce(sum(count), 0)
    into v_kind_used, v_total_used
    from public.ia_usage where user_id = p_user and day = v_day;
  select coalesce(sum(count), 0) into v_global_used from public.ia_usage where day = v_day;

  if v_kind_used >= v_kind_limit then
    v_reason := 'kind';
  elsif v_total_used >= v_total_limit then
    v_reason := 'total';
  elsif v_global_used >= v_global_limit then
    v_reason := 'global';
  else
    insert into public.ia_usage (user_id, day, kind, count) values (p_user, v_day, p_kind, 1)
      on conflict (user_id, day, kind) do update set count = public.ia_usage.count + 1, updated_at = now();
    v_kind_used := v_kind_used + 1;
    v_total_used := v_total_used + 1;
    v_global_used := v_global_used + 1;
  end if;

  return jsonb_build_object(
    'ok', v_reason is null, 'reason', v_reason, 'kind', p_kind, 'day', v_day,
    'kind_used', v_kind_used, 'kind_limit', v_kind_limit,
    'total_used', v_total_used, 'total_limit', v_total_limit,
    'global_used', v_global_used, 'global_limit', v_global_limit
  );
end;
$$;
revoke all on function public.ia_take(uuid, text) from public, anon, authenticated;

-- Devuelve una petición que no se pudo atender por un fallo de la IA (la persona no tiene la culpa). No baja de cero.
create or replace function public.ia_refund(p_user uuid, p_kind text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(727201);
  update public.ia_usage set count = count - 1, updated_at = now()
    where user_id = p_user and day = public.ia_today() and kind = p_kind and count > 0;
end;
$$;
revoke all on function public.ia_refund(uuid, text) from public, anon, authenticated;

-- ---------- 4. funciones para la web ----------

-- Mi gasto de hoy: cuántas peticiones llevo de cada ayuda, mis límites y cuánto queda del cupo de todo el viaje.
create or replace function public.ia_my_usage()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_day date := public.ia_today();
  v_global_used integer;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select coalesce(sum(count), 0) into v_global_used from public.ia_usage where day = v_day;
  return jsonb_build_object(
    'day', v_day,
    'used', (select coalesce(jsonb_object_agg(kind, count), '{}'::jsonb) from public.ia_usage where user_id = auth.uid() and day = v_day),
    'total_used', (select coalesce(sum(count), 0) from public.ia_usage where user_id = auth.uid() and day = v_day),
    'limits', (select coalesce(jsonb_object_agg(kind, max_per_day), '{}'::jsonb) from public.ia_limits),
    'global_left', greatest(public.ia_limit_of('global') - v_global_used, 0)
  );
end;
$$;
revoke all on function public.ia_my_usage() from public, anon;
grant execute on function public.ia_my_usage() to authenticated;

-- Solo administradores: el gasto de hoy por persona, los límites vigentes y lo gastado en los últimos 7 días.
create or replace function public.ia_admin_status()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_day date := public.ia_today();
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'day', v_day,
    'limits', (select coalesce(jsonb_object_agg(kind, max_per_day), '{}'::jsonb) from public.ia_limits),
    'global_used', (select coalesce(sum(count), 0) from public.ia_usage where day = v_day),
    'people', (
      select coalesce(jsonb_agg(p order by (p ->> 'total')::int desc, p ->> 'email'), '[]'::jsonb)
      from (
        select jsonb_build_object('user_id', u.user_id, 'email', coalesce(a.email, ''), 'total', sum(u.count)::int, 'kinds', jsonb_object_agg(u.kind, u.count)) as p
        from public.ia_usage u left join auth.users a on a.id = u.user_id
        where u.day = v_day
        group by u.user_id, a.email
      ) s
    ),
    'days', (
      select coalesce(jsonb_agg(d order by d ->> 'day' desc), '[]'::jsonb)
      from (select jsonb_build_object('day', day, 'total', sum(count)::int) as d from public.ia_usage where day > v_day - 7 group by day) s
    )
  );
end;
$$;
revoke all on function public.ia_admin_status() from public, anon;
grant execute on function public.ia_admin_status() to authenticated;

-- Solo administradores: cambiar uno o varios límites, p. ej. {"total": 40, "translate": 20}. 0 apaga esa ayuda. Devuelve todos los límites.
create or replace function public.ia_set_limits(p_limits jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_limits is null or jsonb_typeof(p_limits) <> 'object' or p_limits = '{}'::jsonb then
    raise exception 'Indica qué límites cambiar';
  end if;
  for r in select key, value from jsonb_each(p_limits) loop
    if r.key not in ('total', 'global', 'assistant', 'caption', 'translate', 'summary', 'ideas', 'describe') then
      raise exception 'Ese límite no existe: %', left(r.key, 40);
    end if;
    if jsonb_typeof(r.value) <> 'number' or (r.value #>> '{}') !~ '^[0-9]{1,6}$' or (r.value #>> '{}')::int > 100000 then
      raise exception 'El límite de «%» tiene que ser un número entero entre 0 y 100000', r.key;
    end if;
  end loop;
  perform pg_advisory_xact_lock(727201);
  for r in select key, (value #>> '{}')::int as n from jsonb_each(p_limits) loop
    insert into public.ia_limits (kind, max_per_day, updated_by) values (r.key, r.n, auth.uid())
      on conflict (kind) do update set max_per_day = excluded.max_per_day, updated_at = now(), updated_by = auth.uid();
  end loop;
  return (select jsonb_object_agg(kind, max_per_day) from public.ia_limits);
end;
$$;
revoke all on function public.ia_set_limits(jsonb) from public, anon;
grant execute on function public.ia_set_limits(jsonb) to authenticated;

-- ---------- service_role (la Edge Function) ----------

-- En Supabase existe el rol service_role (la Edge Function lo usa); se le dan de forma explícita las tres funciones internas y la
-- lectura de las tablas por si el proyecto no se las da por defecto. Si el rol no existe (una base sin Supabase) no se hace nada.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.ia_limits, public.ia_usage to service_role;
    grant execute on function public.ia_who(text) to service_role;
    grant execute on function public.ia_take(uuid, text) to service_role;
    grant execute on function public.ia_refund(uuid, text) to service_role;
  end if;
end
$$;
$parte_ia$;
  else
    raise notice 'ia.sql: ya estaba aplicado, se omite';
  end if;
end
$instalar$;
