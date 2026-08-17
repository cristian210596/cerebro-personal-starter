import { runScheduledMaintenance } from '../src/maintenance.js';

export const config = {
  maxDuration: 60
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  try {
    const forceBackup = String(req.query?.forceBackup || '').toLowerCase() === 'true';
    const result = await runScheduledMaintenance({ forceBackup });
    return res.status(200).json(result);
  } catch (error: any) {
    console.error('Cron mantenimiento falló:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'error desconocido' });
  }
}
