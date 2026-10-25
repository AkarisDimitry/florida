-- Valoraciones con estrellas (1 a 5) de las fotos del viaje y de las fotos de la batalla. Ejecutar en Supabase → SQL Editor DESPUÉS de
-- schema.sql, fotos.sql y juego_batalla.sql (usa public.is_member(), public.photos y, para la batalla, public.battles y
-- public.battle_entries). Una sola vez; el todo en uno solo la aplica si falta public.photo_ratings. Si juego_batalla.sql no está, la
-- parte de la batalla se omite.
--
-- Qué hay:
--   · Fotos del viaje: cualquier viajero puntúa con 1 a 5 estrellas las fotos de los demás (no las suyas) y puede cambiar o quitar su
--     nota. Todos ven la nota media y cuántas valoraciones lleva cada foto.
--   · Batalla de fotos: durante la votación cada foto (menos la propia) se puntúa con estrellas, EN SECRETO igual que los votos, y al
--     cerrar la batalla se ve la nota media de cada foto. Si dos fotos empatan en votos, gana la de mejor nota media.
--
-- Contenido:
--   1. public.photo_ratings      una nota por persona y foto (se inserta, se cambia y se quita; RLS por persona).
--   2. public.battle_ratings     una nota por persona y foto de la batalla. Sin escritura directa: solo con rate_battle_entry().
--   3. public.rate_battle_entry  puntuar (o quitar la nota de) una foto de la batalla en votación.
--   4. public.battle_final       resultado de una batalla terminada con la nota media y el desempate por estrellas.
--
-- Seguridad: lo que no se puede falsear (quién puntúa, la hora, no puntuar lo propio, la nota de 1 a 5, puntuar solo con la batalla en
-- votación, la foto de la misma batalla) lo decide la base de datos. Las notas de la batalla de los demás no se pueden leer hasta que
-- termina (RLS). Tiempo real: photo_ratings va en supabase_realtime; battle_ratings no (sus eventos delatarían las notas).

-- ---------- 1. notas de las fotos del viaje ----------

