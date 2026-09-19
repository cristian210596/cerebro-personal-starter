import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { supabase } from './supabaseClient.js';
import { config } from './config.js';
import { withGemini } from './geminiPool.js';
import { resolveAndLearnEntity, upsertEntityAlias, upsertMasterEntity } from './entityBrain.js';
import * as XLSX from 'xlsx';


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

  // Antes: solo reconocia la pregunta si el comercio/servicio estaba en una lista fija
  // (chatgpt, spotify, netflix, visa, etc.). Cualquier otro comercio (uber, cabify, farmacia,
  // lo que sea) caia al clasificador general y se guardaba como item nuevo en vez de responder.
  // Ahora: cualquier pregunta con intencion de consulta de gasto (sin un importe explicito,
  // porque eso seria un gasto nuevo a cargar, no una consulta) se manda al reporte financiero.
  const hasExplicitAmount = /\$\s*\d/.test(text) || /\b\d+[.,]\d{2}\b/.test(t);
  if (hasExplicitAmount) return false;

  const hasQueryIntent = /(cu[aá]nto|cuanto|total|gast[eé]|gaste|gastaste|vengo gastando|llevo gastado)/.test(t);
  if (!hasQueryIntent) return false;

  // Evita falsos positivos con "cuanto" suelto sin ningun target (comercio/categoria/medio de pago).
  const hasTarget = /\b(en|de|del|para|con)\b/.test(t) ||
    /(chat\s*gpt|chatgpt|openai|spotify|netflix|youtube|suscripci[oó]n|suscripciones|visa|master|mercado pago)/.test(t);

  return hasTarget;
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
    // Si el archivo ya había sido subido en una versión anterior, puede haber quedado
    // en staging: movimientos detectados/clasificados, pero todavía no consolidados
    // dentro de finanzas_movimientos. Antes de devolver "ya importado", intentamos
    // completar esa consolidación. Esto corrige el caso: detectados 58, importados 0.
    const processed = await processFinanceImportation(existing.id);
    return {
      recognized: true as const,
      duplicate: true,
      importacion: existing,
      processed,
      stats: await buildImportStats(existing.id),
      nextPending: await getNextPendingImportedMovement(existing.id),
      pendingList: await getPendingImportedMovements(8, existing.id)
    };
  }

  let parsed: ParsedFinanceDocument | null = null;
  let pdfTextLength = 0;
  let geminiFallbackAttempted = false;
  if (isXlsxLike(fileName, mimeType)) {
    // Antes isCsvLike ya matcheaba .xlsx por el mimetype ("spreadsheet") y lo leía
    // con buffer.toString('utf8'): un .xlsx es un zip binario, así que esto daba
    // basura y terminaba en "Formato financiero no reconocido". Ahora se lee de
    // verdad con la librería xlsx y se reusa el mismo parser de CSV sobre el texto.
    parsed = parseXlsxFinance(input.buffer, fileName);
  } else if (isCsvLike(fileName, mimeType)) {
    parsed = parseCsvFinance(input.buffer.toString('utf8'), fileName);
  } else if (isPdfLike(fileName, mimeType)) {
    const pdfText = await tryExtractPdfText(input.buffer, fileName, mimeType);
    pdfTextLength = pdfText?.length || 0;
    if (pdfText && pdfText.length > 120) {
      parsed = parseVisaGaliciaPdfText(pdfText, fileName) || parseMercadoPagoPdfText(pdfText, fileName);
      console.log(`Importador financiero PDF: texto local ${pdfText.length} chars; movimientos locales ${parsed?.movimientos?.length || 0}`);
    } else {
      console.log('Importador financiero PDF: no se pudo extraer texto local usable. Intento fallback Gemini.');
    }

    // Último recurso: si los extractores locales fallan o el parser no ve movimientos,
    // usamos Gemini SOLO para convertir el resumen a JSON estructurado.
    // Esto queda después de pdf-parse/pdf2json/pdfjs y usa el pool de keys con rotación.
    if (!parsed?.movimientos?.length) {
      geminiFallbackAttempted = true;
      parsed = await tryParseFinancePdfWithGemini(input.buffer, fileName, mimeType, input.caption || '', pdfText);
      if (parsed?.movimientos?.length) {
        console.log(`Importador financiero PDF: fallback Gemini extrajo ${parsed.movimientos.length} movimientos.`);
      }
    }
  } else {
    parsed = null;
  }

  if (!parsed?.es_resumen_financiero || !Array.isArray(parsed.movimientos) || !parsed.movimientos.length) {
    // Antes esto era un mensaje genérico sin ninguna pista de qué falló. No tengo
    // acceso a los logs de Vercel, así que ahora el diagnóstico va directo al chat.
    const hints: string[] = [];
    if (isPdfLike(fileName, mimeType)) {
      hints.push(pdfTextLength > 120
        ? `Extraje texto local (${pdfTextLength} caracteres) pero no reconocí el formato de movimientos.`
        : `No pude extraer texto legible del PDF localmente (${pdfTextLength} caracteres extraídos).`);
      hints.push(geminiFallbackAttempted
        ? 'El fallback con Gemini tampoco encontró movimientos (si esto se repite, puede ser cuota agotada: revisá con /gemini estado).'
        : 'No llegué a intentar el fallback con Gemini.');
    } else if (isXlsxLike(fileName, mimeType)) {
      hints.push('Abrí el Excel y confirmá que la primera hoja tenga una fila de encabezados con columnas de fecha, descripción/comercio y monto/importe.');
    }
    return {
      recognized: false as const,
      duplicate: false,
      reason: [
        isPdfLike(fileName, mimeType) ? 'No pude extraer movimientos del PDF.' : isXlsxLike(fileName, mimeType) ? 'No pude extraer movimientos del Excel.' : 'Formato financiero no reconocido.',
        ...hints,
        'Probá subir el PDF exportado original o el CSV/Excel tal cual lo descargaste del banco, o mandalo de nuevo si esto fue algo puntual.'
      ].join(' ')
    };
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
  const pendingList = await getPendingImportedMovements(8, importacion.id);

  await updateImportationState(importacion.id);

  return {
    recognized: true as const,
    duplicate: false,
    importacion,
    processed,
    stats,
    nextPending,
    pendingList
  };
}

