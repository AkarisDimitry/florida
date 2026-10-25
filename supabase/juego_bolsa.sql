-- Juego «Bolsa de valores» con PRECIOS REALES y dinero ficticio. Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql
-- y acceso.sql (usa public.is_member() y public.is_admin()). Una sola vez. No depende de ningún otro archivo.
--
-- Cada viajero entra con 200.000 $ de mentira y compra y vende 12 activos REALES (acciones de Disney, Carnival, Royal
-- Caribbean, Marriott, Delta, Apple, Tesla, Nvidia, Amazon y Microsoft, y las criptomonedas Bitcoin y Ethereum) a su precio de
-- verdad y en directo. Todos ven las cuentas, las carteras y cada operación de todos (la transparencia es parte del juego).
--
-- QUIÉN MANDA: la base de datos. El navegador NUNCA envía un precio ni escribe cuentas u operaciones: los clientes solo pueden
-- LEER (con RLS: solo los viajeros) y todo lo que se escribe va por funciones `security definer` que toman al usuario de
-- auth.uid() y comprueban saldo, posición y precio.
--
-- DE DÓNDE SALEN LOS PRECIOS: de Yahoo Finance (https://query1.finance.yahoo.com/v8/finance/chart/<SÍMBOLO>), que no admite
-- peticiones desde el navegador (no tiene CORS), así que las hace la propia base de datos:
--   · pg_cron ejecuta CADA MINUTO public.market_tick();
--   · market_tick() (1) recoge las respuestas ya terminadas de net._http_response (pg_net) de las peticiones del minuto
--     anterior, las valida y guarda la cotización, y (2) lanza las nuevas con net.http_get (asíncrono).
--   · La última cotización buena queda en public.market_quotes (precio, cierre anterior, hora del último trade según Yahoo y
--     hora en que se recogió); cada cambio de precio se anota en public.market_history (se borra lo de más de 14 días).
--   · Se ignora todo lo raro (estado distinto de 200, JSON mal formado, precio no válido): se conserva el último precio bueno y
--     se anota el último error de cada símbolo (market_feed). Los administradores lo ven con market_status().
--   · Primera ronda: además se pide una vez el historial de 5 días por horas (range=5d&interval=1h) para que los gráficos no
--     empiecen vacíos.
--
-- ¿SE PUEDE OPERAR? («operable»): un activo se opera solo si su precio es FRESCO, y eso se deduce de los datos, sin calendario
-- (así vale con festivos):
--   · el recolector funciona: fetched_at (cuándo se recogió) de hace menos de 5 minutos; y
--   · el mercado está abierto: quoted_at (hora del último trade) a menos de 20 minutos de fetched_at. En fin de semana o fuera
--     de horario (EE. UU.: lunes a viernes, 9:30-16:00 hora de Nueva York) el último trade es viejo y las acciones quedan
--     «cerradas»; las criptomonedas no cierran.
--   place_trade NUNCA ejecuta a un precio no fresco y explica en español cuál es el caso (mercado cerrado o sin precios).
--   El ranking y las posiciones valoran siempre con la última cotización guardada (con el mercado cerrado vale el último cierre).
--
-- Si pg_net o pg_cron no están activados, la instalación NO falla: la bolsa queda instalada pero sin precios («Sin precios en
-- directo todavía»). Activa las extensiones en Dashboard → Database → Extensions (pg_net y pg_cron) y ejecuta:
--     select public.market_setup();
-- (también lo hace el botón «Actualizar ahora» que ven los administradores en la bolsa).
--
-- LÍMITE CONOCIDO: la dirección de Yahoo Finance no es una API oficial y gratuita con garantías: puede cambiar de formato, limitar
-- las peticiones (429) o bloquear las IP de Supabase. Si pasa, no se rompe nada: la bolsa deja de operar, avisa con «Sin
-- precios en directo todavía» y market_status() (administradores) enseña la última respuesta y el error de cada símbolo.
--
-- Contenido:
--   1. Migración desde la versión anterior (con activos inventados), si estaba instalada.
--   2. public.invest_assets, market_quotes, market_history, market_feed, market_requests y market_state.
--   3. Recolector: market_state_of, market_ingest, market_tick y market_setup (internas), market_status y market_refresh (admin).
--   4. public.invest_accounts e invest_trades (NINGUNA escritura directa).
--   5. Lectura para el cliente: market_prices, market_series, market_sparks, invest_leaderboard, invest_positions, invest_best_worst.
--   6. Escritura: join_market, place_trade y reset_market (solo administradores).
--   7. Tiempo real (invest_trades) y puesta en marcha (extensiones, trabajo de pg_cron y primera ronda).
--
-- OPERACIONES: la posición de un activo es Σ compras − Σ ventas del usuario. place_trade bloquea la fila de la cuenta (`for
-- update`) mientras opera: dos toques seguidos (o dos dispositivos) se ejecutan uno detrás de otro y no se puede gastar dos
-- veces el mismo dinero ni vender dos veces la misma posición. Cantidad: > 0, máx. 6 decimales y 1.000.000 de unidades por
-- operación. Precio: la cotización guardada redondeada a 2 decimales (se guarda con la operación, junto con su hora). Mínimo de
-- operación: 1 $ (salvo vender lo último que queda de una posición).
--
-- COSTE MEDIO (invest_positions.avg_cost): media ponderada móvil. Cada compra recalcula la media con lo que ya había; una venta
-- no la cambia (solo quita unidades); si se vende todo, se reinicia. La ganancia de una posición (pnl) es su valor actual menos
-- cantidad × coste medio.
--
-- MEJOR Y PEOR OPERACIÓN (invest_best_worst): ganancia de cada operación frente al precio de hoy: una compra gana (precio hoy −
-- precio pagado) × cantidad; una venta gana (precio vendido − precio hoy) × cantidad.

-- ---------- 1. migración desde la versión anterior (activos inventados) ----------

-- La versión anterior calculaba los precios con una fórmula y guardaba cuentas y operaciones de prueba. Se sustituye entera:
-- las cuentas se conservan (mismo nombre, otra vez con 200.000 $) y las operaciones se borran.
do $mig$
declare
  v_accounts int;
  v_trades int;
  r record;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invest_assets' and column_name = 'periods') then
    select count(*) into v_accounts from public.invest_accounts;
    select count(*) into v_trades from public.invest_trades;
    drop table if exists pg_temp.bolsa_cuentas_antiguas;
    create temp table bolsa_cuentas_antiguas as select user_id, name, created_at from public.invest_accounts;
    for r in select 'drop function public.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')' as f from pg_proc p
             where p.pronamespace = 'public'::regnamespace
               and (p.proname like 'invest\_%' or p.proname like 'market\_%' or p.proname in ('join_market', 'place_trade', 'reset_market')) loop
      execute r.f;
    end loop;
    drop table public.invest_trades, public.invest_accounts, public.invest_assets cascade;
    raise notice 'Bolsa: se sustituye la versión con activos inventados por la de precios reales. Se reinician % operaciones de prueba y % cuentas (las cuentas se conservan y vuelven a tener 200.000 $).', v_trades, v_accounts;
  end if;
