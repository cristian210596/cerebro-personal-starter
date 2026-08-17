import crypto from 'node:crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config.js';
import { supabase } from './supabaseClient.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey() });

export type ImportedMovement = {
  fecha: string | null;
  descripcion_original: string;
  comercio: string | null;
  comprobante: string | null;
  monto: number | null;
  moneda: string;
  tipo: string;
  cuota_actual: number | null;
  cuotas_totales: number | null;
  categoria_sugerida: string | null;
  subcategoria_sugerida: string | null;
  confianza: number;
  raw: any;
};

type ParsedFinanceDocument = {
  es_resumen_financiero: boolean;
  tipo_fuente: string;
  proveedor: string | null;
  cuenta: string | null;
  tarjeta: string | null;
  periodo: string | null;
  fecha_cierre: string | null;
  fecha_vencimiento: string | null;
  total_pesos: number | null;
  total_dolares: number | null;
  pago_minimo: number | null;
  movimientos: ImportedMovement[];
};

const movementSchema = {
  type: Type.OBJECT,
  properties: {
    fecha: { type: Type.STRING, nullable: true },
    descripcion_original: { type: Type.STRING },
    comercio: { type: Type.STRING, nullable: true },
    comprobante: { type: Type.STRING, nullable: true },
    monto: { type: Type.NUMBER, nullable: true },
    moneda: { type: Type.STRING },
    tipo: { type: Type.STRING },
    cuota_actual: { type: Type.NUMBER, nullable: true },
    cuotas_totales: { type: Type.NUMBER, nullable: true },
    categoria_sugerida: { type: Type.STRING, nullable: true },
    subcategoria_sugerida: { type: Type.STRING, nullable: true },
    confianza: { type: Type.NUMBER },
    raw: { type: Type.STRING, nullable: true }
  },
  required: ['fecha', 'descripcion_original', 'comercio', 'comprobante', 'monto', 'moneda', 'tipo', 'cuota_actual', 'cuotas_totales', 'categoria_sugerida', 'subcategoria_sugerida', 'confianza', 'raw']
};

const documentSchema = {
  type: Type.OBJECT,
  properties: {
    es_resumen_financiero: { type: Type.BOOLEAN },
    tipo_fuente: { type: Type.STRING },
    proveedor: { type: Type.STRING, nullable: true },
    cuenta: { type: Type.STRING, nullable: true },
    tarjeta: { type: Type.STRING, nullable: true },
    periodo: { type: Type.STRING, nullable: true },
    fecha_cierre: { type: Type.STRING, nullable: true },
    fecha_vencimiento: { type: Type.STRING, nullable: true },
    total_pesos: { type: Type.NUMBER, nullable: true },
    total_dolares: { type: Type.NUMBER, nullable: true },
    pago_minimo: { type: Type.NUMBER, nullable: true },
    movimientos: { type: Type.ARRAY, items: movementSchema }
  },
  required: ['es_resumen_financiero', 'tipo_fuente', 'proveedor', 'cuenta', 'tarjeta', 'periodo', 'fecha_cierre', 'fecha_vencimiento', 'total_pesos', 'total_dolares', 'pago_minimo', 'movimientos']
};

const EXTRACT_PROMPT = `
Extraé movimientos financieros de este archivo para un sistema personal de finanzas.

Objetivo:
- Detectar si es resumen de tarjeta, movimientos de Mercado Pago/banco, o documento financiero similar.
- Extraer consumos/movimientos reales, no textos legales ni publicidad.
- En resúmenes de tarjeta, extraer principalmente el DETALLE DEL CONSUMO.
- No extraigas SALDO ANTERIOR ni TOTAL A PAGAR como gasto.
- Los pagos de tarjeta como "SU PAGO EN PESOS" deben ser tipo="pago_tarjeta", no gasto.
- Impuestos, intereses y cargos del resumen pueden extraerse como tipo="cargo_financiero".
- Si un consumo está en dólares, moneda="USD" y monto debe ser el importe en dólares.
- Si un consumo está en pesos, moneda="ARS".
- Si aparece cuota tipo 01/03, cuota_actual=1 y cuotas_totales=3.
- Si no aparece cuota, cuota_actual y cuotas_totales null.
- Fechas en formato YYYY-MM-DD. Si el año aparece abreviado, inferilo desde el período/cierre del resumen.
- Categorías sugeridas admitidas: Supermercado; Alimentos; Comida afuera; Transporte; Casa; Servicios; Salud; Farmacia; Ropa; Tecnología; Educación; Trabajo; Ocio; Regalos; Suscripciones; Impuestos; Alquiler; Auto; Transferencias; Deudas / compartidos; Ingreso laboral; Gastos financieros; Otros.
- Para OPENAI, CHATGPT, GOOGLE, YOUTUBE, NETFLIX, SPOTIFY u otros cargos recurrentes, usá Suscripciones si corresponde.
- Para CABIFY, SUBE, combustible, taxi/remis: Transporte.
- Para universidad/cursos: Educación.
- Para ABL, AYSA, Telecentro, luz, gas, internet: Servicios o Impuestos según corresponda.
- No inventes movimientos si la línea no está clara.

Devolvé solo JSON según schema.
`;

export function looksLikeFinanceFile(fileName = '', mimeType = '', caption = '') {
  const t = norm([fileName, mimeType, caption].join(' '));
  if (!t) return false;
  return /resumen|tarjeta|visa|master|mastercard|mercado\s*pago|movimientos|extracto|cuenta|galicia|uala|brubank|banco|consumos/.test(t);
}

export function looksLikeImportCommand(text: string) {
  const t = norm(text);
  return /^\/?(importacion|importación|importaciones|clasificar|ignorar importado|reporte gasto|reporte gastos|gasto anual|gastos anuales)\b/.test(t);
}

export function looksLikeFinanceAnalyticsText(text: string) {
  const t = norm(text);
  if (/^\/?reporte gasto/.test(t) || /^\/?gasto anual/.test(t) || /^\/?gastos anuales/.test(t)) return true;
  return /(cu[aá]nto|cuanto|total|gast[eé]|gaste|gastaste|vengo gastando|llevo gastado).*(chat\s*gpt|chatgpt|openai|spotify|netflix|youtube|suscripci[oó]n|suscripciones|visa|master|mercado pago)/.test(t);
}

