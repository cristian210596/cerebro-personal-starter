import { withGemini } from './geminiPool.js';
import { config } from './config.js';
import { summarizeSalaryFromText, formatSalarySummary, listSalaryReceipts, formatSalaryList, getLastSalaryReceipt, formatSalaryReceipt } from './salary.js';
import { summarizeFinanceAnalytics, formatFinanceAnalyticsReport } from './financeImport.js';
import { getLastSavedSnapshot, formatLastSaved, unifiedSearch, formatUnifiedSearch } from './chatPro.js';
import { getEquipoCompleto, formatEquipoCompleto, queryVencimientos, formatVencimientosReport } from './equipos.js';

// Router de intencion con IA: se activa cuando el texto tiene pinta de PREGUNTA
// y ningun patron/comando basado en reglas la reconocio. Antes, ese texto caia
// directo al clasificador general y se guardaba como nota/item generico — la
// causa raiz de casi todos los "esto no lo entendio" que fuimos encontrando y
// arreglando uno por uno (fix7, fix9, fix14...). Ahora, en vez de eso, Gemini
// decide a que reporte/funcion YA EXISTENTE corresponde la pregunta y con que
// argumentos llamarla (periodos normalizados a YYYY-MM, terminos de busqueda,
// etc). El calculo real (sumas, restas, filtros) lo sigue haciendo el codigo
// de siempre contra Supabase: Gemini NUNCA inventa el numero final, solo
// elige la funcion y arma los argumentos. Si no encuentra ninguna funcion que
// corresponda, el bot avisa "no entendi" en vez de guardar la pregunta como
// una nota random.

export function looksLikeQuestion(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('/')) return false;
  if (raw.length > 300) return false; // un mensaje muy largo no es una pregunta suelta
  if (/[?¿]/.test(raw)) return true;
  const t = normalize(raw);
  return /^(que|cual|cuales|cuanto|cuanta|cuantos|cuantas|como|cuando|donde|quien|quienes|hay|tengo|tenes|puedo|podes|me acuerdo|sabes|dame|decime|mostrame|contame)\b/.test(t);
}

function normalize(value: string) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function extractJsonObject(text: string) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

type RouterArgs = {
  startPeriod?: string | null;
  endPeriod?: string | null;
  concept?: string | null;
  excludeConcept?: boolean | null;
  financeTerms?: string[] | null;
  financeLabel?: string | null;
  query?: string | null;
  listFilterText?: string | null;
  equipoCodigo?: string | null;
  excludeTerms?: string[] | null;
  includeTerms?: string[] | null;
  soloEstado?: 'vencido' | 'por_vencer' | null;
};

type RouterChoice = { tool: string; args: RouterArgs };
type RouterDecision = RouterChoice | null;

// Contexto de la ultima consulta de reportes por chat, para resolver
// continuaciones en lenguaje natural ("y en marzo?", "y el total?") sin que
// el usuario tenga que repetir "horas extra"/"sueldo"/etc. cada vez. Vive en
// memoria del proceso: mientras la funcion de Vercel siga "caliente" entre
// mensajes seguidos funciona; si arranca en frio se pierde y el bot vuelve a
// preguntar en vez de adivinar mal — preferible a inventar un contexto falso.
const lastDecisionByChat = new Map<number, { decision: RouterChoice; text: string; at: number }>();
const CONTEXT_TTL_MS = 15 * 60 * 1000;

function getContext(chatId: number) {
  const entry = lastDecisionByChat.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.at > CONTEXT_TTL_MS) return null;
  return entry;
}