end
$mig$;

-- ---------- 2. activos, cotizaciones e historial ----------

create table public.invest_assets (
  -- Es el símbolo de Yahoo Finance y se usa tal cual en la dirección de la petición: solo letras, cifras, punto y guion.
  symbol text primary key check (symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,11}$'),
  name text not null check (char_length(name) between 1 and 40),
  emoji text not null check (char_length(emoji) between 1 and 8),
  kind text not null check (kind in ('accion', 'cripto')),
  sort smallint not null default 0
);

insert into public.invest_assets (symbol, name, emoji, kind, sort) values
  ('DIS',     'Disney',            '🏰', 'accion',  1),
  ('CCL',     'Carnival (cruceros)', '🚢', 'accion',  2),
  ('RCL',     'Royal Caribbean',   '⚓', 'accion',  3),
  ('MAR',     'Marriott (hoteles)', '🏨', 'accion',  4),
  ('DAL',     'Delta Air Lines',   '✈️', 'accion',  5),
  ('AAPL',    'Apple',             '🍎', 'accion',  6),
  ('TSLA',    'Tesla',             '🚗', 'accion',  7),
  ('NVDA',    'Nvidia',            '🎮', 'accion',  8),
  ('AMZN',    'Amazon',            '📦', 'accion',  9),
  ('MSFT',    'Microsoft',         '🪟', 'accion', 10),
  ('BTC-USD', 'Bitcoin',           '🪙', 'cripto', 11),
  ('ETH-USD', 'Ethereum',          '💎', 'cripto', 12);

-- Última cotización buena de cada activo. La escribe SOLO market_ingest (el recolector).
create table public.market_quotes (
  symbol text primary key references public.invest_assets (symbol),
  price numeric(14, 2) not null check (price > 0),
  prev_close numeric(14, 2) check (prev_close > 0),   -- cierre anterior (para la variación del día)
  quoted_at timestamptz not null,                      -- hora del último trade según Yahoo
  fetched_at timestamptz not null                      -- cuándo respondió Yahoo (se recogió)
);

-- Un punto cada vez que el precio cambia (y las horas de la carga inicial); se borra lo de más de 14 días.
create table public.market_history (
  symbol text not null references public.invest_assets (symbol),
  t timestamptz not null,
  price numeric(14, 2) not null check (price > 0),
  primary key (symbol, t)
);
create index market_history_t_idx on public.market_history (t);

-- Diagnóstico por símbolo (lo lee market_status, solo administradores).
create table public.market_feed (
  symbol text primary key references public.invest_assets (symbol),
  last_request_at timestamptz,
  last_ok_at timestamptz,
  last_status int,
  last_error text,
  last_error_at timestamptz,
  ok_count int not null default 0,
  error_count int not null default 0,
  backfilled_at timestamptz,
  backfill_tried_at timestamptz,
  backfill_error text
);
insert into public.market_feed (symbol) select symbol from public.invest_assets;

-- Peticiones lanzadas y todavía sin recoger: qué id de pg_net corresponde a qué símbolo.
create table public.market_requests (
  request_id bigint primary key,
  symbol text not null references public.invest_assets (symbol),
  kind text not null check (kind in ('quote', 'backfill')),
  requested_at timestamptz not null default now()
);

