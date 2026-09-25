import { supabase, updateItemFields } from './supabaseClient.js';

export function looksLikeLastSavedQuestion(text: string) {
  const t = norm(text);
  return /^(que|qué) (guardaste|guardaste\?|se guardo|se guardó|quedo guardado|quedó guardado)/.test(t) ||
    t.includes('que guardaste ultimo') || t.includes('que guardaste último') ||
    t.includes('que quedo guardado ultimo') || t.includes('que quedó guardado último');
}

export function looksLikeUniversalCorrection(text: string) {
  const t = norm(text);
  return t.startsWith('corregir ultimo') || t.startsWith('corregir último') || t.startsWith('/corregir') || t.startsWith('/editar');
}

export async function getLastSavedSnapshot(chatId?: string) {
  const [items, archivos, pendientes, movimientos, deudas, memorias, sueldos, comprobantes] = await Promise.all([
    queryLatest('items', chatId ? { telegram_chat_id: chatId } : undefined),
    queryLatest('archivos'),
    queryLatest('pendientes'),
    queryLatest('finanzas_movimientos'),
    queryLatest('finanzas_deudas'),
    queryLatest('memorias'),
    queryLatest('sueldos_recibos'),
    queryLatest('finanzas_comprobantes')
  ]);

  const candidates = [
    items ? { kind: 'item', created_at: items.created_at, row: items } : null,
    archivos ? { kind: 'archivo', created_at: archivos.created_at, row: archivos } : null,
    pendientes ? { kind: 'pendiente', created_at: pendientes.created_at, row: pendientes } : null,
    movimientos ? { kind: 'movimiento financiero', created_at: movimientos.created_at, row: movimientos } : null,
    deudas ? { kind: 'deuda', created_at: deudas.created_at, row: deudas } : null,
    memorias ? { kind: 'memoria', created_at: memorias.created_at, row: memorias } : null,
    sueldos ? { kind: 'recibo de sueldo', created_at: sueldos.created_at, row: sueldos } : null,
    comprobantes ? { kind: 'comprobante/ticket', created_at: comprobantes.created_at, row: comprobantes } : null
  ].filter(Boolean) as Array<{ kind: string; created_at: string; row: any }>;

  candidates.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { latest: candidates[0] || null, candidates };
}

async function queryLatest(table: string, filters?: Record<string, string>) {
  let q = supabase.from(table).select('*').order('created_at', { ascending: false }).limit(1);
  if (filters) {
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  }
  const { data, error } = await q.maybeSingle();
  if (error) return null;
  return data || null;
}