export async function importPaymentScreenshotFile(input: {
  buffer: Buffer;
  fileName?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  chatId: number;
  itemId?: string | null;
  archivoId?: string | null;
}) {
  const fileName = input.fileName || 'captura-pago';
  const mimeType = input.mimeType || 'image/jpeg';
  const hash = sha256(input.buffer);

  const existing = await findExistingImport(hash);
  if (existing) {
    const processed = await processFinanceImportation(existing.id);
    return {
      recognized: true as const,
      duplicate: true,
      importacion: existing,
      processed,
      stats: await buildImportStats(existing.id),
      nextPending: await getNextPendingImportedMovement(existing.id),
      pendingList: await getPendingImportedMovements(8, existing.id)
    };
  }

  const parsed = await extractPaymentScreenshotWithGemini(input.buffer, mimeType, fileName, input.caption || '');
  if (!parsed?.es_resumen_financiero || !Array.isArray(parsed.movimientos) || !parsed.movimientos.length) {
    return { recognized: false as const, duplicate: false, reason: 'No parece una captura de pago/transferencia.' };
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
  const pendingList = await getPendingImportedMovements(8, importacion.id);

  await updateImportationState(importacion.id);

  return {
    recognized: true as const,
    duplicate: false,
    importacion,
    processed,
    stats,
    nextPending,
    pendingList
  };
}

// Clasifica con Gemini si una imagen es una captura de pago/transferencia/cobro
// (Mercado Pago, home banking, billetera virtual, QR) en vez de un ticket
// itemizado o un recibo de sueldo. confianza siempre queda baja salvo que el
// destinatario sea una marca reconocible, para que si no hay certeza quede
// pendiente de clasificar y se dispare la pregunta proactiva al usuario.
async function extractPaymentScreenshotWithGemini(buffer: Buffer, mimeType: string, fileName: string, caption: string): Promise<ParsedFinanceDocument | null> {
  if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY_2) return null;

  const prompt = [
    'Analizá esta imagen para un sistema personal de finanzas.',
    'Puede ser una captura de pantalla de un pago, transferencia o cobro: Mercado Pago, home banking, billetera virtual (Ualá, Brubank, etc.), QR, etc.',
    'NO es esto: un ticket/factura de compra con lista de productos (eso se procesa aparte), ni un recibo de sueldo.',
    'Si la imagen NO muestra un pago/transferencia/cobro de dinero, devolvé es_resumen_financiero=false y movimientos=[].',
    'No inventes datos: si un dato no se ve con claridad, usá null.',
    'Devolvé SOLO JSON válido, sin markdown. Estructura exacta:',
    '{',
    '  "es_resumen_financiero": true|false,',
    '  "tipo_fuente": "captura_pago",',
    '  "proveedor": string|null,',
    '  "cuenta": null,',
    '  "tarjeta": null,',
    '  "periodo": null,',
    '  "fecha_cierre": null,',
    '  "fecha_vencimiento": null,',
    '  "total_pesos": null,',
    '  "total_dolares": null,',
    '  "pago_minimo": null,',
    '  "movimientos": [',
    '    {',
    '      "fecha": "YYYY-MM-DD"|null,',
    '      "descripcion_original": string,',
    '      "comercio": string|null,',
    '      "comprobante": string|null,',
    '      "monto": number,',
    '      "moneda": "ARS"|"USD",',
    '      "tipo": "gasto"|"transferencia",',
    '      "cuota_actual": null,',
    '      "cuotas_totales": null,',
    '      "categoria_sugerida": null,',
    '      "subcategoria_sugerida": null,',
    '      "confianza": number',
    '    }',
    '  ]',
    '}',
    'Reglas:',
    '- "descripcion_original": texto tal cual aparece (ej: nombre del destinatario/comercio, "Pago con QR", etc.).',
    '- "comercio": nombre de la persona/comercio que recibió o envió el dinero, tal cual se ve en la captura. No lo inventes ni lo generalices.',
    '- "proveedor": el medio/app usado (ej: "Mercado Pago", "Banco Galicia", "Ualá"), si se identifica.',
    '- "confianza": siempre bajo (0.2 a 0.4) salvo que el destinatario sea una marca/comercio claramente reconocible (ej: Uber, Cabify, YPF); en ese caso podés usar hasta 0.6. categoria_sugerida siempre null, la categoría se define aparte.',
    caption ? `Caption del usuario: ${caption}` : '',
    `Nombre de archivo: ${fileName}`
  ].filter(Boolean).join('\n');

  try {
    const response: any = await withGemini(ai => ai.models.generateContent({
      model: config.geminiModel(),
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mimeType || 'image/jpeg', data: buffer.toString('base64') } }
          ]
        }
      ]
    }), { operationName: 'detección captura de pago', timeoutMs: 45000, maxAttempts: 1 });

    const jsonText = extractJsonObject(response.text || '');
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    if (!parsed?.es_resumen_financiero) return null;
    return normalizeParsedDocument(parsed);
  } catch (error: any) {
    console.error('No pude analizar posible captura de pago con Gemini:', error?.message || error);
    return null;
  }
}

async function tryExtractPdfText(buffer: Buffer, fileName: string, mimeType: string) {
  if (!isPdfLike(fileName, mimeType)) return null;

  // Importante: esto NO usa Gemini. Son extractores locales en Node/Vercel.
  // Se prueban varios motores porque los resúmenes bancarios suelen romper uno u otro
  // según cómo esté generado el PDF.
  const attempts: Array<[string, () => Promise<string | null>]> = [
    ['pdf-parse', () => tryExtractPdfTextWithPdfParse(buffer)],
    ['pdf2json-layout', () => tryExtractPdfTextWithPdf2Json(buffer)],
    ['pdfjs-layout', () => tryExtractPdfTextWithPdfJs(buffer)]
  ];

  let best: string | null = null;
  let bestLooksLikeStatement: string | null = null;
  for (const [name, fn] of attempts) {
    try {
      const text = await fn();
      if (!text || text.length < 60) continue;
      const cleaned = cleanPdfText(text);
      if (!best || cleaned.length > best.length) best = cleaned;

      // Si ya parece resumen de tarjeta o de cuenta MercadoPago, verificamos que se
      // pueda parsear de verdad antes de quedarnos con este extractor. Un extractor
      // puede matchear el encabezado sin que se pueda extraer ni un movimiento
      // (columnas pegadas o reordenadas); en ese caso seguimos probando los demás.
      const statementChecks: Array<[RegExp[], (t: string, f: string) => ParsedFinanceDocument | null]> = [
        [[/detalle\s+del\s+consumo/i, /(visa|master\s*card|mastercard|galicia)/i], parseVisaGaliciaPdfText],
        [[/detalle\s+de\s+movimientos/i, /mercado\s*pago/i], parseMercadoPagoPdfText]
      ];
      for (const [patterns, parseFn] of statementChecks) {
        if (!patterns.every(p => p.test(cleaned))) continue;
        if (!bestLooksLikeStatement) bestLooksLikeStatement = cleaned;
        const trialParse = parseFn(cleaned, fileName);
        if (trialParse && trialParse.movimientos.length > 0) {
          console.log(`PDF financiero: texto extraído con ${name} (parseable, ${trialParse.movimientos.length} movimientos). Caracteres: ${cleaned.length}`);
          return cleaned;
        }
        console.log(`PDF financiero: ${name} matcheó encabezado de resumen pero no logró parsear ningún movimiento; pruebo otro extractor.`);
      }
    } catch (error: any) {
      console.error(`Extractor PDF ${name} falló:`, error?.message || error);
    }
  }

  // Ningún extractor dio texto parseable en columnas, pero al menos uno
  // reconoció el encabezado de resumen: es mejor que "best" (que puede ser
  // texto más largo pero de una parte irrelevante, como texto legal).
  if (bestLooksLikeStatement) {
    console.log(`PDF financiero: ningún extractor parseó movimientos; uso el que matcheó encabezado. Caracteres: ${bestLooksLikeStatement.length}`);
    return bestLooksLikeStatement;
  }

  if (best && best.length > 120) {
    console.log(`PDF financiero: uso mejor extracción disponible. Caracteres: ${best.length}`);
    return best;
  }

  return null;
}

async function tryExtractPdfTextWithPdfParse(buffer: Buffer) {
  try {
    const require = createRequire(import.meta.url);
    let pdfParse: any = null;

    // pdf-parse 1.1.1 expone este archivo interno estable. Si no existe,
    // usamos el entrypoint normal. Todo queda en try/catch para no bloquear.
    try {
      pdfParse = require('pdf-parse/lib/pdf-parse.js');
    } catch (_) {
      try {
        pdfParse = require('pdf-parse');
      } catch (__){
        pdfParse = null;
      }
    }

    if (!pdfParse) return null;
    const result = await pdfParse(buffer, { max: 0 });
    const text = cleanPdfText(result?.text || '');
    return text.length ? text : null;
  } catch (error: any) {
    console.error('No pude extraer texto del PDF con pdf-parse; sigo con fallback:', error?.message || error);
    return null;
  }
}

async function tryExtractPdfTextWithPdf2Json(buffer: Buffer) {
  try {
    const require = createRequire(import.meta.url);
    let mod: any = null;
    try {
      mod = require('pdf2json');
    } catch (_) {
      mod = null;
    }
    if (!mod) return null;

    const PDFParser = mod.PDFParser || mod.default || mod;
    if (!PDFParser) return null;

    const text = await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 18_000);

      try {
        const parser = new PDFParser(null, 1);
        parser.on('pdfParser_dataError', (errData: any) => {
          console.error('pdf2json error:', errData?.parserError || errData);
          finish(null);
        });
        parser.on('pdfParser_dataReady', (pdfData: any) => {
          const pages = pdfData?.Pages || pdfData?.formImage?.Pages || [];
          const pageTexts = Array.isArray(pages) ? pages.map((page: any) => layoutPdf2JsonTexts(page?.Texts || [])).filter(Boolean) : [];
          finish(cleanPdfText(pageTexts.join('\n\f\n')) || null);
        });
        parser.parseBuffer(buffer);
      } catch (error: any) {
        console.error('pdf2json parseBuffer falló:', error?.message || error);
        finish(null);
      }
    });

    return text && text.length ? text : null;
  } catch (error: any) {
    console.error('No pude extraer texto del PDF con pdf2json:', error?.message || error);
    return null;
  }
}

