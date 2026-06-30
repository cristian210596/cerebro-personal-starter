import type { ItemInsert } from './types.js';
import { classifyText } from './classifier.js';
import {
  itemsByEntity,
  latestEntidades,
  latestItemForChat,
  latestItems,
  latestMemorias,
  pendingItems,
  mergeEntidades,
  normalizeEntidadesDatabase,
  rebuildDerivedData,
  saveArchivo,
  saveItem,
  searchEntidades,
  searchItems,
  searchMemorias,
  statsCerebro,
  supabase,
  syncItemDerivedData,
  updateItemFields
} from './supabaseClient.js';
import { createNotionArchivoPage, createNotionItemPage, syncNotionDerivedForItem, updateNotionItemPage } from './notion.js';
import { config } from './config.js';
import { parseEditInstruction } from './editor.js';
import { generateBackupZip } from './backup.js';
import { buildDocumentText, describeImage, transcribeAudio, type TelegramFileInfo } from './media.js';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    caption?: string;
    voice?: { file_id: string; file_unique_id?: string; mime_type?: string; file_size?: number; duration?: number };
    audio?: { file_id: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number; duration?: number };
    document?: { file_id: string; file_unique_id?: string; file_name?: string; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string; file_unique_id?: string; file_size?: number; width?: number; height?: number }>;
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

  if (!text && hasTelegramMedia(msg)) {
    return handleMediaMessage(msg as any);
  }

  if (!text) {
    await sendMessage(chatId, 'No encontré texto ni archivo compatible para guardar.');
    return;
  }

  const command = parseTelegramCommand(text);

  if (command?.name === 'start') {
    await sendMessage(chatId, introText());
    return;
  }

  if (command?.name === 'buscar') {
    const q = command.args;
    if (!q) return sendMessage(chatId, 'Usá: /buscar hplc lampara d2');
    const results = await searchItems(q, 10);
    return sendMessage(chatId, formatItems(results, `Resultados para: ${q}`));
  }

  if (command?.name === 'ultimos') {
    const results = await latestItems(10);
    return sendMessage(chatId, formatItems(results, 'Últimos items'));
  }

  if (command?.name === 'pendientes') {
    const results = await pendingItems(10);
    return sendMessage(chatId, formatItems(results, 'Pendientes'));
  }

  if (command?.name === 'memorias') {
    const q = command.args;
    const results = q ? await searchMemorias(q, 10) : await latestMemorias(10);
    return sendMessage(chatId, formatMemorias(results, q ? `Memorias: ${q}` : 'Memorias vigentes'));
  }

  if (command?.name === 'entidades') {
    const q = command.args;
    const results = q ? await searchEntidades(q, 20) : await latestEntidades(20);
    return sendMessage(chatId, formatEntidades(results, q ? `Entidades: ${q}` : 'Últimas entidades'));
  }

  if (command?.name === 'entidad') {
    const q = command.args;
    if (!q) return sendMessage(chatId, 'Usá: /entidad hplc');
    const results = await itemsByEntity(q, 10);
    return sendMessage(chatId, formatItems(results, `Items vinculados a entidad: ${q}`));
  }

  if (command?.name === 'stats') {
    const stats = await statsCerebro();
    return sendMessage(chatId, formatStats(stats));
  }

  if (command?.name === 'backup') {
    return handleBackupCommand(chatId);
  }

  if (command?.name === 'reconstruir') {
    return handleRebuildCommand(chatId, command.args);
  }

  if (command?.name === 'normalizar') {
    return handleNormalizeCommand(chatId);
  }

  if (command?.name === 'fusionar') {
    return handleMergeEntityCommand(chatId, command.args);
  }

  if (isEditCommand(text)) {
    return handleEditCommand(chatId, text);
  }

  // Regla de seguridad: ningún comando desconocido se guarda como item.
  if (command) {
    return sendMessage(chatId, `Comando no reconocido: /${command.name}. No lo guardé como item.`);
  }

  await sendMessage(chatId, 'Procesando...');

  const result = await saveClassifiedText({
    chatId,
    messageId: msg.message_id,
    userId: msg.from?.id,
    text,
    source: 'telegram'
  });

  if (!result.ok) return sendMessage(chatId, result.message);
  await sendMessage(chatId, formatSaved(result.clasificacion));
}

