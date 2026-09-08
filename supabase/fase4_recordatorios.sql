-- Fase 4: recordatorios de vencimiento de calibración.
-- Ejecutar una sola vez en el SQL Editor del proyecto Supabase correcto
-- (talqttosnrttdswoskol) — NO en el proyecto viejo de "noticias".
--
-- Guarda para qué fecha de vencimiento ya se mandó el recordatorio
-- proactivo por Telegram, para no repetirlo todos los días mientras el
-- equipo siga vencido/por vencer. Se resetea a null automáticamente cuando
-- se confirma una nueva calibración (ver src/calibracionEventos.ts:
-- resolverConfirmacionCalibracion), así el próximo vencimiento vuelve a
-- poder recordarse.

alter table public.equipos_calibraciones
  add column if not exists recordatorio_enviado_para date;
