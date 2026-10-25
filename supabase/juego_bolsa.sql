-- Juego «Bolsa de valores»: mercado ficticio con temática de viaje. Ejecutar en Supabase → SQL Editor DESPUÉS de
-- schema.sql y acceso.sql (usa public.is_member() y public.is_admin()). Una sola vez. No depende de ningún otro archivo.
--
-- Cada viajero entra con 200.000 $ de mentira y compra y vende 10 activos inventados. Todos ven las cuentas, las
-- carteras y cada operación de todos (la transparencia es parte del juego).
--
-- QUIÉN MANDA: la base de datos. Ni el navegador ni ninguna API externa ponen los precios, ni escriben cuentas u
-- operaciones. Los clientes solo pueden LEER (con RLS: solo los viajeros) y todo lo que escribe va por funciones
-- `security definer` que toman al usuario de auth.uid() (nunca de un parámetro) y comprueban saldo y posición.
--
-- Contenido:
--   1. public.invest_assets      los 10 activos y los parámetros de su curva de precios (solo lectura).
--   2. Precios                   invest_price (interna), market_price, market_prices, market_history, market_sparks.
--   3. public.invest_accounts    una cuenta por viajero (efectivo). NINGUNA escritura directa.
--   4. public.invest_trades      cada compra y venta de todos. NINGUNA escritura directa.
--   5. Funciones de escritura    join_market, place_trade, reset_market (solo administradores).
--   6. Funciones de lectura      invest_leaderboard, invest_positions, invest_best_worst (todo calculado aquí).
--   7. Tiempo real               invest_trades en supabase_realtime.
--
-- CÓMO SE CALCULA EL PRECIO (sin servidor de bolsa): es una función DETERMINISTA de la hora, así que todos ven el
-- mismo precio y el navegador no puede falsearlo:
--     precio(t) = base · exp( vol · Σ a_i · sin(2π·t / T_i + φ_i) )          i = 1..4, redondeado a 2 decimales
--   · t = minutos enteros desde 2026-01-01 00:00 UTC (se trunca al minuto: durante un minuto el precio es el mismo
--     para todos y la operación se ejecuta al precio que se estaba viendo, salvo que cambie el minuto).
--   · Cuatro ondas por activo: un temblor de ~20-40 min, otra de unas horas, una de ~1 día y una de 11-19 días
--     (la que mueve la semana). Con los periodos distintos y las fases al azar, cada activo se mueve a su aire.
--   · `vol` es la volatilidad del activo (0,03 = tranquilo, 0,12 = muy movido) y `exp(...)` garantiza precio > 0.
--   · Medido sobre 60 días con las 10 curvas (ventanas de máximo/mínimo): en 10 min el rango típico va de ~0,2 % (los
--     tranquilos) a ~0,35 % (los movidos); en 24 h de ~3 % a ~6,5 % (hasta ~9 % en los peores días); y el cambio
--     en una semana llega a unos ±7 % en los tranquilos y ±25 % en los más volátiles.
--   LÍMITE CONOCIDO: una función determinista se puede calcular de antemano. Este repositorio es público, así que
--   quien lea este archivo puede calcular precios futuros y hacer trampa en un juego entre amigos. Si importara, la
--   solución es meter en la fórmula una semilla secreta (una fila de una tabla sin permisos para los clientes).
--
-- OPERACIONES: la posición de un activo es Σ compras − Σ ventas del usuario. place_trade bloquea la fila de la cuenta
-- (`for update`) mientras opera, así que dos toques seguidos (o dos dispositivos) se ejecutan uno detrás de otro y no
-- se puede gastar dos veces el mismo dinero ni vender dos veces la misma posición. Cantidad: > 0, máx. 6 decimales
-- y 1.000.000 de unidades por operación. Mínimo de operación: 1 $ (salvo vender lo que queda de una posición).
--
-- COSTE MEDIO (invest_positions.avg_cost): media ponderada móvil. Cada compra recalcula la media con lo que ya había;
-- una venta no la cambia (solo quita unidades); si se vende todo, se reinicia. La ganancia de una posición (pnl) es
-- su valor actual menos cantidad × coste medio.
--
-- MEJOR Y PEOR OPERACIÓN (invest_best_worst): ganancia de cada operación frente al precio de hoy: una compra gana
-- (precio hoy − precio pagado) × cantidad; una venta gana (precio vendido − precio hoy) × cantidad (lo que ganó o
-- perdió por vender en vez de esperar).

