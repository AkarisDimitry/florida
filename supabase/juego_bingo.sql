-- Juego «Bingo del viaje»: un cartón de 25 retos igual para todos; cada viajero marca un reto con una foto de prueba.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql (usa public.members e is_member()) y acceso.sql (usa is_admin()).
-- No depende de ningún otro SQL de juegos. Una sola vez (el todo en uno solo lo aplica si falta public.bingo_marks).
-- Las fotos de prueba van al bucket privado `photos` de fotos.sql, en la carpeta del usuario; sus políticas de Storage
-- (solo la propia carpeta, solo JPEG, máx. 5 MB) ya permiten esas rutas y no se tocan aquí.
--
-- Contenido:
--   1. public.bingo_cells      el cartón: 25 retos (idx 0..24), con los iniciales ya sembrados. Solo lectura para la web.
--   2. public.bingo_marks      una marca por persona y reto, con la foto de prueba. Se insertan y se borran; nunca se editan.
--   3. public.set_bingo_cell / set_bingo_cells   cambiar el texto de los retos (solo administradores).
--   4. public.bingo_progress() el resultado de cada jugador, calculado aquí (marcas, líneas, hora de la primera línea).
--
-- Casillas: se numeran por filas, idx = fila * 5 + columna (fila y columna de 0 a 4):
--      0  1  2  3  4
--      5  6  7  8  9
--     10 11 12 13 14
--     15 16 17 18 19
--     20 21 22 23 24
--
-- Definición de «línea»: cinco casillas en raya en las que el MISMO jugador tiene marca. Hay 12 posibles:
--   5 filas       (0-1-2-3-4, 5-6-7-8-9, 10-…-14, 15-…-19, 20-…-24),
--   5 columnas    (0-5-10-15-20, 1-6-11-16-21, 2-7-12-17-22, 3-8-13-18-23, 4-9-14-19-24) y
--   2 diagonales  (0-6-12-18-24 y 4-8-12-16-20).
-- Una casilla puede estar en varias líneas (la central, en cuatro): cada línea completa suma 1 a `lines`.
--   · first_line_at = cuándo completó su PRIMERA línea: de sus líneas completas, la que se cerró antes, y una línea se
--     cierra con su marca más reciente. Quien tiene la first_line_at más temprana es quien canta «¡Bingo!». Se calcula
--     con las marcas actuales: si alguien quita una marca y la rehace, esa línea vuelve a cerrarse (más tarde).
--   · full_at = «cartón lleno» (25 marcas): la hora de su marca más reciente; null mientras no esté lleno.
--
-- Seguridad: todo con RLS y permisos mínimos por columna; lo que no puede falsearse lo pone la base de datos.
--   · Cada uno inserta solo su marca (user_id = auth.uid()) y borra solo las suyas; nadie actualiza.
--   · La hora (created_at) la pone el servidor y el nombre se normaliza en un disparador (ver más abajo): nadie puede
--     fingir que marcó antes ni escribir con el nombre de otro jugador.
--   · Las rutas de las fotos están atadas al propio usuario y reto por una restricción: <user_id>/bingo-<cell>-<id>.jpg
--     (y …_t.jpg), así nadie puede presentar como prueba una foto subida por otra persona.
--   · Los retos solo los cambia un administrador, con funciones `security definer` que lo comprueban.
--   · Las funciones solo se pueden ejecutar con sesión iniciada (`authenticated`), nunca como anónimo.
--
-- Realtime: bingo_marks va en la publicación supabase_realtime (las marcas son pocas y poco frecuentes).

-- ---------- el cartón: 25 retos ----------

create table public.bingo_cells (
  idx smallint primary key,
  text text not null,
  constraint bingo_cells_idx_check check (idx between 0 and 24),
  constraint bingo_cells_text_check check (char_length(text) between 1 and 120 and text = btrim(text))
);