-- Una sola fila: cuándo corrió el recolector por última vez.
create table public.market_state (
  id boolean primary key default true check (id),
  last_tick_at timestamptz,
  last_tick_note text,
  last_prune_at timestamptz
);
insert into public.market_state default values;

-- Supabase concede por defecto todos los permisos sobre las tablas nuevas: se quitan. Los clientes leen (con RLS: solo los
-- viajeros) activos, cotizaciones e historial; el recolector y su diagnóstico no son accesibles para ellos (sin políticas).
revoke all on public.invest_assets, public.market_quotes, public.market_history, public.market_feed, public.market_requests, public.market_state from anon, authenticated;
grant select on public.invest_assets, public.market_quotes, public.market_history to authenticated;
alter table public.invest_assets enable row level security;
alter table public.market_quotes enable row level security;
alter table public.market_history enable row level security;
alter table public.market_feed enable row level security;
alter table public.market_requests enable row level security;
alter table public.market_state enable row level security;
create policy invest_assets_select on public.invest_assets for select to authenticated using (public.is_member());
create policy market_quotes_select on public.market_quotes for select to authenticated using (public.is_member());
create policy market_history_select on public.market_history for select to authenticated using (public.is_member());

-- ---------- ayudas internas (los clientes no las ejecutan) ----------

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

-- ¿Cómo está un precio? 'none' (nunca llegó), 'stale' (el recolector no ha traído nada en 5 min: sin precios en directo),
-- 'closed' (llega, pero el último trade es de hace más de 20 min: mercado cerrado) o 'live' (operable).
create or replace function public.market_state_of(p_fetched timestamptz, p_quoted timestamptz, p_now timestamptz default clock_timestamp())
returns text
language sql stable set search_path = public, pg_temp
as $$
  select case
    when p_fetched is null or p_quoted is null then 'none'
    when p_fetched < p_now - interval '5 minutes' then 'stale'
    when p_quoted < p_fetched - interval '20 minutes' then 'closed'
    else 'live'
  end;
