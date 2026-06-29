import { handleTelegramUpdate } from '../src/telegram.js';

export const config = {
  maxDuration: 60
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Cerebro Personal webhook activo.' });
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expectedSecret) {
    const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (receivedSecret !== expectedSecret) {
      return res.status(401).json({ ok: false, error: 'secret inválido' });
    }
  }

  try {
    await handleTelegramUpdate(req.body);
    return res.status(200).json({ ok: true });
  } catch (error: any) {
    console.error('Error procesando webhook Telegram:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'error desconocido' });
  }
}