-- ---------- 1. activos ----------

create table public.invest_assets (
  symbol text primary key check (symbol ~ '^[A-Z]{3,5}$'),
  name text not null check (char_length(name) between 1 and 40),
  emoji text not null check (char_length(emoji) between 1 and 8),
  base numeric not null check (base > 0),
  vol numeric not null check (vol > 0 and vol <= 1),
  -- Ondas de la curva (ver arriba): periodo en minutos, amplitud relativa y fase en radianes; mismo número de cada una.
  periods numeric[] not null check (cardinality(periods) between 1 and 8 and 0 < all (periods)),
  amps numeric[] not null constraint invest_assets_amps_check check (cardinality(amps) = cardinality(periods)),
  phases numeric[] not null constraint invest_assets_phases_check check (cardinality(phases) = cardinality(periods)),
  sort smallint not null default 0
);

insert into public.invest_assets (symbol, name, emoji, base, vol, periods, amps, phases, sort) values
  ('HELA', 'Helados de Miami',        '🍦',  24.80, 0.038, '{19,131,1330,19800}',  '{0.055,0.150,0.220,1}', '{0.6,2.1,4.0,1.3}', 1),
  ('FLAM', 'Flamingo Coin',           '🦩',  41.20, 0.105, '{23,157,1510,17600}',  '{0.024,0.078,0.110,1}', '{3.1,0.4,5.2,0.2}', 2),
  ('CANG', 'Cangrejo Futures',        '🦀',  87.50, 0.085, '{29,203,1260,22400}',  '{0.030,0.095,0.140,1}', '{1.7,3.3,0.9,2.8}', 3),
  ('SOLF', 'Sol de Florida',          '☀️', 156.00, 0.032, '{17,241,1620,24900}',  '{0.060,0.160,0.230,1}', '{5.0,1.1,2.4,4.4}', 4),
  ('AIRB', 'Airboat Motors',          '🚤', 238.00, 0.062, '{31,173,1440,27300}',  '{0.036,0.110,0.170,1}', '{2.2,5.6,3.7,0.7}', 5),
  ('GATR', 'Gator Capital',           '🐊',  64.30, 0.115, '{21,119,1700,15800}',  '{0.022,0.068,0.100,1}', '{4.2,2.7,1.5,3.9}', 6),
  ('CAFE', 'Cafecito Cubano S.A.',    '☕',  18.90, 0.060, '{37,187,1180,21200}',  '{0.040,0.120,0.190,1}', '{0.3,4.8,2.9,5.5}', 7),
  ('COHE', 'Cohetes del Cabo',        '🚀', 320.00, 0.120, '{27,139,1380,20100}',  '{0.020,0.072,0.100,1}', '{1.1,3.9,4.6,2.0}', 8),
  ('RUTA', 'Gasolina Ruta 1',         '⛽',  31.50, 0.040, '{41,223,1550,25800}',  '{0.060,0.160,0.210,1}', '{2.6,0.9,5.9,3.4}', 9),
  ('MALE', 'Maletas Express',         '🧳',  74.80, 0.072, '{25,167,1290,18900}',  '{0.032,0.100,0.160,1}', '{3.8,1.9,0.6,1.1}', 10);

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan y solo se da lectura.
revoke all on public.invest_assets from anon, authenticated;
grant select on public.invest_assets to authenticated;
alter table public.invest_assets enable row level security;
create policy invest_assets_select on public.invest_assets
  for select to authenticated using (public.is_member());

-- ---------- ayudas internas (los clientes no las ejecutan; las usan las funciones de abajo) ----------

