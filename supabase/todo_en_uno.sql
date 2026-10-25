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
  if to_regclass('public.invest_accounts') is null then
    raise notice 'Aplicando juego_bolsa.sql...';
    execute $parte_juego_bolsa$
-- Juego «Bolsa de valores»: mercado ficticio con temática de viaje. Ejecutar en Supabase → SQL Editor DESPUÉS de
-- schema.sql y acceso.sql (usa public.is_member() y public.is_admin()). Una sola vez. No depende de ningún otro archivo.
--
-- Cada viajero entra con 200.000 $ de mentira y compra y vende 10 activos inventados. Todos ven las cuentas, las
-- carteras y cada operación de todos (la transparencia es parte del juego).
--
-- QUIÉN MANDA: la base de datos. Ni el navegador ni ninguna API externa ponen los precios, ni escriben cuentas u
-- operaciones. Los clientes solo pueden LEER (con RLS: solo los viajeros) y todo lo que escribe va por funciones
-- `security definer` que toman al usuario de auth.uid() (nunca de un parámetro) y comprueban saldo y posición.
--
-- Contenido:
--   1. public.invest_assets      los 10 activos y los parámetros de su curva de precios (solo lectura).
--   2. Precios                   invest_price (interna), market_price, market_prices, market_history, market_sparks.
--   3. public.invest_accounts    una cuenta por viajero (efectivo). NINGUNA escritura directa.
--   4. public.invest_trades      cada compra y venta de todos. NINGUNA escritura directa.
--   5. Funciones de escritura    join_market, place_trade, reset_market (solo administradores).
--   6. Funciones de lectura      invest_leaderboard, invest_positions, invest_best_worst (todo calculado aquí).
--   7. Tiempo real               invest_trades en supabase_realtime.
--
-- CÓMO SE CALCULA EL PRECIO (sin servidor de bolsa): es una función DETERMINISTA de la hora, así que todos ven el
-- mismo precio y el navegador no puede falsearlo:
--     precio(t) = base · exp( vol · Σ a_i · sin(2π·t / T_i + φ_i) )          i = 1..4, redondeado a 2 decimales
--   · t = minutos enteros desde 2026-01-01 00:00 UTC (se trunca al minuto: durante un minuto el precio es el mismo
--     para todos y la operación se ejecuta al precio que se estaba viendo, salvo que cambie el minuto).
--   · Cuatro ondas por activo: un temblor de ~20-40 min, otra de unas horas, una de ~1 día y una de 11-19 días
--     (la que mueve la semana). Con los periodos distintos y las fases al azar, cada activo se mueve a su aire.
--   · `vol` es la volatilidad del activo (0,03 = tranquilo, 0,12 = muy movido) y `exp(...)` garantiza precio > 0.
--   · Medido sobre 60 días con las 10 curvas (ventanas de máximo/mínimo): en 10 min el rango típico va de ~0,2 % (los
--     tranquilos) a ~0,35 % (los movidos); en 24 h de ~3 % a ~6,5 % (hasta ~9 % en los peores días); y el cambio
--     en una semana llega a unos ±7 % en los tranquilos y ±25 % en los más volátiles.
--   LÍMITE CONOCIDO: una función determinista se puede calcular de antemano. Este repositorio es público, así que
--   quien lea este archivo puede calcular precios futuros y hacer trampa en un juego entre amigos. Si importara, la
--   solución es meter en la fórmula una semilla secreta (una fila de una tabla sin permisos para los clientes).
--
-- OPERACIONES: la posición de un activo es Σ compras − Σ ventas del usuario. place_trade bloquea la fila de la cuenta
-- (`for update`) mientras opera, así que dos toques seguidos (o dos dispositivos) se ejecutan uno detrás de otro y no
-- se puede gastar dos veces el mismo dinero ni vender dos veces la misma posición. Cantidad: > 0, máx. 6 decimales
-- y 1.000.000 de unidades por operación. Mínimo de operación: 1 $ (salvo vender lo que queda de una posición).
--
-- COSTE MEDIO (invest_positions.avg_cost): media ponderada móvil. Cada compra recalcula la media con lo que ya había;
-- una venta no la cambia (solo quita unidades); si se vende todo, se reinicia. La ganancia de una posición (pnl) es
-- su valor actual menos cantidad × coste medio.
--
-- MEJOR Y PEOR OPERACIÓN (invest_best_worst): ganancia de cada operación frente al precio de hoy: una compra gana
-- (precio hoy − precio pagado) × cantidad; una venta gana (precio vendido − precio hoy) × cantidad (lo que ganó o
-- perdió por vender en vez de esperar).

