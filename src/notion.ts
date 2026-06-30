import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@notionhq/client';
import { config } from './config.js';
import { getAppConfigMap, setAppConfigValue, supabase } from './supabaseClient.js';
import { createSignedFileUrl } from './storage.js';

type NotionDbConfig = {
  itemsDatabaseId?: string;
  entidadesDatabaseId?: string;
  memoriasDatabaseId?: string;
  archivosDatabaseId?: string;
  taxonomiaDatabaseId?: string;
  finanzasMovimientosDatabaseId?: string;
  finanzasDeudasDatabaseId?: string;
  finanzasParticionesDatabaseId?: string;
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

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    icon: { type: 'emoji', emoji: emojiForArchivo(archivo.tipo_archivo) },
    properties,
    children: [
      calloutBlock('📎', `Archivo guardado en Supabase Storage. Referencia interna permanente: ${archivo.storage_url || '-'}`),
      signedUrl ? paragraphBlock(`Link temporal de descarga: ${signedUrl}`) : null,
      archivo.transcripcion ? headingBlock('Transcripción') : null,
      archivo.transcripcion ? paragraphBlock(String(archivo.transcripcion).slice(0, 1900)) : null,
      archivo.descripcion_ia ? headingBlock('Descripción IA') : null,
      archivo.descripcion_ia ? paragraphBlock(String(archivo.descripcion_ia).slice(0, 1900)) : null
    ].filter(Boolean) as any
  });

  return page.id;
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
    for (const entidad of item.entidades_json) {
      if (!entidad?.tipo || !entidad?.nombre) continue;
      await createOrUpdateNotionEntidad(notion, dbConfig.entidadesDatabaseId, {
        ...entidad,
        categoria_relacionada: item.categoria_principal
      });
      entidades += 1;
    }
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

async function ensureFinanceDatabases(notion: Client) {
  const fileCfg = loadNotionDbConfig();
  let dbs: Required<Pick<NotionDbConfig, 'finanzasMovimientosDatabaseId' | 'finanzasDeudasDatabaseId' | 'finanzasParticionesDatabaseId'>> = {
    finanzasMovimientosDatabaseId: fileCfg.finanzasMovimientosDatabaseId || '',
    finanzasDeudasDatabaseId: fileCfg.finanzasDeudasDatabaseId || '',
    finanzasParticionesDatabaseId: fileCfg.finanzasParticionesDatabaseId || ''
  };

  try {
    const cfg = await getAppConfigMap([
      'notion_finanzas_movimientos_database_id',
      'notion_finanzas_deudas_database_id',
      'notion_finanzas_particiones_database_id'
    ]);
    dbs.finanzasMovimientosDatabaseId ||= cfg.notion_finanzas_movimientos_database_id || '';
    dbs.finanzasDeudasDatabaseId ||= cfg.notion_finanzas_deudas_database_id || '';
    dbs.finanzasParticionesDatabaseId ||= cfg.notion_finanzas_particiones_database_id || '';
  } catch (error) {
    console.error('No pude leer app_config para Notion finanzas. Ejecutá supabase/finance_notion.sql.', error);
    throw error;
  }

  if (dbs.finanzasMovimientosDatabaseId && dbs.finanzasDeudasDatabaseId && dbs.finanzasParticionesDatabaseId) return dbs;

  const parentPageId = config.notionParentPageId();
  if (!parentPageId) throw new Error('Falta NOTION_PARENT_PAGE_ID para crear bases financieras de Notion.');

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
  const properties = notionMovimientoProperties(row);
  if (row.notion_page_id) {
    await notion.pages.update({ page_id: row.notion_page_id, icon: { type: 'emoji', emoji: emojiForMovimiento(row.tipo) }, properties });
    return row.notion_page_id;
  }
  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    icon: { type: 'emoji', emoji: emojiForMovimiento(row.tipo) },
    properties,
    children: financeMovimientoChildren(row) as any
  });
  await supabase.from('finanzas_movimientos').update({ notion_page_id: page.id }).eq('id', row.id);
  return page.id;
}

async function createOrUpdateNotionDeuda(notion: Client, databaseId: string, row: any) {
  if (!databaseId || !row?.id) return null;
  const properties = notionDeudaProperties(row);
  if (row.notion_page_id) {
    await notion.pages.update({ page_id: row.notion_page_id, icon: { type: 'emoji', emoji: row.tipo === 'yo_debo' ? '📤' : '📥' }, properties });
    return row.notion_page_id;
  }
  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    icon: { type: 'emoji', emoji: row.tipo === 'yo_debo' ? '📤' : '📥' },
    properties,
    children: financeDebtChildren(row) as any
  });
  await supabase.from('finanzas_deudas').update({ notion_page_id: page.id }).eq('id', row.id);
  return page.id;
}

async function createOrUpdateNotionParticion(notion: Client, databaseId: string, row: any) {
  if (!databaseId || !row?.id) return null;
  const properties = notionParticionProperties(row);
  if (row.notion_page_id) {
    await notion.pages.update({ page_id: row.notion_page_id, icon: { type: 'emoji', emoji: '🍕' }, properties });
    return row.notion_page_id;
  }
  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    icon: { type: 'emoji', emoji: '🍕' },
    properties,
    children: [calloutBlock('🍕', `Parte de gasto compartido para ${row.persona || '-'}.`)] as any
  });
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