-- La curva de precios: pura y determinista (misma hora ⇒ mismo precio). Ver la explicación de arriba.
create or replace function public.invest_price(p_base numeric, p_vol numeric, p_periods numeric[], p_amps numeric[], p_phases numeric[], p_at timestamptz)
returns numeric
language sql immutable set search_path = public, pg_temp
as $$
  select greatest(0.01, round((
    p_base::float8 * exp(p_vol::float8 * coalesce((
      select sum(p_amps[i]::float8 * sin(2 * pi() * floor((extract(epoch from p_at) - 1767225600) / 60)::float8 / p_periods[i]::float8 + p_phases[i]::float8))
      from generate_subscripts(p_periods, 1) as i
    ), 0))
  )::numeric, 2));
$$;
revoke all on function public.invest_price(numeric, numeric, numeric[], numeric[], numeric[], timestamptz) from public, anon, authenticated;

-- Dinero con formato español para los mensajes de error (10.000,50): no depende del idioma del servidor.
create or replace function public.invest_fmt(p_value numeric, p_decimals int default 2)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select replace(replace(replace(
    to_char(p_value, case when p_decimals = 0 then 'FM999,999,999,999,990' else 'FM999,999,999,999,990.' || repeat('0', p_decimals) end),
    ',', '#'), '.', ','), '#', '.');
$$;
revoke all on function public.invest_fmt(numeric, int) from public, anon, authenticated;

-- Nombre del jugador: espacios y saltos repetidos pasan a uno, sin espacios en los extremos y máx. 40 caracteres.
create or replace function public.invest_clean_name(p_name text)
returns text
language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(nullif(btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 40)), ''), 'Viajero');
$$;
revoke all on function public.invest_clean_name(text) from public, anon, authenticated;

-- ---------- 2. precios: lo que ve el cliente ----------

-- Precio de un activo a una hora (por defecto, ahora). Solo viajeros.
create or replace function public.market_price(p_symbol text, p_at timestamptz default now())
returns numeric
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  a public.invest_assets;
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  select * into a from public.invest_assets where symbol = upper(btrim(coalesce(p_symbol, '')));
  if not found then
    raise exception 'Ese activo no existe en la bolsa';
  end if;
  return public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, p_at);
end;
$$;
revoke all on function public.market_price(text, timestamptz) from public, anon;
grant execute on function public.market_price(text, timestamptz) to authenticated;

-- Todos los activos con su precio de ahora y el cambio respecto a hace 24 horas (en %).
create or replace function public.market_prices()
returns table (symbol text, name text, emoji text, price numeric, change_24h_pct numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select a.symbol, a.name, a.emoji, p.now_price,
           round((p.now_price / p.old_price - 1) * 100, 2)
    from public.invest_assets a
    cross join lateral (select public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, v_now) as now_price,
                               public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, v_now - interval '24 hours') as old_price) p
    order by a.sort, a.symbol;
end;
$$;
revoke all on function public.market_prices() from public, anon;
grant execute on function public.market_prices() to authenticated;

-- Serie de precios de un activo para dibujar el gráfico: p_points puntos repartidos entre hace p_hours horas y ahora
-- (límites: 1-720 horas y 2-500 puntos). Ordenada por hora.
create or replace function public.market_history(p_symbol text, p_hours int default 48, p_points int default 96)
returns table (t timestamptz, price numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  a public.invest_assets;
  v_last timestamptz := date_trunc('minute', clock_timestamp());
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 720 or p_points is null or p_points not between 2 and 500 then
    raise exception 'El historial admite de 1 a 720 horas y de 2 a 500 puntos';
  end if;
  select * into a from public.invest_assets where symbol = upper(btrim(coalesce(p_symbol, '')));
  if not found then
    raise exception 'Ese activo no existe en la bolsa';
  end if;
  return query
    select s.ts, public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, s.ts)
    from (select v_last - (p_hours * 3600.0 * (p_points - 1 - i) / (p_points - 1)) * interval '1 second' as ts
          from generate_series(0, p_points - 1) as i) s
    order by s.ts;
end;
$$;
revoke all on function public.market_history(text, int, int) from public, anon;
grant execute on function public.market_history(text, int, int) to authenticated;