export async function routeQuestionWithGemini(chatId: number, text: string): Promise<RouterDecision> {
  if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY_2) return null;
  const today = new Date().toISOString().slice(0, 10);
  const context = getContext(chatId);

  const prompt = [
    `Hoy es ${today}. Un usuario le escribió esto a un bot personal de finanzas/sueldos/notas, y ningún comando ni patrón conocido lo reconoció:`,
    `"${text}"`,
    context
      ? `Justo antes, en el mismo chat, se resolvió esta consulta: función "${context.decision.tool}" con argumentos ${JSON.stringify(context.decision.args)} (texto original: "${context.text}"). Si el mensaje actual es una continuación de esa consulta (ej: "y en marzo?", "y el total?", "y en junio también"), interpretalo en base a ese contexto: mismo tipo de función, cambiando solo lo que el mensaje actual especifique distinto (normalmente el período). Si el mensaje actual es un tema nuevo sin relación, ignorá el contexto.`
      : '',
    'Decidí si la pregunta corresponde a alguna de estas funciones YA EXISTENTES del sistema, y con qué argumentos llamarla. NO inventes ni calcules ningún número vos: solo elegí la función y los argumentos, el cálculo lo hace el sistema contra la base de datos real.',
    '',
    'Funciones disponibles:',
    '- salary_report: reporte/comparación de sueldo (neto, bruto, retenciones, o un concepto puntual como "horas extra", "presentismo", "ganancias") en un rango de períodos. Args: startPeriod, endPeriod (formato "YYYY-MM", resueltos a partir de HOY si la pregunta usa "mes pasado", "marzo", "mes 3", "entre el mes 3 y el 5", etc. — si preguntan por UN solo mes, startPeriod y endPeriod son el mismo mes), concept (nombre del concepto si preguntan por uno puntual, o null si preguntan por el total/neto/bruto), excludeConcept (true si la pregunta pide el sueldo SIN/EXCLUYENDO/SACANDO ese concepto — ej "cuánto cobré sin las horas extra", "el neto sacando presentismo" — en ese caso "concept" sigue siendo el concepto a excluir; false o null si preguntan por el concepto en sí, ej "cuánto cobré DE horas extra").',
    '- salary_list: listar qué recibos de sueldo hay cargados (sin calcular nada), opcionalmente filtrado por período o texto. Args: startPeriod (si pregunta por un período puntual, si no null), listFilterText (texto libre para filtrar por empresa, o null).',
    '- salary_latest: el último recibo de sueldo cargado. Sin argumentos relevantes.',
    '- finance_report: gastos/consumos por comercio, categoría, tarjeta o medio de pago en un rango de fechas. Args: startPeriod, endPeriod ("YYYY-MM"), financeTerms (lista de palabras clave del comercio/categoría/tarjeta mencionados, ej ["visa"], ["uber"], ["supermercado"]), financeLabel (texto corto para mostrar como título, ej "tarjeta visa").',
    '- last_saved: qué fue lo último que se guardó en el sistema (cualquier tipo: nota, gasto, pendiente, etc). Sin argumentos.',
    '- search: buscar algo guardado por palabra clave, cuando no es claramente sueldo ni finanzas. Args: query (texto de búsqueda).',
    '- equipos_vencimientos: qué equipos/instrumentos de planta vencen, están vencidos, o un LISTADO de un tipo de equipo (ej "listado de dataloggers", "dataloggers vencidos", "que balanzas tengo"), opcionalmente excluyendo un tipo (ej "ignorando HVAC/manómetros" son los códigos que empiezan con MAN). Args: startPeriod, endPeriod ("YYYY-MM"; si no da período, dejar los dos null), excludeTerms (prefijos de código a excluir, ej ["MAN"], o null), includeTerms (prefijos de código a INCLUIR exclusivamente si piden un tipo puntual, ej "dataloggers" -> ["DAT"], "balanzas" -> ["BAL"], o null si no piden un tipo particular), soloEstado ("vencido" si piden solo lo ya vencido sin importar el período, "por_vencer" si piden solo lo próximo a vencer, o null).',
    '- equipo_info: qué se sabe de un equipo puntual por su código (ej "BAL-017", "EMP-001", "EST-001"): ubicación, última calibración, vencimiento, proveedor, observaciones, Y TAMBIÉN notas, fotos y hechos guardados sobre ese equipo (ej "que sabes de la EMP-001", "que tengo guardado de la EST-001"). Args: equipoCodigo (el código tal cual, sin inventar ceros ni cambiar el formato).',
    '- none: si la pregunta no corresponde a ninguna función de arriba, o falta información imposible de inferir (ni siquiera con el contexto de arriba).',
    '',
    'Devolvé SOLO JSON válido, sin markdown, con esta forma exacta:',
    '{ "tool": "salary_report"|"salary_list"|"salary_latest"|"finance_report"|"last_saved"|"search"|"equipos_vencimientos"|"equipo_info"|"none", "args": { "startPeriod": string|null, "endPeriod": string|null, "concept": string|null, "excludeConcept": boolean|null, "financeTerms": string[]|null, "financeLabel": string|null, "query": string|null, "listFilterText": string|null, "equipoCodigo": string|null, "excludeTerms": string[]|null, "includeTerms": string[]|null, "soloEstado": "vencido"|"por_vencer"|null } }'
  ].filter(Boolean).join('\n');

  try {
    const response = await withGemini(ai => ai.models.generateContent({
      model: config.geminiModel(),
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    }), { operationName: 'router de intención' });
    const jsonText = extractJsonObject(response.text || '');
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed.tool !== 'string' || parsed.tool === 'none') return null;
    const decision: RouterChoice = { tool: parsed.tool, args: parsed.args || {} };
    lastDecisionByChat.set(chatId, { decision, text, at: Date.now() });
    return decision;
  } catch (error: any) {
    console.error('No pude enrutar la pregunta con Gemini:', error?.message || error);
    return null;
  }
}

