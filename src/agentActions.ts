import { priceHistory, setComprobanteItemCodes } from './productCatalog.js';
import {
  getGroupedPendingImportedMovements,
  classifyGroupByIndex,
  ignoreGroupByIndex,
  importFinanceFile,
  formatImportResult,
  extractJsonObject,
  spendingReport
} from './financeImport.js';
import { unifiedSearch } from './chatPro.js';
import { summarizeSalaryFromText, importSalaryReceiptFromFile, formatSalaryImportResult, looksLikeSalaryFile } from './salary.js';
import { buildFinanceDashboardData } from './financeDashboardData.js';
import { importComprobanteFromFile, importComprobanteFromParsedData, formatComprobanteImportResult, looksLikeComprobanteFile } from './comprobantes.js';
import { saveFinanceFromText, formatFinanceSaved } from './finance.js';
import { classifyText } from './classifier.js';
import { saveItem, supabase } from './supabaseClient.js';
import { syncPendingImportedMovementsToNotion, createNotionItemPage, syncNotionDerivedForItem, syncProductosToNotion } from './notion.js';
import { withGemini } from './geminiPool.js';
import { config } from './config.js';
import { downloadStorageRef } from './processingQueue.js';
import { findMovements, updateMovement, deleteMovement } from './movementEditor.js';

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

    case 'spending_report': {
      const { terms, categoria, startPeriod, endPeriod, incluir_ingresos, max_rows } = params;
      if (!startPeriod || !endPeriod) throw new Error('Faltan startPeriod y endPeriod (formato YYYY-MM).');
      const termList = Array.isArray(terms) ? terms.map(String) : (terms ? String(terms).split(',').map(t => t.trim()) : []);
      return await spendingReport({
        terms: termList,
        categoria: categoria ? String(categoria) : null,
        startPeriod: String(startPeriod),
        endPeriod: String(endPeriod),
        incluirIngresos: !!incluir_ingresos,
        maxRows: max_rows != null ? Number(max_rows) : undefined
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

    case 'import_comprobante_data': {
      // Ticket/factura ya leído por Claude (sin Gemini). Guarda cabecera +
      // items con precio por producto, y vincula/crea el gasto.
      const { fecha, total, items } = params;
      if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) throw new Error('Falta fecha en formato YYYY-MM-DD.');
      const totalNum = Number(total);
      if (!Number.isFinite(totalNum) || totalNum <= 0) throw new Error('Falta total (número positivo).');
      if (!Array.isArray(items) || !items.length) throw new Error('Falta items (al menos un producto).');
      for (const [i, it] of items.entries()) {
        if (!it || !String(it.descripcion || '').trim()) throw new Error(`Item ${i + 1} sin descripcion.`);
        if (!Number.isFinite(Number(it.importe))) throw new Error(`Item ${i + 1} (${it.descripcion}) sin importe numérico.`);
      }
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const sumImportes = round2(items.reduce((a: number, it: any) => a + Number(it.importe || 0), 0));
      const sumDescuentos = round2(items.reduce((a: number, it: any) => a + Math.abs(Number(it.descuento || 0)), 0));
      const subtotalNum = params.subtotal != null ? Number(params.subtotal) : null;
      const descuentosNum = params.descuentos != null ? Math.abs(Number(params.descuentos)) : null;
      const avisos: string[] = [];
      if (subtotalNum != null && Math.abs(sumImportes - subtotalNum) > 1) avisos.push(`La suma de importes (${sumImportes}) no coincide con el subtotal (${subtotalNum}).`);
      if (descuentosNum != null && sumDescuentos > 0 && Math.abs(sumDescuentos - descuentosNum) > 1) avisos.push(`La suma de descuentos por item (${sumDescuentos}) no coincide con descuentos (${descuentosNum}).`);
      if (subtotalNum != null && descuentosNum != null && Math.abs(subtotalNum - descuentosNum - totalNum) > 1) avisos.push(`subtotal - descuentos (${round2(subtotalNum - descuentosNum)}) no coincide con total (${totalNum}).`);
      if (avisos.length && !params.forzar) {
        return { ok: false, guardado: false, avisos, texto: 'No guardé nada: los números no cierran. Revisá la lectura o reenviá con forzar:true si el ticket realmente es así.' };
      }
      const result = await importComprobanteFromParsedData({
        is_comprobante: true,
        tipo_comprobante: params.tipo_comprobante || 'ticket',
        confidence: 0.95,
        comercio: params.comercio || null,
        razon_social: params.razon_social || null,
        cuit: params.cuit || null,
        sucursal: params.sucursal || null,
        punto_venta: params.punto_venta || null,
        numero_comprobante: params.numero_comprobante || null,
        fecha: String(fecha),
        total: totalNum,
        subtotal: subtotalNum,
        descuentos: descuentosNum,
        impuestos: params.impuestos != null ? Number(params.impuestos) : null,
        moneda: params.moneda || 'ARS',
        medio_pago: params.medio_pago || null,
        tarjeta: params.tarjeta || null,
        tarjeta_ultimos_4: params.tarjeta_ultimos_4 || null,
        cuotas: params.cuotas != null ? Number(params.cuotas) : null,
        importe_cuota: params.importe_cuota != null ? Number(params.importe_cuota) : null,
        items: items.map((it: any) => ({
          codigo: it.codigo || null,
          descripcion: String(it.descripcion),
          marca: it.marca || null,
          cantidad: it.cantidad != null ? Number(it.cantidad) : 1,
          precio_unitario: it.precio_unitario != null ? Number(it.precio_unitario) : null,
          importe: Number(it.importe),
          descuento: it.descuento != null ? Math.abs(Number(it.descuento)) : null,
          categoria: it.categoria || null,
          subcategoria: it.subcategoria || null,
          raw_json: { ...it, via: 'claude' }
        })),
        texto_extraido: params.texto_extraido || null,
        notas: params.notas || 'Cargado por Claude leyendo la imagen (sin Gemini).'
      }, { fileName: params.filename || null, mimeType: params.mimetype || null });
      await syncPendingImportedMovementsToNotion();
      return {
        ok: true,
        guardado: !result.duplicate,
        duplicate: !!result.duplicate,
        comprobante_id: result.comprobante?.id || null,
        movimiento_id: result.movimiento?.id || null,
        movimiento_vinculado_existente: !!result.movimiento?.__linked,
        items_insertados: result.itemsInserted || 0,
        avisos,
        texto: formatComprobanteImportResult(result)
      };
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

    // Las 3 tools siguientes son para cuando Telegram/Gemini no pudo procesar
    // algo y lo dejó reintentando ("Gemini sin cuota"). En vez de esperar a
    // que se libere la cuota, Cristian le pide a Claude unas veces por día
    // "procesá lo de Telegram" — Claude mira el archivo con su propia visión
    // (sin pasar por Gemini, sin gastar API aparte) y carga el dato posta con
    // las tools que ya existen (import_document / add_manual_expense).
    case 'list_stuck_queue': {
      const { data, error } = await supabase
        .from('procesamiento_cola')
        .select('id, tipo, estado, nombre_archivo, caption, motivo, ultimo_error, intentos, created_at, updated_at')
        .in('estado', ['pendiente', 'reintentar', 'procesando'])
        .order('created_at', { ascending: true })
        .limit(50);
      if (error) throw error;
      // "procesando" solo cuenta como atascado si lleva >10 min sin cambios: la función que lo
      // tomaba murió a mitad (timeout de Vercel) y nunca lo devolvió a la cola.
      const staleBefore = Date.now() - 10 * 60_000;
      const items = (data || []).filter((t: any) => t.estado !== 'procesando' || Date.parse(t.updated_at || t.created_at) < staleBefore);
      return { items };
    }

    case 'get_queue_file': {
      const { queue_id, nombre_archivo } = params;
      if (!queue_id && !nombre_archivo) throw new Error('Falta queue_id o nombre_archivo.');
      // Por nombre_archivo también trae tareas ya completadas (ej: otras fotos del mismo ticket).
      const query = queue_id
        ? supabase.from('procesamiento_cola').select('*').eq('id', queue_id).single()
        : supabase.from('procesamiento_cola').select('*').eq('nombre_archivo', String(nombre_archivo)).order('created_at', { ascending: false }).limit(1).single();
      const { data: task, error } = await query;
      if (error) throw error;
      if (!task.storage_ref) throw new Error('Esta tarea no tiene archivo asociado.');
      const buffer = await downloadStorageRef(task.storage_ref);
      return {
        __image: true,
        data: buffer.toString('base64'),
        mimeType: task.mime_type || 'image/jpeg',
        meta: { id: task.id, tipo: task.tipo, nombre_archivo: task.nombre_archivo, caption: task.caption, ultimo_error: task.ultimo_error }
      };
    }

    case 'price_history': {
      // Historial de precios por producto (nombre, marca o código de barras).
      return priceHistory(String(params.producto || ''), Number(params.limit || 60));
    }

    case 'set_item_codes': {
      // Agrega/corrige códigos de barras de ítems de un comprobante ya cargado.
      const { comprobante_id, codes } = params;
      if (!comprobante_id || !Array.isArray(codes) || !codes.length) throw new Error('Faltan comprobante_id y codes.');
      const r = await setComprobanteItemCodes(String(comprobante_id), codes.map((c: any) => ({ descripcion: String(c.descripcion || ''), codigo: String(c.codigo || '') })));
      return { ok: true, ...r };
    }

    case 'sync_productos_notion': {
      return { ok: true, ...(await syncProductosToNotion(Math.min(Number(params.limit || 15), 25))) };
    }

    case 'resolve_queue_item': {
      const { queue_id, descartado } = params;
      if (!queue_id) throw new Error('Falta queue_id.');
      const { error } = await supabase.from('procesamiento_cola').update({
        estado: 'completado',
        ultimo_error: null,
        resultado: { via: 'claude', descartado: !!descartado },
        procesado_en: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', queue_id);
      if (error) throw error;
      return { ok: true };
    }

    case 'find_movements': {
      return await findMovements({
        query: params.query,
        desde: params.desde,
        hasta: params.hasta,
        monto: params.monto,
        categoria: params.categoria,
        limit: params.limit
      });
    }

    case 'update_movement': {
      const { movimiento_id, categoria, subcategoria, comercio, entidad, guardar_alias, descripcion, monto, fecha, tipo } = params;
      if (!movimiento_id) throw new Error('Falta movimiento_id (obtenerlo con find_movements).');
      return await updateMovement(String(movimiento_id), { categoria, subcategoria, comercio, entidad, guardar_alias: !!guardar_alias, descripcion, monto, fecha, tipo });
    }

    case 'delete_movement': {
      const { movimiento_id, confirmar, devolver_a_pendientes } = params;
      if (!movimiento_id) throw new Error('Falta movimiento_id (obtenerlo con find_movements).');
      return await deleteMovement(String(movimiento_id), { confirmar: confirmar === true, devolver_a_pendientes: devolver_a_pendientes === true });
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
    description: 'Busca en TODO lo que ya está guardado en el sistema (busca en toda la base, no solo lo reciente): notas, pendientes de tareas, movimientos financieros, deudas, presupuestos, memorias, sueldos, comprobantes, ENTIDADES (personas, empresas, equipos, productos) con los items vinculados a cada una, Y TAMBIÉN mails/correos que ya fueron procesados (llegan etiquetados desde Gmail y se guardan acá como notas). Si preguntan algo sobre "mails" o "correos", usar esta tool — no asumir que hace falta un conector de Gmail aparte, los mails ya ingeridos viven en este mismo sistema. Mandar solo 2-4 palabras clave del tema, sin relleno; si la pregunta es muy genérica (ej "mis últimos mails" sin tema), probar igual con alguna palabra razonable antes de decir que no se puede. Los items vienen ordenados por fecha real (la del mail si es un correo, campo fecha), máximo 15; totales.items dice cuántos matchearon en total. Los movimientos financieros vienen ordenados por fecha de consumo (más recientes primero), máximo 50, y totales.movimientos dice cuántos matchearon: para SUMAR o comparar montos usar spending_report, no esta tool. Para una persona, buscar por apellido.',
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
    name: 'spending_report',
    description: 'USAR ESTA TOOL para cualquier "cuánto gasté en X", totales y comparaciones históricas (por mes, entre meses, por comercio o por categoría). Suma TODOS los movimientos del rango, sin tope de cantidad (tarjeta/cuenta consolidados + importados aún no consolidados + tickets no conciliados). Devuelve totales por moneda, por_mes (todos los meses del rango, incluso en 0), por_termino (cada comercio/palabra por separado, por mes), por_categoria, y el detalle. Criterio de fecha: fecha de consumo. Gastos y cargos suman, devoluciones restan; ingresos/transferencias/pagos de tarjeta se excluyen salvo incluir_ingresos=true. NO usar "search" para sumar montos: search devuelve una muestra limitada.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: 'Comercios o palabras a buscar, cada uno se reporta por separado (ej ["cabify","uber"]). Vacío = todos los gastos.' },
        categoria: { type: 'string', description: 'Filtrar por categoría financiera exacta (ej "Transporte", "Comida afuera").' },
        startPeriod: { type: 'string', description: 'YYYY-MM, primer mes incluido' },
        endPeriod: { type: 'string', description: 'YYYY-MM, último mes incluido' },
        incluir_ingresos: { type: 'boolean' },
        max_rows: { type: 'number', description: 'Máximo de filas de detalle a devolver (default 300). Los totales siempre usan todas.' }
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
    name: 'list_stuck_queue',
    description: 'Lista los archivos que Telegram/Gemini NO pudo procesar y quedaron reintentando (típicamente por cuota de Gemini agotada). Usar cuando Cristian pida "procesá lo de Telegram" o similar. Devuelve {items:[{id, tipo, nombre_archivo, caption, ultimo_error, created_at}]}.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_queue_file',
    description: 'Trae el archivo de un ítem atascado en la cola (de list_stuck_queue) para que lo analices vos mismo con tu propia visión, sin pasar por Gemini. Usar el "id" de list_stuck_queue como queue_id.',
    inputSchema: { type: 'object', properties: { queue_id: { type: 'string' }, nombre_archivo: { type: 'string', description: 'Alternativa a queue_id: nombre del archivo (ej photo-3361.jpg), incluye tareas ya completadas' } } }
  },
  {
    name: 'price_history',
    description: 'Historial de precios de un producto comprado (de tickets cargados): precio unitario realmente pagado (con descuento) por fecha y comercio, último, mínimo, máximo y por comercio. Buscar por nombre, marca o código de barras (EAN). Usar para "cómo varió el precio de X", "dónde está más barato X", "cuánto pagué X la última vez".',
    inputSchema: { type: 'object', properties: { producto: { type: 'string' }, limit: { type: 'number' } }, required: ['producto'] }
  },
  {
    name: 'set_item_codes',
    description: 'Agrega o corrige el código de barras (EAN) de productos de un comprobante ya cargado (ej: un ticket cargado sin códigos). codes: [{descripcion, codigo}] — descripcion tal cual está cargada. Revincula el catálogo de productos.',
    inputSchema: { type: 'object', properties: { comprobante_id: { type: 'string' }, codes: { type: 'array', items: { type: 'object', properties: { descripcion: { type: 'string' }, codigo: { type: 'string' } }, required: ['descripcion', 'codigo'] } } }, required: ['comprobante_id', 'codes'] }
  },
  {
    name: 'sync_productos_notion',
    description: 'Sincroniza a Notion (base 🛒 Productos) los productos pendientes. Hasta 25 por llamada; devuelve cuántos quedan pendientes.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
  },
  {
    name: 'resolve_queue_item',
    description: 'Marca un ítem de la cola atascada como resuelto, para que deje de reintentar. Llamar DESPUÉS de haber cargado el dato real con import_comprobante_data (tickets con productos), import_document o add_manual_expense (o con descartado:true si no correspondía cargar nada).',
    inputSchema: { type: 'object', properties: { queue_id: { type: 'string' }, descartado: { type: 'boolean' } }, required: ['queue_id'] }
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
    name: 'import_comprobante_data',
    description: 'Carga un ticket/factura de compra que VOS ya leíste (por ejemplo una foto de get_queue_file), sin pasar por Gemini. Guarda cada producto con cantidad, precio unitario, importe y descuento (sirve para el histórico de precios) y vincula el gasto si ya existía uno compatible (mismo monto, fecha ±días) o lo crea. Usar en vez de add_manual_expense cuando hay un ticket con detalle de productos. Valida que la suma de importes = subtotal y subtotal - descuentos = total; si no cierra, no guarda (salvo forzar:true). No inventar datos: si algo no se lee, omitirlo.',
    inputSchema: {
      type: 'object',
      properties: {
        comercio: { type: 'string', description: 'ej: COTO' },
        razon_social: { type: 'string' },
        cuit: { type: 'string' },
        sucursal: { type: 'string' },
        punto_venta: { type: 'string' },
        numero_comprobante: { type: 'string' },
        tipo_comprobante: { type: 'string', description: 'ticket | factura | recibo | otro' },
        fecha: { type: 'string', description: 'YYYY-MM-DD' },
        total: { type: 'number', description: 'Total pagado (después de descuentos), positivo' },
        subtotal: { type: 'number', description: 'Subtotal sin descuentos' },
        descuentos: { type: 'number', description: 'Total de descuentos, positivo' },
        impuestos: { type: 'number' },
        moneda: { type: 'string', description: 'ARS por defecto' },
        medio_pago: { type: 'string', description: 'ej: Visa crédito' },
        tarjeta: { type: 'string' },
        tarjeta_ultimos_4: { type: 'string' },
        cuotas: { type: 'number' },
        importe_cuota: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              codigo: { type: 'string' },
              descripcion: { type: 'string' },
              marca: { type: 'string' },
              cantidad: { type: 'number' },
              precio_unitario: { type: 'number' },
              importe: { type: 'number', description: 'Importe de la línea antes del descuento (cantidad x precio_unitario)' },
              descuento: { type: 'number', description: 'Descuento aplicado a la línea, positivo' },
              categoria: { type: 'string' },
              subcategoria: { type: 'string' }
            },
            required: ['descripcion', 'importe']
          }
        },
        texto_extraido: { type: 'string' },
        notas: { type: 'string' },
        filename: { type: 'string' },
        mimetype: { type: 'string' },
        forzar: { type: 'boolean', description: 'Guardar aunque los totales no cierren' }
      },
      required: ['fecha', 'total', 'items']
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
    name: 'find_movements',
    description: 'Busca movimientos YA cargados (ya clasificados/impactados, no pendientes) para obtener su movimiento_id antes de corregirlos o borrarlos. Filtros combinables (al menos uno): query (texto del comercio o descripción), monto (magnitud, ±1 peso, sin importar el signo), categoria, desde/hasta (YYYY-MM-DD). Devuelve hasta 50 movimientos, más recientes primero, con id, fecha, tipo, monto, comercio, categoría, origen y si está vinculado a un importado y a Notion. Si hay más de un candidato, mostrárselos al usuario y confirmar cuál antes de modificar.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar en comercio/descripción (ej: "Schill")' },
        monto: { type: 'number', description: 'Monto aproximado (magnitud)' },
        categoria: { type: 'string' },
        desde: { type: 'string', description: 'YYYY-MM-DD' },
        hasta: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'number', description: 'Máximo de resultados (default 20, tope 50)' }
      }
    }
  },
  {
    name: 'update_movement',
    description: 'Corrige un movimiento YA cargado (no sirve para pendientes: eso es classify_group). Usar el movimiento_id de find_movements. Se pasa SOLO lo que cambia: categoria (+ subcategoria; al cambiar la categoría la subcategoría vieja se reemplaza o se limpia), comercio, entidad (nombre canónico de la persona/comercio; NO aprende alias salvo guardar_alias:true), descripcion (reemplaza), monto (magnitud: el signo se conserva), fecha (YYYY-MM-DD), tipo (gasto|ingreso|devolucion|transferencia|ajuste). Guarda en Supabase, refleja el cambio en la fila importada vinculada y sincroniza a Notion. Devuelve antes/después. Verificar con el usuario cuál es el movimiento antes de llamar.',
    inputSchema: {
      type: 'object',
      properties: {
        movimiento_id: { type: 'string', description: 'uuid de find_movements' },
        categoria: { type: 'string' },
        subcategoria: { type: 'string' },
        comercio: { type: 'string' },
        entidad: { type: 'string' },
        guardar_alias: { type: 'boolean', description: 'Solo con entidad: recordar el texto crudo actual como alias de esa entidad' },
        descripcion: { type: 'string' },
        monto: { type: 'number', description: 'Magnitud positiva; el signo (gasto/ingreso) se conserva' },
        fecha: { type: 'string', description: 'YYYY-MM-DD' },
        tipo: { type: 'string' }
      },
      required: ['movimiento_id']
    }
  },
  {
    name: 'delete_movement',
    description: 'Borra un movimiento YA cargado. Es destructivo: la primera llamada SIN confirmar:true no borra nada y devuelve una vista previa de los efectos; mostrarla al usuario y repetir con confirmar:true solo si él confirma. Archiva la página de Notion y desvincula (sin borrar) las filas importadas, comprobantes y recibos de sueldo asociados; las filas importadas quedan ignoradas, o vuelven a pendientes con devolver_a_pendientes:true (útil si el movimiento estaba mal clasificado y se quiere clasificar de nuevo). Se bloquea si el movimiento tiene deudas o particiones de gasto compartido vinculadas.',
    inputSchema: {
      type: 'object',
      properties: {
        movimiento_id: { type: 'string', description: 'uuid de find_movements' },
        confirmar: { type: 'boolean', description: 'true solo después de que el usuario confirmó el borrado' },
        devolver_a_pendientes: { type: 'boolean' }
      },
      required: ['movimiento_id']
    }
  },
  {
    name: 'save_note',
    description: 'Guarda una nota/idea/pendiente de tarea suelta que no es ni finanzas ni una pregunta — algo que el usuario quiere que quede anotado.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }
];
