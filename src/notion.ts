import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@notionhq/client';
import { config } from './config.js';
import { getAppConfigMap, setAppConfigValue, supabase } from './supabaseClient.js';
import { createSignedFileUrl } from './storage.js';
import { getUnsyncedImportedMovements } from './financeImport.js';
import { isSelf, linkComprobanteEntity, linkSueldoEntity, loadEntities, resolveEntityByName, resolveIssuerEntity, resolveEntityForMovement, saveEntityLink, saveEntityNotionPage, type EntityRow } from './entityLinks.js';

type NotionDbConfig = {
  itemsDatabaseId?: string;
  entidadesDatabaseId?: string;
  memoriasDatabaseId?: string;
  archivosDatabaseId?: string;
  taxonomiaDatabaseId?: string;
  finanzasMovimientosDatabaseId?: string;
  finanzasDeudasDatabaseId?: string;
  finanzasParticionesDatabaseId?: string;
  calendarioDatabaseId?: string;
};

function notionAvailable() {
  return Boolean(config.notionToken());
}

export function getNotionClient() {
  if (!notionAvailable()) return null;
  return new Client({ auth: config.notionToken() });
}

function loadNotionDbConfig(): NotionDbConfig {
  const manual = config.notionItemsDatabaseId();
  if (manual) return { itemsDatabaseId: manual };

  const filePath = path.resolve(process.cwd(), 'notion-databases.json');
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export async function createNotionItemPage(item: any) {
  const notion = getNotionClient();
  if (!notion) return null;

  const dbConfig = loadNotionDbConfig();
  const databaseId = dbConfig.itemsDatabaseId;
  if (!databaseId) return null;

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    icon: { type: 'emoji', emoji: emojiForCategory(item.categoria_principal) },
    properties: notionItemProperties(item),
    children: notionItemChildren(item)
  });

  return page.id;
}

export async function updateNotionItemPage(item: any) {
  const notion = getNotionClient();
  if (!notion || !item.notion_page_id) return null;

  await notion.pages.update({
    page_id: item.notion_page_id,
    icon: { type: 'emoji', emoji: emojiForCategory(item.categoria_principal) },
    properties: notionItemProperties(item)
  });

  return item.notion_page_id;
}


export async function createNotionArchivoPage(archivo: any) {
  const notion = getNotionClient();
  if (!notion) return null;

  const dbConfig = loadNotionDbConfig();
  const databaseId = dbConfig.archivosDatabaseId;
  if (!databaseId) return null;

  const nombre = cleanNotionText(archivo.nombre_archivo || 'Archivo Telegram', 180) || 'Archivo Telegram';
  const signedUrl = await createSignedFileUrl(archivo.storage_url, 60 * 60 * 24 * 7);
  const properties = {
    'Nombre': { title: [{ text: { content: nombre } }] },
    'Tipo archivo': selectProp(normalizeTipoArchivo(archivo.tipo_archivo)),
    'MIME': archivo.mime_type ? { rich_text: [{ text: { content: cleanNotionText(archivo.mime_type, 300) } }] } : { rich_text: [] },
    'URL Storage': signedUrl ? { url: signedUrl } : { url: null },
    'Transcripción': archivo.transcripcion ? { rich_text: [{ text: { content: cleanNotionText(archivo.transcripcion, 1900) } }] } : { rich_text: [] },
    'Descripción IA': archivo.descripcion_ia ? { rich_text: [{ text: { content: cleanNotionText(archivo.descripcion_ia, 1900) } }] } : { rich_text: [] },
    'Item ID Supabase': archivo.item_id ? { rich_text: [{ text: { content: String(archivo.item_id).slice(0, 1900) } }] } : { rich_text: [] }
  };

  const relations = await archivoRelationProps(notion, databaseId, archivo);
  const page = await createPageWithRelations(notion, databaseId, { type: 'emoji', emoji: emojiForArchivo(archivo.tipo_archivo) }, properties, relations, [
      calloutBlock('📎', `Archivo guardado en Supabase Storage. Referencia interna permanente: ${archivo.storage_url || '-'}`),
      signedUrl ? paragraphBlock(`Link temporal de descarga: ${signedUrl}`) : null,
      archivo.transcripcion ? headingBlock('Transcripción') : null,
      archivo.transcripcion ? paragraphBlock(String(archivo.transcripcion).slice(0, 1900)) : null,
      archivo.descripcion_ia ? headingBlock('Descripción IA') : null,
      archivo.descripcion_ia ? paragraphBlock(String(archivo.descripcion_ia).slice(0, 1900)) : null
    ].filter(Boolean) as any);

  if (archivo.id) {
    const { error } = await supabase.from('archivos').update({ notion_page_id: page.id }).eq('id', archivo.id);
    if (error) console.warn('No pude guardar notion_page_id del archivo (¿falta vinculos_entidades_v2.sql?):', error.message);
  }
  return page.id;
}

export async function createNotionCalendarioPage(evento: { titulo: string; fecha: string | null; categoria: string; equipoCodigo: string | null; proveedor: string | null; notas: string | null }, textoOriginal: string) {
  const notion = getNotionClient();
  if (!notion) return null;

  const dbConfig = loadNotionDbConfig();
  const databaseId = dbConfig.calendarioDatabaseId;
  if (!databaseId) return null;

  const titulo = cleanNotionText(evento.titulo || textoOriginal, 180) || 'Evento';
  const properties = {
    'Título': { title: [{ text: { content: titulo } }] },
    'Fecha': evento.fecha ? { date: { start: evento.fecha } } : { date: null },
    'Categoría': selectProp(evento.categoria),
    'Equipo': evento.equipoCodigo ? { rich_text: [{ text: { content: cleanNotionText(evento.equipoCodigo, 100) } }] } : { rich_text: [] },
    'Proveedor': evento.proveedor ? { rich_text: [{ text: { content: cleanNotionText(evento.proveedor, 200) } }] } : { rich_text: [] },
    'Notas': evento.notas ? { rich_text: [{ text: { content: cleanNotionText(evento.notas, 1900) } }] } : { rich_text: [] },
    'Origen': selectProp('manual')
  };

  const relations = await calendarioRelationProps(notion, databaseId, evento.proveedor, evento.equipoCodigo);
  const page = await createPageWithRelations(notion, databaseId, { type: 'emoji', emoji: emojiForCalendarCategory(evento.categoria) }, properties, relations, [calloutBlock('📅', `Texto original: ${textoOriginal}`)]);

  return page.id;
}

function emojiForCalendarCategory(categoria: string | null | undefined) {
  const c = String(categoria || '').toLowerCase();
  if (c.includes('laboral')) return '💼';
  if (c.includes('facultad')) return '📚';
  return '🗓️';
}

function normalizeTipoArchivo(value: unknown) {
  const v = String(value || '').toLowerCase();
  if (v.includes('photo') || v.includes('foto') || v.includes('image')) return 'foto';
  if (v.includes('voice') || v.includes('audio')) return 'audio';
  if (v.includes('document')) return 'documento';
  return 'otro';
}

function emojiForArchivo(tipo: unknown) {
  const t = String(tipo || '').toLowerCase();
  if (t.includes('voice') || t.includes('audio')) return '🎙️';
  if (t.includes('photo') || t.includes('foto')) return '🖼️';
  if (t.includes('document')) return '📄';
  return '📎';
}