export function formatLastSaved(snapshot: Awaited<ReturnType<typeof getLastSavedSnapshot>>) {
  if (!snapshot.latest) return 'Último guardado\n\nNo encontré registros todavía.';
  const { kind, row } = snapshot.latest;
  const lines = ['Último guardado', '', `Tipo: ${kind}`];

  if (kind === 'item') {
    lines.push(`Título: ${row.titulo || '-'}`);
    lines.push(`Dónde: Supabase/items${row.notion_page_id ? ' + Notion/Items' : ''}`);
    lines.push(`Categoría: ${row.categoria_principal || '-'}`);
    lines.push(`Estado: ${row.estado || '-'}`);
    if (row.resumen) lines.push(`Resumen: ${String(row.resumen).slice(0, 500)}`);
    if (row.tags?.length) lines.push(`Tags: ${row.tags.join(', ')}`);
  } else if (kind === 'archivo') {
    lines.push(`Nombre: ${row.nombre_archivo || '-'}`);
    lines.push('Dónde: Supabase/archivos + Supabase Storage privado');
    lines.push(`Tipo: ${row.tipo_archivo || '-'}`);
  } else if (kind === 'pendiente') {
    lines.push(`Título: ${row.titulo || '-'}`);
    lines.push('Dónde: Supabase/pendientes + item asociado');
    lines.push(`Estado: ${row.estado || '-'}`);
    lines.push(`Prioridad: ${row.prioridad || '-'}`);
    if (row.fecha_vencimiento) lines.push(`Vence: ${row.fecha_vencimiento}`);
  } else if (kind === 'movimiento financiero') {
    lines.push(`Descripción: ${row.descripcion || row.comercio || '-'}`);
    lines.push('Dónde: Supabase/finanzas_movimientos');
    lines.push(`Monto: ${money(row.monto)}`);
    lines.push(`Categoría: ${row.categoria_financiera || '-'}`);
    lines.push(`Medio: ${row.medio_pago || '-'}`);
  } else if (kind === 'deuda') {
    lines.push(`Persona: ${row.persona || '-'}`);
    lines.push('Dónde: Supabase/finanzas_deudas');
    lines.push(`Saldo: ${money(row.saldo_pendiente)}`);
    lines.push(`Estado: ${row.estado || '-'}`);
  } else if (kind === 'memoria') {
    lines.push(`Memoria: ${row.afirmacion || '-'}`);
    lines.push('Dónde: Supabase/memorias');
    lines.push(`Categoría: ${row.categoria || '-'}`);
    lines.push(`Vigente: ${row.vigente ? 'sí' : 'no'}`);
  } else if (kind === 'recibo de sueldo') {
    lines.push(`Empresa: ${row.empresa || '-'}`);
    lines.push('Dónde: Supabase/sueldos_recibos + finanzas_movimientos');
    lines.push(`Período: ${row.periodo || '-'}`);
    lines.push(`Neto: ${money(row.total_neto)}`);
  } else if (kind === 'comprobante/ticket') {
    lines.push(`Comercio: ${row.comercio || '-'}`);
    lines.push('Dónde: Supabase/finanzas_comprobantes + finanzas_comprobante_items');
    lines.push(`Fecha: ${row.fecha_emision || '-'}`);
    lines.push(`Total: ${money(row.total)}`);
    lines.push(`Estado: ${row.estado || '-'}`);
  }

  lines.push('', 'Últimos registros por área:');
  for (const c of snapshot.candidates.slice(0, 6)) {
    lines.push(`- ${c.kind}: ${shortLabel(c.row)}`);
  }
  return lines.join('\n');
}

function shortLabel(row: any) {
  return String(row.titulo || row.descripcion || row.nombre_archivo || row.afirmacion || row.comercio || row.persona || row.id || '-').slice(0, 80);
}

// Palabras que suelen colarse en una pregunta en lenguaje natural pero no
// tienen nada que ver con lo que se busca de verdad (ej: "qué sabés sobre el
// MAIL de..." — la palabra "mail" no aparece en el contenido real guardado).
// Antes, exigir que TODAS las palabras de la pregunta aparezcan en el texto
// guardado hacía que una sola de estas bastara para tirar "Sin resultados"
// aunque las palabras que sí importaban (ej "control", "cambios") estuvieran.
const SEARCH_STOPWORDS = new Set('que qué quien quién cual cuál sabes sabés sabe contame decime dime avisame che dale sobre acerca el la los las un una unos unas de del al en con por para y o u mail correo email tema cosa algo es fue son eso esto eso'.split(' '));

function tokenizeSearchQuery(query: string): string[] {
  const cleaned = norm(query).replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const all = cleaned.split(/\s+/).filter(Boolean);
  const filtered = all.filter(t => !SEARCH_STOPWORDS.has(t));
  // Si la pregunta era pura palabra de relleno (raro), mejor usar todo antes
  // que buscar con una lista vacía (que matchearía cualquier fila).
  return filtered.length ? filtered : all;
}