-- Los retos iniciales (el primer carácter es un emoji que la web enseña grande en la casilla). Un administrador puede
-- cambiarlos con set_bingo_cell / set_bingo_cells; el banco de ideas de reserva está en code/js/juegos/bingo.js.
insert into public.bingo_cells (idx, text) values
  (0,  '🌅 Ver un atardecer en la playa'),
  (1,  '🍽️ Probar algo que nunca has comido'),
  (2,  '🦩 Foto con un flamenco'),
  (3,  '🧭 Pedir indicaciones a un desconocido'),
  (4,  '😫 Un selfie con tu cara de cansado'),
  (5,  '🐊 Ver un animal salvaje o su estatua'),
  (6,  '🍦 Tomar un helado a deshoras'),
  (7,  '🚗 Cantar a gritos en el coche'),
  (8,  '🧢 Comprar un recuerdo absurdo'),
  (9,  '🌴 Foto bajo una palmera'),
  (10, '🛒 Pasear por un supermercado de aquí'),
  (11, '🪧 Foto con un cartel que no entiendes'),
  (12, '👨‍👩‍👧 Foto de grupo con todos'),
  (13, '🍕 Foto de tu plato más grande'),
  (14, '🌊 Meter los pies en el agua'),
  (15, '🚦 Foto de una señal de tráfico curiosa'),
  (16, '🏖️ Hacer algo con arena'),
  (17, '💃 Bailar donde no toca'),
  (18, '💤 Foto de alguien dormido en el coche'),
  (19, '🐚 Encontrar una concha bonita'),
  (20, '🌃 Foto de noche con luces de ciudad'),
  (21, '🥤 Brindar con una bebida local'),
  (22, '🧳 Tu maleta en un sitio inesperado'),
  (23, '🤳 Selfie con alguien que no conocías'),
  (24, '🏆 Un momento que no olvidarás');

-- ---------- las marcas ----------

create table public.bingo_marks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,                                        -- nombre del jugador (lo normaliza el disparador)
  cell smallint not null references public.bingo_cells (idx),
  path text not null,                                        -- foto de prueba, versión grande
  thumb_path text not null,                                  -- y su miniatura
  created_at timestamptz not null default now(),             -- la fija el disparador: el cliente no la escribe
  constraint bingo_marks_user_cell_key unique (user_id, cell),  -- una marca por persona y reto
  constraint bingo_marks_name_check check (char_length(name) between 1 and 40),
  constraint bingo_marks_paths_check check (
    path = user_id::text || '/bingo-' || cell::text || '-' || id::text || '.jpg'
    and thumb_path = user_id::text || '/bingo-' || cell::text || '-' || id::text || '_t.jpg'
  )
);

