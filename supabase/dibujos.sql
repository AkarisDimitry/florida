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
