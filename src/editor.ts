import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config.js';
import type { EntidadClasificada } from './types.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey() });

export type ItemEditChanges = {
  titulo?: string | null;
  resumen?: string | null;
  categoria_principal?: string | null;
  subcategorias?: string[] | null;
  tipo_item?: string | null;
  estado?: string | null;
  valoracion?: string | null;
  importancia?: string | null;
  accion_futura?: string | null;
  tags?: string[] | null;
  entidades_json?: EntidadClasificada[] | null;
};

type EditResult = {
  changes: ItemEditChanges;
  explanation: string;
};

const editSchema = {
  type: Type.OBJECT,
  properties: {
    changes: {
      type: Type.OBJECT,
      properties: {
        titulo: { type: Type.STRING, nullable: true },
        resumen: { type: Type.STRING, nullable: true },
        categoria_principal: { type: Type.STRING, nullable: true },
        subcategorias: { type: Type.ARRAY, items: { type: Type.STRING }, nullable: true },
        tipo_item: { type: Type.STRING, nullable: true },
        estado: { type: Type.STRING, nullable: true },
        valoracion: { type: Type.STRING, nullable: true },
        importancia: { type: Type.STRING, nullable: true },
        accion_futura: { type: Type.STRING, nullable: true },
        tags: { type: Type.ARRAY, items: { type: Type.STRING }, nullable: true },
        entidades_json: {
          type: Type.ARRAY,
          nullable: true,
          items: {
            type: Type.OBJECT,
            properties: {
              tipo: { type: Type.STRING },
              nombre: { type: Type.STRING }
            },
            required: ['tipo', 'nombre']
          }
        }
      }
    },
    explanation: { type: Type.STRING }
  },
  required: ['changes', 'explanation']
};

const editPrompt = `
Sos el editor del cerebro personal del usuario.
Tu trabajo es interpretar una instrucción de corrección y devolver SOLO los campos que hay que modificar.

Reglas:
- No re-clasifiques todo el item si el usuario pidió un cambio puntual.
- No inventes datos nuevos.
- Si el usuario dice "no es X, es Y", reemplazá el campo afectado por Y.
- Si el usuario menciona categoría, usá categoria_principal.
- Si menciona subcategoría, usá subcategorias.
- Si menciona tags/etiquetas, usá tags y devolvé la lista completa corregida.
- Tags: minúsculas, sin espacios, con guion medio.
- Si no queda claro qué campo cambiar, devolvé changes vacío y explicá brevemente.

Categorías principales admitidas:
Trabajo; Estudio; Compras; Cocina; Ideas / Proyectos; Salud / Cuerpo; Casa / Vida diaria; Consumo cultural; Lugares; Personas; Finanzas personales; Preferencias personales.

Subcategorías frecuentes para Trabajo:
Calificaciones; Calibraciones; Validaciones; Control de Calidad; Garantía de Calidad; Equipos; Normativa; Documentos; Problemas técnicos; Automatizaciones laborales.

Tipos frecuentes:
Nota; Evento; Problema; Duda técnica; Decisión; Compra; Producto deseado; Receta; Resultado / experiencia; Link guardado; Aprendizaje; Preferencia; Pendiente; Documento; Prompt; Persona; Lugar.
`;

