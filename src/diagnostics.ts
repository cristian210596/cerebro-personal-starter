import { config } from './config.js';
import { getAppConfigMap, setAppConfigValue, supabase } from './supabaseClient.js';

const EXPECTED_TABLES = [
  'app_config',
  'items',
  'entidades',
  'item_entidades',
  'memorias',
  'archivos',
  'taxonomia',
  'finanzas_movimientos',
  'finanzas_deudas',
  'finanzas_particiones',
  'finanzas_cierres',
  'finanzas_presupuestos',
  'finanzas_importaciones',
  'finanzas_movimientos_importados',
  'finanzas_reglas_comercios',
  'finanzas_conciliaciones',
  'pendientes'
];

const CRITICAL_ENV = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY'];
const OPTIONAL_ENV = ['NOTION_TOKEN', 'NOTION_PARENT_PAGE_ID', 'NOTION_ITEMS_DATABASE_ID', 'SUPABASE_STORAGE_BUCKET'];

type Check = {
  name: string;
  ok: boolean;
  level: 'OK' | 'WARN' | 'FAIL';
  detail?: string;
};

export async function buildDiagnostics() {
  const checks: Check[] = [];

  checks.push(...checkEnv());
  checks.push(await checkTelegram());
  checks.push(...await checkTables());
  checks.push(await checkStorage());
  checks.push(await checkNotion());
  checks.push(...await checkMaintenanceState());
  checks.push(await checkLatestWrite());

  const failCount = checks.filter(c => c.level === 'FAIL').length;
  const warnCount = checks.filter(c => c.level === 'WARN').length;
  const ok = failCount === 0;
  const ranAt = new Date().toISOString();

  await safeConfig('diagnostics_last_run_at', ranAt);
  await safeConfig('diagnostics_last_result', ok ? (warnCount ? 'WARN' : 'OK') : 'FAIL');

  return { ok, ranAt, failCount, warnCount, checks };
}

function checkEnv(): Check[] {
  const checks: Check[] = [];
  for (const key of CRITICAL_ENV) {
    checks.push({
      name: `env:${key}`,
      ok: Boolean(process.env[key]?.trim()),
      level: process.env[key]?.trim() ? 'OK' : 'FAIL',
      detail: process.env[key]?.trim() ? 'configurada' : 'falta variable crítica'
    });
  }
  for (const key of OPTIONAL_ENV) {
    checks.push({
      name: `env:${key}`,
      ok: Boolean(process.env[key]?.trim()),
      level: process.env[key]?.trim() ? 'OK' : 'WARN',
      detail: process.env[key]?.trim() ? 'configurada' : 'no configurada / opcional'
    });
  }
  return checks;
}

async function checkTelegram(): Promise<Check> {
  try {
    const token = config.telegramBotToken();
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = await res.json().catch(() => null) as any;
    if (!res.ok || !json?.ok) return { name: 'telegram:getMe', ok: false, level: 'FAIL', detail: `falló ${res.status}` };
    return { name: 'telegram:getMe', ok: true, level: 'OK', detail: json.result?.username ? `@${json.result.username}` : 'activo' };
  } catch (error: any) {
    return { name: 'telegram:getMe', ok: false, level: 'FAIL', detail: error?.message || String(error) };
  }
}

async function checkTables(): Promise<Check[]> {
  const out: Check[] = [];
  for (const table of EXPECTED_TABLES) {
    try {
      const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
      if (error) throw error;
      out.push({ name: `tabla:${table}`, ok: true, level: 'OK', detail: `${count ?? 0} registros` });
    } catch (error: any) {
      out.push({ name: `tabla:${table}`, ok: false, level: isCoreTable(table) ? 'FAIL' : 'WARN', detail: error?.message || String(error) });
    }
  }
  return out;
}

function isCoreTable(table: string) {
  return ['app_config', 'items', 'entidades', 'memorias', 'archivos', 'taxonomia'].includes(table);
}