export async function syncNotionDerivedForItem(item: any) {
  const notion = getNotionClient();
  if (!notion) return { entidades: 0, memorias: 0 };

  const dbConfig = loadNotionDbConfig();
  let entidades = 0;
  let memorias = 0;

  if (dbConfig.entidadesDatabaseId && Array.isArray(item.entidades_json)) {
    entidades = await linkItemEntitiesInNotion(notion, item, dbConfig);
  }

  const memoriasSugeridas = item.classifier_json?.memorias_sugeridas || [];
  if (dbConfig.memoriasDatabaseId && Array.isArray(memoriasSugeridas)) {
    for (const memoria of memoriasSugeridas) {
      if (!memoria?.afirmacion) continue;
      await createOrUpdateNotionMemoria(notion, dbConfig.memoriasDatabaseId, {
        ...memoria,
        origen: item.id
      });
      memorias += 1;
    }
  }

  return { entidades, memorias };
}

async function createOrUpdateNotionEntidad(notion: Client, databaseId: string, entidad: any) {
  const nombre = cleanNotionText(entidad.nombre, 180);
  if (!nombre) return null;

  const properties = {
    'Nombre': { title: [{ text: { content: nombre } }] },
    'Tipo': selectProp(entidad.tipo),
    'Alias': { rich_text: [] },
    'Descripción': entidad.descripcion
      ? { rich_text: [{ text: { content: cleanNotionText(entidad.descripcion, 1900) } }] }
      : { rich_text: [] },
    'Categoría relacionada': selectProp(entidad.categoria_relacionada)
  };

  const existingPageId = await findPageByTitle(notion, databaseId, 'Nombre', nombre);

  if (existingPageId) {
    await notion.pages.update({ page_id: existingPageId, icon: { type: 'emoji', emoji: emojiForEntity(entidad.tipo) }, properties });
    return existingPageId;
  }

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    icon: { type: 'emoji', emoji: emojiForEntity(entidad.tipo) },
    properties,
    children: [
      calloutBlock('🧩', `Entidad detectada automáticamente desde Telegram.`),
      bulletBlock(`Tipo: ${entidad.tipo || '-'}`),
      bulletBlock(`Categoría relacionada: ${entidad.categoria_relacionada || '-'}`)
    ] as any
  });

  return page.id;
}

async function createOrUpdateNotionMemoria(notion: Client, databaseId: string, memoria: any) {
  const afirmacion = cleanNotionText(memoria.afirmacion, 180);
  if (!afirmacion) return null;

  const properties = {
    'Afirmación': { title: [{ text: { content: afirmacion } }] },
    'Categoría': selectProp(memoria.categoria),
    'Confianza': selectProp(memoria.confianza || 'Media'),
    'Vigente': { checkbox: true },
    'Origen': memoria.origen ? { rich_text: [{ text: { content: String(memoria.origen).slice(0, 1900) } }] } : { rich_text: [] },
    'Última confirmación': { date: { start: new Date().toISOString().slice(0, 10) } }
  };

  const existingPageId = await findPageByTitle(notion, databaseId, 'Afirmación', afirmacion);

  if (existingPageId) {
    await notion.pages.update({ page_id: existingPageId, icon: { type: 'emoji', emoji: '🧠' }, properties });
    return existingPageId;
  }

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    icon: { type: 'emoji', emoji: '🧠' },
    properties,
    children: [
      calloutBlock('🧠', afirmacion),
      bulletBlock(`Categoría: ${memoria.categoria || '-'}`),
      bulletBlock(`Confianza: ${memoria.confianza || 'Media'}`)
    ] as any
  });

  return page.id;
}

async function findPageByTitle(notion: Client, databaseId: string, property: string, equals: string) {
  const result = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property,
      title: { equals }
    },
    page_size: 1
  });

  return result.results?.[0]?.id || null;
}



export async function syncNotionFinanceResult(result: any) {
  const notion = getNotionClient();
  if (!notion || !result?.ok) return { movimientos: 0, deudas: 0, particiones: 0 };

  const dbs = await ensureFinanceDatabases(notion);
  const persisted = result.persisted || {};
  let movimientos = 0;
  let deudas = 0;
  let particiones = 0;

  if (persisted.movimiento) {
    const pageId = await createOrUpdateNotionMovimiento(notion, dbs.finanzasMovimientosDatabaseId, persisted.movimiento);
    if (pageId) movimientos += 1;
  }

  if (persisted.deuda) {
    const pageId = await createOrUpdateNotionDeuda(notion, dbs.finanzasDeudasDatabaseId, persisted.deuda);
    if (pageId) deudas += 1;
  }

  if (Array.isArray(persisted.deudasCreadas)) {
    for (const deuda of persisted.deudasCreadas) {
      const pageId = await createOrUpdateNotionDeuda(notion, dbs.finanzasDeudasDatabaseId, deuda);
      if (pageId) deudas += 1;
    }
  }

  if (persisted.pago?.applied && persisted.pago?.deuda) {
    const pageId = await createOrUpdateNotionDeuda(notion, dbs.finanzasDeudasDatabaseId, persisted.pago.deuda);
    if (pageId) deudas += 1;
  }

  if (Array.isArray(persisted.particiones)) {
    for (const particion of persisted.particiones) {
      const pageId = await createOrUpdateNotionParticion(notion, dbs.finanzasParticionesDatabaseId, particion);
      if (pageId) particiones += 1;
    }
  }

  return { movimientos, deudas, particiones };
}

