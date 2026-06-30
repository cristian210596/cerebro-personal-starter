import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { Clasificacion, EntidadClasificada, ItemInsert, MemoriaSugerida } from './types.js';
import { embedText, cosineSimilarity, simpleHash } from './embeddings.js';


export const supabase = createClient(
  config.supabaseUrl(),
  config.supabaseServiceRoleKey(),
  { auth: { persistSession: false } }
);


export async function getAppConfigValue(key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) throw error;
  return data?.value || null;
}

export async function setAppConfigValue(key: string, value: string) {
  const { error } = await supabase
    .from('app_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (error) throw error;
}

export async function getAppConfigMap(keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const { data, error } = await supabase
    .from('app_config')
    .select('key,value')
    .in('key', keys);

  if (error) throw error;
  const out: Record<string, string> = {};
  for (const row of data || []) out[row.key] = row.value;
  return out;
}

type EntidadRow = {
  id: string;
  tipo: string | null;
  nombre: string | null;
  alias?: string[] | null;
  descripcion?: string | null;
  categoria_relacionada?: string | null;
  created_at?: string;
};

export async function saveItem(item: ItemInsert) {
  const normalizedEntidades = uniqueEntidades(item.entidades_json || []);
  const normalizedClassifier = {
    ...(item.classifier_json || {}),
    entidades: normalizedEntidades
  };

  const { data, error } = await supabase
    .from('items')
    .insert({
      ...item,
      entidades_json: normalizedEntidades,
      classifier_json: normalizedClassifier
    })
    .select()
    .single();

  if (error) throw error;

  try {
    await syncItemDerivedData(data);
  } catch (derivedError) {
    console.error('No se pudo alimentar entidades/memorias:', derivedError);
  }

  return data;
}

export async function syncItemDerivedData(item: any) {
  const normalizedEntidades = uniqueEntidades(item.entidades_json || []);

  if (JSON.stringify(normalizedEntidades) !== JSON.stringify(item.entidades_json || [])) {
    await supabase
      .from('items')
      .update({
        entidades_json: normalizedEntidades,
        classifier_json: {
          ...(item.classifier_json || {}),
          entidades: normalizedEntidades
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id);
  }

  await replaceEntidadesAndLinks(item.id, normalizedEntidades, item.categoria_principal);
  await saveMemoriasSugeridas(item.id, item.classifier_json || {});
}

export async function replaceEntidadesAndLinks(itemId: string, entidades: EntidadClasificada[], categoriaRelacionada?: string | null) {
  const { error: deleteError } = await supabase
    .from('item_entidades')
    .delete()
    .eq('item_id', itemId);

  if (deleteError) throw deleteError;

  await upsertEntidadesAndLinks(itemId, entidades, categoriaRelacionada);
}

export async function upsertEntidadesAndLinks(itemId: string, entidades: EntidadClasificada[], categoriaRelacionada?: string | null) {
  const cleanEntidades = uniqueEntidades(entidades);

  for (const entidad of cleanEntidades) {
    const entidadData = await findOrCreateEntidad(entidad, categoriaRelacionada);

    const { error: linkError } = await supabase
      .from('item_entidades')
      .upsert(
        { item_id: itemId, entidad_id: entidadData.id },
        { onConflict: 'item_id,entidad_id' }
      );

    if (linkError) throw linkError;
  }
}

async function findOrCreateEntidad(entidad: EntidadClasificada, categoriaRelacionada?: string | null): Promise<EntidadRow> {
  const normalized = normalizeEntidad(entidad);
  const existing = await findExistingEntidad(normalized.tipo, normalized.nombre);

  if (existing) {
    const alias = mergeAlias(existing.alias || [], normalized.originalNombre, normalized.nombre);
    const patch: Record<string, any> = {};

    if (aliasChanged(existing.alias || [], alias)) patch.alias = alias;
    if (!existing.categoria_relacionada && categoriaRelacionada) patch.categoria_relacionada = categoriaRelacionada;

    if (Object.keys(patch).length) {
      const { data, error } = await supabase
        .from('entidades')
        .update(patch)
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    }

    return existing;
  }

  const { data, error } = await supabase
    .from('entidades')
    .insert({
      tipo: normalized.tipo,
      nombre: normalized.nombre,
      alias: uniqueStrings([normalized.originalNombre].filter(Boolean) as string[]),
      categoria_relacionada: categoriaRelacionada || null
    })
    .select()
    .single();

  if (error) {
    // En carrera/concurrencia, puede haberse creado entre el find y el insert.
    const retry = await findExistingEntidad(normalized.tipo, normalized.nombre);
    if (retry) return retry;
    throw error;
  }

  return data;
}

async function findExistingEntidad(tipo: string, nombre: string): Promise<EntidadRow | null> {
  const tipoNorm = normalizeLoose(tipo);
  const nombreKey = entityKey(nombre);

  const { data, error } = await supabase
    .from('entidades')
    .select('*')
    .eq('tipo', tipo)
    .limit(500);

  if (error) throw error;

  for (const row of (data || []) as EntidadRow[]) {
    if (normalizeLoose(row.tipo || '') !== tipoNorm) continue;
    if (entityKey(row.nombre || '') === nombreKey) return row;
    for (const alias of row.alias || []) {
      if (entityKey(alias) === nombreKey) return row;
    }
  }

  return null;
}

export async function saveMemoriasSugeridas(itemId: string, clasificacion: Clasificacion | any) {
  const memorias = uniqueMemorias(clasificacion?.memorias_sugeridas || []);

  for (const memoria of memorias) {
    const afirmacion = cleanText(memoria.afirmacion);
    if (!afirmacion) continue;

    const existing = await findExistingMemoria(afirmacion);

    if (existing?.id) {
      const { error: updateError } = await supabase
        .from('memorias')
        .update({
          categoria: cleanText(memoria.categoria) || existing.categoria || null,
          confianza: cleanText(memoria.confianza) || existing.confianza || 'Media',
          vigente: true,
          ultima_confirmacion: new Date().toISOString().slice(0, 10)
        })
        .eq('id', existing.id);

      if (updateError) throw updateError;
      continue;
    }

    const { error } = await supabase
      .from('memorias')
      .insert({
        afirmacion,
        categoria: cleanText(memoria.categoria) || null,
        confianza: cleanText(memoria.confianza) || 'Media',
        vigente: true,
        origen_item_id: itemId,
        ultima_confirmacion: new Date().toISOString().slice(0, 10)
      });

    if (error) throw error;
  }
}

async function findExistingMemoria(afirmacion: string) {
  const target = memoryKey(afirmacion);
  const { data, error } = await supabase
    .from('memorias')
    .select('*')
    .eq('vigente', true)
    .limit(500);

  if (error) throw error;
  return (data || []).find((m: any) => memoryKey(m.afirmacion) === target) || null;
}


export async function saveArchivo(row: {
  item_id?: string | null;
  tipo_archivo?: string | null;
  nombre_archivo?: string | null;
  mime_type?: string | null;
  storage_url?: string | null;
  transcripcion?: string | null;
  descripcion_ia?: string | null;
}) {
  const { data, error } = await supabase
    .from('archivos')
    .insert({
      item_id: row.item_id || null,
      tipo_archivo: row.tipo_archivo || null,
      nombre_archivo: row.nombre_archivo || null,
      mime_type: row.mime_type || null,
      storage_url: row.storage_url || null,
      transcripcion: row.transcripcion || null,
      descripcion_ia: row.descripcion_ia || null
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function latestItemForChat(chatId: string) {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function updateItemFields(itemId: string, fields: Record<string, any>) {
  const allowed = [
    'titulo',
    'resumen',
    'categoria_principal',
    'subcategorias',
    'tipo_item',
    'estado',
    'valoracion',
    'importancia',
    'accion_futura',
    'tags',
    'entidades_json',
    'classifier_json'
  ];

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) patch[key] = fields[key];
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'entidades_json')) {
    patch.entidades_json = uniqueEntidades(patch.entidades_json || []);
    patch.classifier_json = {
      ...(patch.classifier_json || fields.classifier_json || {}),
      entidades: patch.entidades_json
    };
  }

  const { data, error } = await supabase
    .from('items')
    .update(patch)
    .eq('id', itemId)
    .select()
    .single();

  if (error) throw error;

  try {
    await syncItemDerivedData(data);
  } catch (derivedError) {
    console.error('No se pudo actualizar entidades/memorias:', derivedError);
  }

  return data;
}

export async function searchItems(query: string, limit = 10) {
  const safe = query.replaceAll('%', '').replaceAll(',', ' ');
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .or(`titulo.ilike.%${safe}%,resumen.ilike.%${safe}%,texto_original.ilike.%${safe}%`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function latestItems(limit = 10) {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function pendingItems(limit = 10) {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .or('estado.ilike.%pend%,accion_futura.not.is.null')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function latestMemorias(limit = 10) {
  const { data, error } = await supabase
    .from('memorias')
    .select('*')
    .eq('vigente', true)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function searchMemorias(query: string, limit = 10) {
  const safe = query.replaceAll('%', '').replaceAll(',', ' ');
  const { data, error } = await supabase
    .from('memorias')
    .select('*')
    .eq('vigente', true)
    .or(`afirmacion.ilike.%${safe}%,categoria.ilike.%${safe}%`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function latestEntidades(limit = 20) {
  const { data, error } = await supabase
    .from('entidades')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function searchEntidades(query: string, limit = 20) {
  const safe = query.replaceAll('%', '').replaceAll(',', ' ');
  const { data, error } = await supabase
    .from('entidades')
    .select('*')
    .or(`nombre.ilike.%${safe}%,tipo.ilike.%${safe}%,descripcion.ilike.%${safe}%`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const qKey = entityKey(query);
  const rows = data || [];
  const aliasMatches = rows.filter((row: any) => (row.alias || []).some((a: string) => entityKey(a).includes(qKey)));
  return uniqueRowsById([...rows, ...aliasMatches]).slice(0, limit);
}

export async function itemsByEntity(query: string, limit = 10) {
  const entidades = await searchEntidades(query, 10);
  if (!entidades.length) return [];

  const entidadIds = entidades.map(e => e.id);
  const { data: links, error: linkError } = await supabase
    .from('item_entidades')
    .select('item_id')
    .in('entidad_id', entidadIds)
    .limit(100);

  if (linkError) throw linkError;

  const itemIds = [...new Set((links || []).map(l => l.item_id))].slice(0, limit);
  if (!itemIds.length) return [];

  const { data, error } = await supabase
    .from('items')
    .select('*')
    .in('id', itemIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function rebuildDerivedData(limit = 5) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 5));
  const items = await latestItems(safeLimit);

  let processedItems = 0;
  let entityMentions = 0;
  let memoryMentions = 0;

  for (const item of items) {
    await syncItemDerivedData(item);
    processedItems += 1;
    entityMentions += Array.isArray(item.entidades_json) ? item.entidades_json.length : 0;
    memoryMentions += Array.isArray(item.classifier_json?.memorias_sugeridas)
      ? item.classifier_json.memorias_sugeridas.length
      : 0;
  }

  return { processedItems, entityMentions, memoryMentions, items };
}

export async function normalizeEntidadesDatabase(limit = 500) {
  const { data, error } = await supabase
    .from('entidades')
    .select('*')
    .limit(Math.max(1, Math.min(Number(limit) || 500, 1000)));

  if (error) throw error;

  const rows = (data || []) as EntidadRow[];
  const groups = new Map<string, EntidadRow[]>();

  for (const row of rows) {
    const normalized = normalizeEntidad({ tipo: row.tipo || '', nombre: row.nombre || '' });
    const key = `${normalizeLoose(normalized.tipo)}::${entityKey(normalized.nombre)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  let groupsMerged = 0;
  let rowsMerged = 0;
  let aliasesAdded = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const canonical = chooseCanonicalEntidad(group);
    const duplicates = group.filter(row => row.id !== canonical.id);
    const alias = uniqueStrings([
      ...(canonical.alias || []),
      ...duplicates.flatMap(row => [row.nombre || '', ...(row.alias || [])])
    ]).filter(a => entityKey(a) !== entityKey(canonical.nombre || ''));

    const { error: updateAliasError } = await supabase
      .from('entidades')
      .update({ alias })
      .eq('id', canonical.id);

    if (updateAliasError) throw updateAliasError;
    aliasesAdded += alias.length;

    for (const duplicate of duplicates) {
      const { data: duplicateLinks, error: linksError } = await supabase
        .from('item_entidades')
        .select('item_id')
        .eq('entidad_id', duplicate.id);

      if (linksError) throw linksError;

      for (const link of duplicateLinks || []) {
        await supabase
          .from('item_entidades')
          .upsert(
            { item_id: link.item_id, entidad_id: canonical.id },
            { onConflict: 'item_id,entidad_id' }
          );
      }

      const { error: deleteLinksError } = await supabase
        .from('item_entidades')
        .delete()
        .eq('entidad_id', duplicate.id);

      if (deleteLinksError) throw deleteLinksError;

      const { error: deleteError } = await supabase
        .from('entidades')
        .delete()
        .eq('id', duplicate.id);

      if (deleteError) throw deleteError;
      rowsMerged += 1;
    }

    groupsMerged += 1;
  }

  return { scanned: rows.length, groupsMerged, rowsMerged, aliasesAdded };
}

export async function mergeEntidades(sourceQuery: string, targetQuery: string) {
  const source = await findBestEntidad(sourceQuery);
  const target = await findBestEntidad(targetQuery);

  if (!source) throw new Error(`No encontré entidad origen: ${sourceQuery}`);
  if (!target) throw new Error(`No encontré entidad destino: ${targetQuery}`);
  if (source.id === target.id) return { source, target, movedLinks: 0, merged: false };

  const { data: links, error: linksError } = await supabase
    .from('item_entidades')
    .select('item_id')
    .eq('entidad_id', source.id);

  if (linksError) throw linksError;

  let movedLinks = 0;
  for (const link of links || []) {
    const { error: upsertError } = await supabase
      .from('item_entidades')
      .upsert(
        { item_id: link.item_id, entidad_id: target.id },
        { onConflict: 'item_id,entidad_id' }
      );
    if (upsertError) throw upsertError;
    movedLinks += 1;
  }

  const alias = uniqueStrings([...(target.alias || []), source.nombre || '', ...(source.alias || [])])
    .filter(a => entityKey(a) !== entityKey(target.nombre || ''));

  const { error: updateError } = await supabase
    .from('entidades')
    .update({ alias })
    .eq('id', target.id);

  if (updateError) throw updateError;

  const { error: deleteLinksError } = await supabase
    .from('item_entidades')
    .delete()
    .eq('entidad_id', source.id);

  if (deleteLinksError) throw deleteLinksError;

  const { error: deleteError } = await supabase
    .from('entidades')
    .delete()
    .eq('id', source.id);

  if (deleteError) throw deleteError;

  return { source, target: { ...target, alias }, movedLinks, merged: true };
}

async function findBestEntidad(query: string): Promise<EntidadRow | null> {
  const rows = await searchEntidades(query, 20) as EntidadRow[];
  const q = entityKey(query);
  return rows.find(row => entityKey(row.nombre || '') === q)
    || rows.find(row => (row.alias || []).some(alias => entityKey(alias) === q))
    || rows[0]
    || null;
}


export type SmartSearchResult = {
  item: any;
  score: number;
  mode: 'exacto' | 'semantico' | 'mixto';
  reason: string;
};

export async function smartSearchItems(query: string, limit = 8) {
  const q = cleanText(query);
  if (!q) return { results: [] as SmartSearchResult[], semanticUsed: false, semanticError: null as string | null, indexedNow: 0 };

  const candidates = await loadSearchCandidates(350);
  let indexedNow = 0;

  // Indexa pocos items por búsqueda. Evita timeouts/cuota, pero mejora solo con el uso.
  for (const item of candidates) {
    if (indexedNow >= 4) break;
    if (!hasCurrentEmbedding(item)) {
      try {
        await ensureItemSearchEmbedding(item);
        indexedNow += 1;
      } catch (error) {
        // No cortamos la búsqueda si Gemini/cuota falla.
        break;
      }
    }
  }

  const exact = scoreExactCandidates(q, candidates);
  let semanticUsed = false;
  let semanticError: string | null = null;
  let semantic: SmartSearchResult[] = [];

  try {
    const queryEmbedding = await embedText(buildQueryEmbeddingText(q));
    if (queryEmbedding.length) {
      semanticUsed = true;
      semantic = candidates
        .map(item => {
          const embedding = getStoredEmbedding(item);
          const score = embedding.length ? cosineSimilarity(queryEmbedding, embedding) : 0;
          return {
            item,
            score,
            mode: 'semantico' as const,
            reason: `similitud ${(score * 100).toFixed(0)}%`
          };
        })
        .filter(r => r.score >= 0.58)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit * 2);
    }
  } catch (error: any) {
    semanticError = String(error?.message || error || 'error semántico');
  }

  const merged = mergeSearchResults(exact, semantic)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { results: merged, semanticUsed, semanticError, indexedNow };
}

export async function indexSearchEmbeddings(limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
  const items = await latestItems(safeLimit);
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
    if (hasCurrentEmbedding(item)) {
      skipped += 1;
      continue;
    }
    try {
      await ensureItemSearchEmbedding(item);
      indexed += 1;
    } catch {
      failed += 1;
      break;
    }
  }

  return { indexed, skipped, failed, checked: items.length };
}

async function loadSearchCandidates(limit = 350) {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

function scoreExactCandidates(query: string, items: any[]): SmartSearchResult[] {
  const queryTokens = tokenizeSearch(query);
  if (!queryTokens.length) return [];

  return items
    .map(item => {
      const text = buildItemSearchText(item);
      const textNorm = normalizeLoose(text);
      let score = 0;
      const hits: string[] = [];

      for (const token of queryTokens) {
        if (textNorm.includes(token)) {
          score += 2;
          hits.push(token);
        }
      }

      const qNorm = normalizeLoose(query);
      if (qNorm.length >= 4 && textNorm.includes(qNorm)) score += 5;

      if (Array.isArray(item.tags)) {
        const tagText = normalizeLoose(item.tags.join(' '));
        for (const token of queryTokens) {
          if (tagText.includes(token)) score += 2;
        }
      }

      if (item.categoria_principal && queryTokens.some(t => normalizeLoose(item.categoria_principal).includes(t))) score += 2;
      if (item.estado && queryTokens.some(t => normalizeLoose(item.estado).includes(t))) score += 1.5;
      if (item.valoracion && queryTokens.some(t => normalizeLoose(item.valoracion).includes(t))) score += 1.5;

      const finalScore = Math.min(0.92, score / Math.max(6, queryTokens.length * 3));
      return {
        item,
        score: finalScore,
        mode: 'exacto' as const,
        reason: hits.length ? `coincide: ${hits.slice(0, 5).join(', ')}` : 'coincidencia exacta'
      };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
}

function mergeSearchResults(exact: SmartSearchResult[], semantic: SmartSearchResult[]) {
  const byId = new Map<string, SmartSearchResult>();

  for (const r of [...exact, ...semantic]) {
    const id = r.item?.id;
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, r);
      continue;
    }

    byId.set(id, {
      item: r.item,
      score: Math.max(prev.score, r.score) + 0.05,
      mode: prev.mode === r.mode ? r.mode : 'mixto',
      reason: prev.mode === r.mode ? prev.reason : `${prev.reason}; ${r.reason}`
    });
  }

  return [...byId.values()];
}

async function ensureItemSearchEmbedding(item: any) {
  const text = buildItemEmbeddingText(item);
  const hash = simpleHash(text);
  const existing = item.classifier_json?.search_embedding;

  if (existing?.hash === hash && Array.isArray(existing?.values) && existing.values.length) return item;

  const values = await embedText(text);
  if (!values.length) return item;

  const classifier = {
    ...(item.classifier_json || {}),
    search_embedding: {
      model: config.geminiEmbeddingModel(),
      hash,
      values,
      updated_at: new Date().toISOString()
    }
  };

  const { data, error } = await supabase
    .from('items')
    .update({ classifier_json: classifier, updated_at: new Date().toISOString() })
    .eq('id', item.id)
    .select()
    .single();

  if (error) throw error;
  item.classifier_json = data.classifier_json;
  return data;
}

function hasCurrentEmbedding(item: any) {
  const text = buildItemEmbeddingText(item);
  const emb = item.classifier_json?.search_embedding;
  return Boolean(emb?.hash === simpleHash(text) && Array.isArray(emb?.values) && emb.values.length);
}

function getStoredEmbedding(item: any): number[] {
  const values = item.classifier_json?.search_embedding?.values;
  return Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
}

function buildQueryEmbeddingText(query: string) {
  return `Consulta de búsqueda del cerebro personal: ${query}`;
}

function buildItemEmbeddingText(item: any) {
  return [
    item.titulo ? `Título: ${item.titulo}` : '',
    item.resumen ? `Resumen: ${item.resumen}` : '',
    item.categoria_principal ? `Categoría: ${item.categoria_principal}` : '',
    Array.isArray(item.subcategorias) && item.subcategorias.length ? `Subcategorías: ${item.subcategorias.join(', ')}` : '',
    item.tipo_item ? `Tipo: ${item.tipo_item}` : '',
    item.estado ? `Estado: ${item.estado}` : '',
    item.valoracion ? `Valoración: ${item.valoracion}` : '',
    item.importancia ? `Importancia: ${item.importancia}` : '',
    item.accion_futura ? `Acción futura: ${item.accion_futura}` : '',
    Array.isArray(item.tags) && item.tags.length ? `Tags: ${item.tags.join(', ')}` : '',
    Array.isArray(item.entidades_json) && item.entidades_json.length
      ? `Entidades: ${item.entidades_json.map((e: any) => `${e.tipo}: ${e.nombre}`).join('; ')}`
      : '',
    item.texto_original ? `Texto original: ${String(item.texto_original).slice(0, 2500)}` : ''
  ].filter(Boolean).join('\n');
}

function buildItemSearchText(item: any) {
  return [
    buildItemEmbeddingText(item),
    JSON.stringify(item.classifier_json?.memorias_sugeridas || [])
  ].filter(Boolean).join('\n');
}

function tokenizeSearch(value: string) {
  const stop = new Set(['que', 'como', 'para', 'con', 'una', 'uno', 'unos', 'unas', 'los', 'las', 'del', 'por', 'mis', 'tus', 'sus', 'algo', 'cosas', 'cosa']);
  return normalizeLoose(value)
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !stop.has(t));
}


export async function statsCerebro() {
  const [itemsCount, entidadesCount, memoriasCount] = await Promise.all([
    countTable('items'),
    countTable('entidades'),
    countTable('memorias', { vigente: true })
  ]);

  return { itemsCount, entidadesCount, memoriasCount };
}

async function countTable(table: string, equals?: Record<string, any>) {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (equals) {
    for (const [key, value] of Object.entries(equals)) query = query.eq(key, value);
  }
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

function uniqueEntidades(entidades: EntidadClasificada[]) {
  const seen = new Set<string>();
  const out: EntidadClasificada[] = [];

  for (const entidad of entidades || []) {
    const normalized = normalizeEntidad(entidad);
    if (!normalized.tipo || !normalized.nombre) continue;

    const key = `${normalizeLoose(normalized.tipo)}::${entityKey(normalized.nombre)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tipo: normalized.tipo, nombre: normalized.nombre });
  }

  return out;
}

function normalizeEntidad(entidad: EntidadClasificada) {
  const tipo = normalizeTipo(cleanText(entidad.tipo));
  const originalNombre = cleanText(entidad.nombre);
  const nombre = normalizeEntityDisplayName(originalNombre, tipo);
  return { tipo, nombre, originalNombre };
}

function normalizeTipo(tipo: string) {
  const t = normalizeLoose(tipo);
  if (t.includes('ingrediente')) return 'Ingrediente';
  if (t.includes('producto')) return 'Producto';
  if (t.includes('equipo')) return 'Equipo';
  if (t.includes('marca')) return 'Marca';
  if (t.includes('modelo')) return 'Modelo';
  if (t.includes('componente')) return 'Componente';
  if (t.includes('persona')) return 'Persona';
  if (t.includes('materia')) return 'Materia';
  if (t.includes('norma')) return 'Norma';
  if (t.includes('lugar')) return 'Lugar';
  if (t.includes('herramienta') || t.includes('app')) return 'Herramienta';
  return toTitleCase(tipo || 'Entidad');
}

function normalizeEntityDisplayName(nombre: string, tipo: string) {
  const clean = cleanText(nombre)
    .replace(/["“”]/g, '')
    .replace(/\s+[-–—]\s+/g, ' - ');

  if (!clean) return '';

  const knownUpper = new Set(['hplc', 'lc', 'pda', 'd2', 'toc', 'ph', 'wfi', 'pw', 'gmp', 'iso', 'anmat', 'usp', 'iq', 'oq', 'pq', 'dq', 'fat', 'sat']);
  const words = clean.split(' ').map(word => {
    const bare = removeAccents(word).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (knownUpper.has(bare)) return word.toUpperCase();
    if (/^[A-Z0-9-]{2,}$/.test(word)) return word;
    if (tipo === 'Ingrediente' || tipo === 'Producto') {
      // Evita duplicados por mayúscula/minúscula sin forzar productos propios a minúscula.
      if (word.length <= 3) return word.toLowerCase();
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    }
    return word[0]?.toUpperCase() + word.slice(1);
  });

  return words.join(' ').trim();
}

function entityKey(value: string) {
  return normalizeLoose(value)
    .replace(/\b(el|la|los|las|un|una|unos|unas|de|del|para|con|y|a)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function memoryKey(value: string) {
  return normalizeLoose(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLoose(value: string) {
  return removeAccents(String(value || '').toLowerCase().trim());
}

function removeAccents(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function toTitleCase(value: string) {
  return cleanText(value).replace(/\w\S*/g, part => part[0].toUpperCase() + part.slice(1).toLowerCase());
}

function chooseCanonicalEntidad(rows: EntidadRow[]) {
  return [...rows].sort((a, b) => {
    const aAliases = (a.alias || []).length;
    const bAliases = (b.alias || []).length;
    if (bAliases !== aAliases) return bAliases - aAliases;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  })[0];
}

function mergeAlias(current: string[], ...values: Array<string | null | undefined>) {
  return uniqueStrings([...current, ...values.filter(Boolean) as string[]])
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 50);
}

function aliasChanged(a: string[], b: string[]) {
  return JSON.stringify(uniqueStrings(a)) !== JSON.stringify(uniqueStrings(b));
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values || []) {
    const clean = cleanText(value);
    if (!clean) continue;
    const key = entityKey(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function uniqueRowsById(rows: any[]) {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const row of rows) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function uniqueMemorias(memorias: MemoriaSugerida[]) {
  const seen = new Set<string>();
  const out: MemoriaSugerida[] = [];

  for (const memoria of memorias || []) {
    const afirmacion = cleanText(memoria.afirmacion);
    if (!afirmacion) continue;
    const key = memoryKey(afirmacion);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      afirmacion,
      categoria: cleanText(memoria.categoria) || 'General',
      confianza: cleanText(memoria.confianza) || 'Media'
    });
  }

  return out;
}

function cleanText(value: unknown) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}