async function checkStorage(): Promise<Check> {
  try {
    const bucket = config.supabaseStorageBucket();
    const { error } = await supabase.storage.from(bucket).list('', { limit: 1 });
    if (error) throw error;
    return { name: 'storage:bucket', ok: true, level: 'OK', detail: bucket };
  } catch (error: any) {
    return { name: 'storage:bucket', ok: false, level: 'WARN', detail: error?.message || String(error) };
  }
}

async function checkNotion(): Promise<Check> {
  const token = config.notionToken();
  if (!token) return { name: 'notion:token', ok: false, level: 'WARN', detail: 'sin token; espejo Notion desactivado o incompleto' };
  try {
    const res = await fetch('https://api.notion.com/v1/users/me', {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
    });
    if (!res.ok) return { name: 'notion:users/me', ok: false, level: 'WARN', detail: `falló ${res.status}` };
    return { name: 'notion:users/me', ok: true, level: 'OK', detail: 'API responde' };
  } catch (error: any) {
    return { name: 'notion:users/me', ok: false, level: 'WARN', detail: error?.message || String(error) };
  }
}

async function checkMaintenanceState(): Promise<Check[]> {
  try {
    const cfg = await getAppConfigMap([
      'telegram_last_chat_id',
      'telegram_last_seen_at',
      'maintenance_last_run_at',
      'maintenance_last_keepalive_at',
      'maintenance_last_auto_backup_at',
      'maintenance_last_auto_backup_error'
    ]);
    return [
      { name: 'mantenimiento:chat', ok: Boolean(cfg.telegram_last_chat_id), level: cfg.telegram_last_chat_id ? 'OK' : 'WARN', detail: cfg.telegram_last_chat_id ? 'chat registrado' : 'todavía no hay chat registrado' },
      { name: 'mantenimiento:cron', ok: freshEnough(cfg.maintenance_last_run_at, 48), level: freshEnough(cfg.maintenance_last_run_at, 48) ? 'OK' : 'WARN', detail: formatAge(cfg.maintenance_last_run_at) },
      { name: 'mantenimiento:keepalive', ok: freshEnough(cfg.maintenance_last_keepalive_at, 48), level: freshEnough(cfg.maintenance_last_keepalive_at, 48) ? 'OK' : 'WARN', detail: formatAge(cfg.maintenance_last_keepalive_at) },
      { name: 'backup:auto', ok: freshEnough(cfg.maintenance_last_auto_backup_at, 8 * 24), level: freshEnough(cfg.maintenance_last_auto_backup_at, 8 * 24) ? 'OK' : 'WARN', detail: formatAge(cfg.maintenance_last_auto_backup_at) },
      { name: 'backup:error', ok: !cfg.maintenance_last_auto_backup_error, level: cfg.maintenance_last_auto_backup_error ? 'WARN' : 'OK', detail: cfg.maintenance_last_auto_backup_error || 'sin error registrado' }
    ];
  } catch (error: any) {
    return [{ name: 'mantenimiento:estado', ok: false, level: 'WARN', detail: error?.message || String(error) }];
  }
}

async function checkLatestWrite(): Promise<Check> {
  try {
    const { data, error } = await supabase.from('items').select('created_at,titulo').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!data) return { name: 'datos:ultimo_item', ok: false, level: 'WARN', detail: 'sin items' };
    return { name: 'datos:ultimo_item', ok: true, level: 'OK', detail: `${formatAge(data.created_at)} — ${data.titulo || 'sin título'}` };
  } catch (error: any) {
    return { name: 'datos:ultimo_item', ok: false, level: 'FAIL', detail: error?.message || String(error) };
  }
}

export function formatDiagnostics(diag: Awaited<ReturnType<typeof buildDiagnostics>>) {
  const status = diag.failCount ? 'FALLA' : diag.warnCount ? 'OK con avisos' : 'OK';
  const lines = ['Diagnóstico del sistema', '', `Estado general: ${status}`, `Fallos: ${diag.failCount}`, `Avisos: ${diag.warnCount}`, ''];
  for (const c of diag.checks) lines.push(`${icon(c.level)} ${c.name}: ${c.detail || (c.ok ? 'OK' : 'falló')}`);
  lines.push('', 'Notas:');
  lines.push('- RLS no se valida desde este endpoint. Si Supabase Advisor avisa RLS, corregilo en SQL Editor.');
  lines.push('- Si cron/backup figura viejo, probá /backup auto probar.');
  return lines.join('\n').slice(0, 3900);
}

