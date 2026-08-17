import { supabase } from './supabaseClient.js';

type Period = { label: string; start: string; end: string };

export function looksLikeReviewRequest(text: string) {
  const t = norm(text);
  return t.startsWith('revision ') || t.startsWith('revisión ') || t === 'revision' || t === 'revisión';
}

export async function buildOperationalReview(args = '') {
  const period = parseReviewPeriod(args);
  const [items, pendientes, movimientos, deudas, archivos, presupuestos, cierres] = await Promise.all([
    selectBetween('items', period.start, period.end),
    selectBetween('pendientes', period.start, period.end),
    selectBetween('finanzas_movimientos', period.start, period.end),
    selectOpen('finanzas_deudas'),
    selectBetween('archivos', period.start, period.end),
    selectActiveBudgets(),
    selectOpen('finanzas_cierres')
  ]);

  const pendientesAbiertos = await selectOpenPendings();
  const gastos = movimientos.filter((m: any) => String(m.tipo || '').toLowerCase() !== 'ingreso');
  const ingresos = movimientos.filter((m: any) => String(m.tipo || '').toLowerCase() === 'ingreso');
  const totalGastos = sumAbs(gastos, 'monto');
  const totalIngresos = sumAbs(ingresos, 'monto');
  const byCategory = groupSum(gastos, 'categoria_financiera', 'monto');
  const byPayment = groupSum(gastos, 'medio_pago', 'monto');
  const budgetAlerts = buildBudgetAlerts(presupuestos, byCategory);

  const suggestions: string[] = [];
  if (pendientesAbiertos.length) suggestions.push(`Cerrar o revisar ${pendientesAbiertos.length} pendiente(s) abierto(s).`);
  if (deudas.length) suggestions.push(`Revisar ${deudas.length} deuda(s) abierta(s).`);
  if (cierres.length) suggestions.push(`Revisar ${cierres.length} cierre(s) de tarjeta pendiente/parcial.`);
  if (budgetAlerts.length) suggestions.push('Hay presupuestos cerca o por encima del límite.');
  if (!items.length && !movimientos.length && !pendientes.length) suggestions.push('Hubo poca carga en el período. Usá el bot apenas pase algo para mantener el registro vivo.');

  return { period, items, pendientes, pendientesAbiertos, movimientos, gastos, ingresos, totalGastos, totalIngresos, deudas, archivos, presupuestos, cierres, byCategory, byPayment, budgetAlerts, suggestions };
}

export function formatOperationalReview(r: Awaited<ReturnType<typeof buildOperationalReview>>) {
  const lines = [`Revisión ${r.period.label}`, '', `Período: ${r.period.start.slice(0, 10)} a ${r.period.end.slice(0, 10)}`];

  lines.push('', 'Actividad:');
  lines.push(`Items cargados: ${r.items.length}`);
  lines.push(`Pendientes creados: ${r.pendientes.length}`);
  lines.push(`Pendientes abiertos totales: ${r.pendientesAbiertos.length}`);
  lines.push(`Archivos nuevos: ${r.archivos.length}`);

  lines.push('', 'Finanzas:');
  lines.push(`Movimientos: ${r.movimientos.length}`);
  lines.push(`Gastos: ${money(r.totalGastos)}`);
  lines.push(`Ingresos: ${money(r.totalIngresos)}`);
  lines.push(`Balance registrado: ${money(r.totalIngresos - r.totalGastos)}`);
  lines.push(`Deudas abiertas: ${r.deudas.length}`);
  lines.push(`Cierres tarjeta pendientes/parciales: ${r.cierres.length}`);

  if (r.byCategory.length) {
    lines.push('', 'Gastos principales por categoría:');
    for (const [cat, amount] of r.byCategory.slice(0, 6)) lines.push(`- ${cat}: ${money(amount)}`);
  }

  if (r.byPayment.length) {
    lines.push('', 'Gastos por medio:');
    for (const [pm, amount] of r.byPayment.slice(0, 5)) lines.push(`- ${pm}: ${money(amount)}`);
  }

  if (r.budgetAlerts.length) {
    lines.push('', 'Presupuestos:');
    for (const a of r.budgetAlerts.slice(0, 6)) lines.push(`- ${a}`);
  }

  if (r.pendientesAbiertos.length) {
    lines.push('', 'Pendientes abiertos:');
    for (const p of r.pendientesAbiertos.slice(0, 8)) lines.push(`- ${p.titulo || p.descripcion || '-'}${p.fecha_vencimiento ? ` (vence ${p.fecha_vencimiento})` : ''}`);
  }

  if (r.deudas.length) {
    lines.push('', 'Deudas abiertas:');
    for (const d of r.deudas.slice(0, 6)) {
      const label = d.tipo === 'yo_debo' ? `Debés a ${d.persona}` : `${d.persona} te debe`;
      lines.push(`- ${label}: ${money(d.saldo_pendiente)} — ${d.concepto || '-'}`);
    }
  }

  if (r.suggestions.length) {
    lines.push('', 'Acciones sugeridas:');
    for (const s of r.suggestions.slice(0, 6)) lines.push(`- ${s}`);
  }

  lines.push('', 'Comandos útiles: /pendientes, /deudas, /tarjetas, /presupuestos, /diagnostico');
  return lines.join('\n').slice(0, 3900);
}