export async function syncPendingImportedMovementsToNotion(): Promise<{ ok: boolean; synced: number; total: number; error?: string }> {
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

export async function syncNotionImportedMovements(movements: any[]) {
  const notion = getNotionClient();
  if (!notion || !Array.isArray(movements) || !movements.length) return { movimientos: 0 };

  const dbs = await ensureFinanceDatabases(notion);
  let movimientos = 0;
  for (const row of movements) {
    if (!row?.id) continue;
    try {
      const pageId = await createOrUpdateNotionMovimiento(notion, dbs.finanzasMovimientosDatabaseId, row);
      if (pageId) movimientos += 1;
    } catch (error) {
      console.error('No se pudo sincronizar movimiento importado a Notion:', error);
    }
  }
  return { movimientos };
}

export async function setupFinanceNotionDatabases(options: { force?: boolean } = {}) {
  const notion = getNotionClient();
  if (!notion) throw new Error('Falta NOTION_TOKEN.');
  return ensureFinanceDatabases(notion, options);
}

// Cache por proceso: antes cada sync de UN movimiento verificaba las 3 bases con 3 llamadas a
// Notion. En un lote (o en el backfill de vínculos) eso multiplicaba las llamadas sin sentido.
let financeDbsCache: { at: number; dbs: { finanzasMovimientosDatabaseId: string; finanzasDeudasDatabaseId: string; finanzasParticionesDatabaseId: string } } | null = null;

async function ensureFinanceDatabases(notion: Client, options: { force?: boolean } = {}) {
  if (!options.force && financeDbsCache && Date.now() - financeDbsCache.at < 10 * 60_000) return financeDbsCache.dbs;
  const dbs = await ensureFinanceDatabasesUncached(notion, options);
  financeDbsCache = { at: Date.now(), dbs };
  return dbs;
}

async function ensureFinanceDatabasesUncached(notion: Client, options: { force?: boolean } = {}) {
  const fileCfg = loadNotionDbConfig();
  let dbs: Required<Pick<NotionDbConfig, 'finanzasMovimientosDatabaseId' | 'finanzasDeudasDatabaseId' | 'finanzasParticionesDatabaseId'>> = {
    finanzasMovimientosDatabaseId: options.force ? '' : (fileCfg.finanzasMovimientosDatabaseId || ''),
    finanzasDeudasDatabaseId: options.force ? '' : (fileCfg.finanzasDeudasDatabaseId || ''),
    finanzasParticionesDatabaseId: options.force ? '' : (fileCfg.finanzasParticionesDatabaseId || '')
  };

  let cfg: Record<string, string> = {};
  try {
    cfg = await getAppConfigMap([
      'notion_finanzas_movimientos_database_id',
      'notion_finanzas_deudas_database_id',
      'notion_finanzas_particiones_database_id'
    ]);
  } catch (error) {
    console.error('No pude leer app_config para Notion finanzas. Ejecutá supabase/finance_notion.sql.', error);
    throw error;
  }

  if (!options.force) {
    dbs.finanzasMovimientosDatabaseId ||= cfg.notion_finanzas_movimientos_database_id || '';
    dbs.finanzasDeudasDatabaseId ||= cfg.notion_finanzas_deudas_database_id || '';
    dbs.finanzasParticionesDatabaseId ||= cfg.notion_finanzas_particiones_database_id || '';
  }

  // Validación crítica: antes se confiaba en IDs guardados en app_config/notion-databases.json.
  // Si esas bases fueron borradas o estaban mal, el setup devolvía OK pero no creaba nada nuevo.
  if (dbs.finanzasMovimientosDatabaseId && !(await notionDatabaseExists(notion, dbs.finanzasMovimientosDatabaseId))) {
    console.warn('Base de movimientos financieros no encontrada. Se recreará.');
    dbs.finanzasMovimientosDatabaseId = '';
  }
  if (dbs.finanzasDeudasDatabaseId && !(await notionDatabaseExists(notion, dbs.finanzasDeudasDatabaseId))) {
    console.warn('Base de deudas financieras no encontrada. Se recreará.');
    dbs.finanzasDeudasDatabaseId = '';
  }
  if (dbs.finanzasParticionesDatabaseId && !(await notionDatabaseExists(notion, dbs.finanzasParticionesDatabaseId))) {
    console.warn('Base de gastos compartidos no encontrada. Se recreará.');
    dbs.finanzasParticionesDatabaseId = '';
  }

  if (dbs.finanzasMovimientosDatabaseId && dbs.finanzasDeudasDatabaseId && dbs.finanzasParticionesDatabaseId) return dbs;

  const parentPageId = config.notionParentPageId();
  if (!parentPageId) throw new Error('Falta NOTION_PARENT_PAGE_ID para crear bases financieras de Notion.');

  // Validar que la integración vea la página madre antes de crear.
  try {
    await notion.pages.retrieve({ page_id: parentPageId });
  } catch (error: any) {
    throw new Error(`La integración de Notion no puede ver NOTION_PARENT_PAGE_ID (${parentPageId}). Compartí la página madre con la integración Cerebro Personal Bot. Detalle: ${error?.message || error}`);
  }

  if (!dbs.finanzasMovimientosDatabaseId) {
    dbs.finanzasMovimientosDatabaseId = await createFinanceDatabase(notion, parentPageId, '💰 Finanzas - Movimientos', financeMovementProperties());
    await setAppConfigValue('notion_finanzas_movimientos_database_id', dbs.finanzasMovimientosDatabaseId);
  }
  if (!dbs.finanzasDeudasDatabaseId) {
    dbs.finanzasDeudasDatabaseId = await createFinanceDatabase(notion, parentPageId, '🤝 Finanzas - Deudas', financeDebtProperties());
    await setAppConfigValue('notion_finanzas_deudas_database_id', dbs.finanzasDeudasDatabaseId);
  }
  if (!dbs.finanzasParticionesDatabaseId) {
    dbs.finanzasParticionesDatabaseId = await createFinanceDatabase(notion, parentPageId, '🍕 Finanzas - Gastos compartidos', financeSplitProperties());
    await setAppConfigValue('notion_finanzas_particiones_database_id', dbs.finanzasParticionesDatabaseId);
  }

  return dbs;
}

async function notionDatabaseExists(notion: Client, databaseId: string) {
  try {
    await notion.databases.retrieve({ database_id: databaseId });
    return true;
  } catch (error: any) {
    if (error?.code === 'object_not_found' || error?.status === 404) return false;
    throw error;
  }
}

async function createFinanceDatabase(notion: Client, parentPageId: string, title: string, properties: any) {
  const db = await notion.databases.create({
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: title } }],
    properties
  });
  return db.id;
}

function financeMovementProperties() {
  return {
    'Título': { title: {} },
    'Fecha': { date: {} },
    'Tipo': { select: { options: selectOptions(['gasto','ingreso','devolucion','transferencia','ajuste']) } },
    'Monto': { number: { format: 'number' } },
    'Moneda': { select: { options: selectOptions(['ARS','USD','EUR','Otro']) } },
    'Categoría': { select: { options: selectOptions(['Alimentos','Supermercado','Comida afuera','Transporte','Casa','Servicios','Salud','Farmacia','Ropa','Tecnología','Educación','Trabajo','Ocio','Regalos','Suscripciones','Impuestos','Alquiler','Auto','Transferencias','Deudas / compartidos','Ingreso laboral','Otros']) } },
    'Medio pago': { select: { options: selectOptions(['Visa crédito','Mastercard crédito','Mercado Pago','Banco Galicia','Débito','Efectivo','Transferencia','Otro']) } },
    'Tarjeta': { select: { options: selectOptions(['Visa','Mastercard','Otra']) } },
    'Banco / billetera': { select: { options: selectOptions(['Banco Galicia','Mercado Pago','Otro']) } },
    'Comercio': { rich_text: {} },
    'Cuotas': { number: { format: 'number' } },
    'Estado': { select: { options: selectOptions(['confirmado','pendiente','revisar','anulado']) } },
    'Descripción': { rich_text: {} },
    'Movimiento ID': { rich_text: {} },
    'Item ID': { rich_text: {} }
  };
}

function financeDebtProperties() {
  return {
    'Título': { title: {} },
    'Persona': { rich_text: {} },
    'Tipo': { select: { options: selectOptions(['me_debe','yo_debo']) } },
    'Monto total': { number: { format: 'number' } },
    'Monto pagado': { number: { format: 'number' } },
    'Saldo pendiente': { number: { format: 'number' } },
    'Moneda': { select: { options: selectOptions(['ARS','USD','EUR','Otro']) } },
    'Concepto': { rich_text: {} },
    'Estado': { select: { options: selectOptions(['pendiente','parcial','saldado','cancelado']) } },
    'Fecha origen': { date: {} },
    'Fecha vencimiento': { date: {} },
    'Deuda ID': { rich_text: {} },
    'Item ID': { rich_text: {} }
  };
}

function financeSplitProperties() {
  return {
    'Título': { title: {} },
    'Persona': { rich_text: {} },
    'Monto asignado': { number: { format: 'number' } },
    'Monto pagado': { number: { format: 'number' } },
    'Estado': { select: { options: selectOptions(['pendiente','pagado','parcial','cancelado']) } },
    'Movimiento ID': { rich_text: {} },
    'Partición ID': { rich_text: {} }
  };
}

async function createOrUpdateNotionMovimiento(notion: Client, databaseId: string, row: any) {
  if (!databaseId || !row?.id) return null;
  const base = notionMovimientoProperties(row);
  const relations = await movementRelationProps(notion, databaseId, row);
  const icon = { type: 'emoji', emoji: emojiForMovimiento(row.tipo) } as any;
  if (row.notion_page_id) {
    try {
      await updatePageWithRelations(notion, row.notion_page_id, icon, base, relations);
      return row.notion_page_id;
    } catch (error) {
      // Página archivada/borrada en Notion: se crea una nueva en vez de fallar para siempre.
      if (!isArchivedOrMissing(error)) throw error;
      console.warn(`La página ${row.notion_page_id} está archivada o no existe; se crea una nueva.`);
    }
  }
  const page = await createPageWithRelations(notion, databaseId, icon, base, relations, financeMovimientoChildren(row));
  await supabase.from('finanzas_movimientos').update({ notion_page_id: page.id }).eq('id', row.id);
  return page.id;
}

