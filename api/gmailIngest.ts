import { ingestGmailMessage } from '../src/gmailIntake.js';

export const config = {
  maxDuration: 30
};

// Endpoint que llama el Google Apps Script corriendo en la casilla Gmail
// compartida (ver gmail-apps-script/Code.gs). Autenticado con un secreto
// compartido simple (no OAuth) porque el llamador es un script controlado
// por Cristian, no un tercero — mismo criterio que TELEGRAM_WEBHOOK_SECRET.
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, message: 'Gmail ingest endpoint activo.' });
  }

  const expectedSecret = process.env.GMAIL_INGEST_SECRET?.trim();
  if (!expectedSecret) {
    return res.status(500).json({ ok: false, error: 'Falta configurar GMAIL_INGEST_SECRET en el servidor.' });
  }
  const receivedSecret = req.headers['x-gmail-ingest-secret'];
  if (receivedSecret !== expectedSecret) {
    return res.status(401).json({ ok: false, error: 'secret inválido' });
  }

  try {
    const body = req.body || {};
    const result = await ingestGmailMessage({
      gmailMessageId: String(body.gmailMessageId || ''),
      from: String(body.from || ''),
      subject: String(body.subject || ''),
      dateIso: body.dateIso || null,
      bodyText: String(body.bodyText || ''),
      permalink: body.permalink || null
    });

    if (!result.ok) {
      return res.status(500).json(result);
    }
    return res.status(200).json(result);
  } catch (error: any) {
    console.error('Error procesando ingesta de Gmail:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'error desconocido' });
  }
}
