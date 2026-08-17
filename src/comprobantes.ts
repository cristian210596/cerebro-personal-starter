import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { withGemini } from './geminiPool.js';
import { supabase } from './supabaseClient.js';

export type ComprobanteItem = {
  codigo?: string | null;
  descripcion: string;
  descripcion_normalizada?: string | null;
  marca?: string | null;
  cantidad?: number | null;
  precio_unitario?: number | null;
  importe?: number | null;
  descuento?: number | null;
  categoria?: string | null;
  subcategoria?: string | null;
  raw_json?: any;
};

export type ParsedComprobante = {
  is_comprobante: boolean;
  tipo_comprobante?: 'ticket' | 'factura' | 'recibo' | 'otro' | null;
  confidence?: number | null;
  comercio?: string | null;
  razon_social?: string | null;
  cuit?: string | null;
  sucursal?: string | null;
  punto_venta?: string | null;
  numero_comprobante?: string | null;
  fecha?: string | null;
  total?: number | null;
  subtotal?: number | null;
  descuentos?: number | null;
  impuestos?: number | null;
  moneda?: string | null;
  medio_pago?: string | null;
  tarjeta?: string | null;
  tarjeta_ultimos_4?: string | null;
  cuotas?: number | null;
  importe_cuota?: number | null;
  items?: ComprobanteItem[];
  texto_extraido?: string | null;
  notas?: string | null;
};

type ImportComprobanteInput = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  caption?: string;
  chatId: number | string;
  archivoId?: string | null;
  force?: boolean;
};

type PersistContext = {
  archivoId?: string | null;
  chatId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  bufferHash?: string | null;
};

type ImportComprobanteResult = {
  recognized: boolean;
  duplicate?: boolean;
  comprobante?: any | null;
  movimiento?: any | null;
  itemsInserted?: number;
  parsed?: ParsedComprobante | null;
  message?: string;
};

const DEFAULT_PRODUCT_RULES: Array<{ pattern: RegExp; categoria: string; subcategoria?: string; marca?: string }> = [
  { pattern: /\b(ayudin|lavandina|quitamanchas|detergente|jabon|limpiador|glade|rollo\s+d\/?cocina|sussex|esponja|paño|pano|papel\s+higienico)\b/i, categoria: 'Supermercado', subcategoria: 'Limpieza' },
  { pattern: /\b(sensodyne|colgate|odont|shampoo|acondicionador|desodorante|crema|higienol)\b/i, categoria: 'Supermercado', subcategoria: 'Higiene personal' },
  { pattern: /\b(leche|serenisima|pan|bimbo|gallet|traviata|aceite|natura|yerba|taragui|atun|papas|sal\b|azucar|salsa|manteca|limon|mayonesa|dulce\s+de\s+leche|colonial|queso|jamon)\b/i, categoria: 'Supermercado', subcategoria: 'Alimentos' },
  { pattern: /\b(sabana|sábanas|manta|cortina|voile|chenille|algodon|algodón|borlas|arredo|gallo)\b/i, categoria: 'Casa', subcategoria: 'Decoración / ropa de casa' },
  { pattern: /\b(bolsa)\b/i, categoria: 'Compras', subcategoria: 'Bolsas / accesorios' }
];

const COMMERCE_CATEGORY_RULES: Array<{ pattern: RegExp; categoria: string; subcategoria?: string; comercio?: string }> = [
  { pattern: /\bcoto\b/i, categoria: 'Supermercado', subcategoria: 'Supermercado', comercio: 'COTO' },
  { pattern: /\b(arredo|jas\s+diseñ?o|gallo)\b/i, categoria: 'Casa', subcategoria: 'Decoración / ropa de casa', comercio: 'Arredo / Gallo' }
];

export function looksLikeComprobanteFile(fileName = '', mimeType = '', caption = '') {
  const t = norm(`${fileName} ${mimeType} ${caption}`);
  if (/recibo\s+de\s+(sueldo|haberes)|liquidacion\s+salarial|liquidación\s+salarial/.test(t)) return false;
  if (/resumen\s+(visa|master|tarjeta)|visa\d|mastercard|mercado\s*pago\s*movimientos/.test(t)) return false;
  return /\b(ticket|factura|comprobante|recibo\s+de\s+compra|compra\s+coto|coto|arredo|gallo|jas\s+dise|invoice)\b/.test(t);
}

export function looksLikeComprobanteText(text: string) {
  const t = norm(text);
  if (/recibo\s+de\s+(sueldo|haberes)|liquidacion\s+salarial|liquidación\s+salarial/.test(t)) return false;
  if (/comprobante\s+electronico|factura\s+n|factura\s+[abc]|medio\s+de\s+pago|cantidad\s+de\s+articulos\s+comprados|total\s*:\s*\$/.test(t)) return true;
  if (/\bcoto\b/.test(t) && /(nro\.caja|nro\.tran|factura\s+b|tarjeta\s+comunidad|total)/.test(t)) return true;
  return false;
}

export function looksLikeProductQueryText(text: string) {
  const t = norm(text);
  return /(cuanto|cuánto|gaste|gasté|gasto|compr(e|é)|compras?).*(producto|sensodyne|ayudin|coto|arredo|gallo|sabana|sábanas|cortina|limpieza|higiene)|productos?\s+/.test(t);
}

export async function importComprobanteFromFile(input: ImportComprobanteInput): Promise<ImportComprobanteResult> {
  const parsed = await extractComprobante(input.buffer, input.mimeType, input.fileName, input.caption || '', Boolean(input.force));
  if (!parsed.is_comprobante) {
    return { recognized: false, parsed, message: parsed.notas || 'No parece ticket/factura/comprobante de compra.' };
  }

  return persistComprobante(parsed, {
    archivoId: input.archivoId || null,
    chatId: String(input.chatId),
    fileName: input.fileName,
    mimeType: input.mimeType,
    bufferHash: sha256(input.buffer)
  });
}