$$;
revoke all on function public.market_state_of(timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------- 3. recolector ----------

-- Valida UNA respuesta de Yahoo y guarda la cotización (o el error). Nunca falla: un error se anota y se conserva el último
-- precio bueno. p_kind 'quote' = precio actual (interval=1d&range=1d); 'backfill' = historial de 5 días por horas.
create or replace function public.market_ingest(p_symbol text, p_kind text, p_status int, p_content text, p_error text, p_timed_out boolean, p_created timestamptz)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_msg text;
  v_j jsonb;
  v_meta jsonb;
  v_price numeric;
  v_prev numeric;
  v_time numeric;
  v_quoted timestamptz;
  v_when timestamptz := coalesce(p_created, clock_timestamp());
  v_old public.market_quotes;
  v_rows int;
begin
  if coalesce(p_timed_out, false) then
    v_msg := 'Yahoo no respondió a tiempo';
  elsif p_error is not null then
    v_msg := 'Error de red: ' || left(p_error, 160);
  elsif p_status is null then
    v_msg := 'Respuesta sin código HTTP';
  elsif p_status = 404 then
    v_msg := 'Yahoo no conoce este símbolo (404)';
  elsif p_status = 429 then
    v_msg := 'Yahoo limita las peticiones (429)';
  elsif p_status <> 200 then
    v_msg := 'Yahoo respondió con el error HTTP ' || p_status;
  else
    begin
      v_j := p_content::jsonb;
    exception when others then
      v_msg := 'La respuesta de Yahoo no es un JSON válido';
    end;
  end if;

  if v_msg is null then
    v_meta := v_j #> '{chart,result,0,meta}';
    if jsonb_typeof(v_meta) is distinct from 'object' then
      v_msg := 'La respuesta de Yahoo no trae datos del activo';
    elsif upper(coalesce(v_meta ->> 'symbol', p_symbol)) <> upper(p_symbol) then
      v_msg := 'La respuesta es de otro símbolo (' || left(v_meta ->> 'symbol', 20) || ')';
    elsif coalesce(upper(v_meta ->> 'currency'), 'USD') <> 'USD' then
      v_msg := 'La moneda no es USD (' || left(v_meta ->> 'currency', 10) || ')';
    end if;
  end if;

  if v_msg is null and p_kind = 'backfill' then
    begin
      insert into public.market_history (symbol, t, price)
        select p_symbol, to_timestamp(ts.v::numeric) + interval '1 hour', round(c.v::numeric, 2)
        from jsonb_array_elements_text(v_j #> '{chart,result,0,timestamp}') with ordinality as ts(v, i)
        join jsonb_array_elements_text(v_j #> '{chart,result,0,indicators,quote,0,close}') with ordinality as c(v, i) on c.i = ts.i
        where c.v is not null and c.v::numeric >= 0.01 and c.v::numeric < 1000000000
          and to_timestamp(ts.v::numeric) + interval '1 hour' <= v_when
        on conflict (symbol, t) do nothing;
      get diagnostics v_rows = row_count;
      update public.market_feed set backfilled_at = v_when, backfill_error = null where symbol = p_symbol;
      return true;
    exception when others then
      v_msg := 'Historial inicial no válido: ' || left(sqlerrm, 120);
    end;
  end if;

  if v_msg is null and p_kind = 'quote' then
    begin
      if jsonb_typeof(v_meta -> 'regularMarketPrice') is distinct from 'number' then
        v_msg := 'La respuesta no trae precio';
      else
        v_price := (v_meta ->> 'regularMarketPrice')::numeric;
        if v_price < 0.005 or v_price >= 1000000000 then
          v_msg := 'Precio no válido (' || left(v_price::text, 24) || ')';
        end if;
      end if;
      if v_msg is null then
        if jsonb_typeof(v_meta -> 'chartPreviousClose') = 'number' and (v_meta ->> 'chartPreviousClose')::numeric >= 0.005 and (v_meta ->> 'chartPreviousClose')::numeric < 1000000000 then
          v_prev := (v_meta ->> 'chartPreviousClose')::numeric;
        end if;
        if jsonb_typeof(v_meta -> 'regularMarketTime') is distinct from 'number' then
          v_msg := 'La respuesta no trae la hora de la cotización';
        else
          v_time := (v_meta ->> 'regularMarketTime')::numeric;
          if v_time <= 0 or v_time > 4102444800 then
            v_msg := 'Hora de cotización no válida';
          else
            v_quoted := least(to_timestamp(v_time), v_when); -- una cotización no puede ser del futuro
          end if;
        end if;
      end if;
    exception when others then
      v_msg := 'Respuesta no válida: ' || left(sqlerrm, 120);
    end;
  end if;

  if v_msg is null and p_kind = 'quote' then
    select * into v_old from public.market_quotes where symbol = p_symbol;
    if not found then
      insert into public.market_quotes (symbol, price, prev_close, quoted_at, fetched_at)
        values (p_symbol, round(v_price, 2), round(v_prev, 2), v_quoted, v_when);
    elsif v_quoted >= v_old.quoted_at then
      update public.market_quotes
        set price = round(v_price, 2), prev_close = round(v_prev, 2), quoted_at = v_quoted, fetched_at = greatest(v_when, v_old.fetched_at)
        where symbol = p_symbol;
    else
      -- Yahoo devolvió algo más viejo que lo que ya hay: no se retrocede (el precio y su hora siguen siendo los buenos).
      update public.market_quotes set fetched_at = greatest(v_when, v_old.fetched_at) where symbol = p_symbol;
    end if;
    if v_old.symbol is null or v_quoted >= v_old.quoted_at then
      if v_old.symbol is null or v_old.price is distinct from round(v_price, 2) then
        insert into public.market_history (symbol, t, price) values (p_symbol, v_when, round(v_price, 2))
          on conflict (symbol, t) do update set price = excluded.price;
      end if;
    end if;
    update public.market_feed
      set last_ok_at = v_when, last_status = 200, ok_count = ok_count + 1
      where symbol = p_symbol;
    return true;
  end if;

  -- Algo falló: se anota y no se toca la última cotización buena.
  if p_kind = 'backfill' then
    update public.market_feed set backfill_error = v_msg where symbol = p_symbol;
  else
    update public.market_feed
      set last_status = p_status, last_error = v_msg, last_error_at = v_when, error_count = error_count + 1
      where symbol = p_symbol;
  end if;
  return false;
end;
$$;
revoke all on function public.market_ingest(text, text, int, text, text, boolean, timestamptz) from public, anon, authenticated;

-- Una ronda del recolector (la ejecuta pg_cron cada minuto): recoge lo que ha llegado y lanza las peticiones nuevas.
-- Nadie con sesión puede ejecutarla directamente (solo el dueño: pg_cron y las funciones de abajo).
create or replace function public.market_tick()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_ua constant text := 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
  v_url constant text := 'https://query1.finance.yahoo.com/v8/finance/chart/';
  v_headers jsonb;
  r record;
  v_id bigint;
  v_ok int := 0;
  v_err int := 0;
  v_lost int := 0;
  v_launched int := 0;
begin
  -- Si dos rondas coinciden (cron y el botón del administrador), la segunda se salta.
  if not pg_try_advisory_xact_lock(hashtext('market_tick')) then
    return jsonb_build_object('skipped', true);
  end if;
  if to_regclass('net._http_response') is null or to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is null then
    update public.market_state set last_tick_at = v_now, last_tick_note = 'Falta la extensión pg_net: actívala en Dashboard → Database → Extensions';
    return jsonb_build_object('error', 'Falta la extensión pg_net');
  end if;
  v_headers := jsonb_build_object('User-Agent', v_ua, 'Accept', 'application/json');

  -- 1) recoger las respuestas ya terminadas (de la más antigua a la más nueva, para no retroceder)
  for r in
    select q.request_id, q.symbol, q.kind, q.requested_at,
           h.id is not null as answered, h.status_code, h.content, h.error_msg, h.timed_out, h.created
    from public.market_requests q
    left join net._http_response h on h.id = q.request_id
    order by q.requested_at, q.request_id
  loop
    if r.answered then
      begin
        if public.market_ingest(r.symbol, r.kind, r.status_code, r.content, r.error_msg, r.timed_out, r.created) then
          v_ok := v_ok + 1;
        else
          v_err := v_err + 1;
        end if;
      exception when others then
        v_err := v_err + 1;
        update public.market_feed set last_error = 'Error interno: ' || left(sqlerrm, 120), last_error_at = v_now, error_count = error_count + 1 where symbol = r.symbol;
      end;
      delete from public.market_requests where request_id = r.request_id;
    elsif r.requested_at < v_now - interval '5 minutes' then
      -- Sin respuesta en 5 minutos: se da por perdida (si llegara después, se ignora) y se podrá pedir otra.
      v_lost := v_lost + 1;
      if r.kind = 'quote' then
        update public.market_feed set last_error = 'Sin respuesta de Yahoo en 5 minutos', last_error_at = v_now, error_count = error_count + 1 where symbol = r.symbol;
      else
        update public.market_feed set backfill_error = 'Sin respuesta de Yahoo en 5 minutos' where symbol = r.symbol;
      end if;
      delete from public.market_requests where request_id = r.request_id;
    end if;
  end loop;

  -- 2) lanzar las nuevas (una de precio por símbolo, y una sola vez la carga inicial del historial)
  for r in
    select a.symbol, f.backfilled_at, f.backfill_tried_at,
           exists (select 1 from public.market_requests q where q.symbol = a.symbol and q.kind = 'quote') as quote_pending,
           exists (select 1 from public.market_requests q where q.symbol = a.symbol and q.kind = 'backfill') as backfill_pending
    from public.invest_assets a join public.market_feed f on f.symbol = a.symbol
    order by a.sort
  loop
    begin
      if not r.quote_pending then
        v_id := net.http_get(url := v_url || r.symbol || '?interval=1d&range=1d', headers := v_headers, timeout_milliseconds := 10000);
        insert into public.market_requests (request_id, symbol, kind, requested_at) values (v_id, r.symbol, 'quote', v_now);
        update public.market_feed set last_request_at = v_now where symbol = r.symbol;
        v_launched := v_launched + 1;
      end if;
      if r.backfilled_at is null and not r.backfill_pending and (r.backfill_tried_at is null or r.backfill_tried_at < v_now - interval '30 minutes') then
        v_id := net.http_get(url := v_url || r.symbol || '?interval=1h&range=5d', headers := v_headers, timeout_milliseconds := 15000);
        insert into public.market_requests (request_id, symbol, kind, requested_at) values (v_id, r.symbol, 'backfill', v_now);
        update public.market_feed set backfill_tried_at = v_now where symbol = r.symbol;
        v_launched := v_launched + 1;
      end if;
    exception when others then
      update public.market_feed set last_error = 'No se pudo lanzar la petición: ' || left(sqlerrm, 120), last_error_at = v_now, error_count = error_count + 1 where symbol = r.symbol;
    end;
  end loop;

  -- 3) limpieza: el historial guarda 14 días (se revisa como mucho una vez por hora)
  if (select last_prune_at from public.market_state) is null or (select last_prune_at from public.market_state) < v_now - interval '1 hour' then
    delete from public.market_history where t < v_now - interval '14 days';
    delete from public.market_requests where requested_at < v_now - interval '1 day';
    update public.market_state set last_prune_at = v_now;
  end if;

  update public.market_state set last_tick_at = v_now, last_tick_note = format('%s respuestas buenas, %s con error, %s perdidas, %s peticiones nuevas', v_ok, v_err, v_lost, v_launched);
  return jsonb_build_object('ok', v_ok, 'errors', v_err, 'lost', v_lost, 'launched', v_launched);