-- ---------- 1. activos ----------

create table public.invest_assets (
  symbol text primary key check (symbol ~ '^[A-Z]{3,5}$'),
  name text not null check (char_length(name) between 1 and 40),
  emoji text not null check (char_length(emoji) between 1 and 8),
  base numeric not null check (base > 0),
  vol numeric not null check (vol > 0 and vol <= 1),
  -- Ondas de la curva (ver arriba): periodo en minutos, amplitud relativa y fase en radianes; mismo número de cada una.
  periods numeric[] not null check (cardinality(periods) between 1 and 8 and 0 < all (periods)),
  amps numeric[] not null constraint invest_assets_amps_check check (cardinality(amps) = cardinality(periods)),
  phases numeric[] not null constraint invest_assets_phases_check check (cardinality(phases) = cardinality(periods)),
  sort smallint not null default 0
);

insert into public.invest_assets (symbol, name, emoji, base, vol, periods, amps, phases, sort) values
  ('HELA', 'Helados de Miami',        '🍦',  24.80, 0.038, '{19,131,1330,19800}',  '{0.055,0.150,0.220,1}', '{0.6,2.1,4.0,1.3}', 1),
  ('FLAM', 'Flamingo Coin',           '🦩',  41.20, 0.105, '{23,157,1510,17600}',  '{0.024,0.078,0.110,1}', '{3.1,0.4,5.2,0.2}', 2),
  ('CANG', 'Cangrejo Futures',        '🦀',  87.50, 0.085, '{29,203,1260,22400}',  '{0.030,0.095,0.140,1}', '{1.7,3.3,0.9,2.8}', 3),
  ('SOLF', 'Sol de Florida',          '☀️', 156.00, 0.032, '{17,241,1620,24900}',  '{0.060,0.160,0.230,1}', '{5.0,1.1,2.4,4.4}', 4),
  ('AIRB', 'Airboat Motors',          '🚤', 238.00, 0.062, '{31,173,1440,27300}',  '{0.036,0.110,0.170,1}', '{2.2,5.6,3.7,0.7}', 5),
  ('GATR', 'Gator Capital',           '🐊',  64.30, 0.115, '{21,119,1700,15800}',  '{0.022,0.068,0.100,1}', '{4.2,2.7,1.5,3.9}', 6),
  ('CAFE', 'Cafecito Cubano S.A.',    '☕',  18.90, 0.060, '{37,187,1180,21200}',  '{0.040,0.120,0.190,1}', '{0.3,4.8,2.9,5.5}', 7),
  ('COHE', 'Cohetes del Cabo',        '🚀', 320.00, 0.120, '{27,139,1380,20100}',  '{0.020,0.072,0.100,1}', '{1.1,3.9,4.6,2.0}', 8),
  ('RUTA', 'Gasolina Ruta 1',         '⛽',  31.50, 0.040, '{41,223,1550,25800}',  '{0.060,0.160,0.210,1}', '{2.6,0.9,5.9,3.4}', 9),
  ('MALE', 'Maletas Express',         '🧳',  74.80, 0.072, '{25,167,1290,18900}',  '{0.032,0.100,0.160,1}', '{3.8,1.9,0.6,1.1}', 10);

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y solo se da lectura.
revoke all on public.invest_assets from anon, authenticated;
grant select on public.invest_assets to authenticated;
alter table public.invest_assets enable row level security;
create policy invest_assets_select on public.invest_assets
  for select to authenticated using (public.is_member());

-- ---------- ayudas internas (los clientes no las ejecutan; las usan las funciones de abajo) ----------

-- La curva de precios: pura y determinista (misma hora ⇒ mismo precio). Ver la explicación de arriba.
create or replace function public.invest_price(p_base numeric, p_vol numeric, p_periods numeric[], p_amps numeric[], p_phases numeric[], p_at timestamptz)
returns numeric
language sql immutable set search_path = public, pg_temp
as $$
  select greatest(0.01, round((
    p_base::float8 * exp(p_vol::float8 * coalesce((
      select sum(p_amps[i]::float8 * sin(2 * pi() * floor((extract(epoch from p_at) - 1767225600) / 60)::float8 / p_periods[i]::float8 + p_phases[i]::float8))
      from generate_subscripts(p_periods, 1) as i
    ), 0))
  )::numeric, 2));
$$;
revoke all on function public.invest_price(numeric, numeric, numeric[], numeric[], numeric[], timestamptz) from public, anon, authenticated;

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