export async function extractComprobante(buffer: Buffer, mimeType: string, fileName: string, caption = '', force = false): Promise<ParsedComprobante> {
  const pdfText = await tryExtractPdfText(buffer, fileName, mimeType);
  if (pdfText && (looksLikeComprobanteText(pdfText) || force || looksLikeComprobanteFile(fileName, mimeType, caption))) {
    const local = parseKnownTextComprobante(pdfText, fileName, caption);
    if (local.is_comprobante && Number(local.confidence || 0) >= 0.55 && (local.total || (local.items || []).length)) {
      return sanitizeParsedComprobante(local);
    }
  }

  const shouldTryGemini = force || looksLikeComprobanteFile(fileName, mimeType, caption) || isImageLike(mimeType, fileName) || Boolean(pdfText && looksLikeComprobanteText(pdfText));
  if (!shouldTryGemini) {
    return { is_comprobante: false, confidence: 0, texto_extraido: pdfText || null, notas: 'No detecté señales suficientes de ticket/factura.' };
  }

  const geminiParsed = await extractComprobanteWithGemini(buffer, mimeType, fileName, caption, force, pdfText || null);
  if (pdfText && !geminiParsed.texto_extraido) geminiParsed.texto_extraido = pdfText;
  return sanitizeParsedComprobante(geminiParsed);
}

async function extractComprobanteWithGemini(buffer: Buffer, mimeType: string, fileName: string, caption: string, force: boolean, pdfText: string | null): Promise<ParsedComprobante> {
  const prompt = [
    'Analizá este archivo para un sistema personal de finanzas.',
    'Primero decidí si es un ticket, factura, comprobante electrónico o recibo de compra.',
    'NO confundas recibos de sueldo/haberes con comprobantes de compra: si es sueldo, devolvé is_comprobante=false.',
    force ? 'El usuario cree que esto es un comprobante de compra: intentá extraerlo con cuidado.' : 'Si no es claramente un comprobante de compra, devolvé is_comprobante=false.',
    'No inventes datos. Si un dato no se ve, usá null.',
    'Devolvé SOLO JSON válido, sin markdown.',
    '',
    'Schema exacto:',
    '{',
    '  "is_comprobante": true|false,',
    '  "tipo_comprobante": "ticket"|"factura"|"recibo"|"otro"|null,',
    '  "confidence": 0.0-1.0,',
    '  "comercio": string|null,',
    '  "razon_social": string|null,',
    '  "cuit": string|null,',
    '  "sucursal": string|null,',
    '  "punto_venta": string|null,',
    '  "numero_comprobante": string|null,',
    '  "fecha": "YYYY-MM-DD"|null,',
    '  "total": number|null,',
    '  "subtotal": number|null,',
    '  "descuentos": number|null,',
    '  "impuestos": number|null,',
    '  "moneda": "ARS"|"USD"|null,',
    '  "medio_pago": string|null,',
    '  "tarjeta": string|null,',
    '  "tarjeta_ultimos_4": string|null,',
    '  "cuotas": number|null,',
    '  "importe_cuota": number|null,',
    '  "items": [',
    '    {"codigo": string|null, "descripcion": string, "marca": string|null, "cantidad": number|null, "precio_unitario": number|null, "importe": number|null, "descuento": number|null, "categoria": string|null, "subcategoria": string|null}',
    '  ],',
    '  "texto_extraido": string|null,',
    '  "notas": string|null',
    '}',
    '',
    'Reglas:',
    '- Convertí números argentinos: 101.836,10 => 101836.10.',
    '- En tickets de supermercado, cada producto debe ser un item separado con su precio. Si hay descuento, ponelo como descuento del item si podés.',
    '- Si hay líneas de bonificación/descuento separadas, incluilas como items negativos o en descuentos.',
    '- Para facturas en cuotas, total es el total de la factura e importe_cuota es la cuota mensual.',
    '- Categorías útiles: Supermercado, Limpieza, Higiene personal, Alimentos, Casa, Decoración / ropa de casa, Indumentaria, Transporte, Salud, Otros.',
    caption ? `Caption del usuario: ${caption}` : '',
    fileName ? `Nombre de archivo: ${fileName}` : '',
    pdfText ? `Texto extraído localmente del PDF:\n${pdfText.slice(0, 16000)}` : ''
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
  }), { operationName: 'extracción comprobante/ticket' });

  const raw = String(response.text || '').trim();
  return parseJsonLoose(raw) as ParsedComprobante;
}

function parseKnownTextComprobante(text: string, fileName: string, caption = ''): ParsedComprobante {
  const cleaned = cleanPdfText(text);
  const lower = norm(cleaned);
  if (/arredo|jas\s+diseñ?o|gallo/.test(lower) || /comprobante\s+electronico/.test(lower)) {
    return parseArredoGalloInvoice(cleaned, fileName, caption);
  }
  if (/\bcoto\b/.test(lower)) {
    return parseCotoText(cleaned, fileName, caption);
  }
  return { is_comprobante: false, confidence: 0, texto_extraido: cleaned };
}

function parseArredoGalloInvoice(text: string, fileName: string, caption = ''): ParsedComprobante {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const joined = lines.join('\n');
  const fecha = normalizeDate(findFirst(joined, /Fecha:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i));
  const factura = findFirst(joined, /FACTURA\s*N[°º]?\s*([\d\-]+)/i) || findFirst(joined, /N[°º]\s*([\d]{4,5}\-\d{6,12})/i);
  const cuit = findFirst(joined, /C\.U\.I\.T\.?:\s*([\d\-]+)/i) || findFirst(joined, /CUIT:?\s*([\d\-]+)/i);
  const total = parseAmountLoose(findFirst(joined, /Total:\s*\$?\s*([\d.]+,\d{2})/i));
  const subtotal = parseAmountLoose(findFirst(joined, /Subtotal:\s*\$?\s*([\d.]+,\d{2})/i));
  const medioPago = findFirst(joined, /Medio\s+de\s+pago:\s*([^\n]+)/i);
  const cuotas = toInt(findFirst(joined, /Cuotas:\s*(\d+)/i));
  const importeCuota = parseAmountLoose(findFirst(joined, /Importe:\s*\$?\s*([\d.]+,\d{2})\s*\/\s*cuota/i));
  const impuestos = parseAmountLoose(findFirst(joined, /IVA\s+Contenido\s*\$?\s*([\d.]+,\d{2})/i));
  const comercio = /arredo/i.test(joined) ? 'Arredo / Gallo' : 'Gallo';
  const razonSocial = findFirst(joined, /^([A-ZÁÉÍÓÚÑ0-9 .,&-]{4,})$/m) || 'JAS DISEÑO S.A.';

  const itemLines = lines.filter(l => {
    if (!/[\$]/.test(l) || !/21%|10,5%|0%/.test(l)) return false;
    if (/subtotal|total|iva contenido|percep/i.test(l)) return false;
    return true;
  });

  const items = itemLines.map(parseInvoiceItemLine).filter((it): it is ComprobanteItem => Boolean(it));
  for (const item of items) applyProductCategory(item);

  return sanitizeParsedComprobante({
    is_comprobante: Boolean(total || items.length),
    tipo_comprobante: 'factura',
    confidence: total ? 0.92 : 0.65,
    comercio,
    razon_social: cleanText(razonSocial),
    cuit,
    numero_comprobante: factura,
    fecha,
    total,
    subtotal,
    descuentos: sumNegativeItems(items),
    impuestos,
    moneda: 'ARS',
    medio_pago: cleanText(medioPago),
    tarjeta: detectCard(medioPago || ''),
    cuotas,
    importe_cuota: importeCuota,
    items,
    texto_extraido: text,
    notas: caption || null
  });
}