function layoutPdf2JsonTexts(texts: any[]) {
  const items = (Array.isArray(texts) ? texts : [])
    .map((item: any) => {
      const str = (Array.isArray(item?.R) ? item.R : [])
        .map((r: any) => decodePdf2JsonText(r?.T || ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        x: Number(item?.x || 0),
        y: Number(item?.y || 0),
        str,
        width: Number(item?.w || item?.sw || 0)
      };
    })
    .filter((item: any) => item.str);

  items.sort((a: any, b: any) => Math.abs(a.y - b.y) > 0.35 ? a.y - b.y : a.x - b.x);

  const rows: any[][] = [];
  for (const item of items) {
    let row = rows.find(r => Math.abs(r[0].y - item.y) <= 0.32);
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(item);
  }

  return rows.map(row => {
    row.sort((a, b) => a.x - b.x);
    let line = '';
    let prevRight: number | null = null;
    for (const item of row) {
      if (!line) {
        line = item.str;
      } else {
        const gap = prevRight === null ? 0 : item.x - prevRight;
        const spaces = gap > 7 ? '     ' : gap > 3.5 ? '   ' : ' ';
        line += spaces + item.str;
      }
      prevRight = item.x + Math.max(item.width || 0, item.str.length * 0.22);
    }
    return line.replace(/\s+$/g, '');
  }).filter(Boolean).join('\n');
}

function decodePdf2JsonText(value: string) {
  const raw = String(value || '');
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    try {
      return decodeURIComponent(raw.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
    } catch (__){
      return raw;
    }
  }
}

async function tryExtractPdfTextWithPdfJs(buffer: Buffer) {
  try {
    const require = createRequire(import.meta.url);
    let pdfjsLib: any = null;

    // pdfjs-dist v3: CommonJS estable para Node/Vercel.
    try {
      pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    } catch (_) {
      // pdfjs-dist v4+: ESM.
      try {
        const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
        pdfjsLib = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
      } catch (__){
        pdfjsLib = null;
      }
    }

    if (!pdfjsLib) return null;
    if (pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    }

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0
    });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      pages.push(layoutTextItems(content.items || []));
    }

    const text = cleanPdfText(pages.join('\n\f\n'));
    return text.length ? text : null;
  } catch (error: any) {
    console.error('No pude extraer texto del PDF con pdfjs-dist; no se usa Gemini para importaciones:', error?.message || error);
    return null;
  }
}

function layoutTextItems(items: any[]) {
  const normalized = items
    .map((item: any) => {
      const transform = item?.transform || [];
      const x = Number(transform[4] || 0);
      const y = Number(transform[5] || 0);
      const str = String(item?.str || '').replace(/\s+/g, ' ').trim();
      const width = Number(item?.width || 0);
      return { x, y, str, width };
    })
    .filter((item: any) => item.str);

  normalized.sort((a, b) => Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x);

  const rows: any[][] = [];
  for (const item of normalized) {
    let row = rows.find(r => Math.abs(r[0].y - item.y) <= 2.2);
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(item);
  }

  return rows.map(row => {
    row.sort((a, b) => a.x - b.x);
    let line = '';
    let prevRight: number | null = null;
    for (const item of row) {
      if (!line) {
        line = item.str;
      } else {
        const gap = prevRight === null ? 0 : item.x - prevRight;
        const spaces = gap > 55 ? '     ' : gap > 24 ? '   ' : ' ';
        line += spaces + item.str;
      }
      prevRight = item.x + Math.max(item.width || 0, item.str.length * 4.5);
    }
    return line.replace(/\s+$/g, '');
  }).filter(Boolean).join('\n');
}

function cleanPdfText(value: string) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseVisaGaliciaPdfText(text: string, fileName: string): ParsedFinanceDocument | null {
  const normalized = text.replace(/\r/g, '\n');
  const lower = norm(normalized);
  if (!/detalle del consumo/.test(lower) || !/(visa|mastercard|master card)/.test(lower)) return null;

  const tarjeta = /master\s*card|mastercard/i.test(normalized) ? 'Mastercard' : /visa/i.test(normalized) ? 'Visa' : null;
  const proveedor = /galicia/i.test(normalized) || /cuenta:\s*\d+/i.test(normalized) ? 'Banco Galicia' : null;
  const cuenta = clean(normalized.match(/N[°º]?\s*Cuenta:\s*([0-9]+)/i)?.[1]) || null;
  const topDates = [...normalized.matchAll(/\b(\d{1,2})-([A-Za-zÁÉÍÓÚáéíóúÑñ]{3})-(\d{2})\b/g)].map(m => m[0]);
  const fechaCierre = normalizeDateFromStatement(topDates[2] || topDates[topDates.length - 2] || null, null);
  const fechaVencimiento = normalizeDateFromStatement(topDates[3] || topDates[topDates.length - 1] || null, fechaCierre);
  const periodo = normalizePeriod(null, fechaCierre, fechaVencimiento);

  const totalLine = normalized.match(/TOTAL\s+A\s+PAGAR[^\n\d-]*([\d.]+,\d{2})(?:\s+([\d.]+,\d{2}))?/i);
  const totalPesos = totalLine ? parseAmountLoose(totalLine[1]) : firstLargeAmount(normalized);
  const totalDolares = totalLine?.[2] ? parseAmountLoose(totalLine[2]) : null;
  const pagoMinimo = parsePagoMinimo(normalized);
  const movimientos = parseVisaDetailRows(normalized, fechaCierre || fechaVencimiento);

  if (movimientos.length < 3) return null;
  return normalizeParsedDocument({
    es_resumen_financiero: true,
    tipo_fuente: 'resumen_tarjeta_pdf',
    proveedor,
    cuenta,
    tarjeta,
    periodo,
    fecha_cierre: fechaCierre,
    fecha_vencimiento: fechaVencimiento,
    total_pesos: totalPesos,
    total_dolares: totalDolares,
    pago_minimo: pagoMinimo,
    movimientos
  });
}