async function createOrUpdateNotionDeuda(notion: Client, databaseId: string, row: any) {
  if (!databaseId || !row?.id) return null;
  const base = notionDeudaProperties(row);
  const relations = await personaRelationProps(notion, databaseId, row, 'finanzas_deudas', 'Deudas');
  const icon = { type: 'emoji', emoji: row.tipo === 'yo_debo' ? '📤' : '📥' } as any;
  if (row.notion_page_id) {
    try {
      await updatePageWithRelations(notion, row.notion_page_id, icon, base, relations);
      return row.notion_page_id;
    } catch (error) {
      // Página archivada/borrada en Notion: se crea una nueva en vez de fallar para siempre.
      if (!isArchivedOrMissing(error)) throw error;
      console.warn(`La página ${row.notion_page_id} está archivada o no existe; se crea una nueva.`);
    }
  }
  const page = await createPageWithRelations(notion, databaseId, icon, base, relations, financeDebtChildren(row));
  await supabase.from('finanzas_deudas').update({ notion_page_id: page.id }).eq('id', row.id);
  return page.id;
}

async function createOrUpdateNotionParticion(notion: Client, databaseId: string, row: any) {
  if (!databaseId || !row?.id) return null;
  const base = notionParticionProperties(row);
  const relations = await personaRelationProps(notion, databaseId, row, null, 'Gastos compartidos');
  const icon = { type: 'emoji', emoji: '🍕' } as any;
  if (row.notion_page_id) {
    try {
      await updatePageWithRelations(notion, row.notion_page_id, icon, base, relations);
      return row.notion_page_id;
    } catch (error) {
      // Página archivada/borrada en Notion: se crea una nueva en vez de fallar para siempre.
      if (!isArchivedOrMissing(error)) throw error;
      console.warn(`La página ${row.notion_page_id} está archivada o no existe; se crea una nueva.`);
    }
  }
  const page = await createPageWithRelations(notion, databaseId, icon, base, relations, [calloutBlock('🍕', `Parte de gasto compartido para ${row.persona || '-'}.`)]);
  await supabase.from('finanzas_particiones').update({ notion_page_id: page.id }).eq('id', row.id);
  return page.id;
}

function notionMovimientoProperties(row: any) {
  const title = `${labelMovimiento(row.tipo)} ${moneyText(row.monto)}${row.comercio ? ` - ${row.comercio}` : ''}`.slice(0, 180);
  return {
    'Título': { title: [{ text: { content: title || 'Movimiento financiero' } }] },
    'Fecha': row.fecha_movimiento ? { date: { start: row.fecha_movimiento } } : { date: null },
    'Tipo': selectProp(row.tipo),
    'Monto': { number: Number(row.monto || 0) },
    'Moneda': selectProp(row.moneda || 'ARS'),
    'Categoría': selectProp(row.categoria_financiera),
    'Medio pago': selectProp(row.medio_pago),
    'Tarjeta': selectProp(row.tarjeta),
    'Banco / billetera': selectProp(row.banco_billetera),
    'Comercio': richTextProp(row.comercio),
    'Cuotas': row.cuotas ? { number: Number(row.cuotas) } : { number: null },
    'Estado': selectProp(row.estado || 'confirmado'),
    'Descripción': richTextProp(row.descripcion),
    'Movimiento ID': richTextProp(row.id),
    'Item ID': richTextProp(row.item_id)
  };
}

function notionDeudaProperties(row: any) {
  const label = row.tipo === 'yo_debo' ? `Yo debo a ${row.persona}` : `${row.persona} me debe`;
  const title = `${label} ${moneyText(row.saldo_pendiente || row.monto_total)} - ${row.concepto || ''}`.slice(0, 180);
  return {
    'Título': { title: [{ text: { content: title || 'Deuda' } }] },
    'Persona': richTextProp(row.persona),
    'Tipo': selectProp(row.tipo),
    'Monto total': { number: Number(row.monto_total || 0) },
    'Monto pagado': { number: Number(row.monto_pagado || 0) },
    'Saldo pendiente': { number: Number(row.saldo_pendiente || 0) },
    'Moneda': selectProp(row.moneda || 'ARS'),
    'Concepto': richTextProp(row.concepto),
    'Estado': selectProp(row.estado),
    'Fecha origen': row.fecha_origen ? { date: { start: row.fecha_origen } } : { date: null },
    'Fecha vencimiento': row.fecha_vencimiento ? { date: { start: row.fecha_vencimiento } } : { date: null },
    'Deuda ID': richTextProp(row.id),
    'Item ID': richTextProp(row.item_id)
  };
}

function notionParticionProperties(row: any) {
  const title = `${row.persona || 'Persona'} - ${moneyText(row.monto_asignado)} ${row.estado || ''}`.slice(0, 180);
  return {
    'Título': { title: [{ text: { content: title || 'Gasto compartido' } }] },
    'Persona': richTextProp(row.persona),
    'Monto asignado': { number: Number(row.monto_asignado || 0) },
    'Monto pagado': { number: Number(row.monto_pagado || 0) },
    'Estado': selectProp(row.estado),
    'Movimiento ID': richTextProp(row.movimiento_id),
    'Partición ID': richTextProp(row.id)
  };
}

function financeMovimientoChildren(row: any) {
  return [
    calloutBlock('💰', `${labelMovimiento(row.tipo)} por ${moneyText(row.monto)}.`),
    headingBlock('Datos'),
    bulletBlock(`Categoría: ${row.categoria_financiera || '-'}`),
    bulletBlock(`Medio de pago: ${row.medio_pago || '-'}`),
    bulletBlock(`Comercio/persona: ${row.comercio || '-'}`),
    bulletBlock(`Descripción: ${row.descripcion || '-'}`)
  ];
}

function financeDebtChildren(row: any) {
  const label = row.tipo === 'yo_debo' ? `Yo debo a ${row.persona}` : `${row.persona} me debe`;
  return [
    calloutBlock(row.tipo === 'yo_debo' ? '📤' : '📥', `${label}: saldo pendiente ${moneyText(row.saldo_pendiente)}.`),
    headingBlock('Datos'),
    bulletBlock(`Monto total: ${moneyText(row.monto_total)}`),
    bulletBlock(`Monto pagado: ${moneyText(row.monto_pagado)}`),
    bulletBlock(`Concepto: ${row.concepto || '-'}`),
    bulletBlock(`Estado: ${row.estado || '-'}`)
  ];
}

function selectOptions(names: string[]) {
  return names.map(name => ({ name }));
}

function richTextProp(value: unknown) {
  const text = cleanNotionText(value, 1900);
  return text ? { rich_text: [{ text: { content: text } }] } : { rich_text: [] };
}

function labelMovimiento(tipo: string | null | undefined) {
  const t = String(tipo || '').toLowerCase();
  if (t === 'gasto') return 'Gasto';
  if (t === 'ingreso') return 'Ingreso';
  if (t === 'devolucion') return 'Devolución';
  if (t === 'transferencia') return 'Transferencia';
  if (t === 'ajuste') return 'Ajuste';
  return 'Movimiento';
}

function emojiForMovimiento(tipo: string | null | undefined) {
  const t = String(tipo || '').toLowerCase();
  if (t === 'gasto') return '💸';
  if (t === 'ingreso') return '💰';
  if (t === 'devolucion') return '↩️';
  if (t === 'transferencia') return '🔁';
  return '💳';
}

function moneyText(value: unknown) {
  const n = Number(value || 0);
  return `$${Math.round(n).toLocaleString('es-AR')}`;
}

