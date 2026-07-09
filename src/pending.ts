import { supabase, saveItem } from './supabaseClient.js';
import type { ItemInsert } from './types.js';

export function looksLikePendingText(text: string) {
  const t = norm(text);
  if (!t) return false;
  if (t.startsWith('/')) return false;
  return (
    /^(tengo que|hay que|debo|necesito|recordarme|recordame|acordarme de|pendiente)/.test(t) ||
    /^(comprar|hacer|llamar|pagar|revisar|buscar|llevar|pedir|averiguar)/.test(t)
  );
}

export async function savePendingFromText(input: { chatId: number; messageId: number; userId?: number; text: string }) {
  const parsed = parsePending(input.text);
  const clasificacion = pendingToClassification(parsed, input.text);
  const itemInsert: ItemInsert = {
    fuente: 'telegram',
    telegram_user_id: input.userId ? String(input.userId) : undefined,
    telegram_chat_id: String(input.chatId),
    telegram_message_id: String(input.messageId),
    texto_original: input.text,
    titulo: clasificacion.titulo,
    resumen: clasificacion.resumen,
    categoria_principal: clasificacion.categoria_principal,
    subcategorias: clasificacion.subcategorias,
    tipo_item: clasificacion.tipo_item,
    estado: clasificacion.estado,
    valoracion: clasificacion.valoracion,
    importancia: clasificacion.importancia,
    accion_futura: clasificacion.accion_futura,
    tags: clasificacion.tags,
    entidades_json: clasificacion.entidades,
    classifier_json: clasificacion
  };

  const item = await saveItem(itemInsert);
  const { data: pendiente, error } = await supabase
    .from('pendientes')
    .insert({
      item_id: item.id,
      titulo: parsed.titulo,
      descripcion: parsed.descripcion,
      categoria: parsed.categoria,
      estado: 'abierto',
      prioridad: parsed.prioridad,
      fecha_vencimiento: parsed.fecha_vencimiento,
      tags: parsed.tags
    })
    .select()
    .single();
  if (error) throw error;
  return { ok: true as const, item, pendiente, clasificacion };
}

export async function listPendientes(query = '', limit = 20) {
  const { data, error } = await supabase
    .from('pendientes')
    .select('*')
    .neq('estado', 'hecho')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const q = norm(query);
  const rows = (data || []).filter((row: any) => {
    if (!q) return true;
    const haystack = norm([row.titulo, row.descripcion, row.categoria, row.estado, row.prioridad, ...(row.tags || [])].filter(Boolean).join(' '));
    return q.split(/\s+/).filter(Boolean).every(tok => haystack.includes(tok));
  });
  return rows.slice(0, limit);
}

export async function markPendingDone(query: string) {
  const q = norm(query);
  if (!q) return { ok: false as const, message: 'Usá: /hecho comprar detergente' };
  const rows = await listPendientes('', 100);
  const target = rows.find((p: any) => {
    const hay = norm([p.titulo, p.descripcion, ...(p.tags || [])].filter(Boolean).join(' '));
    return q.split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
  });
  if (!target) return { ok: false as const, message: `No encontré pendiente abierto para: ${query}` };
  const { data, error } = await supabase
    .from('pendientes')
    .update({ estado: 'hecho', updated_at: new Date().toISOString() })
    .eq('id', target.id)
    .select()
    .single();
  if (error) throw error;
  if (target.item_id) {
    await supabase.from('items').update({ estado: 'Hecho', updated_at: new Date().toISOString() }).eq('id', target.item_id);
  }
  return { ok: true as const, pendiente: data };
}

export async function deleteLastPending(confirm: boolean) {
  if (!confirm) return { ok: false as const, message: 'Para borrar el último pendiente usá: /borrar pendiente ultimo confirmar' };
  const { data: row, error } = await supabase.from('pendientes').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!row) return { ok: false as const, message: 'No encontré pendientes para borrar.' };
  await supabase.from('pendientes').delete().eq('id', row.id);
  if (row.item_id) await supabase.from('items').delete().eq('id', row.item_id);
  return { ok: true as const, message: `Pendiente borrado: ${row.titulo || row.descripcion || row.id}` };
}

export function formatPendingSaved(result: Awaited<ReturnType<typeof savePendingFromText>>) {
  return [
    'Pendiente guardado.',
    '',
    `Título: ${result.pendiente.titulo}`,
    `Categoría: ${result.pendiente.categoria || '-'}`,
    `Prioridad: ${result.pendiente.prioridad || '-'}`,
    result.pendiente.fecha_vencimiento ? `Vence: ${result.pendiente.fecha_vencimiento}` : '',
    `Tags: ${(result.pendiente.tags || []).join(', ') || '-'}`
  ].filter(Boolean).join('\n');
}

