-- Juego «Batalla de fotos». Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql y acceso.sql (usa public.is_member()
-- e public.is_admin()). Una sola vez. No depende de fotos.sql en la base: solo usa el almacén privado `photos` que ese
-- archivo crea (las políticas de Storage de la carpeta de cada usuario ya permiten subir y borrar las fotos del juego).
--
-- Cómo se juega: un viajero lanza un reto de foto («La sonrisa más rara»), todos envían UNA foto hecha con el móvil, se vota
-- en secreto la mejor (no la propia) y al terminar se muestra el podio. Hay una clasificación con las batallas terminadas.
--
-- Estados:   open (se envían fotos) → voting (se vota) → done (resultado). Solo avanza, y solo lo hace quien lanzó el reto
--            o un administrador (public.is_admin()). Como mucho UNA batalla sin terminar a la vez (lo garantiza un índice único).
--
-- Contenido:
--   1. Tablas       battles, battle_entries, battle_votes.
--   2. Permisos     sin escritura directa en battles ni battle_votes; en battle_entries el autor solo inserta su foto con la
--                   batalla en `open` y solo la borra mientras sigue en `open`.
--   3. Funciones    start_battle, start_voting, close_battle, cast_vote (escriben, security definer) y battle_results,
--                   battle_leaderboard, battle_progress (leen lo que RLS no deja leer o lo agregan; security definer).
--   4. Tiempo real  battles y battle_entries en supabase_realtime (los votos NO: sus eventos no deben delatar a nadie).
--
-- Seguridad: lo que no debe poder falsearse (quién vota, que no se vote la propia foto, un voto por persona, los estados) lo
-- decide la base de datos. Los votos de los demás no se pueden leer hasta que la batalla termina (RLS). Ojo: el anonimato de
-- las fotos DURANTE la votación es solo de la pantalla (las fotos y su autor se pueden leer; son del grupo y solo las ven
-- viajeros autorizados); lo que la base protege es el secreto de los votos.

-- ---------- batallas ----------