function notionItemProperties(item: any) {
  const titulo = String(item.titulo || 'Item sin título').slice(0, 180);
  const resumen = String(item.resumen || '').slice(0, 1900);
  const textoOriginal = String(item.texto_original || '').slice(0, 1900);
  const accion = item.accion_futura ? String(item.accion_futura).slice(0, 1900) : '';
  const entidades = entidadesText(item).slice(0, 1900);

  return {
    'Título': { title: [{ text: { content: titulo } }] },
    'Fecha evento': item.fecha_evento ? { date: { start: item.fecha_evento } } : { date: null },
    'Categoría': selectProp(item.categoria_principal),
    'Subcategorías': { multi_select: toMultiSelect(item.subcategorias) },
    'Tipo': selectProp(item.tipo_item),
    'Estado': selectProp(item.estado),
    'Valoración': selectProp(normalizeValoracion(item.valoracion)),
    'Importancia': selectProp(item.importancia),
    'Tags': { multi_select: toMultiSelect(item.tags) },
    'Resumen': { rich_text: resumen ? [{ text: { content: resumen } }] : [] },
    'Texto original': { rich_text: textoOriginal ? [{ text: { content: textoOriginal } }] : [] },
    'Acción futura': accion ? { rich_text: [{ text: { content: accion } }] } : { rich_text: [] },
    'URL': item.url ? { url: item.url } : { url: null },
    'Fuente': selectProp(item.fuente),
    'Entidades': entidades ? { rich_text: [{ text: { content: entidades } }] } : { rich_text: [] },
    'Item ID Supabase': { rich_text: [{ text: { content: item.id } }] }
  };
}

function selectProp(value: unknown) {
  const name = cleanNotionOptionName(value);
  return name ? { select: { name } } : { select: null };
}

function notionItemChildren(item: any): any[] {
  const blocks: any[] = [];
  const resumen = String(item.resumen || '').slice(0, 1900);
  const original = String(item.texto_original || '').slice(0, 1900);
  const accion = item.accion_futura ? String(item.accion_futura).slice(0, 1900) : '';
  const tags = Array.isArray(item.tags) && item.tags.length ? item.tags.join(', ') : '-';
  const subcats = Array.isArray(item.subcategorias) && item.subcategorias.length ? item.subcategorias.join(', ') : '-';
  const entidades = entidadesText(item) || '-';

  if (resumen) blocks.push(calloutBlock('🧾', resumen));

  blocks.push(headingBlock('Datos'));
  blocks.push(bulletBlock(`Categoría: ${item.categoria_principal || '-'}`));
  blocks.push(bulletBlock(`Subcategorías: ${subcats}`));
  blocks.push(bulletBlock(`Tipo: ${item.tipo_item || '-'}`));
  blocks.push(bulletBlock(`Estado: ${item.estado || '-'}`));
  blocks.push(bulletBlock(`Valoración: ${item.valoracion || '-'}`));
  blocks.push(bulletBlock(`Importancia: ${item.importancia || '-'}`));
  blocks.push(bulletBlock(`Tags: ${tags}`));
  blocks.push(bulletBlock(`Entidades: ${entidades}`));

  if (accion) blocks.push(calloutBlock('🎯', `Acción futura: ${accion}`));

  if (original) {
    blocks.push(headingBlock('Texto original'));
    blocks.push(paragraphBlock(original));
  }

  return blocks;
}

function emojiForCategory(category: string | null | undefined) {
  const c = String(category || '').toLowerCase();
  if (c.includes('trabajo')) return '💼';
  if (c.includes('estudio')) return '📚';
  if (c.includes('compra')) return '🛒';
  if (c.includes('cocina')) return '🍝';
  if (c.includes('proyecto') || c.includes('ideas')) return '🧩';
  if (c.includes('salud')) return '🩺';
  if (c.includes('casa')) return '🏠';
  if (c.includes('cultural')) return '🎬';
  if (c.includes('lugar')) return '📍';
  if (c.includes('persona')) return '👤';
  if (c.includes('finanzas')) return '💸';
  if (c.includes('preferencia')) return '⭐';
  return '🧠';
}

function emojiForEntity(tipo: string | null | undefined) {
  const t = String(tipo || '').toLowerCase();
  if (t.includes('equipo')) return '⚙️';
  if (t.includes('marca') || t.includes('modelo')) return '🏷️';
  if (t.includes('persona')) return '👤';
  if (t.includes('producto')) return '🛒';
  if (t.includes('ingrediente')) return '🥘';
  if (t.includes('materia')) return '📚';
  if (t.includes('norma')) return '📘';
  if (t.includes('lugar')) return '📍';
  if (t.includes('app') || t.includes('herramienta')) return '🧰';
  return '🧩';
}

function entidadesText(item: any) {
  return Array.isArray(item.entidades_json)
    ? item.entidades_json.map((e: any) => `${e.tipo}: ${e.nombre}`).join(', ')
    : '';
}

function paragraphBlock(text: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] }
  };
}

function headingBlock(text: string) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] }
  };
}

function bulletBlock(text: string) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] }
  };
}

function calloutBlock(emoji: string, text: string) {
  return {
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji },
      rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }]
    }
  };
}

function toMultiSelect(values: string[] | null | undefined) {
  if (!Array.isArray(values)) return [];

  const cleanValues = values
    .flatMap(value => String(value || '').split(/[;,]/g))
    .map(cleanNotionOptionName)
    .filter(Boolean) as string[];

  return [...new Set(cleanValues)].slice(0, 50).map(name => ({ name }));
}

function normalizeValoracion(value: unknown) {
  const original = String(value || '').trim();
  if (!original) return '';

  const lower = removeAccents(original).toLowerCase();

  if (lower.includes('no volver')) return 'No volvería';
  if (lower.includes('volver')) return 'Volvería';
  if (lower.includes('no me gusto') || lower.includes('no me gust')) return 'No me gustó';
  if (lower.includes('me gusto') || lower.includes('me gust')) return 'Me gustó';
  if (lower.includes('util')) return 'Útil';
  if (lower.includes('dudoso')) return 'Dudoso';
  if (lower.includes('riesgoso')) return 'Riesgoso';
  if (lower.includes('neutral')) return 'Neutral';

  return original;
}

function cleanNotionOptionName(value: unknown) {
  const text = String(value || '')
    .trim()
    .replace(/,/g, ' -')
    .replace(/\s+/g, ' ')
    .slice(0, 100)
    .trim();

  return text || null;
}

function cleanNotionText(value: unknown, max = 1900) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max).trim();
}

function removeAccents(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}


// ===================== Vínculos con entidades (relaciones de Notion) =====================
//
// Cada movimiento, deuda, gasto compartido e item queda vinculado con su página en la base
// "Entidades" mediante una relación de Notion de doble vía. Así la página de una persona o
// comercio (ej: "Daniel Daverio") muestra sola todos sus movimientos, deudas y mails.
// Las propiedades de relación se crean solas la primera vez (no hace falta tocar Notion).

const relationReady = new Map<string, boolean>();

