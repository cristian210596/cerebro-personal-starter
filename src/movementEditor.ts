import { supabase } from './supabaseClient.js';
import { archiveNotionPage, syncNotionImportedMovements } from './notion.js';
import { upsertMasterEntity, upsertEntityAlias } from './entityBrain.js';

// Edición y borrado de movimientos YA cargados (tabla finanzas_movimientos).
// Antes solo se podía clasificar pendientes (classify_group / ignore_group); un movimiento
// ya impactado con categoría/monto/fecha/comercio mal quedaba fijo salvo corregirlo a mano
// en la base. Supabase es la fuente de verdad; Notion se sincroniza después y, si falla,
// no revierte el cambio (queda desfasado hasta el próximo sync).

export const MOVEMENT_TYPES = ['gasto', 'ingreso', 'devolucion', 'transferencia', 'ajuste'] as const;

export type MovementEditInput = {
  categoria?: string | null;
  subcategoria?: string | null;
  comercio?: string | null;
  // Nombre de la entidad (persona/comercio). Si se pasa, el comercio pasa a ser el nombre canónico.
  entidad?: string | null;
  // Solo con "entidad": aprende el texto crudo actual como alias de esa entidad.
  // Por defecto NO lo hace, para no contaminar el reconocimiento automático por un error.
  guardar_alias?: boolean;
  descripcion?: string | null;
  // Magnitud del monto. El signo se conserva del movimiento actual.
  monto?: number | string | null;
  fecha?: string | null;
  tipo?: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(id: unknown): string {
  const value = String(id || '').trim();
  if (!UUID_RE.test(value)) throw new Error('movimiento_id inválido: tiene que ser el id (uuid) que devuelve find_movements.');
  return value;
}

// Los filtros .or() de PostgREST se arman como texto: se sacan los caracteres que
// podrían cortar o inyectar condiciones.
export function sanitizeSearchTerm(raw: unknown): string {
  return String(raw ?? '').replace(/[,()%*\\"'`;:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function isValidIsoDate(value: unknown): boolean {
  const s = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const cleanText = (v: unknown) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim());

function summarize(row: any) {
  return {
    id: row.id,
    fecha: row.fecha_movimiento || null,
    tipo: row.tipo || null,
    monto: row.monto != null ? Number(row.monto) : null,
    moneda: row.moneda || 'ARS',
    comercio: row.comercio || null,
    categoria: row.categoria_financiera || null,
    subcategoria: row.subcategoria_financiera || null,
    descripcion: row.descripcion ? String(row.descripcion).slice(0, 140) : null
  };
}

// Función pura (sin base de datos): valida la entrada y arma qué columnas cambiar en
// finanzas_movimientos (patch) y qué reflejar en la fila importada vinculada (imported).
// Solo cuenta como cambio lo que realmente difiere del valor actual.
export function buildMovementPatch(current: any, input: MovementEditInput) {
  const patch: Record<string, any> = {};
  const imported: Record<string, any> = {};
  const cambios: string[] = [];

  const setField = (column: string, next: any, label: string, same: (a: any, b: any) => boolean = (a, b) => a === b) => {
    const prev = current[column] ?? null;
    if (same(prev, next)) return false;
    patch[column] = next;
    cambios.push(`${label}: ${prev ?? '(vacío)'} → ${next ?? '(vacío)'}`);
    return true;
  };

  if (input.categoria != null) {
    const categoria = cleanText(input.categoria);
    if (!categoria) throw new Error('categoria no puede estar vacía.');
    // Al cambiar la categoría, la subcategoría anterior deja de valer: se reemplaza por
    // la nueva o se limpia (evita pares incoherentes tipo "Mascotas / Kiosco").
    const subcategoria = cleanText(input.subcategoria) || null;
    const changedCat = setField('categoria_financiera', categoria, 'categoría');
    const changedSub = setField('subcategoria_financiera', subcategoria, 'subcategoría');
    if (changedCat || changedSub) {
      imported.categoria_confirmada = categoria;
      imported.subcategoria_confirmada = subcategoria;
    }
  } else if (input.subcategoria != null) {
    const subcategoria = cleanText(input.subcategoria);
    if (!subcategoria) throw new Error('subcategoria no puede estar vacía (para limpiarla, indicá también categoria).');
    if (setField('subcategoria_financiera', subcategoria, 'subcategoría')) imported.subcategoria_confirmada = subcategoria;
  }

  if (input.comercio != null) {
    const comercio = cleanText(input.comercio);
    if (!comercio) throw new Error('comercio no puede estar vacío.');
    if (setField('comercio', comercio, 'comercio')) imported.comercio_detectado = comercio;
  }

  if (input.descripcion != null) {
    const descripcion = cleanText(input.descripcion);
    if (!descripcion) throw new Error('descripcion no puede estar vacía.');
    setField('descripcion', descripcion, 'descripción');
  }

  if (input.fecha != null) {
    const fecha = String(input.fecha).trim();
    if (!isValidIsoDate(fecha)) throw new Error('fecha inválida: usar formato YYYY-MM-DD y una fecha real.');
    if (setField('fecha_movimiento', fecha, 'fecha')) imported.fecha_movimiento = fecha;
  }

  if (input.tipo != null) {
    const tipo = String(input.tipo).trim().toLowerCase();
    if (!(MOVEMENT_TYPES as readonly string[]).includes(tipo)) throw new Error(`tipo inválido. Valores aceptados: ${MOVEMENT_TYPES.join(', ')}.`);
    setField('tipo', tipo, 'tipo');
  }

  if (input.monto != null) {
    const magnitude = Math.abs(Number(input.monto));
    if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error('monto inválido: pasar un número distinto de cero (el signo se conserva del movimiento actual).');
    const currentMonto = Number(current.monto);
    if (!Number.isFinite(currentMonto) || currentMonto === 0) throw new Error('El movimiento actual tiene monto 0: no se puede inferir el signo. Borralo y cargalo de nuevo.');
    const monto = round2(Math.sign(currentMonto) * magnitude);
    if (setField('monto', monto, 'monto', (a, b) => Number(a) === Number(b))) imported.monto = monto;
  }

  if (!cambios.length) throw new Error('No hay nada que cambiar: los valores indicados ya son los actuales (o no se indicó ningún campo).');
  patch.updated_at = new Date().toISOString();
  return { patch, imported, cambios };
}

export async function findMovements(params: { query?: string; desde?: string; hasta?: string; monto?: number | string; categoria?: string; limit?: number }) {
  const term = sanitizeSearchTerm(params.query);
  const categoria = sanitizeSearchTerm(params.categoria);
  const hasMonto = params.monto != null && String(params.monto).trim() !== '';
  if (!term && !categoria && !hasMonto && !params.desde && !params.hasta) {
    throw new Error('Indicá al menos un filtro: query, monto, categoria, desde o hasta.');
  }
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);

  let q = supabase.from('finanzas_movimientos').select('*').order('fecha_movimiento', { ascending: false }).limit(limit);
  if (term) q = q.or(`comercio.ilike.%${term}%,descripcion.ilike.%${term}%`);
  if (categoria) q = q.ilike('categoria_financiera', `%${categoria}%`);
  if (params.desde) {
    if (!isValidIsoDate(params.desde)) throw new Error('desde inválido: usar YYYY-MM-DD.');
    q = q.gte('fecha_movimiento', params.desde);
  }
  if (params.hasta) {
    if (!isValidIsoDate(params.hasta)) throw new Error('hasta inválido: usar YYYY-MM-DD.');
    q = q.lte('fecha_movimiento', params.hasta);
  }
  if (hasMonto) {
    const m = Math.abs(Number(params.monto));
    if (!Number.isFinite(m) || m === 0) throw new Error('monto inválido.');
    // Coincide por magnitud (±1 peso), sea cual sea el signo con el que esté guardado.
    const lo = round2(m - 1);
    const hi = round2(m + 1);
    q = q.or(`and(monto.gte.${lo},monto.lte.${hi}),and(monto.gte.${-hi},monto.lte.${-lo})`);
  }

  const { data, error } = await q;
  if (error) throw error;
  return {
    total: (data || []).length,
    movimientos: (data || []).map((r: any) => ({
      ...summarize(r),
      origen: r.origen || null,
      estado: r.estado || null,
      vinculado_a_importado: Boolean(r.movimiento_importado_id),
      en_notion: Boolean(r.notion_page_id)
    }))
  };
}

async function loadMovement(id: string) {
  const { data, error } = await supabase.from('finanzas_movimientos').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No existe un movimiento con id ${id}. Obtené el id con find_movements.`);
  return data;
}

export async function updateMovement(movimientoId: string, input: MovementEditInput) {
  const id = assertUuid(movimientoId);
  const current = await loadMovement(id);

  const effective: MovementEditInput = { ...input };
  if (input.entidad != null && String(input.entidad).trim()) {
    const categoriaEntidad = cleanText(input.categoria) || current.categoria_financiera || null;
    const subcategoriaEntidad = input.categoria != null ? cleanText(input.subcategoria) : (cleanText(input.subcategoria) ?? current.subcategoria_financiera ?? null);
    const master = await upsertMasterEntity({ nombre: String(input.entidad).trim(), categoria: categoriaEntidad, subcategoria: subcategoriaEntidad });
    effective.comercio = master.nombre;
    if (input.guardar_alias) await upsertEntityAlias(master.id, current.comercio || current.descripcion || '', 'correccion_usuario');
  }

  const { patch, imported, cambios } = buildMovementPatch(current, effective);
  // Si cambia el comercio, se suelta el vínculo de entidad para que el sync lo resuelva
  // de nuevo con el comercio corregido (si no, Notion seguiría mostrando la entidad vieja).
  if (patch.comercio !== undefined) patch.entidad_id = null;

  const { data: updated, error: updateError } = await supabase.from('finanzas_movimientos').update(patch).eq('id', id).select().single();
  if (updateError) throw updateError;

  // Espejo en la fila importada vinculada, para que el próximo import/conciliación no
  // pise la corrección con el valor viejo del resumen.
  let importadasActualizadas = 0;
  const importedPatch: Record<string, any> = { ...imported };
  if (Object.keys(importedPatch).length) {
    importedPatch.updated_at = new Date().toISOString();
    const orFilter = `movimiento_id.eq.${id}${current.movimiento_importado_id && UUID_RE.test(String(current.movimiento_importado_id)) ? `,id.eq.${current.movimiento_importado_id}` : ''}`;
    const { data: imps, error: impError } = await supabase.from('finanzas_movimientos_importados').update(importedPatch).or(orFilter).select('id');
    if (impError) console.warn('No pude reflejar el cambio en la fila importada:', impError.message);
    else importadasActualizadas = (imps || []).length;
  }

  let notionSincronizado = false;
  try {
    const synced = await syncNotionImportedMovements([updated]);
    notionSincronizado = synced.movimientos > 0;
  } catch (error) {
    console.error('No pude sincronizar a Notion el movimiento corregido:', error);
  }

  return {
    ok: true,
    cambios,
    antes: summarize(current),
    despues: summarize(updated),
    filas_importadas_actualizadas: importadasActualizadas,
    notion_sincronizado: notionSincronizado,
    aviso: notionSincronizado ? null : 'El cambio quedó guardado en Supabase pero no se pudo sincronizar a Notion (token ausente o error); Notion puede mostrar el dato viejo hasta el próximo sync.'
  };
}

export async function deleteMovement(movimientoId: string, opts: { confirmar?: boolean; devolver_a_pendientes?: boolean } = {}) {
  const id = assertUuid(movimientoId);
  const current = await loadMovement(id);
  const countOf = async (table: string, column: string) => {
    const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true }).eq(column, id);
    if (error) throw error;
    return count || 0;
  };

  // Particiones de gasto compartido y deudas apuntan al movimiento. Borrarlo dejaría
  // datos huérfanos o rompería por FK, así que en esta versión se bloquea.
  const [particiones, deudas] = await Promise.all([countOf('finanzas_particiones', 'movimiento_id'), countOf('finanzas_deudas', 'movimiento_id')]);
  if (particiones + deudas > 0) {
    return {
      ok: false,
      bloqueado: true,
      movimiento: summarize(current),
      texto: `No lo borré: tiene ${particiones} partición(es) de gasto compartido y ${deudas} deuda(s) vinculadas. Resolvelas primero (o corregí el movimiento con update_movement en vez de borrarlo).`
    };
  }

  const orFilter = `movimiento_id.eq.${id}${current.movimiento_importado_id && UUID_RE.test(String(current.movimiento_importado_id)) ? `,id.eq.${current.movimiento_importado_id}` : ''}`;
  const [{ data: prevImported, error: e1 }, { data: prevComprobantes, error: e2 }, { data: prevSueldos, error: e3 }] = await Promise.all([
    supabase.from('finanzas_movimientos_importados').select('id, estado, movimiento_id, categoria_confirmada, subcategoria_confirmada, match_score, match_reason').or(orFilter),
    supabase.from('finanzas_comprobantes').select('id').eq('movimiento_financiero_id', id),
    supabase.from('sueldos_recibos').select('id').eq('movimiento_financiero_id', id)
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;

  const efectos = {
    filas_importadas: (prevImported || []).length,
    destino_filas_importadas: opts.devolver_a_pendientes ? 'vuelven a pendientes de clasificar' : 'quedan ignoradas (no cuentan como gasto)',
    comprobantes_que_se_desvinculan: (prevComprobantes || []).length,
    recibos_de_sueldo_que_se_desvinculan: (prevSueldos || []).length,
    pagina_notion_se_archiva: Boolean(current.notion_page_id)
  };

  if (!opts.confirmar) {
    return {
      ok: false,
      requiere_confirmacion: true,
      movimiento: summarize(current),
      efectos,
      texto: 'No borré nada todavía. Mostrale este movimiento y estos efectos al usuario y, si confirma, repetí la llamada con confirmar:true.'
    };
  }

  const now = new Date().toISOString();
  const importedIds = (prevImported || []).map((r: any) => r.id);
  const comprobanteIds = (prevComprobantes || []).map((r: any) => r.id);
  const sueldoIds = (prevSueldos || []).map((r: any) => r.id);

  const rollback = async () => {
    for (const r of prevImported || []) {
      await supabase.from('finanzas_movimientos_importados').update({
        estado: r.estado, movimiento_id: r.movimiento_id, categoria_confirmada: r.categoria_confirmada,
        subcategoria_confirmada: r.subcategoria_confirmada, match_score: r.match_score, match_reason: r.match_reason, updated_at: new Date().toISOString()
      }).eq('id', r.id);
    }
    if (comprobanteIds.length) await supabase.from('finanzas_comprobantes').update({ movimiento_financiero_id: id }).in('id', comprobanteIds);
    if (sueldoIds.length) await supabase.from('sueldos_recibos').update({ movimiento_financiero_id: id }).in('id', sueldoIds);
  };

  try {
    if (importedIds.length) {
      const importedPatch: Record<string, any> = opts.devolver_a_pendientes
        ? { estado: 'pendiente_revision', movimiento_id: null, categoria_confirmada: null, subcategoria_confirmada: null, match_score: null, match_reason: null, updated_at: now }
        : { estado: 'ignorado', movimiento_id: null, updated_at: now };
      const { error } = await supabase.from('finanzas_movimientos_importados').update(importedPatch).in('id', importedIds);
      if (error) throw error;
    }
    if (comprobanteIds.length) {
      const { error } = await supabase.from('finanzas_comprobantes').update({ movimiento_financiero_id: null }).in('id', comprobanteIds);
      if (error) throw error;
    }
    if (sueldoIds.length) {
      const { error } = await supabase.from('sueldos_recibos').update({ movimiento_financiero_id: null }).in('id', sueldoIds);
      if (error) throw error;
    }
    const { error: deleteError } = await supabase.from('finanzas_movimientos').delete().eq('id', id);
    if (deleteError) throw deleteError;
  } catch (error: any) {
    await rollback().catch(rollbackError => console.error('Falló el rollback del borrado de movimiento:', rollbackError));
    throw new Error(`No se pudo borrar el movimiento; se restauraron los vínculos. Detalle: ${error?.message || error}`);
  }

  // Recién con el movimiento borrado en Supabase se archiva la página de Notion.
  const notionArchivado = await archiveNotionPage(current.notion_page_id);
  return {
    ok: true,
    borrado: summarize(current),
    efectos,
    notion_archivado: notionArchivado,
    aviso: notionArchivado ? null : `El movimiento se borró de Supabase pero no pude archivar su página de Notion (${current.notion_page_id}); archivala a mano si sigue visible.`
  };
}
