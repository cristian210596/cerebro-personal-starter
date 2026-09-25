import { config as appConfig } from '../src/config.js';
import {
  getGroupedPendingImportedMovements,
  classifyGroupByIndex,
  ignoreGroupByIndex
} from '../src/financeImport.js';
import { unifiedSearch } from '../src/chatPro.js';
import { summarizeSalaryFromText } from '../src/salary.js';
import { buildFinanceDashboardData } from '../src/financeDashboardData.js';

export const config = {
  maxDuration: 20
};

// Endpoint que llama el artifact publicado (el "panel conversacional" con
// Claude) para leer y modificar datos reales. Mismo criterio de secreto
// compartido que los otros endpoints, pero éste ADEMÁS escribe (clasifica/
// ignora pendientes), así que usa su propio secreto en vez de reusar el del
// dashboard de solo lectura.
export default async function handler(req: any, res: any) {
  // El artifact publicado corre en otro dominio (claude.ai/claude.site), así
  // que el navegador manda un preflight OPTIONS antes del POST real. Sin
  // estos headers, el POST se ejecuta en el servidor pero el navegador
  // descarta la respuesta igual.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-agent-action-secret');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, message: 'Agent action endpoint activo.' });
    return;
  }

  const expectedSecret = appConfig.agentActionSecret();
  if (!expectedSecret) {
    res.status(500).json({ ok: false, error: 'Falta configurar AGENT_ACTION_SECRET en el servidor.' });
    return;
  }
  const receivedSecret = req.headers['x-agent-action-secret'];
  if (receivedSecret !== expectedSecret) {
    res.status(401).json({ ok: false, error: 'secret inválido' });
    return;
  }

  const { action, params } = req.body || {};
  try {
    const result = await runAction(String(action || ''), params || {});
    res.status(200).json({ ok: true, result });
  } catch (error: any) {
    console.error(`Error ejecutando acción de agente "${action}":`, error);
    res.status(500).json({ ok: false, error: error?.message || 'error desconocido' });
  }
}

async function runAction(action: string, params: any) {
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
      return result;
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
