-- «Punto de encuentro»: un viajero fija un punto en el mapa («nos vemos aquí»), a todos les suena el móvil y cada uno responde
-- «voy llegando (10 min)», «ya llegué» o «no puedo». Todos ven el pin, quién viene y quién falta.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql (usa public.is_member()) y acceso.sql (usa public.is_admin()).
-- Una sola vez (el todo en uno solo lo aplica si falta public.meetups). No depende de ningún otro SQL; el aviso fuerte a todos
-- (parte `avisos`) es OPCIONAL: sin ella el punto de encuentro funciona igual, solo que no llegan avisos con el móvil cerrado.
--
-- Contenido:
--   1. public.meetups          los puntos de encuentro. Como mucho UNO activo a la vez (lo garantiza un índice único parcial).
--   2. public.meetup_replies   la respuesta de cada viajero a un punto (una fila por persona y punto).
--   3. Funciones               create_meetup, reply_meetup y close_meetup (escriben; security definer) y dos internas:
--                              meetup_notify (avisa de forma defensiva) y los disparadores meetups_prepare / meetup_replies_prepare.
--   4. Tiempo real             meetups y meetup_replies en supabase_realtime.
--
-- Estados y caducidad: un punto nace `active` y pasa a `closed` cuando lo cierra quien lo fijó o un administrador
-- (public.close_meetup). Además CADUCA SOLO a las 6 h (`expires_at`, que pone el servidor): pasado ese momento ya no admite
-- respuestas y las pantallas lo tratan como cerrado, aunque la fila siga marcada `active` hasta que alguien cree otro punto
-- (create_meetup cierra antes los caducados; así el índice único no estorba).
--
-- Seguridad: NINGUNA escritura directa desde el cliente (ni INSERT, ni UPDATE, ni DELETE): todo pasa por las tres funciones, que
-- comprueban que quien llama es viajero, que cada uno solo responde por sí mismo (user_id sale de auth.uid()), que solo se
-- responde mientras el punto está activo y que solo lo cierra su creador o un administrador. Las horas las pone el servidor y
-- los nombres se normalizan (espacios, máximo 40 caracteres). Lectura solo para viajeros (RLS con public.is_member()).
--
-- Avisos (contrato con la parte `avisos`): si existe public.push_notify(...) se le llama de forma DEFENSIVA (meetup_notify): un
-- fallo al avisar NUNCA hace fallar ni revierte la acción de la persona. Al fijar el punto: aviso URGENTE a todos menos al creador.
-- Cuando alguien responde: aviso normal SOLO al creador. Al cerrarlo a mano: aviso normal a todos menos a quien lo cierra.

-- ---------- puntos de encuentro ----------

