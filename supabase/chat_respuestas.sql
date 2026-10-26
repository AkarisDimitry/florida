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
