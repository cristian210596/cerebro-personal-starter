# PLAN INTEGRACIÓN GUARDADOS IG → CEREBRO — V00 (2026-10-07)

Estado: Paso 0 (G1) hecho. NO se implementó nada. Esperando OK de Cristian sobre las decisiones D1–D4.

## 1. Inspección del repo (evidencia)
- Stack: TypeScript/Node (ESM), deploy en Vercel (funciones serverless, maxDuration 60 s en api/mcp.ts), Supabase Postgres como fuente de verdad, Notion como vista, LLM Gemini/Cerebras.
- Herramientas: array AGENT_TOOLS + switch runAgentAction en src/agentActions.ts. Se exponen por api/mcp.ts (conector MCP de claude.ai, ?key=AGENT_ACTION_SECRET) y api/agentAction.ts (REST). Agregar una tool = entrada en AGENT_TOOLS + case en el switch.
- "Fuentes": no hay registro de fuentes. "fuente" es solo una columna text en items (default 'telegram').
- Embeddings: src/embeddings.ts (Gemini text-embedding-004). Se guardan en items.classifier_json.search_embedding (jsonb) y el coseno se calcula en JS sobre 350 candidatos (smartSearchItems, src/supabaseClient.ts). schema.sql crea la extensión vector pero no se usa una columna vector.
- Tests: no hay suite. Solo scripts tsx (test:classify, test:movements). No hay script de typecheck.
- Config: src/config.ts con funciones por variable de entorno.

## 2. Verificación de guardados_V00.db (abierta con mode=ro&immutable=1)
Esquema: COINCIDE con la sección 2 (items 22 columnas, lugares, items_fts external content con unicode61 remove_diacritics 2, meta).
Datos: items 1180 (1180 codigos distintos, 0 vacíos); tiene_transcripcion=1 896; barrios 156; direcciones 183; reel 897, post 186, carrusel 89, igtv 8; 23 carpetas.
Diferencias a tener en cuenta:
- meta.transcripciones = 1032 ≠ 896. Las 1032 son registros estado=ok del jsonl; 124 tienen texto vacío (quedan 908). Las 12 restantes hasta 896 no las expliqué. T1 va a usar los conteos de items, no los de meta.
- items con ocr_texto no vacío: 1023 (meta.ocr_videos 1035 y ocr_imagenes 433 cuentan archivos, no items).
- construir_base_V00.py arma la base en un temporal y después la COPIA encima del archivo final con shutil.copyfile. No es atómico: mientras copia, un lector puede ver un archivo a medio escribir.
Prueba previa sobre la base: T2 encuentra los 3 títulos esperados (+11 más), T3 encuentra CPIK (Caballito, Av La Plata 693), T4 'cafe' = 'café' = 48.

## 3. Hallazgo bloqueante para la opción A
Cerebro corre en Vercel. Desde ahí no hay acceso a C:\Users\crist\... La opción A solo serviría para un servidor MCP local nuevo, no para el Cerebro actual.

## 4. Estrategia elegida: B (sincronización a Supabase)
- Script local `npm run sync:guardados` (lo corre Cristian en la PC después de regenerar la base): copia la base a un temporal, comprueba que esté estable (tamaño/mtime) y pasa quick_check, compara meta.items con count(*) y reintenta 3 veces con espera si algo falla.
- Upsert por codigo con hash_contenido por fila: solo escribe lo que cambió. Los codigos que ya no están se marcan activo=false (no se borran).
- Tabla en Supabase public.guardados_ig con tsvector generado (unaccent + config 'spanish_unaccent'), índice GIN, trigram para barrio. Tabla guardados_ig_sync (última corrida, hash del archivo, conteos).
- Búsqueda en SQL desde Vercel (función RPC): websearch_to_tsquery (acepta OR y "frases"), ts_rank, ts_headline para el fragmento, y fuente_coincidencia calculada por campo (titulo/caption/ocr/audio).
- Sin llamadas a Gemini en estas tools (R6): solo SQL; Claude redacta.
- No sincroniza a Notion (es otra fuente, no movimientos ni items).

## 5. Decisiones que necesito de Cristian
D1. R3 pide FTS5. Con B la búsqueda corre en Postgres FTS (equivalente: MATCH→@@, rank→ts_rank, snippet→ts_headline). ¿OK?
D2. R5 (embeddings) choca con la restricción "no mandar el contenido completo de la base a una API externa": indexar 1180 items con Gemini manda todo el contenido a Google. Propuesta: G4 = NO por ahora; compensar con un mapa de sinónimos/jerga determinístico (birra→birras|vindas|piras, airfryer→"air fryer"|"freidora de aire").
D3. T5 (las rutas existen en disco) y T6 (base renombrada) solo se pueden comprobar en la PC: los valida el script de sync/test local. En Vercel obtener_guardado devuelve la ruta absoluta armada con GUARDADOS_BASE_DIR, sin comprobarla.
D4. T8: no existe suite. Propuesta: agregar script typecheck (tsc --noEmit) y tests con node:test para el módulo nuevo; regresión = typecheck + test:movements + test:classify.

## 6. Archivos (a crear/modificar)
Crear:
- supabase/guardados_ig_V00.sql — unaccent, pg_trgm, config de texto, tablas, índices, funciones RPC buscar/lugares/resumen.
- src/guardados/config.ts — GUARDADOS_DB_PATH, GUARDADOS_BASE_DIR, BARRIOS_CERCA_DE_CASA (default: Parque Chacabuco, Caballito, Boedo, Flores, Almagro, Parque Patricios).
- src/guardados/sqliteReader.ts — lectura solo lectura con copia temporal + reintentos (node:sqlite, viene con Node 22.5+; SUPUESTO: la PC tiene Node ≥ 22.5, a verificar).
- src/guardados/sync.ts — diff por hash + upsert + soft delete.
- src/guardados/tools.ts — buscar_guardados, obtener_guardado, lugares_guardados, resumen_guardados, con validación de parámetros y saneo de la consulta (comillas, guiones, @).
- src/guardados/synonyms.ts — expansión de jerga (si D2 = sí).
- src/scripts/syncGuardados.ts y src/scripts/testGuardados.ts (T1–T7).
- docs/GUARDADOS_IG.md — README de la fuente.
Modificar:
- src/agentActions.ts — 4 entradas en AGENT_TOOLS + 4 case (descripciones = cuándo usarlas, citar título+link+campo, precios históricos).
- package.json — scripts sync:guardados, test:guardados, typecheck.
- env.example — variables nuevas.
SQL aparte: supabase/guardados_ig_V00.sql (se ejecuta una vez en el SQL Editor).
No se toca: guardados_V00.db, .jsonl, .txt, multimedia, construir_base_V00.py.

## 7. Backlog
G1 hecho. G2 G3 G5 G6 pendientes (esperando D1–D4). G4 propuesto descartar (D2).
