import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { Clasificacion, EntidadClasificada, ItemInsert, MemoriaSugerida } from './types.js';

export const supabase = createClient(
  config.supabaseUrl(),
  config.supabaseServiceRoleKey(),
  { auth: { persistSession: false } }
);

export async function saveItem(item: ItemInsert) {
  const { data, error } = await supabase
    .from('items')
    .insert(item)
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
  await replaceEntidadesAndLinks(item.id, item.entidades_json || []);
  await saveMemoriasSugeridas(item.id, item.classifier_json || {});
}

export async function replaceEntidadesAndLinks(itemId: string, entidades: EntidadClasificada[]) {
  const { error: deleteError } = await supabase
    .from('item_entidades')
    .delete()
    .eq('item_id', itemId);

  if (deleteError) throw deleteError;

  await upsertEntidadesAndLinks(itemId, entidades);
}

export async function upsertEntidadesAndLinks(itemId: string, entidades: EntidadClasificada[]) {
  const cleanEntidades = uniqueEntidades(entidades);

  for (const entidad of cleanEntidades) {
    const { data: entidadData, error: entidadError } = await supabase
      .from('entidades')
      .upsert(
        {
          tipo: entidad.tipo,
          nombre: entidad.nombre
        },
        { onConflict: 'tipo,nombre' }
      )
      .select()
      .single();

    if (entidadError) throw entidadError;

    const { error: linkError } = await supabase
      .from('item_entidades')
      .upsert(
        { item_id: itemId, entidad_id: entidadData.id },
        { onConflict: 'item_id,entidad_id' }
      );

    if (linkError) throw linkError;
  }
}

export async function saveMemoriasSugeridas(itemId: string, clasificacion: Clasificacion | any) {
  const memorias = uniqueMemorias(clasificacion?.memorias_sugeridas || []);

  for (const memoria of memorias) {
    const afirmacion = cleanText(memoria.afirmacion);
    if (!afirmacion) continue;

    const { data: existing, error: findError } = await supabase
      .from('memorias')
      .select('id')
      .eq('afirmacion', afirmacion)
      .maybeSingle();

    if (findError) throw findError;

    if (existing?.id) {
      const { error: updateError } = await supabase
        .from('memorias')
        .update({
          categoria: cleanText(memoria.categoria) || null,
          confianza: cleanText(memoria.confianza) || 'Media',
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
  return data || [];
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

export async function rebuildDerivedData(limit = 30) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 50));
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
    const tipo = cleanText(entidad.tipo);
    const nombre = cleanText(entidad.nombre);
    if (!tipo || !nombre) continue;

    const key = `${tipo.toLowerCase()}::${nombre.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tipo, nombre });
  }

  return out;
}

function uniqueMemorias(memorias: MemoriaSugerida[]) {
  const seen = new Set<string>();
  const out: MemoriaSugerida[] = [];

  for (const memoria of memorias || []) {
    const afirmacion = cleanText(memoria.afirmacion);
    if (!afirmacion) continue;
    const key = afirmacion.toLowerCase();
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
