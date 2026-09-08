import { withGemini } from './geminiPool.js';
import { config } from './config.js';
import { createNotionCalendarioPage } from './notion.js';

// Captura de eventos de calendario en lenguaje natural ("el miércoles 10
// viene ISPISA a calibrar la BAL-001"). A diferencia del router de
// intención (que solo se activa con PREGUNTAS), esto es una AFIRMACIÓN
// sobre algo que va a pasar: necesita su propio detector y su propia
// extracción con Gemini. El evento se guarda directo en Notion (base
// "Calendario"); Supabase no interviene acá porque Notion ya da la vista de
// calendario que se pidió, sin duplicar el dato en otro lado.

function norm(value: unknown) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const DIAS_SEMANA = 'lunes|martes|miercoles|jueves|viernes|sabado|domingo';
const MESES_NOMBRE = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';

export function looksLikeCalendarEventText(text: string): boolean {
  const t = norm(text);
  if (!t || t.startsWith('/')) return false;
  if (t.length > 300) return false;

  const tieneFecha = new RegExp(`\\b(${DIAS_SEMANA})\\b|\\b(${MESES_NOMBRE})\\b|\\bmanana\\b|\\bpasado manana\\b|\\bel \\d{1,2}\\b|\\b\\d{1,2}[/-]\\d{1,2}\\b`).test(t);
  if (!tieneFecha) return false;

  // Ademas de tener fecha, tiene que sonar a algo que hay que agendar (no
  // cualquier mensaje que mencione un dia de pasada).
  return /\bviene\b|\bvienen\b|\bvisita\b|\bcalibra\b|\bcalibracion\b|\brevisa\b|\bmantenimiento\b|\bservice\b|\breunion\b|\bturno\b|\bcita\b|\bentrega\b|\bagendar\b|\bagenda\b|\bexamen\b|\bparcial\b|\bfinal\b|\bclase\b/.test(t);
}

function extractJsonObject(text: string) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export type CalendarEventExtraction = {
  titulo: string;
  fecha: string | null; // YYYY-MM-DD
  categoria: 'Personal' | 'Laboral' | 'Facultad';
  equipoCodigo: string | null;
  proveedor: string | null;
  notas: string | null;
};

export async function extractCalendarEventWithGemini(text: string): Promise<CalendarEventExtraction | null> {
  if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY_2) return null;
  const today = new Date().toISOString().slice(0, 10);

  const prompt = [
    `Hoy es ${today} (formato YYYY-MM-DD). Un usuario le escribió esto a un bot personal para anotarlo en su calendario:`,
    `"${text}"`,
    'Extraé los datos del evento. NO inventes información que no está en el texto: si algo no se puede determinar, poné null.',
    '- "titulo": resumen corto del evento (ej "Calibración BAL-001 - ISPISA").',
    '- "fecha": fecha concreta del evento en formato YYYY-MM-DD, resuelta a partir de HOY si el texto dice "el miércoles 10", "mañana", "el 15", etc. Si no se puede determinar una fecha concreta, null.',
    '- "categoria": "Laboral" si menciona un código de equipo de planta, un proveedor de mantenimiento/calibración, o algo del trabajo; "Facultad" si es de la universidad (examen, parcial, clase, entrega, cursada); "Personal" en cualquier otro caso.',
    '- "equipoCodigo": el código de equipo tal cual aparece en el texto (ej "BAL-001", sin inventar ceros ni cambiar el formato), o null si no menciona ninguno.',
    '- "proveedor": nombre del proveedor/empresa que menciona (ej "ISPISA"), o null.',
    '- "notas": cualquier detalle adicional relevante del texto que no entre en los campos de arriba, o null.',
    '',
    'Devolvé SOLO JSON válido, sin markdown, con esta forma exacta:',
    '{ "titulo": string, "fecha": string|null, "categoria": "Personal"|"Laboral"|"Facultad", "equipoCodigo": string|null, "proveedor": string|null, "notas": string|null }'
  ].join('\n');

  try {
    const response = await withGemini(ai => ai.models.generateContent({
      model: config.geminiModel(),
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    }), { operationName: 'extracción de evento de calendario' });
    const jsonText = extractJsonObject(response.text || '');
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    if (!parsed || !parsed.fecha) return null; // sin fecha concreta no sirve como evento de calendario

    const categoria: CalendarEventExtraction['categoria'] =
      parsed.categoria === 'Laboral' || parsed.categoria === 'Facultad' ? parsed.categoria : 'Personal';

    return {
      titulo: String(parsed.titulo || text).slice(0, 200),
      fecha: String(parsed.fecha),
      categoria,
      equipoCodigo: parsed.equipoCodigo ? String(parsed.equipoCodigo).trim() : null,
      proveedor: parsed.proveedor ? String(parsed.proveedor).trim() : null,
      notas: parsed.notas ? String(parsed.notas).trim() : null
    };
  } catch (error: any) {
    console.error('No pude extraer evento de calendario con Gemini:', error?.message || error);
    return null;
  }
}

export async function saveCalendarEvent(evento: CalendarEventExtraction, originalText: string): Promise<string | null> {
  return createNotionCalendarioPage(evento, originalText);
}

export function formatCalendarEventSaved(evento: CalendarEventExtraction, notionPageId: string | null): string {
  const partes = [
    `Agendado: "${evento.titulo}"`,
    `Fecha: ${evento.fecha}`,
    `Categoría: ${evento.categoria}`
  ];
  if (evento.equipoCodigo) partes.push(`Equipo: ${evento.equipoCodigo}`);
  if (evento.proveedor) partes.push(`Proveedor: ${evento.proveedor}`);
  if (evento.notas) partes.push(`Notas: ${evento.notas}`);
  if (!notionPageId) partes.push('', '(No se sincronizó a Notion: revisá que exista la base "Calendario" y que hayas corrido el setup.)');
  return partes.join('\n');
}
