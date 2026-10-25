-- Mapa, rutas y valoraciones: columnas nuevas.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql y fotos.sql. Una sola vez.
--
-- Privacidad: las coordenadas de las fotos las ven todos los viajeros autorizados (nadie más).
-- Los archivos de imagen NO llevan ubicación: se les quita al subirlos; solo se guardan estas columnas.

-- ---------- actividades: lugar en el mapa y valoración ----------

alter table public.activities
  add column lat double precision,
  add column lng double precision,
  add column rating smallint;

alter table public.activities
  add constraint activities_lat_range check (lat between -90 and 90),
  add constraint activities_lng_range check (lng between -180 and 180),
  add constraint activities_latlng_pair check ((lat is null) = (lng is null)),
  add constraint activities_rating_range check (rating between 1 and 5);

-- ---------- fotos: dónde y cuándo se tomaron ----------

alter table public.photos
  add column lat double precision,
  add column lng double precision,
  add column taken_at timestamptz; -- hora de reloj de la cámara (EXIF), guardada tal cual como UTC

alter table public.photos
  add constraint photos_lat_range check (lat between -90 and 90),
  add constraint photos_lng_range check (lng between -180 and 180),
  add constraint photos_latlng_pair check ((lat is null) = (lng is null));

-- Cada viajero puede colocar, mover o quitar la ubicación de SUS fotos (y solo esas dos columnas).
grant update (lat, lng) on public.photos to authenticated;
create policy photos_update on public.photos
  for update to authenticated
  using (public.is_member() and created_by = auth.uid())
  with check (public.is_member() and created_by = auth.uid());
