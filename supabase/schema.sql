create extension if not exists vector;

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fecha_evento date,
  fuente text not null default 'telegram',
  telegram_user_id text,
  telegram_chat_id text,
  telegram_message_id text,
  texto_original text not null,
  titulo text,
  resumen text,
  categoria_principal text,
  subcategorias text[] not null default '{}',
  tipo_item text,
  estado text,
  valoracion text,
  importancia text,
  accion_futura text,
  tags text[] not null default '{}',
  entidades_json jsonb not null default '[]'::jsonb,
  url text,
  notion_page_id text,
  embedding_status text not null default 'pendiente',
  classifier_json jsonb not null default '{}'::jsonb
);

create table if not exists public.entidades (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tipo text not null,
  nombre text not null,
  alias text[] not null default '{}',
  descripcion text,
  categoria_relacionada text,
  unique (tipo, nombre)
);

create table if not exists public.item_entidades (
  item_id uuid not null references public.items(id) on delete cascade,
  entidad_id uuid not null references public.entidades(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, entidad_id)
);

create table if not exists public.memorias (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  afirmacion text not null,
  categoria text,
  confianza text,
  vigente boolean not null default true,
  origen_item_id uuid references public.items(id) on delete set null,
  ultima_confirmacion date
);

create table if not exists public.archivos (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.items(id) on delete cascade,
  created_at timestamptz not null default now(),
  tipo_archivo text,
  nombre_archivo text,
  mime_type text,
  storage_url text,
  transcripcion text,
  descripcion_ia text
);

create table if not exists public.taxonomia (
  id uuid primary key default gen_random_uuid(),
  grupo text not null,
  valor text not null,
  descripcion text,
  activo boolean not null default true,
  unique (grupo, valor)
);

create index if not exists idx_items_created_at on public.items(created_at desc);
create index if not exists idx_items_categoria on public.items(categoria_principal);
create index if not exists idx_items_estado on public.items(estado);
create index if not exists idx_items_tags on public.items using gin(tags);
create index if not exists idx_items_subcategorias on public.items using gin(subcategorias);
create index if not exists idx_items_entidades_json on public.items using gin(entidades_json);

insert into public.taxonomia (grupo, valor, descripcion) values
('categoria_principal','Trabajo','Laboral, técnico, GMP, equipos, documentos, problemas de planta/laboratorio'),
('categoria_principal','Estudio','Universidad, materias, clases, exámenes, apuntes'),
('categoria_principal','Compras','Cosas compradas, comparadas o deseadas'),
('categoria_principal','Cocina','Recetas, ingredientes, resultados, preferencias de comida'),
('categoria_principal','Ideas / Proyectos','Apps, automatizaciones, sistemas, bots, mejoras'),
('categoria_principal','Salud / Cuerpo','Sueño, síntomas, hábitos, cuerpo, entrenamiento'),
('categoria_principal','Casa / Vida diaria','Organización, trámites, mantenimiento, objetos'),
('categoria_principal','Consumo cultural','Videos, libros, podcasts, música, documentales'),
('categoria_principal','Lugares','Restaurantes, locales, zonas, alquileres'),
('categoria_principal','Personas','Datos relevantes sobre personas o contactos'),
('categoria_principal','Finanzas personales','Gastos, precios, pagos, decisiones económicas'),
('categoria_principal','Preferencias personales','Gustos, molestias, criterios de decisión, forma de trabajo'),

('subcategoria_trabajo','Calificaciones','IQ, OQ, PQ, URS, DQ, FAT, SAT'),
('subcategoria_trabajo','Calibraciones','Balanzas, HPLC, manómetros, sensores, instrumentos'),
('subcategoria_trabajo','Validaciones','Procesos, limpieza, despirogenado, autoclaves, sistemas'),
('subcategoria_trabajo','Control de Calidad','HPLC, pH, TOC, microbiología, instrumental analítico'),
('subcategoria_trabajo','Garantía de Calidad','PON, desvíos, CAPA, cambios, auditorías'),
('subcategoria_trabajo','Equipos','Datos técnicos, códigos, modelos, fallas de equipos'),
('subcategoria_trabajo','Normativa','ANMAT, GMP, ISO, USP, farmacopeas'),
('subcategoria_trabajo','Documentos','Protocolos, informes, plantillas, prompts'),
('subcategoria_trabajo','Problemas técnicos','Errores, diagnósticos, fallas, dudas técnicas'),
('subcategoria_trabajo','Automatizaciones laborales','Apps, buscadores, scripts y sistemas internos'),

('tipo_item','Nota','Registro general'),
('tipo_item','Evento','Algo que pasó o se hizo'),
('tipo_item','Problema','Falla o inconveniente'),
('tipo_item','Duda técnica','Pregunta o criterio pendiente'),
('tipo_item','Decisión','Decisión tomada o criterio elegido'),
('tipo_item','Compra','Producto comprado'),
('tipo_item','Producto deseado','Producto a evaluar o comprar'),
('tipo_item','Receta','Preparación de comida'),
('tipo_item','Resultado / experiencia','Resultado probado o experiencia personal'),
('tipo_item','Link guardado','Video, artículo, publicación o recurso'),
('tipo_item','Aprendizaje','Concepto aprendido o reforzado'),
('tipo_item','Preferencia','Gusto, rechazo o criterio estable'),
('tipo_item','Pendiente','Acción futura'),
('tipo_item','Documento','Archivo o documento'),
('tipo_item','Prompt','Prompt útil para IA'),
('tipo_item','Persona','Dato sobre persona'),
('tipo_item','Lugar','Dato sobre lugar')
on conflict (grupo, valor) do nothing;
