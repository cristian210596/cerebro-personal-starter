import { withGemini } from './geminiPool.js';
import { config } from './config.js';
import { supabase, saveItem, getAppConfigValue, setAppConfigValue } from './supabaseClient.js';
import { getEquipoInfo } from './equipos.js';
import type { Clasificacion, ItemInsert } from './types.js';

// Fase 4: registrar que un equipo YA se calibró ("hoy se calibró la BAL-017
// con éxito por ISPISA") y, previa confirmación de Cristian, actualizar su
// fecha de calibración/vencimiento en equipos_calibraciones (Fase 1) según
// el intervalo que YA tiene cargado en la planilla. Nunca inventa un
// intervalo: si el equipo no tiene uno cargado, pide el dato en vez de
// asumir. Si la nota menciona algo a recordar para el próximo vencimiento
// (ej "no olvidar las endotoxinas"), queda guardado como memoria durable
// LIGADA al equipo de forma determinística (sin depender de que el
// clasificador de IA decida sugerirla), para que resurja sola en el
// recordatorio de vencimiento (ver maintenance.ts: runCalibracionReminders).

function norm(value: unknown) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const PATRON_CODIGO_EQUIPO = /\b[a-z]{2,5}-\d{2,4}\b/i;

export function looksLikeCalibracionEventText(text: string): boolean {
  const t = norm(text);
  if (!t || t.startsWith('/')) return false;
  if (t.length > 300) return false;
  if (!/\bcalibr/.test(t)) return false;
  // Tiene que sonar a algo YA HECHO ("se calibró", "calibré"), no a un
  // evento futuro a agendar (eso lo agarra looksLikeCalendarEventText en
  // calendario.ts) ni a una pregunta.
  const tieneVerboPasado = /\b(se calibro|se calibró|calibre|calibré|calibramos|ya calibre|ya calibré|ya calibramos|hoy calibre|hoy calibré|hoy se calibro|hoy se calibró)\b/.test(t);
  if (!tieneVerboPasado) return false;
  return PATRON_CODIGO_EQUIPO.test(t);
}

function extractJsonObject(text: string) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

type CalibracionEventoExtraction = {
  codigo: string;
  proveedor: string | null;
  resultado: 'exitosa' | 'con_observaciones' | 'fallida';
  notas: string | null;
};

async function extractCalibracionEventoWithGemini(text: string): Promise<CalibracionEventoExtraction | null> {
  if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEYS && !process.env.GEMINI_API_KEY_2) return null;

  const prompt = [
    'Un usuario le escribió esto a un bot personal para registrar que acaba de calibrar un equipo de planta:',
    `"${text}"`,
    'Extraé los datos. NO inventes nada que no esté en el texto: si algo no se puede determinar, poné null.',
    '- "codigo": el código de equipo tal cual aparece en el texto (ej "BAL-017"), sin inventar ceros ni cambiar el formato.',
    '- "proveedor": nombre del proveedor/empresa que hizo la calibración, o null.',
    '- "resultado": "exitosa" si dice que salió bien/con éxito/aprobada; "con_observaciones" si menciona alguna observación o desvío pero no un rechazo; "fallida" si dice que no pasó/rechazada/mal.',
    '- "notas": cualquier cosa que el usuario pida recordar a futuro o cualquier detalle relevante adicional (ej "no olvidar las endotoxinas la próxima vez"), o null si no hay nada así.',
    '',
    'Devolvé SOLO JSON válido, sin markdown, con esta forma exacta:',
    '{ "codigo": string, "proveedor": string|null, "resultado": "exitosa"|"con_observaciones"|"fallida", "notas": string|null }'
  ].join('\n');

  try {
    const response = await withGemini(ai => ai.models.generateContent({
      model: config.geminiModel(),
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    }), { operationName: 'extracción de evento de calibración' });
    const jsonText = extractJsonObject(response.text || '');
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    if (!parsed || !parsed.codigo) return null;
    const resultado: CalibracionEventoExtraction['resultado'] =
      parsed.resultado === 'fallida' || parsed.resultado === 'con_observaciones' ? parsed.resultado : 'exitosa';
    return {
      codigo: String(parsed.codigo).trim(),
      proveedor: parsed.proveedor ? String(parsed.proveedor).trim() : null,
      resultado,
      notas: parsed.notas ? String(parsed.notas).trim() : null
    };
  } catch (error: any) {
    console.error('No pude extraer evento de calibración con Gemini:', error?.message || error);
    return null;
  }
}