export async function unifiedSearch(query: string) {
  const tokens = tokenizeSearchQuery(query);
  const [items, archivos, pendientes, movimientos, deudas, presupuestos, memorias, sueldos, comprobantes, comprobanteItems] = await Promise.all([
    load('items', 80),
    load('archivos', 80, '*, items(titulo,categoria_principal,resumen,tags)'),
    load('pendientes', 80),
    load('finanzas_movimientos', 120),
    load('finanzas_deudas', 80),
    load('finanzas_presupuestos', 80),
    load('memorias', 80),
    load('sueldos_recibos', 80),
    load('finanzas_comprobantes', 80),
    load('finanzas_comprobante_items', 120)
  ]);

  return {
    query,
    items: filterRows(items, tokens, r => [r.titulo, r.resumen, r.texto_original, r.categoria_principal, r.tipo_item, r.estado, ...(r.tags || [])]).slice(0, 5),
    archivos: filterRows(archivos, tokens, r => [r.nombre_archivo, r.tipo_archivo, r.mime_type, r.transcripcion, r.descripcion_ia, r.items?.titulo, r.items?.resumen, ...(r.items?.tags || [])]).slice(0, 4),
    pendientes: filterRows(pendientes, tokens, r => [r.titulo, r.descripcion, r.categoria, r.estado, r.prioridad, ...(r.tags || [])]).slice(0, 5),
    movimientos: filterRows(movimientos, tokens, r => [r.descripcion, r.comercio, r.categoria_financiera, r.subcategoria_financiera, r.medio_pago, r.tarjeta, r.tipo, r.estado, r.fecha_movimiento]).slice(0, 5),
    deudas: filterRows(deudas, tokens, r => [r.persona, r.concepto, r.tipo, r.estado]).slice(0, 5),
    presupuestos: filterRows(presupuestos, tokens, r => [r.categoria_financiera, r.periodo, r.frecuencia, r.notas]).slice(0, 5),
    memorias: filterRows(memorias, tokens, r => [r.afirmacion, r.categoria, r.confianza]).slice(0, 5),
    sueldos: filterRows(sueldos, tokens, r => [r.empresa, r.empleado, r.periodo, r.estado, r.fecha_pago]).slice(0, 5),
    comprobantes: filterRows(comprobantes, tokens, r => [r.comercio, r.razon_social, r.numero_comprobante, r.fecha_emision, r.medio_pago, r.tarjeta, r.estado]).slice(0, 5),
    comprobanteItems: filterRows(comprobanteItems, tokens, r => [r.descripcion, r.descripcion_normalizada, r.marca, r.categoria, r.subcategoria]).slice(0, 8)
  };
}

async function load(table: string, limit: number, select = '*') {
  const { data, error } = await supabase.from(table).select(select).order('created_at', { ascending: false }).limit(limit);
  if (error) return [];
  return data || [];
}

function filterRows(rows: any[], tokens: string[], fields: (row: any) => any[]) {
  if (!tokens.length) return rows;
  return rows.filter(row => {
    const haystack = norm(fields(row).filter(Boolean).flat().join(' '));
    return tokens.every(token => haystack.includes(token));
  });
}

export function formatUnifiedSearch(result: Awaited<ReturnType<typeof unifiedSearch>>) {
  const lines = [`Búsqueda unificada: ${result.query}`, ''];
  addSection(lines, 'Items', result.items, r => [`• ${r.titulo || '-'}`, `  ${r.categoria_principal || '-'} / ${r.tipo_item || '-'}`, r.resumen ? `  ${String(r.resumen).slice(0, 180)}` : ''].filter(Boolean));
  addSection(lines, 'Pendientes', result.pendientes, r => [`• ${r.titulo || '-'}`, `  ${r.estado || '-'} / ${r.prioridad || '-'}${r.fecha_vencimiento ? ` / vence ${r.fecha_vencimiento}` : ''}`]);
  addSection(lines, 'Finanzas', result.movimientos, r => [`• ${r.fecha_movimiento || '-'} — ${money(r.monto)} — ${r.comercio || r.descripcion || '-'}`, `  ${r.categoria_financiera || '-'} / ${r.medio_pago || '-'}`]);
  addSection(lines, 'Deudas', result.deudas, r => [`• ${r.persona || '-'} — ${money(r.saldo_pendiente)}`, `  ${r.concepto || '-'} / ${r.estado || '-'}`]);
  addSection(lines, 'Archivos', result.archivos, r => [`• ${r.nombre_archivo || '-'}`, `  ${r.tipo_archivo || '-'}${r.items?.titulo ? ` / ${r.items.titulo}` : ''}`]);
  addSection(lines, 'Presupuestos', result.presupuestos, r => [`• ${r.categoria_financiera || '-'} — ${money(r.monto_presupuestado)}`, `  ${r.periodo || '-'} / ${r.frecuencia || '-'}`]);
  addSection(lines, 'Memorias', result.memorias, r => [`• ${r.afirmacion || '-'}`, `  ${r.categoria || '-'} / ${r.confianza || '-'}`]);
  addSection(lines, 'Sueldos', result.sueldos, r => [`• ${r.periodo || '-'} — ${r.empresa || '-'} — ${money(r.total_neto)}`, `  Bruto ${money(r.total_bruto)} / ${r.estado || '-'}`]);
  addSection(lines, 'Comprobantes', result.comprobantes, r => [`• ${r.fecha_emision || '-'} — ${r.comercio || '-'} — ${money(r.total)}`, `  ${r.tipo_comprobante || '-'} / ${r.estado || '-'}`]);
  addSection(lines, 'Productos de comprobantes', result.comprobanteItems, r => [`• ${r.descripcion || '-'} — ${money(r.importe)}`, `  ${r.categoria || '-'} / ${r.subcategoria || '-'}`]);

  if (lines.length <= 2) return `Búsqueda unificada: ${result.query}\n\nSin resultados.`;
  return lines.join('\n').slice(0, 3900);
}