end;
$$;
revoke all on function public.market_tick() from public, anon, authenticated;

-- Pone en marcha (o repara) el recolector: activa pg_net y pg_cron si hace falta (y se puede), programa el trabajo de pg_cron
-- (con nombre fijo: si ya existe se reemplaza, nunca se duplica) y lanza una ronda. Devuelve qué hay y qué falta.
-- Solo el dueño la ejecuta (SQL Editor: `select public.market_setup();`) o un administrador con market_refresh().
create or replace function public.market_setup()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_notes text[] := '{}';
  v_net boolean;
  v_cron boolean;
  v_scheduled boolean := false;
  v_tick jsonb;
begin
  if to_regclass('net._http_response') is null then
    begin
      execute 'create extension if not exists pg_net with schema extensions';
    exception when others then
      v_notes := v_notes || ('No se pudo activar pg_net (' || sqlerrm || '). Actívala en Dashboard → Database → Extensions.');
    end;
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    begin
      execute 'create extension if not exists pg_cron with schema pg_catalog';
    exception when others then
      v_notes := v_notes || ('No se pudo activar pg_cron (' || sqlerrm || '). Actívala en Dashboard → Database → Extensions.');
    end;
  end if;
  v_net := to_regclass('net._http_response') is not null and to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is not null;
  v_cron := to_regprocedure('cron.schedule(text,text,text)') is not null;
  if v_cron then
    begin
      execute $q$select cron.schedule('market_tick', '* * * * *', 'select public.market_tick()')$q$;
      v_scheduled := true;
    exception when others then
      v_notes := v_notes || ('No se pudo programar el trabajo de pg_cron: ' || sqlerrm);
    end;
  end if;
  if v_net then
    v_tick := public.market_tick();
  end if;
  return jsonb_build_object('pg_net', v_net, 'pg_cron', v_cron, 'scheduled', v_scheduled, 'tick', v_tick, 'notes', to_jsonb(v_notes));
