import { Type } from '@google/genai';
import { config } from './config.js';
import { withGemini } from './geminiPool.js';
import { isCerebrasConfigured, withCerebras } from './cerebrasPool.js';
import type { Clasificacion } from './types.js';


const schema = {
  type: Type.OBJECT,
  properties: {
    titulo: { type: Type.STRING },
    resumen: { type: Type.STRING },
    categoria_principal: { type: Type.STRING },
    subcategorias: { type: Type.ARRAY, items: { type: Type.STRING } },
    tipo_item: { type: Type.STRING },
    estado: { type: Type.STRING, nullable: true },
    valoracion: { type: Type.STRING, nullable: true },
    importancia: { type: Type.STRING },
    accion_futura: { type: Type.STRING, nullable: true },
    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    entidades: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          tipo: { type: Type.STRING },
          nombre: { type: Type.STRING }
        },
        required: ['tipo', 'nombre']
      }
    },
    memorias_sugeridas: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          afirmacion: { type: Type.STRING },
          categoria: { type: Type.STRING },
          confianza: { type: Type.STRING }
        },
        required: ['afirmacion', 'categoria', 'confianza']
      }
    }
  },
  required: [
    'titulo',
    'resumen',
    'categoria_principal',
    'subcategorias',
    'tipo_item',
    'estado',
    'valoracion',
    'importancia',
    'accion_futura',
    'tags',
    'entidades',
    'memorias_sugeridas'
  ]
};

const systemPrompt = `
Sos el clasificador del cerebro personal del usuario.
Tu trabajo es convertir mensajes crudos en JSON útil para guardar en una base.

Reglas:
- No inventes datos.
- Si no sabés algo, dejalo vacío o null.
- La categoría principal debe ser una sola.
- Las subcategorías pueden ser varias.
- Separá categoría, tipo, entidades y tags.
- No conviertas todo en memoria estable. Solo sugerí memoria si es una preferencia, patrón, gusto, rechazo, criterio de trabajo o dato duradero.
- Si el mensaje describe una duda, problema o acción futura, estado debe ser Pendiente.
- Si ya está resuelto, estado puede ser Resuelto.
- Si es una receta o compra probada, valoracion puede ser Me gustó, No me gustó, Volvería, No volvería, Útil, Dudoso, etc.
- Tags: minúsculas, sin espacios; usar guion medio.

Categorías principales admitidas:
Trabajo; Estudio; Compras; Cocina; Ideas / Proyectos; Salud / Cuerpo; Casa / Vida diaria; Consumo cultural; Lugares; Personas; Finanzas personales; Preferencias personales.

Subcategorías frecuentes para Trabajo:
Calificaciones; Calibraciones; Validaciones; Control de Calidad; Garantía de Calidad; Equipos; Normativa; Documentos; Problemas técnicos; Automatizaciones laborales.

Tipos de item frecuentes:
Nota; Evento; Problema; Duda técnica; Decisión; Compra; Producto deseado; Receta; Resultado / experiencia; Link guardado; Aprendizaje; Preferencia; Pendiente; Documento; Prompt; Persona; Lugar.

Tipos de entidades frecuentes:
Equipo; Código de equipo; Marca; Modelo; Componente; Persona; Empresa; Producto; Ingrediente; Materia; Norma; Lugar; App / herramienta; Tema.
`;

// Cerebras JSON Schema equivalente al "schema" de arriba (formato Gemini). Se usa solo si
// CEREBRAS_API_KEY esta configurada; si falla por cualquier motivo, cae a Gemini sin romper nada.
const cerebrasSchema = {
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    resumen: { type: 'string' },
    categoria_principal: { type: 'string' },
    subcategorias: { type: 'array', items: { type: 'string' } },
    tipo_item: { type: 'string' },
    estado: { type: ['string', 'null'] },
    valoracion: { type: ['string', 'null'] },
    importancia: { type: 'string' },
    accion_futura: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    entidades: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tipo: { type: 'string' }, nombre: { type: 'string' } },
        required: ['tipo', 'nombre'],
        additionalProperties: false
      }
    },
    memorias_sugeridas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          afirmacion: { type: 'string' },
          categoria: { type: 'string' },
          confianza: { type: 'string' }
        },
        required: ['afirmacion', 'categoria', 'confianza'],
        additionalProperties: false
      }
    }
  },
  required: [
    'titulo', 'resumen', 'categoria_principal', 'subcategorias', 'tipo_item', 'estado',
    'valoracion', 'importancia', 'accion_futura', 'tags', 'entidades', 'memorias_sugeridas'
  ],
  additionalProperties: false
};

export async function classifyText(text: string): Promise<Clasificacion> {
  if (isCerebrasConfigured()) {
    try {
      return await classifyTextWithCerebras(text);
    } catch (error: any) {
      console.error('Cerebras fallo clasificando, uso Gemini como respaldo:', error?.message || error);
    }
  }
  return classifyTextWithGemini(text);
}

async function classifyTextWithGemini(text: string): Promise<Clasificacion> {
  const response = await withGemini(ai => ai.models.generateContent({
    model: config.geminiModel(),
    contents: `${systemPrompt}\n\nMensaje a clasificar:\n${text}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  }), { operationName: 'clasificación' });

  const raw = response.text;
  if (!raw) throw new Error('Gemini no devolvió texto');

  const parsed = JSON.parse(raw) as Clasificacion;
  return normalizeClassification(parsed);
}

async function classifyTextWithCerebras(text: string): Promise<Clasificacion> {
  const parsed = await withCerebras(async call => {
    const response = await call({
      model: config.cerebrasModel(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Mensaje a clasificar:\n${text}` }
      ],
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'clasificacion', strict: true, schema: cerebrasSchema }
      }
    });
    const raw = response?.choices?.[0]?.message?.content;
    if (!raw) throw new Error('Cerebras no devolvió texto');
    return JSON.parse(raw);
  }, { operationName: 'clasificación (cerebras)' });

  return normalizeClassification(parsed as Clasificacion);
}

function normalizeClassification(c: Clasificacion): Clasificacion {
  return {
    titulo: c.titulo || 'Item sin título',
    resumen: c.resumen || '',
    categoria_principal: c.categoria_principal || 'Nota',
    subcategorias: Array.isArray(c.subcategorias) ? c.subcategorias.filter(Boolean) : [],
    tipo_item: c.tipo_item || 'Nota',
    estado: c.estado || null,
    valoracion: c.valoracion || null,
    importancia: c.importancia || 'Media',
    accion_futura: c.accion_futura || null,
    tags: Array.isArray(c.tags)
      ? [...new Set(c.tags.map(t => String(t).trim().toLowerCase().replaceAll(' ', '-')).filter(Boolean))]
      : [],
    entidades: Array.isArray(c.entidades) ? c.entidades.filter(e => e.tipo && e.nombre) : [],
    memorias_sugeridas: Array.isArray(c.memorias_sugeridas) ? c.memorias_sugeridas.filter(m => m.afirmacion) : []
  };
}