function parseVisaDetailRows(text: string, referenceDate: string | null): ImportedMovement[] {
  const out: ImportedMovement[] = [];
  const seen = new Set<string>();

  const push = (m: ImportedMovement) => {
    if (!m.descripcion_original || m.monto === null) return;
    const d = norm(m.descripcion_original);
    if (/saldo anterior|total consumos|total a pagar|pago minimo|pago mínimo|transferencia deuda|su pago en pesos|limites|l[ií]mites|tasas|consolidado/.test(d)) return;
    const key = [m.fecha || '', m.comprobante || '', Math.round(Number(m.monto || 0) * 100), m.moneda, normalizeMerchantText(m.descripcion_original)].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };

  const build = (dateRaw: string, descRaw: string, cuotaRaw: string, comprobante: string, amountRaw: string, moneda: string, raw: any) => {
    let desc = clean(descRaw);
    if (/^\*\s*$/.test(desc) || /^K\s*$/i.test(desc)) return;
    const cuota = parseInstallment(cuotaRaw || '');
    desc = desc
      .replace(/^\*\s*/, '')
      .replace(/^K\s+/i, 'K ')
      .replace(/\s+USD\s+[\d.,]+$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const fecha = normalizeDateFromStatement(dateRaw, referenceDate);
    const monto = parseAmountLoose(amountRaw);
    if (monto === null) return;

    const base: ImportedMovement = {
      fecha,
      descripcion_original: desc,
      comercio: guessCommerce(desc),
      comprobante: clean(comprobante) || null,
      monto,
      moneda,
      tipo: normalizeMovementType('', desc),
      cuota_actual: cuota.current,
      cuotas_totales: cuota.total,
      categoria_sugerida: null,
      subcategoria_sugerida: null,
      confianza: 0.55,
      raw
    };
    const rule = builtInRuleFor(base);
    push({
      ...base,
      comercio: rule?.comercio || base.comercio,
      categoria_sugerida: rule?.categoria || null,
      subcategoria_sugerida: rule?.subcategoria || null,
      confianza: rule?.confianza || base.confianza
    });
  };

  // Parser por línea para textos bien extraídos.
  const lines = text.split(/\n+/).map(l => l.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);

  const arsRowRe = /^(\d{1,2}[-\/]\d{1,2}[-\/]\d{2})\s+(.+?)\s+(?:(\d{1,2}\/\d{1,2})\s+)?(\d{5,8})\s+(-?[\d.]+,\d{2})$/;
  const usdRowRe = /^(\d{1,2}[-\/]\d{1,2}[-\/]\d{2})\s+(.+?USD)\s+(-?[\d.]+,\d{2})\s+(\d{5,8})\s+(-?[\d.]+,\d{2})$/i;

  for (const line of lines) {
    const usd = line.match(usdRowRe);
    if (usd) {
      build(usd[1], `${usd[2]} ${usd[3]}`, '', usd[4], usd[5], 'USD', { line, parser: 'visa_galicia_line_usd' });
      continue;
    }
    const ars = line.match(arsRowRe);
    if (ars) {
      build(ars[1], ars[2], ars[3] || '', ars[4], ars[5], 'ARS', { line, parser: 'visa_galicia_line_ars' });
    }
  }

  // Parser global tolerante: funciona aunque el extractor inserte saltos de línea entre columnas.
  // Acota el bloque de detalle para no leer textos legales o totales.
  const lower = norm(text);
  const startIdx = lower.indexOf('detalle del consumo');
  let detail = startIdx >= 0 ? text.slice(startIdx) : text;
  const endMarkers = ['tarjeta 1425 total consumos', 'total consumos de', 'total a pagar', 'plan v:'];
  const endPositions = endMarkers.map(m => norm(detail).indexOf(m)).filter(i => i > 0);
  if (endPositions.length) detail = detail.slice(0, Math.min(...endPositions));

  const compact = detail.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ');
  const globalRe = /(\d{1,2}[-\/]\d{1,2}[-\/]\d{2})\s+(?!SU\s+PAGO|TRANSFERENCIA|SALDO|TOTAL)(.{4,160}?)\s+(?:(\d{1,2}\/\d{1,2})\s+)?(\d{5,8})\s+(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2})(?=\s+\d{1,2}[-\/]\d{1,2}[-\/]\d{2}\s+|\s+TARJETA\s+\d+\s+Total|\s+TOTAL\s+A\s+PAGAR|$)/gi;
  for (const m of compact.matchAll(globalRe)) {
    const before = m[2] || '';
    const usd = before.match(/(.+?USD)\s+(-?[\d.]+,\d{2})\s*$/i);
    if (usd) {
      build(m[1], `${usd[1]} ${usd[2]}`, m[3] || '', m[4], m[5], 'USD', { text: m[0], parser: 'visa_galicia_global_usd' });
    } else {
      build(m[1], before, m[3] || '', m[4], m[5], 'ARS', { text: m[0], parser: 'visa_galicia_global_ars' });
    }
  }

  return out;
}
function parseMercadoPagoPdfText(text: string, fileName: string): ParsedFinanceDocument | null {
  const normalized = text.replace(/\r/g, '\n');
  const lower = norm(normalized);
  if (!/mercado\s*pago/.test(lower) || !/detalle de movimientos/.test(lower)) return null;

  const cuenta = clean(normalized.match(/CVU:\s*([0-9]+)/i)?.[1]) || null;
  const saldoFinal = parseAmountLoose(normalized.match(/Saldo final:\s*\$\s*(-?[\d.]+,\d{2})/i)?.[1] || '');

  const movimientos = parseMercadoPagoDetailRows(normalized);
  if (movimientos.length < 3) return null;

  const primeraFecha = movimientos[0]?.fecha || null;
  const ultimaFecha = movimientos[movimientos.length - 1]?.fecha || null;

  return normalizeParsedDocument({
    es_resumen_financiero: true,
    tipo_fuente: 'resumen_cuenta_mercadopago',
    proveedor: 'Mercado Pago',
    cuenta,
    tarjeta: null,
    periodo: normalizePeriod(null, ultimaFecha, primeraFecha),
    fecha_cierre: ultimaFecha,
    fecha_vencimiento: null,
    total_pesos: saldoFinal,
    total_dolares: null,
    pago_minimo: null,
    movimientos
  });
}

function parseMercadoPagoDetailRows(text: string): ImportedMovement[] {
  const out: ImportedMovement[] = [];
  const seen = new Set<string>();

  // Cada fila, tal como la deja pdf-parse, queda como:
  // "DD-MM-YYYY\n<descripción, 1 o 2 líneas>\n<id operación>$ <valor>$ <saldo>"
  // Sin espacio entre el id y el primer "$", ni entre el valor y el segundo "$".
  const re = /(\d{2}-\d{2}-\d{4})\n([\s\S]+?)\n(\d{6,15})\$\s*(-?[\d.]+,\d{2})\$\s*([\d.]+,\d{2})/g;

  for (const m of text.matchAll(re)) {
    const desc = clean(m[2].replace(/\s+/g, ' '));
    if (!desc) continue;
    const fecha = normalizeDate(m[1]);
    const comprobante = clean(m[3]) || null;
    const monto = parseAmountLoose(m[4]);
    if (monto === null) continue;

    const key = [fecha, comprobante].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const base: ImportedMovement = {
      fecha,
      descripcion_original: desc,
      comercio: guessCommerce(desc),
      comprobante,
      monto,
      moneda: 'ARS',
      tipo: normalizeMovementType('', desc),
      cuota_actual: null,
      cuotas_totales: null,
      categoria_sugerida: null,
      subcategoria_sugerida: null,
      confianza: 0.55,
      raw: { text: m[0], parser: 'mercadopago_cuenta' }
    };
    const rule = builtInRuleFor(base);
    out.push({
      ...base,
      comercio: rule?.comercio || base.comercio,
      categoria_sugerida: rule?.categoria || null,
      subcategoria_sugerida: rule?.subcategoria || null,
      confianza: rule?.confianza || base.confianza
    });
  }

  return out;
}

function normalizeDateFromStatement(value: string | null, referenceDate: string | null) {
  if (!value) return null;
  const s = clean(value);
  const monthNames: Record<string, string> = {
    ene: '01', jan: '01', feb: '02', mar: '03', abr: '04', apr: '04', may: '05', jun: '06', jul: '07', ago: '08', aug: '08', sep: '09', set: '09', oct: '10', nov: '11', dic: '12', dec: '12'
  };
  const named = s.match(/^(\d{1,2})-([A-Za-zÁÉÍÓÚáéíóúÑñ]{3})-(\d{2})$/);
  if (named) {
    const month = monthNames[norm(named[2]).slice(0, 3)] || null;
    if (!month) return null;
    return `20${named[3]}-${month}-${pad2(named[1])}`;
  }
  const numeric = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/);
  if (numeric) {
    const day = pad2(numeric[1]);
    const month = pad2(numeric[2]);
    let year = 2000 + Number(numeric[3]);
    if (referenceDate) {
      const refYear = Number(referenceDate.slice(0, 4));
      const refMonth = Number(referenceDate.slice(5, 7));
      const rowMonth = Number(month);
      year = refYear;
      if (refMonth <= 2 && rowMonth >= 11) year = refYear - 1;
    }
    return `${year}-${month}-${day}`;
  }
  return normalizeDate(s);
}

function firstLargeAmount(text: string) {
  const m = text.match(/\b(\d{1,3}(?:\.\d{3})+,\d{2})\b/);
  return m ? parseAmountLoose(m[1]) : null;
}

function parsePagoMinimo(text: string) {
  const idx = norm(text).indexOf('pago minimo');
  if (idx < 0) return null;
  const slice = text.slice(idx, idx + 700);
  const m = slice.match(/\$\s*([\d.]+,\d{2})/);
  return m ? parseAmountLoose(m[1]) : null;
}