end;
$$;
revoke all on function public.market_setup() from public, anon, authenticated;

-- Administradores: «Actualizar ahora». Repara lo que falte (extensiones y trabajo programado) y fuerza una ronda. Como pg_net
-- trabaja en segundo plano, las respuestas se recogen en la siguiente ronda (o llamando otra vez a los pocos segundos).
create or replace function public.market_refresh()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  return public.market_setup();
end;
$$;
revoke all on function public.market_refresh() from public, anon;
grant execute on function public.market_refresh() to authenticated;

-- Administradores: cómo está el recolector (extensiones, trabajo programado, última ronda, cada activo y las últimas
-- respuestas de Yahoo). Sirve para ver por qué no llegan precios.
create or replace function public.market_status()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_net boolean := to_regclass('net._http_response') is not null;
  v_cron boolean := to_regclass('cron.job') is not null;
  v_job jsonb;
  v_resp jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_cron then
    begin
      select jsonb_build_object('schedule', j.schedule, 'active', j.active,
               'last_runs', coalesce((select jsonb_agg(jsonb_build_object('status', d.status, 'message', left(d.return_message, 160), 'start', d.start_time) order by d.start_time desc)
                                      from (select * from cron.job_run_details x where x.jobid = j.jobid order by x.start_time desc limit 3) d), '[]'::jsonb))
        into v_job from cron.job j where j.jobname = 'market_tick';
    exception when others then
      select jsonb_build_object('schedule', j.schedule, 'active', j.active) into v_job from cron.job j where j.jobname = 'market_tick';
    end;
  end if;
  if v_net then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status_code, 'timed_out', x.timed_out, 'error', x.error_msg, 'created', x.created, 'body', left(x.content, 160)) order by x.created desc), '[]'::jsonb)
      into v_resp from (select * from net._http_response order by created desc limit 8) x;
  end if;
  return jsonb_build_object(
    'now', v_now,
    'pg_net', v_net,
    'pg_cron', v_cron,
    'job', v_job,
    'last_tick_at', (select s.last_tick_at from public.market_state s),
    'last_tick_note', (select s.last_tick_note from public.market_state s),
    'pending_requests', (select count(*) from public.market_requests),
    'assets', (
      select jsonb_agg(jsonb_build_object(
        'symbol', a.symbol, 'kind', a.kind,
        'state', public.market_state_of(q.fetched_at, q.quoted_at, v_now),
        'price', q.price, 'quoted_at', q.quoted_at, 'fetched_at', q.fetched_at,
        'last_ok_at', f.last_ok_at, 'last_status', f.last_status, 'last_error', f.last_error, 'last_error_at', f.last_error_at,
        'ok_count', f.ok_count, 'error_count', f.error_count,
        'history_points', (select count(*) from public.market_history h where h.symbol = a.symbol),
        'backfilled_at', f.backfilled_at, 'backfill_error', f.backfill_error) order by a.sort)
      from public.invest_assets a
      left join public.market_quotes q on q.symbol = a.symbol
      left join public.market_feed f on f.symbol = a.symbol),
    'recent_responses', v_resp);
end;
$$;
revoke all on function public.market_status() from public, anon;
grant execute on function public.market_status() to authenticated;

-- ---------- 4. cuentas y operaciones ----------

create table public.invest_accounts (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- `<> 'NaN'`: en numeric, NaN se ordena por encima de todos los números y pasaría `cash >= 0`.
  cash numeric(14, 2) not null default 200000 check (cash >= 0 and cash <> 'NaN'),
  created_at timestamptz not null default now()
);

create table public.invest_trades (
  id bigint generated always as identity primary key, -- el orden de las operaciones de cada jugador (coste medio)
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40), -- su nombre cuando operó
  symbol text not null references public.invest_assets (symbol),
  side text not null check (side in ('buy', 'sell')),
  qty numeric(18, 6) not null check (qty > 0 and qty <= 1000000),
  price numeric(14, 2) not null check (price > 0),     -- la cotización de Yahoo a la que se ejecutó
  total numeric(14, 2) not null check (total >= 0),
  quoted_at timestamptz not null,                      -- hora de esa cotización (último trade en Yahoo)
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

-- ---------- 5. lectura para el cliente ----------

-- Todos los activos con su última cotización, la variación del día respecto al cierre anterior, cómo está el precio y si se
-- puede operar. Sin cotización todavía: precio nulo y estado 'none'. server_now permite al cliente calcular «hace 40 s» sin
-- depender de su reloj.
create or replace function public.market_prices()
returns table (symbol text, name text, emoji text, kind text, price numeric, prev_close numeric, change_day_pct numeric, quoted_at timestamptz, fetched_at timestamptz, state text, operable boolean, server_now timestamptz)
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
    select a.symbol, a.name, a.emoji, a.kind, q.price, q.prev_close,
           case when q.prev_close > 0 then round((q.price / q.prev_close - 1) * 100, 2) end,
           q.quoted_at, q.fetched_at, s.st, s.st = 'live', v_now
    from public.invest_assets a
    left join public.market_quotes q on q.symbol = a.symbol
    cross join lateral (select public.market_state_of(q.fetched_at, q.quoted_at, v_now) as st) s
    order by a.sort, a.symbol;