export async function executeRouterDecision(
  chatId: number,
  decision: RouterChoice,
  originalText: string,
  sendMessage: (chatId: number, text: string) => Promise<void>
): Promise<boolean> {
  const args = decision.args || {};
  try {
    switch (decision.tool) {
      case 'salary_report': {
        await sendMessage(chatId, 'Calculando reporte de sueldos...');
        const overrides = {
          startPeriod: args.startPeriod || undefined,
          endPeriod: args.endPeriod || undefined,
          concept: args.concept && String(args.concept).trim() ? String(args.concept).trim() : null,
          excludeConcept: !!args.excludeConcept
        };
        const result = await summarizeSalaryFromText(originalText, overrides);
        await sendMessage(chatId, formatSalarySummary(result));
        return true;
      }
      case 'salary_list': {
        const filterText = [args.startPeriod, args.listFilterText].filter(Boolean).join(' ');
        const rows = await listSalaryReceipts(filterText, 20);
        await sendMessage(chatId, formatSalaryList(rows, 'Sueldos cargados'));
        return true;
      }
      case 'salary_latest': {
        const row = await getLastSalaryReceipt();
        await sendMessage(chatId, formatSalaryReceipt(row));
        return true;
      }
      case 'finance_report': {
        await sendMessage(chatId, 'Calculando reporte financiero...');
        const overrides = {
          startPeriod: args.startPeriod || undefined,
          endPeriod: args.endPeriod || undefined,
          terms: args.financeTerms && args.financeTerms.length ? args.financeTerms : undefined,
          label: args.financeLabel || undefined
        };
        const report = await summarizeFinanceAnalytics(originalText, overrides);
        await sendMessage(chatId, formatFinanceAnalyticsReport(report));
        return true;
      }
      case 'last_saved': {
        const snapshot = await getLastSavedSnapshot(String(chatId));
        await sendMessage(chatId, formatLastSaved(snapshot));
        return true;
      }
      case 'search': {
        if (!args.query) return false;
        const result = await unifiedSearch(args.query);
        await sendMessage(chatId, formatUnifiedSearch(result));
        return true;
      }
      case 'equipos_vencimientos': {
        const rows = await queryVencimientos({
          startPeriod: args.startPeriod || undefined,
          endPeriod: args.endPeriod || undefined,
          excludePrefixes: args.excludeTerms && args.excludeTerms.length ? args.excludeTerms : undefined,
          includePrefixes: args.includeTerms && args.includeTerms.length ? args.includeTerms : undefined,
          soloEstado: args.soloEstado || undefined
        });
        const label = args.startPeriod ? `en ${args.startPeriod}${args.endPeriod && args.endPeriod !== args.startPeriod ? ` a ${args.endPeriod}` : ''}` : undefined;
        await sendMessage(chatId, formatVencimientosReport(rows, { label }));
        return true;
      }
      case 'equipo_info': {
        if (!args.equipoCodigo) return false;
        const data = await getEquipoCompleto(args.equipoCodigo);
        await sendMessage(chatId, formatEquipoCompleto(args.equipoCodigo, data));
        return true;
      }
      default:
        return false;
    }
  } catch (error: any) {
    console.error('No pude ejecutar la decisión del router de intención:', error?.message || error);
    await sendMessage(chatId, `No pude resolver esa consulta: ${error?.message || 'error desconocido'}`);
    return true;
  }
}
