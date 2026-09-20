import crypto from 'node:crypto';
import { config } from './config.js';
import { withGemini } from './geminiPool.js';
import { supabase } from './supabaseClient.js';

export type SalaryConceptType = 'haber' | 'retencion' | 'asignacion' | 'no_remunerativo' | 'otro';

export type ParsedSalaryConcept = {
  concepto: string;
  codigo?: string | null;
  unidades?: string | number | null;
  tipo?: SalaryConceptType | null;
  importe?: number | null;
};

export type ParsedSalaryReceipt = {
  is_salary_receipt: boolean;
  confidence?: number;
  empresa?: string | null;
  empleado?: string | null;
  legajo?: string | null;
  cuil?: string | null;
  periodo?: string | null;
  fecha_pago?: string | null;
  fecha_ingreso?: string | null;
  categoria?: string | null;
  contratacion?: string | null;
  total_bruto?: number | null;
  total_neto?: number | null;
  total_haberes?: number | null;
  total_retenciones?: number | null;
  total_asignaciones?: number | null;
  total_no_remunerativo?: number | null;
  moneda?: string | null;
  conceptos?: ParsedSalaryConcept[];
  texto_extraido?: string | null;
  notas?: string | null;
};

type ImportSalaryInput = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  caption?: string;
  chatId: number | string;
  archivoId?: string | null;
  force?: boolean;
};

type ImportSalaryResult = {
  recognized: boolean;
  duplicate?: boolean;
  recibo?: any;
  movimiento?: any | null;
  conceptsInserted?: number;
  parsed?: ParsedSalaryReceipt | null;
  message?: string;
};

const MONTHS: Record<string, string> = {
  enero: '01', ene: '01',
  febrero: '02', feb: '02',
  marzo: '03', mar: '03',
  abril: '04', abr: '04',
  mayo: '05', may: '05',
  junio: '06', jun: '06',
  julio: '07', jul: '07',
  agosto: '08', ago: '08',
  septiembre: '09', setiembre: '09', sep: '09', set: '09',
  octubre: '10', oct: '10',
  noviembre: '11', nov: '11',
  diciembre: '12', dic: '12'
};

export function looksLikeSalaryFile(fileName = '', mimeType = '', caption = '') {
  const t = norm(`${fileName} ${mimeType} ${caption}`);
  return /\b(recibo|haberes|sueldo|salarial|liquidacion|liquidación)\b/.test(t) && !/\bvisa|master|mercado\s*pago|resumen\s*tarjeta\b/.test(t);
}

export function looksLikeSalaryQueryText(text: string) {
  const t = norm(text);
  if (/^(cuanto|cuánto) (cobre|cobré|cobro|me pagaron)/.test(t)) return true;
  if (t.includes('sueldo') || t.includes('recibo de haberes') || t.includes('recibo de sueldo')) return true;
  if (t.includes('ganancias') && (t.includes('descontaron') || t.includes('retuvieron') || t.includes('retencion') || t.includes('retención'))) return true;
  if (t.includes('horas extra') || t.includes('horas extras')) return true;
  if (t.includes('total neto') && (t.includes('ano') || t.includes('año') || t.includes('mes'))) return true;
  return false;
}

export async function importSalaryReceiptFromFile(input: ImportSalaryInput): Promise<ImportSalaryResult> {
  const parsed = await extractSalaryReceiptWithGemini(input.buffer, input.mimeType, input.fileName, input.caption || '', input.force || looksLikeSalaryFile(input.fileName, input.mimeType, input.caption || ''));
  if (!parsed.is_salary_receipt) {
    return { recognized: false, parsed, message: 'La imagen/documento no parece recibo de sueldo.' };
  }
  return persistSalaryReceipt(parsed, {
    archivoId: input.archivoId || null,
    chatId: String(input.chatId),
    fileName: input.fileName,
    mimeType: input.mimeType,
    bufferHash: sha256(input.buffer)
  });
}

