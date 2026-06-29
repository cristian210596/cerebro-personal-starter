import type { ItemInsert } from './types.js';
import { classifyText } from './classifier.js';
import { latestItems, latestMemorias, pendingItems, saveItem, searchItems, supabase } from './supabaseClient.js';
import { createNotionItemPage } from './notion.js';
import { config } from './config.js';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
};

const apiBase = `https://api.telegram.org/bot${config.telegramBotToken()}`;

export async function startTelegramPolling() {
  let offset = 0;
  console.log('Bot escuchando Telegram. Cortar con Ctrl+C.');

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (error) {
      console.error('Error en polling:', error);
      await sleep(3000);
    }
  }
}

async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  const url = `${apiBase}/getUpdates?timeout=30&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram getUpdates falló: ${res.status}`);
  const json = await res.json() as { ok: boolean; result: TelegramUpdate[] };
  if (!json.ok) throw new Error('Telegram devolvió ok=false');
  return json.result;
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) {
    await sendMessage(chatId, 'Por ahora este MVP guarda texto. Después agregamos audios, fotos y documentos.');
    return;
  }

  if (text === '/start') {
    await sendMessage(chatId, introText());
    return;
  }

  if (text.startsWith('/buscar')) {
    const q = text.replace('/buscar', '').trim();
    if (!q) return sendMessage(chatId, 'Usá: /buscar hplc lampara d2');
    const results = await searchItems(q, 10);
    return sendMessage(chatId, formatItems(results, `Resultados para: ${q}`));
  }

  if (text.startsWith('/ultimos')) {
    const results = await latestItems(10);
    return sendMessage(chatId, formatItems(results, 'Últimos items'));
  }

  if (text.startsWith('/pendientes')) {
    const results = await pendingItems(10);
    return sendMessage(chatId, formatItems(results, 'Pendientes'));
  }

  if (text.startsWith('/memorias')) {
    const results = await latestMemorias(10);
    return sendMessage(chatId, formatMemorias(results));
  }

  await sendMessage(chatId, 'Procesando...');

  const clasificacion = await classifyText(text);
  const insert: ItemInsert = {
    fuente: 'telegram',
    telegram_user_id: msg.from?.id ? String(msg.from.id) : undefined,
    telegram_chat_id: String(chatId),
    telegram_message_id: String(msg.message_id),
    texto_original: text,
    titulo: clasificacion.titulo,
    resumen: clasificacion.resumen,
    categoria_principal: clasificacion.categoria_principal,
    subcategorias: clasificacion.subcategorias,
    tipo_item: clasificacion.tipo_item,
    estado: clasificacion.estado,
    valoracion: clasificacion.valoracion,
    importancia: clasificacion.importancia,
    accion_futura: clasificacion.accion_futura,
    tags: clasificacion.tags,
    entidades_json: clasificacion.entidades,
    classifier_json: clasificacion
  };

  const item = await saveItem(insert);

  try {
    const notionPageId = await createNotionItemPage(item);
    if (notionPageId) {
      await supabase.from('items').update({ notion_page_id: notionPageId }).eq('id', item.id);
    }
  } catch (error) {
    console.error('No se pudo sincronizar Notion:', error);
  }

  await sendMessage(chatId, formatSaved(clasificacion));
}

export async function sendMessage(chatId: number, text: string) {
  const res = await fetch(`${apiBase}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) })
  });
  if (!res.ok) throw new Error(`Telegram sendMessage falló: ${res.status}`);
}

function introText() {
  return [
    'Cerebro personal activo.',
    '',
    'Mandame cualquier texto y lo guardo clasificado.',
    '',
    'Comandos:',
    '/buscar hplc lampara d2',
    '/ultimos',
    '/pendientes',
    '/memorias'
  ].join('\n');
}

function formatSaved(c: any) {
  const lines = [
    'Guardado.',
    '',
    `Título: ${c.titulo}`,
    `Categoría: ${c.categoria_principal}`,
    `Subcategorías: ${(c.subcategorias || []).join(', ') || '-'}`,
    `Tipo: ${c.tipo_item}`,
    `Estado: ${c.estado || '-'}`,
    `Valoración: ${c.valoracion || '-'}`,
    `Importancia: ${c.importancia || '-'}`,
    `Tags: ${(c.tags || []).join(', ') || '-'}`
  ];

  if (c.accion_futura) lines.push(`Acción futura: ${c.accion_futura}`);
  if (c.memorias_sugeridas?.length) {
    lines.push('', 'Memoria sugerida:');
    for (const m of c.memorias_sugeridas) lines.push(`- ${m.afirmacion}`);
  }
  return lines.join('\n');
}

function formatItems(items: any[], title: string) {
  if (!items.length) return `${title}\n\nSin resultados.`;
  const lines = [title, ''];
  for (const item of items) {
    lines.push(`• ${item.titulo || 'Sin título'}`);
    lines.push(`  ${item.categoria_principal || '-'} / ${item.tipo_item || '-'}`);
    if (item.estado) lines.push(`  Estado: ${item.estado}`);
    if (item.tags?.length) lines.push(`  Tags: ${item.tags.join(', ')}`);
    if (item.resumen) lines.push(`  ${String(item.resumen).slice(0, 220)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatMemorias(memorias: any[]) {
  if (!memorias.length) return 'No hay memorias vigentes.';
  const lines = ['Memorias vigentes', ''];
  for (const memoria of memorias) {
    lines.push(`• ${memoria.afirmacion}`);
    if (memoria.categoria) lines.push(`  Categoría: ${memoria.categoria}`);
    if (memoria.confianza) lines.push(`  Confianza: ${memoria.confianza}`);
    lines.push('');
  }
  return lines.join('\n');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
