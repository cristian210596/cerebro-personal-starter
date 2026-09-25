import { config as appConfig } from '../src/config.js';
import { importBankNotificationText, formatImportResult } from '../src/financeImport.js';
import { getAppConfigValue } from '../src/supabaseClient.js';
import { sendMessage } from '../src/telegram.js';

export const config = {
  maxDuration: 20
};

// Endpoint que llama un Atajo de iOS (Automatización -> Notificación -> app
// del banco/billetera -> "Obtener contenido de URL" en POST hacia acá).
// Autenticado con un secreto compartido simple, mismo criterio que
// GMAIL_INGEST_SECRET / TELEGRAM_WEBHOOK_SECRET.
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, message: 'Notification ingest endpoint activo.' });
    return;
  }

  const expectedSecret = appConfig.notificationIngestSecret();
  if (!expectedSecret) {
    res.status(500).json({ ok: false, error: 'Falta configurar NOTIFICATION_INGEST_SECRET en el servidor.' });
    return;
  }
  const receivedSecret = req.headers['x-notification-ingest-secret'];
  if (receivedSecret !== expectedSecret) {
    res.status(401).json({ ok: false, error: 'secret inválido' });
    return;
  }

  try {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const message = String(body.body || body.message || '').trim();
    const app = body.app ? String(body.app) : null;
    const text = [title, message].filter(Boolean).join('\n');
    if (!text) {
      res.status(400).json({ ok: false, error: 'falta title/body de la notificación' });
      return;
    }

    const chatIdRaw = await getAppConfigValue('telegram_last_chat_id');
    const chatId = chatIdRaw ? Number(chatIdRaw) : null;

    const result = await importBankNotificationText({ text, app, chatId: chatId || 0 });

    if (chatId && result.recognized) {
      const formatted = formatImportResult(result as any);
      if (formatted) await sendMessage(chatId, formatted);
    }

    res.status(200).json({ ok: true, recognized: result.recognized, duplicate: (result as any).duplicate || false });
  } catch (error: any) {
    console.error('Error procesando notificación de pago:', error);
    res.status(500).json({ ok: false, error: error?.message || 'error desconocido' });
  }
}
