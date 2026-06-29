import { config as appConfig } from '../src/config.js';

export const config = {
  maxDuration: 30
};

function getBaseUrl(req: any) {
  if (process.env.PUBLIC_WEBHOOK_URL?.trim()) return process.env.PUBLIC_WEBHOOK_URL.trim().replace(/\/$/, '');
  if (process.env.VERCEL_URL?.trim()) return `https://${process.env.VERCEL_URL.trim()}`;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

export default async function handler(req: any, res: any) {
  try {
    const token = appConfig.telegramBotToken();
    const webhookUrl = `${getBaseUrl(req)}/api/telegram`;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

    const body: any = {
      url: webhookUrl,
      allowed_updates: ['message']
    };
    if (secret) body.secret_token = secret;

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const json = await tgRes.json();
    return res.status(tgRes.ok ? 200 : 500).json({ webhookUrl, telegram: json });
  } catch (error: any) {
    console.error('Error seteando webhook:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'error desconocido' });
  }
}