-- ---------- 2. precios: lo que ve el cliente ----------

-- Precio de un activo a una hora (por defecto, ahora). Solo viajeros.
create or replace function public.market_price(p_symbol text, p_at timestamptz default now())
returns numeric
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  a public.invest_assets;
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into a from public.invest_assets where symbol = upper(btrim(coalesce(p_symbol, '')));
  if not found then
    raise exception 'Ese activo no existe en la bolsa';
  end if;
  return public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, p_at);
end;
$$;
revoke all on function public.market_price(text, timestamptz) from public, anon;
grant execute on function public.market_price(text, timestamptz) to authenticated;

-- Todos los activos con su precio de ahora y el cambio respecto a hace 24 horas (en %).
create or replace function public.market_prices()
returns table (symbol text, name text, emoji text, price numeric, change_24h_pct numeric)
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
    select a.symbol, a.name, a.emoji, p.now_price,
           round((p.now_price / p.old_price - 1) * 100, 2)
    from public.invest_assets a
    cross join lateral (select public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, v_now) as now_price,
                               public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, v_now - interval '24 hours') as old_price) p
    order by a.sort, a.symbol;
end;
$$;
revoke all on function public.market_prices() from public, anon;
grant execute on function public.market_prices() to authenticated;

-- Serie de precios de un activo para dibujar el gráfico: p_points puntos repartidos entre hace p_hours horas y ahora
-- (límites: 1-720 horas y 2-500 puntos). Ordenada por hora.
create or replace function public.market_history(p_symbol text, p_hours int default 48, p_points int default 96)
returns table (t timestamptz, price numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  a public.invest_assets;
  v_last timestamptz := date_trunc('minute', clock_timestamp());
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 720 or p_points is null or p_points not between 2 and 500 then
    raise exception 'El historial admite de 1 a 720 horas y de 2 a 500 puntos';
  end if;
  select * into a from public.invest_assets where symbol = upper(btrim(coalesce(p_symbol, '')));
  if not found then
    raise exception 'Ese activo no existe en la bolsa';
  end if;
  return query
    select s.ts, public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, s.ts)
    from (select v_last - (p_hours * 3600.0 * (p_points - 1 - i) / (p_points - 1)) * interval '1 second' as ts
          from generate_series(0, p_points - 1) as i) s
    order by s.ts;
end;
$$;
revoke all on function public.market_history(text, int, int) from public, anon;
grant execute on function public.market_history(text, int, int) to authenticated;

-- Los mini gráficos de todos los activos de una sola vez (una consulta en vez de diez).
-- Límites: 1-168 horas y 2-60 puntos por activo.
create or replace function public.market_sparks(p_hours int default 24, p_points int default 24)
returns table (symbol text, t timestamptz, price numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_last timestamptz := date_trunc('minute', clock_timestamp());
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 168 or p_points is null or p_points not between 2 and 60 then
    raise exception 'Los mini gráficos admiten de 1 a 168 horas y de 2 a 60 puntos';
  end if;
  return query
    select a.symbol, s.ts, public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, s.ts)
    from public.invest_assets a
    cross join lateral (select v_last - (p_hours * 3600.0 * (p_points - 1 - i) / (p_points - 1)) * interval '1 second' as ts
                        from generate_series(0, p_points - 1) as i) s
    order by a.sort, a.symbol, s.ts;
end;
$$;
revoke all on function public.market_sparks(int, int) from public, anon;
grant execute on function public.market_sparks(int, int) to authenticated;

-- ---------- 3. cuentas ----------

create table public.invest_accounts (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- `<> 'NaN'`: en numeric, NaN se ordena por encima de todos los números y pasaría `cash >= 0`.
  cash numeric(14, 2) not null default 200000 check (cash >= 0 and cash <> 'NaN'),
  created_at timestamptz not null default now()
);

-- ---------- 4. operaciones ----------

create table public.invest_trades (
  id bigint generated always as identity primary key, -- el orden de las operaciones de cada jugador (coste medio)
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40), -- su nombre cuando operó
  symbol text not null references public.invest_assets (symbol),
  side text not null check (side in ('buy', 'sell')),
  qty numeric(18, 6) not null check (qty > 0 and qty <= 1000000),
  price numeric(14, 2) not null check (price > 0),
  total numeric(14, 2) not null check (total >= 0),
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

-- ---------- 5. escritura: solo por estas funciones ----------

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

