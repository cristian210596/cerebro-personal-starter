import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@notionhq/client';
import { config } from './config.js';

type NotionDbConfig = {
  itemsDatabaseId?: string;
  entidadesDatabaseId?: string;
  memoriasDatabaseId?: string;
  archivosDatabaseId?: string;
  taxonomiaDatabaseId?: string;
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

  const titulo = String(item.titulo || 'Item sin título').slice(0, 180);
  const resumen = String(item.resumen || '').slice(0, 1900);
  const textoOriginal = String(item.texto_original || '').slice(0, 1900);
  const accion = item.accion_futura ? String(item.accion_futura).slice(0, 1900) : '';
  const entidades = Array.isArray(item.entidades_json)
    ? item.entidades_json.map((e: any) => `${e.tipo}: ${e.nombre}`).join(', ').slice(0, 1900)
    : '';

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties: {
      'Título': { title: [{ text: { content: titulo } }] },
      'Fecha evento': item.fecha_evento ? { date: { start: item.fecha_evento } } : { date: null },
      'Categoría': item.categoria_principal ? { select: { name: item.categoria_principal } } : { select: null },
      'Subcategorías': { multi_select: toMultiSelect(item.subcategorias) },
      'Tipo': item.tipo_item ? { select: { name: item.tipo_item } } : { select: null },
      'Estado': item.estado ? { select: { name: item.estado } } : { select: null },
      'Valoración': item.valoracion ? { select: { name: item.valoracion } } : { select: null },
      'Importancia': item.importancia ? { select: { name: item.importancia } } : { select: null },
      'Tags': { multi_select: toMultiSelect(item.tags) },
      'Resumen': { rich_text: [{ text: { content: resumen } }] },
      'Texto original': { rich_text: [{ text: { content: textoOriginal } }] },
      'Acción futura': accion ? { rich_text: [{ text: { content: accion } }] } : { rich_text: [] },
      'URL': item.url ? { url: item.url } : { url: null },
      'Fuente': item.fuente ? { select: { name: item.fuente } } : { select: null },
      'Entidades': entidades ? { rich_text: [{ text: { content: entidades } }] } : { rich_text: [] },
      'Item ID Supabase': { rich_text: [{ text: { content: item.id } }] }
    }
  });

  return page.id;
}

function toMultiSelect(values: string[] | null | undefined) {
  if (!Array.isArray(values)) return [];
  return values.filter(Boolean).slice(0, 50).map(name => ({ name: String(name).slice(0, 100) }));
}
