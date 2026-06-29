import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { Clasificacion, EntidadClasificada, ItemInsert, MemoriaSugerida } from './types.js';

export const supabase = createClient(
  config.supabaseUrl(),
  config.supabaseServiceRoleKey(),
  { auth: { persistSession: false } }
);

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