export async function importFinanceFile(input: {
  buffer: Buffer;
  fileName?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  chatId: number;
  itemId?: string | null;
  archivoId?: string | null;
}) {
  const fileName = input.fileName || 'archivo';
  const mimeType = input.mimeType || 'application/octet-stream';
  const hash = sha256(input.buffer);

  const existing = await findExistingImport(hash);
  if (existing) {
    return {
      recognized: true as const,
      duplicate: true,
      importacion: existing,
      stats: await buildImportStats(existing.id),
      nextPending: await getNextPendingImportedMovement(existing.id)
    };
  }

  let parsed: ParsedFinanceDocument | null = null;
  if (isCsvLike(fileName, mimeType)) {
    parsed = parseCsvFinance(input.buffer.toString('utf8'), fileName);
  } else {
    parsed = await extractFinanceDocumentWithGemini(input.buffer, mimeType, fileName, input.caption || '');
  }

  if (!parsed?.es_resumen_financiero || !Array.isArray(parsed.movimientos) || !parsed.movimientos.length) {
    return { recognized: false as const, duplicate: false };
  }

  const importacion = await createImportation(parsed, {
    fileName,
    mimeType,
    hash,
    chatId: input.chatId,
    itemId: input.itemId || null,
    archivoId: input.archivoId || null
  });

  const rows = normalizeImportedMovements(parsed, importacion.id);
  const inserted = await insertImportedRows(rows);
  const processed = await autoProcessImportedRowsWithRules(inserted);
  const stats = await buildImportStats(importacion.id);
  const nextPending = await getNextPendingImportedMovement(importacion.id);

  await updateImportationState(importacion.id);

  return {
    recognized: true as const,
    duplicate: false,
    importacion,
    processed,
    stats,
    nextPending
  };
}

