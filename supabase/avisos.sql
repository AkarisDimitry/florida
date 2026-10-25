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
