-- Compras y gastos: distinguir una compra (algo que se compró en una tienda) de un gasto (una cuenta, un taxi...)
-- en el reparto de gastos.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de extras.sql (añade columnas a public.expenses). Una sola vez.
-- No depende de adjuntos.sql ni de ningún otro archivo: se puede aplicar antes, después o sin él.
--
-- Contenido (todo en public.expenses):
--   · kind   'gasto' (por defecto) o 'compra'. Los gastos que ya existían quedan como 'gasto'.
--   · place  tienda o sitio donde se compró (texto libre, opcional, máx. 120 caracteres).
-- El reparto (paid_by, split, amount) es el mismo para los dos tipos: solo cambia cómo se muestran.
-- (La foto del ticket de una compra se ata con photos.expense_id, que añade adjuntos.sql.)

alter table public.expenses
  add column kind text not null default 'gasto' check (kind in ('gasto', 'compra')),
  add column place text check (char_length(place) <= 120);

-- UPDATE se concede por columnas (extras.sql): se añaden solo las dos nuevas. La política expenses_update
-- no filtra por autor (cualquier viajero edita cualquier gasto), así que `kind` y `place` se editan igual que
-- el resto de columnas. El INSERT ya es a nivel de tabla y las incluye; las políticas no cambian.
grant update (kind, place) on public.expenses to authenticated;