type CalibracionPendiente = {
  chatId: number;
  codigo: string;
  subid: string;
  fechaCalibracion: string;
  fechaRecalibracionPropuesta: string;
  intervaloMeses: number;
  proveedor: string | null;
  notas: string | null;
  textoOriginal: string;
};

function pendienteKey(chatId: number) {
  return `calib_pendiente_${chatId}`;
}

// Devuelve el mensaje a enviar (pidiendo confirmación, o explicando por qué
// no se puede procesar automáticamente), o null si Gemini no pudo extraer
// nada útil del texto (en ese caso el llamador sigue el flujo normal).
export async function proponerActualizacionCalibracion(chatId: number, text: string): Promise<string | null> {
  const evento = await extractCalibracionEventoWithGemini(text);
  if (!evento) return null;

  const filas = await getEquipoInfo(evento.codigo);
  if (!filas.length) {
    return `No tengo cargado "${evento.codigo}" en la planilla de calibraciones. Si es un equipo nuevo o el código no coincide, decime bien el código o subí la planilla actualizada.`;
  }

  if (filas.length > 1) {
    const subids = filas.map((f: any) => f.subid).join(', ');
    return `"${evento.codigo}" tiene varios sub-ítems cargados (${subids}). Decime cuál calibraste puntualmente, mencionando el sub-ítem (ej "se calibró la sonda RTD-001 de AUT-002").`;
  }

  const fila = filas[0];

  if (evento.resultado !== 'exitosa') {
    return [
      `Anotado: "${evento.codigo}" tuvo una calibración ${evento.resultado === 'fallida' ? 'FALLIDA' : 'con observaciones'}.`,
      'No actualizo la fecha de vencimiento automáticamente para este caso — decime manualmente si corresponde reprogramarla, o registrala una vez resuelta.'
    ].join('\n');
  }

  if (!fila.intervalo_meses) {
    return `"${evento.codigo}" no tiene cargado un intervalo de calibración en la planilla, así que no puedo calcular el próximo vencimiento. Decime cada cuánto se calibra (ej "cada 12 meses") o actualizá la planilla con ese dato.`;
  }

  const hoy = new Date();
  const fechaCalibracionIso = hoy.toISOString().slice(0, 10);
  const fechaRecal = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()));
  fechaRecal.setUTCMonth(fechaRecal.getUTCMonth() + fila.intervalo_meses);
  const fechaRecalIso = fechaRecal.toISOString().slice(0, 10);

  const pendiente: CalibracionPendiente = {
    chatId,
    codigo: fila.codigo,
    subid: fila.subid,
    fechaCalibracion: fechaCalibracionIso,
    fechaRecalibracionPropuesta: fechaRecalIso,
    intervaloMeses: fila.intervalo_meses,
    proveedor: evento.proveedor || fila.proveedor || null,
    notas: evento.notas,
    textoOriginal: text
  };
  await setAppConfigValue(pendienteKey(chatId), JSON.stringify(pendiente));

  return [
    `Vas a actualizar "${fila.codigo}"${fila.subid !== 'N.A.' ? ` (${fila.subid})` : ''}:`,
    `- Calibración: ${fechaCalibracionIso}${pendiente.proveedor ? ` — Proveedor: ${pendiente.proveedor}` : ''}`,
    `- Próximo vencimiento: ${fechaRecalIso} (${fila.intervalo_meses} meses, según la planilla)`,
    pendiente.notas ? `- Nota para recordarte junto con el próximo vencimiento: "${pendiente.notas}"` : '',
    '',
    '¿Confirmás? Respondé "sí" o "no".'
  ].filter(Boolean).join('\n');
}