-- Los mini gráficos de todos los activos de una sola vez (una consulta en vez de diez).
-- Límites: 1-168 horas y 2-60 puntos por activo.
create or replace function public.market_sparks(p_hours int default 24, p_points int default 24)
returns table (symbol text, t timestamptz, price numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_last timestamptz := date_trunc('minute', clock_timestamp());
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 168 or p_points is null or p_points not between 2 and 60 then
    raise exception 'Los mini gráficos admiten de 1 a 168 horas y de 2 a 60 puntos';
  end if;
  return query
    select a.symbol, s.ts, public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, s.ts)
    from public.invest_assets a
    cross join lateral (select v_last - (p_hours * 3600.0 * (p_points - 1 - i) / (p_points - 1)) * interval '1 second' as ts
                        from generate_series(0, p_points - 1) as i) s
    order by a.sort, a.symbol, s.ts;
end;
$$;
revoke all on function public.market_sparks(int, int) from public, anon;
grant execute on function public.market_sparks(int, int) to authenticated;

-- ---------- 3. cuentas ----------

create table public.invest_accounts (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- `<> 'NaN'`: en numeric, NaN se ordena por encima de todos los números y pasaría `cash >= 0`.
  cash numeric(14, 2) not null default 200000 check (cash >= 0 and cash <> 'NaN'),
  created_at timestamptz not null default now()
);

-- ---------- 4. operaciones ----------

create table public.invest_trades (
  id bigint generated always as identity primary key, -- el orden de las operaciones de cada jugador (coste medio)
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40), -- su nombre cuando operó
  symbol text not null references public.invest_assets (symbol),
  side text not null check (side in ('buy', 'sell')),
  qty numeric(18, 6) not null check (qty > 0 and qty <= 1000000),
  price numeric(14, 2) not null check (price > 0),
  total numeric(14, 2) not null check (total >= 0),
  created_at timestamptz not null default clock_timestamp()
);
create index invest_trades_user_idx on public.invest_trades (user_id, symbol, id);

revoke all on public.invest_accounts, public.invest_trades from anon, authenticated;
revoke all on sequence public.invest_trades_id_seq from anon, authenticated;
grant select on public.invest_accounts, public.invest_trades to authenticated; -- solo lectura: escriben las funciones
alter table public.invest_accounts enable row level security;
alter table public.invest_trades enable row level security;

-- Todos los viajeros ven las cuentas y operaciones de todos.
create policy invest_accounts_select on public.invest_accounts
  for select to authenticated using (public.is_member());
create policy invest_trades_select on public.invest_trades
  for select to authenticated using (public.is_member());

-- ---------- 5. escritura: solo por estas funciones ----------

-- Entrar a la bolsa: crea la cuenta de quien llama con 200.000 $ si no la tenía (si ya la tenía, no cambia nada) y la
-- devuelve. El nombre se normaliza (≤ 40 caracteres); si llega vacío se usa «Viajero».
create or replace function public.join_market(p_name text default null)
returns public.invest_accounts
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_acc public.invest_accounts;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  insert into public.invest_accounts (user_id, name) values (v_uid, public.invest_clean_name(p_name))
    on conflict (user_id) do nothing;
  select * into v_acc from public.invest_accounts where user_id = v_uid;
  return v_acc;
end;
$$;
revoke all on function public.join_market(text) from public, anon;
grant execute on function public.join_market(text) to authenticated;

-- Comprar o vender. Siempre al precio oficial de ESTE momento (el servidor lo calcula; el cliente no lo envía) y
-- siempre como quien llama (auth.uid()). Devuelve la operación guardada. Los fallos explican en español qué pasó.
create or replace function public.place_trade(p_symbol text, p_side text, p_qty numeric)
returns public.invest_trades
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_side text := lower(btrim(coalesce(p_side, '')));
  v_acc public.invest_accounts;
  v_held numeric;
  v_now timestamptz;
  v_price numeric;
  v_total numeric;
  v_trade public.invest_trades;