async function extractFinanceDocumentWithGemini(buffer: Buffer, mimeType: string, fileName: string, caption: string): Promise<ParsedFinanceDocument> {
  const response = await ai.models.generateContent({
    model: config.geminiModel(),
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${EXTRACT_PROMPT}\nArchivo: ${fileName}\nComentario del usuario: ${caption || '-'}` },
          { inlineData: { mimeType: mimeType || 'application/pdf', data: buffer.toString('base64') } }
        ]
      }
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: documentSchema
    }
  });

  const raw = response.text;
  if (!raw) throw new Error('Gemini no devolvió extracción financiera');
  return normalizeParsedDocument(JSON.parse(raw));
}

function parseCsvFinance(text: string, fileName: string): ParsedFinanceDocument {
  const rows = parseDelimited(text).slice(0, 1000);
  const movements: ImportedMovement[] = [];

  for (const row of rows) {
    const keys = Object.keys(row);
    const joined = keys.map(k => `${k}: ${row[k]}`).join(' | ');
    const fecha = findDateInText(joined);
    const monto = findAmountInRow(row);
    const descripcion = findDescriptionInRow(row) || joined.slice(0, 220);
    if (!fecha || monto === null || !descripcion) continue;
    movements.push({
      fecha,
      descripcion_original: descripcion,
      comercio: guessCommerce(descripcion),
      comprobante: null,
      monto: Math.abs(monto),
      moneda: /usd|dolar|dólar/i.test(joined) ? 'USD' : 'ARS',
      tipo: monto < 0 ? 'gasto' : 'movimiento',
      cuota_actual: null,
      cuotas_totales: null,
      categoria_sugerida: null,
      subcategoria_sugerida: null,
      confianza: 0.25,
      raw: row
    });
  }

  return normalizeParsedDocument({
    es_resumen_financiero: movements.length > 0,
    tipo_fuente: norm(fileName).includes('mercado') ? 'mercado_pago_csv' : 'csv_movimientos',
    proveedor: norm(fileName).includes('mercado') ? 'Mercado Pago' : null,
    cuenta: null,
    tarjeta: null,
    periodo: null,
    fecha_cierre: null,
    fecha_vencimiento: null,
    total_pesos: null,
    total_dolares: null,
    pago_minimo: null,
    movimientos: movements
  });
}

function normalizeParsedDocument(parsed: any): ParsedFinanceDocument {
  const movements = Array.isArray(parsed?.movimientos) ? parsed.movimientos : [];
  return {
    es_resumen_financiero: Boolean(parsed?.es_resumen_financiero),
    tipo_fuente: clean(parsed?.tipo_fuente) || 'documento_financiero',
    proveedor: clean(parsed?.proveedor) || null,
    cuenta: clean(parsed?.cuenta) || null,
    tarjeta: normalizeCard(parsed?.tarjeta),
    periodo: normalizePeriod(parsed?.periodo, parsed?.fecha_cierre, parsed?.fecha_vencimiento),
    fecha_cierre: normalizeDate(parsed?.fecha_cierre),
    fecha_vencimiento: normalizeDate(parsed?.fecha_vencimiento),
    total_pesos: toNumberOrNull(parsed?.total_pesos),
    total_dolares: toNumberOrNull(parsed?.total_dolares),
    pago_minimo: toNumberOrNull(parsed?.pago_minimo),
    movimientos: movements.map(normalizeMovement).filter((m: ImportedMovement) => m.descripcion_original && m.monto !== null)
  };
}

function normalizeMovement(m: any): ImportedMovement {
  const cuota = parseInstallment(m?.cuota || m?.cuotas || m?.cuota_texto || '');
  const current = toIntegerOrNull(m?.cuota_actual) ?? cuota.current;
  const total = toIntegerOrNull(m?.cuotas_totales) ?? cuota.total;
  const desc = clean(m?.descripcion_original || m?.descripcion || m?.referencia || '');
  return {
    fecha: normalizeDate(m?.fecha),
    descripcion_original: desc,
    comercio: clean(m?.comercio) || guessCommerce(desc),
    comprobante: clean(m?.comprobante) || null,
    monto: toNumberOrNull(m?.monto),
    moneda: normalizeCurrency(m?.moneda),
    tipo: normalizeMovementType(m?.tipo, desc),
    cuota_actual: current,
    cuotas_totales: total,
    categoria_sugerida: normalizeCategory(m?.categoria_sugerida),
    subcategoria_sugerida: clean(m?.subcategoria_sugerida) || null,
    confianza: clamp(Number(m?.confianza ?? 0.4), 0, 1),
    raw: m?.raw || m || {}
  };
}

async function createImportation(parsed: ParsedFinanceDocument, meta: any) {
  const { data, error } = await supabase
    .from('finanzas_importaciones')
    .insert({
      tipo_fuente: parsed.tipo_fuente,
      proveedor: parsed.proveedor,
      cuenta: parsed.cuenta,
      tarjeta: parsed.tarjeta,
      periodo: parsed.periodo,
      fecha_cierre: parsed.fecha_cierre,
      fecha_vencimiento: parsed.fecha_vencimiento,
      total_pesos: parsed.total_pesos,
      total_dolares: parsed.total_dolares,
      pago_minimo: parsed.pago_minimo,
      estado: 'procesando',
      archivo_id: meta.archivoId,
      item_id: meta.itemId,
      telegram_chat_id: String(meta.chatId),
      nombre_archivo: meta.fileName,
      mime_type: meta.mimeType,
      archivo_hash: meta.hash,
      resumen_json: parsed as any
    })
    .select()
    .single();
  if (error) throw error;

  if (parsed.tarjeta && (parsed.total_pesos || parsed.total_dolares)) {
    await upsertCardStatement(parsed, data.id);
  }

  return data;
}

async function upsertCardStatement(parsed: ParsedFinanceDocument, importacionId: string) {
  const amount = parsed.total_pesos || 0;
  if (!amount || !parsed.tarjeta) return;
  const periodo = parsed.periodo || parsed.fecha_cierre?.slice(0, 7) || new Date().toISOString().slice(0, 7);
  const { data: existing } = await supabase
    .from('finanzas_cierres')
    .select('*')
    .eq('tarjeta', parsed.tarjeta)
    .eq('periodo', periodo)
    .limit(1)
    .maybeSingle();

  const patch: any = {
    tarjeta: parsed.tarjeta,
    periodo,
    monto_total: amount,
    saldo_pendiente: amount,
    moneda: 'ARS',
    fecha_cierre: parsed.fecha_cierre,
    fecha_vencimiento: parsed.fecha_vencimiento,
    estado: 'pendiente',
    notas: `Importado desde resumen ${importacionId}`,
    updated_at: new Date().toISOString()
  };

  if (existing?.id) {
    await supabase.from('finanzas_cierres').update({ ...patch, monto_pagado: existing.monto_pagado || 0, saldo_pendiente: Math.max(0, amount - Number(existing.monto_pagado || 0)) }).eq('id', existing.id);
  } else {
    await supabase.from('finanzas_cierres').insert({ ...patch, monto_pagado: 0 });
  }
}

function normalizeImportedMovements(parsed: ParsedFinanceDocument, importacionId: string) {
  return parsed.movimientos
    .filter(m => shouldKeepImportedMovement(m))
    .map(m => {
      const rule = builtInRuleFor(m);
      const category = rule?.categoria || m.categoria_sugerida || null;
      const subcategory = rule?.subcategoria || m.subcategoria_sugerida || null;
      const confidence = Math.max(m.confianza || 0, rule?.confianza || 0);
      const merchantKey = merchantKeyFrom(m.comercio || m.descripcion_original);
      const externalHash = buildMovementHash(importacionId, m);
      return {
        importacion_id: importacionId,
        external_hash: externalHash,
        fecha_movimiento: m.fecha,
        descripcion_original: m.descripcion_original,
        descripcion_normalizada: normalizeMerchantText(m.descripcion_original),
        comercio_detectado: rule?.comercio || m.comercio,
        merchant_key: merchantKey,
        comprobante: m.comprobante,
        monto: m.monto,
        moneda: m.moneda,
        tipo: m.tipo,
        tarjeta: parsed.tarjeta,
        proveedor: parsed.proveedor,
        cuota_actual: m.cuota_actual,
        cuotas_totales: m.cuotas_totales,
        categoria_sugerida: category,
        subcategoria_sugerida: subcategory,
        confianza_clasificacion: confidence,
        estado: confidence >= 0.78 ? 'clasificado' : 'pendiente_revision',
        raw_json: m.raw || m
      };
    });
}

function shouldKeepImportedMovement(m: ImportedMovement) {
  if (!m || m.monto === null || !m.descripcion_original) return false;
  const d = norm(m.descripcion_original);
  if (/saldo anterior|total a pagar|pago minimo|pago mínimo|limite|l[ií]mite/.test(d)) return false;
  return true;
}

async function insertImportedRows(rows: any[]) {
  if (!rows.length) return [];
  const inserted: any[] = [];
  for (const row of rows) {
    const { data, error } = await supabase
      .from('finanzas_movimientos_importados')
      .upsert(row, { onConflict: 'external_hash' })
      .select()
      .single();
    if (error) throw error;
    inserted.push(data);
  }
  return inserted;
}

async function autoProcessImportedRows(rows: any[]) {
  const stats = { autoInserted: 0, matchedManual: 0, pending: 0, ignored: 0 };
  for (const row of rows) {
    if (row.estado === 'ignorado' || row.movimiento_id) continue;
    if (row.estado === 'pendiente_revision') {
      stats.pending += 1;
      continue;
    }

    const match = await findManualMatch(row);
    if (match) {
      const updated = await mergeImportedIntoMovement(row, match);
      await markImportedConciliated(row, updated, match.score, match.reason);
      stats.matchedManual += 1;
      continue;
    }

    const movement = await createMovementFromImported(row);
    await supabase.from('finanzas_movimientos_importados').update({ estado: 'importado', movimiento_id: movement.id, updated_at: new Date().toISOString() }).eq('id', row.id);
    stats.autoInserted += 1;
  }
  return stats;
}

async function createMovementFromImported(row: any) {
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .insert({
      fecha_movimiento: row.fecha_movimiento || new Date().toISOString().slice(0, 10),
      tipo: mapImportedTypeToMovementType(row.tipo),
      monto: Number(row.monto || 0),
      moneda: row.moneda || 'ARS',
      descripcion: row.descripcion_original,
      categoria_financiera: row.categoria_confirmada || row.categoria_sugerida || 'Otros',
      subcategoria_financiera: row.subcategoria_confirmada || row.subcategoria_sugerida || null,
      medio_pago: row.tarjeta ? `${row.tarjeta} crédito` : row.proveedor || null,
      tarjeta: row.tarjeta || null,
      banco_billetera: row.proveedor || null,
      comercio: row.comercio_detectado || row.descripcion_original,
      cuotas: row.cuotas_totales || null,
      estado: 'confirmado',
      origen: 'importacion',
      importacion_id: row.importacion_id,
      movimiento_importado_id: row.id,
      external_hash: row.external_hash,
      comprobante: row.comprobante,
      cuota_actual: row.cuota_actual,
      cuotas_totales: row.cuotas_totales,
      periodo_resumen: await getImportPeriod(row.importacion_id),
      merchant_key: row.merchant_key
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getImportPeriod(importacionId: string) {
  const { data } = await supabase.from('finanzas_importaciones').select('periodo').eq('id', importacionId).maybeSingle();
  return data?.periodo || null;
}

async function findManualMatch(row: any): Promise<null | { movement: any; score: number; reason: string }> {
  if (!row.fecha_movimiento || !row.monto) return null;
  const start = shiftDate(row.fecha_movimiento, -1);
  const end = shiftDate(row.fecha_movimiento, 1);
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .gte('fecha_movimiento', start)
    .lte('fecha_movimiento', end)
    .limit(200);
  if (error) throw error;

  let best: { movement: any; score: number; reason: string } | null = null;
  for (const movement of data || []) {
    if (movement.external_hash && movement.external_hash === row.external_hash) continue;
    const score = matchScore(row, movement);
    if (score.score >= 0.82 && (!best || score.score > best.score)) best = { movement, score: score.score, reason: score.reason };
  }
  return best;
}

function matchScore(row: any, movement: any) {
  const amountA = Number(row.monto || 0);
  const amountB = Number(movement.monto || 0);
  const amountDiff = Math.abs(amountA - amountB);
  const amountTol = Math.max(60, Math.abs(amountA) * 0.035);
  let score = 0;
  const reasons: string[] = [];
  if (amountDiff <= amountTol) { score += 0.55; reasons.push('monto parecido'); }
  if (sameOrNearDate(row.fecha_movimiento, movement.fecha_movimiento)) { score += 0.2; reasons.push('fecha cercana'); }
  const rowPay = norm([row.tarjeta, row.proveedor].filter(Boolean).join(' '));
  const movPay = norm([movement.medio_pago, movement.tarjeta, movement.banco_billetera].filter(Boolean).join(' '));
  if (!rowPay || !movPay || rowPay.split(/\s+/).some(x => x && movPay.includes(x))) { score += 0.1; reasons.push('medio compatible'); }
  const rowText = norm([row.descripcion_original, row.comercio_detectado].filter(Boolean).join(' '));
  const movText = norm([movement.descripcion, movement.comercio, movement.categoria_financiera].filter(Boolean).join(' '));
  if (textOverlapScore(rowText, movText) > 0.15) { score += 0.15; reasons.push('texto relacionado'); }
  // Caso clave: gasto manual aproximado sin comercio real. Monto + fecha bastan bastante.
  if (amountDiff <= amountTol && sameOrNearDate(row.fecha_movimiento, movement.fecha_movimiento) && !movement.external_hash) score += 0.12;
  return { score: Math.min(1, score), reason: reasons.join(', ') };
}

async function mergeImportedIntoMovement(row: any, match: { movement: any; score: number; reason: string }) {
  const current = match.movement;
  const patch: any = {
    monto: Number(row.monto || current.monto || 0),
    moneda: row.moneda || current.moneda || 'ARS',
    comercio: row.comercio_detectado || current.comercio || null,
    descripcion: mergeDescription(current.descripcion, row.descripcion_original),
    medio_pago: current.medio_pago || (row.tarjeta ? `${row.tarjeta} crédito` : row.proveedor || null),
    tarjeta: current.tarjeta || row.tarjeta || null,
    banco_billetera: current.banco_billetera || row.proveedor || null,
    categoria_financiera: current.categoria_financiera || row.categoria_confirmada || row.categoria_sugerida || null,
    subcategoria_financiera: current.subcategoria_financiera || row.subcategoria_confirmada || row.subcategoria_sugerida || null,
    cuotas: current.cuotas || row.cuotas_totales || null,
    origen: current.origen || 'manual_conciliado',
    importacion_id: row.importacion_id,
    movimiento_importado_id: row.id,
    external_hash: row.external_hash,
    comprobante: row.comprobante || current.comprobante || null,
    cuota_actual: row.cuota_actual || current.cuota_actual || null,
    cuotas_totales: row.cuotas_totales || current.cuotas_totales || null,
    periodo_resumen: await getImportPeriod(row.importacion_id),
    merchant_key: row.merchant_key || current.merchant_key || null,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('finanzas_movimientos').update(patch).eq('id', current.id).select().single();
  if (error) throw error;
  return data;
}

async function markImportedConciliated(row: any, movement: any, score: number, reason: string) {
  await supabase.from('finanzas_movimientos_importados').update({ estado: 'conciliado', movimiento_id: movement.id, match_score: score, match_reason: reason, updated_at: new Date().toISOString() }).eq('id', row.id);
  await supabase.from('finanzas_conciliaciones').insert({ movimiento_importado_id: row.id, movimiento_id: movement.id, tipo_match: 'automatico', score, estado: 'confirmado', notas: reason });
}

export async function listFinanceImports(limit = 10) {
  const { data, error } = await supabase.from('finanzas_importaciones').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

export async function latestFinanceImport() {
  const { data, error } = await supabase.from('finanzas_importaciones').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getNextPendingImportedMovement(importacionId?: string | null) {
  let q = supabase.from('finanzas_movimientos_importados').select('*').eq('estado', 'pendiente_revision').order('created_at', { ascending: true }).limit(1);
  if (importacionId) q = q.eq('importacion_id', importacionId);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getPendingImportedMovements(limit = 12) {
  const { data, error } = await supabase.from('finanzas_movimientos_importados').select('*, finanzas_importaciones(periodo,tarjeta,proveedor,nombre_archivo)').eq('estado', 'pendiente_revision').order('created_at', { ascending: true }).limit(limit);
  if (error) throw error;
  return data || [];
}

export async function classifyImportedMovementByIndex(index: number, categoryText: string, saveRule: boolean) {
  const rows = await getPendingImportedMovements(30);
  const row = rows[index - 1];
  if (!row) return { ok: false as const, message: `No encontré pendiente #${index}. Usá /importacion revisar.` };
  const parsed = parseCategoryAndSubcategory(categoryText);
  if (!parsed.category) return { ok: false as const, message: 'Indicá categoría. Ejemplo: /clasificar 1 Suscripciones guardar regla' };

  const patch = {
    categoria_confirmada: parsed.category,
    subcategoria_confirmada: parsed.subcategory,
    estado: 'clasificado',
    confianza_clasificacion: 1,
    updated_at: new Date().toISOString()
  };
  const { data: updated, error } = await supabase.from('finanzas_movimientos_importados').update(patch).eq('id', row.id).select().single();
  if (error) throw error;

  let rule = null;
  if (saveRule) rule = await saveCommerceRuleFromImported(updated, parsed.category, parsed.subcategory);

  const match = await findManualMatch(updated);
  let movement: any;
  let action = 'importado';
  if (match) {
    movement = await mergeImportedIntoMovement(updated, match);
    await markImportedConciliated(updated, movement, match.score, `clasificado por usuario; ${match.reason}`);
    action = 'conciliado';
  } else {
    movement = await createMovementFromImported(updated);
    await supabase.from('finanzas_movimientos_importados').update({ estado: 'importado', movimiento_id: movement.id, updated_at: new Date().toISOString() }).eq('id', updated.id);
  }

  await updateImportationState(row.importacion_id);
  return { ok: true as const, imported: updated, movement, rule, action, nextPending: await getNextPendingImportedMovement() };
}

async function saveCommerceRuleFromImported(row: any, category: string, subcategory: string | null) {
  const patron = row.merchant_key || merchantKeyFrom(row.comercio_detectado || row.descripcion_original);
  const { data, error } = await supabase
    .from('finanzas_reglas_comercios')
    .upsert({
      patron,
      comercio_normalizado: row.comercio_detectado || row.descripcion_original,
      categoria_financiera: category,
      subcategoria_financiera: subcategory,
      medio_pago: row.tarjeta ? `${row.tarjeta} crédito` : row.proveedor || null,
      aplicar_auto: true,
      confianza: 1,
      ejemplos: [row.descripcion_original],
      updated_at: new Date().toISOString()
    }, { onConflict: 'patron' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function ignoreImportedMovementByIndex(index: number) {
  const rows = await getPendingImportedMovements(30);
  const row = rows[index - 1];
  if (!row) return { ok: false as const, message: `No encontré pendiente #${index}. Usá /importacion revisar.` };
  const { error } = await supabase.from('finanzas_movimientos_importados').update({ estado: 'ignorado', updated_at: new Date().toISOString() }).eq('id', row.id);
  if (error) throw error;
  await updateImportationState(row.importacion_id);
  return { ok: true as const, imported: row, nextPending: await getNextPendingImportedMovement() };
}

export async function buildImportStats(importacionId: string) {
  const { data, error } = await supabase.from('finanzas_movimientos_importados').select('estado').eq('importacion_id', importacionId).limit(1000);
  if (error) throw error;
  const stats: Record<string, number> = { total: 0 };
  for (const row of data || []) {
    stats.total += 1;
    stats[row.estado || 'sin_estado'] = (stats[row.estado || 'sin_estado'] || 0) + 1;
  }
  return stats;
}

async function updateImportationState(importacionId: string) {
  const stats = await buildImportStats(importacionId);
  const state = stats.pendiente_revision ? 'revision_pendiente' : 'procesada';
  await supabase.from('finanzas_importaciones').update({ estado: state, updated_at: new Date().toISOString() }).eq('id', importacionId);
}

async function findExistingImport(hash: string) {
  const { data, error } = await supabase.from('finanzas_importaciones').select('*').eq('archivo_hash', hash).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function summarizeFinanceAnalytics(text: string) {
  const target = extractAnalyticsTarget(text);
  const period = extractAnalyticsPeriod(text);
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .gte('fecha_movimiento', period.start)
    .lte('fecha_movimiento', period.end)
    .order('fecha_movimiento', { ascending: true })
    .limit(2000);
  if (error) throw error;
  const rows = (data || []).filter((row: any) => matchesAnalyticsTarget(row, target));
  return { target, period, rows, totals: totalsByCurrency(rows), monthly: totalsByMonthAndCurrency(rows) };
}

export function formatFinanceAnalyticsReport(report: Awaited<ReturnType<typeof summarizeFinanceAnalytics>>) {
  const { target, period, rows, totals, monthly } = report;
  if (!rows.length) return `Reporte financiero: ${target.label}\n\nNo encontré movimientos para ${target.label} en ${period.label}.`;
  const lines = [`Reporte financiero: ${target.label}`, '', `Período: ${period.label}`, `Movimientos: ${rows.length}`];
  lines.push('');
  lines.push('Totales:');
  for (const [currency, total] of Object.entries(totals)) {
    lines.push(`- ${currency}: ${formatMoney(total, currency)}`);
  }
  lines.push('');
  lines.push('Por mes:');
  for (const key of Object.keys(monthly).sort()) {
    const group = monthly[key];
    const parts = Object.entries(group).map(([currency, total]) => `${formatMoney(total, currency)}`).join(' + ');
    lines.push(`- ${key}: ${parts}`);
  }
  const months = Object.keys(monthly).length;
  if (months > 0) {
    lines.push('');
    lines.push('Promedio mensual sobre meses con gasto:');
    for (const [currency, total] of Object.entries(totals)) {
      lines.push(`- ${currency}: ${formatMoney(total / months, currency)}`);
    }
  }
  lines.push('');
  lines.push('Últimos movimientos:');
  for (const row of rows.slice(-6).reverse()) {
    lines.push(`- ${row.fecha_movimiento}: ${formatMoney(Number(row.monto || 0), row.moneda || 'ARS')} — ${row.comercio || row.descripcion || '-'}`);
  }
  return lines.join('\n');
}

export function formatImportResult(result: Awaited<ReturnType<typeof importFinanceFile>>) {
  if (!result.recognized) return '';
  const imp = result.importacion;
  const stats = result.stats || {};
  const lines = [result.duplicate ? 'Resumen financiero ya importado.' : 'Resumen financiero importado.', ''];
  lines.push(`Fuente: ${imp.proveedor || imp.tipo_fuente || '-'}`);
  if (imp.tarjeta) lines.push(`Tarjeta: ${imp.tarjeta}`);
  if (imp.periodo) lines.push(`Periodo: ${imp.periodo}`);
  if (imp.fecha_vencimiento) lines.push(`Vencimiento: ${imp.fecha_vencimiento}`);
  if (imp.total_pesos) lines.push(`Total pesos: ${formatMoney(Number(imp.total_pesos), 'ARS')}`);
  if (imp.total_dolares) lines.push(`Total dólares: ${formatMoney(Number(imp.total_dolares), 'USD')}`);
  lines.push('');
  lines.push(`Movimientos detectados: ${stats.total || 0}`);
  lines.push(`Importados: ${stats.importado || 0}`);
  lines.push(`Conciliados con manuales: ${stats.conciliado || 0}`);
  lines.push(`Pendientes de clasificar: ${stats.pendiente_revision || 0}`);
  lines.push(`Ignorados: ${stats.ignorado || 0}`);
  if (result.nextPending) {
    lines.push('', 'Próximo pendiente:');
    lines.push(formatOnePending(result.nextPending, 1));
    lines.push('', 'Respondé: /clasificar 1 Categoria guardar regla');
    lines.push('Ejemplo: /clasificar 1 Suscripciones guardar regla');
  }
  return lines.join('\n');
}

export function formatImports(rows: any[]) {
  if (!rows.length) return 'Importaciones financieras\n\nSin importaciones.';
  const lines = ['Importaciones financieras', ''];
  for (const row of rows) {
    lines.push(`• ${row.created_at?.slice(0, 10) || '-'} — ${row.proveedor || row.tipo_fuente || '-'} ${row.tarjeta || ''} ${row.periodo || ''}`.trim());
    lines.push(`  Estado: ${row.estado || '-'} — Archivo: ${row.nombre_archivo || '-'}`);
  }
  return lines.join('\n');
}

export function formatPendingImported(rows: any[]) {
  if (!rows.length) return 'Importación financiera\n\nNo hay movimientos pendientes de clasificar.';
  const lines = ['Movimientos importados pendientes', ''];
  rows.forEach((row, idx) => lines.push(formatOnePending(row, idx + 1), ''));
  lines.push('Para clasificar: /clasificar 1 Categoria guardar regla');
  lines.push('Para ignorar: /ignorar importado 1');
  return lines.join('\n');
}

function formatOnePending(row: any, index: number) {
  const imp = row.finanzas_importaciones || {};
  return [
    `#${index} — ${row.fecha_movimiento || '-'} — ${formatMoney(Number(row.monto || 0), row.moneda || 'ARS')}`,
    `${row.comercio_detectado || row.descripcion_original || '-'}`,
    `Fuente: ${imp.proveedor || row.proveedor || '-'} ${imp.tarjeta || row.tarjeta || ''} ${imp.periodo || ''}`.trim(),
    `Sugerencia: ${row.categoria_sugerida || 'sin categoría'} (${Math.round(Number(row.confianza_clasificacion || 0) * 100)}%)`
  ].join('\n');
}

export function formatClassifyImportedResult(result: Awaited<ReturnType<typeof classifyImportedMovementByIndex>>) {
  if (!result.ok) return result.message;
  const lines = ['Movimiento clasificado.', '', `Acción: ${result.action === 'conciliado' ? 'conciliado con gasto existente' : 'importado como gasto'}`, `Comercio: ${result.movement.comercio || '-'}`, `Categoría: ${result.movement.categoria_financiera || '-'}`, `Monto: ${formatMoney(Number(result.movement.monto || 0), result.movement.moneda || 'ARS')}`];
  if (result.rule) lines.push('Regla guardada para próximos resúmenes.');
  if (result.nextPending) {
    lines.push('', 'Siguiente pendiente:', formatOnePending(result.nextPending, 1));
  }
  return lines.join('\n');
}

export function formatIgnoreImportedResult(result: Awaited<ReturnType<typeof ignoreImportedMovementByIndex>>) {
  if (!result.ok) return result.message;
  const lines = ['Movimiento importado ignorado.', '', `${result.imported.fecha_movimiento || '-'} — ${result.imported.descripcion_original || '-'}`];
  if (result.nextPending) lines.push('', 'Siguiente pendiente:', formatOnePending(result.nextPending, 1));
  return lines.join('\n');
}

function builtInRuleFor(m: ImportedMovement) {
  const t = norm([m.descripcion_original, m.comercio].filter(Boolean).join(' '));
  const rules = [
    { re: /openai|chatgpt|chat\s*gpt/, comercio: 'OpenAI / ChatGPT', categoria: 'Suscripciones', subcategoria: 'Herramientas IA', confianza: 0.99 },
    { re: /google.*youtube|youtube/, comercio: 'YouTube / Google', categoria: 'Suscripciones', subcategoria: 'Entretenimiento', confianza: 0.92 },
    { re: /netflix|spotify|prime video|disney/, comercio: null, categoria: 'Suscripciones', subcategoria: 'Entretenimiento', confianza: 0.92 },
    { re: /cabify|uber|didi|taxi|remis|sube/, comercio: null, categoria: 'Transporte', subcategoria: null, confianza: 0.9 },
    { re: /combustible|ypf|shell|axion|puma/, comercio: null, categoria: 'Auto', subcategoria: 'Combustible', confianza: 0.88 },
    { re: /aysa|telecentro|metrogas|edenor|edesur|movistar|personal|claro/, comercio: null, categoria: 'Servicios', subcategoria: null, confianza: 0.9 },
    { re: /\babl\b|agip|arca|afip|rentas/, comercio: null, categoria: 'Impuestos', subcategoria: null, confianza: 0.9 },
    { re: /univ|universidad|kennedy|pagos360.*kennedy/, comercio: 'Universidad Kennedy', categoria: 'Educación', subcategoria: 'Universidad', confianza: 0.95 },
    { re: /farmacity|farmacia/, comercio: null, categoria: 'Farmacia', subcategoria: null, confianza: 0.85 },
    { re: /carrefour|coto|dia|jumbo|disco|vea|maxi|supermercado/, comercio: null, categoria: 'Supermercado', subcategoria: null, confianza: 0.82 },
    { re: /restaurant|gastro|food|bar|cafe|caf[eé]|pizzeria|mcdonald|burger|mostaza|jamon|jam[oó]n|delivery/, comercio: null, categoria: 'Comida afuera', subcategoria: null, confianza: 0.8 }
  ];
  const match = rules.find(r => r.re.test(t));
  if (match) return { ...match, comercio: match.comercio || m.comercio || guessCommerce(m.descripcion_original) };
  return null;
}

async function loadSavedRule(row: any) {
  const key = row.merchant_key || merchantKeyFrom(row.comercio_detectado || row.descripcion_original);
  const { data, error } = await supabase.from('finanzas_reglas_comercios').select('*').eq('aplicar_auto', true).limit(500);
  if (error) throw error;
  return (data || []).find((r: any) => key.includes(r.patron) || r.patron.includes(key)) || null;
}

async function applySavedRule(row: any) {
  const rule = await loadSavedRule(row);
  if (!rule) return row;
  return {
    ...row,
    comercio_detectado: rule.comercio_normalizado || row.comercio_detectado,
    categoria_sugerida: rule.categoria_financiera || row.categoria_sugerida,
    subcategoria_sugerida: rule.subcategoria_financiera || row.subcategoria_sugerida,
    confianza_clasificacion: Math.max(Number(row.confianza_clasificacion || 0), Number(rule.confianza || 0.95)),
    estado: 'clasificado',
    regla_id: rule.id
  };
}

// Overwrite inserted rows with user-learned rules before auto processing.
async function applyRulesToInsertedRows(rows: any[]) {
  const out: any[] = [];
  for (const row of rows) {
    const patched = await applySavedRule(row);
    if (patched !== row || patched.regla_id) {
      const { data, error } = await supabase.from('finanzas_movimientos_importados').update({
        comercio_detectado: patched.comercio_detectado,
        categoria_sugerida: patched.categoria_sugerida,
        subcategoria_sugerida: patched.subcategoria_sugerida,
        confianza_clasificacion: patched.confianza_clasificacion,
        estado: patched.estado,
        regla_id: patched.regla_id,
        updated_at: new Date().toISOString()
      }).eq('id', row.id).select().single();
      if (error) throw error;
      out.push(data);
    } else out.push(row);
  }
  return out;
}

// Patch autoProcess entry to use saved rules.
async function autoProcessImportedRowsWithRules(rows: any[]) {
  return autoProcessImportedRows(await applyRulesToInsertedRows(rows));
}

// Replace reference at runtime by exporting compatible helper name in code path above.
// Kept as function declaration below for clarity in stack traces.

function parseDelimited(text: string) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [] as Record<string, string>[];
  const sep = chooseSep(lines[0]);
  const headers = splitCsvLine(lines[0], sep).map(h => clean(h) || 'col');
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line, sep);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => row[h] = values[i] || '');
    return row;
  });
}

function chooseSep(header: string) {
  const semis = (header.match(/;/g) || []).length;
  const commas = (header.match(/,/g) || []).length;
  const tabs = (header.match(/\t/g) || []).length;
  if (tabs >= semis && tabs >= commas) return '\t';
  return semis >= commas ? ';' : ',';
}

function splitCsvLine(line: string, sep: string) {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { q = !q; continue; }
    if (!q && ch === sep) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function findAmountInRow(row: Record<string, string>) {
  const preferred = Object.entries(row).find(([k]) => /monto|importe|total|valor|amount/i.test(k));
  if (preferred) {
    const n = parseAmountLoose(preferred[1]);
    if (n !== null) return n;
  }
  for (const value of Object.values(row)) {
    const n = parseAmountLoose(value);
    if (n !== null && Math.abs(n) > 0) return n;
  }
  return null;
}

function findDescriptionInRow(row: Record<string, string>) {
  const preferred = Object.entries(row).find(([k]) => /descripcion|descripción|detalle|comercio|concepto|referencia|operacion|operación/i.test(k));
  if (preferred) return clean(preferred[1]);
  return clean(Object.values(row).sort((a, b) => b.length - a.length)[0] || '');
}

function findDateInText(text: string) {
  const iso = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}`;
  const ar = text.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2}|\d{2})\b/);
  if (ar) return normalizeDate(`${ar[1]}-${ar[2]}-${ar[3]}`);
  return null;
}

function isCsvLike(fileName: string, mimeType: string) {
  return /\.csv$|\.txt$/i.test(fileName) || /csv|text\/plain|excel|spreadsheet/i.test(mimeType);
}

function normalizeMovementType(type: any, desc: string) {
  const t = norm([type, desc].join(' '));
  if (/pago tarjeta|su pago|pago en pesos|payment/.test(t)) return 'pago_tarjeta';
  if (/interes|interés|iva|iibb|sellos|rg\s*5617|cargo|comision|comisión|impuesto/.test(t)) return 'cargo_financiero';
  if (/devolucion|devolución|reintegro/.test(t)) return 'devolucion';
  if (/transferencia/.test(t)) return 'transferencia';
  return 'gasto';
}

function mapImportedTypeToMovementType(type: string) {
  const t = norm(type);
  if (t.includes('pago_tarjeta')) return 'transferencia';
  if (t.includes('devolucion')) return 'devolucion';
  if (t.includes('transferencia')) return 'transferencia';
  return 'gasto';
}

function normalizeCard(value: any) {
  const t = norm(value);
  if (t.includes('master')) return 'Mastercard';
  if (t.includes('visa')) return 'Visa';
  return clean(value) || null;
}

function normalizeCurrency(value: any) {
  const t = norm(value);
  if (/usd|u\$s|dolar|dólar/.test(t)) return 'USD';
  return 'ARS';
}

function normalizeCategory(value: any) {
  const v = clean(value);
  if (!v) return null;
  const aliases: Record<string, string> = {
    transporte: 'Transporte',
    suscripciones: 'Suscripciones',
    supermercado: 'Supermercado',
    alimentos: 'Alimentos',
    'comida afuera': 'Comida afuera',
    servicios: 'Servicios',
    impuestos: 'Impuestos',
    educacion: 'Educación',
    educación: 'Educación',
    farmacia: 'Farmacia',
    tecnologia: 'Tecnología',
    tecnología: 'Tecnología',
    ocio: 'Ocio',
    casa: 'Casa',
    auto: 'Auto',
    otros: 'Otros',
    'gastos financieros': 'Gastos financieros'
  };
  return aliases[norm(v)] || v;
}

function normalizePeriod(period: any, closing?: any, due?: any) {
  const p = clean(period);
  const iso = p?.match(/(20\d{2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${pad2(iso[2])}`;
  const fromDate = normalizeDate(closing) || normalizeDate(due);
  return fromDate ? fromDate.slice(0, 7) : p || null;
}

function normalizeDate(value: any) {
  if (!value) return null;
  const s = clean(value);
  if (!s) return null;
  const iso = s.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}`;
  const ar = s.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2}|\d{2})\b/);
  if (ar) {
    const year = ar[3].length === 2 ? `20${ar[3]}` : ar[3];
    return `${year}-${pad2(ar[2])}-${pad2(ar[1])}`;
  }
  return null;
}

function parseInstallment(value: string) {
  const m = String(value || '').match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  return { current: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null };
}

function parseCategoryAndSubcategory(text: string) {
  let s = text.replace(/guardar regla|siempre|recordar/gi, '').trim();
  s = s.replace(/^como\s+/i, '').trim();
  const parts = s.split(/[/>|]/).map(x => clean(x)).filter(Boolean);
  return { category: normalizeCategory(parts[0]), subcategory: parts[1] || null };
}

function extractAnalyticsTarget(text: string) {
  const t = norm(text);
  if (/chat\s*gpt|chatgpt|openai/.test(t)) return { label: 'ChatGPT / OpenAI', terms: ['openai', 'chatgpt', 'chat gpt'] };
  const cleaned = t
    .replace(/^\/?reporte gastos?\s*/g, '')
    .replace(/cu[aá]nto|cuanto|gaste|gast[eé]|gastaste|total|en|este|esta|año|ano|mes|llevo|vengo|suscripcion|suscripción|de|la|el|los|las|por/g, ' ')
    .replace(/\b20\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const terms = cleaned ? cleaned.split(' ').filter(x => x.length > 2) : [];
  return { label: terms.join(' ') || 'gastos consultados', terms };
}

function extractAnalyticsPeriod(text: string) {
  const t = norm(text);
  const now = new Date();
  const yearMatch = t.match(/\b(20\d{2})\b/);
  let year = yearMatch ? Number(yearMatch[1]) : now.getFullYear();
  if (/año pasado|ano pasado/.test(t)) year -= 1;
  const month = monthFromText(t);
  if (month) {
    const start = `${year}-${month}-01`;
    const end = lastDayOfMonth(year, Number(month));
    return { label: `${year}-${month}`, start, end };
  }
  return { label: String(year), start: `${year}-01-01`, end: `${year}-12-31` };
}

function monthFromText(t: string) {
  const months: Record<string, string> = { enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06', julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12' };
  for (const [name, value] of Object.entries(months)) if (t.includes(name)) return value;
  return null;
}

function matchesAnalyticsTarget(row: any, target: { terms: string[] }) {
  if (!target.terms.length) return true;
  const haystack = norm([row.comercio, row.descripcion, row.categoria_financiera, row.subcategoria_financiera, row.medio_pago, row.tarjeta, row.banco_billetera, row.merchant_key].filter(Boolean).join(' '));
  return target.terms.some(term => haystack.includes(norm(term)));
}

function totalsByCurrency(rows: any[]) {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const c = row.moneda || 'ARS';
    out[c] = round((out[c] || 0) + Number(row.monto || 0));
  }
  return out;
}

function totalsByMonthAndCurrency(rows: any[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const month = String(row.fecha_movimiento || row.created_at || '').slice(0, 7) || 'sin-fecha';
    const c = row.moneda || 'ARS';
    out[month] ||= {};
    out[month][c] = round((out[month][c] || 0) + Number(row.monto || 0));
  }
  return out;
}

function buildMovementHash(importacionId: string, m: ImportedMovement) {
  return sha256(Buffer.from([importacionId, m.fecha || '', m.descripcion_original || '', m.comprobante || '', String(m.monto), m.moneda, String(m.cuota_actual || ''), String(m.cuotas_totales || '')].join('|')));
}

function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function clean(value: any) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function norm(value: any) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function normalizeMerchantText(value: string) {
  return norm(value).replace(/[^a-z0-9\s*]/g, ' ').replace(/\s+/g, ' ').trim();
}

function merchantKeyFrom(value: string) {
  return normalizeMerchantText(value)
    .replace(/\b(k|merpago|mercadopago|www|com|ar|sa|srl|argentina|directorios?)\b/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || normalizeMerchantText(value).slice(0, 120);
}

function guessCommerce(desc: string) {
  let d = clean(desc)
    .replace(/^\*\s*/, '')
    .replace(/^K\s+/i, '')
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\b\d{2}\/\d{2}\b/g, '')
    .replace(/USD\s*[\d.,]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return d || null;
}

function toNumberOrNull(value: any) {
  if (typeof value === 'number' && Number.isFinite(value)) return round(value);
  return parseAmountLoose(String(value ?? ''));
}

function toIntegerOrNull(value: any) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseAmountLoose(value: string) {
  const s = String(value || '').trim();
  const m = s.match(/-?\d[\d.,]*/);
  if (!m) return null;
  let raw = m[0];
  const negative = raw.startsWith('-') || /(^|\s)-/.test(s);
  raw = raw.replace(/^-/, '');
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized = raw;
  if (lastComma > lastDot) normalized = raw.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) normalized = raw.replace(/,/g, '');
  else normalized = raw.replace(',', '.');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return round(negative ? -n : n);
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function pad2(value: string | number) {
  return String(value).padStart(2, '0');
}

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sameOrNearDate(a: string, b: string) {
  if (!a || !b) return false;
  return Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) <= 86400000;
}

function textOverlapScore(a: string, b: string) {
  const aa = new Set(a.split(/\s+/).filter(x => x.length >= 4));
  const bb = new Set(b.split(/\s+/).filter(x => x.length >= 4));
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const x of aa) if (bb.has(x)) hit += 1;
  return hit / Math.max(aa.size, bb.size);
}

function mergeDescription(current: string, imported: string) {
  const c = clean(current);
  const i = clean(imported);
  if (!c) return i;
  if (!i || norm(c).includes(norm(i))) return c;
  return `${c} [importado: ${i}]`.slice(0, 800);
}

function formatMoney(value: number, currency: string) {
  const c = currency || 'ARS';
  if (c === 'USD') return `USD ${Number(value || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${Number(value || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

// Rebind implementation with learned rules.
// This line intentionally keeps the public behavior inside importFinanceFile via local function call below.