create table public.meetups (
  id uuid primary key default gen_random_uuid(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,  -- si se borra al usuario, el punto sigue (solo un administrador lo cierra)
  created_by_name text not null check (char_length(created_by_name) between 1 and 40),
  title text not null default 'Punto de encuentro' check (char_length(title) between 1 and 60 and title = btrim(title)),
  note text check (char_length(note) <= 200),
  place text check (char_length(place) <= 120),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  expires_at timestamptz not null default now() + interval '6 hours',
  -- (0, 0) es el «punto nulo» que mandan los móviles cuando no saben dónde están: no es un sitio de encuentro.
  constraint meetups_coords_check check (not (lat = 0 and lng = 0)),
  -- La hora de cierre acompaña al estado.
  constraint meetups_times_check check ((status = 'active' and closed_at is null) or (status = 'closed' and closed_at is not null)),
  constraint meetups_expires_check check (expires_at > created_at)
);

-- Como mucho un punto activo: el índice único parcial sobre una constante admite una sola fila `active`, aunque dos personas
-- lo fijen en el mismo instante.
create unique index meetups_one_active_idx on public.meetups ((true)) where status = 'active';
create index meetups_created_at_idx on public.meetups (created_at desc);

-- ---------- respuestas ----------

create table public.meetup_replies (
  meetup_id uuid not null references public.meetups (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  status text not null check (status in ('voy', 'llegue', 'no_puedo')),
  eta_minutes smallint,
  updated_at timestamptz not null default now(),
  primary key (meetup_id, user_id),
  -- Los minutos de llegada solo tienen sentido con «voy» (y entre 1 y 180).
  constraint meetup_replies_eta_check check (eta_minutes is null or (status = 'voy' and eta_minutes between 1 and 180))
);

-- ---------- permisos y RLS ----------

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
revoke all on public.meetups, public.meetup_replies from anon, authenticated;
grant select on public.meetups to authenticated;         -- nadie escribe directamente: lo hacen las funciones
grant select on public.meetup_replies to authenticated;

alter table public.meetups enable row level security;
alter table public.meetup_replies enable row level security;

create policy meetups_select on public.meetups
  for select to authenticated using (public.is_member());
create policy meetup_replies_select on public.meetup_replies
  for select to authenticated using (public.is_member());

-- ---------- disparadores: hora del servidor, nombre limpio y respuestas solo en puntos activos ----------

-- La hora de creación y la de caducidad las pone siempre el servidor (el cliente ni siquiera puede escribirlas).
create or replace function public.meetups_prepare()
returns trigger
language plpgsql set search_path = public
as $$
begin
  new.created_at := now();
  new.expires_at := new.created_at + interval '6 hours';
  return new;
end;
$$;
revoke all on function public.meetups_prepare() from public, anon, authenticated;

create trigger meetups_prepare
  before insert on public.meetups
  for each row execute function public.meetups_prepare();

-- Antes de guardar una respuesta: el punto tiene que seguir activo (se bloquea su fila FOR SHARE, así nadie cierra el punto en
-- mitad de una respuesta: close_meetup pide el bloqueo exclusivo y espera), la hora es la del servidor y el nombre se limpia.
-- Es una segunda barrera: reply_meetup ya lo comprueba, pero si algún día se concediera INSERT/UPDATE, esto seguiría protegiendo.
create or replace function public.meetup_replies_prepare()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
  v_expires timestamptz;
begin
  select m.status, m.expires_at into v_status, v_expires from public.meetups m where m.id = new.meetup_id for share;
  if not found then
    raise exception 'Ese punto de encuentro no existe';
  elsif v_status <> 'active' or v_expires <= now() then
    raise exception 'Este punto de encuentro ya ha terminado';
  end if;
  new.updated_at := now();
  new.name := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
  return new;
end;
$$;
revoke all on function public.meetup_replies_prepare() from public, anon, authenticated;

create trigger meetup_replies_prepare
  before insert or update on public.meetup_replies
  for each row execute function public.meetup_replies_prepare();

-- ---------- aviso defensivo ----------

-- Llama a public.push_notify (parte `avisos`) SOLO si existe y sin que un fallo afecte nunca a quien llama: sin la parte
-- `avisos`, sin pg_net, con la función de envío caída o con cualquier error, esto como mucho deja un WARNING en el registro.
-- La firma es la del contrato con la parte `avisos` (no cambiarla sin avisar).
create or replace function public.meetup_notify(
  p_title text, p_body text, p_exclude uuid, p_urgent boolean, p_only uuid[], p_tag text, p_dedupe_key text, p_dedupe_seconds integer
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is null then
    return;
  end if;
  begin
    perform public.push_notify('encuentro', p_title, p_body, '#mapa', p_exclude, p_urgent, null::text, p_only, p_tag, false, p_dedupe_key, p_dedupe_seconds);
  exception when others then
    raise warning 'No se pudo enviar el aviso del punto de encuentro: %', sqlerrm;
  end;
end;
$$;
revoke all on function public.meetup_notify(text, text, uuid, boolean, uuid[], text, text, integer) from public, anon, authenticated;

-- ---------- fijar, responder y cerrar ----------

-- Fija un punto de encuentro y devuelve su id. `p_title` y `p_note` pueden ser null (título «Punto de encuentro», sin nota);
-- `p_place` es el nombre del sitio si se conoce y `p_name` el nombre que se muestra («Lo fijó Ana»); como en el resto de la web
-- lo manda la página (la identidad real es created_by = auth.uid()). Falla si ya hay un punto activo y dice quién lo fijó.
create or replace function public.create_meetup(
  p_title text, p_note text, p_lat double precision, p_lng double precision, p_place text default null, p_name text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_title text := coalesce(nullif(btrim(regexp_replace(coalesce(p_title, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), ''), 'Punto de encuentro');
  v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), '');
  v_place text := nullif(btrim(regexp_replace(coalesce(p_place, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), '');
  v_name text := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
  v_id uuid;
  v_other text;
  v_body text;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if char_length(v_title) > 60 then
    raise exception 'El título es demasiado largo: máximo 60 caracteres';
  end if;
  if char_length(coalesce(v_note, '')) > 200 then
    raise exception 'La nota es demasiado larga: máximo 200 caracteres';
  end if;
  if char_length(coalesce(v_place, '')) > 120 then
    raise exception 'El nombre del sitio es demasiado largo: máximo 120 caracteres';
  end if;
  if p_lat is null or p_lng is null then
    raise exception 'Falta el sitio: elige dónde es el punto de encuentro';
  end if;
  -- `not between` también rechaza NaN e infinito (en Postgres, NaN es mayor que cualquier número).
  if not (p_lat between -90 and 90) or not (p_lng between -180 and 180) or (p_lat = 0 and p_lng = 0) then
    raise exception 'Esas coordenadas no son válidas';
  end if;

  -- Los puntos que ya caducaron se cierran antes: si no, seguirían ocupando el único hueco del índice.
  update public.meetups set status = 'closed', closed_at = expires_at where status = 'active' and expires_at <= now();

  select m.created_by_name into v_other from public.meetups m where m.status = 'active';
  if found then
    raise exception 'Ya hay un punto de encuentro activo: lo fijó %. Quien lo fijó o un administrador puede cerrarlo para fijar otro', v_other;
  end if;
  begin
    insert into public.meetups (title, note, place, lat, lng, created_by_name)
    values (v_title, v_note, v_place, p_lat, p_lng, v_name)
    returning id into v_id;
  exception when unique_violation then
    -- Dos personas lo fijaron a la vez: ganó la otra.
    select m.created_by_name into v_other from public.meetups m where m.status = 'active';
    raise exception 'Ya hay un punto de encuentro activo: lo fijó %. Quien lo fijó o un administrador puede cerrarlo para fijar otro', coalesce(v_other, 'otra persona');
  end;

  v_body := coalesce(nullif(concat_ws(' · ', v_place, v_note), '') || ' — ', '') || 'Toca para ver cómo llegar';
  perform public.meetup_notify('📍 ' || v_name || ' fija un punto de encuentro', v_body, v_uid, true, null, 'encuentro-' || v_id::text, null, 0);
  return v_id;
end;
$$;
revoke all on function public.create_meetup(text, text, double precision, double precision, text, text) from public, anon;
grant execute on function public.create_meetup(text, text, double precision, double precision, text, text) to authenticated;

-- Responde a un punto: `voy` (con los minutos que faltan, opcional, de 1 a 180), `llegue` o `no_puedo`. Cada uno solo cambia SU
-- respuesta y se puede cambiar las veces que haga falta mientras el punto siga activo. Avisa SOLO a quien lo fijó.
create or replace function public.reply_meetup(p_meetup uuid, p_status text, p_eta integer default null, p_name text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_m public.meetups%rowtype;
  v_name text;
  v_title text;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('voy', 'llegue', 'no_puedo') then
    raise exception 'Respuesta no válida: elige «Voy llegando», «Ya llegué» o «No puedo»';
  end if;
  if p_status = 'voy' then
    if p_eta is not null and (p_eta < 1 or p_eta > 180) then
      raise exception 'El tiempo debe estar entre 1 y 180 minutos';
    end if;
  elsif p_eta is not null then
    raise exception 'El tiempo de llegada solo se indica con «Voy llegando»';
  end if;
  -- FOR SHARE: mientras se responde, nadie puede cerrar el punto a la vez (close_meetup pide el bloqueo exclusivo).
  select * into v_m from public.meetups m where m.id = p_meetup for share;
  if not found then
    raise exception 'Ese punto de encuentro no existe';
  end if;
  if v_m.status <> 'active' or v_m.expires_at <= now() then
    raise exception 'Este punto de encuentro ya ha terminado';
  end if;
  -- Sin nombre en la llamada se conserva el de su respuesta anterior (o «Viajero»).
  v_name := coalesce(
    nullif(btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''),
    (select r.name from public.meetup_replies r where r.meetup_id = p_meetup and r.user_id = v_uid),
    'Viajero'
  );
  insert into public.meetup_replies (meetup_id, user_id, name, status, eta_minutes)
  values (p_meetup, v_uid, v_name, p_status, p_eta)
  on conflict (meetup_id, user_id) do update
    set name = excluded.name, status = excluded.status, eta_minutes = excluded.eta_minutes;

  -- Aviso solo a quien lo fijó (si sigue existiendo y no es quien responde); con un dedupe corto por si cambia de idea al momento.
  if v_m.created_by is not null and v_m.created_by <> v_uid then
    v_title := case p_status
      when 'voy' then case when p_eta is null then '🚶 ' || v_name || ' va hacia el punto de encuentro' else '🚶 ' || v_name || ' llega en ' || p_eta || ' min' end
      when 'llegue' then '✅ ' || v_name || ' ya llegó'
      else '🙏 ' || v_name || ' no puede ir'
    end;
    perform public.meetup_notify(
      v_title, coalesce(v_m.place, v_m.title) || ' — Toca para ver quién falta', v_uid, false, array[v_m.created_by],
      'encuentro-resp-' || p_meetup::text || '-' || v_uid::text, 'encuentro-resp-' || p_meetup::text || '-' || v_uid::text, 20
    );
  end if;
end;
$$;
revoke all on function public.reply_meetup(uuid, text, integer, text) from public, anon;
grant execute on function public.reply_meetup(uuid, text, integer, text) to authenticated;

-- Cierra un punto. Solo quien lo fijó o un administrador. Avisa a todos menos a quien lo cierra (si todavía estaba vigente).
create or replace function public.close_meetup(p_meetup uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_m public.meetups%rowtype;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into v_m from public.meetups m where m.id = p_meetup for update;
  if not found then
    raise exception 'Ese punto de encuentro no existe';
  end if;
  if v_m.created_by is distinct from v_uid and not public.is_admin() then
    raise exception 'Solo quien fijó el punto de encuentro o un administrador puede cerrarlo' using errcode = '42501';
  end if;
  if v_m.status = 'closed' then
    raise exception 'Este punto de encuentro ya estaba cerrado';
  end if;
  update public.meetups set status = 'closed', closed_at = least(now(), expires_at) where id = p_meetup;
  if v_m.expires_at > now() then
    perform public.meetup_notify('✅ El punto de encuentro se cerró', coalesce(v_m.place, v_m.title), v_uid, false, null, 'encuentro-' || p_meetup::text, 'encuentro-cierre-' || p_meetup::text, 0);
  end if;
end;
$$;
revoke all on function public.close_meetup(uuid) from public, anon;
grant execute on function public.close_meetup(uuid) to authenticated;

-- ---------- tiempo real ----------

-- Los puntos y las respuestas llegan en directo (Realtime respeta las políticas de lectura: solo los viajeros).
alter publication supabase_realtime add table public.meetups, public.meetup_replies;