function addSection(lines: string[], title: string, rows: any[], format: (row: any) => string[]) {
  if (!rows.length) return;
  lines.push(title + ':');
  for (const row of rows) lines.push(...format(row), '');
}

export async function buildPeriodSummary(args: string) {
  const parsed = parsePeriod(args);
  const [items, pendientes, movimientos, deudas, archivos] = await Promise.all([
    selectSince('items', parsed.startIso),
    selectSince('pendientes', parsed.startIso),
    selectSince('finanzas_movimientos', parsed.startIso),
    selectOpen('finanzas_deudas'),
    selectSince('archivos', parsed.startIso)
  ]);

  const gastos = movimientos.filter((m: any) => norm(m.tipo).includes('gasto') || Number(m.monto || 0) < 0 || !norm(m.tipo).includes('ingreso'));
  const ingresos = movimientos.filter((m: any) => norm(m.tipo).includes('ingreso'));
  const totalGastos = gastos.reduce((acc: number, r: any) => acc + Math.abs(Number(r.monto || 0)), 0);
  const totalIngresos = ingresos.reduce((acc: number, r: any) => acc + Math.abs(Number(r.monto || 0)), 0);
  const abiertos = pendientes.filter((p: any) => norm(p.estado) !== 'hecho');

  const byCategory = new Map<string, number>();
  for (const m of gastos) {
    const key = m.categoria_financiera || 'Sin categoría';
    byCategory.set(key, (byCategory.get(key) || 0) + Math.abs(Number(m.monto || 0)));
  }
  const topCats = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  return { parsed, items, pendientes, abiertos, movimientos, gastos, ingresos, totalGastos, totalIngresos, deudas, archivos, topCats };
}

export function formatPeriodSummary(s: Awaited<ReturnType<typeof buildPeriodSummary>>) {
  const lines = [`Resumen ${s.parsed.label}`, '', `Desde: ${s.parsed.startIso.slice(0, 10)}`];
  lines.push(`Items nuevos: ${s.items.length}`);
  lines.push(`Pendientes creados: ${s.pendientes.length}`);
  lines.push(`Pendientes abiertos: ${s.abiertos.length}`);
  lines.push(`Archivos nuevos: ${s.archivos.length}`);
  lines.push(`Movimientos financieros: ${s.movimientos.length}`);
  lines.push(`Gastos registrados: ${money(s.totalGastos)}`);
  lines.push(`Ingresos registrados: ${money(s.totalIngresos)}`);
  lines.push(`Deudas abiertas: ${s.deudas.length}`);

  if (s.topCats.length) {
    lines.push('', 'Gastos por categoría:');
    for (const [cat, amount] of s.topCats) lines.push(`- ${cat}: ${money(amount)}`);
  }

  if (s.abiertos.length) {
    lines.push('', 'Pendientes abiertos:');
    for (const p of s.abiertos.slice(0, 5)) lines.push(`- ${p.titulo}${p.fecha_vencimiento ? ` (vence ${p.fecha_vencimiento})` : ''}`);
  }

  if (s.items.length) {
    lines.push('', 'Últimos items:');
    for (const item of s.items.slice(0, 5)) lines.push(`- ${item.titulo || 'Sin título'} (${item.categoria_principal || '-'})`);
  }

  return lines.join('\n').slice(0, 3900);
}

