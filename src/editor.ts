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

  const response = await ai.models.generateContent({
    model: config.geminiModel(),
    contents: `${editPrompt}\n\nItem actual:\n${JSON.stringify(itemContext, null, 2)}\n\nInstrucción del usuario:\n${instruction}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: editSchema
    }
  });

  const raw = response.text;
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
