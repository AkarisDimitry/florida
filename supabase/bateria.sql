-- Batería de los viajeros (opcional). Ejecutar en Supabase → SQL Editor DESPUÉS de presencia.sql (añade columnas a
-- public.presence). Una sola vez; el todo en uno solo lo aplica si todavía falta la columna `presence.battery`.
--
-- Qué hace: junto con su latido de «estoy en línea» (cada ~45 s), cada móvil envía su nivel de batería y si está cargando.
-- Los demás viajeros lo ven en el panel de personas («Ana · 🔋 23 %») y, cuando la batería de alguien baja del 20 %, a
-- todos les llega un aviso («🔋 Ana tiene poca batería»), para que el grupo se entere antes de que se apague el móvil.
--
-- Limitaciones honestas:
--   · Los navegadores solo dejan leer la batería en Chrome/Edge (Android y escritorio). Safari (iPhone) y Firefox NO lo
--     permiten: en esos móviles la columna queda vacía y la web lo dice con claridad.
--   · La batería sale del propio móvil, que la envía mientras la web está abierta: no es una garantía, es un dato aproximado.
--   · Quien no quiera compartirla la desactiva en su panel de personas; entonces se envía vacío (null).
--
-- Contenido:
--   1. presence.battery   nivel de 0 a 100 (null = no se comparte o no se puede leer).
--      presence.charging  true si está cargando (null = desconocido).
--   2. Permisos: solo estas dos columnas se añaden al INSERT y al UPDATE por columnas que ya tenía `presence`.
--   3. Aviso de batería baja: disparador sobre `presence` que, al cruzar el 20 % (o el 10 %) hacia abajo sin estar
--      cargando, pide un aviso a todos los demás con public.push_notify (de avisos.sql) SI existe. Es opcional y
--      nunca puede romper el latido: cualquier fallo al avisar se descarta con un warning.

-- ---------- 1. columnas ----------

alter table public.presence
  add column battery smallint check (battery between 0 and 100),
  add column charging boolean;

-- ---------- 2. permisos ----------

-- presencia.sql concede a `authenticated` INSERT y UPDATE solo en (user_id, name): el upsert de PostgREST necesita las dos
-- columnas en los dos sitios. Se añaden las dos nuevas igual. `last_seen` sigue sin ser escribible (la pone su disparador).
-- Las políticas de presence no cambian: cada uno solo escribe SU fila.
grant insert (battery, charging) on public.presence to authenticated;
grant update (battery, charging) on public.presence to authenticated;

-- ---------- 3. aviso de batería baja ----------

-- Al cruzar hacia abajo el 20 % (aviso normal) o el 10 % (aviso más serio) sin estar cargando. «Cruzar» significa que la
-- lectura anterior estaba por encima del umbral (o no existía): así una batería que se queda en el 15 % no repite el aviso
-- en cada latido. Además, push_notify agrupa avisos repetidos de la misma persona (dos horas por umbral).
-- Se ejecuta como dueño (security definer) porque push_notify no la puede llamar un viajero, y se envuelve en un bloque de
-- excepciones: un fallo al avisar (push_notify ausente, pg_net caído…) nunca debe impedir guardar el latido.
create or replace function public.presence_battery_alert()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_low int;
  v_title text;
  v_who text := coalesce(nullif(btrim(new.name), ''), 'Un viajero');
begin
  if new.battery is null or coalesce(new.charging, false) then
    return new;
  end if;

  if new.battery <= 10 and (tg_op = 'INSERT' or old.battery is null or old.battery > 10 or coalesce(old.charging, false)) then
    v_low := 10;
    v_title := '🪫 ' || v_who || ' casi se queda sin batería (' || new.battery || ' %)';
  elsif new.battery <= 20 and (tg_op = 'INSERT' or old.battery is null or old.battery > 20 or coalesce(old.charging, false)) then
    v_low := 20;
    v_title := '🔋 ' || v_who || ' tiene poca batería (' || new.battery || ' %)';
  else
    return new;
  end if;

  begin
    -- Solo si avisos.sql está instalado; con otra firma o sin la función, no se avisa y listo.
    if to_regprocedure('public.push_notify(text,text,text,text,uuid,boolean,text,uuid[],text,boolean,text,integer)') is not null then
      perform public.push_notify(
        'bateria', v_title, 'Quizá necesite un cargador. Toca para ver dónde está.', '#mapa',
        new.user_id, false, null, null, 'bateria-' || new.user_id::text || '-' || v_low, false,
        'bateria-' || new.user_id::text || '-' || v_low, 7200
      );
    end if;
  exception when others then
    raise warning 'presence_battery_alert: no se pudo avisar (%): %', sqlstate, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.presence_battery_alert() from public, anon, authenticated;

create trigger presence_battery_alert
  after insert or update of battery, charging on public.presence
  for each row
  when (new.battery is not null and new.battery <= 20)
  execute function public.presence_battery_alert();
