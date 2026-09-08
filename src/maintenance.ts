import { generateBackupZip } from './backup.js';
import { config } from './config.js';
import { getAppConfigMap, getAppConfigValue, setAppConfigValue, supabase } from './supabaseClient.js';
import { computeEstadoVencimiento, getEquipoMemoria } from './equipos.js';

const DAILY_BACKUP_INTERVAL_DAYS = 7;
const BACKUP_TABLES_FOR_PING = [
  'items',
  'entidades',
  'memorias',
  'archivos',
  'finanzas_movimientos',
  'finanzas_deudas',
  'finanzas_cierres',
  'finanzas_presupuestos',
  'finanzas_importaciones',
  'finanzas_movimientos_importados',
  'finanzas_reglas_comercios',
  'finanzas_conciliaciones',
  'finanzas_comprobantes',
  'finanzas_comprobante_items',
  'finanzas_reglas_productos',
  'sueldos_recibos',
  'sueldos_conceptos',
  'pendientes'
];

type MaintenanceResult = {
  ok: boolean;
  ranAt: string;
  pingOk: boolean;
  pingTable?: string;
  pingError?: string;
  backupSent: boolean;
  backupSkippedReason?: string;
  chatId?: string | null;
  lastBackupAt?: string | null;
  nextBackupDueAt?: string | null;
};

export async function rememberTelegramChat(chatId: number | string) {
  const value = String(chatId);
  const now = new Date().toISOString();
  try {
    await setAppConfigValue('telegram_last_chat_id', value);
    await setAppConfigValue('telegram_last_seen_at', now);
  } catch (error) {
    console.error('No pude registrar último chat de Telegram:', error);
  }
}

export async function pingSupabaseForKeepAlive() {
  const now = new Date().toISOString();
  let lastError = '';

  for (const table of BACKUP_TABLES_FOR_PING) {
    try {
      const { error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true });

      if (error) {
        lastError = `${table}: ${error.message}`;
        continue;
      }

      await setAppConfigValue('maintenance_last_keepalive_at', now);
      await setAppConfigValue('maintenance_last_keepalive_table', table);
      return { ok: true as const, table, at: now };
    } catch (error: any) {
      lastError = `${table}: ${error?.message || error}`;
    }
  }

  await setAppConfigValue('maintenance_last_keepalive_error', lastError || 'sin detalle');
  return { ok: false as const, error: lastError || 'No hubo tabla disponible para ping.', at: now };
}

export async function runScheduledMaintenance(options?: { forceBackup?: boolean; manualChatId?: number | string }) : Promise<MaintenanceResult> {
  const now = new Date();
  const ranAt = now.toISOString();
  const ping = await pingSupabaseForKeepAlive();

  const cfg = await getAppConfigMap([
    'telegram_last_chat_id',
    'maintenance_last_auto_backup_at',
    'maintenance_last_auto_backup_filename'
  ]);

  const chatId = options?.manualChatId ? String(options.manualChatId) : (cfg.telegram_last_chat_id || null);
  const lastBackupAt = cfg.maintenance_last_auto_backup_at || null;
  const due = options?.forceBackup || isBackupDue(lastBackupAt, now);
  const nextBackupDueAt = lastBackupAt ? addDaysIso(lastBackupAt, DAILY_BACKUP_INTERVAL_DAYS) : ranAt;

  const result: MaintenanceResult = {
    ok: ping.ok,
    ranAt,
    pingOk: ping.ok,
    pingTable: ping.ok ? ping.table : undefined,
    pingError: ping.ok ? undefined : ping.error,
    backupSent: false,
    backupSkippedReason: undefined,
    chatId,
    lastBackupAt,
    nextBackupDueAt
  };

  if (!chatId) {
    result.backupSkippedReason = 'sin telegram_last_chat_id; mandá cualquier mensaje al bot primero';
    await setAppConfigValue('maintenance_last_run_at', ranAt);
    return result;
  }

  if (!due) {
    result.backupSkippedReason = `todavía no pasaron ${DAILY_BACKUP_INTERVAL_DAYS} días desde el último backup automático`;
    await setAppConfigValue('maintenance_last_run_at', ranAt);
    return result;
  }

  try {
    const backup = await generateBackupZip();
    await sendTelegramDocument(Number(chatId), backup.filename, backup.buffer, [
      options?.forceBackup ? 'Backup automático de prueba.' : 'Backup automático semanal.',
      '',
      `Generado: ${formatDateAR(ranAt)}`,
      `Items: ${backup.counts.items || 0}`,
      `Entidades: ${backup.counts.entidades || 0}`,
      `Memorias: ${backup.counts.memorias || 0}`,
      `Archivos: ${backup.counts.archivos || 0}`,
      `Gastos: ${backup.counts.finanzas_movimientos || 0}`,
      `Comprobantes: ${backup.counts.finanzas_comprobantes || 0}`,
      `Productos comprobantes: ${backup.counts.finanzas_comprobante_items || 0}`,
      `Pendientes: ${backup.counts.pendientes || 0}`,
      '',
      'Guardá este ZIP como respaldo externo.'
    ].join('\n'));

    await setAppConfigValue('maintenance_last_auto_backup_at', ranAt);
    await setAppConfigValue('maintenance_last_auto_backup_filename', backup.filename);
    result.backupSent = true;
    result.lastBackupAt = ranAt;
    result.nextBackupDueAt = addDaysIso(ranAt, DAILY_BACKUP_INTERVAL_DAYS);
  } catch (error: any) {
    const msg = error?.message || String(error);
    result.backupSkippedReason = `falló el envío/generación del backup: ${msg}`;
    await setAppConfigValue('maintenance_last_auto_backup_error', msg);
  }

  await setAppConfigValue('maintenance_last_run_at', ranAt);
  return result;
}