async function ensureRelationProperty(notion: Client, dbId: string, prop: string, targetDbId: string, syncedName: string): Promise<boolean> {
  const key = `${dbId}:${prop}`;
  if (relationReady.has(key)) return relationReady.get(key)!;
  try {
    const db: any = await notion.databases.retrieve({ database_id: dbId });
    const existing = db.properties?.[prop];
    if (existing) {
      const ok = existing.type === 'relation';
      if (!ok) console.warn(`La propiedad "${prop}" existe en Notion pero no es una relación; no se vincula.`);
      relationReady.set(key, ok);
      return ok;
    }
    await notion.databases.update({
      database_id: dbId,
      properties: { [prop]: { relation: { database_id: targetDbId, type: 'dual_property', dual_property: {} } } }
    } as any);
    // Renombrar la propiedad espejo que Notion crea en la base destino ("Related to ...").
    try {
      const after: any = await notion.databases.retrieve({ database_id: dbId });
      const synced = after.properties?.[prop]?.relation?.dual_property?.synced_property_name;
      if (synced && synced !== syncedName) {
        await notion.databases.update({ database_id: targetDbId, properties: { [synced]: { name: syncedName } } } as any);
      }
    } catch (renameError) {
      console.warn(`No pude renombrar la relación espejo a "${syncedName}" (no es grave):`, renameError);
    }
    relationReady.set(key, true);
    return true;
  } catch (error) {
    console.error(`No pude crear la relación "${prop}" en Notion:`, error);
    relationReady.set(key, false);
    return false;
  }
}

async function notionPageForEntity(notion: Client, entity: EntityRow, entidadesDbId: string): Promise<string | null> {
  if (entity.notion_page_id) return entity.notion_page_id;
  const nombre = cleanNotionText(entity.nombre, 180);
  if (!nombre) return null;
  let pageId = await findPageByTitle(notion, entidadesDbId, 'Nombre', nombre);
  if (!pageId) {
    const page = await notion.pages.create({
      parent: { database_id: entidadesDbId },
      icon: { type: 'emoji', emoji: emojiForEntity(entity.tipo) },
      properties: {
        'Nombre': { title: [{ text: { content: nombre } }] },
        'Tipo': selectProp(entity.tipo),
        'Alias': richTextProp((entity.alias || []).join(', ')),
        'Categoría relacionada': selectProp(entity.categoria_relacionada)
      } as any,
      children: [calloutBlock('🧩', 'Entidad creada automáticamente por Cerebro al vincular movimientos/mails.')] as any
    });
    pageId = page.id;
  }
  entity.notion_page_id = pageId;
  await saveEntityNotionPage(entity.id, pageId);
  return pageId;
}

async function entityById(id: string | null | undefined) {
  if (!id) return null;
  const rows = await loadEntities();
  return rows.find(r => r.id === id) || null;
}

async function movementRelationProps(notion: Client, movimientosDbId: string, row: any): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  try {
    const cfg = loadNotionDbConfig();
    if (cfg.entidadesDatabaseId && await ensureRelationProperty(notion, movimientosDbId, 'Entidad', cfg.entidadesDatabaseId, 'Movimientos')) {
      // Si ya tiene entidad asignada en Supabase (fuente de verdad) se respeta; si no, se resuelve.
      let entity = await entityById(row.entidad_id);
      if (!entity) {
        const res = await resolveEntityForMovement(row);
        entity = res?.entity || null;
        if (entity) await saveEntityLink('finanzas_movimientos', row.id, entity.id);
      }
      if (entity) {
        const pageId = await notionPageForEntity(notion, entity, cfg.entidadesDatabaseId);
        if (pageId) out['Entidad'] = { relation: [{ id: pageId }] };
      }
    }
    if (row.importacion_id && cfg.archivosDatabaseId) {
      const archivoPage = await resumenPageForImport(row.importacion_id);
      if (archivoPage && await ensureRelationProperty(notion, movimientosDbId, 'Resumen', cfg.archivosDatabaseId, 'Movimientos del resumen')) {
        out['Resumen'] = { relation: [{ id: archivoPage }] };
      }
    }
    if (row.item_id && cfg.itemsDatabaseId && await ensureRelationProperty(notion, movimientosDbId, 'Item origen', cfg.itemsDatabaseId, 'Movimientos')) {
      const { data } = await supabase.from('items').select('notion_page_id').eq('id', row.item_id).maybeSingle();
      if (data?.notion_page_id) out['Item origen'] = { relation: [{ id: data.notion_page_id }] };
    }
  } catch (error) {
    console.error('No pude vincular el movimiento con su entidad/item:', error);
  }
  return out;
}

async function personaRelationProps(notion: Client, dbId: string, row: any, table: 'finanzas_deudas' | null, syncedName: string): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  try {
    const cfg = loadNotionDbConfig();
    if (!row?.persona || !cfg.entidadesDatabaseId) return out;
    if (!(await ensureRelationProperty(notion, dbId, 'Entidad', cfg.entidadesDatabaseId, syncedName))) return out;
    let entity = await entityById(row.entidad_id);
    if (!entity) {
      const res = await resolveEntityByName(row.persona, { tipo: 'Persona' });
      entity = res?.entity || null;
      if (entity && table) await saveEntityLink(table, row.id, entity.id);
    }
    if (entity) {
      const pageId = await notionPageForEntity(notion, entity, cfg.entidadesDatabaseId);
      if (pageId) out['Entidad'] = { relation: [{ id: pageId }] };
    }
  } catch (error) {
    console.error('No pude vincular la persona con su entidad:', error);
  }
  return out;
}

// Si la relación falla (página de entidad borrada, permisos, etc.) no se pierde la
// actualización principal: se reintenta sin relaciones.
class PageGoneError extends Error {}
function isArchivedOrMissing(error: any) { return error instanceof PageGoneError; }

// Distingue "la página a actualizar está archivada/borrada" de "falló una relación".
async function pageIsGone(notion: Client, pageId: string) {
  try {
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    return Boolean(page?.archived || page?.in_trash);
  } catch (error: any) {
    return error?.code === 'object_not_found' || error?.status === 404;
  }
}

async function updatePageWithRelations(notion: Client, pageId: string, icon: any, base: any, relations: Record<string, any>) {
  try {
    await notion.pages.update({ page_id: pageId, icon, properties: { ...base, ...relations } as any });
  } catch (error) {
    if (await pageIsGone(notion, pageId)) throw new PageGoneError(String((error as any)?.message || error));
    if (!Object.keys(relations).length) throw error;
    console.warn('Falló la actualización con relaciones; reintento sin relaciones:', (error as any)?.message || error);
    await notion.pages.update({ page_id: pageId, icon, properties: base });
  }
}

async function createPageWithRelations(notion: Client, databaseId: string, icon: any, base: any, relations: Record<string, any>, children: any[]) {
  try {
    return await notion.pages.create({ parent: { database_id: databaseId }, icon, properties: { ...base, ...relations } as any, children: children as any });
  } catch (error) {
    if (!Object.keys(relations).length) throw error;
    console.warn('Falló la creación con relaciones; reintento sin relaciones:', error);
    return await notion.pages.create({ parent: { database_id: databaseId }, icon, properties: base, children: children as any });
  }
}

export async function linkItemEntitiesInNotion(notion: Client, item: any, dbConfig: NotionDbConfig = loadNotionDbConfig()): Promise<number> {
  if (!dbConfig.entidadesDatabaseId || !Array.isArray(item?.entidades_json)) return 0;
  const pageIds: string[] = [];
  for (const entidad of item.entidades_json) {
    if (!entidad?.nombre || isSelf(entidad.nombre)) continue;
    try {
      const res = await resolveEntityByName(entidad.nombre, { tipo: entidad.tipo || null, categoria: item.categoria_principal || null });
      if (!res) continue;
      const pageId = await notionPageForEntity(notion, res.entity, dbConfig.entidadesDatabaseId);
      if (pageId && !pageIds.includes(pageId)) pageIds.push(pageId);
    } catch (error) {
      console.error(`No pude vincular la entidad "${entidad.nombre}" del item:`, error);
    }
  }
  if (item.notion_page_id && pageIds.length && dbConfig.itemsDatabaseId &&
      await ensureRelationProperty(notion, dbConfig.itemsDatabaseId, 'Entidades vinculadas', dbConfig.entidadesDatabaseId, 'Items')) {
    try {
      await notion.pages.update({ page_id: item.notion_page_id, properties: { 'Entidades vinculadas': { relation: pageIds.map(id => ({ id })) } } as any });
    } catch (error) {
      console.error('No pude actualizar las entidades vinculadas del item en Notion:', error);
    }
  }
  return pageIds.length;
}