export async function runSystemAutotest(chatId: number | string) {
  const stamp = new Date().toISOString();
  const tag = `AUTOTEST-${Date.now()}`;
  const cleanup: Array<() => Promise<void>> = [];
  const steps: Check[] = [];

  let itemId: string | null = null;
  let pendingId: string | null = null;
  let movementId: string | null = null;

  try {
    const { data, error } = await supabase.from('items').insert({
      fuente: 'autotest',
      telegram_chat_id: String(chatId),
      texto_original: `Prueba automática ${tag}`,
      titulo: `Prueba automática ${tag}`,
      resumen: 'Registro temporal creado por /test sistema.',
      categoria_principal: 'Sistema',
      subcategorias: ['Autotest'],
      tipo_item: 'Prueba',
      estado: 'Temporal',
      importancia: 'Baja',
      tags: ['autotest', tag.toLowerCase()],
      entidades_json: [],
      classifier_json: { autotest: true, tag }
    }).select().single();
    if (error) throw error;
    itemId = data.id;
    cleanup.push(async () => { if (itemId) await supabase.from('items').delete().eq('id', itemId); });
    steps.push({ name: 'crear item temporal', ok: true, level: 'OK', detail: data.id });
  } catch (error: any) {
    steps.push({ name: 'crear item temporal', ok: false, level: 'FAIL', detail: error?.message || String(error) });
  }

  if (itemId) {
    try {
      const { data, error } = await supabase.from('pendientes').insert({
        item_id: itemId,
        titulo: `Pendiente temporal ${tag}`,
        descripcion: 'Pendiente temporal creado por /test sistema.',
        categoria: 'Sistema',
        estado: 'abierto',
        prioridad: 'Baja',
        tags: ['autotest', tag.toLowerCase()]
      }).select().single();
      if (error) throw error;
      pendingId = data.id;
      cleanup.push(async () => { if (pendingId) await supabase.from('pendientes').delete().eq('id', pendingId); });
      steps.push({ name: 'crear pendiente temporal', ok: true, level: 'OK', detail: data.id });
    } catch (error: any) {
      steps.push({ name: 'crear pendiente temporal', ok: false, level: 'FAIL', detail: error?.message || String(error) });
    }
  }

  if (itemId) {
    try {
      const { data, error } = await supabase.from('finanzas_movimientos').insert({
        item_id: itemId,
        fecha_movimiento: stamp.slice(0, 10),
        tipo: 'ajuste',
        monto: 1,
        moneda: 'ARS',
        descripcion: `Movimiento temporal ${tag}`,
        categoria_financiera: 'Sistema',
        medio_pago: 'Autotest',
        comercio: 'Autotest',
        estado: 'temporal'
      }).select().single();
      if (error) throw error;
      movementId = data.id;
      cleanup.push(async () => { if (movementId) await supabase.from('finanzas_movimientos').delete().eq('id', movementId); });
      steps.push({ name: 'crear movimiento temporal', ok: true, level: 'OK', detail: data.id });
    } catch (error: any) {
      steps.push({ name: 'crear movimiento temporal', ok: false, level: 'WARN', detail: error?.message || String(error) });
    }
  }

  try {
    const { data, error } = await supabase.from('items').select('id,titulo').ilike('titulo', `%${tag}%`).limit(1);
    if (error) throw error;
    steps.push({ name: 'buscar item temporal', ok: Boolean(data?.length), level: data?.length ? 'OK' : 'FAIL', detail: data?.length ? 'encontrado' : 'no encontrado' });
  } catch (error: any) {
    steps.push({ name: 'buscar item temporal', ok: false, level: 'FAIL', detail: error?.message || String(error) });
  }

  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch (error: any) { steps.push({ name: 'limpieza temporal', ok: false, level: 'WARN', detail: error?.message || String(error) }); }
  }

  try {
    const { count, error } = await supabase.from('items').select('*', { count: 'exact', head: true }).ilike('titulo', `%${tag}%`);
    if (error) throw error;
    steps.push({ name: 'confirmar limpieza', ok: count === 0, level: count === 0 ? 'OK' : 'WARN', detail: `${count ?? 0} restos` });
  } catch (error: any) {
    steps.push({ name: 'confirmar limpieza', ok: false, level: 'WARN', detail: error?.message || String(error) });
  }

  const failCount = steps.filter(s => s.level === 'FAIL').length;
  const warnCount = steps.filter(s => s.level === 'WARN').length;
  await safeConfig('autotest_last_run_at', stamp);
  await safeConfig('autotest_last_result', failCount ? 'FAIL' : warnCount ? 'WARN' : 'OK');
  return { tag, ranAt: stamp, failCount, warnCount, steps };
}