function parseInvoiceItemLine(line: string): ComprobanteItem | null {
  const amounts = [...line.matchAll(/-?\$\s*[\d.]+,\d{2}/g)].map(m => m[0]);
  if (!amounts.length) return null;
  const importe = parseAmountLoose(amounts[amounts.length - 1]);
  const precio = amounts.length >= 2 ? parseAmountLoose(amounts[amounts.length - 2]) : importe;
  const codigo = (line.match(/^([A-Z0-9%\-]+)\s+/i)?.[1] || '').trim() || null;
  let desc = line;
  if (codigo) desc = desc.slice(codigo.length).trim();
  desc = desc.replace(/\s+-?\$\s*[\d.]+,\d{2}\s+\d+(?:,\d+)?%\s+-?\$\s*[\d.]+,\d{2}\s*$/i, '').trim();
  desc = desc.replace(/\s+\d+(?:,\d+)?%\s*$/i, '').trim();
  const qtyMatch = desc.match(/\s(\d+(?:[.,]\d+)?)\s*$/);
  const cantidad = qtyMatch ? parseDecimalLoose(qtyMatch[1]) : 1;
  if (qtyMatch) desc = desc.slice(0, qtyMatch.index).trim();
  desc = desc.replace(/\s+(GALLO|AR|R\d+|X\d+|DMAN|KC|GC|H|R|V)\s*$/i, '').trim();
  const item: ComprobanteItem = {
    codigo,
    descripcion: cleanProductDescription(desc) || line,
    cantidad,
    precio_unitario: precio,
    importe,
    descuento: importe !== null && importe < 0 ? Math.abs(importe) : null,
    raw_json: { line }
  };
  return item;
}

function parseCotoText(text: string, fileName: string, caption = ''): ParsedComprobante {
  const joined = cleanPdfText(text);
  const fechaRaw = findFirst(joined, /(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}:\d{2})/i);
  const fecha = normalizeDate(fechaRaw);
  const total = parseAmountLoose(findFirst(joined, /TOTAL\s+([\d.]+,\d{2})/i)) || parseAmountLoose(findFirst(joined, /Total\s*:?\s*\$?\s*([\d.]+,\d{2})/i));
  const subtotal = parseAmountLoose(findFirst(joined, /SUBTOT\.\s*SIN\s*DESCUENTOS\s+([\d.]+,\d{2})/i));
  const descuentos = Math.abs(parseAmountLoose(findFirst(joined, /DESCUENTOS\s+POR\s+PROMOCIONES\s+(-?[\d.]+,\d{2})/i)) || 0) || null;
  const tarjeta = findFirst(joined, /(VISA|MASTER(?:CARD)?|AMEX|CABAL)\s+(?:xx|x{2})?(\d{4})/i);
  const tarjetaUltimos = findFirst(joined, /(?:xx|x{2})(\d{4})/i);
  const items = parseCotoItemsLoose(joined);
  for (const item of items) applyProductCategory(item);

  return sanitizeParsedComprobante({
    is_comprobante: /\bcoto\b/i.test(joined) && Boolean(total || items.length),
    tipo_comprobante: 'ticket',
    confidence: total ? 0.85 : 0.55,
    comercio: 'COTO',
    razon_social: 'COTO CICSA',
    sucursal: findFirst(joined, /(SUC\d+\s+COTO\s+CICSA[^\n]*)/i),
    fecha,
    total,
    subtotal,
    descuentos,
    moneda: 'ARS',
    medio_pago: tarjeta ? tarjeta : null,
    tarjeta: detectCard(tarjeta || ''),
    tarjeta_ultimos_4: tarjetaUltimos || null,
    items,
    texto_extraido: text,
    notas: caption || null
  });
}

function parseCotoItemsLoose(text: string): ComprobanteItem[] {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const out: ComprobanteItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^(COTO|FACTURA|ORIGINAL|TOTAL|SUBTOT|DESCUENTOS|TARJETA|NRO\.|CUIT|IVA|DATOS|DETALLE)/i.test(line)) continue;
    const maybeAmount = parseAmountLoose(line.match(/([\d.]+,\d{2})\s*$/)?.[1] || null);
    if (maybeAmount !== null && i > 0) {
      const prev = lines[i - 1];
      if (/[A-ZÁÉÍÓÚÑ]{3,}/.test(prev) && !/^\d/.test(prev) && !/TARJETA|COMUNIDAD|NRO\.|CUIT|TOTAL|SUBTOT|DESCUENTOS/i.test(prev)) {
        const item: ComprobanteItem = { descripcion: cleanProductDescription(prev), cantidad: 1, importe: maybeAmount, precio_unitario: maybeAmount, raw_json: { line, prev } };
        applyProductCategory(item);
        out.push(item);
      }
    }
  }
  return dedupeItems(out).slice(0, 160);
}

