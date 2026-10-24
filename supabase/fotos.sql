-- Fotos del viaje: tabla, almacén privado y permisos.
-- Ejecutar en Supabase → SQL Editor DESPUÉS de schema.sql (usa public.is_member()).
-- Las fotos se guardan en el bucket privado `photos`, en la carpeta del usuario que las sube:
--   <user_id>/<foto_id>.jpg      (versión grande, máx. 1600 px)
--   <user_id>/<foto_id>_t.jpg    (miniatura, máx. 400 px)

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  thumb_path text not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text check (char_length(created_by_name) <= 40),
  created_at timestamptz not null default now()
);

revoke all on public.photos from anon;
grant select, insert, delete on public.photos to authenticated;
alter table public.photos enable row level security;

-- Todos los viajeros ven las fotos y suben las suyas; cada uno borra solo las suyas.
create policy photos_select on public.photos
  for select to authenticated using (public.is_member());
create policy photos_insert on public.photos
  for insert to authenticated with check (public.is_member() and created_by = auth.uid());
create policy photos_delete on public.photos
  for delete to authenticated using (public.is_member() and created_by = auth.uid());

-- ---------- almacén de archivos ----------

-- Privado (se muestra con enlaces temporales), solo JPEG, máx. 5 MB por archivo.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg'])
on conflict (id) do nothing;

create policy photos_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.is_member());

create policy photos_objects_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

create policy photos_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- tiempo real ----------

alter publication supabase_realtime add table public.photos;