export async function sendMessage(chatId: number, text: string) {
  const res = await fetch(`${apiBase}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) })
  });
  if (!res.ok) throw new Error(`Telegram sendMessage falló: ${res.status}`);
}

export async function sendDocument(chatId: number, filename: string, buffer: Buffer, caption?: string) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption.slice(0, 1000));
  form.append('document', new Blob([buffer], { type: 'application/zip' }), filename);

  const res = await fetch(`${apiBase}/sendDocument`, {
    method: 'POST',
    body: form
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Telegram sendDocument falló: ${res.status} ${text}`);
  }
}


type SaveClassifiedTextInput = {
  chatId: number;
  messageId: number;
  userId?: number;
  text: string;
  source: string;
  url?: string | null;
};

type SaveClassifiedTextResult =
  | { ok: true; item: any; clasificacion: any }
  | { ok: false; message: string };

async function saveClassifiedText(input: SaveClassifiedTextInput): Promise<SaveClassifiedTextResult> {
  let clasificacion: any;
  try {
    clasificacion = await classifyText(input.text);
  } catch (error: any) {
    console.error('No se pudo clasificar con IA:', error);
    const msg = String(error?.message || '');
    if (msg.includes('429') || String(error?.status || '') === '429') {
      return { ok: false, message: 'No pude guardar porque Gemini se quedó sin cuota temporalmente. Probá más tarde.' };
    }
    return { ok: false, message: 'No pude clasificar este mensaje. Revisá logs de Vercel.' };
  }

  const insert: ItemInsert = {
    fuente: input.source,
    telegram_user_id: input.userId ? String(input.userId) : undefined,
    telegram_chat_id: String(input.chatId),
    telegram_message_id: String(input.messageId),
    texto_original: input.text,
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
    url: input.url || null,
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
    console.error('No se pudo sincronizar Notion:', error);
  }

  return { ok: true, item, clasificacion };
}

function hasTelegramMedia(msg: any) {
  return Boolean(msg.voice || msg.audio || msg.document || (Array.isArray(msg.photo) && msg.photo.length));
}

async function handleMediaMessage(msg: NonNullable<TelegramUpdate['message']>) {
  const chatId = msg.chat.id;
  await sendMessage(chatId, 'Recibido. Procesando archivo...');

  try {
    const media = pickTelegramMedia(msg as any);
    if (!media) return sendMessage(chatId, 'No pude identificar el archivo recibido.');

    if (media.fileSize && media.fileSize > 18 * 1024 * 1024) {
      return sendMessage(chatId, 'El archivo es demasiado grande para procesarlo ahora. Mandalo más chico o guardalo manualmente como link/nota.');
    }

    const downloaded = await downloadTelegramFile(media.fileId);
    let textForItem = '';
    let transcripcion: string | null = null;
    let descripcionIa: string | null = null;
    const caption = String((msg as any).caption || '').trim();

    if (media.kind === 'voice' || media.kind === 'audio') {
      transcripcion = await transcribeAudio(downloaded.buffer, media.mimeType || 'audio/ogg');
      textForItem = [
        'Audio recibido por Telegram.',
        caption ? `Comentario del usuario: ${caption}` : '',
        transcripcion ? `Transcripción: ${transcripcion}` : 'Transcripción no disponible.'
      ].filter(Boolean).join('\n');
    } else if (media.kind === 'photo') {
      descripcionIa = await describeImage(downloaded.buffer, media.mimeType || 'image/jpeg', caption);
      textForItem = [
        'Foto recibida por Telegram.',
        caption ? `Comentario del usuario: ${caption}` : '',
        descripcionIa ? `Descripción de imagen: ${descripcionIa}` : 'Descripción no disponible.'
      ].filter(Boolean).join('\n');
    } else {
      textForItem = buildDocumentText(media, caption);
    }

    const result = await saveClassifiedText({
      chatId,
      messageId: msg.message_id,
      userId: msg.from?.id,
      text: textForItem,
      source: `telegram_${media.kind}`,
      url: `telegram://${media.fileId}`
    });

    if (!result.ok) return sendMessage(chatId, result.message);

    const archivo = await saveArchivo({
      item_id: result.item.id,
      tipo_archivo: media.kind,
      nombre_archivo: media.fileName || `${media.kind}-${msg.message_id}`,
      mime_type: media.mimeType || downloaded.mimeType || null,
      storage_url: `telegram://${media.fileId}`,
      transcripcion,
      descripcion_ia: descripcionIa
    });

    try {
      await createNotionArchivoPage(archivo);
    } catch (error) {
      console.error('No se pudo sincronizar archivo a Notion:', error);
    }

    return sendMessage(chatId, [
      media.kind === 'voice' || media.kind === 'audio' ? 'Audio guardado.' : media.kind === 'photo' ? 'Foto guardada.' : 'Documento guardado.',
      '',
      `Título: ${result.clasificacion.titulo}`,
      `Categoría: ${result.clasificacion.categoria_principal}`,
      `Tipo: ${result.clasificacion.tipo_item}`,
      `Tags: ${(result.clasificacion.tags || []).join(', ') || '-'}`,
      transcripcion ? `\nTranscripción: ${transcripcion.slice(0, 900)}` : ''
    ].filter(Boolean).join('\n'));
  } catch (error: any) {
    console.error('No se pudo procesar archivo Telegram:', error);
    const msgText = String(error?.message || '');
    if (msgText.includes('429') || String(error?.status || '') === '429') {
      return sendMessage(chatId, 'No pude procesar el archivo porque Gemini quedó sin cuota temporalmente. Probá más tarde.');
    }
    return sendMessage(chatId, `No pude procesar el archivo: ${error?.message || 'error desconocido'}`);
  }
}

