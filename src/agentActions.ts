import {
  getGroupedPendingImportedMovements,
  classifyGroupByIndex,
  ignoreGroupByIndex
} from './financeImport.js';
import { unifiedSearch } from './chatPro.js';
import { summarizeSalaryFromText } from './salary.js';
import { buildFinanceDashboardData } from './financeDashboardData.js';

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
  }
];
