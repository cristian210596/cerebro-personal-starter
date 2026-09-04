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
import { createNotionArchivoPage, createNotionItemPage, getNotionClient, syncNotionDerivedForItem, syncNotionFinanceResult, syncNotionImportedMovements, updateNotionItemPage } from './notion.js';
import { config } from './config.js';
import { getGeminiPoolStatus, testGeminiPoolOnce } from './geminiPool.js';
import { getCerebrasPoolStatus, testCerebrasPoolOnce, getCerebrasConfiguredKeyCount } from './cerebrasPool.js';
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
import { classifyImportedMovementByIndex, classifyImportedMovementFromAnswer, correctLastFinanceMovementFromText, findPendingIndicesMatchingSuggestion, formatClassifyImportedResult, formatFinanceAnalyticsReport, formatIgnoreImportedResult, formatImportResult, formatImports, formatPendingImported, formatProcessImportResult, getPendingImportedMovements, getUnsyncedImportedMovements, ignoreImportedMovementByIndex, importFinanceFile, importPaymentScreenshotFile, latestFinanceImport, listFinanceImports, looksLikeFinanceAnalyticsText, looksLikeFinanceFile, looksLikeImportCommand, processFinanceImportation, summarizeFinanceAnalytics } from './financeImport.js';
import { formatComprobanteDetail, formatComprobanteImportResult, formatComprobanteItems, formatComprobantes, formatProductRuleResult, formatProductSpendingReport, formatProducts, getComprobanteItems, getLastComprobante, importComprobanteFromFile, listComprobantes, listProducts, looksLikeComprobanteFile, looksLikeProductQueryText, saveProductRuleFromText, summarizeProductSpending } from './comprobantes.js';
import { confirmLastSalaryReceipt, correctLastSalaryReceiptFromText, createManualSalaryReceiptFromText, formatSalaryConcepts, formatSalaryImportResult, formatSalaryList, formatSalaryReceipt, formatSalarySummary, getLastSalaryReceipt, getSalaryConcepts, importSalaryReceiptFromFile, listSalaryReceipts, looksLikeSalaryFile, looksLikeSalaryQueryText, summarizeSalaryFromText } from './salary.js';
import { enqueueProcessingTask, cleanupQueueCompleted, formatQueue, formatQueueProcessResults, listQueue, processQueue, retryLastQueued } from './processingQueue.js';
import { addAliasFromText, formatAliasAdded, formatAliases, formatMasterEntities, listAliases, listMasterEntities, seedDefaultEntityBrain } from './entityBrain.js';
import { buildInbox, confirmConciliationByIndex, formatConciliationCandidates, formatConciliationDone, formatInbox, formatSources, getFinancialSourcesForLastMovement, listConciliationCandidates, rejectConciliationByIndex } from './conciliation.js';
import { formatVersionInfo } from './version.js';

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