function pickTelegramMedia(msg: any): TelegramFileInfo | null {
  if (msg.voice) {
    return {
      kind: 'voice',
      fileId: msg.voice.file_id,
      fileUniqueId: msg.voice.file_unique_id,
      mimeType: msg.voice.mime_type || 'audio/ogg',
      fileSize: msg.voice.file_size,
      fileName: `voice-${msg.message_id}.ogg`
    };
  }

  if (msg.audio) {
    return {
      kind: 'audio',
      fileId: msg.audio.file_id,
      fileUniqueId: msg.audio.file_unique_id,
      mimeType: msg.audio.mime_type || 'audio/mpeg',
      fileSize: msg.audio.file_size,
      fileName: msg.audio.file_name || `audio-${msg.message_id}`
    };
  }

  if (Array.isArray(msg.photo) && msg.photo.length) {
    const photo = [...msg.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0];
    return {
      kind: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      mimeType: 'image/jpeg',
      fileSize: photo.file_size,
      fileName: `photo-${msg.message_id}.jpg`
    };
  }

  if (msg.document) {
    return {
      kind: 'document',
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      mimeType: msg.document.mime_type || 'application/octet-stream',
      fileSize: msg.document.file_size,
      fileName: msg.document.file_name || `document-${msg.message_id}`
    };
  }

  return null;
}

async function downloadTelegramFile(fileId: string) {
  const fileRes = await fetch(`${apiBase}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!fileRes.ok) throw new Error(`Telegram getFile falló: ${fileRes.status}`);
  const fileJson = await fileRes.json() as { ok: boolean; result?: { file_path?: string } };
  if (!fileJson.ok || !fileJson.result?.file_path) throw new Error('Telegram no devolvió file_path');

  const downloadUrl = `https://api.telegram.org/file/bot${config.telegramBotToken()}/${fileJson.result.file_path}`;
  const dataRes = await fetch(downloadUrl);
  if (!dataRes.ok) throw new Error(`Telegram download falló: ${dataRes.status}`);
  const arrayBuffer = await dataRes.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: dataRes.headers.get('content-type') || undefined
  };
}

