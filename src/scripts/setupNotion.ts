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

async function createDatabase(title: string, properties: any) {
  const db = await notion.databases.create({
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: title } }],
    properties
  });
  console.log(`Creada base: ${title}`);
  return db.id;
}

const categorias = [
  'Trabajo','Estudio','Compras','Cocina','Ideas / Proyectos','Salud / Cuerpo',
  'Casa / Vida diaria','Consumo cultural','Lugares','Personas','Finanzas personales','Preferencias personales'
];

const tipos = [
  'Nota','Evento','Problema','Duda técnica','Decisión','Compra','Producto deseado','Receta',
  'Resultado / experiencia','Link guardado','Aprendizaje','Preferencia','Pendiente','Documento','Prompt','Persona','Lugar'
];

const estados = ['Pendiente','Resuelto','Vigente','Revisar','Descartado','Para ver','Probado'];
const valoraciones = ['Me gustó','No me gustó','Volvería','No volvería','Útil','Dudoso','Riesgoso','Neutral'];
const importancias = ['Baja','Media','Alta'];

const itemsDatabaseId = await createDatabase('🧠 Cerebro - Items', {
  'Título': { title: {} },
  'Fecha evento': { date: {} },
  'Categoría': { select: { options: selectOptions(categorias) } },
  'Subcategorías': { multi_select: { options: [] } },
  'Tipo': { select: { options: selectOptions(tipos) } },
  'Estado': { select: { options: selectOptions(estados) } },
  'Valoración': { select: { options: selectOptions(valoraciones) } },
  'Importancia': { select: { options: selectOptions(importancias) } },
  'Tags': { multi_select: { options: [] } },
  'Resumen': { rich_text: {} },
  'Texto original': { rich_text: {} },
  'Acción futura': { rich_text: {} },
  'URL': { url: {} },
  'Fuente': { select: { options: selectOptions(['telegram','manual','web','notion']) } },
  'Entidades': { rich_text: {} },
  'Item ID Supabase': { rich_text: {} }
});

const entidadesDatabaseId = await createDatabase('🧩 Cerebro - Entidades', {
  'Nombre': { title: {} },
  'Tipo': { select: { options: selectOptions(['Equipo','Código de equipo','Marca','Modelo','Componente','Persona','Empresa','Producto','Ingrediente','Materia','Norma','Lugar','App / herramienta','Tema']) } },
  'Alias': { rich_text: {} },
  'Descripción': { rich_text: {} },
  'Categoría relacionada': { select: { options: selectOptions(categorias) } }
});

const memoriasDatabaseId = await createDatabase('🧠 Cerebro - Memorias', {
  'Afirmación': { title: {} },
  'Categoría': { select: { options: [] } },
  'Confianza': { select: { options: selectOptions(['Baja','Media','Alta']) } },
  'Vigente': { checkbox: {} },
  'Origen': { rich_text: {} },
  'Última confirmación': { date: {} }
});

const archivosDatabaseId = await createDatabase('📎 Cerebro - Archivos', {
  'Nombre': { title: {} },
  'Tipo archivo': { select: { options: selectOptions(['audio','foto','documento','video','otro']) } },
  'MIME': { rich_text: {} },
  'URL Storage': { url: {} },
  'Transcripción': { rich_text: {} },
  'Descripción IA': { rich_text: {} },
  'Item ID Supabase': { rich_text: {} }
});

const taxonomiaDatabaseId = await createDatabase('⚙️ Cerebro - Taxonomía', {
  'Valor': { title: {} },
  'Grupo': { select: { options: selectOptions(['categoria_principal','subcategoria_trabajo','tipo_item']) } },
  'Descripción': { rich_text: {} },
  'Activo': { checkbox: {} }
});

const out = {
  itemsDatabaseId,
  entidadesDatabaseId,
  memoriasDatabaseId,
  archivosDatabaseId,
  taxonomiaDatabaseId
};

fs.writeFileSync(path.resolve(process.cwd(), 'notion-databases.json'), JSON.stringify(out, null, 2));
console.log('Listo. Se guardó notion-databases.json');
