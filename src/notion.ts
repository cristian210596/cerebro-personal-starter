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

function removeAccents(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