export function formatSystemAutotest(result: Awaited<ReturnType<typeof runSystemAutotest>>) {
  const status = result.failCount ? 'FALLA' : result.warnCount ? 'OK con avisos' : 'OK';
  const lines = ['Autotest del sistema', '', `Estado: ${status}`, `Tag: ${result.tag}`, ''];
  for (const s of result.steps) lines.push(`${icon(s.level)} ${s.name}: ${s.detail || '-'}`);
  if (!result.failCount) lines.push('', 'La prueba creó, buscó y limpió registros temporales.');
  return lines.join('\n').slice(0, 3900);
}

export async function getOperationalLogs() {
  const cfg = await getAppConfigMap([
    'diagnostics_last_run_at',
    'diagnostics_last_result',
    'autotest_last_run_at',
    'autotest_last_result',
    'maintenance_last_run_at',
    'maintenance_last_keepalive_at',
    'maintenance_last_keepalive_error',
    'maintenance_last_auto_backup_at',
    'maintenance_last_auto_backup_filename',
    'maintenance_last_auto_backup_error',
    'telegram_last_seen_at'
  ]);
  return cfg;
}

export function formatOperationalLogs(cfg: Record<string, string>) {
  return [
    'Logs operativos',
    '',
    `Último mensaje Telegram: ${formatAge(cfg.telegram_last_seen_at)}`,
    `Último diagnóstico: ${formatAge(cfg.diagnostics_last_run_at)} — ${cfg.diagnostics_last_result || '-'}`,
    `Último autotest: ${formatAge(cfg.autotest_last_run_at)} — ${cfg.autotest_last_result || '-'}`,
    `Último cron: ${formatAge(cfg.maintenance_last_run_at)}`,
    `Último keep-alive: ${formatAge(cfg.maintenance_last_keepalive_at)}`,
    cfg.maintenance_last_keepalive_error ? `Error keep-alive: ${cfg.maintenance_last_keepalive_error}` : 'Error keep-alive: -',
    `Último backup auto: ${formatAge(cfg.maintenance_last_auto_backup_at)}`,
    cfg.maintenance_last_auto_backup_filename ? `ZIP: ${cfg.maintenance_last_auto_backup_filename}` : 'ZIP: -',
    cfg.maintenance_last_auto_backup_error ? `Error backup: ${cfg.maintenance_last_auto_backup_error}` : 'Error backup: -',
    '',
    'Para una prueba completa: /diagnostico y después /test sistema'
  ].join('\n');
}

function icon(level: Check['level']) { return level === 'OK' ? 'OK' : level === 'WARN' ? 'AVISO' : 'FALLA'; }

function freshEnough(value: string | undefined, hours: number) {
  if (!value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() <= hours * 60 * 60 * 1000;
}

function formatAge(value: string | null | undefined) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const diff = Math.max(0, Date.now() - d.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 2) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  const days = Math.floor(h / 24);
  return `hace ${days} días`;
}

async function safeConfig(key: string, value: string) {
  try { await setAppConfigValue(key, value); } catch { /* app_config puede no existir en instalaciones viejas */ }
}
