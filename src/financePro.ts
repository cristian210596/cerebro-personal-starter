import { supabase } from './supabaseClient.js';

export function looksLikeFinanceProText(text: string) {
  const t = norm(text);
  return (
    /^corregir (ultimo|último) gasto/.test(t) ||
    /^corregir gasto/.test(t) ||
    /^marcar deuda/.test(t) ||
    /^saldar deuda/.test(t) ||
    /^cierre (visa|master|mastercard)/.test(t) ||
    /^pague (visa|master|mastercard)/.test(t) ||
    /^pag[uú]e (visa|master|mastercard)/.test(t)
  );
}

export async function listFinanceMovements(query = '', limit = 12) {
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .order('fecha_movimiento', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const q = norm(query);
  const rows = (data || []).filter((row: any) => {
    if (!q) return true;
    const haystack = norm([
      row.descripcion,
      row.categoria_financiera,
      row.subcategoria_financiera,
      row.medio_pago,
      row.tarjeta,
      row.banco_billetera,
      row.comercio,
      row.tipo,
      row.estado,
      row.fecha_movimiento
    ].filter(Boolean).join(' '));
    return q.split(/\s+/).filter(Boolean).every(token => haystack.includes(token));
  });
  return rows.slice(0, limit);
}

export async function listFinanceDebts(query = '', limit = 15) {
  const { data, error } = await supabase
    .from('finanzas_deudas')
    .select('*')
    .neq('estado', 'saldado')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const q = norm(query);
  const rows = (data || []).filter((row: any) => {
    if (!q) return true;
    const haystack = norm([row.persona, row.tipo, row.concepto, row.estado].filter(Boolean).join(' '));
    return q.split(/\s+/).filter(Boolean).every(token => haystack.includes(token));
  });
  return rows.slice(0, limit);
}

export function formatMovements(rows: any[], title = 'Gastos / movimientos') {
  if (!rows.length) return `${title}\n\nSin movimientos.`;
  const lines = [title, ''];
  for (const row of rows) {
    lines.push(`• ${row.fecha_movimiento || '-'} — ${labelTipo(row.tipo)} — ${money(row.monto)}`);
    lines.push(`  ${row.comercio || row.descripcion || '-'}`);
    lines.push(`  ${row.categoria_financiera || '-'} / ${row.medio_pago || '-'}`);
    if (row.cuotas) lines.push(`  Cuotas: ${row.cuotas}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatDebts(rows: any[], title = 'Deudas abiertas') {
  if (!rows.length) return `${title}\n\nSin deudas abiertas.`;
  const lines = [title, ''];
  for (const row of rows) {
    const who = row.tipo === 'yo_debo' ? `Yo debo a ${row.persona}` : `${row.persona} me debe`;
    lines.push(`• ${who}: ${money(row.saldo_pendiente)} / ${money(row.monto_total)}`);
    lines.push(`  ${row.concepto || '-'} — ${row.estado || '-'}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function correctLastFinanceMovement(text: string) {
  const { data: rows, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const current = rows?.[0];
  if (!current) return { ok: false as const, message: 'No encontré un gasto/movimiento para corregir.' };

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  const amount = parseAmount(text);
  if (amount !== null) patch.monto = amount;

  const pm = detectPaymentMethod(text);
  if (pm) {
    patch.medio_pago = pm.medio_pago;
    patch.tarjeta = pm.tarjeta;
    patch.banco_billetera = pm.banco_billetera;
  }

  const categoria = extractAfter(text, /(categoria|categoría)\s+([^,.]+)/i);
  if (categoria) patch.categoria_financiera = normalizeCategory(categoria);

  const comercio = extractAfter(text, /(comercio|local)\s+([^,.]+)/i);
  if (comercio) patch.comercio = clean(comercio);

  const estado = extractAfter(text, /estado\s+([^,.]+)/i);
  if (estado) patch.estado = clean(estado).toLowerCase();

  if (Object.keys(patch).length <= 1) {
    return { ok: false as const, message: 'No encontré qué corregir. Ejemplo: corregir último gasto: fue con visa, categoría comida afuera, monto 4500' };
  }

  const { data, error: updateError } = await supabase
    .from('finanzas_movimientos')
    .update(patch)
    .eq('id', current.id)
    .select()
    .single();
  if (updateError) throw updateError;

  return { ok: true as const, movimiento: data, patch };
}

export function formatFinanceCorrection(result: Awaited<ReturnType<typeof correctLastFinanceMovement>>) {
  if (!result.ok) return result.message;
  const m = result.movimiento;
  return [
    'Gasto corregido.',
    '',
    `Monto: ${money(m.monto)}`,
    `Categoría: ${m.categoria_financiera || '-'}`,
    `Medio: ${m.medio_pago || '-'}`,
    `Comercio: ${m.comercio || '-'}`
  ].join('\n');
}

export async function markDebtPaidFromText(text: string) {
  const t = norm(text);
  const personMatch = text.match(/(?:deuda de|deuda con|de )\s*([^,.]+?)(?:\s+como|\s+saldada|$)/i) || text.match(/^(?:saldar deuda|marcar deuda)\s+([^,.]+)/i);
  const persona = personMatch ? clean(personMatch[1]) : '';
  const amount = parseAmount(text);
  if (!persona) return { ok: false as const, message: 'No identifiqué la persona. Ejemplo: marcar deuda de Juan como saldada' };

  const { data: debts, error } = await supabase
    .from('finanzas_deudas')
    .select('*')
    .neq('estado', 'saldado')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;

  const target = (debts || []).find((d: any) => norm(d.persona).includes(norm(persona)) || norm(persona).includes(norm(d.persona)));
  if (!target) return { ok: false as const, message: `No encontré deuda abierta para ${persona}.` };

  const pago = amount ?? Number(target.saldo_pendiente || 0);
  const nuevoPagado = Number(target.monto_pagado || 0) + pago;
  const saldo = Math.max(0, round(Number(target.monto_total || 0) - nuevoPagado));
  const estado = saldo <= 0 || t.includes('saldada') || t.includes('saldar') ? 'saldado' : 'parcial';

  const { data, error: updateError } = await supabase
    .from('finanzas_deudas')
    .update({ monto_pagado: nuevoPagado, saldo_pendiente: estado === 'saldado' ? 0 : saldo, estado, updated_at: new Date().toISOString() })
    .eq('id', target.id)
    .select()
    .single();
  if (updateError) throw updateError;
  return { ok: true as const, deuda: data, pago };
}

export async function saveCardStatementFromText(text: string) {
  const t = norm(text);
  const tarjeta = t.includes('master') ? 'Mastercard' : t.includes('visa') ? 'Visa' : null;
  const amount = parseAmount(text);
  if (!tarjeta || amount === null) return { ok: false as const, message: 'Usá: cierre visa julio 450000 vence 10/8' };
  const periodo = extractPeriod(text) || new Date().toISOString().slice(0, 7);
  const vencimiento = extractDueDate(text);

  const { data, error } = await supabase
    .from('finanzas_cierres')
    .insert({ tarjeta, periodo, monto_total: amount, monto_pagado: 0, saldo_pendiente: amount, fecha_vencimiento: vencimiento, estado: 'pendiente' })
    .select()
    .single();
  if (error) throw error;
  return { ok: true as const, cierre: data };
}

export async function payCardFromText(text: string) {
  const t = norm(text);
  const tarjeta = t.includes('master') ? 'Mastercard' : t.includes('visa') ? 'Visa' : null;
  const amount = parseAmount(text);
  if (!tarjeta || amount === null) return { ok: false as const, message: 'Usá: pagué visa 450000' };

  const { data: rows, error } = await supabase
    .from('finanzas_cierres')
    .select('*')
    .eq('tarjeta', tarjeta)
    .neq('estado', 'pagado')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const cierre = rows?.[0];
  if (!cierre) return { ok: false as const, message: `No encontré cierre pendiente para ${tarjeta}.` };
  const pagado = Number(cierre.monto_pagado || 0) + amount;
  const saldo = Math.max(0, round(Number(cierre.monto_total || 0) - pagado));
  const estado = saldo <= 0 ? 'pagado' : 'parcial';

  const { data, error: updateError } = await supabase
    .from('finanzas_cierres')
    .update({ monto_pagado: pagado, saldo_pendiente: saldo, estado, updated_at: new Date().toISOString() })
    .eq('id', cierre.id)
    .select()
    .single();
  if (updateError) throw updateError;
  return { ok: true as const, cierre: data, pago: amount };
}

export async function getCardSummary() {
  const { data, error } = await supabase
    .from('finanzas_cierres')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data || [];
}

export function formatCardSummary(rows: any[]) {
  if (!rows.length) return 'Tarjetas\n\nSin cierres registrados.';
  const lines = ['Tarjetas', ''];
  for (const row of rows) {
    lines.push(`• ${row.tarjeta} ${row.periodo || ''}: ${money(row.saldo_pendiente)} pendiente / ${money(row.monto_total)}`);
    lines.push(`  Estado: ${row.estado || '-'}${row.fecha_vencimiento ? ` — vence ${row.fecha_vencimiento}` : ''}`);
  }
  return lines.join('\n');
}

export async function deleteLastFinanceMovement(confirm: boolean) {
  if (!confirm) return { ok: false as const, message: 'Para borrar el último gasto usá: /borrar gasto ultimo confirmar' };
  const { data: rows, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = rows?.[0];
  if (!row) return { ok: false as const, message: 'No encontré movimientos para borrar.' };
  await supabase.from('finanzas_particiones').delete().eq('movimiento_id', row.id);
  await supabase.from('finanzas_deudas').delete().eq('movimiento_id', row.id);
  const { error: delError } = await supabase.from('finanzas_movimientos').delete().eq('id', row.id);
  if (delError) throw delError;
  return { ok: true as const, message: `Borré el último movimiento: ${row.comercio || row.descripcion || row.tipo} — ${money(row.monto)}.` };
}

export async function deleteLastItem(confirm: boolean) {
  if (!confirm) return { ok: false as const, message: 'Para borrar el último item usá: /borrar ultimo confirmar' };
  const { data: rows, error } = await supabase.from('items').select('*').order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  const row = rows?.[0];
  if (!row) return { ok: false as const, message: 'No encontré items para borrar.' };
  await supabase.from('finanzas_movimientos').delete().eq('item_id', row.id);
  await supabase.from('finanzas_deudas').delete().eq('item_id', row.id);
  await supabase.from('archivos').delete().eq('item_id', row.id);
  const { error: delError } = await supabase.from('items').delete().eq('id', row.id);
  if (delError) throw delError;
  return { ok: true as const, message: `Borré el último item: ${row.titulo || row.id}.` };
}

function extractAfter(text: string, regex: RegExp) {
  const m = text.match(regex);
  return m ? clean(m[2] || m[1]) : '';
}

function detectPaymentMethod(text: string) {
  const t = norm(text);
  if (t.includes('visa')) return { medio_pago: 'Visa crédito', tarjeta: 'Visa', banco_billetera: null };
  if (t.includes('master')) return { medio_pago: 'Mastercard crédito', tarjeta: 'Mastercard', banco_billetera: null };
  if (t.includes('mercado pago') || /\bmp\b/.test(t)) return { medio_pago: 'Mercado Pago', tarjeta: null, banco_billetera: 'Mercado Pago' };
  if (t.includes('galicia')) return { medio_pago: 'Banco Galicia', tarjeta: null, banco_billetera: 'Banco Galicia' };
  if (t.includes('efectivo')) return { medio_pago: 'Efectivo', tarjeta: null, banco_billetera: null };
  if (t.includes('debito')) return { medio_pago: 'Débito', tarjeta: null, banco_billetera: null };
  if (t.includes('transferencia')) return { medio_pago: 'Transferencia', tarjeta: null, banco_billetera: null };
  return null;
}

function parseAmount(text: string) {
  const matches = [...text.matchAll(/(?:\$\s*)?(\d{1,3}(?:[\. ]\d{3})+|\d+)(?:,(\d{1,2}))?/g)];
  if (!matches.length) return null;
  const ignored = ['10/8','10/08','1/2','2/3'];
  for (const m of matches) {
    const raw = m[0];
    if (ignored.includes(raw)) continue;
    const n = Number(`${m[1].replace(/[\. ]/g, '')}.${m[2] || '0'}`);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function extractPeriod(text: string) {
  const t = norm(text);
  const months: Record<string, string> = { enero:'01', febrero:'02', marzo:'03', abril:'04', mayo:'05', junio:'06', julio:'07', agosto:'08', septiembre:'09', setiembre:'09', octubre:'10', noviembre:'11', diciembre:'12' };
  for (const [name, mm] of Object.entries(months)) {
    if (t.includes(name)) return `${new Date().getFullYear()}-${mm}`;
  }
  const m = text.match(/(20\d{2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  return null;
}

function extractDueDate(text: string) {
  const m = text.match(/vence\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (!m) return null;
  const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(new Date().getFullYear());
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function normalizeCategory(value: string) {
  const v = norm(value);
  if (v.includes('comida') || v.includes('rest') || v.includes('cafe') || v.includes('panader')) return 'Comida afuera';
  if (v.includes('super')) return 'Supermercado';
  if (v.includes('farm')) return 'Farmacia';
  if (v.includes('ropa')) return 'Ropa';
  if (v.includes('serv')) return 'Servicios';
  if (v.includes('trans')) return 'Transporte';
  return clean(value);
}

function labelTipo(value: string) {
  if (value === 'gasto') return 'Gasto';
  if (value === 'ingreso') return 'Ingreso';
  if (value === 'devolucion') return 'Devolución';
  return clean(value) || '-';
}

function norm(value: unknown) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function clean(value: unknown) { return String(value || '').trim().replace(/\s+/g, ' '); }
function money(value: any) { return `$${Number(value || 0).toLocaleString('es-AR')}`; }
function round(n: number) { return Math.round(n * 100) / 100; }