export async function extractSalaryReceiptWithGemini(buffer: Buffer, mimeType: string, fileName: string, caption = '', force = false): Promise<ParsedSalaryReceipt> {
  const prompt = [
    'Analizá este archivo para un sistema personal de registro de sueldos.',
    'Primero decidí si es un recibo de sueldo / recibo de haberes / liquidación salarial.',
    force ? 'El usuario cree que esto es un recibo de sueldo: intentá extraerlo con cuidado.' : 'Si no es claramente un recibo de sueldo, devolvé is_salary_receipt=false.',
    'No inventes datos. Si un dato no se ve, usá null.',
    'Devolvé SOLO JSON válido, sin markdown.',
    '',
    'Schema exacto:',
    '{',
    '  "is_salary_receipt": true|false,',
    '  "confidence": 0.0-1.0,',
    '  "empresa": string|null,',
    '  "empleado": string|null,',
    '  "legajo": string|null,',
    '  "cuil": string|null,',
    '  "periodo": "YYYY-MM"|null,',
    '  "fecha_pago": "YYYY-MM-DD"|null,',
    '  "fecha_ingreso": "YYYY-MM-DD"|null,',
    '  "categoria": string|null,',
    '  "contratacion": string|null,',
    '  "total_bruto": number|null,',
    '  "total_neto": number|null,',
    '  "total_haberes": number|null,',
    '  "total_retenciones": number|null,',
    '  "total_asignaciones": number|null,',
    '  "total_no_remunerativo": number|null,',
    '  "moneda": "ARS",',
    '  "conceptos": [',
    '    {"concepto": string, "codigo": string|null, "unidades": string|null, "tipo": "haber"|"retencion"|"asignacion"|"no_remunerativo"|"otro", "importe": number|null}',
    '  ],',
    '  "texto_extraido": string|null,',
    '  "notas": string|null',
    '}',
    '',
    'Reglas:',
    '- En Argentina, Total Neto es el importe cobrado efectivamente.',
    '- Total Bruto puede figurar como Total Bruto o total de haberes + no remunerativo.',
    '- Retención Imp. Ganancias debe ir como concepto tipo retencion.',
    '- Aporte Jubilatorio, Ley 19032 y Obra Social son retenciones.',
    '- Sueldo básico, antigüedad, feriado y horas extras son haberes.',
    '- Convertí números argentinos: 4.226.534,00 => 4226534.00.',
    '- Si el periodo figura 01/2026, devolver 2026-01.',
    caption ? `Caption del usuario: ${caption}` : '',
    fileName ? `Nombre de archivo: ${fileName}` : ''
  ].filter(Boolean).join('\n');

  const response: any = await withGemini(ai => ai.models.generateContent({
    model: config.geminiModel(),
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: mimeType || 'application/octet-stream', data: buffer.toString('base64') } }
        ]
      }
    ]
  }), { operationName: 'extracción recibo de sueldo', timeoutMs: 45000, maxAttempts: 1 });

  const raw = String(response.text || '').trim();
  const parsed = parseJsonLoose(raw) as ParsedSalaryReceipt;
  return sanitizeParsedSalary(parsed);
}

export async function persistSalaryReceipt(parsedInput: ParsedSalaryReceipt, context: { archivoId?: string | null; chatId?: string | null; fileName?: string | null; mimeType?: string | null; bufferHash?: string | null }): Promise<ImportSalaryResult> {
  const parsed = sanitizeParsedSalary(parsedInput);
  if (!parsed.is_salary_receipt) return { recognized: false, parsed };

  const empresa = cleanText(parsed.empresa) || 'Empresa sin identificar';
  const empleado = cleanText(parsed.empleado) || null;
  const periodo = normalizePeriod(parsed.periodo || parsed.fecha_pago || '') || periodFromDate(parsed.fecha_pago || '') || null;
  const fechaPago = normalizeDate(parsed.fecha_pago || '') || null;
  const dedupeKey = buildSalaryDedupeKey(empresa, periodo, empleado, context.bufferHash || null);

  const existing = await findExistingSalaryReceipt(dedupeKey, empresa, periodo, empleado);
  if (existing) {
    return {
      recognized: true,
      duplicate: true,
      recibo: existing,
      movimiento: existing.movimiento_financiero_id ? { id: existing.movimiento_financiero_id } : null,
      conceptsInserted: 0,
      parsed,
      message: 'Ese recibo ya estaba cargado. No lo dupliqué.'
    };
  }

  const estado = parsed.confidence && parsed.confidence >= 0.65 && parsed.total_neto && periodo ? 'confirmado' : 'pendiente_revision';
  const { data: recibo, error } = await supabase
    .from('sueldos_recibos')
    .insert({
      archivo_id: context.archivoId || null,
      telegram_chat_id: context.chatId || null,
      nombre_archivo: context.fileName || null,
      mime_type: context.mimeType || null,
      empresa,
      empleado,
      legajo: cleanText(parsed.legajo) || null,
      cuil: cleanText(parsed.cuil) || null,
      periodo,
      fecha_pago: fechaPago,
      fecha_ingreso: normalizeDate(parsed.fecha_ingreso || '') || null,
      categoria: cleanText(parsed.categoria) || null,
      contratacion: cleanText(parsed.contratacion) || null,
      total_bruto: moneyOrNull(parsed.total_bruto),
      total_neto: moneyOrNull(parsed.total_neto),
      total_haberes: moneyOrNull(parsed.total_haberes),
      total_retenciones: moneyOrNull(parsed.total_retenciones),
      total_asignaciones: moneyOrNull(parsed.total_asignaciones),
      total_no_remunerativo: moneyOrNull(parsed.total_no_remunerativo),
      moneda: parsed.moneda || 'ARS',
      estado,
      confianza_extraccion: Number(parsed.confidence || 0),
      dedupe_key: dedupeKey,
      texto_extraido: parsed.texto_extraido || null,
      raw_json: parsed,
      notas: parsed.notas || null
    })
    .select()
    .single();

  if (error) throw error;

  const concepts = sanitizeConcepts(parsed.conceptos || []);
  let conceptsInserted = 0;
  if (concepts.length) {
    const rows = concepts.map((c, index) => ({
      recibo_id: recibo.id,
      orden: index + 1,
      concepto: c.concepto,
      codigo: c.codigo || null,
      unidades: c.unidades == null ? null : String(c.unidades),
      tipo: normalizeConceptType(c.tipo),
      importe: moneyOrNull(c.importe)
    }));
    const { error: conceptError } = await supabase.from('sueldos_conceptos').insert(rows);
    if (conceptError) throw conceptError;
    conceptsInserted = rows.length;
  }

  const movimiento = await createIncomeMovementForReceipt(recibo, dedupeKey);
  if (movimiento) {
    await supabase.from('sueldos_recibos').update({ movimiento_financiero_id: movimiento.id, updated_at: new Date().toISOString() }).eq('id', recibo.id);
    recibo.movimiento_financiero_id = movimiento.id;
  }

  return { recognized: true, duplicate: false, recibo, movimiento, conceptsInserted, parsed };
}

