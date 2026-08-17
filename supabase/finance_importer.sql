-- Finanzas Importador v1
-- Ejecutar una sola vez en Supabase SQL Editor.
-- Requiere que ya existan las tablas base de finanzas.

alter table public.finanzas_movimientos add column if not exists origen text;
alter table public.finanzas_movimientos add column if not exists importacion_id uuid;
alter table public.finanzas_movimientos add column if not exists movimiento_importado_id uuid;
alter table public.finanzas_movimientos add column if not exists external_hash text;
alter table public.finanzas_movimientos add column if not exists comprobante text;
alter table public.finanzas_movimientos add column if not exists cuota_actual integer;
alter table public.finanzas_movimientos add column if not exists cuotas_totales integer;
alter table public.finanzas_movimientos add column if not exists periodo_resumen text;
alter table public.finanzas_movimientos add column if not exists merchant_key text;

create table if not exists public.finanzas_importaciones (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tipo_fuente text not null default 'documento_financiero',
  proveedor text,
  cuenta text,
  tarjeta text,
  periodo text,
  fecha_cierre date,
  fecha_vencimiento date,
  total_pesos numeric(14,2),
  total_dolares numeric(14,2),
  pago_minimo numeric(14,2),
  estado text not null default 'procesando' check (estado in ('procesando','revision_pendiente','procesada','error','ignorada')),
  archivo_id uuid references public.archivos(id) on delete set null,
  item_id uuid references public.items(id) on delete set null,
  telegram_chat_id text,
  nombre_archivo text,
  mime_type text,
  archivo_hash text not null,
  resumen_json jsonb
);

create unique index if not exists finanzas_importaciones_archivo_hash_idx on public.finanzas_importaciones(archivo_hash);
create index if not exists finanzas_importaciones_created_idx on public.finanzas_importaciones(created_at desc);
create index if not exists finanzas_importaciones_estado_idx on public.finanzas_importaciones(estado);
create index if not exists finanzas_importaciones_periodo_idx on public.finanzas_importaciones(periodo);

create table if not exists public.finanzas_reglas_comercios (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  patron text not null,
  comercio_normalizado text,
  categoria_financiera text not null,
  subcategoria_financiera text,
  medio_pago text,
  aplicar_auto boolean not null default true,
  confianza numeric(4,3) not null default 1,
  ejemplos text[] not null default '{}',
  notas text
);

create unique index if not exists finanzas_reglas_comercios_patron_idx on public.finanzas_reglas_comercios(patron);
create index if not exists finanzas_reglas_comercios_categoria_idx on public.finanzas_reglas_comercios(categoria_financiera);
create index if not exists finanzas_reglas_comercios_auto_idx on public.finanzas_reglas_comercios(aplicar_auto);

create table if not exists public.finanzas_movimientos_importados (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  importacion_id uuid not null references public.finanzas_importaciones(id) on delete cascade,
  external_hash text not null,
  fecha_movimiento date,
  descripcion_original text not null,
  descripcion_normalizada text,
  comercio_detectado text,
  merchant_key text,
  comprobante text,
  monto numeric(14,2) not null,
  moneda text not null default 'ARS',
  tipo text not null default 'gasto',
  tarjeta text,
  proveedor text,
  cuota_actual integer,
  cuotas_totales integer,
  categoria_sugerida text,
  subcategoria_sugerida text,
  categoria_confirmada text,
  subcategoria_confirmada text,
  regla_id uuid references public.finanzas_reglas_comercios(id) on delete set null,
  confianza_clasificacion numeric(4,3) not null default 0,
  estado text not null default 'pendiente_revision' check (estado in ('pendiente_revision','clasificado','importado','conciliado','ignorado','error')),
  movimiento_id uuid references public.finanzas_movimientos(id) on delete set null,
  match_score numeric(5,4),
  match_reason text,
  raw_json jsonb
);

create unique index if not exists finanzas_movimientos_importados_external_hash_idx on public.finanzas_movimientos_importados(external_hash);
create index if not exists finanzas_movimientos_importados_importacion_idx on public.finanzas_movimientos_importados(importacion_id);
create index if not exists finanzas_movimientos_importados_estado_idx on public.finanzas_movimientos_importados(estado);
create index if not exists finanzas_movimientos_importados_fecha_idx on public.finanzas_movimientos_importados(fecha_movimiento desc);
create index if not exists finanzas_movimientos_importados_merchant_idx on public.finanzas_movimientos_importados(merchant_key);

create table if not exists public.finanzas_conciliaciones (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  movimiento_importado_id uuid not null references public.finanzas_movimientos_importados(id) on delete cascade,
  movimiento_id uuid not null references public.finanzas_movimientos(id) on delete cascade,
  tipo_match text not null default 'automatico' check (tipo_match in ('automatico','manual','confirmado_usuario')),
  score numeric(5,4) not null default 0,
  estado text not null default 'confirmado' check (estado in ('sugerido','confirmado','rechazado')),
  notas text
);

create index if not exists finanzas_conciliaciones_movimiento_idx on public.finanzas_conciliaciones(movimiento_id);
create index if not exists finanzas_conciliaciones_importado_idx on public.finanzas_conciliaciones(movimiento_importado_id);

create unique index if not exists finanzas_movimientos_external_hash_idx
on public.finanzas_movimientos(external_hash)
where external_hash is not null;

create index if not exists finanzas_movimientos_importacion_idx on public.finanzas_movimientos(importacion_id);
create index if not exists finanzas_movimientos_merchant_idx on public.finanzas_movimientos(merchant_key);
create index if not exists finanzas_movimientos_periodo_resumen_idx on public.finanzas_movimientos(periodo_resumen);

-- RLS: el bot entra por backend con service_role. No se habilita acceso público.
alter table public.finanzas_importaciones enable row level security;
alter table public.finanzas_movimientos_importados enable row level security;
alter table public.finanzas_reglas_comercios enable row level security;
alter table public.finanzas_conciliaciones enable row level security;

insert into public.taxonomia (grupo, valor, descripcion) values
('categoria_financiera','Gastos financieros','Intereses, sellos, percepciones, comisiones y cargos de tarjetas'),
('categoria_financiera','Donaciones','Donaciones y aportes'),
('categoria_financiera','Herramientas IA','Servicios de inteligencia artificial como ChatGPT/OpenAI'),
('origen_financiero','manual','Movimiento cargado manualmente por Telegram'),
('origen_financiero','importacion','Movimiento importado desde resumen, CSV o extracto'),
('estado_importacion_financiera','pendiente_revision','Movimiento importado que requiere clasificación'),
('estado_importacion_financiera','conciliado','Movimiento importado unido a un gasto manual existente'),
('estado_importacion_financiera','importado','Movimiento importado como gasto confirmado')
on conflict (grupo, valor) do nothing;
