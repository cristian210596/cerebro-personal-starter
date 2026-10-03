import {
  getGroupedPendingImportedMovements,
  classifyGroupByIndex,
  ignoreGroupByIndex,
  importFinanceFile,
  formatImportResult,
  extractJsonObject
} from './financeImport.js';
import { unifiedSearch } from './chatPro.js';
import { summarizeSalaryFromText, importSalaryReceiptFromFile, formatSalaryImportResult, looksLikeSalaryFile } from './salary.js';
import { buildFinanceDashboardData } from './financeDashboardData.js';
import { importComprobanteFromFile, formatComprobanteImportResult, looksLikeComprobanteFile } from './comprobantes.js';
import { saveFinanceFromText, formatFinanceSaved } from './finance.js';
import { classifyText } from './classifier.js';
import { saveItem, supabase } from './supabaseClient.js';
import { syncPendingImportedMovementsToNotion, createNotionItemPage, syncNotionDerivedForItem } from './notion.js';
import { withGemini } from './geminiPool.js';
import { config } from './config.js';

function isPdfOrSpreadsheet(filename: string, mimetype: string) {
  const f = (filename || '').toLowerCase();
  const m = (mimetype || '').toLowerCase();
  return m.includes('pdf') || m.includes('spreadsheet') || m.includes('csv') || /\.(pdf|xlsx?|csv)$/.test(f);
}

// Último recurso cuando el documento no encajó en ninguno de los 4 moldes
// específicos (cada uno con su propia tabla/schema fijo). En vez de rendirse,
// esto analiza el documento en general: qué es, de quién, cuánto, cuándo
// vence. No inventa una tabla nueva por tipo de documento — lo guarda como
// nota estructurada y buscable, con los datos ya extraídos, para que el
// usuario decida qué hacer (ej: cargarlo como gasto con add_manual_expense).
async function extractGenericFinancialDocument(buffer: Buffer, mimeType: string, filename: string, caption: string) {
  const prompt = [
    'Analizá este documento. No asumas que tiene que ser un ticket de compra, un recibo de sueldo, un resumen de tarjeta/cuenta, ni una captura de pago — puede ser cualquier otra cosa con contenido financiero: una factura de servicio (prepaga, luz, gas, internet, alquiler, seguro), un contrato, un estado de deuda, una notificación de vencimiento, etc.',
    'Primero decidí si tiene contenido financiero relevante para un sistema personal de gastos (es_financiero). Si es un documento sin ningún dato financiero (una foto random, un documento de identidad, etc.), es_financiero=false.',
    'No inventes ningún dato: si algo no está claramente visible, usá null.',
    'Devolvé SOLO JSON válido, sin markdown. Estructura exacta:',
    '{',
    '  "es_financiero": true|false,',
    '  "tipo_documento": string|null,',
    '  "entidad": string|null,',
    '  "concepto": string|null,',
    '  "periodo": "YYYY-MM"|null,',
    '  "moneda": "ARS"|"USD"|null,',
    '  "monto_total": number|null,',
    '  "monto_a_pagar_ahora": number|null,',
    '  "fecha_emision": "YYYY-MM-DD"|null,',
    '  "fecha_vencimiento": "YYYY-MM-DD"|null,',
    '  "descripcion": string|null,',
    '  "resumen_para_el_usuario": string|null',
    '}',
    'Reglas:',
    '- "tipo_documento": describilo en pocas palabras (ej: "Factura de prepaga", "Estado de deuda", "Contrato de alquiler").',
    '- "entidad": quién emite el documento (ej: "Swiss Medical", "Edenor").',
    '- "monto_a_pagar_ahora": lo que efectivamente hay que pagar en esta instancia (puede ser 0 si el saldo quedó en cero por descuentos/bonificaciones — no es un error, es un dato real).',
    '- "resumen_para_el_usuario": 1-2 frases en español explicando qué es este documento y qué se puede hacer con él (ej: "cargarlo como gasto pendiente", "es solo informativo, no requiere acción"), para mostrárselo directo al usuario.',
    caption ? `Caption del usuario: ${caption}` : '',
    filename ? `Nombre de archivo: ${filename}` : ''
  ].filter(Boolean).join('\n');

  const response: any = await withGemini(ai => ai.models.generateContent({
    model: config.geminiModel(),
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'application/octet-stream', data: buffer.toString('base64') } }
      ]
    }]
  }), { operationName: 'análisis genérico de documento', timeoutMs: 45000, maxAttempts: 1 });

  const jsonText = extractJsonObject(response.text || '');
  if (!jsonText) return null;
  try { return JSON.parse(jsonText); } catch { return null; }
}

