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