function parsePeriod(args: string) {
  const t = norm(args);
  const now = new Date();
  if (t.includes('mes')) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    return { label: 'del mes', startIso: d.toISOString() };
  }
  if (t.includes('hoy')) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return { label: 'de hoy', startIso: d.toISOString() };
  }
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return { label: 'de la semana', startIso: d.toISOString() };
}

async function selectSince(table: string, startIso: string) {
  const { data, error } = await supabase.from(table).select('*').gte('created_at', startIso).order('created_at', { ascending: false }).limit(300);
  if (error) return [];
  return data || [];
}

async function selectOpen(table: string) {
  const { data, error } = await supabase.from(table).select('*').neq('estado', 'saldado').order('created_at', { ascending: false }).limit(300);
  if (error) return [];
  return data || [];
}

export async function cleanupDuplicates(confirm: boolean) {
  const [items, pendientes] = await Promise.all([load('items', 500), load('pendientes', 500)]);
  const itemGroups = duplicateGroups(items, (r: any) => norm(r.texto_original || r.titulo));
  const pendingGroups = duplicateGroups(pendientes.filter((p: any) => norm(p.estado) !== 'hecho'), (r: any) => norm(r.titulo));

  const itemDeleteIds = itemGroups.flatMap(g => g.slice(1).map((r: any) => r.id));
  const pendingDeleteIds = pendingGroups.flatMap(g => g.slice(1).map((r: any) => r.id));

  if (confirm) {
    if (itemDeleteIds.length) await supabase.from('items').delete().in('id', itemDeleteIds);
    if (pendingDeleteIds.length) await supabase.from('pendientes').delete().in('id', pendingDeleteIds);
  }

  return { confirm, itemGroups, pendingGroups, itemDeleteIds, pendingDeleteIds };
}

function duplicateGroups(rows: any[], keyFn: (row: any) => string) {
  const map = new Map<string, any[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || key.length < 6) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  return [...map.values()].filter(g => g.length > 1).map(g => g.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))));
}

export function formatDuplicateCleanup(r: Awaited<ReturnType<typeof cleanupDuplicates>>) {
  const lines = [r.confirm ? 'Limpieza de duplicados ejecutada.' : 'Duplicados detectados.'];
  lines.push('', `Items duplicados: ${r.itemDeleteIds.length}`, `Pendientes duplicados: ${r.pendingDeleteIds.length}`);
  if (!r.confirm) lines.push('', 'No borré nada. Para aplicar: /limpiar duplicados confirmar');

  const examples = [...r.itemGroups, ...r.pendingGroups].slice(0, 5);
  if (examples.length) {
    lines.push('', 'Ejemplos:');
    for (const g of examples) lines.push(`- ${shortLabel(g[0])} (${g.length} copias)`);
  }
  return lines.join('\n');
}

export async function applyUniversalCorrection(text: string, chatId: string) {
  const raw = text.replace(/^\/corregir\s*/i, '').replace(/^\/editar\s*/i, '').replace(/^corregir último\s*:??\s*/i, '').replace(/^corregir ultimo\s*:??\s*/i, '').trim();
  const t = norm(raw || text);

  if (t.includes('archivo')) return correctLastArchivo(raw);
  if (t.includes('pendiente')) return correctLastPendiente(raw);
  if (t.includes('memoria')) return correctLastMemoria(raw);
  if (t.includes('privado') || t.includes('sensible')) return markLastItemSensitive(chatId);

  return { handled: false as const };
}

