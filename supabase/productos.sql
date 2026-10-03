-- Catálogo de productos + historial de precios (correr una vez en Supabase > SQL Editor).
-- Idempotente.

create table if not exists public.productos (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ean text,                         -- código de barras normalizado (EAN-8/12/13)
  clave_normalizada text not null,  -- descripción normalizada (para agrupar los que no traen código)
  nombre text not null,
  alias text[] not null default '{}',
  marca text,
  marca_entidad_id uuid references public.entidades(id) on delete set null,
  categoria text,
  subcategoria text,
  notion_page_id text,
  notion_sync_pending boolean not null default true
);
create unique index if not exists productos_ean_uidx on public.productos(ean) where ean is not null;
create unique index if not exists productos_clave_sin_ean_uidx on public.productos(clave_normalizada) where ean is null;
create index if not exists productos_sync_idx on public.productos(notion_sync_pending) where notion_sync_pending;

alter table public.finanzas_comprobante_items
  add column if not exists producto_id uuid references public.productos(id) on delete set null;
alter table public.finanzas_comprobante_items
  add column if not exists precio_unitario_neto numeric;
create index if not exists finanzas_comprobante_items_producto_idx on public.finanzas_comprobante_items(producto_id);

-- Vista de historial: una fila por compra de cada producto, con el precio realmente pagado.
create or replace view public.productos_precios as
select
  i.producto_id,
  p.nombre as producto,
  p.ean,
  p.marca,
  p.categoria,
  c.fecha_emision as fecha,
  c.comercio,
  c.entidad_id as comercio_entidad_id,
  c.sucursal,
  i.cantidad,
  i.precio_unitario,
  i.descuento,
  i.precio_unitario_neto,
  i.comprobante_id
from public.finanzas_comprobante_items i
join public.finanzas_comprobantes c on c.id = i.comprobante_id
left join public.productos p on p.id = i.producto_id;