async function saveGenericFinancialDocumentAsNote(data: any, filename: string) {
  const titulo = [data.tipo_documento, data.entidad].filter(Boolean).join(' — ') || `Documento financiero (${filename})`;
  const resumen = data.resumen_para_el_usuario || data.descripcion || null;
  const item = await saveItem({
    fuente: 'agente',
    texto_original: JSON.stringify(data),
    titulo,
    resumen,
    categoria_principal: 'Finanzas',
    subcategorias: [data.tipo_documento].filter(Boolean),
    tipo_item: 'documento_financiero',
    estado: data.monto_a_pagar_ahora > 0 ? 'pendiente' : null,
    valoracion: null,
    importancia: data.monto_a_pagar_ahora > 0 ? 'media' : 'baja',
    accion_futura: data.fecha_vencimiento ? `Vence ${data.fecha_vencimiento}` : null,
    tags: [data.entidad, data.periodo].filter(Boolean),
    entidades_json: null,
    classifier_json: data
  } as any);
  return item;
}

async function syncItemToNotion(item: any) {
  try {
    const notionPageId = await createNotionItemPage(item);
    if (notionPageId) {
      await supabase.from('items').update({ notion_page_id: notionPageId }).eq('id', item.id);
      item.notion_page_id = notionPageId;
    }
    await syncNotionDerivedForItem(item);
  } catch (error) {
    console.error('No se pudo sincronizar a Notion el item del agente:', error);
  }
}

async function tryGenericFallback(buffer: Buffer, mimeType: string, filename: string, caption: string) {
  const generic = await extractGenericFinancialDocument(buffer, mimeType, filename, caption).catch(() => null);
  if (!generic || !generic.es_financiero) {
    return { kind: null, recognized: false, texto: 'No reconocí contenido financiero en este documento.' };
  }
  const item = await saveGenericFinancialDocumentAsNote(generic, filename);
  await syncItemToNotion(item);
  const partes = [
    generic.resumen_para_el_usuario || `Detecté: ${generic.tipo_documento || 'documento financiero'} de ${generic.entidad || 'entidad no identificada'}.`,
    generic.monto_a_pagar_ahora != null ? `Monto a pagar: ${generic.monto_a_pagar_ahora} ${generic.moneda || 'ARS'}.` : '',
    generic.fecha_vencimiento ? `Vencimiento: ${generic.fecha_vencimiento}.` : '',
    `Lo guardé como nota (id ${item.id}). Si querés que además lo cargue como gasto, usá add_manual_expense con el monto y la entidad.`
  ].filter(Boolean);
  return { kind: 'documento_financiero_generico', recognized: true, texto: partes.join(' '), datos: generic };
}