export async function getMaintenanceStatus() {
  const ping = await pingSupabaseForKeepAlive();
  const cfg = await getAppConfigMap([
    'telegram_last_chat_id',
    'telegram_last_seen_at',
    'maintenance_last_run_at',
    'maintenance_last_keepalive_at',
    'maintenance_last_keepalive_table',
    'maintenance_last_auto_backup_at',
    'maintenance_last_auto_backup_filename',
    'maintenance_last_auto_backup_error'
  ]);

  return {
    ping,
    ...cfg,
    next_auto_backup_due_at: cfg.maintenance_last_auto_backup_at
      ? addDaysIso(cfg.maintenance_last_auto_backup_at, DAILY_BACKUP_INTERVAL_DAYS)
      : 'cuando corra el próximo mantenimiento con chat registrado'
  };
}

export function formatMaintenanceStatus(status: any) {
  return [
    'Supervivencia / mantenimiento',
    '',
    `Supabase keep-alive: ${status.ping?.ok ? 'OK' : 'falló'}`,
    status.ping?.table ? `Tabla usada: ${status.ping.table}` : '',
    status.ping?.error ? `Error: ${status.ping.error}` : '',
    '',
    `Último chat registrado: ${status.telegram_last_chat_id || '-'}`,
    `Último mensaje Telegram: ${formatDateAR(status.telegram_last_seen_at)}`,
    `Última corrida cron: ${formatDateAR(status.maintenance_last_run_at)}`,
    `Último keep-alive: ${formatDateAR(status.maintenance_last_keepalive_at)}`,
    `Último backup automático: ${formatDateAR(status.maintenance_last_auto_backup_at)}`,
    `Próximo backup automático desde: ${formatDateAR(status.next_auto_backup_due_at)}`,
    status.maintenance_last_auto_backup_filename ? `Último ZIP: ${status.maintenance_last_auto_backup_filename}` : '',
    status.maintenance_last_auto_backup_error ? `Último error backup: ${status.maintenance_last_auto_backup_error}` : '',
    '',
    'Comandos:',
    '/backup estado',
    '/backup auto probar',
    '/supervivencia'
  ].filter(Boolean).join('\n');
}

export function formatMaintenanceRunResult(result: MaintenanceResult) {
  return [
    'Mantenimiento ejecutado.',
    '',
    `Keep-alive Supabase: ${result.pingOk ? 'OK' : 'falló'}`,
    result.pingTable ? `Tabla usada: ${result.pingTable}` : '',
    result.pingError ? `Error: ${result.pingError}` : '',
    `Backup enviado: ${result.backupSent ? 'sí' : 'no'}`,
    result.backupSkippedReason ? `Motivo: ${result.backupSkippedReason}` : '',
    `Último backup automático: ${formatDateAR(result.lastBackupAt)}`,
    `Próximo backup desde: ${formatDateAR(result.nextBackupDueAt)}`
  ].filter(Boolean).join('\n');
}

function isBackupDue(lastBackupAt: string | null, now: Date) {
  if (!lastBackupAt) return true;
  const last = new Date(lastBackupAt);
  if (Number.isNaN(last.getTime())) return true;
  const diffMs = now.getTime() - last.getTime();
  return diffMs >= DAILY_BACKUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
}