async function persistComprobante(parsedInput: ParsedComprobante, context: PersistContext): Promise<ImportComprobanteResult> {
  const parsed = sanitizeParsedComprobante(parsedInput);
  if (!parsed.is_comprobante) return { recognized: false, parsed };

  const comercio = normalizeCommerce(parsed.comercio || parsed.razon_social || 'Comercio sin identificar');
  const fecha = normalizeDate(parsed.fecha || '') || null;
  const total = Number(parsed.total || 0) || null;
  const dedupeKey = buildComprobanteDedupeKey(parsed, context.bufferHash || null);

  const existing = await findExistingComprobante(dedupeKey, parsed, context.bufferHash || null);
  if (existing) {
    return { recognized: true, duplicate: true, comprobante: existing, movimiento: existing.movimiento_financiero_id ? { id: existing.movimiento_financiero_id } : null, itemsInserted: 0, parsed, message: 'Ese comprobante ya estaba cargado. No lo dupliqué.' };
  }

  const rawItems = (parsed.items || []).map(sanitizeItem).filter((i): i is ComprobanteItem => Boolean(i && i.descripcion));
  const items = await applyStoredProductRules(rawItems);
  const categoryGuess = categoryFromCommerceOrItems(comercio, items);

  const { data: comprobante, error } = await supabase.from('finanzas_comprobantes').insert({
    archivo_id: context.archivoId || null,
    telegram_chat_id: context.chatId || null,
    nombre_archivo: context.fileName || null,
    mime_type: context.mimeType || null,
    archivo_hash: context.bufferHash || dedupeKey,
    dedupe_key: dedupeKey,
    tipo_comprobante: parsed.tipo_comprobante || 'otro',
    comercio,
    razon_social: cleanText(parsed.razon_social) || comercio,
    cuit: cleanText(parsed.cuit),
    sucursal: cleanText(parsed.sucursal),
    punto_venta: cleanText(parsed.punto_venta),
    numero_comprobante: cleanText(parsed.numero_comprobante),
    fecha_emision: fecha,
    total,
    subtotal: toNumberOrNull(parsed.subtotal),
    descuentos: toNumberOrNull(parsed.descuentos),
    impuestos: toNumberOrNull(parsed.impuestos),
    moneda: parsed.moneda || 'ARS',
    medio_pago: cleanText(parsed.medio_pago),
    tarjeta: normalizeCard(parsed.tarjeta || parsed.medio_pago || ''),
    tarjeta_ultimos_4: cleanText(parsed.tarjeta_ultimos_4),
    cuotas: toInt(parsed.cuotas),
    importe_cuota: toNumberOrNull(parsed.importe_cuota),
    estado: total ? 'pendiente_conciliacion' : 'pendiente_revision',
    texto_extraido: parsed.texto_extraido || null,
    confianza: parsed.confidence || 0,
    raw_json: parsed as any
  }).select().single();
  if (error) throw error;

  let inserted = 0;
  if (items.length) {
    const rows = items.map(item => ({
      comprobante_id: comprobante.id,
      codigo: cleanText(item.codigo),
      descripcion: item.descripcion,
      descripcion_normalizada: normalizeProductKey(item.descripcion),
      marca: cleanText(item.marca) || inferBrand(item.descripcion),
      cantidad: toNumberOrNull(item.cantidad) || 1,
      precio_unitario: toNumberOrNull(item.precio_unitario),
      importe: toNumberOrNull(item.importe),
      descuento: toNumberOrNull(item.descuento),
      categoria: item.categoria || null,
      subcategoria: item.subcategoria || null,
      raw_json: item.raw_json || item
    }));
    const { error: itemsError } = await supabase.from('finanzas_comprobante_items').insert(rows);
    if (itemsError) throw itemsError;
    inserted = rows.length;
  }

  const movimiento = await maybeCreateOrLinkMovement(comprobante, parsed, categoryGuess, dedupeKey);
  if (movimiento?.id) {
    await supabase.from('finanzas_comprobantes').update({ movimiento_financiero_id: movimiento.id, estado: movimiento.__linked ? 'conciliado' : 'confirmado', updated_at: new Date().toISOString() }).eq('id', comprobante.id);
    comprobante.movimiento_financiero_id = movimiento.id;
  }

  return { recognized: true, duplicate: false, comprobante, movimiento: movimiento || null, itemsInserted: inserted, parsed };
}

async function maybeCreateOrLinkMovement(comprobante: any, parsed: ParsedComprobante, categoryGuess: { categoria: string; subcategoria?: string | null }, externalHash: string) {
  const total = Number(comprobante.total || 0);
  if (!total || total <= 0) return null;

  const compatible = await findCompatibleFinanceMovement(comprobante);
  if (compatible) {
    await supabase.from('finanzas_movimientos').update({
      comprobante_id: comprobante.id,
      comercio: compatible.comercio || comprobante.comercio,
      categoria_financiera: compatible.categoria_financiera || categoryGuess.categoria,
      subcategoria_financiera: compatible.subcategoria_financiera || categoryGuess.subcategoria || null,
      updated_at: new Date().toISOString()
    }).eq('id', compatible.id);
    return { ...compatible, __linked: true };
  }

  const cuotas = Number(comprobante.cuotas || 0);
  const isInstallmentCredit = cuotas && cuotas > 1 && normalizeCard(comprobante.tarjeta || comprobante.medio_pago || '');
  if (isInstallmentCredit) {
    // No creamos gasto mensual por el total cuando la factura está en cuotas.
    // El resumen de tarjeta va a cargar el impacto mensual. El comprobante conserva el total y los productos.
    return null;
  }

  const { data: existingByHash, error: hashError } = await supabase.from('finanzas_movimientos').select('*').eq('external_hash', externalHash).limit(1).maybeSingle();
  if (hashError) throw hashError;
  if (existingByHash) return existingByHash;

  const { data, error } = await supabase.from('finanzas_movimientos').insert({
    fecha_movimiento: comprobante.fecha_emision || new Date().toISOString().slice(0, 10),
    tipo: 'gasto',
    monto: total,
    moneda: comprobante.moneda || 'ARS',
    descripcion: `Comprobante ${comprobante.comercio || ''}${comprobante.numero_comprobante ? ` ${comprobante.numero_comprobante}` : ''}`.trim(),
    categoria_financiera: categoryGuess.categoria || 'Compras',
    subcategoria_financiera: categoryGuess.subcategoria || null,
    medio_pago: normalizePaymentMethod(comprobante.medio_pago || comprobante.tarjeta || ''),
    tarjeta: normalizeCard(comprobante.tarjeta || comprobante.medio_pago || ''),
    banco_billetera: null,
    comercio: comprobante.comercio || null,
    cuotas: comprobante.cuotas || null,
    estado: 'confirmado',
    origen: 'comprobante',
    external_hash: externalHash,
    merchant_key: normalizeProductKey(comprobante.comercio || ''),
    comprobante_id: comprobante.id
  }).select().single();
  if (error) throw error;
  return data;
}