export async function getFinanceNotionDatabaseIds() {
  const notion = getNotionClient();
  if (!notion) return null;
  return ensureFinanceDatabases(notion);
}

export async function syncNotionDebtsAndSplits(deudas: any[], particiones: any[]) {
  const notion = getNotionClient();
  if (!notion) return { deudas: 0, particiones: 0 };
  const dbs = await ensureFinanceDatabases(notion);
  let d = 0;
  let p = 0;
  for (const row of deudas || []) {
    try { if (await createOrUpdateNotionDeuda(notion, dbs.finanzasDeudasDatabaseId, row)) d += 1; } catch (error) { console.error('No se pudo sincronizar deuda:', error); }
  }
  for (const row of particiones || []) {
    try { if (await createOrUpdateNotionParticion(notion, dbs.finanzasParticionesDatabaseId, row)) p += 1; } catch (error) { console.error('No se pudo sincronizar gasto compartido:', error); }
  }
  return { deudas: d, particiones: p };
}


// ----- Archivos y calendario -----

async function entityPagesFor(notion: Client, entities: (EntityRow | null | undefined)[], entidadesDbId: string) {
  const ids: string[] = [];
  for (const e of entities) {
    if (!e || isSelf(e.nombre)) continue;
    const pid = await notionPageForEntity(notion, e, entidadesDbId);
    if (pid && !ids.includes(pid)) ids.push(pid);
  }
  return ids;
}

async function archivoRelationProps(notion: Client, archivosDbId: string, archivo: any): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  try {
    const cfg = loadNotionDbConfig();
    const entities: (EntityRow | null)[] = [];
    let movementId: string | null = null;
    const importIds: string[] = [];

    if (archivo?.id) {
      const { data: comps } = await supabase.from('finanzas_comprobantes').select('*').eq('archivo_id', archivo.id).limit(5);
      for (const c of comps || []) { entities.push(await linkComprobanteEntity(c)); movementId ||= c.movimiento_financiero_id || null; }
      const { data: recibos } = await supabase.from('sueldos_recibos').select('*').eq('archivo_id', archivo.id).limit(5);
      for (const r of recibos || []) { entities.push(await linkSueldoEntity(r)); movementId ||= r.movimiento_financiero_id || null; }
      // Resúmenes de tarjeta / cuenta: el emisor como entidad y los movimientos del resumen.
      const { data: imps } = await supabase.from('finanzas_importaciones').select('id,proveedor,tarjeta').eq('archivo_id', archivo.id).limit(3);
      for (const imp of imps || []) {
        entities.push(await resolveIssuerEntity(imp.proveedor));
        if (imp.tarjeta) entities.push(await resolveIssuerEntity(imp.tarjeta));
        importIds.push(imp.id);
      }
    }
    if (archivo?.item_id) {
      const { data: links } = await supabase.from('item_entidades').select('entidad_id').eq('item_id', archivo.item_id);
      const all = await loadEntities();
      for (const l of links || []) entities.push(all.find(e => e.id === l.entidad_id) || null);
      if (cfg.itemsDatabaseId && await ensureRelationProperty(notion, archivosDbId, 'Item', cfg.itemsDatabaseId, 'Archivos')) {
        const { data: item } = await supabase.from('items').select('notion_page_id').eq('id', archivo.item_id).maybeSingle();
        if (item?.notion_page_id) out['Item'] = { relation: [{ id: item.notion_page_id }] };
      }
    }
    if (cfg.entidadesDatabaseId && entities.some(Boolean) && await ensureRelationProperty(notion, archivosDbId, 'Entidades', cfg.entidadesDatabaseId, 'Archivos')) {
      const ids = await entityPagesFor(notion, entities, cfg.entidadesDatabaseId);
      if (ids.length) out['Entidades'] = { relation: ids.map(id => ({ id })) };
    }
    const movPages: string[] = [];
    if (movementId) {
      const { data: mov } = await supabase.from('finanzas_movimientos').select('notion_page_id').eq('id', movementId).maybeSingle();
      if (mov?.notion_page_id) movPages.push(mov.notion_page_id);
    }
    // Los movimientos de un resumen NO se cargan acá: Notion acepta como máximo 100 páginas por
    // relación en cada actualización. Se vinculan desde cada movimiento (propiedad "Resumen"),
    // y la columna espejo "Movimientos del resumen" del archivo los muestra a todos, sin tope.
    if (movPages.length) {
      const dbs = await ensureFinanceDatabases(notion);
      if (await ensureRelationProperty(notion, archivosDbId, 'Movimiento', dbs.finanzasMovimientosDatabaseId, 'Archivos')) {
        out['Movimiento'] = { relation: movPages.slice(0, 100).map(id => ({ id })) };
      }
    }
  } catch (error) {
    console.error('No pude vincular el archivo con entidades/movimiento:', error);
  }
  return out;
}

async function calendarioRelationProps(notion: Client, calendarioDbId: string, proveedor: string | null | undefined, equipoCodigo: string | null | undefined): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  try {
    const cfg = loadNotionDbConfig();
    if (!cfg.entidadesDatabaseId || (!proveedor && !equipoCodigo)) return out;
    if (!(await ensureRelationProperty(notion, calendarioDbId, 'Entidades', cfg.entidadesDatabaseId, 'Calendario'))) return out;
    const entities: (EntityRow | null)[] = [];
    if (proveedor) entities.push((await resolveEntityByName(proveedor, { tipo: 'Empresa' }))?.entity || null);
    if (equipoCodigo) entities.push((await resolveEntityByName(equipoCodigo, { tipo: 'Equipo' }))?.entity || null);
    const ids = await entityPagesFor(notion, entities, cfg.entidadesDatabaseId);
    if (ids.length) out['Entidades'] = { relation: ids.map(id => ({ id })) };
  } catch (error) {
    console.error('No pude vincular el evento de calendario con entidades:', error);
  }
  return out;
}

// Backfill: vincula una página de Archivos ya existente (busca por notion_page_id o por título).
export async function relinkArchivoInNotion(archivo: any): Promise<boolean> {
  const notion = getNotionClient();
  const cfg = loadNotionDbConfig();
  if (!notion || !cfg.archivosDatabaseId) return false;
  let pageId: string | null = archivo.notion_page_id || null;
  if (!pageId && archivo.nombre_archivo) {
    const res: any = await notion.databases.query({ database_id: cfg.archivosDatabaseId, filter: { property: 'Nombre', title: { equals: cleanNotionText(archivo.nombre_archivo, 180) } }, page_size: 2 });
    if (res.results?.length === 1) pageId = res.results[0].id;
  }
  if (!pageId) return false;
  const relations = await archivoRelationProps(notion, cfg.archivosDatabaseId, archivo);
  if (!Object.keys(relations).length) return false;
  try {
    await notion.pages.update({ page_id: pageId, properties: relations as any });
    if (!archivo.notion_page_id && archivo.id) await supabase.from('archivos').update({ notion_page_id: pageId }).eq('id', archivo.id);
    return true;
  } catch (error) {
    console.error(`No pude vincular el archivo ${archivo.nombre_archivo}:`, (error as any)?.message || error);
    return false;
  }
}