begin
  if v_uid is null or not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_side not in ('buy', 'sell') then
    raise exception 'La operación debe ser una compra o una venta';
  end if;
  if p_qty is null or p_qty = 'NaN' or p_qty <= 0 then
    raise exception 'La cantidad debe ser mayor que 0';
  end if;
  if p_qty > 1000000 then
    raise exception 'La cantidad máxima por operación es de 1.000.000 de unidades';
  end if;
  if p_qty <> round(p_qty, 6) then
    raise exception 'La cantidad admite como máximo 6 decimales';
  end if;
  if not exists (select 1 from public.invest_assets where symbol = v_symbol) then
    raise exception 'Ese activo no existe en la bolsa';
  end if;

  -- Se bloquea la cuenta hasta el final de la operación: otra operación del mismo jugador espera aquí y, al
  -- continuar, ya ve el saldo y las posiciones actualizados.
  select * into v_acc from public.invest_accounts where user_id = v_uid for update;
  if not found then
    raise exception 'Primero entra a la bolsa para recibir tus 200.000 $';
  end if;

  v_now := clock_timestamp();
  v_price := public.market_price(v_symbol, v_now);
  v_total := round(p_qty * v_price, 2);

  select coalesce(sum(case side when 'buy' then qty else -qty end), 0) into v_held
    from public.invest_trades where user_id = v_uid and symbol = v_symbol;

  -- Mínimo de 1 $ por operación; vender lo último que queda de una posición se permite aunque valga menos.
  if v_total < 1 and not (v_side = 'sell' and p_qty = v_held) then
    raise exception 'La operación mínima es de 1 $ (esta sería de % $)', public.invest_fmt(v_total);
  end if;

  if v_side = 'buy' then
    if v_acc.cash < v_total then
      raise exception 'No tienes suficiente dinero: esta compra cuesta % $ y tienes % $', public.invest_fmt(v_total), public.invest_fmt(v_acc.cash);
    end if;
    update public.invest_accounts set cash = cash - v_total where user_id = v_uid;
  else
    if v_held < p_qty then
      raise exception 'No tienes suficientes unidades: quieres vender % y tienes %', trim_scale(p_qty), trim_scale(v_held);
    end if;
    update public.invest_accounts set cash = cash + v_total where user_id = v_uid;
  end if;

  insert into public.invest_trades (user_id, name, symbol, side, qty, price, total, created_at)
    values (v_uid, v_acc.name, v_symbol, v_side, p_qty, v_price, v_total, v_now)
    returning * into v_trade;
  return v_trade;
end;
$$;
revoke all on function public.place_trade(text, text, numeric) from public, anon;
grant execute on function public.place_trade(text, text, numeric) to authenticated;

-- Reiniciar la bolsa: solo administradores. Borra todas las operaciones y deja a todos con 200.000 $ (las cuentas
-- siguen). Devuelve cuántas cuentas se reiniciaron. (`where true`: las extensiones de seguridad de Supabase, como
-- pg_safeupdate, rechazan un UPDATE o DELETE sin WHERE.)
create or replace function public.reset_market()
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_accounts integer;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  delete from public.invest_trades where true;
  update public.invest_accounts set cash = 200000 where true;
  get diagnostics v_accounts = row_count;
  return v_accounts;
end;
$$;
revoke all on function public.reset_market() from public, anon;
grant execute on function public.reset_market() to authenticated;

-- ---------- 6. lectura: todo calculado aquí (una sola fuente de verdad) ----------

