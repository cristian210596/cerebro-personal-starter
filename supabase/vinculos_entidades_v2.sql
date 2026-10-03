-- Vínculos V2: comprobantes, recibos de sueldo y archivos (correr una vez en Supabase > SQL Editor).
-- Idempotente. Requiere haber corrido antes supabase/vinculos_entidades.sql.

alter table public.finanzas_comprobantes
  add column if not exists entidad_id uuid references public.entidades(id) on delete set null;
create index if not exists finanzas_comprobantes_entidad_idx on public.finanzas_comprobantes(entidad_id);

alter table public.sueldos_recibos
  add column if not exists entidad_id uuid references public.entidades(id) on delete set null;
create index if not exists sueldos_recibos_entidad_idx on public.sueldos_recibos(entidad_id);

alter table public.archivos
  add column if not exists notion_page_id text;