async function findCompatibleFinanceMovement(comprobante: any) {
  const total = Number(comprobante.total || 0);
  if (!total || !comprobante.fecha_emision) return null;
  const start = addDays(comprobante.fecha_emision, -3);
  const end = addDays(comprobante.fecha_emision, 5);
  const low = Math.max(0, total - Math.max(50, total * 0.03));
  const high = total + Math.max(50, total * 0.03);
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .eq('tipo', 'gasto')
    .gte('fecha_movimiento', start)
    .lte('fecha_movimiento', end)
    .gte('monto', low)
    .lte('monto', high)
    .order('fecha_movimiento', { ascending: false })
    .limit(10);
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) return null;
  const commerceKey = normalizeProductKey(comprobante.comercio || '');
  return rows.find((r: any) => normalizeProductKey(`${r.comercio || ''} ${r.descripcion || ''}`).includes(commerceKey.slice(0, 8)) || commerceKey.includes(normalizeProductKey(`${r.comercio || ''}`).slice(0, 8))) || rows[0];
}

async function findExistingComprobante(dedupeKey: string, parsed: ParsedComprobante, bufferHash: string | null) {
  if (dedupeKey) {
    const { data, error } = await supabase.from('finanzas_comprobantes').select('*').eq('dedupe_key', dedupeKey).limit(1).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  if (bufferHash) {
    const { data, error } = await supabase.from('finanzas_comprobantes').select('*').eq('archivo_hash', bufferHash).limit(1).maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  if (parsed.fecha && parsed.total) {
    const { data, error } = await supabase.from('finanzas_comprobantes')
      .select('*')
      .eq('fecha_emision', normalizeDate(parsed.fecha))
      .gte('total', Number(parsed.total) - 1)
      .lte('total', Number(parsed.total) + 1)
      .ilike('comercio', `%${(parsed.comercio || parsed.razon_social || '').slice(0, 24)}%`)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  return null;
}

export async function listComprobantes(query = '', limit = 10) {
  let q = supabase.from('finanzas_comprobantes').select('*').order('fecha_emision', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(limit);
  const term = cleanText(query);
  if (term) q = q.or(`comercio.ilike.%${escapeLike(term)}%,razon_social.ilike.%${escapeLike(term)}%,numero_comprobante.ilike.%${escapeLike(term)}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getLastComprobante() {
  const { data, error } = await supabase.from('finanzas_comprobantes').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getComprobanteItems(comprobanteId?: string | null, limit = 80) {
  let id = comprobanteId;
  if (!id) {
    const last = await getLastComprobante();
    id = last?.id || null;
  }
  if (!id) return { comprobante: null, items: [] as any[] };
  const { data: comprobante, error: cError } = await supabase.from('finanzas_comprobantes').select('*').eq('id', id).single();
  if (cError) throw cError;
  const { data: items, error } = await supabase.from('finanzas_comprobante_items').select('*').eq('comprobante_id', id).order('created_at', { ascending: true }).limit(limit);
  if (error) throw error;
  return { comprobante, items: items || [] };
}

export async function listProducts(query = '', limit = 20) {
  let q = supabase.from('finanzas_comprobante_items').select('*, finanzas_comprobantes(fecha_emision,comercio,total,medio_pago,tarjeta)').order('created_at', { ascending: false }).limit(limit);
  const term = cleanText(query);
  if (term) q = q.or(`descripcion.ilike.%${escapeLike(term)}%,marca.ilike.%${escapeLike(term)}%,categoria.ilike.%${escapeLike(term)}%,subcategoria.ilike.%${escapeLike(term)}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function summarizeProductSpending(text: string) {
  const { term, year } = parseProductReportQuery(text);
  if (!term) return { ok: false as const, message: 'Decime producto/comercio/categoría. Ejemplo: cuánto gasté en Sensodyne este año' };
  const yearText = year || new Date().getFullYear().toString();
  const start = `${yearText}-01-01`;
  const end = `${yearText}-12-31`;
  const cleanTerm = cleanText(term) || '';

  const { data, error } = await supabase
    .from('finanzas_comprobante_items')
    .select('*, finanzas_comprobantes!inner(fecha_emision,comercio,total,moneda)')
    .or(`descripcion.ilike.%${escapeLike(cleanTerm)}%,marca.ilike.%${escapeLike(cleanTerm)}%,categoria.ilike.%${escapeLike(cleanTerm)}%,subcategoria.ilike.%${escapeLike(cleanTerm)}%`)
    .gte('finanzas_comprobantes.fecha_emision', start)
    .lte('finanzas_comprobantes.fecha_emision', end)
    .limit(1000);
  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc: number, r: any) => acc + Math.max(0, Number(r.importe || 0)), 0);
  const byMonth = new Map<string, number>();
  const byCommerce = new Map<string, number>();
  for (const row of rows) {
    const comp = row.finanzas_comprobantes || {};
    const month = String(comp.fecha_emision || '').slice(0, 7) || 'sin fecha';
    const amount = Math.max(0, Number(row.importe || 0));
    byMonth.set(month, (byMonth.get(month) || 0) + amount);
    const commerce = comp.comercio || 'Sin comercio';
    byCommerce.set(commerce, (byCommerce.get(commerce) || 0) + amount);
  }

  return { ok: true as const, term: cleanTerm, year: yearText, rows, total, byMonth, byCommerce };
}

export async function saveProductRuleFromText(text: string) {
  const t = cleanText(text) || '';
  const m = t.match(/(?:clasificar\s+producto|producto)\s+(.+?)\s+(?:como|categoria|categoría)\s+(.+?)(?:\s+guardar\s+regla|$)/i) || t.match(/esto\s+siempre\s+clasificalo\s+como\s+(.+)/i);
  if (!m) return { ok: false as const, message: 'Usá: /clasificar producto sensodyne como Higiene personal guardar regla' };
  const patron = cleanText(m[1] || '');
  const categoryText = cleanText(m[2] || m[1] || '');
  if (!patron || !categoryText) return { ok: false as const, message: 'No encontré producto y categoría.' };
  const { categoria, subcategoria } = parseCategoryText(categoryText);
  const key = normalizeProductKey(patron);
  const { data: existing, error: findError } = await supabase.from('finanzas_reglas_productos').select('*').eq('patron', key).limit(1).maybeSingle();
  if (findError) throw findError;
  if (existing) {
    const { data, error } = await supabase.from('finanzas_reglas_productos').update({ categoria, subcategoria, producto_normalizado: cleanText(patron), aplicar_auto: true, updated_at: new Date().toISOString() }).eq('id', existing.id).select().single();
    if (error) throw error;
    return { ok: true as const, rule: data, updated: true };
  }
  const { data, error } = await supabase.from('finanzas_reglas_productos').insert({ patron: key, producto_normalizado: cleanText(patron), categoria, subcategoria, aplicar_auto: true }).select().single();
  if (error) throw error;
  return { ok: true as const, rule: data, updated: false };
}

export function formatComprobanteImportResult(result: ImportComprobanteResult) {
  if (!result.recognized) return result.message || 'No reconocí el archivo como ticket/factura.';
  const c = result.comprobante || {};
  const lines = [
    result.duplicate ? 'Comprobante ya cargado.' : 'Comprobante importado.',
    '',
    `Comercio: ${c.comercio || '-'}`,
    `Tipo: ${c.tipo_comprobante || '-'}`,
    `Fecha: ${c.fecha_emision || '-'}`,
    `Total: ${formatMoney(Number(c.total || 0), c.moneda || 'ARS')}`,
    `Medio: ${[c.medio_pago, c.tarjeta, c.cuotas ? `${c.cuotas} cuotas` : ''].filter(Boolean).join(' / ') || '-'}`,
    `Items detectados: ${result.itemsInserted ?? '-'}`,
    `Estado: ${c.movimiento_financiero_id ? 'conciliado/registrado' : c.estado || '-'}`
  ];
  if (Number(c.cuotas || 0) > 1) {
    lines.push('', 'No creé gasto por el total porque está en cuotas. El resumen de tarjeta carga el impacto mensual; este comprobante guarda el detalle/productos.');
  }
  return lines.join('\n');
}

export function formatComprobantes(rows: any[]) {
  if (!rows.length) return 'No encontré comprobantes.';
  const lines = ['Comprobantes:'];
  for (const r of rows) {
    lines.push(`• ${r.fecha_emision || '-'} — ${r.comercio || '-'} — ${formatMoney(Number(r.total || 0), r.moneda || 'ARS')} — ${r.estado || '-'}`);
  }
  return lines.join('\n');
}

export function formatComprobanteDetail(row: any) {
  if (!row) return 'No encontré comprobante.';
  return [
    'Último comprobante:',
    '',
    `Comercio: ${row.comercio || '-'}`,
    `Razón social: ${row.razon_social || '-'}`,
    `Fecha: ${row.fecha_emision || '-'}`,
    `Factura/ticket: ${row.numero_comprobante || '-'}`,
    `Total: ${formatMoney(Number(row.total || 0), row.moneda || 'ARS')}`,
    `Subtotal: ${row.subtotal ? formatMoney(Number(row.subtotal), row.moneda || 'ARS') : '-'}`,
    `Descuentos: ${row.descuentos ? formatMoney(Number(row.descuentos), row.moneda || 'ARS') : '-'}`,
    `Medio: ${[row.medio_pago, row.tarjeta, row.cuotas ? `${row.cuotas} cuotas` : '', row.importe_cuota ? `${formatMoney(Number(row.importe_cuota), row.moneda || 'ARS')}/cuota` : ''].filter(Boolean).join(' / ') || '-'}`,
    `Estado: ${row.estado || '-'}`
  ].join('\n');
}

export function formatComprobanteItems(payload: { comprobante: any | null; items: any[] }) {
  if (!payload.comprobante) return 'No encontré comprobante.';
  const lines = [`Items de ${payload.comprobante.comercio || 'comprobante'} (${payload.comprobante.fecha_emision || '-'})`];
  if (!payload.items.length) {
    lines.push('No hay items estructurados.');
    return lines.join('\n');
  }
  for (const item of payload.items.slice(0, 40)) {
    lines.push(`• ${item.descripcion} — ${formatMoney(Number(item.importe || 0), payload.comprobante.moneda || 'ARS')}${item.subcategoria ? ` — ${item.subcategoria}` : ''}`);
  }
  if (payload.items.length > 40) lines.push(`... ${payload.items.length - 40} más`);
  return lines.join('\n');
}

export function formatProducts(rows: any[]) {
  if (!rows.length) return 'No encontré productos.';
  const lines = ['Productos encontrados:'];
  for (const r of rows.slice(0, 30)) {
    const comp = r.finanzas_comprobantes || {};
    lines.push(`• ${comp.fecha_emision || '-'} — ${r.descripcion} — ${formatMoney(Number(r.importe || 0), comp.moneda || 'ARS')} — ${comp.comercio || '-'}`);
  }
  return lines.join('\n');
}

export function formatProductSpendingReport(result: Awaited<ReturnType<typeof summarizeProductSpending>>) {
  if (!result.ok) return result.message;
  const lines = [`Reporte por producto/categoría: ${result.term}`, '', `Período: ${result.year}`, `Items encontrados: ${result.rows.length}`, `Total: ${formatMoney(result.total, 'ARS')}`];
  if (!result.rows.length) return lines.concat('', 'No encontré items para ese criterio.').join('\n');
  lines.push('', 'Por mes:');
  for (const [month, amount] of [...result.byMonth.entries()].sort()) lines.push(`• ${month}: ${formatMoney(amount, 'ARS')}`);
  lines.push('', 'Por comercio:');
  for (const [commerce, amount] of [...result.byCommerce.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push(`• ${commerce}: ${formatMoney(amount, 'ARS')}`);
  return lines.join('\n');
}

export function formatProductRuleResult(result: Awaited<ReturnType<typeof saveProductRuleFromText>>) {
  if (!result.ok) return result.message;
  return [
    result.updated ? 'Regla de producto actualizada.' : 'Regla de producto guardada.',
    `Patrón: ${result.rule.patron}`,
    `Categoría: ${result.rule.categoria || result.rule.categoria_financiera || '-'}`,
    `Subcategoría: ${result.rule.subcategoria || '-'}`
  ].join('\n');
}

async function applyStoredProductRules(items: ComprobanteItem[]): Promise<ComprobanteItem[]> {
  if (!items.length) return items;
  const { data, error } = await supabase.from('finanzas_reglas_productos').select('*').eq('aplicar_auto', true).limit(1000);
  if (error) throw error;
  const rules = data || [];
  return items.map(item => {
    const key = normalizeProductKey(item.descripcion);
    const match = rules.find((r: any) => key.includes(String(r.patron || '')) || String(r.patron || '').includes(key));
    if (match) {
      item.categoria = match.categoria || match.categoria_financiera || item.categoria || null;
      item.subcategoria = match.subcategoria || item.subcategoria || null;
      item.descripcion_normalizada = match.producto_normalizado || item.descripcion_normalizada || null;
      if (match.marca && !item.marca) item.marca = match.marca;
      return item;
    }
    applyProductCategory(item);
    return item;
  });
}

function applyProductCategory(item: ComprobanteItem) {
  const text = `${item.descripcion} ${item.marca || ''}`;
  const rule = DEFAULT_PRODUCT_RULES.find(r => r.pattern.test(text));
  if (rule) {
    item.categoria = item.categoria || rule.categoria;
    item.subcategoria = item.subcategoria || rule.subcategoria || null;
    item.marca = item.marca || rule.marca || inferBrand(item.descripcion);
  } else {
    item.categoria = item.categoria || 'Compras';
    item.subcategoria = item.subcategoria || null;
    item.marca = item.marca || inferBrand(item.descripcion);
  }
  item.descripcion_normalizada = item.descripcion_normalizada || normalizeProductKey(item.descripcion);
}

function categoryFromCommerceOrItems(comercio: string, items: ComprobanteItem[]) {
  const commerceRule = COMMERCE_CATEGORY_RULES.find(r => r.pattern.test(comercio));
  if (commerceRule) return { categoria: commerceRule.categoria, subcategoria: commerceRule.subcategoria || null };
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = [item.categoria || 'Compras', item.subcategoria || ''].join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) {
    const [categoria, subcategoria] = best.split('|');
    return { categoria, subcategoria: subcategoria || null };
  }
  return { categoria: 'Compras', subcategoria: null };
}

function sanitizeParsedComprobante(input: ParsedComprobante | null | undefined): ParsedComprobante {
  const p: ParsedComprobante = input && typeof input === 'object' ? input : { is_comprobante: false };
  const items = Array.isArray(p.items) ? p.items.map(sanitizeItem).filter((i): i is ComprobanteItem => Boolean(i && i.descripcion)).slice(0, 250) : [];
  return {
    is_comprobante: Boolean(p.is_comprobante),
    tipo_comprobante: normalizeTipoComprobante(p.tipo_comprobante || null),
    confidence: clamp01(Number(p.confidence || 0)),
    comercio: cleanText(p.comercio),
    razon_social: cleanText(p.razon_social),
    cuit: cleanText(p.cuit),
    sucursal: cleanText(p.sucursal),
    punto_venta: cleanText(p.punto_venta),
    numero_comprobante: cleanText(p.numero_comprobante),
    fecha: normalizeDate(p.fecha || '') || null,
    total: toNumberOrNull(p.total),
    subtotal: toNumberOrNull(p.subtotal),
    descuentos: toNumberOrNull(p.descuentos),
    impuestos: toNumberOrNull(p.impuestos),
    moneda: normalizeCurrency(p.moneda || 'ARS'),
    medio_pago: cleanText(p.medio_pago),
    tarjeta: normalizeCard(p.tarjeta || p.medio_pago || ''),
    tarjeta_ultimos_4: cleanText(p.tarjeta_ultimos_4),
    cuotas: toInt(p.cuotas),
    importe_cuota: toNumberOrNull(p.importe_cuota),
    items,
    texto_extraido: p.texto_extraido || null,
    notas: p.notas || null
  };
}

function sanitizeItem(input: any): ComprobanteItem | null {
  if (!input || typeof input !== 'object') return null;
  const desc = cleanProductDescription(String(input.descripcion || input.description || ''));
  if (!desc) return null;
  const item: ComprobanteItem = {
    codigo: cleanText(input.codigo || input.code),
    descripcion: desc,
    descripcion_normalizada: cleanText(input.descripcion_normalizada) || normalizeProductKey(desc),
    marca: cleanText(input.marca || inferBrand(desc)),
    cantidad: toNumberOrNull(input.cantidad) || 1,
    precio_unitario: toNumberOrNull(input.precio_unitario),
    importe: toNumberOrNull(input.importe ?? input.total ?? input.precio),
    descuento: toNumberOrNull(input.descuento),
    categoria: cleanText(input.categoria),
    subcategoria: cleanText(input.subcategoria),
    raw_json: input.raw_json || input
  };
  applyProductCategory(item);
  return item;
}

async function tryExtractPdfText(buffer: Buffer, fileName: string, mimeType: string) {
  if (!isPdfLike(fileName, mimeType)) return null;
  const attempts: Array<() => Promise<string | null>> = [
    () => tryExtractPdfTextWithPdfParse(buffer),
    () => tryExtractPdfTextWithPdfJs(buffer)
  ];
  let best: string | null = null;
  for (const fn of attempts) {
    const text = await fn();
    if (!text || text.length < 40) continue;
    const cleaned = cleanPdfText(text);
    if (!best || cleaned.length > best.length) best = cleaned;
    if (looksLikeComprobanteText(cleaned)) return cleaned;
  }
  return best;
}

async function tryExtractPdfTextWithPdfParse(buffer: Buffer) {
  try {
    const require = createRequire(import.meta.url);
    let pdfParse: any = null;
    try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); } catch (_) { try { pdfParse = require('pdf-parse'); } catch (__){ pdfParse = null; } }
    if (!pdfParse) return null;
    const result = await pdfParse(buffer, { max: 0 });
    return cleanPdfText(result?.text || '') || null;
  } catch (_) {
    return null;
  }
}

async function tryExtractPdfTextWithPdfJs(buffer: Buffer) {
  try {
    const require = createRequire(import.meta.url);
    let pdfjsLib: any = null;
    try { pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); } catch (_) {
      try {
        const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
        pdfjsLib = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
      } catch (__){ pdfjsLib = null; }
    }
    if (!pdfjsLib) return null;
    if (pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer), disableWorker: true, useSystemFonts: true, disableFontFace: true, verbosity: 0 });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      pages.push(layoutTextItems(content.items || []));
    }
    return cleanPdfText(pages.join('\n\f\n')) || null;
  } catch (_) {
    return null;
  }
}

