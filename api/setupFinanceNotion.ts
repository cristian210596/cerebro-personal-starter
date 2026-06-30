import { setupFinanceNotionDatabases } from '../src/notion.js';

export const config = {
  maxDuration: 60
};

export default async function handler(req: any, res: any) {
  try {
    const force = String(req?.query?.force || '').toLowerCase() === 'true';
    const result = await setupFinanceNotionDatabases({ force });
    return res.status(200).json({
      ok: true,
      message: force ? 'Bases financieras de Notion recreadas/listas.' : 'Bases financieras de Notion listas.',
      databases: result
    });
  } catch (error: any) {
    console.error('Error creando bases financieras de Notion:', error);
    return res.status(500).json({
      ok: false,
      error: error?.message || 'error desconocido'
    });
  }
}