create table public.battles (
  id uuid primary key default gen_random_uuid(),
  prompt text not null check (char_length(prompt) between 1 and 120 and prompt = btrim(prompt)),
  status text not null default 'open' check (status in ('open', 'voting', 'done')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now(),
  voting_at timestamptz,
  closed_at timestamptz,
  -- Las marcas de tiempo acompañan al estado: una batalla `open` no tiene ninguna, `voting` tiene la de inicio de votación y
  -- `done` las dos.
  constraint battles_times_check check (
    (status = 'open' and voting_at is null and closed_at is null)
    or (status = 'voting' and voting_at is not null and closed_at is null)
    or (status = 'done' and voting_at is not null and closed_at is not null)
  )
);

-- Como mucho una batalla sin terminar: el índice único parcial sobre una constante admite una sola fila con status <> 'done',
-- aunque dos personas lancen un reto en el mismo instante.
create unique index battles_one_active_idx on public.battles ((true)) where status <> 'done';
create index battles_created_at_idx on public.battles (created_at desc);

-- ---------- fotos de la batalla ----------

-- Una foto por persona y batalla. Los archivos son <user_id>/batalla-<battle_id>.jpg y <user_id>/batalla-<battle_id>_t.jpg en
-- el almacén privado `photos`; la restricción obliga a que las rutas sean EXACTAMENTE esas, así nadie puede enseñar como
-- suyo un archivo de otro ni de otra carpeta.
create table public.battle_entries (
  id uuid primary key default gen_random_uuid(),
  battle_id uuid not null references public.battles (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text check (char_length(name) <= 40),
  path text not null,
  thumb_path text not null,
  created_at timestamptz not null default now(),
  constraint battle_entries_one_per_user unique (battle_id, user_id),
  -- Hace falta para que un voto solo pueda apuntar a una foto de SU MISMA batalla (clave foránea compuesta de battle_votes).
  constraint battle_entries_id_battle_key unique (id, battle_id),
  constraint battle_entries_path_check check (path = user_id::text || '/batalla-' || battle_id::text || '.jpg'),
  constraint battle_entries_thumb_check check (thumb_path = user_id::text || '/batalla-' || battle_id::text || '_t.jpg')
);

-- ---------- votos ----------

-- Un voto por persona y batalla (clave primaria). El cambio de voto es un UPDATE de entry_id que hace cast_vote.
create table public.battle_votes (
  battle_id uuid not null references public.battles (id) on delete cascade,
  voter_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  entry_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (battle_id, voter_id),
  -- La foto votada tiene que ser de la misma batalla (y si se borra la foto, se borran sus votos).
  constraint battle_votes_entry_fkey foreign key (entry_id, battle_id) references public.battle_entries (id, battle_id) on delete cascade
);
create index battle_votes_entry_idx on public.battle_votes (entry_id);

-- ---------- permisos y RLS ----------

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
revoke all on public.battles, public.battle_entries, public.battle_votes from anon, authenticated;
grant select on public.battles to authenticated;                    -- nadie escribe directamente: lo hacen las funciones
grant select, delete on public.battle_entries to authenticated;      -- sin UPDATE: una foto no se edita (se borra y se envía otra)
grant insert (battle_id, name, path, thumb_path) on public.battle_entries to authenticated; -- user_id, id y hora los pone la base
grant select on public.battle_votes to authenticated;                -- nadie vota directamente: lo hace cast_vote

alter table public.battles enable row level security;
alter table public.battle_entries enable row level security;
alter table public.battle_votes enable row level security;

-- Los viajeros autorizados ven las batallas y las fotos.
create policy battles_select on public.battles
  for select to authenticated using (public.is_member());
create policy battle_entries_select on public.battle_entries
  for select to authenticated using (public.is_member());

-- Cada uno inserta SU foto (user_id sale de auth.uid()) y solo con la batalla en `open`.
create policy battle_entries_insert on public.battle_entries
  for insert to authenticated
  with check (
    public.is_member() and user_id = auth.uid()
    and exists (select 1 from public.battles b where b.id = battle_id and b.status = 'open')
  );

-- Cada uno borra solo la suya y solo mientras la batalla sigue en `open` (después, la foto ya está en juego).
create policy battle_entries_delete on public.battle_entries
  for delete to authenticated
  using (
    public.is_member() and user_id = auth.uid()
    and exists (select 1 from public.battles b where b.id = battle_id and b.status = 'open')
  );

-- Votos: cada uno ve SIEMPRE el suyo; los de los demás, solo cuando la batalla ha terminado.
create policy battle_votes_select on public.battle_votes
  for select to authenticated
  using (
    public.is_member()
    and (voter_id = auth.uid() or exists (select 1 from public.battles b where b.id = battle_id and b.status = 'done'))
  );

-- Al insertar una foto se bloquea la fila de la batalla (FOR SHARE) y se comprueba que sigue en `open`: así una foto no se
-- cuela justo cuando alguien pasa la batalla a votación (start_voting pide el bloqueo exclusivo y espera a que termine el
-- INSERT). Además da un mensaje claro en vez de «violates row-level security policy».
create or replace function public.battle_entries_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_status text;
begin
  select b.status into v_status from public.battles b where b.id = new.battle_id for share;
  if not found then
    raise exception 'Esa batalla no existe';
  elsif v_status = 'voting' then
    raise exception 'Ya no se pueden enviar fotos: la votación ha empezado';
  elsif v_status <> 'open' then
    raise exception 'Ya no se pueden enviar fotos: la batalla ha terminado';
  end if;
  return new;
end;
$$;
revoke all on function public.battle_entries_guard() from public, anon, authenticated;

create trigger battle_entries_guard
  before insert on public.battle_entries
  for each row execute function public.battle_entries_guard();

-- ---------- lanzar y avanzar la batalla ----------

-- Lanza un reto nuevo. `p_name` es el nombre que se muestra («Lanzado por Ana»); como en el resto de la web lo manda la
-- página (la identidad real es created_by = auth.uid()). Devuelve el id de la batalla. Falla si ya hay una sin terminar.
create or replace function public.start_battle(p_prompt text, p_name text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_prompt text := btrim(regexp_replace(coalesce(p_prompt, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
  v_name text := nullif(btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), '');
  v_id uuid;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_prompt = '' then
    raise exception 'Escribe el tema del reto';
  end if;
  if char_length(v_prompt) > 120 then
    raise exception 'El tema es demasiado largo: máximo 120 caracteres';
  end if;
  if exists (select 1 from public.battles where status <> 'done') then
    raise exception 'Ya hay un reto en marcha. Cuando termine podrás lanzar otro';
  end if;
  begin
    insert into public.battles (prompt, created_by_name) values (v_prompt, v_name) returning id into v_id;
  exception when unique_violation then
    -- Dos personas lanzaron un reto a la vez: ganó la otra.
    raise exception 'Ya hay un reto en marcha. Cuando termine podrás lanzar otro';
  end;
  return v_id;
end;
$$;
revoke all on function public.start_battle(text, text) from public, anon;
grant execute on function public.start_battle(text, text) to authenticated;

-- open → voting. Solo quien lanzó el reto o un administrador.
create or replace function public.start_voting(p_battle uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_battle public.battles%rowtype;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into v_battle from public.battles where id = p_battle for update;
  if not found then
    raise exception 'Esa batalla no existe';
  end if;
  if v_battle.created_by is distinct from auth.uid() and not public.is_admin() then
    raise exception 'Solo quien lanzó el reto o un administrador puede empezar la votación' using errcode = '42501';
  end if;
  if v_battle.status = 'voting' then
    raise exception 'La votación ya ha empezado';
  elsif v_battle.status <> 'open' then
    raise exception 'La batalla ya ha terminado';
  end if;
  update public.battles set status = 'voting', voting_at = now() where id = p_battle;
end;
$$;
revoke all on function public.start_voting(uuid) from public, anon;
grant execute on function public.start_voting(uuid) to authenticated;

-- voting → done. Solo quien lanzó el reto o un administrador (se puede cerrar aunque falte gente por votar).
create or replace function public.close_battle(p_battle uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_battle public.battles%rowtype;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into v_battle from public.battles where id = p_battle for update;
  if not found then
    raise exception 'Esa batalla no existe';
  end if;
  if v_battle.created_by is distinct from auth.uid() and not public.is_admin() then
    raise exception 'Solo quien lanzó el reto o un administrador puede cerrar la batalla' using errcode = '42501';
  end if;
  if v_battle.status = 'open' then
    raise exception 'La votación todavía no ha empezado';
  elsif v_battle.status = 'done' then
    raise exception 'La batalla ya ha terminado';
  end if;
  update public.battles set status = 'done', closed_at = now() where id = p_battle;
end;
$$;
revoke all on function public.close_battle(uuid) from public, anon;
grant execute on function public.close_battle(uuid) to authenticated;

-- ---------- votar ----------

-- Vota (o cambia el voto a) una foto. La batalla se deduce de la foto. Reglas: solo con la batalla en `voting`, solo quienes
-- han enviado su foto (así en el resultado todos los votantes tienen nombre), nunca la propia, y un voto por batalla (votar
-- otra foto sustituye al anterior).
create or replace function public.cast_vote(p_entry uuid)
returns void
language plpgsql security definer set search_path = public
as $$
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
  -- FOR SHARE: mientras se vota, nadie puede cerrar la batalla a la vez (close_battle pide el bloqueo exclusivo).
  select b.status into v_status from public.battles b where b.id = v_battle for share;
  if v_status = 'open' then
    raise exception 'La votación todavía no ha empezado';
  elsif v_status = 'done' then
    raise exception 'La batalla ya ha terminado: no se puede votar';
  end if;
  if v_owner = v_uid then
    raise exception 'No puedes votar tu propia foto';
  end if;
  if not exists (select 1 from public.battle_entries e where e.battle_id = v_battle and e.user_id = v_uid) then
    raise exception 'Solo votan quienes han enviado su foto';
  end if;
  insert into public.battle_votes (battle_id, voter_id, entry_id)
  values (v_battle, v_uid, p_entry)
  on conflict (battle_id, voter_id) do update set entry_id = excluded.entry_id, created_at = now();
end;
$$;
revoke all on function public.cast_vote(uuid) from public, anon;
grant execute on function public.cast_vote(uuid) to authenticated;

-- ---------- resultados ----------

-- Resultado de una batalla TERMINADA: una fila por foto con sus votos y su puesto (los empates comparten puesto: 1, 1, 3…).
-- Antes de que termine falla, para que nadie pueda ir contando votos.
create or replace function public.battle_results(p_battle uuid)
returns table (entry_id uuid, user_id uuid, name text, path text, thumb_path text, votes bigint, rank bigint)
language plpgsql stable security definer set search_path = public
as $$
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
    select e.id, e.user_id, e.name, e.path, e.thumb_path, count(v.voter_id)::bigint, rank() over (order by count(v.voter_id) desc)
    from public.battle_entries e
    left join public.battle_votes v on v.entry_id = e.id
    where e.battle_id = p_battle
    group by e.id
    order by 7, e.created_at, e.id;
end;
$$;
revoke all on function public.battle_results(uuid) from public, anon;
grant execute on function public.battle_results(uuid) to authenticated;

-- Clasificación del viaje, solo con batallas terminadas: por persona, victorias (primer puesto con al menos un voto; los
-- empates comparten la victoria), votos recibidos y batallas en las que ha participado. Ordenada por victorias, votos y
-- participaciones. El nombre es el de su última foto.
create or replace function public.battle_leaderboard()
returns table (user_id uuid, name text, wins bigint, votes bigint, battles bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    with tally as (
      select e.battle_id, e.user_id, e.name, e.created_at, count(v.voter_id) as n
      from public.battle_entries e
      join public.battles b on b.id = e.battle_id and b.status = 'done'
      left join public.battle_votes v on v.entry_id = e.id
      group by e.id
    ), ranked as (
      select t.*, rank() over (partition by t.battle_id order by t.n desc) as rk from tally t
    )
    select r.user_id,
           (array_agg(r.name order by r.created_at desc))[1],
           (count(*) filter (where r.rk = 1 and r.n > 0))::bigint,
           coalesce(sum(r.n), 0)::bigint,
           count(*)::bigint
    from ranked r
    group by r.user_id
    order by 3 desc, 4 desc, 5 desc, 2, 1;
end;
$$;
revoke all on function public.battle_leaderboard() from public, anon;
grant execute on function public.battle_leaderboard() to authenticated;

-- Cuántas fotos hay y cuántos votos se han emitido, SIN decir quién ha votado ni qué (los votos son secretos hasta el final).
-- Sirve para avisar a quien lanzó el reto de que ya han votado todos y puede cerrar.
create or replace function public.battle_progress(p_battle uuid)
returns table (participants bigint, voted bigint)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if not exists (select 1 from public.battles b where b.id = p_battle) then
    raise exception 'Esa batalla no existe';
  end if;
  return query
    select (select count(*) from public.battle_entries e where e.battle_id = p_battle),
           (select count(*) from public.battle_votes v where v.battle_id = p_battle);
end;
$$;
revoke all on function public.battle_progress(uuid) from public, anon;
grant execute on function public.battle_progress(uuid) to authenticated;

-- ---------- tiempo real ----------

-- Las batallas y sus fotos llegan en directo (Realtime respeta las políticas de lectura). Los votos no se publican a propósito.
alter publication supabase_realtime add table public.battles, public.battle_entries;
