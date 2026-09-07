-- Calibraciones / Equipos v1
-- Ejecutar una sola vez en Supabase SQL Editor.
--
-- Fuente: hoja "Calibraciones con datos" de la planilla maestra de
-- calibraciones que Cristian mantiene a mano y reenvía por Telegram cada vez
-- que la actualiza (no hay sincronización automática con Google Drive).
--
-- Clave real: codigo + subid. Un mismo "equipo padre" (ej AUT-002, una
-- autoclave) puede tener varios sub-ítems propios con vencimiento
-- INDEPENDIENTE: sondas de temperatura, manovacuómetros, lazos de presión,
-- etc. subid = 'N.A.' cuando el equipo no tiene sub-ítems (caso más común).
-- Si la planilla trae dos filas con el mismo codigo+subid sin diferenciar
-- (pasa con algún equipo viejo dado de baja), el importador nunca pisa una
-- fila: le suma un sufijo "#2" al subid para no perder el registro.

create table if not exists public.equipos_calibraciones (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  codigo text not null,
  subid text not null default 'N.A.',
  equipo text,
  marca text,
  modelo text,
  fecha_calibracion date,
  intervalo_meses integer,
  intervalo_raw text,
  fecha_recalibracion date,
  estado_calib_raw text,
  proveedor text,
  estado_uso text,
  estado_uso_raw text,
  ubicacion text,
  observaciones text,
  clase_serie text,
  rango_uso_gray text,
  capacidad_rango text,
  origen_importacion text not null default 'planilla_excel',
  unique (codigo, subid)
);

create index if not exists idx_equipos_calibraciones_codigo on public.equipos_calibraciones(codigo);
create index if not exists idx_equipos_calibraciones_recalibracion on public.equipos_calibraciones(fecha_recalibracion);
create index if not exists idx_equipos_calibraciones_estado_uso on public.equipos_calibraciones(estado_uso);
