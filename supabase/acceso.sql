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