// Backfill: vincula todas las páginas del calendario con sus entidades (proveedor y equipo).
export async function relinkCalendarioInNotion(): Promise<number> {
  const notion = getNotionClient();
  const cfg = loadNotionDbConfig();
  if (!notion || !cfg.calendarioDatabaseId) return 0;
  let cursor: string | undefined;
  let n = 0;
  do {
    const res: any = await notion.databases.query({ database_id: cfg.calendarioDatabaseId, start_cursor: cursor, page_size: 100 });
    for (const page of res.results || []) {
      const text = (p: any) => (p?.rich_text || []).map((t: any) => t.plain_text).join('').trim() || null;
      const proveedor = text(page.properties?.['Proveedor']);
      const equipo = text(page.properties?.['Equipo']);
      const relations = await calendarioRelationProps(notion, cfg.calendarioDatabaseId, proveedor, equipo);
      if (Object.keys(relations).length) {
        try { await notion.pages.update({ page_id: page.id, properties: relations as any }); n += 1; } catch (error) { console.error('No pude vincular evento:', (error as any)?.message || error); }
        await new Promise(r => setTimeout(r, 350));
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return n;
}


// importacion_id -> página de Notion del archivo del resumen (cacheado por proceso).
const resumenPageCache = new Map<string, string | null>();
async function resumenPageForImport(importacionId: string): Promise<string | null> {
  if (resumenPageCache.has(importacionId)) return resumenPageCache.get(importacionId) || null;
  let pageId: string | null = null;
  try {
    const { data: imp } = await supabase.from('finanzas_importaciones').select('archivo_id').eq('id', importacionId).maybeSingle();
    if (imp?.archivo_id) {
      const { data: arch } = await supabase.from('archivos').select('notion_page_id').eq('id', imp.archivo_id).maybeSingle();
      pageId = arch?.notion_page_id || null;
    }
  } catch { pageId = null; }
  resumenPageCache.set(importacionId, pageId);
  return pageId;
}

// ===================== Productos (historial de precios) =====================

let productosDbId: string | null = null;
async function ensureProductosDatabase(notion: Client): Promise<string> {
  if (productosDbId) return productosDbId;
  let id = '';
  try { id = (await getAppConfigMap(['notion_productos_database_id'])).notion_productos_database_id || ''; } catch { id = ''; }
  if (id && !(await notionDatabaseExists(notion, id))) id = '';
  if (!id) {
    const parentPageId = config.notionParentPageId();
    if (!parentPageId) throw new Error('Falta NOTION_PARENT_PAGE_ID para crear la base de Productos.');
    id = await createFinanceDatabase(notion, parentPageId, '🛒 Productos', {
      'Nombre': { title: {} },
      'EAN': { rich_text: {} },
      'Marca': { select: { options: [] } },
      'Categoría': { select: { options: [] } },
      'Último precio': { number: { format: 'number' } },
      'Precio mínimo': { number: { format: 'number' } },
      'Precio máximo': { number: { format: 'number' } },
      'Compras': { number: { format: 'number' } },
      'Última compra': { date: {} },
      'Último comercio': { rich_text: {} },
      'Historial': { rich_text: {} },
      'Producto ID': { rich_text: {} }
    });
    await setAppConfigValue('notion_productos_database_id', id);
  }
  productosDbId = id;
  return id;
}

function money(n: unknown) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-';
}

// Crea/actualiza en Notion los productos marcados como pendientes (notion_sync_pending).
// Se llama desde el cron diario, desde la tool sync_productos_notion y desde el backfill.
export async function syncProductosToNotion(limit = 40): Promise<{ synced: number; pending: number }> {
  const notion = getNotionClient();
  if (!notion) return { synced: 0, pending: 0 };
  const cfg = loadNotionDbConfig();
  const dbId = await ensureProductosDatabase(notion);
  const relOk = cfg.entidadesDatabaseId ? await ensureRelationProperty(notion, dbId, 'Entidades', cfg.entidadesDatabaseId, 'Productos') : false;

  const { data: products, error } = await supabase.from('productos').select('*').eq('notion_sync_pending', true).limit(limit);
  if (error) throw error;
  const entities = await loadEntities();
  let synced = 0;

  for (const p of products || []) {
    try {
      const { data: rows } = await supabase
        .from('finanzas_comprobante_items')
        .select('precio_unitario_neto, importe, descuento, cantidad, finanzas_comprobantes!inner(fecha_emision, comercio, entidad_id)')
        .eq('producto_id', p.id)
        .limit(500);
      const puntos = (rows || []).map((r: any) => ({
        fecha: r.finanzas_comprobantes?.fecha_emision || null,
        comercio: r.finanzas_comprobantes?.comercio || null,
        entidad: r.finanzas_comprobantes?.entidad_id || null,
        precio: r.precio_unitario_neto != null ? Number(r.precio_unitario_neto) : null
      })).sort((a: any, b: any) => String(a.fecha).localeCompare(String(b.fecha)));
      const precios = puntos.map((x: any) => x.precio).filter((x: any) => typeof x === 'number');
      const ultimo = puntos[puntos.length - 1];
      const historial = puntos.slice(-30).reverse().map((x: any) => `${x.fecha || '?'} · ${x.comercio || '?'} · ${money(x.precio)}`).join('\n').slice(0, 1900);

      const base: any = {
        'Nombre': { title: [{ text: { content: cleanNotionText(p.nombre, 180) || 'Producto' } }] },
        'EAN': richTextProp(p.ean),
        'Marca': selectProp(p.marca),
        'Categoría': selectProp(p.categoria),
        'Último precio': { number: precios.length ? precios[precios.length - 1] : null },
        'Precio mínimo': { number: precios.length ? Math.min(...precios) : null },
        'Precio máximo': { number: precios.length ? Math.max(...precios) : null },
        'Compras': { number: puntos.length },
        'Última compra': ultimo?.fecha ? { date: { start: ultimo.fecha } } : { date: null },
        'Último comercio': richTextProp(ultimo?.comercio || null),
        'Historial': richTextProp(historial),
        'Producto ID': richTextProp(p.id)
      };

      const relations: Record<string, any> = {};
      if (relOk && cfg.entidadesDatabaseId) {
        const ents = [...new Set([...puntos.map((x: any) => x.entidad).filter(Boolean), p.marca_entidad_id].filter(Boolean))]
          .map(id => entities.find(e => e.id === id) || null);
        const ids = await entityPagesFor(notion, ents, cfg.entidadesDatabaseId);
        if (ids.length) relations['Entidades'] = { relation: ids.slice(0, 100).map(id => ({ id })) };
      }

      const icon = { type: 'emoji', emoji: '🛒' } as any;
      let pageId: string | null = p.notion_page_id || null;
      if (pageId) {
        try { await updatePageWithRelations(notion, pageId, icon, base, relations); }
        catch (e) { if (!isArchivedOrMissing(e)) throw e; pageId = null; }
      }
      if (!pageId) {
        const page = await createPageWithRelations(notion, dbId, icon, base, relations, [calloutBlock('🛒', 'Producto del catálogo de Cerebro. El historial se actualiza solo con cada ticket.')]);
        pageId = page.id;
      }
      await supabase.from('productos').update({ notion_page_id: pageId, notion_sync_pending: false, updated_at: new Date().toISOString() }).eq('id', p.id);
      synced += 1;
      await new Promise(r => setTimeout(r, 300));
    } catch (error) {
      console.error(`No pude sincronizar el producto ${p.nombre} a Notion:`, (error as any)?.message || error);
    }
  }
  const { count } = await supabase.from('productos').select('id', { count: 'exact', head: true }).eq('notion_sync_pending', true);
  return { synced, pending: count || 0 };
}
