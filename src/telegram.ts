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
  smartSearchItems,
  indexSearchEmbeddings,
  searchMemorias,
  statsCerebro,
  supabase,
  syncItemDerivedData,
  updateItemFields
} from './supabaseClient.js';
import { createNotionArchivoPage, createNotionItemPage, syncNotionDerivedForItem, syncNotionFinanceResult, updateNotionItemPage } from './notion.js';
import { config } from './config.js';
import { parseEditInstruction } from './editor.js';
import { generateBackupZip } from './backup.js';
import { buildDocumentText, describeImage, transcribeAudio, type TelegramFileInfo } from './media.js';
import { createSignedFileUrl, uploadTelegramFileToStorage } from './storage.js';
import { formatFinanceSaved, formatFinanceSummary, getFinanceSummary, looksLikeFinanceText, saveFinanceFromText } from './finance.js';
import { correctLastFinanceMovement, deleteLastFinanceMovement, deleteLastItem, formatBudgetSaved, formatBudgets, formatCardSummary, formatDebts, formatFinanceCorrection, formatMovements, getCardSummary, listBudgets, listFinanceDebts, listFinanceMovements, looksLikeBudgetText, looksLikeFinanceProText, markDebtPaidFromText, payCardFromText, saveBudgetFromText, saveCardStatementFromText } from './financePro.js';
import { deleteLastPending, formatPendingDone, formatPendingSaved, formatPendientes, listPendientes, looksLikePendingText, markPendingDone, savePendingFromText } from './pending.js';
import { formatMaintenanceRunResult, formatMaintenanceStatus, getMaintenanceStatus, rememberTelegramChat, runScheduledMaintenance } from './maintenance.js';
import { applyUniversalCorrection, buildPeriodSummary, cleanupDuplicates, formatDuplicateCleanup, formatLastSaved, formatPeriodSummary, formatUnifiedSearch, getLastSavedSnapshot, looksLikeLastSavedQuestion, looksLikeUniversalCorrection, unifiedSearch } from './chatPro.js';
import { buildDiagnostics, formatDiagnostics, formatOperationalLogs, formatSystemAutotest, getOperationalLogs, runSystemAutotest } from './diagnostics.js';
import { buildOperationalReview, formatOperationalReview, looksLikeReviewRequest } from './reviewPro.js';
import { formatClarifyCorrection, formatNaturalDeletePrompt, naturalDeleteArgs, routeConversationalText } from './conversationRouter.js';

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
  await rememberTelegramChat(chatId);
  const text = msg.text?.trim();

  if (!text && hasTelegramMedia(msg)) {
    return handleMediaMessage(msg as any);
  }

  if (!text) {
    await sendMessage(chatId, 'No encontré texto ni archivo compatible para guardar.');
    return;
  }

  const command = parseTelegramCommand(text);

  if (command?.name === 'start' || command?.name === 'ayuda') {
    await sendMessage(chatId, introText());
    return;
  }

  if (command?.name === 'estado') {
    return handleEstadoCommand(chatId);
  }

  if (command?.name === 'diagnostico' || command?.name === 'diagnóstico') {
    return handleDiagnosticoCommand(chatId);
  }

  if (command?.name === 'test' && removeAccents(command.args || '').toLowerCase().includes('sistema')) {
    return handleTestSistemaCommand(chatId);
  }

  if (command?.name === 'logs') {
    return handleLogsCommand(chatId);
  }

  if (command?.name === 'revision' || command?.name === 'revisión') {
    return handleRevisionCommand(chatId, command.args);
  }

  if (command?.name === 'supervivencia') {
    return handleSupervivenciaCommand(chatId);
  }

  if (command?.name === 'archivos') {
    return handleArchivosCommand(chatId, command.args);
  }

  if (command?.name === 'archivo') {
    return handleArchivoCommand(chatId, command.args);
  }

  if (command?.name === 'buscar') {
    const q = command.args;
    if (!q) return sendMessage(chatId, 'Usá: /buscar hplc lampara d2');
    return handleUnifiedSearchCommand(chatId, q);
  }

  if (command?.name === 'resumen') {
    return handleResumenCommand(chatId, command.args);
  }

  if (command?.name === 'ultimo' || command?.name === 'último') {
    return handleUltimoCommand(chatId);
  }

  if (command?.name === 'limpiar') {
    return handleLimpiarCommand(chatId, command.args);
  }

  if (command?.name === 'indexar') {
    return handleIndexCommand(chatId, command.args);
  }

  if (command?.name === 'ultimos') {
    const results = await latestItems(10);
    return sendMessage(chatId, formatItems(results, 'Últimos items'));
  }

  if (command?.name === 'pendientes') {
    return handlePendientesCommand(chatId, command.args);
  }

  if (command?.name === 'hecho') {
    return handleHechoCommand(chatId, command.args);
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

  if (command?.name === 'finanzas') {
    return handleFinanceSummaryCommand(chatId);
  }

  if (command?.name === 'gastos') {
    return handleGastosCommand(chatId, command.args);
  }

  if (command?.name === 'deudas') {
    return handleDeudasCommand(chatId, command.args);
  }

  if (command?.name === 'tarjetas') {
    return handleTarjetasCommand(chatId);
  }

  if (command?.name === 'presupuestos') {
    return handlePresupuestosCommand(chatId);
  }

  if (command?.name === 'presupuesto') {
    return handlePresupuestoCommand(chatId, command.args);
  }

  if (command?.name === 'pagar') {
    return handlePagarCommand(chatId, command.args);
  }

  if (command?.name === 'borrar') {
    return handleBorrarCommand(chatId, command.args);
  }

  if (command?.name === 'backup') {
    const args = removeAccents(command.args || '').toLowerCase();
    if (args.includes('estado')) return handleBackupEstadoCommand(chatId);
    if (args.includes('auto') || args.includes('probar') || args.includes('prueba')) return handleBackupAutoTestCommand(chatId);
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

  const conversationalRoute = routeConversationalText(text);
  if (conversationalRoute) {
    switch (conversationalRoute.kind) {
      case 'help':
        return sendMessage(chatId, introText());
      case 'status':
        return handleEstadoCommand(chatId);
      case 'diagnostics':
        return handleDiagnosticoCommand(chatId);
      case 'backup_status':
        return handleBackupEstadoCommand(chatId);
      case 'last':
        return handleUltimoCommand(chatId);
      case 'pending_list':
        return handlePendientesCommand(chatId, conversationalRoute.query);
      case 'done':
        return handleHechoCommand(chatId, conversationalRoute.query);
      case 'search':
        return handleUnifiedSearchCommand(chatId, conversationalRoute.query);
      case 'summary':
        return handleResumenCommand(chatId, conversationalRoute.period);
      case 'review':
        return handleRevisionCommand(chatId, conversationalRoute.period);
      case 'delete':
        if (!conversationalRoute.confirm) return sendMessage(chatId, formatNaturalDeletePrompt(conversationalRoute));
        return handleBorrarCommand(chatId, naturalDeleteArgs(conversationalRoute));
      case 'do_not_save':
        return sendMessage(chatId, 'No lo guardé como item. Si querés borrar el último registro, mandá: /borrar ultimo confirmar');
      case 'clarify_correction':
        return sendMessage(chatId, formatClarifyCorrection());
    }
  }

  if (looksLikeLastSavedQuestion(text)) {
    return handleUltimoCommand(chatId);
  }

  if (looksLikeReviewRequest(text)) {
    return handleRevisionCommand(chatId, text.replace(/^revisi[oó]n\s*/i, ''));
  }

  if (looksLikeBudgetText(text)) {
    return handlePresupuestoCommand(chatId, text.replace(/^\/presupuesto\s*/i, '').replace(/^presupuesto\s*/i, ''));
  }

  if (looksLikeFinanceProText(text)) {
    const handled = await handleFinanceProNaturalText(chatId, text);
    if (handled) return;
  }

  if (isEditCommand(text) || looksLikeUniversalCorrection(text)) {
    const universal = await applyUniversalCorrection(text, String(chatId));
    if (universal.handled) return sendMessage(chatId, universal.message);
    return handleEditCommand(chatId, text);
  }

  // Regla de seguridad: ningún comando desconocido se guarda como item.
  if (command) {
    return sendMessage(chatId, `Comando no reconocido: /${command.name}. No lo guardé como item.`);
  }

  if (looksLikePendingText(text)) {
    return handlePendingNaturalText(chatId, msg.message_id, msg.from?.id, text);
  }

  if (looksLikeFinanceText(text)) {
    const financeHandled = await handleFinanceNaturalText(chatId, msg.message_id, msg.from?.id, text);
    if (financeHandled) return;
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
  form.append('document', new Blob([new Uint8Array(buffer)], { type: 'application/zip' }), filename);

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
    const stored = await uploadTelegramFileToStorage({
      buffer: downloaded.buffer,
      fileName: media.fileName || `${media.kind}-${msg.message_id}`,
      mimeType: media.mimeType || downloaded.mimeType || 'application/octet-stream',
      kind: media.kind,
      chatId,
      messageId: msg.message_id
    });

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
      url: stored.signedUrl || null
    });

    if (!result.ok) return sendMessage(chatId, result.message);

    const archivo = await saveArchivo({
      item_id: result.item.id,
      tipo_archivo: media.kind,
      nombre_archivo: media.fileName || `${media.kind}-${msg.message_id}`,
      mime_type: media.mimeType || downloaded.mimeType || null,
      storage_url: stored.storageRef,
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
      stored.signedUrl ? `Archivo: ${stored.signedUrl}` : '',
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

async function handleBackupEstadoCommand(chatId: number) {
  try {
    const status = await getMaintenanceStatus();
    return sendMessage(chatId, formatMaintenanceStatus(status));
  } catch (error: any) {
    console.error('No pude obtener estado de backup automático:', error);
    return sendMessage(chatId, `No pude obtener estado: ${error?.message || 'error desconocido'}`);
  }
}

async function handleBackupAutoTestCommand(chatId: number) {
  await sendMessage(chatId, 'Ejecutando mantenimiento y backup automático de prueba...');
  try {
    const result = await runScheduledMaintenance({ forceBackup: true, manualChatId: chatId });
    return sendMessage(chatId, formatMaintenanceRunResult(result));
  } catch (error: any) {
    console.error('No pude probar backup automático:', error);
    return sendMessage(chatId, `No pude probar backup automático: ${error?.message || 'error desconocido'}`);
  }
}

async function handleSupervivenciaCommand(chatId: number) {
  try {
    const status = await getMaintenanceStatus();
    return sendMessage(chatId, formatMaintenanceStatus(status));
  } catch (error: any) {
    console.error('No pude obtener supervivencia:', error);
    return sendMessage(chatId, `No pude obtener supervivencia: ${error?.message || 'error desconocido'}`);
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
    '/resumen semana',
    '/resumen mes',
    '/ultimo',
    '/limpiar duplicados',
    '/archivos dni',
    '/archivo ultimo',
    '/ultimos',
    '/pendientes',
    '/hecho comprar detergente',
    '/memorias',
    '/entidades',
    '/entidad hplc',
    '/estado',
    '/diagnostico',
    '/test sistema',
    '/logs',
    '/revision hoy',
    '/revision semana',
    '/stats',
    '/finanzas',
    '/gastos visa',
    '/deudas',
    '/tarjetas',
    '/presupuesto supermercado 250000 mensual',
    '/presupuestos',
    '/pagar Juan 5000',
    '/borrar gasto ultimo confirmar',
    '/borrar archivo ultimo confirmar',
    '/backup',
    '/backup estado',
    '/backup auto probar',
    '/supervivencia',
    '/normalizar'
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




async function handleDiagnosticoCommand(chatId: number) {
  await sendMessage(chatId, 'Ejecutando diagnóstico...');
  try {
    const result = await buildDiagnostics();
    return sendMessage(chatId, formatDiagnostics(result));
  } catch (error: any) {
    console.error('No pude ejecutar diagnóstico:', error);
    return sendMessage(chatId, `No pude ejecutar diagnóstico: ${error?.message || 'error desconocido'}`);
  }
}

async function handleTestSistemaCommand(chatId: number) {
  await sendMessage(chatId, 'Ejecutando autotest. Creo registros temporales y después los borro...');
  try {
    const result = await runSystemAutotest(chatId);
    return sendMessage(chatId, formatSystemAutotest(result));
  } catch (error: any) {
    console.error('No pude ejecutar autotest:', error);
    return sendMessage(chatId, `No pude ejecutar autotest: ${error?.message || 'error desconocido'}`);
  }
}

async function handleLogsCommand(chatId: number) {
  try {
    const logs = await getOperationalLogs();
    return sendMessage(chatId, formatOperationalLogs(logs));
  } catch (error: any) {
    console.error('No pude obtener logs operativos:', error);
    return sendMessage(chatId, `No pude obtener logs: ${error?.message || 'error desconocido'}`);
  }
}

async function handleRevisionCommand(chatId: number, args: string) {
  await sendMessage(chatId, 'Armando revisión operativa...');
  try {
    const review = await buildOperationalReview(args || 'hoy');
    return sendMessage(chatId, formatOperationalReview(review));
  } catch (error: any) {
    console.error('No pude armar revisión:', error);
    return sendMessage(chatId, `No pude armar revisión: ${error?.message || 'error desconocido'}`);
  }
}

async function handleUnifiedSearchCommand(chatId: number, query: string) {
  await sendMessage(chatId, 'Buscando en todo el cerebro...');
  try {
    const result = await unifiedSearch(query);
    return sendMessage(chatId, formatUnifiedSearch(result));
  } catch (error: any) {
    console.error('No pude hacer búsqueda unificada:', error);
    return sendMessage(chatId, `No pude buscar: ${error?.message || 'error desconocido'}`);
  }
}

async function handleResumenCommand(chatId: number, args: string) {
  await sendMessage(chatId, 'Armando resumen...');
  try {
    const summary = await buildPeriodSummary(args || 'semana');
    return sendMessage(chatId, formatPeriodSummary(summary));
  } catch (error: any) {
    console.error('No pude armar resumen:', error);
    return sendMessage(chatId, `No pude armar resumen: ${error?.message || 'error desconocido'}`);
  }
}

async function handleUltimoCommand(chatId: number) {
  try {
    const snapshot = await getLastSavedSnapshot(String(chatId));
    return sendMessage(chatId, formatLastSaved(snapshot));
  } catch (error: any) {
    console.error('No pude consultar último guardado:', error);
    return sendMessage(chatId, `No pude consultar último guardado: ${error?.message || 'error desconocido'}`);
  }
}

async function handleLimpiarCommand(chatId: number, args: string) {
  const a = removeAccents(args || '').toLowerCase();
  if (!a.includes('duplicados')) return sendMessage(chatId, 'Usá: /limpiar duplicados o /limpiar duplicados confirmar');
  try {
    const result = await cleanupDuplicates(a.includes('confirmar'));
    return sendMessage(chatId, formatDuplicateCleanup(result));
  } catch (error: any) {
    console.error('No pude limpiar duplicados:', error);
    return sendMessage(chatId, `No pude limpiar duplicados: ${error?.message || 'error desconocido'}`);
  }
}

async function handleSmartSearchCommand(chatId: number, query: string) {
  await sendMessage(chatId, 'Buscando...');

  try {
    const result = await smartSearchItems(query, 8);
    const header = [
      `Resultados para: ${query}`,
      result.semanticUsed ? 'Modo: exacto + semántico' : 'Modo: exacto',
      result.indexedNow ? `Indexados ahora: ${result.indexedNow}` : '',
      result.semanticError ? 'Aviso: la parte semántica no respondió; usé búsqueda exacta.' : ''
    ].filter(Boolean).join('\n');

    return sendMessage(chatId, await formatSmartItemsWithFiles(result.results, header));
  } catch (error: any) {
    console.error('No se pudo buscar:', error);
    return sendMessage(chatId, `No pude buscar: ${error?.message || 'error desconocido'}`);
  }
}

async function handleIndexCommand(chatId: number, args: string) {
  const n = Number(args.trim() || 10);
  const limit = Math.max(1, Math.min(n || 10, 20));
  await sendMessage(chatId, `Indexando últimos ${limit} items para búsqueda semántica...`);

  try {
    const result = await indexSearchEmbeddings(limit);
    return sendMessage(chatId, [
      'Indexación terminada.',
      '',
      `Revisados: ${result.checked}`,
      `Indexados: ${result.indexed}`,
      `Ya estaban indexados: ${result.skipped}`,
      `Fallidos: ${result.failed}`,
      '',
      'Ahora usá /buscar normalmente.'
    ].join('\n'));
  } catch (error: any) {
    console.error('No se pudo indexar:', error);
    return sendMessage(chatId, `No pude indexar: ${error?.message || 'error desconocido'}`);
  }
}

function formatSmartItems(results: any[], title: string) {
  if (!results.length) return `${title}\n\nSin resultados.`;
  const lines = [title, ''];
  let i = 1;
  for (const result of results) {
    const item = result.item || result;
    lines.push(`${i}. ${item.titulo || 'Sin título'}`);
    lines.push(`   ${item.categoria_principal || '-'} / ${item.tipo_item || '-'}`);
    if (item.estado) lines.push(`   Estado: ${item.estado}`);
    if (item.valoracion) lines.push(`   Valoración: ${item.valoracion}`);
    if (item.tags?.length) lines.push(`   Tags: ${item.tags.slice(0, 8).join(', ')}`);
    if (result.mode) lines.push(`   Match: ${result.mode} (${Math.round((result.score || 0) * 100)}%) - ${result.reason || '-'}`);
    if (item.resumen) lines.push(`   ${String(item.resumen).slice(0, 260)}`);
    lines.push('');
    i += 1;
  }
  return lines.join('\n');
}


async function formatSmartItemsWithFiles(results: any[], title: string) {
  if (!results.length) return `${title}\n\nSin resultados.`;

  const itemIds = results.map((r: any) => (r.item || r).id).filter(Boolean);
  const archivosByItem = await loadArchivosByItem(itemIds);

  const lines = [title, ''];
  let i = 1;
  for (const result of results) {
    const item = result.item || result;
    lines.push(`${i}. ${item.titulo || 'Sin título'}`);
    lines.push(`   ${item.categoria_principal || '-'} / ${item.tipo_item || '-'}`);
    if (item.estado) lines.push(`   Estado: ${item.estado}`);
    if (item.valoracion) lines.push(`   Valoración: ${item.valoracion}`);
    if (item.tags?.length) lines.push(`   Tags: ${item.tags.slice(0, 8).join(', ')}`);
    if (result.mode) lines.push(`   Match: ${result.mode} (${Math.round((result.score || 0) * 100)}%) - ${result.reason || '-'}`);
    if (item.resumen) lines.push(`   ${String(item.resumen).slice(0, 220)}`);

    const archivos = archivosByItem.get(item.id) || [];
    for (const archivo of archivos.slice(0, 2)) {
      const url = await createSignedFileUrl(archivo.storage_url, 60 * 60 * 24 * 7);
      lines.push(`   Archivo: ${archivo.nombre_archivo || 'archivo'}`);
      if (url) lines.push(`   Link: ${url}`);
    }

    lines.push('');
    i += 1;
  }
  return lines.join('\n');
}

async function loadArchivosByItem(itemIds: string[]) {
  const map = new Map<string, any[]>();
  if (!itemIds.length) return map;

  const { data, error } = await supabase
    .from('archivos')
    .select('*')
    .in('item_id', itemIds)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('No pude cargar archivos para búsqueda:', error);
    return map;
  }

  for (const archivo of data || []) {
    if (!archivo.item_id) continue;
    if (!map.has(archivo.item_id)) map.set(archivo.item_id, []);
    map.get(archivo.item_id)!.push(archivo);
  }

  return map;
}



async function handleEstadoCommand(chatId: number) {
  try {
    const tables = ['items', 'entidades', 'memorias', 'archivos', 'finanzas_movimientos', 'finanzas_deudas', 'finanzas_particiones', 'finanzas_cierres', 'finanzas_presupuestos', 'pendientes'];
    const lines = ['Estado del cerebro', ''];
    for (const table of tables) {
      try {
        const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
        if (error) throw error;
        lines.push(`${table}: ${count ?? 0}`);
      } catch {
        lines.push(`${table}: no disponible`);
      }
    }
    lines.push('', 'Servicios:');
    lines.push(`Telegram: activo`);
    lines.push(`Supabase: activo`);
    lines.push(`Notion: ${config.notionToken() ? 'configurado' : 'sin token'}`);
    lines.push(`Gemini: ${config.geminiApiKey() ? 'configurado' : 'sin key'}`);
    lines.push('', 'Comandos útiles: /backup, /buscar, /archivos, /finanzas, /gastos, /deudas, /tarjetas');
    return sendMessage(chatId, lines.join('\n'));
  } catch (error: any) {
    console.error('No pude generar estado:', error);
    return sendMessage(chatId, `No pude generar estado: ${error?.message || 'error desconocido'}`);
  }
}

async function handleArchivosCommand(chatId: number, args: string) {
  try {
    const q = removeAccents(String(args || '').toLowerCase()).trim();
    const { data, error } = await supabase
      .from('archivos')
      .select('*, items(titulo,categoria_principal,resumen,tags)')
      .order('created_at', { ascending: false })
      .limit(40);
    if (error) throw error;

    let rows = data || [];
    if (q) {
      rows = rows.filter((a: any) => {
        const haystack = removeAccents([
          a.nombre_archivo,
          a.tipo_archivo,
          a.mime_type,
          a.transcripcion,
          a.descripcion_ia,
          a.items?.titulo,
          a.items?.categoria_principal,
          a.items?.resumen,
          ...(a.items?.tags || [])
        ].filter(Boolean).join(' ').toLowerCase());
        return q.split(/\s+/).every(part => haystack.includes(part));
      });
    }

    if (!rows.length) return sendMessage(chatId, q ? `Archivos: ${args}\n\nSin resultados.` : 'Archivos\n\nSin archivos registrados.');

    const lines = [q ? `Archivos: ${args}` : 'Últimos archivos', ''];
    let n = 1;
    for (const a of rows.slice(0, 8)) {
      const url = await createSignedFileUrl(a.storage_url, 60 * 60 * 24 * 7);
      lines.push(`${n}. ${a.nombre_archivo || 'Archivo'}`);
      lines.push(`   Tipo: ${a.tipo_archivo || '-'}${a.items?.titulo ? ` — ${a.items.titulo}` : ''}`);
      if (a.descripcion_ia) lines.push(`   ${String(a.descripcion_ia).slice(0, 180)}`);
      if (a.transcripcion) lines.push(`   Transcripción: ${String(a.transcripcion).slice(0, 180)}`);
      if (url) lines.push(`   Link: ${url}`);
      lines.push('');
      n += 1;
    }
    return sendMessage(chatId, lines.join('\n'));
  } catch (error: any) {
    console.error('No pude listar archivos:', error);
    return sendMessage(chatId, `No pude listar archivos: ${error?.message || 'error desconocido'}`);
  }
}

async function handleArchivoCommand(chatId: number, args: string) {
  try {
    const q = String(args || '').trim();
    if (!q || removeAccents(q.toLowerCase()).includes('ultimo')) {
      const { data, error } = await supabase.from('archivos').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      if (!data) return sendMessage(chatId, 'No encontré archivos.');
      const url = await createSignedFileUrl(data.storage_url, 60 * 60 * 24 * 7);
      return sendMessage(chatId, [`Archivo último`, '', `Nombre: ${data.nombre_archivo || '-'}`, `Tipo: ${data.tipo_archivo || '-'}`, url ? `Link: ${url}` : 'Sin link disponible'].join('\n'));
    }
    return handleArchivosCommand(chatId, q);
  } catch (error: any) {
    console.error('No pude obtener archivo:', error);
    return sendMessage(chatId, `No pude obtener archivo: ${error?.message || 'error desconocido'}`);
  }
}

async function deleteLastArchivo(confirm: boolean) {
  if (!confirm) return { ok: false as const, message: 'Para borrar el último archivo usá: /borrar archivo ultimo confirmar' };
  const { data: row, error } = await supabase.from('archivos').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!row) return { ok: false as const, message: 'No encontré archivos para borrar.' };

  await supabase.from('archivos').delete().eq('id', row.id);
  if (row.item_id) await supabase.from('items').delete().eq('id', row.item_id);

  return { ok: true as const, message: `Archivo borrado: ${row.nombre_archivo || row.id}` };
}


async function handlePendientesCommand(chatId: number, args: string) {
  try {
    const rows = await listPendientes(args, 20);
    return sendMessage(chatId, formatPendientes(rows, args ? `Pendientes: ${args}` : 'Pendientes abiertos'));
  } catch (error: any) {
    console.error('No pude listar pendientes:', error);
    return sendMessage(chatId, `No pude listar pendientes: ${error?.message || 'error desconocido'}`);
  }
}

async function handleHechoCommand(chatId: number, args: string) {
  try {
    const result = await markPendingDone(args);
    return sendMessage(chatId, formatPendingDone(result));
  } catch (error: any) {
    console.error('No pude cerrar pendiente:', error);
    return sendMessage(chatId, `No pude cerrar pendiente: ${error?.message || 'error desconocido'}`);
  }
}

async function handlePendingNaturalText(chatId: number, messageId: number, userId: number | undefined, text: string) {
  try {
    const result = await savePendingFromText({ chatId, messageId, userId, text });
    try {
      const notionPageId = await createNotionItemPage(result.item);
      if (notionPageId) {
        await supabase.from('items').update({ notion_page_id: notionPageId }).eq('id', result.item.id);
        result.item.notion_page_id = notionPageId;
      }
      await syncNotionDerivedForItem(result.item);
    } catch (error) {
      console.error('No se pudo sincronizar Notion para pendiente:', error);
    }
    return sendMessage(chatId, formatPendingSaved(result));
  } catch (error: any) {
    console.error('No pude guardar pendiente:', error);
    return sendMessage(chatId, `No pude guardar pendiente: ${error?.message || 'error desconocido'}`);
  }
}

async function handlePresupuestoCommand(chatId: number, args: string) {
  try {
    const result = await saveBudgetFromText(args);
    return sendMessage(chatId, formatBudgetSaved(result));
  } catch (error: any) {
    console.error('No pude guardar presupuesto:', error);
    return sendMessage(chatId, `No pude guardar presupuesto: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/interacciones_finanzas_plus.sql.`);
  }
}

async function handlePresupuestosCommand(chatId: number) {
  try {
    const rows = await listBudgets();
    return sendMessage(chatId, formatBudgets(rows));
  } catch (error: any) {
    console.error('No pude listar presupuestos:', error);
    return sendMessage(chatId, `No pude listar presupuestos: ${error?.message || 'error desconocido'}.`);
  }
}

async function handleGastosCommand(chatId: number, args: string) {
  try {
    const rows = await listFinanceMovements(args, 12);
    return sendMessage(chatId, formatMovements(rows, args ? `Gastos / movimientos: ${args}` : 'Últimos gastos / movimientos'));
  } catch (error: any) {
    console.error('No pude listar gastos:', error);
    return sendMessage(chatId, `No pude listar gastos: ${error?.message || 'error desconocido'}`);
  }
}

async function handleDeudasCommand(chatId: number, args: string) {
  try {
    const rows = await listFinanceDebts(args, 15);
    return sendMessage(chatId, formatDebts(rows, args ? `Deudas: ${args}` : 'Deudas abiertas'));
  } catch (error: any) {
    console.error('No pude listar deudas:', error);
    return sendMessage(chatId, `No pude listar deudas: ${error?.message || 'error desconocido'}`);
  }
}

async function handleTarjetasCommand(chatId: number) {
  try {
    const rows = await getCardSummary();
    return sendMessage(chatId, formatCardSummary(rows));
  } catch (error: any) {
    console.error('No pude listar tarjetas:', error);
    return sendMessage(chatId, 'No pude listar tarjetas. Si acabás de instalar el parche, ejecutá supabase/finance_pro.sql.');
  }
}

async function handlePagarCommand(chatId: number, args: string) {
  if (!args) return sendMessage(chatId, 'Usá: /pagar Juan 5000 o /pagar deuda de Juan confirmar');
  try {
    const result = await markDebtPaidFromText(args);
    if (!result.ok) return sendMessage(chatId, result.message);
    return sendMessage(chatId, [
      'Pago/deuda actualizado.',
      '',
      `${result.deuda.persona}: ${result.deuda.estado}`,
      `Saldo pendiente: $${Number(result.deuda.saldo_pendiente || 0).toLocaleString('es-AR')}`
    ].join('\n'));
  } catch (error: any) {
    console.error('No pude aplicar pago:', error);
    return sendMessage(chatId, `No pude aplicar el pago: ${error?.message || 'error desconocido'}`);
  }
}

async function handleBorrarCommand(chatId: number, args: string) {
  const a = removeAccents(args || '').toLowerCase();
  try {
    if (a.includes('gasto')) {
      const result = await deleteLastFinanceMovement(a.includes('confirmar'));
      return sendMessage(chatId, result.message);
    }
    if (a.includes('archivo')) {
      const result = await deleteLastArchivo(a.includes('confirmar'));
      return sendMessage(chatId, result.message);
    }
    if (a.includes('pendiente')) {
      const result = await deleteLastPending(a.includes('confirmar'));
      return sendMessage(chatId, result.message);
    }
    if (a.includes('ultimo') || a.includes('último')) {
      const result = await deleteLastItem(a.includes('confirmar'));
      return sendMessage(chatId, result.message);
    }
    return sendMessage(chatId, 'Usá: /borrar gasto ultimo confirmar, /borrar archivo ultimo confirmar, /borrar pendiente ultimo confirmar o /borrar ultimo confirmar');
  } catch (error: any) {
    console.error('No pude borrar:', error);
    return sendMessage(chatId, `No pude borrar: ${error?.message || 'error desconocido'}`);
  }
}

async function handleFinanceProNaturalText(chatId: number, text: string) {
  const clean = removeAccents(text).toLowerCase();
  try {
    if (clean.startsWith('corregir ultimo gasto') || clean.startsWith('corregir último gasto') || clean.startsWith('corregir gasto')) {
      const result = await correctLastFinanceMovement(text);
      return sendMessage(chatId, formatFinanceCorrection(result));
    }
    if (clean.startsWith('marcar deuda') || clean.startsWith('saldar deuda')) {
      const result = await markDebtPaidFromText(text);
      if (!result.ok) return sendMessage(chatId, result.message);
      return sendMessage(chatId, `Deuda actualizada. ${result.deuda.persona}: ${result.deuda.estado}. Saldo: $${Number(result.deuda.saldo_pendiente || 0).toLocaleString('es-AR')}`);
    }
    if (clean.startsWith('cierre visa') || clean.startsWith('cierre master')) {
      const result = await saveCardStatementFromText(text);
      if (!result.ok) return sendMessage(chatId, result.message);
      return sendMessage(chatId, `Cierre guardado. ${result.cierre.tarjeta} ${result.cierre.periodo}: $${Number(result.cierre.monto_total || 0).toLocaleString('es-AR')}${result.cierre.fecha_vencimiento ? ` vence ${result.cierre.fecha_vencimiento}` : ''}`);
    }
    if (clean.startsWith('pague visa') || clean.startsWith('pagué visa') || clean.startsWith('pague master') || clean.startsWith('pagué master')) {
      const result = await payCardFromText(text);
      if (!result.ok) return sendMessage(chatId, result.message);
      return sendMessage(chatId, `Pago de tarjeta registrado. ${result.cierre.tarjeta}: saldo pendiente $${Number(result.cierre.saldo_pendiente || 0).toLocaleString('es-AR')}`);
    }
    return false;
  } catch (error: any) {
    console.error('No pude procesar finanzas pro:', error);
    await sendMessage(chatId, `No pude procesar esta acción financiera: ${error?.message || 'error desconocido'}`);
    return true;
  }
}

async function handleFinanceSummaryCommand(chatId: number) {
  try {
    const summary = await getFinanceSummary();
    return sendMessage(chatId, formatFinanceSummary(summary));
  } catch (error: any) {
    console.error('No pude generar resumen financiero:', error);
    return sendMessage(chatId, 'No pude generar el resumen financiero. Si acabás de instalar el parche, primero ejecutá el SQL de finanzas en Supabase.');
  }
}

async function handleFinanceNaturalText(chatId: number, messageId: number, userId: number | undefined, text: string) {
  await sendMessage(chatId, 'Procesando finanzas...');

  try {
    const result = await saveFinanceFromText({ chatId, messageId, userId, text });
    if (!result.ok) return false;

    try {
      const notionPageId = await createNotionItemPage(result.item);
      if (notionPageId) {
        await supabase.from('items').update({ notion_page_id: notionPageId }).eq('id', result.item.id);
        result.item.notion_page_id = notionPageId;
      }
      await syncNotionDerivedForItem(result.item);
      await syncNotionFinanceResult(result);
    } catch (error) {
      console.error('No se pudo sincronizar Notion para finanzas:', error);
    }

    await sendMessage(chatId, formatFinanceSaved(result));
    return true;
  } catch (error: any) {
    console.error('No pude procesar finanzas:', error);
    const msg = String(error?.message || '');
    if (msg.includes('429') || String(error?.status || '') === '429') {
      await sendMessage(chatId, 'No pude procesar finanzas porque Gemini se quedó sin cuota temporalmente. Probá más tarde.');
      return true;
    }
    if (msg.includes('finanzas_movimientos') || msg.includes('finanzas_deudas') || msg.includes('finanzas_particiones')) {
      await sendMessage(chatId, 'Todavía no están creadas las tablas de finanzas. Ejecutá primero el SQL del parche en Supabase.');
      return true;
    }
    await sendMessage(chatId, 'No pude procesar este movimiento financiero. Lo guardo como nota normal.');
    return false;
  }
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