-- Posición de cada jugador en cada activo (solo lo que tiene ahora): cantidad y coste medio (media ponderada móvil;
-- ver arriba). Interna: la usan invest_positions e invest_leaderboard.
create or replace function public.invest_holdings()
returns table (user_id uuid, symbol text, qty numeric, avg_cost numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  r record;
  cur_user uuid;
  cur_symbol text;
  q numeric := 0;
  avg numeric := 0;
begin
  for r in select t.user_id as u, t.symbol as s, t.side as sd, t.qty as n, t.total as c
           from public.invest_trades t order by t.user_id, t.symbol, t.id loop
    if cur_user is distinct from r.u or cur_symbol is distinct from r.s then
      if cur_user is not null and q > 0 then
        user_id := cur_user; symbol := cur_symbol; qty := q; avg_cost := avg;
        return next;
      end if;
      cur_user := r.u; cur_symbol := r.s; q := 0; avg := 0;
    end if;
    if r.sd = 'buy' then
      avg := (q * avg + r.c) / (q + r.n);
      q := q + r.n;
    else
      q := q - r.n;
      if q <= 0 then q := 0; avg := 0; end if;
    end if;
  end loop;
  if cur_user is not null and q > 0 then
    user_id := cur_user; symbol := cur_symbol; qty := q; avg_cost := avg;
    return next;
  end if;
end;
$$;
revoke all on function public.invest_holdings() from public, anon, authenticated;

-- Todas las posiciones de todos: cantidad, coste medio, precio de ahora, valor y ganancia (valor − cantidad × coste medio).
create or replace function public.invest_positions()
returns table (user_id uuid, name text, symbol text, qty numeric, avg_cost numeric, price numeric, value numeric, pnl numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    select h.user_id, ac.name, h.symbol, h.qty, round(h.avg_cost, 4), px.p,
           round(h.qty * px.p, 2),
           round(h.qty * px.p, 2) - round(h.qty * h.avg_cost, 2)
    from public.invest_holdings() h
    join public.invest_accounts ac on ac.user_id = h.user_id
    join public.invest_assets a on a.symbol = h.symbol
    cross join lateral (select public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, v_now) as p) px
    order by ac.name, ac.user_id, a.sort, h.symbol;
end;
$$;
revoke all on function public.invest_positions() from public, anon;
grant execute on function public.invest_positions() to authenticated;

-- Clasificación: por jugador, efectivo + valor de sus posiciones = patrimonio (total), ganancia en % sobre los
-- 200.000 $ iniciales y número de operaciones. Ordenada por patrimonio (y por nombre si empatan).
create or replace function public.invest_leaderboard()
returns table (user_id uuid, name text, cash numeric, holdings_value numeric, total numeric, pnl_pct numeric, trades_count bigint)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    with pos as (select p.user_id, sum(p.value) as v from public.invest_positions() p group by p.user_id),
         cnt as (select t.user_id, count(*) as n from public.invest_trades t group by t.user_id)
    select a.user_id, a.name, a.cash, coalesce(pos.v, 0), a.cash + coalesce(pos.v, 0),
           round((a.cash + coalesce(pos.v, 0) - 200000) / 200000 * 100, 2),
           coalesce(cnt.n, 0)
    from public.invest_accounts a
    left join pos on pos.user_id = a.user_id
    left join cnt on cnt.user_id = a.user_id
    order by 5 desc, a.name, a.user_id;
end;
$$;
revoke all on function public.invest_leaderboard() from public, anon;
grant execute on function public.invest_leaderboard() to authenticated;

-- La mejor y la peor operación de todos (ver arriba cómo se mide). Dos filas ('best' y 'worst'), o ninguna si
-- nadie ha operado (con una sola operación, las dos son la misma).
create or replace function public.invest_best_worst()
returns table (kind text, id bigint, user_id uuid, name text, symbol text, side text, qty numeric, price numeric, total numeric, created_at timestamptz, price_now numeric, gain numeric, asset_name text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return query
    with g as (
      select t.id, t.user_id, t.name, t.symbol, t.side, t.qty, t.price, t.total, t.created_at, px.p as price_now,
             round(case t.side when 'buy' then px.p - t.price else t.price - px.p end * t.qty, 2) as gain, a.name as asset_name
      from public.invest_trades t
      join public.invest_assets a on a.symbol = t.symbol
      cross join lateral (select public.invest_price(a.base, a.vol, a.periods, a.amps, a.phases, v_now) as p) px
    )
    (select 'best'::text, g.* from g order by g.gain desc, g.id limit 1)
    union all
    (select 'worst'::text, g.* from g order by g.gain, g.id limit 1);
end;
$$;
revoke all on function public.invest_best_worst() from public, anon;
grant execute on function public.invest_best_worst() to authenticated;

-- ---------- 7. tiempo real ----------

-- Las operaciones nuevas llegan a todos sin recargar (Realtime respeta la política de lectura de arriba).
alter publication supabase_realtime add table public.invest_trades;