async function correctLastPendiente(instruction: string) {
  const { data: current, error } = await supabase.from('pendientes').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!current) return { handled: true as const, message: 'No encontré pendiente para corregir.' };
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  const t = norm(instruction);
  if (t.includes('hecho') || t.includes('cerrado') || t.includes('listo')) patch.estado = 'hecho';
  if (t.includes('abierto')) patch.estado = 'abierto';
  const cat = extract(instruction, /(categoria|categoría)\s+([^,.]+)/i);
  if (cat) patch.categoria = cat;
  const pri = extract(instruction, /(prioridad)\s+([^,.]+)/i);
  if (pri) patch.prioridad = capitalize(pri);
  const title = extract(instruction, /(titulo|título|nombre)\s+([^,.]+)/i);
  if (title) patch.titulo = title;
  if (Object.keys(patch).length <= 1) return { handled: true as const, message: 'No encontré qué corregir del pendiente. Ejemplo: corregir último pendiente: prioridad alta, categoría compras' };
  const { data, error: e2 } = await supabase.from('pendientes').update(patch).eq('id', current.id).select().single();
  if (e2) throw e2;
  return { handled: true as const, message: ['Pendiente corregido.', '', `Título: ${data.titulo}`, `Estado: ${data.estado}`, `Prioridad: ${data.prioridad}`, `Categoría: ${data.categoria || '-'}`].join('\n') };
}

async function correctLastArchivo(instruction: string) {
  const { data: current, error } = await supabase.from('archivos').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!current) return { handled: true as const, message: 'No encontré archivo para corregir.' };
  const patch: Record<string, any> = {};
  const nombre = extract(instruction, /(nombre|renombrar|titulo|título)\s+([^,.]+)/i);
  if (nombre) patch.nombre_archivo = nombre;
  const tipo = extract(instruction, /(tipo)\s+([^,.]+)/i);
  if (tipo) patch.tipo_archivo = tipo;
  if (!Object.keys(patch).length) return { handled: true as const, message: 'No encontré qué corregir del archivo. Ejemplo: corregir último archivo: nombre DNI frente' };
  const { data, error: e2 } = await supabase.from('archivos').update(patch).eq('id', current.id).select().single();
  if (e2) throw e2;
  return { handled: true as const, message: ['Archivo corregido.', '', `Nombre: ${data.nombre_archivo || '-'}`, `Tipo: ${data.tipo_archivo || '-'}`].join('\n') };
}

async function correctLastMemoria(instruction: string) {
  const { data: current, error } = await supabase.from('memorias').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!current) return { handled: true as const, message: 'No encontré memoria para corregir.' };
  const patch: Record<string, any> = {};
  const t = norm(instruction);
  if (t.includes('borrar') || t.includes('no vigente') || t.includes('incorrecta')) patch.vigente = false;
  const afirmacion = extract(instruction, /(memoria|afirmacion|afirmación)\s+([^,.]+)/i);
  if (afirmacion) patch.afirmacion = afirmacion;
  const categoria = extract(instruction, /(categoria|categoría)\s+([^,.]+)/i);
  if (categoria) patch.categoria = categoria;
  if (!Object.keys(patch).length) return { handled: true as const, message: 'No encontré qué corregir de la memoria. Ejemplo: corregir última memoria: no vigente' };
  const { data, error: e2 } = await supabase.from('memorias').update(patch).eq('id', current.id).select().single();
  if (e2) throw e2;
  return { handled: true as const, message: ['Memoria corregida.', '', `Memoria: ${data.afirmacion || '-'}`, `Vigente: ${data.vigente ? 'sí' : 'no'}`, `Categoría: ${data.categoria || '-'}`].join('\n') };
}

async function markLastItemSensitive(chatId: string) {
  const { data: item, error } = await supabase.from('items').select('*').eq('telegram_chat_id', chatId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!item) return { handled: true as const, message: 'No encontré item para marcar privado/sensible.' };
  const tags = Array.from(new Set([...(item.tags || []), 'privado', 'sensible']));
  const updated = await updateItemFields(item.id, { tags, importancia: 'Alta', classifier_json: { ...(item.classifier_json || {}), tags, importancia: 'Alta' } });
  return { handled: true as const, message: ['Marcado como privado/sensible.', '', `Item: ${updated.titulo || '-'}`, `Tags: ${(updated.tags || []).join(', ')}`].join('\n') };
}

function extract(text: string, re: RegExp) {
  const m = text.match(re);
  return m ? clean(m[2]) : '';
}

function money(value: any) { return `$${Number(value || 0).toLocaleString('es-AR')}`; }
function norm(value: unknown) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function clean(value: unknown) { return String(value || '').trim().replace(/\s+/g, ' '); }
function capitalize(value: string) { const v = clean(value).toLowerCase(); return v ? v[0].toUpperCase() + v.slice(1) : v; }