async function findExistingSalaryReceipt(dedupeKey: string, empresa: string, periodo: string | null, empleado: string | null) {
  if (dedupeKey) {
    const { data, error } = await supabase.from('sueldos_recibos').select('*').eq('dedupe_key', dedupeKey).limit(1).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  if (periodo) {
    let q = supabase.from('sueldos_recibos').select('*').eq('periodo', periodo).ilike('empresa', `%${empresa.slice(0, 24)}%`).limit(3);
    if (empleado) q = q.ilike('empleado', `%${empleado.slice(0, 24)}%`);
    const { data, error } = await q;
    if (error) throw error;
    if ((data || []).length) return (data || [])[0];
  }
  return null;
}

async function createIncomeMovementForReceipt(recibo: any, externalHash: string) {
  const neto = Number(recibo.total_neto || 0);
  if (!neto || neto <= 0) return null;

  const existing = await findExistingFinanceMovement(externalHash);
  if (existing) return existing;

  const { data, error } = await supabase.from('finanzas_movimientos').insert({
    fecha_movimiento: recibo.fecha_pago || new Date().toISOString().slice(0, 10),
    tipo: 'ingreso',
    monto: neto,
    moneda: recibo.moneda || 'ARS',
    descripcion: `Sueldo ${recibo.empresa || ''}${recibo.periodo ? ` — ${recibo.periodo}` : ''}`.trim(),
    categoria_financiera: 'Ingresos',
    subcategoria_financiera: 'Sueldo',
    medio_pago: 'Transferencia',
    tarjeta: null,
    banco_billetera: null,
    comercio: recibo.empresa || null,
    cuotas: null,
    estado: recibo.estado === 'confirmado' ? 'confirmado' : 'pendiente_revision',
    origen: 'recibo_sueldo',
    external_hash: externalHash,
    merchant_key: normalizeKey(recibo.empresa || 'sueldo'),
    periodo_resumen: recibo.periodo || null
  }).select().single();

  if (error) throw error;
  return data;
}

async function findExistingFinanceMovement(externalHash: string) {
  const { data, error } = await supabase.from('finanzas_movimientos').select('*').eq('external_hash', externalHash).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createManualSalaryReceiptFromText(chatId: string | number, text: string) {
  const parsed = parseManualSalaryText(text);
  if (!parsed.periodo || !parsed.total_neto) {
    return { ok: false as const, message: 'Usá: /sueldo cargar periodo 2026-02 neto 3744369 bruto 4667076 empresa Dr Gray fecha 2026-03-05' };
  }
  const result = await persistSalaryReceipt({
    is_salary_receipt: true,
    confidence: 0.7,
    empresa: parsed.empresa || 'Empresa sin identificar',
    empleado: null,
    periodo: parsed.periodo,
    fecha_pago: parsed.fecha_pago || null,
    total_bruto: parsed.total_bruto || null,
    total_neto: parsed.total_neto,
    total_haberes: null,
    total_retenciones: null,
    moneda: 'ARS',
    conceptos: [],
    notas: 'Carga manual por Telegram'
  }, { chatId: String(chatId), fileName: 'carga-manual', mimeType: 'text/plain', bufferHash: `manual:${Date.now()}` });
  return { ok: true as const, result };
}

export async function listSalaryReceipts(args = '', limit = 15) {
  const period = extractPeriodFromText(args);
  let q = supabase.from('sueldos_recibos').select('*').order('periodo', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
  if (period) q = q.eq('periodo', period);
  const { data, error } = await q;
  if (error) throw error;
  const tokens = norm(args).split(/\s+/).filter(Boolean).filter(t => !MONTHS[t] && !/^20\d{2}$/.test(t));
  const rows = data || [];
  if (!tokens.length) return rows;
  return rows.filter((r: any) => tokens.every(tok => norm([r.empresa, r.empleado, r.periodo, r.estado].filter(Boolean).join(' ')).includes(tok)));
}

export async function getLastSalaryReceipt() {
  const { data, error } = await supabase.from('sueldos_recibos').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getSalaryConcepts(args = '') {
  const last = norm(args).includes('ultimo') || norm(args).includes('último') || !args.trim();
  let receipt: any = null;
  if (last) receipt = await getLastSalaryReceipt();
  else {
    const period = extractPeriodFromText(args);
    if (period) {
      const { data, error } = await supabase.from('sueldos_recibos').select('*').eq('periodo', period).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      receipt = data;
    }
  }
  if (!receipt) return { receipt: null, concepts: [] as any[] };
  const { data, error } = await supabase.from('sueldos_conceptos').select('*').eq('recibo_id', receipt.id).order('orden', { ascending: true });
  if (error) throw error;
  return { receipt, concepts: data || [] };
}

export async function confirmLastSalaryReceipt() {
  const last = await getLastSalaryReceipt();
  if (!last) return { ok: false as const, message: 'No encontré recibos.' };
  const { data, error } = await supabase.from('sueldos_recibos').update({ estado: 'confirmado', updated_at: new Date().toISOString() }).eq('id', last.id).select().single();
  if (error) throw error;
  if (last.movimiento_financiero_id) {
    await supabase.from('finanzas_movimientos').update({ estado: 'confirmado' }).eq('id', last.movimiento_financiero_id);
  }
  return { ok: true as const, recibo: data };
}

export async function correctLastSalaryReceiptFromText(text: string) {
  const last = await getLastSalaryReceipt();
  if (!last) return { ok: false as const, message: 'No encontré recibos para corregir.' };
  const patch = parseSalaryCorrection(text);
  if (!Object.keys(patch).length) return { ok: false as const, message: 'No detecté corrección. Ejemplo: /sueldo corregir neto 3744369 bruto 4667076 periodo 2026-02' };
  const { data, error } = await supabase.from('sueldos_recibos').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', last.id).select().single();
  if (error) throw error;
  if (data.movimiento_financiero_id && patch.total_neto) {
    await supabase.from('finanzas_movimientos').update({ monto: patch.total_neto, fecha_movimiento: data.fecha_pago || last.fecha_pago, periodo_resumen: data.periodo || last.periodo }).eq('id', data.movimiento_financiero_id);
  }
  return { ok: true as const, recibo: data, patch };
}

export async function summarizeSalaryFromText(text: string, overrides?: { startPeriod?: string; endPeriod?: string; concept?: string | null; excludeConcept?: boolean }) {
  // El router de intencion (Gemini) puede resolver el periodo/concepto el mismo
  // y pasarlos ya normalizados (YYYY-MM), evitando los limites de
  // extractSalaryPeriodRange/extractConceptTarget (que no entienden rangos como
  // "entre el mes 3 y el 5" ni "entre marzo y mayo"). Sin overrides, el
  // comportamiento es igual que siempre (parseo por texto).
  const period = overrides?.startPeriod && overrides?.endPeriod
    ? { startPeriod: overrides.startPeriod, endPeriod: overrides.endPeriod }
    : extractSalaryPeriodRange(text);
  const targetConcept = overrides && overrides.concept !== undefined ? overrides.concept : extractConceptTarget(text);
  const excludeConcept = !!overrides?.excludeConcept;
  const { data: receipts, error } = await supabase
    .from('sueldos_recibos')
    .select('*')
    .gte('periodo', period.startPeriod)
    .lte('periodo', period.endPeriod)
    .order('periodo', { ascending: true })
    .limit(200);
  if (error) throw error;

  let concepts: any[] = [];
  if (targetConcept && (receipts || []).length) {
    const ids = (receipts || []).map((r: any) => r.id);
    const { data, error: conceptError } = await supabase.from('sueldos_conceptos').select('*, sueldos_recibos(periodo,empresa)').in('recibo_id', ids).limit(1000);
    if (conceptError) throw conceptError;
    concepts = (data || []).filter((c: any) => norm(c.concepto || '').includes(targetConcept));
  }

  return { period, receipts: receipts || [], targetConcept, excludeConcept, concepts };
}

export function formatSalaryImportResult(result: ImportSalaryResult) {
  if (!result.recognized) return `No parece recibo de sueldo.${result.message ? `\n${result.message}` : ''}`;
  const r = result.recibo || {};
  const lines = [result.duplicate ? 'Recibo de sueldo ya cargado.' : 'Recibo de sueldo importado.', ''];
  lines.push(`Empresa: ${r.empresa || '-'}`);
  lines.push(`Período: ${r.periodo || '-'}`);
  if (r.fecha_pago) lines.push(`Fecha de pago: ${r.fecha_pago}`);
  lines.push(`Total bruto: ${money(r.total_bruto)}`);
  lines.push(`Total neto: ${money(r.total_neto)}`);
  if (r.total_retenciones != null) lines.push(`Retenciones: ${money(r.total_retenciones)}`);
  lines.push(`Estado: ${r.estado || '-'}`);
  if (result.conceptsInserted) lines.push(`Conceptos guardados: ${result.conceptsInserted}`);
  if (result.movimiento?.id || r.movimiento_financiero_id) lines.push('Ingreso financiero asociado: sí');
  if (r.estado === 'pendiente_revision') lines.push('', 'Revisalo con: /sueldo ultimo y confirmá con /sueldo confirmar ultimo');
  return lines.join('\n');
}

export function formatSalaryList(rows: any[], title = 'Sueldos cargados') {
  if (!rows.length) return `${title}\n\nSin recibos.`;
  const lines = [title, ''];
  for (const r of rows.slice(0, 15)) {
    lines.push(`• ${r.periodo || '-'} — ${r.empresa || '-'} — Neto ${money(r.total_neto)}`);
    lines.push(`  Bruto ${money(r.total_bruto)} / Retenciones ${money(r.total_retenciones)} / ${r.estado || '-'}`);
  }
  return lines.join('\n');
}

export function formatSalaryReceipt(r: any) {
  if (!r) return 'No encontré recibos de sueldo.';
  return [
    'Último recibo de sueldo',
    '',
    `Empresa: ${r.empresa || '-'}`,
    `Empleado: ${r.empleado || '-'}`,
    `Período: ${r.periodo || '-'}`,
    `Fecha de pago: ${r.fecha_pago || '-'}`,
    `Total bruto: ${money(r.total_bruto)}`,
    `Total neto: ${money(r.total_neto)}`,
    `Haberes: ${money(r.total_haberes)}`,
    `Retenciones: ${money(r.total_retenciones)}`,
    `Estado: ${r.estado || '-'}`,
    `Ingreso financiero asociado: ${r.movimiento_financiero_id ? 'sí' : 'no'}`,
    '',
    'Para ver conceptos: /sueldo conceptos ultimo'
  ].join('\n');
}

export function formatSalaryConcepts(result: Awaited<ReturnType<typeof getSalaryConcepts>>) {
  if (!result.receipt) return 'No encontré recibo para listar conceptos.';
  const lines = [`Conceptos del recibo ${result.receipt.periodo || ''}`, '', `Empresa: ${result.receipt.empresa || '-'}`, ''];
  if (!result.concepts.length) {
    lines.push('Sin conceptos extraídos.');
    return lines.join('\n');
  }
  for (const c of result.concepts) {
    lines.push(`• ${c.concepto || '-'} — ${c.tipo || '-'} — ${money(c.importe)}`);
    if (c.codigo || c.unidades) lines.push(`  Código: ${c.codigo || '-'} / Unidades: ${c.unidades || '-'}`);
  }
  return lines.join('\n').slice(0, 3900);
}

export function formatSalarySummary(summary: Awaited<ReturnType<typeof summarizeSalaryFromText>>) {
  const rows = summary.receipts;
  const lines = ['Reporte de sueldo', '', `Período: ${summary.period.startPeriod} a ${summary.period.endPeriod}`];
  if (!rows.length) return [...lines, '', 'No encontré recibos cargados para ese período.'].join('\n');

  const totalNeto = rows.reduce((a: number, r: any) => a + Number(r.total_neto || 0), 0);
  const totalBruto = rows.reduce((a: number, r: any) => a + Number(r.total_bruto || 0), 0);
  const totalRet = rows.reduce((a: number, r: any) => a + Number(r.total_retenciones || 0), 0);
  lines.push(`Recibos: ${rows.length}`);
  lines.push(`Total neto: ${money(totalNeto)}`);
  lines.push(`Total bruto: ${money(totalBruto)}`);
  lines.push(`Total retenciones: ${money(totalRet)}`);

  if (summary.targetConcept) {
    lines.push('', `Concepto consultado: ${summary.targetConcept}${summary.excludeConcept ? ' (excluido del total)' : ''}`);
    if (!summary.concepts.length) {
      // Antes: con 0 coincidencias igual mostraba "Total concepto: $0.00", indistinguible
      // de un concepto real en $0. Ahora se avisa explicitamente que no hubo coincidencias.
      lines.push('No encontre ese concepto en los recibos de este periodo (puede que el recibo lo nombre distinto, o que no lo haya tenido).');
      if (summary.excludeConcept) lines.push(`Como no aparece en ningún recibo, el neto sin ese concepto es igual al total neto: ${money(totalNeto)}`);
    } else {
      const totalConcept = summary.concepts.reduce((a: number, c: any) => a + Number(c.importe || 0), 0);
      if (summary.excludeConcept) {
        lines.push(`Total neto SIN ${summary.targetConcept}: ${money(totalNeto - totalConcept)}`);
        lines.push(`(Total neto con todo: ${money(totalNeto)} — ${summary.targetConcept}: ${money(totalConcept)})`);
      } else {
        lines.push(`Total concepto: ${money(totalConcept)}`);
      }
      for (const c of summary.concepts.slice(0, 12)) {
        const periodo = c.sueldos_recibos?.periodo || '-';
        const unidades = c.unidades ? ` (${c.unidades})` : '';
        lines.push(`• ${periodo}: ${c.concepto}${unidades} — ${money(c.importe)}`);
      }
    }
  } else {
    lines.push('', 'Por período:');
    for (const r of rows.slice(0, 24)) lines.push(`• ${r.periodo || '-'}: neto ${money(r.total_neto)} / bruto ${money(r.total_bruto)}`);
  }

  if (rows.length >= 2) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const diff = Number(last.total_neto || 0) - Number(first.total_neto || 0);
    lines.push('', `Variación neta ${first.periodo || 'inicio'} → ${last.periodo || 'fin'}: ${money(diff)}`);
  }
  return lines.join('\n').slice(0, 3900);
}

function parseManualSalaryText(text: string) {
  return {
    periodo: extractPeriodFromText(text),
    fecha_pago: extractDateAfter(text, 'fecha') || extractDateAfter(text, 'pago'),
    total_neto: extractAmountAfter(text, 'neto'),
    total_bruto: extractAmountAfter(text, 'bruto'),
    empresa: extractTextAfter(text, 'empresa') || extractTextAfter(text, 'empleador') || 'Empresa sin identificar'
  };
}

function parseSalaryCorrection(text: string) {
  const patch: Record<string, any> = {};
  const neto = extractAmountAfter(text, 'neto');
  const bruto = extractAmountAfter(text, 'bruto');
  const ret = extractAmountAfter(text, 'retenciones') || extractAmountAfter(text, 'descuentos');
  const periodo = extractPeriodFromText(text);
  const fecha = extractDateAfter(text, 'fecha') || extractDateAfter(text, 'pago');
  const empresa = extractTextAfter(text, 'empresa');
  if (neto) patch.total_neto = neto;
  if (bruto) patch.total_bruto = bruto;
  if (ret) patch.total_retenciones = ret;
  if (periodo) patch.periodo = periodo;
  if (fecha) patch.fecha_pago = fecha;
  if (empresa) patch.empresa = empresa;
  patch.estado = 'confirmado';
  return patch;
}

function sanitizeParsedSalary(input: any): ParsedSalaryReceipt {
  const obj = input && typeof input === 'object' ? input : {};
  return {
    is_salary_receipt: Boolean(obj.is_salary_receipt),
    confidence: clampNumber(obj.confidence, 0, 1) ?? 0,
    empresa: cleanText(obj.empresa),
    empleado: cleanText(obj.empleado),
    legajo: cleanText(obj.legajo),
    cuil: cleanText(obj.cuil),
    periodo: normalizePeriod(obj.periodo || ''),
    fecha_pago: normalizeDate(obj.fecha_pago || ''),
    fecha_ingreso: normalizeDate(obj.fecha_ingreso || ''),
    categoria: cleanText(obj.categoria),
    contratacion: cleanText(obj.contratacion),
    total_bruto: moneyOrNull(obj.total_bruto),
    total_neto: moneyOrNull(obj.total_neto),
    total_haberes: moneyOrNull(obj.total_haberes),
    total_retenciones: moneyOrNull(obj.total_retenciones),
    total_asignaciones: moneyOrNull(obj.total_asignaciones),
    total_no_remunerativo: moneyOrNull(obj.total_no_remunerativo),
    moneda: cleanText(obj.moneda) || 'ARS',
    conceptos: Array.isArray(obj.conceptos) ? obj.conceptos.map((c: any) => ({
      concepto: cleanText(c.concepto) || 'Concepto sin nombre',
      codigo: cleanText(c.codigo),
      unidades: c.unidades == null ? null : String(c.unidades),
      tipo: normalizeConceptType(c.tipo),
      importe: moneyOrNull(c.importe)
    })) : [],
    texto_extraido: cleanText(obj.texto_extraido),
    notas: cleanText(obj.notas)
  };
}

function sanitizeConcepts(concepts: ParsedSalaryConcept[]) {
  return concepts
    .map(c => ({
      concepto: cleanText(c.concepto) || '',
      codigo: cleanText(c.codigo),
      unidades: c.unidades ?? null,
      tipo: normalizeConceptType(c.tipo),
      importe: moneyOrNull(c.importe)
    }))
    .filter(c => c.concepto && c.importe != null);
}

function normalizeConceptType(value: any): SalaryConceptType {
  const t = norm(String(value || ''));
  if (t.includes('ret')) return 'retencion';
  if (t.includes('asig')) return 'asignacion';
  if (t.includes('no_rem') || t.includes('no remun')) return 'no_remunerativo';
  if (t.includes('hab')) return 'haber';
  return 'otro';
}

function periodLabel(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function extractSalaryPeriodRange(text: string) {
  const t = norm(text);
  const now = new Date();
  const yearMatch = t.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : now.getFullYear();
  const singlePeriod = extractPeriodFromText(text);
  if (singlePeriod) return { startPeriod: singlePeriod, endPeriod: singlePeriod };

  // "el mes pasado" / "mes anterior": un solo periodo, el mes calendario anterior a hoy.
  // Antes esto no estaba contemplado y caia directo al default de "todo el año".
  if (t.includes('mes pasado') || t.includes('mes anterior')) {
    const p = periodLabel(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    return { startPeriod: p, endPeriod: p };
  }

  // "este mes": un solo periodo, el mes actual.
  if (t.includes('este mes')) {
    const p = periodLabel(now);
    return { startPeriod: p, endPeriod: p };
  }

  // "ultimos/ultimos N meses": ventana relativa real, contando hacia atras desde el mes actual.
  // Antes "ultimos" (sin leer el numero) devolvia siempre un rango fijo de ~24 meses.
  const monthsBackMatch = t.match(/(?:ultimos?|últimos?)\s+(\d{1,2})\s*mes(?:es)?/);
  if (monthsBackMatch) {
    const n = Math.max(1, Math.min(60, Number(monthsBackMatch[1])));
    const endPeriod = periodLabel(now);
    const startPeriod = periodLabel(new Date(now.getFullYear(), now.getMonth() - (n - 1), 1));
    return { startPeriod, endPeriod };
  }

  // "el año pasado" / "año anterior": el año calendario completo anterior (no el actual).
  // Quedo pendiente ayer, lo cierro ahora de paso porque es el mismo tipo de bug.
  if (t.includes('ano pasado') || t.includes('año pasado') || t.includes('ano anterior') || t.includes('año anterior')) {
    return { startPeriod: `${year - 1}-01`, endPeriod: `${year - 1}-12` };
  }

  if (t.includes('este ano') || t.includes('este año')) return { startPeriod: `${year}-01`, endPeriod: `${year}-12` };
  if (t.includes('ano') || t.includes('año')) return { startPeriod: `${year}-01`, endPeriod: `${year}-12` };

  // "ultimos/ultimos" suelto sin numero: antes ~24 meses fijos; ahora 12 meses reales desde hoy.
  if (t.includes('ultimos') || t.includes('últimos')) {
    const endPeriod = periodLabel(now);
    const startPeriod = periodLabel(new Date(now.getFullYear(), now.getMonth() - 11, 1));
    return { startPeriod, endPeriod };
  }

  return { startPeriod: `${year}-01`, endPeriod: `${year}-12` };
}

function extractConceptTarget(text: string) {
  const t = norm(text);
  if (t.includes('ganancias')) return 'ganancias';
  if (/\bhoras?\s+extras?\b/.test(t)) return 'horas extra';
  if (t.includes('obra social')) return 'obra social';
  if (t.includes('jubilatorio') || t.includes('jubilacion') || t.includes('jubilación')) return 'jubilatorio';
  if (t.includes('antiguedad') || t.includes('antigüedad')) return 'antiguedad';

  // Antes: cualquier concepto fuera de esta lista de 5 devolvia null y el reporte mostraba
  // el total neto/bruto general sin avisar que no encontro el concepto pedido.
  // Ahora: si la pregunta menciona otro concepto (presentismo, adicional, vacaciones, etc.),
  // se usa como termino de busqueda generico contra el nombre real del concepto en el recibo.
  const cleaned = t
    .replace(/[¿?¡!.,;:]+/g, ' ')
    .replace(/^\/?sueldo\s*/, '')
    // "pasado/anterior/proximo/actual/corriente" describen CUANDO, no un concepto del recibo.
    // Sin esto, "cuanto cobre el mes pasado" devolvia targetConcept="pasado" (bug real, visto en vivo).
    .replace(/\b(cu[aá]nto|cuanto|gan[eé]|gane|cobr[eé]|cobro|me pagaron|total|neto|bruto|recibo|de|del|los|las|el|la|en|mi|mis|este|esta|ano|año|mes|meses|ultimos?|últimos?|pasado|pasada|anterior|proximo|próximo|actual|corriente)\b/g, ' ')
    // Los nombres de mes describen CUANDO, no un concepto del recibo (mismo motivo por el
    // que ya se sacan "pasado/anterior/proximo" arriba). Sin esto, "cuanto gane de X en
    // mayo" dejaba targetConcept = "X mayo" en vez de "X", y nunca encontraba el concepto.
    .replace(new RegExp(`\\b(${Object.keys(MONTHS).join('|')})\\b`, 'g'), ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 2 ? cleaned : null;
}

function extractPeriodFromText(text: string) {
  const raw = String(text || '');
  const direct = raw.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])\b/);
  if (direct) return `${direct[1]}-${direct[2].padStart(2, '0')}`;
  const rev = raw.match(/\b(0?[1-9]|1[0-2])[-/](20\d{2})\b/);
  if (rev) return `${rev[2]}-${rev[1].padStart(2, '0')}`;
  const t = norm(raw);
  const year = (t.match(/\b(20\d{2})\b/) || [])[1] || String(new Date().getFullYear());
  for (const [name, month] of Object.entries(MONTHS)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) return `${year}-${month}`;
  }
  return null;
}

function normalizePeriod(value: string) {
  return extractPeriodFromText(String(value || ''));
}

function periodFromDate(value: string) {
  const d = normalizeDate(value);
  return d ? d.slice(0, 7) : null;
}

function normalizeDate(value: string) {
  const raw = String(value || '').trim();
  const iso = raw.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const ar = raw.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2}|\d{2})\b/);
  if (ar) {
    const year = ar[3].length === 2 ? `20${ar[3]}` : ar[3];
    return `${year}-${ar[2].padStart(2, '0')}-${ar[1].padStart(2, '0')}`;
  }
  return null;
}