// Si procesar un update tarda (PDF pesado, Gemini lento) y Vercel no responde a
// tiempo, Telegram reintenta el webhook con el MISMO update_id. Sin esto, cada
// reintento reprocesaba todo desde cero: "Recibido/Procesando" duplicados y, en
// el peor caso, importaciones duplicadas. Se descarta en silencio cualquier
// update_id ya visto (insert con PK; el segundo insert choca y ahí se detecta).
async function wasUpdateAlreadyProcessed(updateId: number): Promise<boolean> {
  if (!updateId) return false;
  try {
    const { error } = await supabase.from('telegram_updates_procesados').insert({ update_id: updateId });
    if (!error) return false;
    if ((error as any).code === '23505') return true; // unique_violation: ya procesado
    console.error('No pude registrar update_id de Telegram (sigo procesando igual):', error);
    return false;
  } catch (error) {
    console.error('No pude registrar update_id de Telegram (sigo procesando igual):', error);
    return false;
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate) {
  const msg = update.message;
  if (!msg) return;

  if (await wasUpdateAlreadyProcessed(update.update_id)) return;

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

  // Router conversacional anti-basura: debe ejecutarse ANTES del clasificador general y antes de cualquier lógica secundaria.
  // Si falla este filtro, frases operativas como "qué puedo hacer" o "eliminar ese último" terminan guardadas como items.
  const earlyConversationalRoute = routeConversationalText(text);
  if (earlyConversationalRoute) {
    switch (earlyConversationalRoute.kind) {
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
        return handlePendientesCommand(chatId, earlyConversationalRoute.query);
      case 'done':
        return handleHechoCommand(chatId, earlyConversationalRoute.query);
      case 'search':
        return handleUnifiedSearchCommand(chatId, earlyConversationalRoute.query);
      case 'summary':
        return handleResumenCommand(chatId, earlyConversationalRoute.period);
      case 'review':
        return handleRevisionCommand(chatId, earlyConversationalRoute.period);
      case 'delete':
        if (!earlyConversationalRoute.confirm) return sendMessage(chatId, formatNaturalDeletePrompt(earlyConversationalRoute));
        return handleBorrarCommand(chatId, naturalDeleteArgs(earlyConversationalRoute));
      case 'do_not_save':
        return sendMessage(chatId, 'No lo guardé como item. Para borrar el último registro, mandá: /borrar ultimo confirmar');
      case 'clarify_correction':
        return sendMessage(chatId, formatClarifyCorrection());
    }
  }

  const command = parseTelegramCommand(text);

  if (command?.name === 'start' || command?.name === 'ayuda') {
    await sendMessage(chatId, introText());
    return;
  }

  if (command?.name === 'router') {
    await sendMessage(chatId, 'Router antibasura activo v2. Frases como "Qué puedo hacer?", "Eliminar ese último" y "No guardes eso" no deben guardarse como items.');
    return;
  }


  if (command?.name === 'version' || command?.name === 'versión') {
    return sendMessage(chatId, formatVersionInfo());
  }

  if (command?.name === 'cola') {
    return handleColaCommand(chatId, command.args);
  }

  if (command?.name === 'reprocesar') {
    return handleReprocesarCommand(chatId, command.args);
  }

  if (command?.name === 'bandeja') {
    return handleBandejaCommand(chatId);
  }

  if (command?.name === 'conciliacion' || command?.name === 'conciliación' || command?.name === 'conciliar') {
    return handleConciliacionCommand(chatId, command.name, command.args);
  }

  if (command?.name === 'alias') {
    return handleAliasCommand(chatId, command.args);
  }

  if (command?.name === 'maestras') {
    return handleMaestrasCommand(chatId, command.args);
  }

  if (command?.name === 'gemini') {
    return handleGeminiCommand(chatId, command.args);
  }

  if (command?.name === 'cerebras') {
    return handleCerebrasCommand(chatId, command.args);
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

  if (command?.name === 'importaciones') {
    return handleImportacionesCommand(chatId);
  }

  if (command?.name === 'importacion' || command?.name === 'importación') {
    return handleImportacionCommand(chatId, command.args);
  }

  if (command?.name === 'clasificar') {
    if (/^producto/i.test(command.args || '')) return handleProductoCommand(chatId, command.args);
    return handleClasificarImportadoCommand(chatId, command.args);
  }

  if (command?.name === 'ignorar') {
    return handleIgnorarImportadoCommand(chatId, command.args);
  }

  if (command?.name === 'reporte') {
    return handleReporteFinancieroCommand(chatId, command.args);
  }

  if (command?.name === 'sueldos') {
    return handleSueldosCommand(chatId, command.args);
  }

  if (command?.name === 'sueldo') {
    return handleSueldoCommand(chatId, command.args);
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

  if (command?.name === 'comprobantes') {
    return handleComprobantesCommand(chatId, command.args);
  }

  if (command?.name === 'comprobante') {
    return handleComprobanteCommand(chatId, command.args);
  }

  if (command?.name === 'productos') {
    return handleProductosCommand(chatId, command.args);
  }

  if (command?.name === 'producto') {
    return handleProductoCommand(chatId, command.args);
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

  if (/^(bandeja|que tengo pendiente|qué tengo pendiente|pendientes del sistema)$/i.test(text.trim())) {
    return handleBandejaCommand(chatId);
  }

  if (/^(version|versión|que version|qué versión)/i.test(text.trim())) {
    return sendMessage(chatId, formatVersionInfo());
  }

  if (looksLikeLastSavedQuestion(text)) {
    return handleUltimoCommand(chatId);
  }

  if (looksLikeReviewRequest(text)) {
    return handleRevisionCommand(chatId, text.replace(/^revisi[oó]n\s*/i, ''));
  }

  const pendingAnswerMatch = text.trim().match(/^(\d{1,2})\s*(?:es|son|:|-)\s+(.+)$/i);
  if (pendingAnswerMatch) {
    const handled = await handlePendingImportedAnswer(chatId, Number(pendingAnswerMatch[1]), pendingAnswerMatch[2]);
    if (handled) return;
  } else {
    // Respuesta en bloque: varias líneas, una por pendiente ("1 sin categoria\n2
    // sin categoria\n..."). El regex de una sola línea no cruza saltos de línea,
    // así que antes esto no matcheaba nada y el bloque entero se perdía como una
    // única nota genérica. Si cada línea no vacía tiene el formato "N es/son/:/-
    // texto", se procesa cada una. Se va de mayor a menor índice porque
    // clasificar un pendiente lo saca de la lista y corre los índices de los que
    // quedan; yendo de atrás para adelante los números que faltan no se mueven.
    const rawLines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const perLineMatches = rawLines.map(l => l.match(/^(\d{1,2})\s*(?:es|son|:|-)\s+(.+)$/i));
    if (rawLines.length > 1 && rawLines.length <= 30 && perLineMatches.every(Boolean)) {
      await sendMessage(chatId, `Clasificando ${perLineMatches.length} pendientes...`);
      const ordered = perLineMatches
        .map(m => ({ index: Number(m![1]), answer: m![2] }))
        .sort((a, b) => b.index - a.index);
      const results: string[] = [];
      for (const { index, answer } of ordered) {
        try {
          const result = await classifyImportedMovementFromAnswer(index, answer);
          results.push(result.ok ? `#${index}: ${result.movement.comercio || '-'} — ${result.movement.categoria_financiera || '-'}` : `#${index}: ${result.message}`);
        } catch (error: any) {
          results.push(`#${index}: error (${error?.message || 'desconocido'})`);
        }
      }
      results.reverse();
      const notionLine = formatNotionSyncLine(await syncPendingImportedMovementsToNotion());
      await sendMessage(chatId, [results.join('\n'), notionLine].filter(Boolean).join('\n\n'));
      return;
    }

    // Respondió solo con la sugerencia (ej: "sin categoría"), sin el número del
    // pendiente adelante. Antes esto se perdía como nota genérica random.
    const suggestionMatches = await findPendingIndicesMatchingSuggestion(text);
    if (suggestionMatches.length === 1) {
      const handled = await handlePendingImportedAnswer(chatId, suggestionMatches[0], text.trim());
      if (handled) return;
    } else if (suggestionMatches.length > 1) {
      await sendMessage(chatId, `Hay ${suggestionMatches.length} pendientes con esa misma sugerencia (#${suggestionMatches.join(', #')}). Decime el número, ej: "${suggestionMatches[0]} es ${text.trim()}".`);
      return;
    }
  }

  // "Modificar/corregir el último gasto. Es panadería" (o "movimiento"/"consumo"/"pago").
  // Antes esto no matcheaba ningún handler de finanzas y terminaba creando un item
  // genérico random vía el clasificador de texto libre. Si hay un pendiente de
  // clasificar reciente, se responde igual que "1 es panadería"; si no hay ningún
  // pendiente (el gasto ya había quedado consolidado solo, con categoría genérica),
  // corrige directamente el último finanzas_movimientos.
  const lastFinanceCorrectionMatch = text.trim().match(/^(?:modificar|modifica|corregir|corregi|arreglar|arregla|cambiar|cambia|edita|editar)\s+(?:el\s+)?(?:[uú]ltimo|ultimo)\s+(?:gasto|movimiento|consumo|pago)s?\b[.,:]?\s*(.*)$/i);
  if (lastFinanceCorrectionMatch) {
    const handled = await handleLastFinanceMovementCorrection(chatId, lastFinanceCorrectionMatch[1]);
    if (handled) return;
  }

  if (looksLikeImportCommand(text)) {
    const handled = await handleImportNaturalText(chatId, text);
    if (handled) return;
  }

  if (looksLikeSalaryQueryText(text)) {
    return handleSalaryReportCommand(chatId, text);
  }

  if (looksLikeFinanceAnalyticsText(text)) {
    return handleReporteFinancieroCommand(chatId, text);
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

    // Importador financiero sin Gemini: no clasificamos el PDF como item general.
    // Esto evita gastar cuota de Gemini y evita que un resumen de tarjeta quede como nota basura.
    if (media.kind === 'document' && looksLikeFinanceFile(media.fileName || '', media.mimeType || downloaded.mimeType || '', caption)) {
      await sendMessage(chatId, 'Parece un resumen/movimiento financiero. Lo importo sin usar Gemini y sin guardarlo como item general...');

      const archivo = await saveArchivo({
        item_id: null,
        tipo_archivo: media.kind,
        nombre_archivo: media.fileName || `${media.kind}-${msg.message_id}`,
        mime_type: media.mimeType || downloaded.mimeType || null,
        storage_url: stored.storageRef,
        transcripcion: null,
        descripcion_ia: 'Documento financiero importado sin Gemini.'
      });

      try {
        await createNotionArchivoPage(archivo);
      } catch (error) {
        console.error('No se pudo sincronizar archivo financiero a Notion:', error);
      }

      const financeImport = await importFinanceFile({
        buffer: downloaded.buffer,
        fileName: media.fileName || `${media.kind}-${msg.message_id}`,
        mimeType: media.mimeType || downloaded.mimeType || 'application/octet-stream',
        caption,
        chatId,
        itemId: null,
        archivoId: archivo.id
      });

      let notionSyncLine = '';
      if (financeImport.recognized) {
        notionSyncLine = formatNotionSyncLine(await syncPendingImportedMovementsToNotion());
      }

      const financeImportMessage = formatImportResult(financeImport);
      const importReason = !financeImport.recognized && 'reason' in financeImport ? String((financeImport as any).reason || '') : '';
      return sendMessage(chatId, [
        financeImport.recognized ? 'Documento financiero importado.' : 'Documento financiero guardado, pero no pude extraer movimientos automáticamente.',
        stored.signedUrl ? `Archivo: ${stored.signedUrl}` : '',
        financeImportMessage || importReason || 'No pude extraer movimientos de este formato. Probá con PDF exportado original o CSV/Excel.',
        notionSyncLine
      ].filter(Boolean).join('\n\n'));
    }

    // Comprobantes/tickets/facturas: se procesan antes del recibo de sueldo para evitar que queden como item narrativo.
    const shouldTryComprobante = media.kind === 'photo' || looksLikeComprobanteFile(media.fileName || '', media.mimeType || downloaded.mimeType || '', caption);
    if (shouldTryComprobante) {
      try {
        await sendMessage(chatId, media.kind === 'photo' ? 'Reviso si es recibo/ticket/factura/comprobante...' : 'Reviso si es ticket/factura/comprobante de compra...');
        const compResult = await importComprobanteFromFile({
          buffer: downloaded.buffer,
          fileName: media.fileName || `${media.kind}-${msg.message_id}`,
          mimeType: media.mimeType || downloaded.mimeType || 'application/octet-stream',
          caption,
          chatId,
          archivoId: null,
          force: looksLikeComprobanteFile(media.fileName || '', media.mimeType || downloaded.mimeType || '', caption)
        });

        if (compResult.recognized) {
          const archivo = await saveArchivo({
            item_id: null,
            tipo_archivo: media.kind,
            nombre_archivo: media.fileName || `${media.kind}-${msg.message_id}`,
            mime_type: media.mimeType || downloaded.mimeType || null,
            storage_url: stored.storageRef,
            transcripcion: null,
            descripcion_ia: 'Comprobante/ticket/factura importado.'
          });
          if (compResult.comprobante?.id) {
            await supabase.from('finanzas_comprobantes').update({ archivo_id: archivo.id, updated_at: new Date().toISOString() }).eq('id', compResult.comprobante.id);
          }
          try { await createNotionArchivoPage(archivo); } catch (error) { console.error('No se pudo sincronizar comprobante a Notion:', error); }
          return sendMessage(chatId, [
            formatComprobanteImportResult(compResult),
            stored.signedUrl ? `\nArchivo: ${stored.signedUrl}` : ''
          ].filter(Boolean).join('\n'));
        }
      } catch (error: any) {
        console.error('No pude revisar/importar comprobante:', error);
        const msgText = String(error?.message || '');
        const compHint = looksLikeComprobanteFile(media.fileName || '', media.mimeType || downloaded.mimeType || '', caption) || /ticket|factura|comprobante|coto|arredo|gallo/i.test(caption || '');
        const geminiQuota = /gemini sin cuota|quota|rate limit|resource_exhausted|429/i.test(msgText);
        if (geminiQuota || compHint) {
          const queuedKind = compHint ? 'comprobante' : 'media';
          const archivo = await saveArchivo({
            item_id: null,
            tipo_archivo: media.kind,
            nombre_archivo: media.fileName || `${media.kind}-${msg.message_id}`,
            mime_type: media.mimeType || downloaded.mimeType || null,
            storage_url: stored.storageRef,
            transcripcion: null,
            descripcion_ia: queuedKind === 'media'
              ? 'Archivo pendiente: no pude determinar si es sueldo/ticket/factura por cuota de Gemini.'
              : 'Comprobante/ticket/factura pendiente de reprocesamiento por cuota de Gemini.'
          });
          try { await createNotionArchivoPage(archivo); } catch (error) { console.error('No se pudo sincronizar archivo en cola a Notion:', error); }
          await enqueueProcessingTask({
            kind: queuedKind as any,
            chatId,
            archivoId: archivo.id,
            storageRef: stored.storageRef,
            fileName: media.fileName || `${media.kind}-${msg.message_id}`,
            mimeType: media.mimeType || downloaded.mimeType || 'application/octet-stream',
            caption,
            reason: 'gemini_cuota',
            runAfterMinutes: 10,
            payload: { origen: 'telegram_media', etapa: 'comprobante_check', generic_media: queuedKind === 'media' }
          });
          return sendMessage(chatId, [
            queuedKind === 'media'
              ? 'Guardé el archivo y lo dejé en cola porque Gemini está sin cuota. Todavía no lo marqué como ticket ni como recibo de sueldo.'
              : 'Guardé el archivo y dejé el comprobante/ticket/factura en cola porque Gemini está sin cuota.',
            msgText ? `Detalle: ${msgText.slice(0, 300)}` : '',
            '',
            'Cuando se libere la cuota, procesalo con:',
            '/cola procesar',
            '',
            'Para revisar estado:',
            '/cola',
            '/gemini estado'
          ].filter(Boolean).join('\n'));
        }
      }
    }

    const shouldTrySalary = media.kind === 'photo' || looksLikeSalaryFile(media.fileName || '', media.mimeType || downloaded.mimeType || '', caption);
    if (shouldTrySalary) {
      try {
        await sendMessage(chatId, 'Reviso si es un recibo de sueldo...');
        const salaryResult = await importSalaryReceiptFromFile({
          buffer: downloaded.buffer,
          fileName: media.fileName || `${media.kind}-${msg.message_id}`,
          mimeType: media.mimeType || downloaded.mimeType || 'application/octet-stream',
          caption,
          chatId,
          archivoId: null,
          force: looksLikeSalaryFile(media.fileName || '', media.mimeType || downloaded.mimeType || '', caption)
        });

        if (salaryResult.recognized) {
          const archivo = await saveArchivo({
            item_id: null,
            tipo_archivo: media.kind,
            nombre_archivo: media.fileName || `${media.kind}-${msg.message_id}`,
            mime_type: media.mimeType || downloaded.mimeType || null,
            storage_url: stored.storageRef,
            transcripcion: null,
            descripcion_ia: 'Recibo de sueldo importado.'
          });
          if (salaryResult.recibo?.id) {
            await supabase.from('sueldos_recibos').update({ archivo_id: archivo.id, updated_at: new Date().toISOString() }).eq('id', salaryResult.recibo.id);
          }
          try { await createNotionArchivoPage(archivo); } catch (error) { console.error('No se pudo sincronizar archivo de sueldo a Notion:', error); }
          return sendMessage(chatId, [
            formatSalaryImportResult(salaryResult),
            stored.signedUrl ? `\nArchivo: ${stored.signedUrl}` : ''
          ].filter(Boolean).join('\n'));
        }
      } catch (error: any) {
        console.error('No pude revisar/importar recibo de sueldo:', error);
        const msgText = String(error?.message || '');
        const salaryHint = looksLikeSalaryFile(media.fileName || '', media.mimeType || downloaded.mimeType || '', caption) || /recibo|haberes|sueldo|liquidaci[oó]n/i.test(caption || '');
        const geminiQuota = /gemini sin cuota|quota|rate limit|resource_exhausted|429/i.test(msgText);

        // Importante: si ya intentamos procesar una foto como posible recibo y falló por cuota,
        // NO seguimos al flujo genérico de "describir imagen". Eso consumía otra llamada Gemini
        // y devolvía un error confuso de "descripción de imagen".
        if (geminiQuota || salaryHint || media.kind === 'photo') {
          const queuedKind = salaryHint ? 'sueldo' : 'media';
          const archivo = await saveArchivo({
            item_id: null,
            tipo_archivo: media.kind,
            nombre_archivo: media.fileName || `${media.kind}-${msg.message_id}`,
            mime_type: media.mimeType || downloaded.mimeType || null,
            storage_url: stored.storageRef,
            transcripcion: null,
            descripcion_ia: queuedKind === 'media'
              ? 'Archivo pendiente: no pude determinar si es sueldo/ticket/factura por cuota de Gemini.'
              : 'Recibo de sueldo pendiente de reprocesamiento por cuota de Gemini.'
          });
          try { await createNotionArchivoPage(archivo); } catch (error) { console.error('No se pudo sincronizar archivo de sueldo en cola a Notion:', error); }
          await enqueueProcessingTask({
            kind: queuedKind as any,
            chatId,
            archivoId: archivo.id,
            storageRef: stored.storageRef,
            fileName: media.fileName || `${media.kind}-${msg.message_id}`,
            mimeType: media.mimeType || downloaded.mimeType || 'application/octet-stream',
            caption,
            reason: 'gemini_cuota',
            runAfterMinutes: 10,
            payload: { origen: 'telegram_media', etapa: 'salary_check', generic_media: queuedKind === 'media' }
          });
          return sendMessage(chatId, [
            queuedKind === 'media'
              ? 'Guardé el archivo y lo dejé en cola porque Gemini está sin cuota. Todavía no lo marqué como ticket ni como recibo de sueldo.'
              : 'Guardé el archivo y dejé el recibo de sueldo en cola porque Gemini está sin cuota.',
            msgText ? `Detalle: ${msgText.slice(0, 300)}` : '',
            '',
            'Cuando se libere la cuota, procesalo con:',
            '/cola procesar',
            '',
            'Carga manual alternativa si es urgente:',
            '/sueldo cargar periodo 2026-02 neto 3744369 bruto 4667076 empresa Dr Gray fecha 2026-03-05'
          ].filter(Boolean).join('\n'));
        }
      }
    }

    // Captura de pago/transferencia (Mercado Pago, home banking, QR) que no es
    // ticket itemizado ni recibo de sueldo. Antes esto no tenía ningún camino:
    // caía directo al clasificador genérico de items sin pasar por finanzas ni
    // preguntar nada. Reusa el mismo staging que el importador de PDF, así que
    // si no hay certeza queda pendiente y dispara la pregunta proactiva.
    if (media.kind === 'photo') {
      try {
        await sendMessage(chatId, 'Reviso si es un pago o transferencia (Mercado Pago, banco, QR)...');
        const paymentImport = await importPaymentScreenshotFile({
          buffer: downloaded.buffer,
          fileName: media.fileName || `${media.kind}-${msg.message_id}`,
          mimeType: media.mimeType || downloaded.mimeType || 'image/jpeg',
          caption,
          chatId,
          itemId: null,
          archivoId: null
        });

        if (paymentImport.recognized) {
          const archivo = await saveArchivo({
            item_id: null,
            tipo_archivo: media.kind,
            nombre_archivo: media.fileName || `${media.kind}-${msg.message_id}`,
            mime_type: media.mimeType || downloaded.mimeType || null,
            storage_url: stored.storageRef,
            transcripcion: null,
            descripcion_ia: 'Captura de pago/transferencia importada.'
          });
          try { await createNotionArchivoPage(archivo); } catch (error) { console.error('No se pudo sincronizar captura de pago a Notion:', error); }
          const notionSyncLine = formatNotionSyncLine(await syncPendingImportedMovementsToNotion());
          return sendMessage(chatId, [
            paymentImport.duplicate ? 'Esta captura ya la había importado.' : 'Pago/transferencia detectado e importado.',
            stored.signedUrl ? `Archivo: ${stored.signedUrl}` : '',
            formatImportResult(paymentImport),
            notionSyncLine
          ].filter(Boolean).join('\n\n'));
        }
      } catch (error: any) {
        console.error('No pude revisar/importar captura de pago:', error);
        // No es un error fatal: si no se pudo determinar, seguimos con el flujo
        // genérico de foto en vez de cortar el mensaje con un error confuso.
      }
    }

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

    let financeImportMessage = '';
    if (media.kind === 'document' && looksLikeFinanceFile(media.fileName || '', media.mimeType || downloaded.mimeType || '', caption)) {
      try {
        await sendMessage(chatId, 'Parece un resumen/movimiento financiero. Importando y conciliando...');
        const financeImport = await importFinanceFile({
          buffer: downloaded.buffer,
          fileName: media.fileName || `${media.kind}-${msg.message_id}`,
          mimeType: media.mimeType || downloaded.mimeType || 'application/octet-stream',
          caption,
          chatId,
          itemId: result.item.id,
          archivoId: archivo.id
        });
        if (financeImport.recognized) {
          const notionSync = await syncPendingImportedMovementsToNotion();
          const notionLine = formatNotionSyncLine(notionSync);
          financeImportMessage = [formatImportResult(financeImport), notionLine].filter(Boolean).join('\n\n');
        } else {
          financeImportMessage = formatImportResult(financeImport);
        }
      } catch (error: any) {
        console.error('No pude importar finanzas desde archivo:', error);
        financeImportMessage = `No pude importar movimientos financieros: ${error?.message || 'error desconocido'}`;
      }
    }

    return sendMessage(chatId, [
      media.kind === 'voice' || media.kind === 'audio' ? 'Audio guardado.' : media.kind === 'photo' ? 'Foto guardada.' : 'Documento guardado.',
      '',
      `Título: ${result.clasificacion.titulo}`,
      `Categoría: ${result.clasificacion.categoria_principal}`,
      `Tipo: ${result.clasificacion.tipo_item}`,
      `Tags: ${(result.clasificacion.tags || []).join(', ') || '-'}`,
      stored.signedUrl ? `Archivo: ${stored.signedUrl}` : '',
      transcripcion ? `\nTranscripción: ${transcripcion.slice(0, 900)}` : '',
      financeImportMessage ? `\n${financeImportMessage}` : ''
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
    '/importaciones',
    '/comprobantes',
    '/comprobante ultimo',
    '/comprobante items ultimo',
    '/productos coto',
    '/producto gasto sensodyne 2026',
    '/clasificar producto sensodyne como Higiene personal guardar regla',
    '/sueldos',
    '/sueldo ultimo',
    '/sueldo conceptos ultimo',
    '/importacion revisar',
    '/clasificar 1 Suscripciones guardar regla',
    '/reporte gasto chatgpt 2026',
    'cuánto cobré este año',
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
    '/version',
    '/cola',
    '/cola procesar',
    '/bandeja',
    '/conciliacion pendientes',
    '/alias openai',
    '/entidades maestras',
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




async function handleImportacionesCommand(chatId: number) {
  try {
    const rows = await listFinanceImports(10);
    return sendMessage(chatId, formatImports(rows));
  } catch (error: any) {
    console.error('No pude listar importaciones:', error);
    return sendMessage(chatId, `No pude listar importaciones: ${error?.message || 'error desconocido'}`);
  }
}

async function handleImportacionCommand(chatId: number, args: string) {
  const a = removeAccents(args || '').toLowerCase();
  try {
    if (a.includes('procesar') || a.includes('consolidar')) {
      const result = await processFinanceImportation();
      const notionLine = formatNotionSyncLine(await syncPendingImportedMovementsToNotion());
      return sendMessage(chatId, [formatProcessImportResult(result), notionLine].filter(Boolean).join('\n\n'));
    }

    if (!a || a.includes('ultima') || a.includes('última')) {
      const imp = await latestFinanceImport();
      if (!imp) return sendMessage(chatId, 'No hay importaciones financieras todavía.');
      const stats = await import('./financeImport.js').then(m => m.buildImportStats(imp.id));
      const pending = await getPendingImportedMovements(5);
      return sendMessage(chatId, [
        'Última importación financiera',
        '',
        `Fuente: ${imp.proveedor || imp.tipo_fuente || '-'}`,
        `Tarjeta: ${imp.tarjeta || '-'}`,
        `Periodo: ${imp.periodo || '-'}`,
        `Estado: ${imp.estado || '-'}`,
        `Movimientos: ${stats.total || 0}`,
        `Importados: ${stats.importado || 0}`,
        `Conciliados: ${stats.conciliado || 0}`,
        `Clasificados sin consolidar: ${stats.clasificado || 0}`,
        `Pendientes: ${stats.pendiente_revision || 0}`,
        '',
        stats.clasificado ? 'Para consolidar los ya clasificados: /importacion procesar' : '',
        pending.length ? formatPendingImported(pending.slice(0, 5)) : 'Sin pendientes de clasificación.'
      ].filter(Boolean).join('\n'));
    }
    if (a.includes('revisar') || a.includes('pendiente')) {
      const rows = await getPendingImportedMovements(12);
      return sendMessage(chatId, formatPendingImported(rows));
    }
    return sendMessage(chatId, 'Usá: /importacion ultima, /importacion revisar o /importacion procesar');
  } catch (error: any) {
    console.error('No pude revisar/procesar importación:', error);
    return sendMessage(chatId, `No pude revisar/procesar importación: ${error?.message || 'error desconocido'}`);
  }
}

async function handleClasificarImportadoCommand(chatId: number, args: string) {
  const match = String(args || '').trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return sendMessage(chatId, 'Usá: /clasificar 1 Suscripciones guardar regla');
  const index = Number(match[1]);
  const text = match[2];
  const saveRule = /guardar regla|siempre|recordar/i.test(text);
  try {
    const result = await classifyImportedMovementByIndex(index, text, saveRule);
    const notionLine = result.ok ? formatNotionSyncLine(await syncPendingImportedMovementsToNotion()) : '';
    return sendMessage(chatId, [formatClassifyImportedResult(result), notionLine].filter(Boolean).join('\n\n'));
  } catch (error: any) {
    console.error('No pude clasificar importado:', error);
    return sendMessage(chatId, `No pude clasificar movimiento importado: ${error?.message || 'error desconocido'}`);
  }
}

// Sincroniza a Notion CUALQUIER movimiento importado que todavia no tenga
// página de Notion asociada, sin importar si se creó ahora o en una importación
// anterior (incluye datos de pruebas viejas hechas antes de este fix).
// Devuelve el resultado (en vez de tragarse el error en silencio) para poder
// mostrarlo en el mensaje del bot y diagnosticar sin depender de logs de Vercel.
async function syncPendingImportedMovementsToNotion(): Promise<{ ok: boolean; synced: number; total: number; error?: string }> {
  try {
    const pending = await getUnsyncedImportedMovements();
    if (!pending.length) return { ok: true, synced: 0, total: 0 };
    if (!getNotionClient()) return { ok: false, synced: 0, total: pending.length, error: 'NOTION_TOKEN no configurado' };
    const result = await syncNotionImportedMovements(pending);
    return { ok: true, synced: result.movimientos, total: pending.length };
  } catch (error: any) {
    console.error('No se pudo sincronizar movimientos importados pendientes a Notion:', error);
    return { ok: false, synced: 0, total: 0, error: error?.message || 'error desconocido' };
  }
}

function formatNotionSyncLine(sync: { ok: boolean; synced: number; total: number; error?: string }) {
  if (!sync.ok) return `Notion: no pude sincronizar (${sync.error || 'error desconocido'}).`;
  if (!sync.total) return '';
  return `Notion: sincronizados ${sync.synced} de ${sync.total} movimientos pendientes.`;
}

// "Modificar/corregir el último gasto. Es X": primero intenta como respuesta al
// pendiente de clasificar más reciente (igual que "1 es X"); si no hay ningún
// pendiente, corrige directamente el último finanzas_movimientos ya consolidado.
async function handleLastFinanceMovementCorrection(chatId: number, answerTextRaw: string): Promise<boolean> {
  const answerText = String(answerTextRaw || '').trim();
  try {
    const pending = await getPendingImportedMovements(30);
    if (pending.length) {
      const handled = await handlePendingImportedAnswer(chatId, pending.length, answerText || 'sin detalle adicional');
      if (handled) return true;
    }

    if (!answerText) {
      await sendMessage(chatId, 'Decime qué corrijo del último gasto. Ejemplo: "Modificar el último gasto. Es panadería".');
      return true;
    }

    const updated = await correctLastFinanceMovementFromText(answerText);
    if (!updated) {
      await sendMessage(chatId, 'No encontré ningún gasto reciente para corregir.');
      return true;
    }

    const notionLine = formatNotionSyncLine(await syncSingleMovementToNotion(updated));
    await sendMessage(chatId, [formatCorrectedMovement(updated), notionLine].filter(Boolean).join('\n\n'));
    return true;
  } catch (error: any) {
    console.error('No pude corregir el último gasto:', error);
    return false;
  }
}

async function syncSingleMovementToNotion(movement: any): Promise<{ ok: boolean; synced: number; total: number; error?: string }> {
  try {
    if (!getNotionClient()) return { ok: false, synced: 0, total: 1, error: 'NOTION_TOKEN no configurado' };
    const result = await syncNotionImportedMovements([movement]);
    return { ok: true, synced: result.movimientos, total: 1 };
  } catch (error: any) {
    console.error('No se pudo sincronizar corrección de gasto a Notion:', error);
    return { ok: false, synced: 0, total: 0, error: error?.message || 'error desconocido' };
  }
}

function formatCorrectedMovement(row: any) {
  return [
    'Gasto corregido.',
    '',
    `Comercio: ${row.comercio || '-'}`,
    `Categoría: ${row.categoria_financiera || '-'}${row.subcategoria_financiera ? ` / ${row.subcategoria_financiera}` : ''}`,
    `Monto: $${Number(row.monto || 0).toLocaleString('es-AR')}`,
    `Fecha: ${row.fecha_movimiento || '-'}`
  ].join('\n');
}

// Responder en lenguaje natural a un pendiente de clasificación: "1 es mercado pago,
// le pagué a mi hermano por nafta". Si el número no corresponde a ningún pendiente
// real, no hace nada (devuelve false) para no interferir con mensajes normales que
// arrancan con un número por otro motivo.
async function handlePendingImportedAnswer(chatId: number, index: number, answerText: string) {
  try {
    const pending = await getPendingImportedMovements(30);
    if (!pending.length || index < 1 || index > pending.length) return false;

    await sendMessage(chatId, 'Anotado. Clasificando con lo que me contaste...');
    const result = await classifyImportedMovementFromAnswer(index, answerText);
    if (!result.ok) {
      await sendMessage(chatId, result.message);
      return true;
    }
    const notionLine = formatNotionSyncLine(await syncPendingImportedMovementsToNotion());
    await sendMessage(chatId, [formatClassifyImportedResult(result), notionLine].filter(Boolean).join('\n\n'));
    return true;
  } catch (error: any) {
    console.error('No pude interpretar respuesta a pendiente de clasificación:', error);
    return false;
  }
}

async function handleIgnorarImportadoCommand(chatId: number, args: string) {
  const match = String(args || '').trim().match(/^(?:importado\s+)?(\d+)$/i);
  if (!match) return sendMessage(chatId, 'Usá: /ignorar importado 1');
  try {
    const result = await ignoreImportedMovementByIndex(Number(match[1]));
    return sendMessage(chatId, formatIgnoreImportedResult(result));
  } catch (error: any) {
    console.error('No pude ignorar importado:', error);
    return sendMessage(chatId, `No pude ignorar movimiento importado: ${error?.message || 'error desconocido'}`);
  }
}



async function handleColaCommand(chatId: number, args: string) {
  const a = removeAccents(String(args || '').trim().toLowerCase());
  try {
    if (a.includes('limpiar')) {
      const n = await cleanupQueueCompleted();
      return sendMessage(chatId, `Cola limpiada. Completados borrados: ${n}`);
    }
    if (a.includes('procesar')) {
      const m = a.match(/(\d+)/);
      const limit = m ? Number(m[1]) : 5;
      await sendMessage(chatId, `Procesando cola (${limit})...`);
      const results = await processQueue(limit, a.includes('forzar'));
      return sendMessage(chatId, formatQueueProcessResults(results));
    }
    const rows = await listQueue(a.replace(/^errores?/, 'error'), 20);
    return sendMessage(chatId, formatQueue(rows));
  } catch (error: any) {
    console.error('No pude manejar cola:', error);
    return sendMessage(chatId, `No pude manejar cola: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/mega_conexion.sql.`);
  }
}

async function handleReprocesarCommand(chatId: number, args: string) {
  try {
    const last = await retryLastQueued();
    if (!last) return sendMessage(chatId, 'No hay tareas para reprocesar.');
    const results = await processQueue(1, true);
    return sendMessage(chatId, formatQueueProcessResults(results));
  } catch (error: any) {
    console.error('No pude reprocesar:', error);
    return sendMessage(chatId, `No pude reprocesar: ${error?.message || 'error desconocido'}`);
  }
}

async function handleBandejaCommand(chatId: number) {
  try {
    const inbox = await buildInbox();
    return sendMessage(chatId, formatInbox(inbox));
  } catch (error: any) {
    console.error('No pude armar bandeja:', error);
    return sendMessage(chatId, `No pude armar bandeja: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/mega_conexion.sql.`);
  }
}

async function handleConciliacionCommand(chatId: number, name: string, args: string) {
  const a = removeAccents(String(args || '').trim().toLowerCase());
  try {
    if (name === 'conciliar' && /\d+/.test(a) && a.includes('confirmar')) {
      const n = Number((a.match(/\d+/) || ['0'])[0]);
      const result = await confirmConciliationByIndex(n);
      return sendMessage(chatId, formatConciliationDone(result));
    }
    if (name === 'conciliar' && /\d+/.test(a) && (a.includes('rechazar') || a.includes('no'))) {
      const n = Number((a.match(/\d+/) || ['0'])[0]);
      const result = await rejectConciliationByIndex(n);
      return sendMessage(chatId, `Conciliación rechazada: ${result.tipo}`);
    }
    if (a.includes('fuentes') || a.includes('ultimo') || a.includes('último')) {
      const payload = await getFinancialSourcesForLastMovement();
      return sendMessage(chatId, formatSources(payload));
    }
    const rows = await listConciliationCandidates(15);
    return sendMessage(chatId, formatConciliationCandidates(rows));
  } catch (error: any) {
    console.error('No pude conciliar:', error);
    return sendMessage(chatId, `No pude conciliar: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/mega_conexion.sql.`);
  }
}

async function handleAliasCommand(chatId: number, args: string) {
  const a = String(args || '').trim();
  try {
    if (!a) return sendMessage(chatId, 'Usá: /alias openai o /alias OPENAI *CHATGPT => OpenAI / ChatGPT');
    if (/=>|->|como|=/.test(a)) {
      const result = await addAliasFromText(a);
      return sendMessage(chatId, formatAliasAdded(result));
    }
    if (removeAccents(a.toLowerCase()).includes('sembrar') || removeAccents(a.toLowerCase()).includes('default')) {
      const result = await seedDefaultEntityBrain();
      return sendMessage(chatId, `Entidades maestras inicializadas. Aliases cargados: ${result.inserted}`);
    }
    const rows = await listAliases(a, 30);
    return sendMessage(chatId, formatAliases(rows));
  } catch (error: any) {
    console.error('No pude manejar alias:', error);
    return sendMessage(chatId, `No pude manejar alias: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/mega_conexion.sql.`);
  }
}

async function handleMaestrasCommand(chatId: number, args: string) {
  try {
    const rows = await listMasterEntities(args || '', 30);
    return sendMessage(chatId, formatMasterEntities(rows));
  } catch (error: any) {
    console.error('No pude listar entidades maestras:', error);
    return sendMessage(chatId, `No pude listar entidades maestras: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/mega_conexion.sql.`);
  }
}

async function handleComprobantesCommand(chatId: number, args: string) {
  try {
    const rows = await listComprobantes(args || '', 12);
    return sendMessage(chatId, formatComprobantes(rows));
  } catch (error: any) {
    console.error('No pude listar comprobantes:', error);
    return sendMessage(chatId, `No pude listar comprobantes: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/comprobantes.sql.`);
  }
}

async function handleComprobanteCommand(chatId: number, args: string) {
  const a = removeAccents(String(args || '').trim().toLowerCase());
  try {
    if (!a || a.includes('ultimo') || a.includes('ultima') || a.includes('último') || a.includes('última')) {
      if (a.includes('item') || a.includes('items') || a.includes('producto')) {
        const payload = await getComprobanteItems(null, 80);
        return sendMessage(chatId, formatComprobanteItems(payload));
      }
      const last = await getLastComprobante();
      return sendMessage(chatId, formatComprobanteDetail(last));
    }

    if (a.includes('items') || a.includes('productos')) {
      const payload = await getComprobanteItems(null, 80);
      return sendMessage(chatId, formatComprobanteItems(payload));
    }

    return sendMessage(chatId, 'Usá: /comprobante ultimo o /comprobante items ultimo');
  } catch (error: any) {
    console.error('No pude obtener comprobante:', error);
    return sendMessage(chatId, `No pude obtener comprobante: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/comprobantes.sql.`);
  }
}

async function handleProductosCommand(chatId: number, args: string) {
  try {
    const rows = await listProducts(args || '', 30);
    return sendMessage(chatId, formatProducts(rows));
  } catch (error: any) {
    console.error('No pude listar productos:', error);
    return sendMessage(chatId, `No pude listar productos: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/comprobantes.sql.`);
  }
}

async function handleProductoCommand(chatId: number, args: string) {
  const text = String(args || '').trim();
  if (!text) return sendMessage(chatId, 'Usá: /producto sensodyne o /producto gasto sensodyne 2026');
  if (/clasificar|guardar\s+regla|como/i.test(text)) {
    try {
      const result = await saveProductRuleFromText(text.startsWith('clasificar') ? text : `producto ${text}`);
      return sendMessage(chatId, formatProductRuleResult(result));
    } catch (error: any) {
      console.error('No pude guardar regla de producto:', error);
      return sendMessage(chatId, `No pude guardar regla de producto: ${error?.message || 'error desconocido'}`);
    }
  }
  if (/gasto|gaste|gasté|cuanto|cuánto|año|ano|20\d{2}/i.test(text)) {
    return handleProductSpendingCommand(chatId, text);
  }
  return handleProductosCommand(chatId, text);
}

async function handleProductSpendingCommand(chatId: number, text: string) {
  try {
    const result = await summarizeProductSpending(text);
    return sendMessage(chatId, formatProductSpendingReport(result));
  } catch (error: any) {
    console.error('No pude calcular reporte de producto:', error);
    return sendMessage(chatId, `No pude calcular reporte de producto: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/comprobantes.sql.`);
  }
}


async function handleGeminiCommand(chatId: number, args: string) {
  const a = removeAccents(String(args || '').trim().toLowerCase());

  if (!a || a.includes('estado')) {
    const status = getGeminiPoolStatus();
    const lines = ['Gemini / rotación de API keys', ''];
    lines.push(`Keys detectadas: ${status.length}`);
    if (!status.length) {
      lines.push('No hay keys configuradas. Falta GEMINI_API_KEY.');
      return sendMessage(chatId, lines.join('\n'));
    }
    for (const s of status) {
      lines.push([
        `${s.label}: ${s.available ? 'disponible' : `cooldown ${s.cooldownSeconds}s`}`,
        `fallos: ${s.failures}`,
        s.lastError ? `último error: ${s.lastError}` : '',
        s.lastUsedAt ? `último uso: ${s.lastUsedAt}` : ''
      ].filter(Boolean).join(' | '));
    }
    lines.push('', 'Si Keys detectadas = 1, Vercel no está leyendo GEMINI_API_KEY_2. Agregala en Environment Variables y redeploy.');
    return sendMessage(chatId, lines.join('\n'));
  }

  if (a.includes('probar') || a.includes('test')) {
    await sendMessage(chatId, 'Probando Gemini con el pool de keys...');
    const result = await testGeminiPoolOnce();
    const lines = ['Prueba Gemini'];
    lines.push(result.ok ? `OK con ${result.keyLabel}` : `Falló: ${result.error || 'error desconocido'}`);
    lines.push('');
    lines.push('Estado actual:');
    for (const s of result.status) {
      lines.push(`${s.label}: ${s.available ? 'disponible' : `cooldown ${s.cooldownSeconds}s`} | fallos ${s.failures}${s.lastError ? ` | ${s.lastError}` : ''}`);
    }
    return sendMessage(chatId, lines.join('\n'));
  }

  return sendMessage(chatId, 'Usá: /gemini estado o /gemini probar');
}

async function handleCerebrasCommand(chatId: number, args: string) {
  const a = removeAccents(String(args || '').trim().toLowerCase());

  if (!a || a.includes('estado')) {
    const configured = getCerebrasConfiguredKeyCount();
    const lines = ['Cerebras / clasificación de texto (opcional)', ''];
    lines.push(`Keys detectadas: ${configured}`);
    if (!configured) {
      lines.push('No hay keys configuradas. La clasificación de texto sigue usando solo Gemini.');
      lines.push('Para activarlo: agregá CEREBRAS_API_KEY en las variables de entorno y redeploy.');
      return sendMessage(chatId, lines.join('\n'));
    }
    const status = getCerebrasPoolStatus();
    for (const s of status) {
      lines.push([
        `${s.label}: ${s.available ? 'disponible' : `cooldown ${s.cooldownSeconds}s`}`,
        `fallos: ${s.failures}`,
        s.lastError ? `último error: ${s.lastError}` : '',
        s.lastUsedAt ? `último uso: ${s.lastUsedAt}` : ''
      ].filter(Boolean).join(' | '));
    }
    lines.push('', 'Se usa para clasificar texto y parsear gastos en lenguaje natural. Si falla, cae automáticamente a Gemini.');
    return sendMessage(chatId, lines.join('\n'));
  }

  if (a.includes('probar') || a.includes('test')) {
    if (!getCerebrasConfiguredKeyCount()) {
      return sendMessage(chatId, 'No hay CEREBRAS_API_KEY configurada. Agregala en las variables de entorno y redeploy.');
    }
    await sendMessage(chatId, 'Probando Cerebras con el pool de keys...');
    const result = await testCerebrasPoolOnce();
    const lines = ['Prueba Cerebras'];
    lines.push(result.ok ? `OK con ${result.keyLabel} — respuesta: ${result.text}` : `Falló: ${result.error || 'error desconocido'}`);
    lines.push('');
    lines.push('Estado actual:');
    for (const s of result.status) {
      lines.push(`${s.label}: ${s.available ? 'disponible' : `cooldown ${s.cooldownSeconds}s`} | fallos ${s.failures}${s.lastError ? ` | ${s.lastError}` : ''}`);
    }
    return sendMessage(chatId, lines.join('\n'));
  }

  return sendMessage(chatId, 'Usá: /cerebras estado o /cerebras probar');
}

async function handleSueldosCommand(chatId: number, args: string) {
  try {
    const rows = await listSalaryReceipts(args || '', 20);
    return sendMessage(chatId, formatSalaryList(rows, args ? `Sueldos: ${args}` : 'Sueldos cargados'));
  } catch (error: any) {
    console.error('No pude listar sueldos:', error);
    return sendMessage(chatId, `No pude listar sueldos: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/salary_receipts.sql.`);
  }
}

async function handleSueldoCommand(chatId: number, args: string) {
  const a = removeAccents(String(args || '').trim().toLowerCase());
  try {
    // OJO: antes usaba a.includes('ultimo'), que tambien hace match dentro de "ultimos"
    // (plural). Eso hacia que "/sueldo horas extras ultimos 3 meses" se interpretara como
    // "mostrame el ultimo recibo" en vez de correr el reporte. \bultimo\b exige la palabra
    // exacta "ultimo" y no matchea "ultimos".
    if (!a || /\bultimo\b/.test(a)) {
      if (a.includes('concepto')) {
        const result = await getSalaryConcepts(args || 'ultimo');
        return sendMessage(chatId, formatSalaryConcepts(result));
      }
      const row = await getLastSalaryReceipt();
      return sendMessage(chatId, formatSalaryReceipt(row));
    }

    if (a.startsWith('conceptos') || a.includes('conceptos')) {
      const result = await getSalaryConcepts(args);
      return sendMessage(chatId, formatSalaryConcepts(result));
    }

    if (a.startsWith('confirmar')) {
      const result = await confirmLastSalaryReceipt();
      if (!result.ok) return sendMessage(chatId, result.message);
      return sendMessage(chatId, `Recibo confirmado: ${result.recibo.periodo || '-'} — neto $${Number(result.recibo.total_neto || 0).toLocaleString('es-AR')}`);
    }

    if (a.startsWith('corregir')) {
      const result = await correctLastSalaryReceiptFromText(args);
      if (!result.ok) return sendMessage(chatId, result.message);
      return sendMessage(chatId, `Recibo corregido: ${result.recibo.periodo || '-'} — neto $${Number(result.recibo.total_neto || 0).toLocaleString('es-AR')}`);
    }

    if (a.startsWith('cargar')) {
      const result = await createManualSalaryReceiptFromText(chatId, args);
      if (!result.ok) return sendMessage(chatId, result.message);
      return sendMessage(chatId, formatSalaryImportResult(result.result));
    }

    return handleSalaryReportCommand(chatId, args);
  } catch (error: any) {
    console.error('No pude procesar comando sueldo:', error);
    return sendMessage(chatId, `No pude procesar sueldo: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/salary_receipts.sql.`);
  }
}

async function handleSalaryReportCommand(chatId: number, args: string) {
  await sendMessage(chatId, 'Calculando reporte de sueldos...');
  try {
    const result = await summarizeSalaryFromText(args || 'este año');
    return sendMessage(chatId, formatSalarySummary(result));
  } catch (error: any) {
    console.error('No pude calcular reporte de sueldos:', error);
    return sendMessage(chatId, `No pude calcular reporte de sueldos: ${error?.message || 'error desconocido'}. Si acabás de instalar el parche, ejecutá supabase/salary_receipts.sql.`);
  }
}

async function handleReporteFinancieroCommand(chatId: number, args: string) {
  const query = String(args || '').replace(/^gasto[s]?\s*/i, '').trim() || 'gastos';
  await sendMessage(chatId, 'Calculando reporte financiero...');
  try {
    const report = await summarizeFinanceAnalytics(query);
    return sendMessage(chatId, formatFinanceAnalyticsReport(report));
  } catch (error: any) {
    console.error('No pude calcular reporte financiero:', error);
    return sendMessage(chatId, `No pude calcular reporte financiero: ${error?.message || 'error desconocido'}`);
  }
}

async function handleImportNaturalText(chatId: number, text: string) {
  const t = removeAccents(text).toLowerCase();
  if (t.includes('revisar') || t.includes('pendiente')) {
    await handleImportacionCommand(chatId, 'revisar');
    return true;
  }
  if (t.startsWith('/clasificar') || t.startsWith('clasificar ')) {
    await handleClasificarImportadoCommand(chatId, text.replace(/^\/?clasificar\s*/i, ''));
    return true;
  }
  return false;
}

async function handleEstadoCommand(chatId: number) {
  try {
    const tables = ['items', 'entidades', 'memorias', 'archivos', 'finanzas_movimientos', 'finanzas_deudas', 'finanzas_particiones', 'finanzas_cierres', 'finanzas_presupuestos', 'finanzas_importaciones', 'finanzas_movimientos_importados', 'finanzas_reglas_comercios', 'finanzas_conciliaciones', 'sueldos_recibos', 'sueldos_conceptos', 'pendientes'];
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
    lines.push(`Cerebras: ${getCerebrasConfiguredKeyCount() ? `configurado (${getCerebrasConfiguredKeyCount()} key/s), clasificación de texto` : 'sin key (clasificación usa solo Gemini)'}`);
    lines.push('', 'Comandos útiles: /backup, /buscar, /archivos, /finanzas, /gastos, /deudas, /tarjetas, /sueldos');
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
