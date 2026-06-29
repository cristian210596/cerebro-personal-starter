import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import type { Clasificacion, EntidadClasificada, ItemInsert } from './types.js';

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

  await upsertEntidadesAndLinks(data.id, item.entidades_json || []);
  await saveMemoriasSugeridas(data.id, item.classifier_json);

  return data;
}

async function upsertEntidadesAndLinks(itemId: string, entidades: EntidadClasificada[]) {
  for (const entidad of entidades) {
    if (!entidad.tipo || !entidad.nombre) continue;

    const { data: entidadData, error: entidadError } = await supabase
      .from('entidades')
      .upsert({ tipo: entidad.tipo, nombre: entidad.nombre }, { onConflict: 'tipo,nombre' })
      .select()
      .single();

    if (entidadError) throw entidadError;

    const { error: linkError } = await supabase
      .from('item_entidades')
      .upsert({ item_id: itemId, entidad_id: entidadData.id }, { onConflict: 'item_id,entidad_id' });

    if (linkError) throw linkError;
  }
}

async function saveMemoriasSugeridas(itemId: string, clasificacion: Clasificacion) {
  const memorias = clasificacion.memorias_sugeridas || [];
  for (const memoria of memorias) {
    if (!memoria.afirmacion) continue;

    const { error } = await supabase
      .from('memorias')
      .insert({
        afirmacion: memoria.afirmacion,
        categoria: memoria.categoria,
        confianza: memoria.confianza,
        vigente: true,
        origen_item_id: itemId
      });

    if (error) throw error;
  }
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