-- Comprar o vender. Siempre al precio oficial de ESTE momento (el servidor lo calcula; el cliente no lo envía) y
-- siempre como quien llama (auth.uid()). Devuelve la operación guardada. Los fallos explican en español qué pasó.
create or replace function public.place_trade(p_symbol text, p_side text, p_qty numeric)
returns public.invest_trades
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_side text := lower(btrim(coalesce(p_side, '')));
  v_acc public.invest_accounts;
  v_held numeric;
  v_now timestamptz;
  v_price numeric;
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
  if not exists (select 1 from public.invest_assets where symbol = v_symbol) then
    raise exception 'Ese activo no existe en la bolsa';
  end if;

  -- Se bloquea la cuenta hasta el final de la operación: otra operación del mismo jugador espera aquí y, al
  -- continuar, ya ve el saldo y las posiciones actualizados.
  select * into v_acc from public.invest_accounts where user_id = v_uid for update;
  if not found then
    raise exception 'Primero entra a la bolsa para recibir tus 200.000 $';
  end if;

  v_now := clock_timestamp();
  v_price := public.market_price(v_symbol, v_now);
  v_total := round(p_qty * v_price, 2);

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

  insert into public.invest_trades (user_id, name, symbol, side, qty, price, total, created_at)
    values (v_uid, v_acc.name, v_symbol, v_side, p_qty, v_price, v_total, v_now)
    returning * into v_trade;
  return v_trade;
end;
$$;
revoke all on function public.place_trade(text, text, numeric) from public, anon;
grant execute on function public.place_trade(text, text, numeric) to authenticated;

-- Reiniciar la bolsa: solo administradores. Borra todas las operaciones y deja a todos con 200.000 $ (las cuentas
-- siguen). Devuelve cuántas cuentas se reiniciaron. (`where true`: las extensiones de seguridad de Supabase, como
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

-- ---------- 6. lectura: todo calculado aquí (una sola fuente de verdad) ----------

-- Posición de cada jugador en cada activo (solo lo que tiene ahora): cantidad y coste medio (media ponderada móvil;
-- ver arriba). Interna: la usan invest_positions e invest_leaderboard.
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

-- Todas las posiciones de todos: cantidad, coste medio, precio de ahora, valor y ganancia (valor − cantidad × coste medio).
create or replace function public.invest_positions()
returns table (user_id uuid, name text, symbol text, qty numeric, avg_cost numeric, price numeric, value numeric, pnl numeric)
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
    select h.user_id, ac.name, h.symbol, h.qty, round(h.avg_cost, 4), px.p,
           round(h.qty * px.p, 2),
           round(h.qty * px.p, 2) - round(h.qty * h.avg_cost, 2)
    from public.invest_holdings() h
    join public.invest_accounts ac on ac.user_id = h.user_id
    join public.invest_assets a on a.symbol = h.symbol
    cross join lateral (select public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, v_now) as p) px
    order by ac.name, ac.user_id, a.sort, h.symbol;
end;
$$;
revoke all on function public.invest_positions() from public, anon;
grant execute on function public.invest_positions() to authenticated;

-- Clasificación: por jugador, efectivo + valor de sus posiciones = patrimonio (total), ganancia en % sobre los
-- 200.000 $ iniciales y número de operaciones. Ordenada por patrimonio (y por nombre si empatan).
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

-- La mejor y la peor operación de todos (ver arriba cómo se mide). Dos filas ('best' y 'worst'), o ninguna si
-- nadie ha operado (con una sola operación, las dos son la misma).
create or replace function public.invest_best_worst()
returns table (kind text, id bigint, user_id uuid, name text, symbol text, side text, qty numeric, price numeric, total numeric, created_at timestamptz, price_now numeric, gain numeric, asset_name text)
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
    with g as (
      select t.id, t.user_id, t.name, t.symbol, t.side, t.qty, t.price, t.total, t.created_at, px.p as price_now,
             round(case t.side when 'buy' then px.p - t.price else t.price - px.p end * t.qty, 2) as gain, a.name as asset_name
      from public.invest_trades t
      join public.invest_assets a on a.symbol = t.symbol
      cross join lateral (select public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, v_now) as p) px
    )
    (select 'best'::text, g.* from g order by g.gain desc, g.id limit 1)
    union all
    (select 'worst'::text, g.* from g order by g.gain, g.id limit 1);
end;
$$;
revoke all on function public.invest_best_worst() from public, anon;
grant execute on function public.invest_best_worst() to authenticated;

-- ---------- 7. tiempo real ----------

-- Las operaciones nuevas llegan a todos sin recargar (Realtime respeta la política de lectura de arriba).
alter publication supabase_realtime add table public.invest_trades;
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
