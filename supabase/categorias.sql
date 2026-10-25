-- Categoría y ubicación de cada gasto o compra: de qué es (nafta, comida, salidas…) para el resumen «¿En qué gastamos?» de Cuentas,
-- el álbum y el PDF, y dónde se pagó para que salga en el mapa.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de extras.sql (añade columnas a public.expenses). Una sola vez.
-- No depende de compras.sql, adjuntos.sql ni de ningún otro archivo: se puede aplicar antes, después o sin ellos.
--
-- Contenido (todo en public.expenses):
--   · category  una de ocho claves cerradas: nafta, comida, salidas, transporte, alojamiento, compras, salud, otros.
--               Puede ser nula: los gastos que ya existían se quedan sin categoría (no se tocan) y la web les calcula una por las
--               palabras del concepto («cena en el puerto» → comida). Solo se guarda lo que elige quien apunta el gasto.
--   · lat, lng  dónde se pagó (opcional; la web la pone sola al apuntar el gasto, si quien lo apunta lo deja, y se puede quitar o
--               mover). Mismas reglas que las coordenadas de las fotos y las actividades (rangos y pareja nula a la vez) y, además,
--               nunca (0, 0): es el «punto nulo» que devuelven los GPS sin señal, no un sitio del viaje.
-- El reparto (paid_by, split, amount) no cambia; las políticas RLS tampoco.
--
-- Privacidad: como las de las fotos, las coordenadas de un gasto las ven todos los viajeros autorizados (nadie más).

alter table public.expenses
  add column category text
    constraint expenses_category_check check (category in ('nafta', 'comida', 'salidas', 'transporte', 'alojamiento', 'compras', 'salud', 'otros')),
  add column lat double precision,
  add column lng double precision;
-- (Un CHECK deja pasar el nulo: así los gastos antiguos y los que se apuntan sin categoría o sin ubicación siguen siendo válidos.
-- Una cadena vacía, una clave con mayúsculas o con espacios y cualquier otra palabra se rechazan. Un valor NaN o infinito en lat o
-- lng tampoco cabe en los rangos.)

alter table public.expenses
  add constraint expenses_lat_range check (lat between -90 and 90),
  add constraint expenses_lng_range check (lng between -180 and 180),
  add constraint expenses_latlng_pair check ((lat is null) = (lng is null)),
  add constraint expenses_latlng_not_zero check (not (lat = 0 and lng = 0));

-- Permisos: INSERT y SELECT ya son a nivel de tabla (extras.sql), así que las columnas nuevas se pueden leer y escribir al apuntar un
-- gasto sin conceder nada más (y anon sigue sin nada: extras.sql le quitó todo). UPDATE se concede por columnas: se añaden solo las
-- tres nuevas. La política expenses_update no filtra por autor (cualquier viajero edita cualquier gasto), así que se editan igual
-- que el resto de columnas.
grant update (category, lat, lng) on public.expenses to authenticated;
