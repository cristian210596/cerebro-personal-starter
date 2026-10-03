-- Productos V2: tipo genérico (ej: "Leche" para todas las marcas) y contenido para precio por litro/kilo.
-- Idempotente. Requiere supabase/productos.sql.
alter table public.productos add column if not exists tipo_producto text;
alter table public.productos add column if not exists contenido numeric;   -- en litros, kilos o unidades
alter table public.productos add column if not exists unidad text;         -- 'l' | 'kg' | 'u'
create index if not exists productos_tipo_idx on public.productos(tipo_producto);