create table public.photo_ratings (
  photo_id uuid not null references public.photos (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'Viajero' check (char_length(name) between 1 and 40),
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);

revoke all on public.photo_ratings from anon, authenticated;
grant select, delete on public.photo_ratings to authenticated;
-- La web puntúa con un upsert (PostgREST: INSERT … ON CONFLICT DO UPDATE SET photo_id, name, stars), que necesita UPDATE sobre esas tres.
grant insert (photo_id, name, stars) on public.photo_ratings to authenticated;
grant update (photo_id, name, stars) on public.photo_ratings to authenticated;
alter table public.photo_ratings enable row level security;

create policy photo_ratings_select on public.photo_ratings
  for select to authenticated using (public.is_member());
create policy photo_ratings_insert on public.photo_ratings
  for insert to authenticated with check (public.is_member() and user_id = auth.uid());
create policy photo_ratings_update on public.photo_ratings
  for update to authenticated using (public.is_member() and user_id = auth.uid()) with check (public.is_member() and user_id = auth.uid());
create policy photo_ratings_delete on public.photo_ratings
  for delete to authenticated using (public.is_member() and user_id = auth.uid());

-- Antes de guardar (al insertar y al cambiar): autor real, hora del servidor, nombre normalizado, nada de puntuar lo propio ni un ticket,
-- y la nota no puede cambiarse de foto ni de persona.
create or replace function public.photo_ratings_prepare()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  p public.photos;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    if auth.uid() is not null then
      new.user_id := auth.uid();
    end if;
  else
    new.user_id := old.user_id;
    new.created_at := old.created_at;
    if new.photo_id <> old.photo_id then
      raise exception 'Una nota no se puede pasar a otra foto' using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  new.name := coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
  select * into p from public.photos where id = new.photo_id;
  if found then
    if p.created_by is not null and p.created_by = new.user_id then
      raise exception 'No puedes valorar tu propia foto' using errcode = 'check_violation';
    end if;
    if p.expense_id is not null then
      raise exception 'La foto de un ticket no se valora' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.photo_ratings_prepare() from public, anon, authenticated;
create trigger photo_ratings_prepare
  before insert or update on public.photo_ratings
  for each row execute function public.photo_ratings_prepare();

alter publication supabase_realtime add table public.photo_ratings;

-- ---------- batalla de fotos (solo si está instalada) ----------

do $batalla$
begin
  if to_regclass('public.battle_entries') is null then
    raise notice 'valoraciones.sql: no está juego_batalla.sql, se omiten las notas de la batalla';
    return;
  end if;

  -- 2. notas de las fotos de la batalla
  create table public.battle_ratings (
    entry_id uuid not null,
    battle_id uuid not null,
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    stars smallint not null check (stars between 1 and 5),
    updated_at timestamptz not null default now(),
    primary key (entry_id, user_id),
    -- La foto puntuada tiene que ser de la misma batalla (y si se borra la foto o la batalla, se van sus notas).
    constraint battle_ratings_entry_fkey foreign key (entry_id, battle_id) references public.battle_entries (id, battle_id) on delete cascade
  );
  create index battle_ratings_battle_idx on public.battle_ratings (battle_id);

  revoke all on public.battle_ratings from anon, authenticated;
  grant select on public.battle_ratings to authenticated; -- nadie escribe directamente: lo hace rate_battle_entry
  alter table public.battle_ratings enable row level security;
  -- Cada uno ve SIEMPRE las suyas; las de los demás, solo cuando la batalla ha terminado (como los votos).
  create policy battle_ratings_select on public.battle_ratings
    for select to authenticated
    using (
      public.is_member()
      and (user_id = auth.uid() or exists (select 1 from public.battles b where b.id = battle_id and b.status = 'done'))
    );

  -- 3. puntuar una foto de la batalla. `p_stars` de 1 a 5; 0 o null quita la nota. Las mismas reglas que cast_vote: solo con la batalla
  -- en votación, solo quienes han enviado su foto y nunca la propia.
  create or replace function public.rate_battle_entry(p_entry uuid, p_stars int)
  returns void
  language plpgsql security definer set search_path = public
  as $f$
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
    -- FOR SHARE: mientras se puntúa, nadie puede cerrar la batalla a la vez (close_battle pide el bloqueo exclusivo).
    select b.status into v_status from public.battles b where b.id = v_battle for share;
    if v_status = 'open' then
      raise exception 'La votación todavía no ha empezado';
    elsif v_status = 'done' then
      raise exception 'La batalla ya ha terminado: no se puede puntuar';
    end if;
    if v_owner = v_uid then
      raise exception 'No puedes puntuar tu propia foto';
    end if;
    if not exists (select 1 from public.battle_entries e where e.battle_id = v_battle and e.user_id = v_uid) then
      raise exception 'Solo puntúan quienes han enviado su foto';
    end if;
    if p_stars is null or p_stars = 0 then
      delete from public.battle_ratings where entry_id = p_entry and user_id = v_uid;
      return;
    end if;
    if p_stars not between 1 and 5 then
      raise exception 'La nota va de 1 a 5 estrellas';
    end if;
    insert into public.battle_ratings (entry_id, battle_id, user_id, stars)
    values (p_entry, v_battle, v_uid, p_stars)
    on conflict (entry_id, user_id) do update set stars = excluded.stars, updated_at = now();
  end;
  $f$;
  revoke all on function public.rate_battle_entry(uuid, int) from public, anon;
  grant execute on function public.rate_battle_entry(uuid, int) to authenticated;

  -- 4. resultado de una batalla TERMINADA con la nota media: una fila por foto. Se ordena por votos y, si empatan, por nota media
  -- (las que empatan en las dos cosas comparten puesto). Antes de que termine falla, para que nadie vaya sacando notas.
  create or replace function public.battle_final(p_battle uuid)
  returns table (entry_id uuid, user_id uuid, name text, path text, thumb_path text, votes bigint, avg_stars numeric, ratings bigint, rank bigint)
  language plpgsql stable security definer set search_path = public
  as $f$
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
      with s as (
        select e.id as eid, e.user_id as uid, e.name as nm, e.path as pth, e.thumb_path as thp, e.created_at as at,
               (select count(*) from public.battle_votes v where v.entry_id = e.id)::bigint as vt,
               (select round(avg(r.stars), 2) from public.battle_ratings r where r.entry_id = e.id) as av,
               (select count(*) from public.battle_ratings r where r.entry_id = e.id)::bigint as rt
        from public.battle_entries e
        where e.battle_id = p_battle
      )
      select s.eid, s.uid, s.nm, s.pth, s.thp, s.vt, s.av, s.rt, rank() over (order by s.vt desc, coalesce(s.av, 0) desc)
      from s
      order by 9, s.at, s.eid;
  end;
  $f$;
  revoke all on function public.battle_final(uuid) from public, anon;
  grant execute on function public.battle_final(uuid) to authenticated;
end
$batalla$;
