import { runCalibracionReminders, runScheduledMaintenance } from '../src/maintenance.js';

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

    // Fase 4: recordatorios de vencimiento de calibración. Va en un
    // try/catch propio para que un error acá (ej Supabase caído un
    // instante) no tumbe el resultado del backup/keep-alive, que es lo más
    // crítico de este cron.
    let calibReminders: any = null;
    try {
      calibReminders = await runCalibracionReminders();
    } catch (calibError: any) {
      console.error('Cron recordatorios de calibración falló:', calibError);
      calibReminders = { ok: false, error: calibError?.message || 'error desconocido' };
    }

    return res.status(200).json({ ...result, calibReminders });
  } catch (error: any) {
    console.error('Cron mantenimiento falló:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'error desconocido' });
  }
}