function layoutTextItems(items: any[]) {
  const normalized = items
    .map((it: any) => ({ text: decodeURIComponentSafe(String(it.str || '')).trim(), x: Number(it.transform?.[4] || 0), y: Number(it.transform?.[5] || 0) }))
    .filter((it: any) => it.text);
  normalized.sort((a: any, b: any) => Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x);
  const lines: any[][] = [];
  for (const item of normalized) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last[0].y - item.y) > 2) lines.push([item]);
    else last.push(item);
  }
  return lines.map(line => line.sort((a: any, b: any) => a.x - b.x).map((i: any) => i.text).join(' ')).join('\n');
}

function parseJsonLoose(raw: string): any {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }
  throw new Error('Gemini no devolvió JSON válido para comprobante.');
}

function parseProductReportQuery(text: string) {
  const t = cleanText(text) || '';
  const year = t.match(/\b(20\d{2})\b/)?.[1] || (norm(t).includes('este ano') || norm(t).includes('este año') ? new Date().getFullYear().toString() : null);
  let term = t
    .replace(/\b(20\d{2})\b/g, '')
    .replace(/cu[aá]nto\s+gast[eé]\s+en/i, '')
    .replace(/cu[aá]nto\s+gasto\s+en/i, '')
    .replace(/gasto\s+producto/i, '')
    .replace(/producto/i, '')
    .replace(/este\s+a[nñ]o/ig, '')
    .replace(/durante\s+el\s+a[nñ]o/ig, '')
    .trim();
  term = term || t;
  return { term, year };
}

