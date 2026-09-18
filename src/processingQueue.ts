import { supabase } from './supabaseClient.js';
import { createSignedFileUrl, parseStorageRef } from './storage.js';
import { importComprobanteFromFile } from './comprobantes.js';
import { importSalaryReceiptFromFile } from './salary.js';
import { importFinanceFile } from './financeImport.js';

export type QueueKind = 'comprobante' | 'sueldo' | 'finanzas' | 'media' | 'otro';

export async function enqueueProcessingTask(input: {
  kind: QueueKind;
  chatId: number | string;
  archivoId?: string | null;
  storageRef?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  reason?: string | null;
  runAfterMinutes?: number;
  payload?: any;
}) {
  const storageHash = input.storageRef ? simpleHash(input.storageRef) : null;
  const { data: existing, error: findError } = await supabase
    .from('procesamiento_cola')
    .select('*')
    .eq('estado', 'pendiente')
    .eq('storage_hash', storageHash || '__none__')
    .maybeSingle();
  if (findError && !String(findError.message || '').includes('invalid input')) {
    // ignore nullable hash mismatch errors from legacy installs
  }
  if (existing) return { queued: false, task: existing, duplicate: true };

  const retryAt = new Date(Date.now() + (input.runAfterMinutes ?? 10) * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('procesamiento_cola')
    .insert({
      tipo: input.kind,
      estado: 'pendiente',
      motivo: input.reason || 'pendiente_procesamiento',
      chat_id: String(input.chatId),
      archivo_id: input.archivoId || null,
      storage_ref: input.storageRef || null,
      storage_hash: storageHash,
      nombre_archivo: input.fileName || null,
      mime_type: input.mimeType || null,
      caption: input.caption || null,
      payload: input.payload || {},
      reintentar_desde: retryAt
    })
    .select()
    .single();
  if (error) throw error;
  return { queued: true, task: data, duplicate: false };
}

export async function listQueue(filter = '', limit = 20) {
  const f = norm(filter);
  let query = supabase.from('procesamiento_cola').select('*').order('created_at', { ascending: false }).limit(100);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).filter((r: any) => {
    if (!f) return true;
    return norm(`${r.tipo} ${r.estado} ${r.motivo} ${r.nombre_archivo} ${r.caption}`).includes(f);
  }).slice(0, limit);
}

export async function processQueue(limit = 5, force = false) {
  const now = new Date().toISOString();
  let q = supabase
    .from('procesamiento_cola')
    .select('*')
    .in('estado', ['pendiente', 'reintentar'])
    .order('reintentar_desde', { ascending: true })
    .limit(Math.max(1, Math.min(limit, 10)));
  if (!force) q = q.lte('reintentar_desde', now);
  const { data, error } = await q;
  if (error) throw error;

  const results = [] as any[];
  for (const task of data || []) {
    results.push(await processOneTask(task));
  }
  return results;
}

export async function cleanupQueueCompleted() {
  const { error, count } = await supabase
    .from('procesamiento_cola')
    .delete({ count: 'exact' })
    .eq('estado', 'completado');
  if (error) throw error;
  return count || 0;
}