export async function runAgentAction(action: string, params: any) {
  switch (action) {
    case 'list_pending': {
      const groups = await getGroupedPendingImportedMovements(60);
      return {
        groups: groups.map((g, i) => ({
          index: i + 1,
          label: g.label,
          count: g.count,
          total: g.total,
          categoria_sugerida: g.categoria_sugerida,
          ejemplos: g.rows.slice(0, 3).map((r: any) => ({ fecha: r.fecha_movimiento, monto: r.monto, descripcion: r.descripcion_original }))
        }))
      };
    }

    case 'classify_group': {
      const { index, categoria, subcategoria, entidad, detalle, guardar_regla } = params;
      if (!index || !categoria) throw new Error('Faltan index y/o categoria.');
      const categoryText = subcategoria ? `${categoria} / ${subcategoria}` : String(categoria);
      const result = await classifyGroupByIndex(Number(index), categoryText, !!guardar_regla, entidad || null, detalle || null);
      const notion = await syncPendingImportedMovementsToNotion();
      return { ...result, notion };
    }

    case 'ignore_group': {
      const { index } = params;
      if (!index) throw new Error('Falta index.');
      return await ignoreGroupByIndex(Number(index));
    }

    case 'search': {
      const { query } = params;
      if (!query) throw new Error('Falta query.');
      return await unifiedSearch(String(query));
    }

    case 'salary_report': {
      const { startPeriod, endPeriod, concept, excludeConcept } = params;
      if (!startPeriod || !endPeriod) throw new Error('Faltan startPeriod y endPeriod (formato YYYY-MM).');
      return await summarizeSalaryFromText('', {
        startPeriod: String(startPeriod),
        endPeriod: String(endPeriod),
        concept: concept ? String(concept) : null,
        excludeConcept: !!excludeConcept
      });
    }

    case 'finance_overview': {
      return await buildFinanceDashboardData();
    }

    case 'import_document': {
      const { file_base64, filename, mimetype, caption } = params;
      if (!file_base64 || !filename) throw new Error('Faltan file_base64 y/o filename.');
      const buffer = Buffer.from(String(file_base64), 'base64');
      const mt = mimetype || 'application/octet-stream';
      const cap = caption || '';
      const chatId = 0;

      // Antes: "es PDF" mandaba SIEMPRE a resumen financiero, sin importar el
      // contenido — un recibo de sueldo en PDF (formato normal para muchos
      // recibos) nunca llegaba a probarse como sueldo. Ahora se prioriza por
      // la pista del nombre/caption (looksLikeSalaryFile / looksLikeComprobanteFile),
      // sea PDF o imagen, y si hay una pista fuerte NO se encadenan más
      // intentos (cada llamada a Gemini puede tardar hasta 45s; encadenar 3-4
      // en una sola ejecución supera el tiempo máximo de la función).
      const salaryHint = looksLikeSalaryFile(filename, mt, cap);
      const comprobanteHint = looksLikeComprobanteFile(filename, mt, cap);

      if (salaryHint) {
        const salary = await importSalaryReceiptFromFile({ buffer, fileName: filename, mimeType: mt, caption: cap, chatId: String(chatId), archivoId: null, force: true });
        if (salary.recognized) return { kind: 'recibo_sueldo', recognized: true, texto: formatSalaryImportResult(salary) };
        return { kind: null, recognized: false, texto: 'No pude leer esto como recibo de sueldo. Probá con analyze_unknown_document para ver qué es en general.' };
      }

      if (comprobanteHint) {
        const comp = await importComprobanteFromFile({ buffer, fileName: filename, mimeType: mt, caption: cap, chatId, archivoId: null, force: true });
        if (comp.recognized) {
          await syncPendingImportedMovementsToNotion();
          return { kind: 'comprobante', recognized: true, texto: formatComprobanteImportResult(comp) };
        }
        return { kind: null, recognized: false, texto: 'No pude leer esto como comprobante. Probá con analyze_unknown_document para ver qué es en general.' };
      }

      if (isPdfOrSpreadsheet(filename, mt)) {
        const result = await importFinanceFile({ buffer, fileName: filename, mimeType: mt, caption: cap, chatId });
        if (result.recognized) {
          await syncPendingImportedMovementsToNotion();
          return { kind: 'resumen_financiero', recognized: true, texto: formatImportResult(result) };
        }
        return { kind: null, recognized: false, texto: 'No lo reconocí como resumen de tarjeta/cuenta. Probá con analyze_unknown_document para ver qué es en general.' };
      }

      // Imagen sin ninguna pista clara: un solo intento (comprobante, el caso
      // más común), no una cadena de varios — cada intento es una llamada a
      // Gemini de hasta 45s, y encadenar varios en una misma respuesta puede
      // superar el límite de tiempo del servidor.
      const comp = await importComprobanteFromFile({ buffer, fileName: filename, mimeType: mt, caption: cap, chatId, archivoId: null, force: false });
      if (comp.recognized) {
        await syncPendingImportedMovementsToNotion();
        return { kind: 'comprobante', recognized: true, texto: formatComprobanteImportResult(comp) };
      }
      return { kind: null, recognized: false, texto: 'No lo reconocí como comprobante, recibo de sueldo, resumen ni captura de pago. Probá con analyze_unknown_document para ver qué es en general.' };
    }

    case 'analyze_unknown_document': {
      const { file_base64, filename, mimetype, caption } = params;
      if (!file_base64 || !filename) throw new Error('Faltan file_base64 y/o filename.');
      const buffer = Buffer.from(String(file_base64), 'base64');
      const mt = mimetype || 'application/octet-stream';
      const cap = caption || '';
      return await tryGenericFallback(buffer, mt, filename, cap);
    }

    case 'add_manual_expense': {
      const { text } = params;
      if (!text) throw new Error('Falta text.');
      const result = await saveFinanceFromText({ chatId: 0, messageId: 0, text: String(text) });
      return { ok: result.ok, texto: result.ok ? formatFinanceSaved(result) : `No lo reconocí como un gasto/finanza (${(result as any).reason || 'motivo desconocido'}).` };
    }

    case 'save_note': {
      const { text } = params;
      if (!text) throw new Error('Falta text.');
      const clasificacion = await classifyText(String(text));
      const item = await saveItem({
        fuente: 'agente',
        texto_original: String(text),
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
      } as any);
      await syncItemToNotion(item);
      return { titulo: item.titulo, categoria: item.categoria_principal, id: item.id };
    }

    default:
      throw new Error(`Acción desconocida: "${action}"`);
  }
}