-- Antes de guardar una marca:
--   · created_at = hora del servidor (aunque el cliente mande otra).
--   · name: espacios y saltos de línea repetidos pasan a uno, sin espacios en los extremos; vacío = «Viajero».
--   · Un nombre que ya usa OTRA persona en el bingo (sin distinguir mayúsculas) se rechaza: así nadie puede marcar
--     haciéndose pasar por otro. (No es infalible —«Aná» no es «Ana»—, pero evita el suplantamiento evidente.)
-- Se ejecuta con los permisos de quien inserta: la política de lectura de abajo ya enseña todas las marcas a los
-- viajeros, y a quien no lo es no le dice nada (la política de INSERT lo rechaza después de todas formas).
create or replace function public.bingo_marks_prepare()
returns trigger
language plpgsql set search_path = public
as $$
begin
  new.created_at := now();
  new.name := coalesce(nullif(btrim(regexp_replace(coalesce(new.name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), ''), 'Viajero');
  if exists (select 1 from public.bingo_marks o where o.user_id <> new.user_id and lower(o.name) = lower(new.name)) then
    raise exception 'Ese nombre ya lo usa otra persona en el bingo. Cambia tu nombre en tu perfil para poder jugar.' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function public.bingo_marks_prepare() from public, anon, authenticated;

create trigger bingo_marks_prepare
  before insert on public.bingo_marks
  for each row execute function public.bingo_marks_prepare();

-- ---------- permisos y RLS ----------

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y se dan solo los necesarios.
-- bingo_cells: solo lectura (los retos los cambian las funciones de abajo). bingo_marks: leer, borrar las propias e
-- insertar con estas columnas; `created_at` no está en la lista (la pone el disparador) y UPDATE no se concede.
revoke all on public.bingo_cells, public.bingo_marks from anon, authenticated;
grant select on public.bingo_cells to authenticated;
grant select, delete on public.bingo_marks to authenticated;
grant insert (id, user_id, name, cell, path, thumb_path) on public.bingo_marks to authenticated;
alter table public.bingo_cells enable row level security;
alter table public.bingo_marks enable row level security;

-- Los viajeros ven el cartón y las marcas de todos (es parte de la gracia).
create policy bingo_cells_select on public.bingo_cells
  for select to authenticated using (public.is_member());
create policy bingo_marks_select on public.bingo_marks
  for select to authenticated using (public.is_member());
-- Cada uno marca solo como él mismo y borra solo sus marcas (quitar la marca y volver a hacerla). No hay UPDATE.
create policy bingo_marks_insert on public.bingo_marks
  for insert to authenticated with check (public.is_member() and user_id = auth.uid());
create policy bingo_marks_delete on public.bingo_marks
  for delete to authenticated using (public.is_member() and user_id = auth.uid());

-- ---------- cambiar los retos (solo administradores) ----------

-- Normaliza el texto de un reto: espacios y saltos de línea repetidos pasan a uno y sin espacios en los extremos.
create or replace function public.bingo_clean_text(p_text text)
returns text
language sql immutable set search_path = public
as $$
  select btrim(regexp_replace(coalesce(p_text, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
$$;
revoke all on function public.bingo_clean_text(text) from public, anon, authenticated;

-- Cambia el texto de UN reto. Las marcas que ya tuviera se conservan (siguen con su foto bajo el texto nuevo).
create or replace function public.set_bingo_cell(p_idx smallint, p_text text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_text text := public.bingo_clean_text(p_text);
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_idx is null or p_idx not between 0 and 24 then
    raise exception 'La casilla tiene que ser un número de 0 a 24' using errcode = '22023';
  end if;
  if char_length(v_text) not between 1 and 120 then
    raise exception 'El reto debe tener entre 1 y 120 caracteres' using errcode = '22023';
  end if;
  update public.bingo_cells set text = v_text where idx = p_idx;
end;
$$;
revoke all on function public.set_bingo_cell(smallint, text) from public, anon;
grant execute on function public.set_bingo_cell(smallint, text) to authenticated;

-- Cambia los 25 retos de una vez (p_texts[1] es la casilla 0, y así hasta la 24). Todo o nada.
create or replace function public.set_bingo_cells(p_texts text[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_texts text[];
  i int;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_texts is null or array_ndims(p_texts) is distinct from 1 or cardinality(p_texts) <> 25 then
    raise exception 'Hacen falta exactamente 25 retos' using errcode = '22023';
  end if;
  for i in 1..25 loop
    v_texts[i] := public.bingo_clean_text(p_texts[i]);
    if char_length(v_texts[i]) not between 1 and 120 then
      raise exception 'El reto % debe tener entre 1 y 120 caracteres', i using errcode = '22023';
    end if;
  end loop;
  update public.bingo_cells c set text = v_texts[c.idx + 1];
end;
$$;
revoke all on function public.set_bingo_cells(text[]) from public, anon;
grant execute on function public.set_bingo_cells(text[]) to authenticated;

-- ---------- resultados ----------

-- Una fila por jugador con al menos una marca (nadie más aparece: la web no puede leer los nombres de `members`).
-- Orden: más líneas, más marcas, primera línea más temprana, y por último el nombre (así el orden es siempre el mismo).
-- Se ejecuta con los permisos de quien llama: lo que ve sale de la política de lectura de bingo_marks (un viajero
-- ve a todos; quien no es viajero, a nadie).
create or replace function public.bingo_progress()
returns table (user_id uuid, name text, marks integer, lines integer, first_line_at timestamptz, full_at timestamptz)
language sql stable set search_path = public
as $$
  with line_cells (cells) as (values
    (array[0, 1, 2, 3, 4]), (array[5, 6, 7, 8, 9]), (array[10, 11, 12, 13, 14]), (array[15, 16, 17, 18, 19]), (array[20, 21, 22, 23, 24]),  -- filas
    (array[0, 5, 10, 15, 20]), (array[1, 6, 11, 16, 21]), (array[2, 7, 12, 17, 22]), (array[3, 8, 13, 18, 23]), (array[4, 9, 14, 19, 24]),  -- columnas
    (array[0, 6, 12, 18, 24]), (array[4, 8, 12, 16, 20])                                                                                    -- diagonales
  ),
  done as (  -- líneas completas de cada jugador y cuándo se cerró cada una (su marca más reciente)
    select m.user_id, max(m.created_at) as closed_at
    from line_cells l
    join public.bingo_marks m on m.cell = any (l.cells)
    group by m.user_id, l.cells
    having count(*) = 5
  ),
  per_line as (
    select d.user_id, count(*)::integer as lines, min(d.closed_at) as first_line_at from done d group by d.user_id
  ),
  per_user as (
    select m.user_id,
           (array_agg(m.name order by m.created_at desc, m.id))[1] as name,  -- el nombre de su marca más reciente
           count(*)::integer as marks,
           max(m.created_at) as last_at
    from public.bingo_marks m
    group by m.user_id
  )
  select u.user_id, u.name, u.marks, coalesce(p.lines, 0), p.first_line_at, case when u.marks = 25 then u.last_at end
  from per_user u
  left join per_line p on p.user_id = u.user_id
  order by coalesce(p.lines, 0) desc, u.marks desc, p.first_line_at asc nulls last, u.name, u.user_id;
$$;
revoke all on function public.bingo_progress() from public, anon;
grant execute on function public.bingo_progress() to authenticated;

-- ---------- tiempo real ----------

alter publication supabase_realtime add table public.bingo_marks;