function addDaysIso(iso: string, days: number) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function formatDateAR(value: string | null | undefined) {
  if (!value) return '-';
  if (value === 'cuando corra el próximo mantenimiento con chat registrado') return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

async function sendTelegramDocument(chatId: number, filename: string, buffer: Buffer, caption?: string) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption.slice(0, 1000));
  form.append('document', new Blob([new Uint8Array(buffer)], { type: 'application/zip' }), filename);

  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken()}/sendDocument`, {
    method: 'POST',
    body: form
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Telegram sendDocument falló: ${res.status} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Fase 4: recordatorios proactivos de vencimiento de calibración, enganchados
// al mismo cron diario que ya corre el backup/keep-alive (ver api/cron.ts).
//
// SUPUESTO explícito (Cristian: marcar supuestos): la ventana de preaviso
// para el PUSH proactivo es de 15 días. Es un valor DISTINTO del umbral de
// 90 días que usa equipos.ts para clasificar "por vencer" en una CONSULTA
// manual (ese es un horizonte de vigilancia amplio; este es la antelación
// real del recordatorio automático, pensada para no empezar a avisar
// demasiado pronto). Ajustable si Cristian prefiere otro número.
//
// El recordatorio se envía UNA SOLA VEZ por vencimiento (no todos los días
// mientras siga vencido/por vencer): se marca con
// equipos_calibraciones.recordatorio_enviado_para = fecha_recalibracion.
// Cuando se registra una nueva calibración (resolverConfirmacionCalibracion
// en calibracionEventos.ts), ese campo se resetea a null, así que el nuevo
// vencimiento vuelve a poder recordarse cuando corresponda.
//
// Requiere la columna equipos_calibraciones.recordatorio_enviado_para (date,
// nullable) — ver SQL entregado aparte para agregarla en Supabase.
//
// Además de la info técnica (código, vencimiento, proveedor), el mensaje
// arrastra las "memorias" (notas durables) que Fase 3/4 hayan guardado sobre
// ese código de equipo (ej "no olvidar las endotoxinas"), para que resurjan
// solas junto con el aviso de vencimiento en vez de perderse.
const DIAS_PREAVISO_RECORDATORIO = 15;

export async function runCalibracionReminders(options?: { manualChatId?: number | string }) {
  const ranAt = new Date().toISOString();
  const hoy = new Date();

  const cfg = await getAppConfigMap(['telegram_last_chat_id']);
  const chatId = options?.manualChatId ? String(options.manualChatId) : (cfg.telegram_last_chat_id || null);

  const result: { ok: boolean; ranAt: string; enviados: number; chatId: string | null; skippedReason?: string } = {
    ok: true,
    ranAt,
    enviados: 0,
    chatId
  };

  if (!chatId) {
    result.skippedReason = 'sin telegram_last_chat_id; mandá cualquier mensaje al bot primero';
    return result;
  }

  const { data, error } = await supabase
    .from('equipos_calibraciones')
    .select('*')
    .not('fecha_recalibracion', 'is', null)
    .neq('estado_uso', 'fuera_de_uso_permanente');

  if (error) {
    result.ok = false;
    result.skippedReason = `error consultando equipos_calibraciones: ${error.message}`;
    return result;
  }

  const pendientes = (data || []).filter((row: any) => {
    const estado = computeEstadoVencimiento(row.fecha_recalibracion, hoy, DIAS_PREAVISO_RECORDATORIO);
    if (estado !== 'vencido' && estado !== 'por_vencer') return false;
    return row.recordatorio_enviado_para !== row.fecha_recalibracion;
  });

  if (!pendientes.length) {
    await setAppConfigValue('maintenance_last_calib_reminder_run_at', ranAt);
    return result;
  }

  const bloques: string[] = [];
  for (const row of pendientes) {
    const estado = computeEstadoVencimiento(row.fecha_recalibracion, hoy, DIAS_PREAVISO_RECORDATORIO);
    const estadoTxt = estado === 'vencido' ? 'VENCIDO' : 'por vencer';
    const subidTxt = row.subid && row.subid !== 'N.A.' ? ` (${row.subid})` : '';
    const lineas = [
      `${row.codigo}${subidTxt} - ${row.equipo || 'sin nombre'} — vence ${row.fecha_recalibracion} (${estadoTxt}) — Proveedor: ${row.proveedor || 'sin dato'}`
    ];

    try {
      const memoria = await getEquipoMemoria(row.codigo);
      for (const m of memoria.memorias) {
        lineas.push(`  Para tener en cuenta: ${m.afirmacion}`);
      }
    } catch (memError) {
      console.error(`No pude traer memoria de "${row.codigo}" para el recordatorio de calibración:`, memError);
    }

    bloques.push(lineas.join('\n'));

    try {
      await supabase
        .from('equipos_calibraciones')
        .update({ recordatorio_enviado_para: row.fecha_recalibracion })
        .eq('codigo', row.codigo)
        .eq('subid', row.subid);
    } catch (updError) {
      console.error(`No pude marcar recordatorio_enviado_para para "${row.codigo}":`, updError);
    }
  }

  const mensaje = [`Recordatorio de calibraciones (${pendientes.length}):`, '', ...bloques].join('\n\n');

  try {
    await sendTelegramText(Number(chatId), mensaje);
    result.enviados = pendientes.length;
  } catch (sendError: any) {
    result.ok = false;
    result.skippedReason = `falló el envío del recordatorio: ${sendError?.message || sendError}`;
  }

  await setAppConfigValue('maintenance_last_calib_reminder_run_at', ranAt);
  return result;
}

const TELEGRAM_CHUNK_LEN_CRON = 3800;

function splitTelegramMessageForCron(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && (current + '\n' + line).length > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegramText(chatId: number, text: string) {
  const chunks = splitTelegramMessageForCron(text, TELEGRAM_CHUNK_LEN_CRON);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : '';
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `${prefix}${chunks[i]}` })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage falló: ${res.status} ${errText} (parte ${i + 1}/${chunks.length})`);
    }
  }
}