function extractDateAfter(text: string, label: string) {
  const re = new RegExp(`${label}[^0-9]{0,20}(\\d{1,2}[/-]\\d{1,2}[/-](?:20)?\\d{2}|20\\d{2}-\\d{1,2}-\\d{1,2})`, 'i');
  const m = String(text || '').match(re);
  return m ? normalizeDate(m[1]) : null;
}

function extractAmountAfter(text: string, label: string) {
  const re = new RegExp(`${label}[^0-9-]{0,30}([0-9][0-9.,]*)`, 'i');
  const m = String(text || '').match(re);
  return m ? parseMoney(m[1]) : null;
}

function extractTextAfter(text: string, label: string) {
  const re = new RegExp(`${label}[:=]?\\s+(.+?)(?:\\s+(?:periodo|neto|bruto|fecha|empresa|empleador)\\b|$)`, 'i');
  const m = String(text || '').match(re);
  return cleanText(m?.[1] || null);
}

function parseMoney(value: any): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? roundMoney(value) : null;
  let s = String(value).trim().replace(/\s/g, '');
  if (!s) return null;
  s = s.replace(/\$/g, '');
  const negative = s.startsWith('-');
  s = s.replace(/^-/, '');
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return roundMoney(negative ? -n : n);
}

function moneyOrNull(value: any) {
  return parseMoney(value);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function money(value: any) {
  const n = Number(value || 0);
  return `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cleanText(value: any) {
  if (value == null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s || null;
}

function buildSalaryDedupeKey(empresa: string, periodo: string | null, empleado: string | null, bufferHash: string | null) {
  if (periodo) return `sueldo:${normalizeKey(empresa)}:${periodo}:${normalizeKey(empleado || '')}`;
  return `sueldo:${normalizeKey(empresa)}:${bufferHash || Date.now()}`;
}

function normalizeKey(value: string) {
  return norm(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'sin-dato';
}

function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseJsonLoose(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try { return JSON.parse(slice); } catch {}
  }
  return { is_salary_receipt: false, notas: `No pude parsear JSON: ${raw.slice(0, 200)}` };
}

function clampNumber(value: any, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function norm(value: string) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
