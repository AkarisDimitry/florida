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