export const AGENT_TOOLS = [
  {
    name: 'list_pending',
    description: 'Lista los movimientos financieros pendientes de clasificar, agrupados por comercio. Devuelve {groups:[{index,label,count,total,categoria_sugerida,ejemplos}]}. Usar antes de clasificar/ignorar para saber el index correcto, y cuando el usuario pregunta qué tiene pendiente.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'classify_group',
    description: 'Clasifica TODOS los movimientos de un grupo pendiente con una categoría. Usar el index que devolvió list_pending (llamarlo primero si no se tiene fresco). Categorías típicas: Alimentos, Supermercado, Comida afuera, Transporte, Auto, Casa, Servicios, Salud, Farmacia, Ropa, Tecnología, Educación, Trabajo, Ocio, Regalos, Suscripciones, Impuestos, Alquiler, Transferencias, Deudas / compartidos, Ingreso laboral, Donaciones, Mascotas, Otros — pero se puede usar cualquier categoría en lenguaje natural si el usuario es específico.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Número de grupo de list_pending' },
        categoria: { type: 'string' },
        subcategoria: { type: 'string' },
        entidad: { type: 'string', description: 'Si el usuario aclaró quién/qué es el comercio, ponerlo acá' },
        detalle: { type: 'string', description: 'Detalle extra que haya dado el usuario (qué compró, para qué fue)' },
        guardar_regla: { type: 'boolean', description: 'true si el usuario pidió recordar/guardar esta regla para el futuro' }
      },
      required: ['index', 'categoria']
    }
  },
  {
    name: 'ignore_group',
    description: 'Ignora (descarta, no lo cuenta como gasto) todos los movimientos de un grupo pendiente. Usar el index de list_pending.',
    inputSchema: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] }
  },
  {
    name: 'search',
    description: 'Busca en TODO lo que ya está guardado en el sistema: notas, pendientes de tareas, movimientos financieros, deudas, presupuestos, memorias, sueldos, comprobantes, Y TAMBIÉN mails/correos que ya fueron procesados (llegan etiquetados desde Gmail y se guardan acá como notas). Si preguntan algo sobre "mails" o "correos", usar esta tool — no asumir que hace falta un conector de Gmail aparte, los mails ya ingeridos viven en este mismo sistema. Mandar solo 2-4 palabras clave del tema, sin relleno; si la pregunta es muy genérica (ej "mis últimos mails" sin tema), probar igual con alguna palabra razonable antes de decir que no se puede.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'salary_report',
    description: 'Reporte de sueldo (neto, bruto, retenciones, o un concepto puntual como horas extra) en un rango de períodos YYYY-MM. Para "sin <concepto>" o "excluyendo <concepto>" usar excludeConcept=true: devuelve el neto restando ese concepto en vez de sumarlo aparte.',
    inputSchema: {
      type: 'object',
      properties: {
        startPeriod: { type: 'string', description: 'YYYY-MM' },
        endPeriod: { type: 'string', description: 'YYYY-MM' },
        concept: { type: 'string' },
        excludeConcept: { type: 'boolean' }
      },
      required: ['startPeriod', 'endPeriod']
    }
  },
  {
    name: 'finance_overview',
    description: 'Panorama financiero general: gastado/ingresos/saldo del mes actual, gasto por categoría (este mes e histórico últimos 12 meses), serie mensual de cashflow, y últimos movimientos.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'import_document',
    description: 'Sube un comprobante/ticket, recibo de sueldo, resumen de tarjeta (PDF/CSV/Excel) o captura de pago. Recibe el archivo en base64 (sin el prefijo data:). Prueba UN solo tipo por llamada (el más probable según el nombre/caption). Si devuelve recognized:false, NO es un error — llamá a analyze_unknown_document con el mismo archivo para identificarlo de forma general (facturas de servicios, deudas, contratos, etc.) en vez de asumir que no se puede hacer nada con él.',
    inputSchema: {
      type: 'object',
      properties: {
        file_base64: { type: 'string', description: 'Contenido del archivo codificado en base64' },
        filename: { type: 'string' },
        mimetype: { type: 'string', description: 'ej: image/jpeg, application/pdf' },
        caption: { type: 'string' }
      },
      required: ['file_base64', 'filename']
    }
  },
  {
    name: 'analyze_unknown_document',
    description: 'Analiza un documento financiero que import_document no pudo reconocer como ninguno de sus tipos específicos (facturas de servicios, estados de deuda, contratos, notificaciones de vencimiento, etc.). Extrae entidad/monto/vencimiento en general y lo guarda como nota — no lo descarta. Usar SIEMPRE que import_document devuelva recognized:false, con el mismo archivo.',
    inputSchema: {
      type: 'object',
      properties: {
        file_base64: { type: 'string' },
        filename: { type: 'string' },
        mimetype: { type: 'string' },
        caption: { type: 'string' }
      },
      required: ['file_base64', 'filename']
    }
  },
  {
    name: 'add_manual_expense',
    description: 'Carga un gasto/ingreso/deuda contado en lenguaje natural, sin archivo (ej: "gasté 5000 en el kiosco", "me prestaron 10000 hasta fin de mes"). No usar para clasificar pendientes existentes (eso es classify_group).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'save_note',
    description: 'Guarda una nota/idea/pendiente de tarea suelta que no es ni finanzas ni una pregunta — algo que el usuario quiere que quede anotado.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }
];