export async function parseEditInstruction(instruction: string, currentItem: any): Promise<EditResult> {
  const simple = tryParseSimpleEditInstruction(instruction);
  if (simple) return simple;

  const itemContext = {
    id: currentItem.id,
    titulo: currentItem.titulo,
    resumen: currentItem.resumen,
    categoria_principal: currentItem.categoria_principal,
    subcategorias: currentItem.subcategorias,
    tipo_item: currentItem.tipo_item,
    estado: currentItem.estado,
    valoracion: currentItem.valoracion,
    importancia: currentItem.importancia,
    accion_futura: currentItem.accion_futura,
    tags: currentItem.tags,
    entidades_json: currentItem.entidades_json,
    texto_original: currentItem.texto_original
  };

  let raw = '';
  try {
    const response = await ai.models.generateContent({
      model: config.geminiModel(),
      contents: `${editPrompt}

Item actual:
${JSON.stringify(itemContext, null, 2)}

Instrucción del usuario:
${instruction}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: editSchema
      }
    });
    raw = response.text || '';
  } catch (error: any) {
    if (String(error?.message || '').includes('429') || String(error?.status || '') === '429') {
      return {
        changes: {},
        explanation: 'Gemini se quedó sin cuota temporalmente. Probá con una corrección simple tipo: valoracion Volvería, estado Pendiente, tags hplc,shimadzu.'
      };
    }
    throw error;
  }

  if (!raw) throw new Error('Gemini no devolvió edición');

  const parsed = JSON.parse(raw) as EditResult;
  return {
    changes: normalizeChanges(parsed.changes || {}),
    explanation: parsed.explanation || 'Editado.'
  };
}

function normalizeChanges(changes: ItemEditChanges): ItemEditChanges {
  const out: ItemEditChanges = {};

  for (const key of [
    'titulo',
    'resumen',
    'categoria_principal',
    'tipo_item',
    'estado',
    'valoracion',
    'importancia',
    'accion_futura'
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      const value = changes[key];
      out[key] = value === null ? null : String(value || '').trim();
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'subcategorias')) {
    out.subcategorias = Array.isArray(changes.subcategorias)
      ? [...new Set(changes.subcategorias.map(v => String(v).trim()).filter(Boolean))]
      : [];
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'tags')) {
    out.tags = Array.isArray(changes.tags)
      ? [...new Set(changes.tags.map(normalizeTag).filter(Boolean))]
      : [];
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'entidades_json')) {
    out.entidades_json = Array.isArray(changes.entidades_json)
      ? changes.entidades_json
          .filter(e => e?.tipo && e?.nombre)
          .map(e => ({ tipo: String(e.tipo).trim(), nombre: String(e.nombre).trim() }))
      : [];
  }

  return out;
}


function tryParseSimpleEditInstruction(instruction: string): EditResult | null {
  const raw = instruction.trim();
  const lower = removeAccents(raw).toLowerCase();
  const changes: ItemEditChanges = {};

  const categoria = pickAfter(raw, lower, ['categoria principal', 'categoria', 'no es compra, es', 'no es compras, es']);
  if (categoria) changes.categoria_principal = normalizeKnownCategoria(categoria);

  const subcategoria = pickAfter(raw, lower, ['subcategoria', 'subcategoría']);
  if (subcategoria) changes.subcategorias = splitValues(subcategoria).map(capitalizeLoose);

  const estado = pickAfter(raw, lower, ['estado']);
  if (estado) changes.estado = capitalizeLoose(firstValue(estado));

  const importancia = pickAfter(raw, lower, ['importancia']);
  if (importancia) changes.importancia = capitalizeLoose(firstValue(importancia));

  const valoracion = pickAfter(raw, lower, ['valoracion', 'valoración']);
  if (valoracion) changes.valoracion = normalizeValoracion(firstValue(valoracion));

  const tipo = pickAfter(raw, lower, ['tipo']);
  if (tipo) changes.tipo_item = capitalizeLoose(firstValue(tipo));

  const tags = pickAfter(raw, lower, ['tags', 'etiquetas']);
  if (tags) changes.tags = splitValues(tags).map(normalizeTag).filter(Boolean);

  const accion = pickAfter(raw, lower, ['accion futura', 'acción futura', 'pendiente']);
  if (accion) changes.accion_futura = accion.trim();

  if (!Object.keys(changes).length) return null;
  return { changes: normalizeChanges(changes), explanation: 'Interpretado sin usar Gemini.' };
}

function pickAfter(raw: string, lower: string, labels: string[]) {
  for (const label of labels) {
    const idx = lower.indexOf(label);
    if (idx === -1) continue;

    let tail = raw.slice(idx + label.length).trim();
    tail = tail.replace(/^\s*[:=\-]\s*/, '').trim();

    const stop = findNextFieldIndex(tail);
    if (stop !== -1) tail = tail.slice(0, stop).trim();
    return tail;
  }
  return '';
}

function findNextFieldIndex(text: string) {
  const markers = [
    /,\s*(categoria|subcategoria|subcategoría|estado|importancia|valoracion|valoración|tipo|tags|etiquetas|accion futura|acción futura|pendiente)\b/i,
    /;\s*(categoria|subcategoria|subcategoría|estado|importancia|valoracion|valoración|tipo|tags|etiquetas|accion futura|acción futura|pendiente)\b/i
  ];
  const indexes = markers.map(r => text.search(r)).filter(i => i >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}

function firstValue(text: string) {
  return splitValues(text)[0] || text.trim();
}

function splitValues(text: string) {
  return text
    .split(/[;,]/g)
    .map(v => v.trim())
    .filter(Boolean);
}

function capitalizeLoose(text: string) {
  const t = text.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function normalizeKnownCategoria(text: string) {
  const lower = removeAccents(text).toLowerCase();
  if (lower.includes('preferencia')) return 'Preferencias personales';
  if (lower.includes('trabajo')) return 'Trabajo';
  if (lower.includes('estudio')) return 'Estudio';
  if (lower.includes('compra')) return 'Compras';
  if (lower.includes('cocina') || lower.includes('receta')) return 'Cocina';
  if (lower.includes('proyecto') || lower.includes('idea')) return 'Ideas / Proyectos';
  if (lower.includes('salud')) return 'Salud / Cuerpo';
  if (lower.includes('casa')) return 'Casa / Vida diaria';
  if (lower.includes('cultural') || lower.includes('video') || lower.includes('podcast')) return 'Consumo cultural';
  if (lower.includes('lugar')) return 'Lugares';
  if (lower.includes('persona')) return 'Personas';
  if (lower.includes('finanza') || lower.includes('gasto')) return 'Finanzas personales';
  return capitalizeLoose(text);
}

function normalizeValoracion(text: string) {
  const lower = removeAccents(text).toLowerCase();
  if (lower.includes('no volver')) return 'No volvería';
  if (lower.includes('volver')) return 'Volvería';
  if (lower.includes('no me gusto') || lower.includes('no me gust')) return 'No me gustó';
  if (lower.includes('me gusto') || lower.includes('me gust')) return 'Me gustó';
  if (lower.includes('util')) return 'Útil';
  if (lower.includes('dudoso')) return 'Dudoso';
  if (lower.includes('riesgoso')) return 'Riesgoso';
  if (lower.includes('neutral')) return 'Neutral';
  return capitalizeLoose(text);
}

function removeAccents(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeTag(tag: unknown) {
  return String(tag || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}