async function tryParseFinancePdfWithGemini(buffer: Buffer, fileName: string, mimeType: string, caption: string, pdfText?: string | null): Promise<ParsedFinanceDocument | null> {
  if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY_2) return null;
  if (buffer.length > 15 * 1024 * 1024) return null;

  const prompt = [
    'Extraé movimientos de este resumen de tarjeta o documento financiero.',
    'Devolvé SOLO JSON válido. No uses markdown.',
    'Estructura exacta:',
    '{',
    '  "es_resumen_financiero": true,',
    '  "tipo_fuente": "resumen_tarjeta_pdf",',
    '  "proveedor": "Banco Galicia" | null,',
    '  "cuenta": string | null,',
    '  "tarjeta": "Visa" | "Mastercard" | null,',
    '  "periodo": "YYYY-MM" | null,',
    '  "fecha_cierre": "YYYY-MM-DD" | null,',
    '  "fecha_vencimiento": "YYYY-MM-DD" | null,',
    '  "total_pesos": number | null,',
    '  "total_dolares": number | null,',
    '  "pago_minimo": number | null,',
    '  "movimientos": [',
    '    {',
    '      "fecha": "YYYY-MM-DD",',
    '      "descripcion_original": string,',
    '      "comercio": string | null,',
    '      "comprobante": string | null,',
    '      "monto": number,',
    '      "moneda": "ARS" | "USD",',
    '      "tipo": "gasto" | "devolucion" | "impuesto" | "pago" | "movimiento",',
    '      "cuota_actual": number | null,',
    '      "cuotas_totales": number | null,',
    '      "categoria_sugerida": string | null,',
    '      "subcategoria_sugerida": string | null,',
    '      "confianza": number',
    '    }',
    '  ]',
    '}',
    'Reglas:',
    '- Extraé solo DETALLE DEL CONSUMO y cargos/impuestos relevantes del resumen, no textos legales.',
    '- No incluyas SALDO ANTERIOR ni pagos de la tarjeta como gastos personales, salvo impuestos/cargos del resumen.',
    '- Conservá consumos en USD como moneda USD y monto USD, no los conviertas a pesos.',
    '- Si aparece OPENAI *CHATGPT, clasificalo como Suscripciones / Herramientas IA.',
    '- Si aparece ANTHROPIC/CLAUDE, clasificalo como Suscripciones / Herramientas IA.',
    '- Si hay cuota 02/09, cuota_actual=2 y cuotas_totales=9.',
    caption ? `Caption del usuario: ${caption}` : '',
    `Nombre de archivo: ${fileName}`
  ].filter(Boolean).join('\n');

  // Si pdf-parse ya extrajo texto local usable, se lo mandamos a Gemini como
  // texto plano: es una llamada mucho más rápida que comprensión multimodal
  // del PDF entero, y evita el timeout de 60s de Vercel (Hobby plan) en
  // resúmenes largos. El modo multimodal (inlineData, más lento) queda como
  // último recurso solo si no hay texto local (ej: PDF escaneado/imagen).
  const usableText = (pdfText || '').trim();
  const MAX_TEXT_CHARS = 60000;
  const truncated = usableText.length > MAX_TEXT_CHARS;
  const textForPrompt = truncated ? usableText.slice(0, MAX_TEXT_CHARS) : usableText;

  const parts = usableText
    ? [{ text: `${prompt}

Texto extraído del documento (pdf-parse${truncated ? ', truncado' : ''}):
${textForPrompt}` }]
    : [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'application/pdf', data: buffer.toString('base64') } }
      ];

  try {
    const response = await withGemini(ai => ai.models.generateContent({
      model: config.geminiModel(),
      contents: [{ role: 'user', parts }]
    }), { operationName: 'importación financiera PDF', timeoutMs: 45000, maxAttempts: 1 });

    const jsonText = extractJsonObject(response.text || '');
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    const normalized = normalizeParsedDocument(parsed);
    if (!normalized.movimientos.length) return null;
    return normalized;
  } catch (error: any) {
    console.error('Fallback Gemini para importación financiera falló:', error?.message || error);
    return null;
  }
}

function extractJsonObject(text: string) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function parseXlsxFinance(buffer: Buffer, fileName: string): ParsedFinanceDocument {
  const empty: ParsedFinanceDocument = {
    es_resumen_financiero: false, tipo_fuente: 'documento_financiero', proveedor: null, cuenta: null, tarjeta: null,
    periodo: null, fecha_cierre: null, fecha_vencimiento: null, total_pesos: null, total_dolares: null, pago_minimo: null, movimientos: []
  };
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : null;
    if (!sheet) return empty;
    // Reusa el mismo parser genérico de CSV (detección de columnas fecha/monto/descripción
    // por encabezado) convirtiendo la primera hoja a texto CSV.
    const csvText = XLSX.utils.sheet_to_csv(sheet);
    return parseCsvFinance(csvText, fileName);
  } catch (error: any) {
    console.error('No pude leer el Excel financiero:', error?.message || error);
    return empty;
  }
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
  const stats: { autoInserted: number; matchedManual: number; pending: number; ignored: number; movements: any[] } =
    { autoInserted: 0, matchedManual: 0, pending: 0, ignored: 0, movements: [] };
  for (const row of rows) {
    if (row.estado === 'ignorado' || row.movimiento_id) continue;
    if (row.estado === 'pendiente_revision') {
      stats.pending += 1;
      continue;
    }

    const alreadyConsolidated = await findMovementByExternalHash(row.external_hash);
    if (alreadyConsolidated) {
      await supabase.from('finanzas_movimientos_importados').update({
        estado: 'importado',
        movimiento_id: alreadyConsolidated.id,
        match_score: 1,
        match_reason: 'ya existía movimiento consolidado con el mismo external_hash',
        updated_at: new Date().toISOString()
      }).eq('id', row.id);
      stats.autoInserted += 1;
      stats.movements.push(alreadyConsolidated);
      continue;
    }

    const match = await findManualMatch(row);
    if (match) {
      const updated = await mergeImportedIntoMovement(row, match);
      await markImportedConciliated(row, updated, match.score, match.reason);
      stats.matchedManual += 1;
      stats.movements.push(updated);
      continue;
    }

    const movement = await createMovementFromImported(row);
    await supabase.from('finanzas_movimientos_importados').update({ estado: 'importado', movimiento_id: movement.id, updated_at: new Date().toISOString() }).eq('id', row.id);
    stats.autoInserted += 1;
    stats.movements.push(movement);
  }
  return stats;
}

