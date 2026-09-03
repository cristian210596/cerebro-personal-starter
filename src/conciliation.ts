import { supabase } from './supabaseClient.js';
import { normalizeEntityKey, resolveMasterEntity } from './entityBrain.js';

export async function listConciliationCandidates(limit = 15) {
  const [manual, imported, comprobantes] = await Promise.all([
    supabase.from('finanzas_movimientos').select('*').order('created_at', { ascending: false }).limit(200),
    supabase.from('finanzas_movimientos_importados').select('*').order('created_at', { ascending: false }).limit(200),
    supabase.from('finanzas_comprobantes').select('*').order('created_at', { ascending: false }).limit(100)
  ]);
  if (manual.error) throw manual.error;
  if (imported.error) throw imported.error;
  if (comprobantes.error) throw comprobantes.error;

  const candidates: any[] = [];
  const movs = manual.data || [];
  for (const imp of imported.data || []) {
    if (imp.movimiento_id) continue;
    const match = bestMovementMatch(imp, movs);
    if (match && match.score >= 0.72) candidates.push({ tipo: 'importado_vs_manual', score: match.score, origen: imp, destino: match.row, razon: match.reason });
  }
  for (const comp of comprobantes.data || []) {
    if (comp.movimiento_financiero_id) continue;
    const match = bestComprobanteMatch(comp, movs);
    if (match && match.score >= 0.68) candidates.push({ tipo: 'comprobante_vs_movimiento', score: match.score, origen: comp, destino: match.row, razon: match.reason });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function confirmConciliationByIndex(index: number) {
  const candidates = await listConciliationCandidates(50);
  const cand = candidates[index - 1];
  if (!cand) throw new Error('No encontré esa conciliación pendiente.');
  if (cand.tipo === 'importado_vs_manual') {
    await supabase.from('finanzas_movimientos_importados').update({ movimiento_id: cand.destino.id, estado: 'conciliado', updated_at: new Date().toISOString() }).eq('id', cand.origen.id);
    return cand;
  }
  if (cand.tipo === 'comprobante_vs_movimiento') {
    await supabase.from('finanzas_comprobantes').update({ movimiento_financiero_id: cand.destino.id, estado: 'conciliado', updated_at: new Date().toISOString() }).eq('id', cand.origen.id);
    return cand;
  }
  return cand;
}

export async function rejectConciliationByIndex(index: number) {
  const candidates = await listConciliationCandidates(50);
  const cand = candidates[index - 1];
  if (!cand) throw new Error('No encontré esa conciliación pendiente.');
  await supabase.from('conciliacion_rechazos').insert({ tipo: cand.tipo, origen_id: cand.origen.id, destino_id: cand.destino.id, score: cand.score });
  return cand;
}

export async function getFinancialSourcesForLastMovement() {
  const { data: mov, error } = await supabase.from('finanzas_movimientos').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!mov) return null;
  const [imps, comps] = await Promise.all([
    supabase.from('finanzas_movimientos_importados').select('*').eq('movimiento_id', mov.id),
    supabase.from('finanzas_comprobantes').select('*').eq('movimiento_financiero_id', mov.id)
  ]);
  return { movimiento: mov, importados: imps.data || [], comprobantes: comps.data || [] };
}

export async function buildInbox() {
  const [queue, comps, sueldos, imports, conc, productos] = await Promise.all([
    safeSelect('procesamiento_cola', 'id,tipo,estado,motivo,nombre_archivo,reintentar_desde', ['pendiente', 'reintentar', 'error']),
    safeSelect('finanzas_comprobantes', '*', ['pendiente_revision', 'pendiente_conciliacion']),
    safeSelect('sueldos_recibos', '*', ['pendiente_revision']),
    safeSelect('finanzas_movimientos_importados', '*', ['pendiente_revision']),
    listConciliationCandidates(8).catch(() => []),
    safeProductsWithoutCategory()
  ]);
  return { queue, comprobantes: comps, sueldos, importados: imports, conciliaciones: conc, productos };
}

async function safeSelect(table: string, columns: string, estados: string[]) {
  try {
    const { data, error } = await supabase.from(table).select(columns).in('estado', estados).order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    return data || [];
  } catch (_) { return []; }
}

async function safeProductsWithoutCategory() {
  try {
    const { data, error } = await supabase.from('finanzas_comprobante_items').select('*').or('categoria.is.null,categoria.eq.').order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    return data || [];
  } catch (_) { return []; }
}

function bestMovementMatch(source: any, movements: any[]) {
  let best: any = null;
  for (const m of movements) {
    const score = matchScore({ fecha: source.fecha, monto: source.monto, texto: source.descripcion_original || source.comercio }, { fecha: m.fecha || m.created_at, monto: m.monto, texto: `${m.descripcion || ''} ${m.comercio || ''} ${m.categoria || ''}` });
    if (!best || score.score > best.score) best = { row: m, ...score };
  }
  return best;
}

function bestComprobanteMatch(comp: any, movements: any[]) {
  let best: any = null;
  for (const m of movements) {
    const score = matchScore({ fecha: comp.fecha, monto: comp.total, texto: comp.comercio || comp.razon_social }, { fecha: m.fecha || m.created_at, monto: m.monto, texto: `${m.descripcion || ''} ${m.comercio || ''} ${m.categoria || ''}` });
    if (!best || score.score > best.score) best = { row: m, ...score };
  }
  return best;
}

function matchScore(a: any, b: any) {
  let score = 0;
  const reason: string[] = [];
  const amountA = Math.abs(Number(a.monto || 0));
  const amountB = Math.abs(Number(b.monto || 0));
  if (amountA && amountB) {
    const diff = Math.abs(amountA - amountB);
    const rel = diff / Math.max(amountA, amountB);
    if (rel < 0.005) { score += 0.5; reason.push('monto casi igual'); }
    else if (rel < 0.03) { score += 0.35; reason.push('monto parecido'); }
  }
  const da = dateKey(a.fecha); const db = dateKey(b.fecha);
  if (da && db) {
    const days = Math.abs((Date.parse(da) - Date.parse(db)) / 86400000);
    if (days <= 0.5) { score += 0.25; reason.push('misma fecha'); }
    else if (days <= 3) { score += 0.12; reason.push('fecha cercana'); }
  }
  const ta = normalizeEntityKey(a.texto || '');
  const tb = normalizeEntityKey(b.texto || '');
  if (ta && tb) {
    if (ta.includes(tb) || tb.includes(ta)) { score += 0.2; reason.push('texto compatible'); }
    else if (commonTokenScore(ta, tb) > 0.35) { score += 0.12; reason.push('tokens compatibles'); }
  }
  return { score: Math.min(1, score), reason: reason.join(', ') || 'similitud general' };
}

function commonTokenScore(a: string, b: string) {
  const as = new Set(a.split(' ').filter(t => t.length > 3));
  const bs = new Set(b.split(' ').filter(t => t.length > 3));
  if (!as.size || !bs.size) return 0;
  let c = 0; for (const t of as) if (bs.has(t)) c++;
  return c / Math.max(as.size, bs.size);
}
function dateKey(v: any) { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }

export function formatConciliationCandidates(cands: any[]) {
  if (!cands.length) return 'Conciliación financiera\n\nNo encontré candidatos claros.';
  const lines = ['Conciliación financiera pendiente', ''];
  cands.forEach((c, i) => {
    lines.push(`${i + 1}. ${Math.round(c.score * 100)}% — ${c.tipo}`);
    lines.push(`   Origen: ${describe(c.origen)}`);
    lines.push(`   Destino: ${describe(c.destino)}`);
    lines.push(`   Motivo: ${c.razon}`);
    lines.push(`   Confirmar: /conciliar ${i + 1} confirmar`);
    lines.push('');
  });
  return lines.join('\n');
}

export function formatConciliationDone(c: any) {
  return ['Conciliación aplicada.', '', `Tipo: ${c.tipo}`, `Origen: ${describe(c.origen)}`, `Destino: ${describe(c.destino)}`, `Score: ${Math.round(c.score * 100)}%`].join('\n');
}

export function formatSources(payload: any) {
  if (!payload) return 'No encontré movimientos financieros.';
  const lines = ['Fuentes del último gasto', '', describe(payload.movimiento), ''];
  lines.push(`Movimientos importados vinculados: ${payload.importados.length}`);
  for (const r of payload.importados.slice(0, 5)) lines.push(`- ${describe(r)}`);
  lines.push(`Comprobantes vinculados: ${payload.comprobantes.length}`);
  for (const r of payload.comprobantes.slice(0, 5)) lines.push(`- ${describe(r)}`);
  return lines.join('\n');
}

export function formatInbox(inbox: any) {
  const lines = ['Bandeja del cerebro', ''];
  lines.push(`Cola IA/archivos: ${inbox.queue.length}`);
  for (const r of inbox.queue.slice(0, 5)) lines.push(`- ${r.tipo} ${r.estado}: ${r.nombre_archivo || r.motivo || r.id}`);
  lines.push('');
  lines.push(`Comprobantes pendientes: ${inbox.comprobantes.length}`);
  for (const r of inbox.comprobantes.slice(0, 5)) lines.push(`- ${r.comercio || r.razon_social || 'Comprobante'} $${r.total || '-'} ${r.fecha || ''}`);
  lines.push('');
  lines.push(`Sueldos pendientes: ${inbox.sueldos.length}`);
  for (const r of inbox.sueldos.slice(0, 5)) lines.push(`- ${r.periodo || '-'} ${r.empresa || ''} neto ${r.total_neto || '-'}`);
  lines.push('');
  lines.push(`Movimientos importados por revisar: ${inbox.importados.length}`);
  for (const r of inbox.importados.slice(0, 5)) lines.push(`- ${r.descripcion_original || r.comercio || '-'} $${r.monto || '-'} ${r.fecha || ''}`);
  lines.push('');
  lines.push(`Conciliaciones sugeridas: ${inbox.conciliaciones.length}`);
  for (const c of inbox.conciliaciones.slice(0, 3)) lines.push(`- ${Math.round(c.score * 100)}% ${describe(c.origen)} ↔ ${describe(c.destino)}`);
  lines.push('');
  lines.push(`Productos sin categoría: ${inbox.productos.length}`);
  for (const p of inbox.productos.slice(0, 5)) lines.push(`- ${p.descripcion || '-'} $${p.importe || p.precio_unitario || '-'}`);
  lines.push('', 'Acciones útiles:', '/cola procesar', '/conciliacion pendientes', '/comprobante items ultimo');
  return lines.join('\n');
}

function describe(r: any) {
  if (!r) return '-';
  const name = r.descripcion || r.descripcion_original || r.comercio || r.razon_social || r.titulo || r.nombre_archivo || r.id;
  const amount = r.monto ?? r.total ?? r.importe;
  const date = r.fecha || String(r.created_at || '').slice(0, 10);
  return `${date ? `${date} — ` : ''}${name}${amount != null ? ` — $${amount}` : ''}`.slice(0, 220);
}
