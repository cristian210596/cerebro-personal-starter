import { config as appConfig } from '../src/config.js';
import { runAgentAction, AGENT_TOOLS } from '../src/agentActions.js';

export const config = {
  maxDuration: 30
};

// Servidor MCP mínimo (Streamable HTTP, revisión 2026-07-28: sin sesiones,
// negociación por request) para agregar como "Add custom connector" en
// claude.ai (Settings -> Connectors). Protegido con un secreto simple en la
// URL (?key=...) en vez de OAuth completo, para no montar un authorization
// server solo para uso personal.
export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const expectedSecret = appConfig.agentActionSecret();
  if (!expectedSecret) {
    res.status(500).json({ ok: false, error: 'Falta configurar AGENT_ACTION_SECRET en el servidor.' });
    return;
  }
  const providedSecret = String(req.query?.key || '');
  if (providedSecret !== expectedSecret) {
    res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'secreto inválido (falta ?key=... correcto en la URL del conector)' } });
    return;
  }

  if (req.method === 'GET') {
    // No implementamos el stream GET de notificaciones server->client (no lo
    // necesitamos: no hay nada que empujar de forma no solicitada). Un 405
    // simple es una respuesta válida para un cliente que lo intente.
    res.status(405).json({ ok: false, error: 'GET no soportado; este servidor solo responde por POST.' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const body = req.body || {};
  const { jsonrpc, id, method, params } = body;

  // Notificación (sin "id"): el cliente no espera respuesta con contenido.
  const isNotification = id === undefined || id === null;

  try {
    let result: any;

    if (method === 'initialize') {
      result = {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cerebro-personal', version: '1.0.0' }
      };
    } else if (method === 'notifications/initialized') {
      res.status(202).end();
      return;
    } else if (method === 'tools/list') {
      result = { tools: AGENT_TOOLS };
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const actionResult = await runAgentAction(toolName, toolArgs);
        result = { content: [{ type: 'text', text: JSON.stringify(actionResult) }] };
      } catch (toolError: any) {
        result = { content: [{ type: 'text', text: `Error: ${toolError?.message || toolError}` }], isError: true };
      }
    } else if (method === 'ping') {
      result = {};
    } else {
      if (isNotification) { res.status(202).end(); return; }
      res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Método no soportado: ${method}` } });
      return;
    }

    if (isNotification) { res.status(202).end(); return; }
    res.status(200).json({ jsonrpc: jsonrpc || '2.0', id, result });
  } catch (error: any) {
    console.error('Error en servidor MCP:', error);
    if (isNotification) { res.status(202).end(); return; }
    res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32000, message: error?.message || 'error desconocido' } });
  }
}
