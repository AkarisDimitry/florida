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