function parseCategoryText(text: string): { categoria: string; subcategoria: string | null } {
  const t = cleanText(text) || '';
  if (/higiene/i.test(t)) return { categoria: 'Supermercado', subcategoria: 'Higiene personal' };
  if (/limpieza/i.test(t)) return { categoria: 'Supermercado', subcategoria: 'Limpieza' };
  if (/alimento|comida|super/i.test(t)) return { categoria: 'Supermercado', subcategoria: 'Alimentos' };
  if (/decor|casa|sabana|cortina/i.test(t)) return { categoria: 'Casa', subcategoria: 'Decoración / ropa de casa' };
  return { categoria: t || 'Compras', subcategoria: null };
}

function buildComprobanteDedupeKey(parsed: ParsedComprobante, bufferHash: string | null) {
  const parts = [
    normalizeProductKey(parsed.comercio || parsed.razon_social || ''),
    normalizeDate(parsed.fecha || '') || '',
    cleanText(parsed.numero_comprobante) || '',
    String(Math.round(Number(parsed.total || 0) * 100)),
    normalizeCurrency(parsed.moneda || 'ARS')
  ];
  const base = parts.join('|');
  if (base.replace(/\|/g, '').length < 8 && bufferHash) return `hash:${bufferHash}`;
  return sha256(Buffer.from(base));
}

