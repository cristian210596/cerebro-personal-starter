-- Vincular movimientos, deudas y entidades (correr una vez en Supabase > SQL Editor).
-- Es idempotente: se puede correr más de una vez sin romper nada.

alter table public.finanzas_movimientos
  add column if not exists entidad_id uuid references public.entidades(id) on delete set null;
create index if not exists finanzas_movimientos_entidad_idx on public.finanzas_movimientos(entidad_id);

alter table public.finanzas_deudas
  add column if not exists entidad_id uuid references public.entidades(id) on delete set null;
create index if not exists finanzas_deudas_entidad_idx on public.finanzas_deudas(entidad_id);

alter table public.entidades
  add column if not exists notion_page_id text;
