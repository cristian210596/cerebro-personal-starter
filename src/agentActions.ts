import {
  getGroupedPendingImportedMovements,
  classifyGroupByIndex,
  ignoreGroupByIndex,
  importFinanceFile,
  formatImportResult
} from './financeImport.js';
import { unifiedSearch } from './chatPro.js';
import { summarizeSalaryFromText, importSalaryReceiptFromFile, formatSalaryImportResult, looksLikeSalaryFile } from './salary.js';
import { buildFinanceDashboardData } from './financeDashboardData.js';
import { importComprobanteFromFile, formatComprobanteImportResult, looksLikeComprobanteFile } from './comprobantes.js';
import { saveFinanceFromText, formatFinanceSaved } from './finance.js';
import { classifyText } from './classifier.js';
import { saveItem } from './supabaseClient.js';

function isPdfOrSpreadsheet(filename: string, mimetype: string) {
  const f = (filename || '').toLowerCase();
  const m = (mimetype || '').toLowerCase();
  return m.includes('pdf') || m.includes('spreadsheet') || m.includes('csv') || /\.(pdf|xlsx?|csv)$/.test(f);
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
      return await classifyGroupByIndex(Number(index), categoryText, !!guardar_regla, entidad || null, detalle || null);
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

      if (isPdfOrSpreadsheet(filename, mt)) {
        const result = await importFinanceFile({ buffer, fileName: filename, mimeType: mt, caption: cap, chatId });
        return { kind: 'resumen_financiero', recognized: result.recognized, texto: formatImportResult(result) || (result as any).reason };
      }

      // Es imagen: probamos en el mismo orden que Telegram (comprobante ->
      // sueldo -> captura de pago), nos quedamos con el primero que reconozca.
      try {
        const comp = await importComprobanteFromFile({ buffer, fileName: filename, mimeType: mt, caption: cap, chatId, archivoId: null, force: looksLikeComprobanteFile(filename, mt, cap) });
        if (comp.recognized) return { kind: 'comprobante', recognized: true, texto: formatComprobanteImportResult(comp) };
      } catch (e) { /* seguimos probando los otros tipos */ }

      try {
        const salary = await importSalaryReceiptFromFile({ buffer, fileName: filename, mimeType: mt, caption: cap, chatId: String(chatId), archivoId: null, force: looksLikeSalaryFile(filename, mt, cap) });
        if (salary.recognized) return { kind: 'recibo_sueldo', recognized: true, texto: formatSalaryImportResult(salary) };
      } catch (e) { /* seguimos probando */ }

      const { importPaymentScreenshotFile } = await import('./financeImport.js');
      const payment = await importPaymentScreenshotFile({ buffer, fileName: filename, mimeType: mt, caption: cap, chatId });
      if (payment.recognized) return { kind: 'captura_pago', recognized: true, texto: formatImportResult(payment) };

      return { kind: null, recognized: false, texto: 'No reconocí este documento como comprobante, recibo de sueldo, resumen financiero ni captura de pago.' };
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
    description: 'Busca en todo lo guardado (notas, pendientes de tareas, movimientos financieros, deudas, presupuestos, memorias, sueldos, comprobantes) por palabra clave. Mandar solo 2-4 palabras clave del tema, sin relleno.',
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
    description: 'Sube un comprobante/ticket, recibo de sueldo, resumen de tarjeta (PDF/CSV/Excel) o captura de pago (Mercado Pago, transferencia). Recibe el archivo en base64 (sin el prefijo data:). Detecta solo el tipo de documento; el resultado puede terminar como pendiente de clasificar (usar list_pending después).',
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