export function formatPendientes(rows: any[], title = 'Pendientes') {
  if (!rows.length) return `${title}\n\nSin pendientes abiertos.`;
  const lines = [title, ''];
  for (const p of rows) {
    lines.push(`• ${p.titulo || p.descripcion || '-'}`);
    lines.push(`  ${p.categoria || '-'} — ${p.prioridad || '-'} — ${p.estado || '-'}`);
    if (p.fecha_vencimiento) lines.push(`  Vence: ${p.fecha_vencimiento}`);
    if (p.tags?.length) lines.push(`  Tags: ${p.tags.slice(0, 6).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatPendingDone(result: Awaited<ReturnType<typeof markPendingDone>>) {
  if (!result.ok) return result.message;
  return `Pendiente marcado como hecho: ${result.pendiente.titulo || result.pendiente.descripcion || '-'}`;
}

function parsePending(text: string) {
  const t = clean(text);
  const titulo = titleFromText(t);
  const category = detectCategory(t);
  const priority = detectPriority(t);
  const due = detectDueDate(t);
  const tags = unique([category?.toLowerCase(), ...keywordTags(t)].filter(Boolean) as string[]);
  return {
    titulo,
    descripcion: t,
    categoria: category,
    prioridad: priority,
    fecha_vencimiento: due,
    tags
  };
}

function pendingToClassification(p: ReturnType<typeof parsePending>, original: string) {
  return {
    titulo: p.titulo,
    resumen: `Pendiente registrado: ${p.descripcion}`,
    categoria_principal: p.categoria || 'Pendientes',
    subcategorias: ['Pendientes'],
    tipo_item: 'Pendiente',
    estado: 'Pendiente',
    valoracion: null,
    importancia: p.prioridad === 'Alta' ? 'Alta' : 'Media',
    accion_futura: p.descripcion,
    tags: unique(['pendiente', ...(p.tags || [])]),
    entidades: [],
    memorias_sugeridas: []
  };
}

function titleFromText(text: string) {
  let s = text.replace(/^(tengo que|hay que|debo|necesito|recordarme|recordame|acordarme de|pendiente)\s+/i, '');
  s = s.replace(/^comprar\s+/i, 'Comprar ');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.slice(0, 120) || 'Pendiente';
}

function detectCategory(text: string) {
  const t = norm(text);
  if (t.includes('comprar') || t.includes('super') || t.includes('mercado') || t.includes('detergente')) return 'Compras';
  if (t.includes('pagar') || t.includes('visa') || t.includes('master') || t.includes('deuda')) return 'Finanzas personales';
  if (t.includes('trabajo') || t.includes('hplc') || t.includes('calibr')) return 'Trabajo';
  if (t.includes('estudiar') || t.includes('facu') || t.includes('examen')) return 'Estudio';
  if (t.includes('casa') || t.includes('limpiar') || t.includes('arreglar')) return 'Casa / vida diaria';
  return 'Pendientes';
}

function detectPriority(text: string) {
  const t = norm(text);
  if (t.includes('urgente') || t.includes('importante') || t.includes('hoy')) return 'Alta';
  if (t.includes('cuando pueda') || t.includes('algún día') || t.includes('algun dia')) return 'Baja';
  return 'Media';
}

function detectDueDate(text: string) {
  const t = norm(text);
  const now = new Date();
  if (t.includes('mañana') || t.includes('manana')) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return isoDate(d);
  }
  if (t.includes('hoy')) return isoDate(now);
  const m = text.match(/(?:para el|para|vence|vencimiento)\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(now.getFullYear());
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function keywordTags(text: string) {
  const t = norm(text);
  const tags: string[] = [];
  for (const [needle, tag] of [
    ['detergente', 'detergente'], ['dni', 'dni'], ['visa', 'visa'], ['master', 'mastercard'], ['mercado pago', 'mercado-pago'],
    ['hplc', 'hplc'], ['cafe', 'cafe'], ['super', 'supermercado'], ['panader', 'panaderia']
  ]) if (t.includes(needle)) tags.push(tag);
  return tags;
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function norm(value: unknown) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function clean(value: unknown) { return String(value || '').trim().replace(/\s+/g, ' '); }
function unique(arr: string[]) { return Array.from(new Set(arr.filter(Boolean))); }