export async function looksLikeConfirmacionCalibracion(chatId: number, text: string): Promise<boolean> {
  const raw = await getAppConfigValue(pendienteKey(chatId));
  if (!raw) return false;
  const t = norm(text);
  return /^(si|sí|dale|confirmo|ok|de acuerdo|correcto)\b/.test(t) || /^(no|cancelar|cancela)\b/.test(t);
}

export async function resolverConfirmacionCalibracion(chatId: number, text: string): Promise<string> {
  const raw = await getAppConfigValue(pendienteKey(chatId));
  if (!raw) return 'No tenía ninguna calibración pendiente de confirmar.';
  await setAppConfigValue(pendienteKey(chatId), '');

  let pendiente: CalibracionPendiente;
  try {
    pendiente = JSON.parse(raw);
  } catch {
    return 'No pude recuperar los datos de la calibración pendiente. Probá registrarla de nuevo.';
  }

  const t = norm(text);
  if (/^(no|cancelar|cancela)\b/.test(t)) {
    return `Cancelado. No actualicé "${pendiente.codigo}".`;
  }

  const { error } = await supabase
    .from('equipos_calibraciones')
    .update({
      fecha_calibracion: pendiente.fechaCalibracion,
      fecha_recalibracion: pendiente.fechaRecalibracionPropuesta,
      proveedor: pendiente.proveedor,
      recordatorio_enviado_para: null
    })
    .eq('codigo', pendiente.codigo)
    .eq('subid', pendiente.subid);
  if (error) throw error;

  // Guardamos el evento como item normal (aparece en "qué sabés de X" junto
  // con fotos/notas de Fase 3) y, si había una nota para recordar a futuro,
  // la persistimos como memoria LIGADA al equipo de forma determinística —
  // sin depender de que un clasificador de IA decida si vale la pena
  // guardarla, porque acá el usuario la pidió explícitamente.
  try {
    const clasificacion: Clasificacion = {
      titulo: `Calibración ${pendiente.codigo} — ${pendiente.fechaCalibracion}`,
      resumen: pendiente.textoOriginal,
      categoria_principal: 'Trabajo',
      subcategorias: ['Calibraciones', 'Equipos'],
      tipo_item: 'Evento',
      estado: 'Resuelto',
      valoracion: null,
      importancia: 'Media',
      accion_futura: null,
      tags: ['calibracion', norm(pendiente.codigo).replace(/\s+/g, '-')],
      entidades: [{ tipo: 'Código de equipo', nombre: pendiente.codigo }],
      memorias_sugeridas: pendiente.notas
        ? [{ afirmacion: pendiente.notas, categoria: 'Equipos', confianza: 'Alta' }]
        : []
    };
    const itemInsert: ItemInsert = {
      fuente: 'telegram_calibracion',
      telegram_chat_id: String(chatId),
      texto_original: pendiente.textoOriginal,
      titulo: clasificacion.titulo,
      resumen: clasificacion.resumen,
      categoria_principal: clasificacion.categoria_principal,
      subcategorias: clasificacion.subcategorias,
      tipo_item: clasificacion.tipo_item,
      estado: clasificacion.estado,
      valoracion: clasificacion.valoracion,
      importancia: clasificacion.importancia,
      accion_futura: clasificacion.accion_futura,
      tags: clasificacion.tags,
      entidades_json: clasificacion.entidades,
      classifier_json: clasificacion
    };
    await saveItem(itemInsert);
  } catch (error) {
    console.error('No pude guardar el item/memoria del evento de calibración (la fecha en equipos_calibraciones ya se actualizó igual):', error);
  }

  return [
    `Listo. "${pendiente.codigo}" actualizado:`,
    `- Última calibración: ${pendiente.fechaCalibracion}`,
    `- Próximo vencimiento: ${pendiente.fechaRecalibracionPropuesta}`,
    pendiente.notas ? `- Te lo voy a recordar junto con ese vencimiento: "${pendiente.notas}"` : ''
  ].filter(Boolean).join('\n');
}