export async function retryLastQueued() {
  const { data, error } = await supabase.from('procesamiento_cola').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { error: upd } = await supabase.from('procesamiento_cola').update({ estado: 'pendiente', reintentar_desde: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', data.id);
  if (upd) throw upd;
  return data;
}

async function processOneTask(task: any) {
  await supabase.from('procesamiento_cola').update({ estado: 'procesando', intentos: (task.intentos || 0) + 1, updated_at: new Date().toISOString() }).eq('id', task.id);
  try {
    if (!task.storage_ref) throw new Error('La tarea no tiene storage_ref.' );
    const buffer = await downloadStorageRef(task.storage_ref);
    let result: any = null;
    if (task.tipo === 'comprobante') {
      result = await importComprobanteFromFile({
        buffer,
        fileName: task.nombre_archivo,
        mimeType: task.mime_type,
        caption: task.caption || '',
        chatId: Number(task.chat_id || 0),
        archivoId: task.archivo_id || null,
        force: true
      });
    } else if (task.tipo === 'sueldo') {
      result = await importSalaryReceiptFromFile({
        buffer,
        fileName: task.nombre_archivo,
        mimeType: task.mime_type,
        caption: task.caption || '',
        chatId: Number(task.chat_id || 0),
        archivoId: task.archivo_id || null,
        force: true
      });
    } else if (task.tipo === 'finanzas') {
      result = await importFinanceFile({
        buffer,
        fileName: task.nombre_archivo,
        mimeType: task.mime_type,
        caption: task.caption || '',
        chatId: Number(task.chat_id || 0),
        archivoId: task.archivo_id || null
      });
    } else if (task.tipo === 'media' || task.tipo === 'otro') {
      // Documento/foto de tipo desconocido: primero intentamos sueldo, después comprobante.
      // Esto evita que un recibo de haberes quede trabado como ticket/factura cuando Gemini está sin cuota.
      const salary = await importSalaryReceiptFromFile({
        buffer,
        fileName: task.nombre_archivo,
        mimeType: task.mime_type,
        caption: task.caption || '',
        chatId: Number(task.chat_id || 0),
        archivoId: task.archivo_id || null,
        force: false
      });
      if (salary?.recognized) {
        result = { ...salary, routed_as: 'sueldo' };
      } else {
        const comprobante = await importComprobanteFromFile({
          buffer,
          fileName: task.nombre_archivo,
          mimeType: task.mime_type,
          caption: task.caption || '',
          chatId: Number(task.chat_id || 0),
          archivoId: task.archivo_id || null,
          force: false
        });
        result = comprobante?.recognized ? { ...comprobante, routed_as: 'comprobante' } : { recognized: false, reason: 'No pude clasificar el archivo como sueldo ni comprobante.' };
      }
    } else {
      throw new Error(`Tipo de cola no soportado: ${task.tipo}`);
    }

    const recognized = Boolean(result?.recognized);
    await supabase.from('procesamiento_cola').update({
      estado: recognized ? 'completado' : 'error',
      ultimo_error: recognized ? null : (result?.reason || 'No reconocido'),
      resultado: result || {},
      updated_at: new Date().toISOString(),
      procesado_en: new Date().toISOString()
    }).eq('id', task.id);
    return { ok: recognized, task, result };
  } catch (error: any) {
    const msg = String(error?.message || error);
    const quota = /quota|rate limit|429|gemini sin cuota|resource_exhausted|no respondió a tiempo/i.test(msg);
    await supabase.from('procesamiento_cola').update({
      estado: quota ? 'reintentar' : 'error',
      motivo: quota ? 'gemini_cuota' : 'error',
      ultimo_error: msg.slice(0, 1000),
      reintentar_desde: new Date(Date.now() + (quota ? 10 : 60) * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', task.id);
    return { ok: false, task, error: msg, retry: quota };
  }
}

async function downloadStorageRef(storageRef: string) {
  const parsed = parseStorageRef(storageRef);
  if (!parsed) throw new Error('storage_ref inválido.');
  const { data, error } = await supabase.storage.from(parsed.bucket).download(parsed.path);
  if (error) throw error;
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function formatQueue(rows: any[]) {
  if (!rows.length) return 'Cola de procesamiento\n\nSin pendientes.';
  const lines = ['Cola de procesamiento', ''];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.tipo} — ${r.estado}`);
    lines.push(`   Archivo: ${r.nombre_archivo || '-'}`);
    lines.push(`   Motivo: ${r.motivo || '-'}`);
    lines.push(`   Intentos: ${r.intentos || 0}`);
    if (r.reintentar_desde) lines.push(`   Reintentar desde: ${r.reintentar_desde}`);
    if (r.ultimo_error) lines.push(`   Error: ${String(r.ultimo_error).slice(0, 180)}`);
    lines.push('');
  });
  return lines.join('\n');
}

export function formatQueueProcessResults(results: any[]) {
  if (!results.length) return 'No había tareas listas para procesar.';
  const ok = results.filter(r => r.ok).length;
  const retry = results.filter(r => r.retry).length;
  const err = results.length - ok - retry;
  const lines = ['Procesamiento de cola', '', `Procesadas: ${results.length}`, `Completadas: ${ok}`, `Reintento por cuota: ${retry}`, `Errores: ${err}`, ''];
  for (const r of results.slice(0, 8)) {
    lines.push(`• ${r.task?.tipo || '-'} ${r.task?.nombre_archivo || ''}: ${r.ok ? 'OK' : r.retry ? 'reintentar' : 'error'}`);
    if (r.error) lines.push(`  ${String(r.error).slice(0, 180)}`);
  }
  return lines.join('\n');
}

export async function queueStats() {
  const { data, error } = await supabase.from('procesamiento_cola').select('estado,tipo');
  if (error) throw error;
  const stats: Record<string, number> = {};
  for (const r of data || []) stats[r.estado] = (stats[r.estado] || 0) + 1;
  return stats;
}

function norm(s: string) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function simpleHash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0; return String(h); }