end;
$$;
revoke all on function public.market_prices() from public, anon;
grant execute on function public.market_prices() to authenticated;

-- Serie de precios REAL de un activo para dibujar el gráfico: p_points puntos repartidos entre hace p_hours horas y ahora, cada
-- uno con el último precio conocido en ese momento (los instantes anteriores al primer dato no salen). Límites: 1-336 horas y
-- 2-500 puntos. Ordenada por hora.
create or replace function public.market_series(p_symbol text, p_hours int default 48, p_points int default 96)
returns table (t timestamptz, price numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_sym text := upper(btrim(coalesce(p_symbol, '')));
  v_last timestamptz := clock_timestamp();
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 336 or p_points is null or p_points not between 2 and 500 then
    raise exception 'El historial admite de 1 a 336 horas y de 2 a 500 puntos';
  end if;
  if not exists (select 1 from public.invest_assets where symbol = v_sym) then
    raise exception 'Ese activo no existe en la bolsa';
  end if;
  return query
    select s.ts, h.price
    from (select v_last - (p_hours * 3600.0 * (p_points - 1 - i) / (p_points - 1)) * interval '1 second' as ts
          from generate_series(0, p_points - 1) as i) s
    cross join lateral (select x.price from public.market_history x where x.symbol = v_sym and x.t <= s.ts order by x.t desc limit 1) h
    order by s.ts;
end;
$$;
revoke all on function public.market_series(text, int, int) from public, anon;
grant execute on function public.market_series(text, int, int) to authenticated;

-- Los mini gráficos de todos los activos de una sola vez (una consulta en vez de doce). Límites: 1-336 horas y 2-60 puntos.
create or replace function public.market_sparks(p_hours int default 120, p_points int default 30)
returns table (symbol text, t timestamptz, price numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_last timestamptz := clock_timestamp();
begin
  if not public.is_member() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if p_hours is null or p_hours not between 1 and 336 or p_points is null or p_points not between 2 and 60 then
    raise exception 'Los mini gráficos admiten de 1 a 336 horas y de 2 a 60 puntos';
  end if;
  return query
    select a.symbol, s.ts, h.price
    from public.invest_assets a
    cross join lateral (select v_last - (p_hours * 3600.0 * (p_points - 1 - i) / (p_points - 1)) * interval '1 second' as ts
                        from generate_series(0, p_points - 1) as i) s
    cross join lateral (select x.price from public.market_history x where x.symbol = a.symbol and x.t <= s.ts order by x.t desc limit 1) h
    order by a.sort, a.symbol, s.ts;
end;
$$;
revoke all on function public.market_sparks(int, int) from public, anon;
grant execute on function public.market_sparks(int, int) to authenticated;

-- Posición de cada jugador en cada activo (solo lo que tiene ahora): cantidad y coste medio (media ponderada móvil; ver
-- arriba). Interna: la usan invest_positions e invest_leaderboard.
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

-- Todas las posiciones de todos: cantidad, coste medio, precio de la última cotización, valor y ganancia (valor − cantidad ×
-- coste medio). Valora con la última cotización guardada aunque el mercado esté cerrado.
create or replace function public.invest_positions()
returns table (user_id uuid, name text, symbol text, qty numeric, avg_cost numeric, price numeric, value numeric, pnl numeric)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
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
    left join public.market_quotes mq on mq.symbol = h.symbol
    cross join lateral (select coalesce(mq.price, round(h.avg_cost, 2)) as p) px
    order by ac.name, ac.user_id, a.sort, h.symbol;
end;
$$;
revoke all on function public.invest_positions() from public, anon;
grant execute on function public.invest_positions() to authenticated;

-- Clasificación: por jugador, efectivo + valor de sus posiciones = patrimonio (total), ganancia en % sobre los 200.000 $
-- iniciales y número de operaciones. Ordenada por patrimonio (y por nombre si empatan).
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

-- La mejor y la peor operación de todos (ver arriba cómo se mide). Dos filas ('best' y 'worst'), o ninguna si nadie ha operado
-- (con una sola operación, las dos son la misma).
create or replace function public.invest_best_worst()
returns table (kind text, id bigint, user_id uuid, name text, symbol text, side text, qty numeric, price numeric, total numeric, created_at timestamptz, price_now numeric, gain numeric, asset_name text)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
#variable_conflict use_column
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
      left join public.market_quotes mq on mq.symbol = t.symbol
      cross join lateral (select coalesce(mq.price, t.price) as p) px
    )
    (select 'best'::text, g.* from g order by g.gain desc, g.id limit 1)
    union all
    (select 'worst'::text, g.* from g order by g.gain, g.id limit 1);
end;
$$;
revoke all on function public.invest_best_worst() from public, anon;
grant execute on function public.invest_best_worst() to authenticated;

-- ---------- 6. escritura: solo por estas funciones ----------

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

-- Comprar o vender. Siempre a la última cotización guardada (el servidor la tiene; el cliente no envía precio) y solo si es FRESCA
-- (ver arriba), y siempre como quien llama (auth.uid()). Devuelve la operación guardada. Los fallos explican en español qué pasó.
create or replace function public.place_trade(p_symbol text, p_side text, p_qty numeric)
returns public.invest_trades
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_symbol text := upper(btrim(coalesce(p_symbol, '')));
  v_side text := lower(btrim(coalesce(p_side, '')));
  v_asset public.invest_assets;
  v_acc public.invest_accounts;
  v_quote public.market_quotes;
  v_state text;
  v_held numeric;
  v_now timestamptz;
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
  select * into v_asset from public.invest_assets where symbol = v_symbol;
  if not found then
    raise exception 'Ese activo no existe en la bolsa';
  end if;

  -- Se bloquea la cuenta hasta el final de la operación: otra operación del mismo jugador espera aquí y, al
  -- continuar, ya ve el saldo y las posiciones actualizados.
  select * into v_acc from public.invest_accounts where user_id = v_uid for update;
  if not found then
    raise exception 'Primero entra a la bolsa para recibir tus 200.000 $';
  end if;

  -- Solo a precio fresco: se lee UNA vez la cotización y de esa misma fila salen el estado, el precio y su hora.
  v_now := clock_timestamp();
  select * into v_quote from public.market_quotes where symbol = v_symbol;
  v_state := public.market_state_of(v_quote.fetched_at, v_quote.quoted_at, v_now);
  if v_state <> 'live' then
    if v_state = 'closed' and v_asset.kind = 'accion' then
      raise exception 'Mercado cerrado: las acciones de EE. UU. se operan de lunes a viernes, de 9:30 a 16:00 (hora de Nueva York). Último precio de % (%): % $. Mientras tanto puedes operar con Bitcoin y Ethereum.',
        v_asset.name, to_char(v_quote.quoted_at at time zone 'America/New_York', 'DD/MM HH24:MI "NY"'), public.invest_fmt(v_quote.price);
    end if;
    raise exception 'No hay precios en directo ahora mismo para %. Inténtalo en unos minutos.', v_asset.name;
  end if;
  v_total := round(p_qty * v_quote.price, 2);

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

  insert into public.invest_trades (user_id, name, symbol, side, qty, price, total, quoted_at, created_at)
    values (v_uid, v_acc.name, v_symbol, v_side, p_qty, v_quote.price, v_total, v_quote.quoted_at, v_now)
    returning * into v_trade;
  return v_trade;
end;
$$;
revoke all on function public.place_trade(text, text, numeric) from public, anon;
grant execute on function public.place_trade(text, text, numeric) to authenticated;

-- Reiniciar la bolsa: solo administradores. Borra todas las operaciones y deja a todos con 200.000 $ (las cuentas siguen y los
-- precios no se tocan). Devuelve cuántas cuentas se reiniciaron. (`where true`: las extensiones de seguridad de Supabase, como
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

-- ---------- 7. tiempo real y puesta en marcha ----------

-- Las operaciones nuevas llegan a todos sin recargar (Realtime respeta la política de lectura de arriba). Las cotizaciones no
-- se publican a propósito: son doce filas cada minuto y la pantalla las consulta cada ~20 s.
alter publication supabase_realtime add table public.invest_trades;

-- Cuentas de la versión anterior (si la había): se recrean con 200.000 $.
do $mig2$
declare
  v_n int;
begin
  if to_regclass('pg_temp.bolsa_cuentas_antiguas') is not null then
    insert into public.invest_accounts (user_id, name, cash, created_at)
      select user_id, name, 200000, created_at from pg_temp.bolsa_cuentas_antiguas;
    get diagnostics v_n = row_count;
    drop table pg_temp.bolsa_cuentas_antiguas;
    raise notice 'Bolsa: % cuentas conservadas con 200.000 $.', v_n;
  end if;
end
$mig2$;

-- Extensiones, trabajo de pg_cron y primera ronda. Si no se puede, NO falla la instalación: la bolsa queda sin precios hasta
-- que se activen pg_net y pg_cron (Dashboard → Database → Extensions) y se ejecute `select public.market_setup();`.
do $arranque$
declare
  v_r jsonb;
begin
  v_r := public.market_setup();
  if (v_r ->> 'pg_net')::boolean and (v_r ->> 'pg_cron')::boolean and (v_r ->> 'scheduled')::boolean then
    raise notice 'Bolsa: precios reales en marcha (pg_cron pide los precios a Yahoo Finance cada minuto; la primera ronda ya está lanzada).';
  else
    raise notice 'Bolsa instalada, pero SIN precios en directo todavía: pg_net=%, pg_cron=%, trabajo programado=%. Activa pg_net y pg_cron en Dashboard → Database → Extensions y ejecuta: select public.market_setup();', v_r ->> 'pg_net', v_r ->> 'pg_cron', v_r ->> 'scheduled';
  end if;
  if jsonb_array_length(v_r -> 'notes') > 0 then
    raise notice 'Bolsa: %', v_r -> 'notes';
  end if;
exception when others then
  raise notice 'Bolsa instalada, pero no se pudo poner en marcha el recolector de precios (%). Activa pg_net y pg_cron en Dashboard → Database → Extensions y ejecuta: select public.market_setup();', sqlerrm;
end
$arranque$;
