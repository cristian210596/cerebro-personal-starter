import { classifyText } from './classifier.js';
import { saveItem, supabase } from './supabaseClient.js';
import { createNotionItemPage, syncNotionDerivedForItem } from './notion.js';
import { sendMessage } from './telegram.js';
import { getAppConfigValue } from './supabaseClient.js';
import type { ItemInsert } from './types.js';

// Fase 5: ingesta de mails de Gmail etiquetados "_Cristian" en la casilla
// corporativa compartida, vía Google Apps Script (ver gmail-apps-script/
// en la raíz del repo). El Apps Script corre del lado de Google con las
// credenciales personales de Cristian sobre esa casilla, y le pega a este
// endpoint (api/gmailIngest.ts) con el contenido del mail.
//
// El mail entra al mismo pipeline genérico que cualquier nota de Telegram
// (classifyText -> saveItem -> Notion), para que sea buscable/consultable
// igual que el resto, y además dispara un aviso por Telegram para que
// Cristian se entere en el momento sin tener que revisar la casilla.
//
// Reutilizamos la columna telegram_message_id (texto libre, no depende del
// nombre) para guardar el Gmail message id y poder deduplicar si Apps
// Script reintenta el mismo mail — evita agregar una columna nueva para
// un solo string identificador.

export type GmailIngestInput = {
  gmailMessageId: string;
  from: string;
  subject: string;
  dateIso: string | null;
  bodyText: string;
  permalink: string | null;
};

export type GmailIngestResult =
  | { ok: true; alreadyProcessed: true }
  | { ok: true; alreadyProcessed: false; itemId: string }
  | { ok: false; error: string };

function buildTextoOriginal(input: GmailIngestInput): string {
  const partes = [
    `De: ${input.from}`,
    `Asunto: ${input.subject}`,
    input.dateIso ? `Fecha: ${input.dateIso}` : '',
    '',
    input.bodyText
  ];
  return partes.filter(Boolean).join('\n');
}

export async function ingestGmailMessage(input: GmailIngestInput): Promise<GmailIngestResult> {
  const gmailMessageId = String(input.gmailMessageId || '').trim();
  if (!gmailMessageId) {
    return { ok: false, error: 'falta gmailMessageId' };
  }

  const { data: existing, error: existingError } = await supabase
    .from('items')
    .select('id')
    .eq('fuente', 'gmail')
    .eq('telegram_message_id', gmailMessageId)
    .maybeSingle();
  if (existingError) {
    return { ok: false, error: `error verificando duplicado: ${existingError.message}` };
  }
  if (existing) {
    return { ok: true, alreadyProcessed: true };
  }

  // Truncamos el cuerpo para no guardar mails gigantes (firmas, threads
  // largos citados, etc.) ni pasarle un prompt enorme al clasificador.
  const bodyTruncado = String(input.bodyText || '').slice(0, 6000);
  const textoOriginal = buildTextoOriginal({ ...input, bodyText: bodyTruncado });

  let clasificacion: any;
  try {
    clasificacion = await classifyText(textoOriginal);
  } catch (error: any) {
    console.error('No se pudo clasificar mail de Gmail con IA:', error);
    return { ok: false, error: `fallo el clasificador: ${error?.message || error}` };
  }

  const insert: ItemInsert = {
    fuente: 'gmail',
    telegram_message_id: gmailMessageId,
    texto_original: textoOriginal,
    titulo: clasificacion.titulo || input.subject,
    resumen: clasificacion.resumen,
    categoria_principal: clasificacion.categoria_principal,
    subcategorias: clasificacion.subcategorias,
    tipo_item: clasificacion.tipo_item,
    estado: clasificacion.estado,
    valoracion: clasificacion.valoracion,
    importancia: clasificacion.importancia,
    accion_futura: clasificacion.accion_futura,
    tags: [...(clasificacion.tags || []), 'gmail'],
    entidades_json: clasificacion.entidades,
    url: input.permalink || undefined,
    classifier_json: clasificacion
  };

  const item = await saveItem(insert);

  try {
    const notionPageId = await createNotionItemPage(item);
    if (notionPageId) {
      await supabase.from('items').update({ notion_page_id: notionPageId }).eq('id', item.id);
      item.notion_page_id = notionPageId;
    }
    await syncNotionDerivedForItem(item);
  } catch (error) {
    console.error('No se pudo sincronizar a Notion el mail de Gmail:', error);
  }

  try {
    const chatIdRaw = await getAppConfigValue('telegram_last_chat_id');
    if (chatIdRaw) {
      const resumenCorto = (clasificacion.resumen || input.subject || '').slice(0, 500);
      await sendMessage(Number(chatIdRaw), [
        `Mail nuevo etiquetado _Cristian:`,
        `De: ${input.from}`,
        `Asunto: ${input.subject}`,
        '',
        resumenCorto,
        input.permalink ? `\n${input.permalink}` : ''
      ].filter(Boolean).join('\n'));
    }
  } catch (error) {
    console.error('No se pudo avisar por Telegram el mail de Gmail:', error);
  }

  return { ok: true, alreadyProcessed: false, itemId: item.id };
}