async function handleBackupCommand(chatId: number) {
  await sendMessage(chatId, 'Generando backup...');

  try {
    const backup = await generateBackupZip();
    await sendDocument(chatId, backup.filename, backup.buffer, [
      'Backup generado.',
      '',
      `Items: ${backup.counts.items || 0}`,
      `Entidades: ${backup.counts.entidades || 0}`,
      `Memorias: ${backup.counts.memorias || 0}`,
      `Archivos: ${backup.counts.archivos || 0}`,
      '',
      'Guardá este ZIP fuera de Telegram si querés doble resguardo.'
    ].join('\n'));
  } catch (error: any) {
    console.error('No se pudo generar backup:', error);
    return sendMessage(chatId, `No pude generar backup: ${error?.message || 'error desconocido'}`);
  }
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
    '/memorias',
    '/entidades',
    '/entidad hplc',
    '/stats',
    '/backup',
    '/reconstruir 5',
    '/normalizar',
    '/fusionar Café Colombia => Café Martínez Colombia'
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
    `Tags: ${(c.tags || []).join(', ') || '-'}`,
    `Entidades: ${(c.entidades || []).map((e: any) => `${e.tipo}: ${e.nombre}`).join(', ') || '-'}`
  ];

  if (c.accion_futura) lines.push(`Acción futura: ${c.accion_futura}`);
  if (c.memorias_sugeridas?.length) {
    lines.push('', 'Memorias sugeridas:');
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

function formatMemorias(memorias: any[], title = 'Memorias vigentes') {
  if (!memorias.length) return `${title}\n\nSin memorias.`;
  const lines = [title, ''];
  for (const memoria of memorias) {
    lines.push(`• ${memoria.afirmacion}`);
    if (memoria.categoria) lines.push(`  Categoría: ${memoria.categoria}`);
    if (memoria.confianza) lines.push(`  Confianza: ${memoria.confianza}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatEntidades(entidades: any[], title: string) {
  if (!entidades.length) return `${title}\n\nSin entidades.`;
  const lines = [title, ''];
  for (const entidad of entidades) {
    lines.push(`• ${entidad.nombre}`);
    lines.push(`  Tipo: ${entidad.tipo || '-'}`);
    if (entidad.categoria_relacionada) lines.push(`  Categoría: ${entidad.categoria_relacionada}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatStats(stats: any) {
  return [
    'Estado del cerebro',
    '',
    `Items: ${stats.itemsCount}`,
    `Entidades: ${stats.entidadesCount}`,
    `Memorias vigentes: ${stats.memoriasCount}`
  ].join('\n');
}

async function handleRebuildCommand(chatId: number, args: string) {
  const n = Number(args.trim() || 5);
  const limit = Math.max(1, Math.min(n || 5, 5));

  await sendMessage(chatId, `Reconstruyendo últimos ${limit} items. Límite máximo: 5 para evitar reintentos de Telegram/Vercel.`);

  const result = await rebuildDerivedData(limit);

  return sendMessage(chatId, [
    'Reconstrucción terminada.',
    '',
    `Items procesados: ${result.processedItems}`,
    `Menciones de entidades detectadas: ${result.entityMentions}`,
    `Memorias sugeridas detectadas: ${result.memoryMentions}`,
    '',
    'Probá ahora: /entidades y /memorias',
    'Para limpiar duplicados: /normalizar'
  ].join('\n'));
}

async function handleNormalizeCommand(chatId: number) {
  await sendMessage(chatId, 'Normalizando entidades duplicadas exactas...');

  try {
    const result = await normalizeEntidadesDatabase(500);
    return sendMessage(chatId, [
      'Normalización terminada.',
      '',
      `Entidades revisadas: ${result.scanned}`,
      `Grupos fusionados: ${result.groupsMerged}`,
      `Filas duplicadas eliminadas: ${result.rowsMerged}`,
      `Alias preservados/agregados: ${result.aliasesAdded}`,
      '',
      'Nota: esto fusiona duplicados claros por normalización exacta. Para casos dudosos usá /fusionar origen => destino.'
    ].join('\n'));
  } catch (error: any) {
    console.error('No se pudo normalizar entidades:', error);
    return sendMessage(chatId, `No pude normalizar entidades: ${error?.message || 'error desconocido'}`);
  }
}

async function handleMergeEntityCommand(chatId: number, args: string) {
  const raw = args.trim();
  const match = raw.match(/^(.+?)\s*(?:=>|->|→)\s*(.+)$/);

  if (!match) {
    return sendMessage(chatId, 'Usá: /fusionar Café Colombia => Café Martínez Colombia');
  }

  const source = match[1].trim();
  const target = match[2].trim();

  if (!source || !target) {
    return sendMessage(chatId, 'Usá: /fusionar entidad vieja => entidad correcta');
  }

  await sendMessage(chatId, `Fusionando "${source}" dentro de "${target}"...`);

  try {
    const result = await mergeEntidades(source, target);
    if (!result.merged) return sendMessage(chatId, 'No fusioné nada: ambas búsquedas apuntan a la misma entidad.');

    return sendMessage(chatId, [
      'Fusión terminada.',
      '',
      `Origen eliminado: ${result.source.nombre}`,
      `Destino conservado: ${result.target.nombre}`,
      `Vínculos movidos: ${result.movedLinks}`,
      `Alias del destino: ${(result.target.alias || []).join(', ') || '-'}`,
      '',
      'Desde ahora, si aparece el origen como alias, se reutiliza la entidad destino.'
    ].join('\n'));
  } catch (error: any) {
    console.error('No se pudo fusionar entidad:', error);
    return sendMessage(chatId, `No pude fusionar: ${error?.message || 'error desconocido'}`);
  }
}

function parseTelegramCommand(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/([^\s@]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: removeAccents(match[1]).toLowerCase(),
    args: (match[2] || '').trim()
  };
}

function removeAccents(value: string) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isEditCommand(text: string) {
  const lower = text.toLowerCase();
  return lower.startsWith('/editar') || lower.startsWith('/corregir') || lower.startsWith('corregir último') || lower.startsWith('corregir ultimo');
}

async function handleEditCommand(chatId: number, text: string) {
  const instruction = text
    .replace(/^\/editar\s*/i, '')
    .replace(/^\/corregir\s*/i, '')
    .replace(/^corregir último\s*:?\s*/i, '')
    .replace(/^corregir ultimo\s*:?\s*/i, '')
    .trim();

  if (!instruction) {
    return sendMessage(chatId, 'Usá: corregir último: estado Pendiente, subcategoría Calibraciones');
  }

  const current = await latestItemForChat(String(chatId));
  if (!current) return sendMessage(chatId, 'No encontré un item anterior para editar.');

  await sendMessage(chatId, 'Editando último item...');

  let edit;
  try {
    edit = await parseEditInstruction(instruction, current);
  } catch (error) {
    console.error('No se pudo interpretar edición:', error);
    return sendMessage(chatId, 'No pude interpretar la corrección. Probá con formato simple: valoracion Volvería, estado Pendiente, tags hplc,shimadzu');
  }

  const changes = edit.changes || {};
  if (!Object.keys(changes).length) {
    return sendMessage(chatId, `No apliqué cambios. ${edit.explanation || ''}`.trim());
  }

  const mergedClassifier = {
    ...(current.classifier_json || {}),
    ...mapChangesToClassifier(changes)
  };

  const updated = await updateItemFields(current.id, {
    ...changes,
    classifier_json: mergedClassifier
  });

  try {
    await syncItemDerivedData(updated);
    if (updated.notion_page_id) {
      await updateNotionItemPage(updated);
    } else {
      const notionPageId = await createNotionItemPage(updated);
      if (notionPageId) {
        await supabase.from('items').update({ notion_page_id: notionPageId }).eq('id', updated.id);
      }
    }
    await syncNotionDerivedForItem(updated);
  } catch (error) {
    console.error('No se pudo actualizar Notion/derivados:', error);
  }

  return sendMessage(chatId, formatEdited(updated, Object.keys(changes), edit.explanation));
}

function mapChangesToClassifier(changes: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'entidades_json') out.entidades = value;
    else out[key] = value;
  }
  return out;
}

function formatEdited(item: any, changedKeys: string[], explanation: string) {
  const labels: Record<string, string> = {
    titulo: 'Título',
    resumen: 'Resumen',
    categoria_principal: 'Categoría',
    subcategorias: 'Subcategorías',
    tipo_item: 'Tipo',
    estado: 'Estado',
    valoracion: 'Valoración',
    importancia: 'Importancia',
    accion_futura: 'Acción futura',
    tags: 'Tags',
    entidades_json: 'Entidades'
  };

  const lines = [
    'Editado.',
    '',
    `Item: ${item.titulo || 'Sin título'}`,
    `Cambios: ${changedKeys.map(k => labels[k] || k).join(', ')}`
  ];
  if (explanation) lines.push(`Criterio: ${explanation}`);
  lines.push('', `Categoría: ${item.categoria_principal || '-'}`);
  lines.push(`Subcategorías: ${(item.subcategorias || []).join(', ') || '-'}`);
  lines.push(`Estado: ${item.estado || '-'}`);
  lines.push(`Tags: ${(item.tags || []).join(', ') || '-'}`);
  return lines.join('\n');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
