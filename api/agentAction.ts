import { config as appConfig } from '../src/config.js';
import { runAgentAction } from '../src/agentActions.js';

export const config = {
  maxDuration: 20
};

// Endpoint REST simple (no MCP) sobre las mismas acciones — se mantiene por si
// sirve para algo que llame por HTTP plano en vez de protocolo MCP. El camino
// recomendado para usar esto desde Claude es el conector MCP: api/mcp.ts.
export default async function handler(req: any, res: any) {
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
    const result = await runAgentAction(String(action || ''), params || {});
    res.status(200).json({ ok: true, result });
  } catch (error: any) {
    console.error(`Error ejecutando acción de agente "${action}":`, error);
    res.status(500).json({ ok: false, error: error?.message || 'error desconocido' });
  }
}
