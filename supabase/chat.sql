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