function parseReviewPeriod(args: string): Period {
  const t = norm(args || 'hoy');
  const now = new Date();
  const end = now.toISOString();
  if (t.includes('mes')) {
    const start = new Date(now); start.setDate(1); start.setHours(0,0,0,0);
    return { label: 'del mes', start: start.toISOString(), end };
  }
  if (t.includes('semana')) {
    const start = new Date(now); start.setDate(start.getDate() - 7); start.setHours(0,0,0,0);
    return { label: 'de la semana', start: start.toISOString(), end };
  }
  if (t.includes('ayer')) {
    const start = new Date(now); start.setDate(start.getDate() - 1); start.setHours(0,0,0,0);
    const finish = new Date(start); finish.setHours(23,59,59,999);
    return { label: 'de ayer', start: start.toISOString(), end: finish.toISOString() };
  }
  const start = new Date(now); start.setHours(0,0,0,0);
  return { label: 'de hoy', start: start.toISOString(), end };
}

async function selectBetween(table: string, start: string, end: string) {
  try {
    const { data, error } = await supabase.from(table).select('*').gte('created_at', start).lte('created_at', end).order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    return data || [];
  } catch { return []; }
}

async function selectOpen(table: string) {
  try {
    let q = supabase.from(table).select('*').order('created_at', { ascending: false }).limit(200);
    if (table === 'finanzas_deudas') q = q.neq('estado', 'saldado').neq('estado', 'cancelado');
    if (table === 'finanzas_cierres') q = q.neq('estado', 'pagado').neq('estado', 'cancelado');
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  } catch { return []; }
}

async function selectOpenPendings() {
  try {
    const { data, error } = await supabase.from('pendientes').select('*').neq('estado', 'hecho').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    return data || [];
  } catch { return []; }
}

async function selectActiveBudgets() {
  try {
    const { data, error } = await supabase.from('finanzas_presupuestos').select('*').eq('activo', true).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return data || [];
  } catch { return []; }
}

function buildBudgetAlerts(budgets: any[], categoryTotals: Array<[string, number]>) {
  const totals = new Map(categoryTotals.map(([cat, amount]) => [norm(cat), amount]));
  const out: string[] = [];
  for (const b of budgets) {
    const key = norm(b.categoria_financiera);
    const spent = totals.get(key) || 0;
    const budget = Number(b.monto_presupuestado || 0);
    if (!budget) continue;
    const pct = Math.round((spent / budget) * 100);
    if (pct >= 100) out.push(`${b.categoria_financiera}: ${money(spent)} de ${money(budget)} (${pct}%) — excedido`);
    else if (pct >= 80) out.push(`${b.categoria_financiera}: ${money(spent)} de ${money(budget)} (${pct}%) — cerca del límite`);
  }
  return out;
}

function groupSum(rows: any[], key: string, amountKey: string) {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = String(r[key] || 'Sin dato');
    map.set(k, (map.get(k) || 0) + Math.abs(Number(r[amountKey] || 0)));
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function sumAbs(rows: any[], key: string) { return rows.reduce((acc, r) => acc + Math.abs(Number(r[key] || 0)), 0); }
function money(n: number | string | null | undefined) { return `$${Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`; }
function norm(value: unknown) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
