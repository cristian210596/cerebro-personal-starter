import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { config } from '../config.js';

dotenv.config();

const token = config.notionToken();
const parentPageId = config.notionParentPageId();

if (!token || !parentPageId) {
  console.error('Faltan NOTION_TOKEN o NOTION_PARENT_PAGE_ID.');
  process.exit(1);
}

const notion = new Client({ auth: token });

const selectOptions = (names: string[]) => names.map(name => ({ name }));

const categorias = ['Personal', 'Laboral', 'Facultad'];
const origenes = ['manual', 'calibracion_vencimiento', 'otro'];

const db = await notion.databases.create({
  parent: { type: 'page_id', page_id: parentPageId },
  title: [{ type: 'text', text: { content: '📅 Cerebro - Calendario' } }],
  properties: {
    'Título': { title: {} },
    'Fecha': { date: {} },
    'Categoría': { select: { options: selectOptions(categorias) } },
    'Equipo': { rich_text: {} },
    'Proveedor': { rich_text: {} },
    'Notas': { rich_text: {} },
    'Origen': { select: { options: selectOptions(origenes) } }
  }
});

console.log('Creada base: 📅 Cerebro - Calendario');

const dbPath = path.resolve(process.cwd(), 'notion-databases.json');
const existing = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : {};
existing.calendarioDatabaseId = db.id;
fs.writeFileSync(dbPath, JSON.stringify(existing, null, 2));
console.log('Listo. Se agregó calendarioDatabaseId a notion-databases.json (sin tocar las demás bases).');