async function findMovementByExternalHash(externalHash: string | null) {
  if (!externalHash) return null;
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .eq('external_hash', externalHash)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function createMovementFromImported(row: any) {
  // Antes el comercio quedaba tal cual lo escribio el resumen (ej: "PAYU*AR*UBER1234"),
  // asi que "cuanto gaste en Uber" no encontraba nada si el texto cambiaba de un resumen
  // a otro. Ahora se resuelve contra las entidades maestras conocidas: si hay match, el
  // comercio se normaliza al nombre canonico y el texto crudo queda aprendido como alias.
  const entity = await resolveAndLearnEntity(row.comercio_detectado || row.descripcion_original).catch(() => null);
  const comercio = entity?.nombre || row.comercio_detectado || row.descripcion_original;
  const categoria = row.categoria_confirmada || row.categoria_sugerida || entity?.categoria || 'Otros';
  const subcategoria = row.subcategoria_confirmada || row.subcategoria_sugerida || entity?.subcategoria || null;

  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .insert({
      fecha_movimiento: row.fecha_movimiento || new Date().toISOString().slice(0, 10),
      tipo: mapImportedTypeToMovementType(row.tipo),
      monto: Number(row.monto || 0),
      moneda: row.moneda || 'ARS',
      descripcion: row.descripcion_original,
      categoria_financiera: categoria,
      subcategoria_financiera: subcategoria,
      medio_pago: row.tarjeta ? `${row.tarjeta} crédito` : row.proveedor || null,
      tarjeta: row.tarjeta || null,
      banco_billetera: row.proveedor || null,
      comercio,
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
  const entity = await resolveAndLearnEntity(row.comercio_detectado || row.descripcion_original).catch(() => null);
  const patch: any = {
    monto: Number(row.monto || current.monto || 0),
    moneda: row.moneda || current.moneda || 'ARS',
    comercio: entity?.nombre || row.comercio_detectado || current.comercio || null,
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

export async function processFinanceImportation(importacionId?: string | null) {
  let id = importacionId || null;
  if (!id) {
    const latest = await latestFinanceImport();
    id = latest?.id || null;
  }
  if (!id) {
    return {
      ok: false as const,
      message: 'No hay importaciones financieras para procesar.',
      processed: { autoInserted: 0, matchedManual: 0, pending: 0, ignored: 0 },
      stats: { total: 0 } as Record<string, number>
    };
  }

  // Procesa filas que quedaron en staging como "clasificado" pero sin movimiento final.
  // No toca pendientes de revisión: esos requieren /clasificar.
  const { data, error } = await supabase
    .from('finanzas_movimientos_importados')
    .select('*')
    .eq('importacion_id', id)
    .eq('estado', 'clasificado')
    .is('movimiento_id', null)
    .limit(1000);
  if (error) throw error;

  const processed = await autoProcessImportedRowsWithRules(data || []);
  await updateImportationState(id);
  return {
    ok: true as const,
    importacion_id: id,
    processed,
    stats: await buildImportStats(id)
  };
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

export async function getUnsyncedImportedMovements(limit = 200) {
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .eq('origen', 'importacion')
    .is('notion_page_id', null)
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function getPendingImportedMovements(limit = 12, importacionId?: string | null) {
  let q = supabase.from('finanzas_movimientos_importados').select('*, finanzas_importaciones(periodo,tarjeta,proveedor,nombre_archivo)').eq('estado', 'pendiente_revision').order('created_at', { ascending: true }).limit(limit);
  if (importacionId) q = q.eq('importacion_id', importacionId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Si el usuario responde solo con el texto de la sugerencia (ej: "sin categoría"),
// sin el número del pendiente adelante ("8 es ..."), antes esto no matcheaba
// ningún handler de finanzas y terminaba guardado como una nota genérica sin
// relación con el movimiento. Devuelve las posiciones (1-based, mismas que se
// muestran como "#N") cuya sugerencia coincide exactamente con el texto.
export async function findPendingIndicesMatchingSuggestion(text: string): Promise<number[]> {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return [];
  const rows = await getPendingImportedMovements(30);
  const indices: number[] = [];
  rows.forEach((row: any, i: number) => {
    const suggestion = String(row.categoria_sugerida || 'sin categoría').trim().toLowerCase();
    if (suggestion === needle) indices.push(i + 1);
  });
  return indices;
}

export async function classifyImportedMovementByIndex(index: number, categoryText: string, saveRule: boolean, entidadNombre?: string | null, detalle?: string | null) {
  const rows = await getPendingImportedMovements(30);
  const row = rows[index - 1];
  if (!row) return { ok: false as const, message: `No encontré pendiente #${index}. Usá /importacion revisar.` };
  return applyClassificationToRow(row, categoryText, saveRule, entidadNombre, detalle);
}

async function applyClassificationToRow(row: any, categoryText: string, saveRule: boolean, entidadNombre?: string | null, detalle?: string | null) {
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

  // Si el usuario nos dijo explícitamente qué entidad es (ej: "es mercado pago"), la
  // registramos como entidad maestra y guardamos el texto crudo del resumen como alias,
  // para que la próxima vez que aparezca (aunque cambie el sufijo/código) se reconozca sola.
  if (entidadNombre) {
    try {
      const master = await upsertMasterEntity({ nombre: entidadNombre, categoria: parsed.category, subcategoria: parsed.subcategory });
      await upsertEntityAlias(master.id, updated.comercio_detectado || updated.descripcion_original, 'clarificacion_usuario');
      updated.comercio_detectado = master.nombre;
    } catch (entityError) {
      console.error('No pude registrar la entidad a partir de la respuesta del usuario:', entityError);
    }
  }

  // Si el usuario contó qué compró o para qué fue el gasto además de la categoría/entidad,
  // se suma a la descripción para no perderlo (antes se descartaba por completo).
  if (detalle) {
    updated.descripcion_original = updated.descripcion_original
      ? `${updated.descripcion_original} — ${detalle}`
      : detalle;
  }

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

// Agrupa pendientes por comercio para no tener que clasificar el mismo comercio
// varias veces (ej: 4 transferencias distintas a la misma persona). El orden y la
// clave de agrupación son deterministas (mismo criterio que merchant_key/comercio),
// así que el mismo índice de grupo resuelve a lo mismo entre el listado y la
// clasificación, mientras no se clasifique nada en el medio.
export async function getGroupedPendingImportedMovements(limit = 60) {
  const rows = await getPendingImportedMovements(limit);
  const groups: { key: string; label: string; rows: any[]; count: number; total: number; categoria_sugerida: string | null }[] = [];
  const byKey = new Map<string, typeof groups[number]>();

  for (const row of rows) {
    const rawKey = row.merchant_key || merchantKeyFrom(row.comercio_detectado || row.descripcion_original || '');
    const key = rawKey && rawKey.trim().length >= 3 ? rawKey : `__row_${row.id}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: clean(row.comercio_detectado) || clean(row.descripcion_original) || 'Sin descripción',
        rows: [],
        count: 0,
        total: 0,
        categoria_sugerida: row.categoria_sugerida || null
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
    group.count += 1;
    group.total += Number(row.monto || 0);
  }

  return groups;
}

export function formatPendingImportedGrouped(groups: Awaited<ReturnType<typeof getGroupedPendingImportedMovements>>) {
  if (!groups.length) return 'Importación financiera\n\nNo hay movimientos pendientes de clasificar.';
  const lines = ['Pendientes por clasificar (agrupados por comercio)', ''];
  groups.forEach((g, i) => {
    const montoTxt = formatMoney(g.total, 'ARS');
    lines.push(`#${i + 1} — ${g.label} (${g.count} mov., ${montoTxt})`);
    if (g.count === 1) {
      const r = g.rows[0];
      lines.push(`   ${r.fecha_movimiento || '-'} — ${formatMoney(Number(r.monto || 0), r.moneda || 'ARS')}`);
    }
    lines.push('');
  });
  lines.push('Para clasificar todo junto en un mensaje: 1 kiosco, 2 ferreteria, 3 nafta');
  lines.push('También sirve uno por línea, o /clasificar 1 Categoria guardar regla para guardar la regla de ese comercio.');
  return lines.join('\n');
}

export async function classifyGroupByIndex(groupIndex: number, categoryText: string, saveRule: boolean, entidadNombre?: string | null, detalle?: string | null) {
  const groups = await getGroupedPendingImportedMovements(60);
  const group = groups[groupIndex - 1];
  if (!group) return { ok: false as const, message: `No encontré el grupo #${groupIndex}. Usá /importacion revisar.` };

  const results: Awaited<ReturnType<typeof applyClassificationToRow>>[] = [];
  for (const row of group.rows) {
    results.push(await applyClassificationToRow(row, categoryText, saveRule, entidadNombre, detalle));
  }
  const ok = results.every(r => r.ok);
  return { ok, label: group.label, count: group.count, results };
}

// Igual que classifyGroupByIndex pero interpretando la respuesta en lenguaje natural
// una sola vez (con la primera fila del grupo como contexto) y aplicándola a todas
// las filas del grupo, en vez de llamar a Gemini una vez por fila.
export async function classifyGroupFromAnswer(groupIndex: number, answerText: string) {
  const groups = await getGroupedPendingImportedMovements(60);
  const group = groups[groupIndex - 1];
  if (!group) return { ok: false as const, message: `No encontré el grupo #${groupIndex}. Usá /importacion revisar.` };

  const interpreted = await interpretPendingAnswerWithGemini(group.rows[0], answerText);
  const fallback = parseCategoryAndSubcategory(answerText);
  const categoria = interpreted?.categoria || fallback.category || 'Otros';
  const subcategoria = interpreted?.subcategoria || fallback.subcategory || null;
  const categoryText = [categoria, subcategoria].filter(Boolean).join(' / ');

  const results: Awaited<ReturnType<typeof applyClassificationToRow>>[] = [];
  for (const row of group.rows) {
    results.push(await applyClassificationToRow(row, categoryText, false, interpreted?.entidad_nombre || null, interpreted?.detalle || null));
  }
  const ok = results.every(r => r.ok);
  return { ok, label: group.label, count: group.count, results };
}

export function formatClassifyGroupResult(result: Awaited<ReturnType<typeof classifyGroupByIndex>>) {
  if (!result.ok || !('results' in result)) return (result as any).message || 'No pude clasificar el grupo.';
  const first = result.results.find(r => r.ok) as any;
  const categoria = first?.movement?.categoria_financiera || '-';
  const lines = [
    `Grupo clasificado: ${result.label}`,
    '',
    `Movimientos actualizados: ${result.count}`,
    `Categoría: ${categoria}`
  ];
  const failed = result.results.filter(r => !r.ok);
  if (failed.length) lines.push('', `${failed.length} no se pudieron actualizar: ${failed.map((r: any) => r.message).join('; ')}`);
  return lines.join('\n');
}

export async function ignoreGroupByIndex(groupIndex: number) {
  const groups = await getGroupedPendingImportedMovements(60);
  const group = groups[groupIndex - 1];
  if (!group) return { ok: false as const, message: `No encontré el grupo #${groupIndex}. Usá /importacion revisar.` };
  for (const row of group.rows) {
    const { error } = await supabase.from('finanzas_movimientos_importados').update({ estado: 'ignorado', updated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) throw error;
    await updateImportationState(row.importacion_id);
  }
  return { ok: true as const, label: group.label, count: group.count };
}

export function formatIgnoreGroupResult(result: Awaited<ReturnType<typeof ignoreGroupByIndex>>) {
  if (!result.ok) return (result as any).message || 'No pude ignorar el grupo.';
  return `Grupo ignorado: ${result.label} (${result.count} movimientos).`;
}

// Versión agrupada de findPendingIndicesMatchingSuggestion: devuelve índices de
// GRUPO (no de fila) cuya sugerencia coincide con el texto.
export async function findGroupIndicesMatchingSuggestion(text: string): Promise<number[]> {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return [];
  const groups = await getGroupedPendingImportedMovements(60);
  const indices: number[] = [];
  groups.forEach((g, i) => {
    const suggestion = String(g.categoria_sugerida || 'sin categoría').trim().toLowerCase();
    if (suggestion === needle) indices.push(i + 1);
  });
  return indices;
}

export async function interpretPendingAnswerWithGemini(row: any, answerText: string) {
  if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY_2) return null;
  const prompt = [
    'Un movimiento de un resumen de tarjeta no se pudo clasificar automáticamente y el usuario explicó qué es.',
    `Descripción original del resumen: ${row.descripcion_original || row.comercio_detectado || '-'}`,
    `Monto: ${row.monto} ${row.moneda || 'ARS'}`,
    `Fecha: ${row.fecha_movimiento || '-'}`,
    `Respuesta del usuario: "${answerText}"`,
    'Devolvé SOLO JSON válido, sin markdown, con esta forma exacta:',
    '{ "entidad_nombre": string | null, "categoria": string, "subcategoria": string | null, "detalle": string | null }',
    'Reglas:',
    '- "entidad_nombre": el nombre del comercio/servicio/persona que el USUARIO diga en su respuesta (ej: "panadería de la esquina", "mi hermano", "Farmacity"). Priorizá siempre lo que dice el usuario por sobre la descripción original del resumen: si el usuario nombra un comercio distinto al que aparece ahí (por ejemplo, el resumen trae el nombre de una persona pero el usuario dice que fue una panadería), usá lo que dijo el usuario. No repitas el texto crudo del resumen salvo que el usuario lo confirme. Si el usuario solo mencionó el medio de pago (ej: "es mercado pago") sin nombrar comercio, usá null.',
    '- "categoria" y "subcategoria": basate en lo que el usuario CONTÓ que fue el gasto o para qué lo usó (ej: "es un sándwich que compré para cenar" → Comida afuera; "entrada a un recital" → Ocio), NO en la descripción original del resumen ni en ninguna sugerencia previa. Usá la descripción original del resumen solo como apoyo si la respuesta del usuario es ambigua y no dice de qué se trató el gasto. Categorías cortas, en español, consistentes con categorías de gastos personales (ej: Supermercado, Transporte, Salud, Comida afuera, Ocio, Deudas / compartidos, Servicios, Otros).',
    '- "detalle": si el usuario contó qué compró, para qué fue el gasto, o cualquier detalle adicional más allá de la categoría/entidad (ej: "pastafrola y biscochitos", "arreglo de la bici"), un resumen corto de eso en sus palabras. Si no agregó nada más, null.'
  ].join('\n');

  try {
    const response = await withGemini(ai => ai.models.generateContent({
      model: config.geminiModel(),
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    }), { operationName: 'interpretar respuesta de clasificación' });
    const jsonText = extractJsonObject(response.text || '');
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    return {
      entidad_nombre: parsed.entidad_nombre ? String(parsed.entidad_nombre).trim() : null,
      categoria: parsed.categoria ? String(parsed.categoria).trim() : null,
      subcategoria: parsed.subcategoria ? String(parsed.subcategoria).trim() : null,
      detalle: parsed.detalle ? String(parsed.detalle).trim() : null
    };
  } catch (error: any) {
    console.error('No pude interpretar respuesta de clasificación con Gemini:', error?.message || error);
    return null;
  }
}

// Permite responder en lenguaje natural ("1 es mercado pago, le pagué a mi hermano por
// nafta") en vez de tener que usar la sintaxis rígida de /clasificar. Usa Gemini para
// interpretar categoría + entidad; si Gemini no está disponible, cae a un parser simple.
export async function classifyImportedMovementFromAnswer(index: number, answerText: string) {
  const rows = await getPendingImportedMovements(30);
  const row = rows[index - 1];
  if (!row) return { ok: false as const, message: `No encontré pendiente #${index}. Usá /importacion revisar.` };

  const interpreted = await interpretPendingAnswerWithGemini(row, answerText);
  const fallback = parseCategoryAndSubcategory(answerText);
  const categoria = interpreted?.categoria || fallback.category || 'Otros';
  const subcategoria = interpreted?.subcategoria || fallback.subcategory || null;
  const categoryText = [categoria, subcategoria].filter(Boolean).join(' / ');

  return classifyImportedMovementByIndex(index, categoryText, false, interpreted?.entidad_nombre || null, interpreted?.detalle || null);
}

// Corrige el último finanzas_movimientos YA consolidado (no un pendiente de
// importación) a partir de una respuesta en lenguaje natural: "es panadería".
// Aprende el alias (comercio/descripción original -> entidad) igual que el
// flujo de pendientes, para que la próxima vez se reconozca solo.
export async function correctLastFinanceMovementFromText(answerText: string) {
  const { data: current, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!current) return null;

  const interpreted = await interpretPendingAnswerWithGemini({
    descripcion_original: current.descripcion || current.comercio,
    monto: current.monto,
    moneda: current.moneda,
    fecha_movimiento: current.fecha_movimiento
  }, answerText);
  const fallback = parseCategoryAndSubcategory(answerText);
  const categoria = interpreted?.categoria || fallback.category || current.categoria_financiera || 'Otros';
  const subcategoria = interpreted?.subcategoria || fallback.subcategory || current.subcategoria_financiera || null;

  let comercio = current.comercio;
  if (interpreted?.entidad_nombre) {
    try {
      const master = await upsertMasterEntity({ nombre: interpreted.entidad_nombre, categoria, subcategoria });
      await upsertEntityAlias(master.id, current.comercio || current.descripcion || '', 'correccion_usuario');
      comercio = master.nombre;
    } catch (entityError) {
      console.error('No pude registrar la entidad de la corrección de gasto:', entityError);
    }
  }

  const descripcion = interpreted?.detalle
    ? `${current.descripcion || ''}${current.descripcion ? ' — ' : ''}${interpreted.detalle}`.trim()
    : current.descripcion;

  const { data: updated, error: updateError } = await supabase
    .from('finanzas_movimientos')
    .update({
      categoria_financiera: categoria,
      subcategoria_financiera: subcategoria,
      comercio,
      descripcion,
      updated_at: new Date().toISOString()
    })
    .eq('id', current.id)
    .select()
    .single();
  if (updateError) throw updateError;
  return updated;
}

async function saveCommerceRuleFromImported(row: any, category: string, subcategory: string | null) {
  const patron = row.merchant_key || merchantKeyFrom(row.comercio_detectado || row.descripcion_original);
  if (!patron || patron.trim().length < 3) {
    console.error('No guardo regla de comercio: patrón vacío o demasiado corto.', { row_id: row?.id, comercio_detectado: row?.comercio_detectado, descripcion_original: row?.descripcion_original });
    return null;
  }
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
  const state = stats.pendiente_revision ? 'revision_pendiente' : stats.clasificado ? 'procesando' : 'procesada';
  await supabase.from('finanzas_importaciones').update({ estado: state, updated_at: new Date().toISOString() }).eq('id', importacionId);
}

async function findExistingImport(hash: string) {
  const { data, error } = await supabase.from('finanzas_importaciones').select('*').eq('archivo_hash', hash).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function summarizeFinanceAnalytics(text: string, overrides?: { startPeriod?: string; endPeriod?: string; terms?: string[]; label?: string }) {
  // El router de intencion (Gemini) puede resolver el periodo/terminos el mismo
  // y pasarlos ya normalizados, evitando los limites de los parsers heuristicos
  // extractAnalyticsTarget/extractAnalyticsPeriod. Sin overrides, el
  // comportamiento es igual que siempre (parseo por texto).
  const target = overrides?.terms && overrides.terms.length
    ? { label: overrides.label || overrides.terms.join(' ') || 'gastos consultados', terms: overrides.terms }
    : extractAnalyticsTarget(text);
  const period = overrides?.startPeriod && overrides?.endPeriod
    ? {
        label: `${overrides.startPeriod} a ${overrides.endPeriod}`,
        start: `${overrides.startPeriod}-01`,
        end: lastDayOfMonth(Number(overrides.endPeriod.slice(0, 4)), Number(overrides.endPeriod.slice(5, 7)))
      }
    : extractAnalyticsPeriod(text);
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .gte('fecha_movimiento', period.start)
    .lte('fecha_movimiento', period.end)
    .order('fecha_movimiento', { ascending: true })
    .limit(2000);
  if (error) throw error;
  const consolidatedRows = (data || []).filter((row: any) => matchesAnalyticsTarget(row, target));
  const importedRows = await loadUnconsolidatedImportedAnalyticsRows(period, target);
  // Antes esta funcion solo miraba finanzas_movimientos / finanzas_movimientos_importados
  // (resumenes de tarjeta, gastos escritos a mano). Los comprobantes fotografiados
  // (facturas/tickets) viven en otra tabla aparte y nunca se sumaban aca — por eso
  // "cuanto gaste en Gillette" no encontraba nada aunque el comprobante estaba cargado.
  const comprobanteRows = await loadComprobanteAnalyticsRows(period, target);
  const rows = [...consolidatedRows, ...importedRows, ...comprobanteRows];
  return { target, period, rows, totals: totalsByCurrency(rows), monthly: totalsByMonthAndCurrency(rows) };
}

async function loadComprobanteAnalyticsRows(period: { start: string; end: string }, target: { terms: string[] }) {
  // Sin termino especifico (ej: "cuanto gaste este mes" a secas) no traemos comprobantes:
  // ya estan cubiertos a nivel comercio por los movimientos de tarjeta/cuenta, y sumar
  // ademas cada item de cada ticket duplicaria el total. Con un termino puntual (una marca,
  // un producto) el riesgo de doble conteo es bajo porque los movimientos bancarios no
  // suelen tener el nombre del producto, solo el comercio.
  if (!target.terms.length) return [];

  const { data, error } = await supabase
    .from('finanzas_comprobante_items')
    .select('*, finanzas_comprobantes!inner(fecha_emision,comercio,moneda,movimiento_financiero_id)')
    .gte('finanzas_comprobantes.fecha_emision', period.start)
    .lte('finanzas_comprobantes.fecha_emision', period.end)
    // Si el comprobante ya quedo conciliado con un movimiento bancario, ese gasto ya esta
    // contado arriba (finanzas_movimientos) — lo excluimos de aca para no duplicarlo.
    .is('finanzas_comprobantes.movimiento_financiero_id', null)
    .limit(2000);
  if (error) throw error;

  return (data || [])
    .map((row: any) => {
      const comp = row.finanzas_comprobantes || {};
      return {
        fecha_movimiento: comp.fecha_emision || null,
        monto: Math.max(0, Number(row.importe || 0)),
        moneda: comp.moneda || 'ARS',
        comercio: comp.comercio || null,
        descripcion: row.descripcion || null,
        categoria_financiera: row.categoria || null,
        subcategoria_financiera: row.subcategoria || null,
        medio_pago: null,
        tarjeta: null,
        banco_billetera: null,
        merchant_key: row.marca || null,
        origen: 'comprobante'
      };
    })
    .filter((row: any) => matchesAnalyticsTarget(row, target));
}

async function loadUnconsolidatedImportedAnalyticsRows(period: { start: string; end: string }, target: { terms: string[] }) {
  const { data, error } = await supabase
    .from('finanzas_movimientos_importados')
    .select('*')
    .gte('fecha_movimiento', period.start)
    .lte('fecha_movimiento', period.end)
    .is('movimiento_id', null)
    .in('estado', ['clasificado', 'pendiente_revision'])
    .limit(2000);
  if (error) throw error;
  return (data || [])
    .map((row: any) => ({
      id: row.id,
      fecha_movimiento: row.fecha_movimiento,
      monto: Number(row.monto || 0),
      moneda: row.moneda || 'ARS',
      comercio: row.comercio_detectado || row.descripcion_original,
      descripcion: row.descripcion_original,
      categoria_financiera: row.categoria_confirmada || row.categoria_sugerida || null,
      subcategoria_financiera: row.subcategoria_confirmada || row.subcategoria_sugerida || null,
      medio_pago: row.tarjeta ? `${row.tarjeta} crédito` : row.proveedor || null,
      tarjeta: row.tarjeta || null,
      banco_billetera: row.proveedor || null,
      merchant_key: row.merchant_key || null,
      origen: 'importacion_no_consolidada'
    }))
    .filter((row: any) => matchesAnalyticsTarget(row, target));
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
    const extra = row.origen === 'importacion_no_consolidada'
      ? ' [importado no consolidado]'
      : row.origen === 'comprobante'
        ? ' [comprobante]'
        : '';
    lines.push(`- ${row.fecha_movimiento}: ${formatMoney(Number(row.monto || 0), row.moneda || 'ARS')} — ${row.comercio || row.descripcion || '-'}${extra}`);
  }
  return lines.join('\n');
}

export function formatProcessImportResult(result: Awaited<ReturnType<typeof processFinanceImportation>>) {
  if (!result.ok) return result.message;
  const p = result.processed;
  const s = result.stats || {};
  return [
    'Importación financiera procesada.',
    '',
    `Importados ahora: ${p.autoInserted || 0}`,
    `Conciliados con gastos manuales: ${p.matchedManual || 0}`,
    `Pendientes de clasificar: ${s.pendiente_revision || 0}`,
    `Clasificados sin consolidar: ${s.clasificado || 0}`,
    `Total detectados: ${s.total || 0}`,
    '',
    (s.clasificado || 0) > 0
      ? 'Todavía quedan clasificados sin consolidar. Revisá /logs o /diagnostico si esto se repite.'
      : 'Listo. Ahora los reportes deberían encontrar esos movimientos.'
  ].join('\n');
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
  if (stats.clasificado) lines.push(`Clasificados sin consolidar: ${stats.clasificado || 0}`);
  lines.push(`Pendientes de clasificar: ${stats.pendiente_revision || 0}`);
  lines.push(`Ignorados: ${stats.ignorado || 0}`);
  const processed = (result as any).processed?.processed || (result as any).processed;
  if (processed && (processed.autoInserted || processed.matchedManual || processed.pending)) {
    lines.push('');
    lines.push(`Consolidación automática: ${processed.autoInserted || 0} importados, ${processed.matchedManual || 0} conciliados, ${processed.pending || 0} pendientes.`);
  }
  if (stats.clasificado) {
    lines.push('');
    lines.push('Hay movimientos clasificados que todavía no quedaron como gasto consolidado. Mandá: /importacion procesar');
  }
  const pendingList = (result as any).pendingList as any[] | undefined;
  if (pendingList && pendingList.length) {
    lines.push('', pendingList.length > 1 ? `No reconocí ${pendingList.length} movimientos. Contame qué son:` : 'No reconocí este movimiento. Contame qué es:');
    pendingList.forEach((row, idx) => lines.push('', formatOnePending(row, idx + 1)));
    lines.push('', 'Respondé así: "1 es mercado pago, le pagué a mi hermano por nafta" (funciona con cualquiera de los números de arriba).');
    lines.push('También podés usar: /clasificar 1 Categoria guardar regla');
  } else if (result.nextPending) {
    lines.push('', 'Próximo pendiente:');
    lines.push(formatOnePending(result.nextPending, 1));
    lines.push('', 'Respondé: "1 es ..." o /clasificar 1 Categoria guardar regla');
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
  if (!key || key.trim().length < 3) return null;
  const { data, error } = await supabase.from('finanzas_reglas_comercios').select('*').eq('aplicar_auto', true).limit(500);
  if (error) throw error;
  return (data || []).find((r: any) => r.patron && r.patron.trim().length >= 3 && (key.includes(r.patron) || r.patron.includes(key))) || null;
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

function isXlsxLike(fileName: string, mimeType: string) {
  const name = String(fileName || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  return /\.xlsx?$|\.xlsm$/.test(name) || mime.includes('spreadsheetml') || mime.includes('ms-excel');
}

function isCsvLike(fileName: string, mimeType: string) {
  return /\.csv$|\.txt$/i.test(fileName) || /csv|text\/plain|excel|spreadsheet/i.test(mimeType);
}

function isPdfLike(fileName: string, mimeType: string) {
  return /\.pdf$/i.test(fileName) || /application\/pdf/i.test(mimeType);
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
  // Saco signos de pregunta/exclamacion/puntuacion antes de todo: si no, "uber?" queda
  // como termino de busqueda y nunca matchea el comercio real "uber" guardado en la base.
  const t = norm(text).replace(/[¿?¡!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/chat\s*gpt|chatgpt|openai/.test(t)) return { label: 'ChatGPT / OpenAI', terms: ['openai', 'chatgpt', 'chat gpt'] };
  const cleaned = t
    .replace(/^\/?reporte gastos?\s*/g, '')
    .replace(/cu[aá]nto|cuanto|gaste|gast[eé]|gastaste|ultimamente|últimamente|total|en|este|esta|año|ano|mes|llevo|vengo|suscripcion|suscripción|de|la|el|los|las|por/g, ' ')
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