function cleanPdfText(text: string) {
  return String(text || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function cleanText(v: unknown) { return String(v ?? '').replace(/\s+/g, ' ').trim() || null; }
function cleanProductDescription(v: unknown) { return String(v ?? '').replace(/^[-*•\s]+/, '').replace(/\s+/g, ' ').trim(); }
function norm(s: string) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function normalizeProductKey(s: string) { return norm(s).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); }
function normalizeCommerce(s: string) { const t = cleanText(s) || 'Comercio sin identificar'; const rule = COMMERCE_CATEGORY_RULES.find(r => r.pattern.test(t)); return rule?.comercio || t; }
function escapeLike(s: string) { return s.replace(/[%_]/g, m => `\\${m}`); }
function sha256(data: Buffer | string) { return crypto.createHash('sha256').update(data).digest('hex'); }
function toNumberOrNull(v: unknown) { if (v === null || v === undefined || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; return parseAmountLoose(String(v)); }
function toInt(v: unknown) { const n = Number(String(v ?? '').replace(/[^0-9-]/g, '')); return Number.isFinite(n) && n !== 0 ? n : null; }
function parseDecimalLoose(v: string) { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; }
function parseAmountLoose(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^-/.test(s) || /-\$/.test(s)) neg = true;
  s = s.replace(/[^0-9,.-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg && n > 0 ? -n : n;
}
function findFirst(text: string, re: RegExp) { const m = text.match(re); return m ? (m[1] || m[0]).trim() : null; }
function normalizeDate(v: string | null | undefined) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  m = s.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function normalizeCurrency(v: string) { return /usd|dolar|dólar|u\$s/i.test(v) ? 'USD' : 'ARS'; }
function normalizeTipoComprobante(v: string | null): 'ticket' | 'factura' | 'recibo' | 'otro' { const t = norm(v || ''); if (t.includes('factura')) return 'factura'; if (t.includes('ticket')) return 'ticket'; if (t.includes('recibo')) return 'recibo'; return 'otro'; }
function normalizeCard(v: string) { const t = norm(v); if (t.includes('visa')) return 'Visa'; if (t.includes('master')) return 'Mastercard'; if (t.includes('amex')) return 'Amex'; return null; }
function detectCard(v: string) { return normalizeCard(v); }
function normalizePaymentMethod(v: string) { const card = normalizeCard(v); if (card) return `${card} crédito`; if (/mercado\s*pago|merpago/i.test(v)) return 'Mercado Pago'; if (/efectivo/i.test(v)) return 'Efectivo'; if (/debito|débito/i.test(v)) return 'Débito'; return cleanText(v) || null; }
function addDays(date: string, days: number) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function clamp01(n: number) { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function isPdfLike(fileName: string, mimeType: string) { return /pdf/i.test(mimeType) || /\.pdf$/i.test(fileName); }
function isImageLike(mimeType: string, fileName: string) { return /^image\//i.test(mimeType) || /\.(jpg|jpeg|png|webp)$/i.test(fileName); }
function formatMoney(n: number, currency = 'ARS') { const val = Number(n || 0); return `${currency === 'USD' ? 'USD' : '$'} ${val.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function sumNegativeItems(items: ComprobanteItem[]) { const n = items.filter(i => Number(i.importe || 0) < 0).reduce((a, i) => a + Math.abs(Number(i.importe || 0)), 0); return n || null; }
function dedupeItems(items: ComprobanteItem[]) { const seen = new Set<string>(); return items.filter(i => { const k = `${normalizeProductKey(i.descripcion)}|${i.importe || ''}`; if (seen.has(k)) return false; seen.add(k); return true; }); }
function inferBrand(desc: string) {
  const rules: Array<[RegExp, string]> = [[/bimbo/i, 'Bimbo'], [/serenisima/i, 'La Serenísima'], [/taragui/i, 'Taragüi'], [/natura/i, 'Natura'], [/sensodyne/i, 'Sensodyne'], [/ayudin/i, 'Ayudín'], [/traviata/i, 'Traviata'], [/sussex/i, 'Sussex'], [/gallo|arredo/i, 'Gallo/Arredo']];
  return rules.find(([re]) => re.test(desc))?.[1] || null;
}
function decodeURIComponentSafe(s: string) { try { return decodeURIComponent(s); } catch { return s; } }
