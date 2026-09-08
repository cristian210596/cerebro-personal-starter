import * as XLSX from 'xlsx';
import { supabase } from './supabaseClient.js';
import { createSignedFileUrl } from './storage.js';

// Calibraciones de equipos (GMP): importa la hoja "Calibraciones con datos" de
// la planilla maestra que Cristian mantiene a mano, y expone consultas de
// vencimientos + info de equipo para el router de intención.
//
// Clave real de cada fila: codigo + subid. Un mismo "equipo padre" (ej
// AUT-002, una autoclave) puede tener varios sub-items propios con
// vencimiento INDEPENDIENTE: sondas de temperatura (TE00, TE01, TE02...),
// manovacuómetros (PI09, PI12/1, PI12/2...), lazos de presión (PE06), etc.
// subid = 'N.A.' cuando el equipo no tiene sub-items (caso más común).
//
// Los códigos (codigo/subid) se tratan SIEMPRE como texto. Nunca se
// convierten a número en ningún punto de este archivo: un equipo se llama
// "AUT-002", no "AUT-2".

const SHEET_NAME_TARGET = 'calibraciones con datos';

export type EquipoCalibracionRow = {
  codigo: string;
  subid: string;
  equipo: string | null;
  marca: string | null;
  modelo: string | null;
  fecha_calibracion: string | null;
  intervalo_meses: number | null;
  intervalo_raw: string | null;
  fecha_recalibracion: string | null;
  estado_calib_raw: string | null;
  proveedor: string | null;
  estado_uso: string | null;
  estado_uso_raw: string | null;
  ubicacion: string | null;
  observaciones: string | null;
  clase_serie: string | null;
  rango_uso_gray: string | null;
  capacidad_rango: string | null;
  origen_importacion: string;
};

function norm(value: unknown) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function looksLikeCalibracionesFile(fileName = '', mimeType = '', caption = '') {
  const isXlsx = /spreadsheetml|\.xlsx$/i.test(mimeType) || /\.xlsx$/i.test(fileName);
  if (!isXlsx) return false;
  const t = norm([fileName, caption].join(' '));
  return /calibracion/.test(t);
}

function normalizeIntervaloMeses(raw: unknown): { meses: number | null; raw: string | null } {
  if (raw === null || raw === undefined || raw === '') return { meses: null, raw: null };
  const rawStr = String(raw).trim();
  const s = norm(rawStr);
  if (!s || s === 'n.a.' || s === 'na') return { meses: null, raw: rawStr };
  if (s === 'mensual') return { meses: 1, raw: rawStr };
  if (s === 'semestral') return { meses: 6, raw: rawStr };
  if (s === 'anual') return { meses: 12, raw: rawStr };
  const m = s.match(/^(\d+)\s*m$/);
  if (m) return { meses: Number(m[1]), raw: rawStr };
  // Valor no reconocido: lo guardamos igual como raw para no perder el dato,
  // pero sin meses normalizados (queda sin periodicidad calculable).
  return { meses: null, raw: rawStr };
}

function normalizeEstadoUso(raw: unknown): { estado: string | null; raw: string | null } {
  if (raw === null || raw === undefined || raw === '') return { estado: null, raw: null };
  const rawStr = String(raw).trim();
  const s = norm(rawStr);
  if (s === 'en uso') return { estado: 'en_uso', raw: rawStr };
  if (s.includes('permanente')) return { estado: 'fuera_de_uso_permanente', raw: rawStr };
  if (s.includes('temporal')) return { estado: 'fuera_de_uso_temporal', raw: rawStr };
  if (s === 'fuera de uso') return { estado: 'fuera_de_uso', raw: rawStr };
  return { estado: null, raw: rawStr };
}

function excelDateToIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  // Por si el workbook se lee sin cellDates: true, XLSX puede devolver un
  // serial numérico de fecha. Lo convertimos igual, por las dudas.
  if (typeof value === 'number') {
    const parsed = XLSX.SSF?.parse_date_code ? XLSX.SSF.parse_date_code(value) : null;
    if (parsed) {
      const d = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

function findSheetName(workbook: XLSX.WorkBook): string | null {
  const match = workbook.SheetNames.find(name => norm(name) === SHEET_NAME_TARGET);
  return match || null;
}

function cell(row: any[], idx: number): unknown {
  const v = row[idx];
  return v === undefined ? null : v;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

export function parseCalibracionesWorkbook(buffer: Buffer): { rows: EquipoCalibracionRow[]; sheetName: string; duplicadosResueltos: { codigo: string; subidOriginal: string; subidAsignado: string }[] } {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = findSheetName(workbook);
  if (!sheetName) {
    throw new Error(`No encontré la hoja "Calibraciones con datos" en el archivo. Hojas disponibles: ${workbook.SheetNames.join(', ')}`);
  }
  const sheet = workbook.Sheets[sheetName];
  const raw: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 1, defval: null });

  const rows: EquipoCalibracionRow[] = [];
  // La clave real de cada fila es (codigo, subid). La planilla puede tener
  // dos filas con el mismo codigo+subid (ej "PFG-056" dos veces, sin SubID,
  // con fechas/proveedores distintos: son dos eventos de calibración
  // históricos reales, no un duplicado exacto). Nunca se pisa una fila
  // silenciosamente: si la clave ya se usó en este mismo import, se le suma
  // un sufijo "#2", "#3"... al subid para que las dos queden guardadas, y se
  // reporta el caso en el resultado para que Cristian pueda, si quiere,
  // ponerle un SubID real en la planilla de origen.
  const keysVistas = new Map<string, number>();
  const duplicadosResueltos: { codigo: string; subidOriginal: string; subidAsignado: string }[] = [];

  for (const r of raw) {
    const codigoRaw = cell(r, 0); // A
    const codigo = textOrNull(codigoRaw);
    if (!codigo) continue; // fila vacía o de separación

    const subidRaw = textOrNull(cell(r, 1)); // B
    let subid = subidRaw || 'N.A.';

    const keyBase = `${codigo} ${subid}`;
    const vistas = keysVistas.get(keyBase) || 0;
    keysVistas.set(keyBase, vistas + 1);
    if (vistas > 0) {
      const subidOriginal = subid;
      subid = `${subid}#${vistas + 1}`;
      duplicadosResueltos.push({ codigo, subidOriginal, subidAsignado: subid });
    }

    const intervalo = normalizeIntervaloMeses(cell(r, 6)); // G
    const uso = normalizeEstadoUso(cell(r, 11)); // L

    rows.push({
      codigo,
      subid,
      equipo: textOrNull(cell(r, 2)), // C
      marca: textOrNull(cell(r, 3)), // D
      modelo: textOrNull(cell(r, 4)), // E
      fecha_calibracion: excelDateToIso(cell(r, 5)), // F
      intervalo_meses: intervalo.meses,
      intervalo_raw: intervalo.raw,
      fecha_recalibracion: excelDateToIso(cell(r, 7)), // H
      estado_calib_raw: textOrNull(cell(r, 9)), // J (no se usa para calcular estado: se recalcula en vivo)
      proveedor: textOrNull(cell(r, 10)), // K
      estado_uso: uso.estado,
      estado_uso_raw: uso.raw,
      ubicacion: textOrNull(cell(r, 12)), // M
      observaciones: textOrNull(cell(r, 13)), // N
      clase_serie: textOrNull(cell(r, 14)), // O
      rango_uso_gray: textOrNull(cell(r, 19)), // T
      capacidad_rango: textOrNull(cell(r, 20)), // U
      origen_importacion: 'planilla_excel'
    });
  }

  return { rows, sheetName, duplicadosResueltos };
}

export type ImportCalibracionesResult = {
  ok: boolean;
  totalFilas: number;
  equiposUnicos: number;
  conSubItem: number;
  creados: number;
  actualizados: number;
  sheetName: string;
  duplicadosResueltos: { codigo: string; subidOriginal: string; subidAsignado: string }[];
  error?: string;
};

export async function importCalibracionesFromFile(input: { buffer: Buffer }): Promise<ImportCalibracionesResult> {
  let parsed: { rows: EquipoCalibracionRow[]; sheetName: string; duplicadosResueltos: { codigo: string; subidOriginal: string; subidAsignado: string }[] };
  try {
    parsed = parseCalibracionesWorkbook(input.buffer);
  } catch (error: any) {
    return {
      ok: false,
      totalFilas: 0,
      equiposUnicos: 0,
      conSubItem: 0,
      creados: 0,
      actualizados: 0,
      sheetName: '',
      duplicadosResueltos: [],
      error: error?.message || 'No pude leer el archivo.'
    };
  }

  const { rows, sheetName, duplicadosResueltos } = parsed;
  if (!rows.length) {
    return { ok: false, totalFilas: 0, equiposUnicos: 0, conSubItem: 0, creados: 0, actualizados: 0, sheetName, duplicadosResueltos: [], error: 'La hoja no tiene filas con código de equipo.' };
  }

  // Para saber cuántos son altas nuevas vs actualizaciones, primero traemos
  // los pares (codigo, subid) que ya existen.
  const { data: existentes, error: fetchError } = await supabase
    .from('equipos_calibraciones')
    .select('codigo, subid');
  if (fetchError) throw fetchError;

  const existentesSet = new Set((existentes || []).map((e: any) => `${e.codigo} ${e.subid}`));
  let creados = 0;
  let actualizados = 0;
  for (const row of rows) {
    const key = `${row.codigo} ${row.subid}`;
    if (existentesSet.has(key)) actualizados++; else creados++;
  }

  const nowIso = new Date().toISOString();
  const toUpsert = rows.map(r => ({ ...r, updated_at: nowIso }));

  const CHUNK = 200;
  for (let i = 0; i < toUpsert.length; i += CHUNK) {
    const chunk = toUpsert.slice(i, i + CHUNK);
    const { error } = await supabase.from('equipos_calibraciones').upsert(chunk, { onConflict: 'codigo,subid' });
    if (error) throw error;
  }

  const equiposUnicos = new Set(rows.map(r => r.codigo)).size;
  const conSubItem = rows.filter(r => r.subid !== 'N.A.').length;

  return { ok: true, totalFilas: rows.length, equiposUnicos, conSubItem, creados, actualizados, sheetName, duplicadosResueltos };
}

export function formatImportCalibracionesResult(result: ImportCalibracionesResult): string {
  if (!result.ok) {
    return `No pude importar la planilla de calibraciones: ${result.error}`;
  }
  const lineas = [
    `Calibraciones actualizadas desde "${result.sheetName}".`,
    `Filas procesadas: ${result.totalFilas} (equipos únicos: ${result.equiposUnicos}, con sub-ítem propio: ${result.conSubItem}).`,
    `Nuevos: ${result.creados} · Actualizados: ${result.actualizados}.`
  ];
  if (result.duplicadosResueltos.length) {
    lineas.push('');
    lineas.push('Ojo: encontré código+SubID repetidos en la planilla (dos filas distintas sin un SubID que las diferencie). No perdí ninguna, las guardé todas, pero convendría que les pongas un SubID real en la planilla:');
    for (const d of result.duplicadosResueltos) {
      lineas.push(`- ${d.codigo} (SubID "${d.subidOriginal}" repetido, se guardó como "${d.subidAsignado}")`);
    }
  }
  return lineas.join('\n');
}

// ---------------------------------------------------------------------------
// Consultas: vencimientos y ficha de equipo.
// ---------------------------------------------------------------------------

// Días de preaviso para considerar "por vencer": asumido en 90 días como v1
// (es uno de los dos umbrales que ya usaba Cristian en su propia planilla,
// el más conservador). Ajustable a futuro si hace falta un segundo umbral
// más urgente.
const DIAS_PREAVISO_DEFAULT = 90;

export function computeEstadoVencimiento(fechaRecalibracion: string | null, hoy = new Date(), diasPreaviso = DIAS_PREAVISO_DEFAULT): 'sin_periodicidad' | 'vencido' | 'por_vencer' | 'vigente' {
  if (!fechaRecalibracion) return 'sin_periodicidad';
  const fecha = new Date(fechaRecalibracion + 'T00:00:00Z');
  const diffDias = Math.floor((fecha.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDias < 0) return 'vencido';
  if (diffDias <= diasPreaviso) return 'por_vencer';
  return 'vigente';
}

export type VencimientosQuery = {
  startPeriod?: string | null; // YYYY-MM
  endPeriod?: string | null; // YYYY-MM
  excludePrefixes?: string[] | null; // ej ["MAN", "MAG"]
  includePrefixes?: string[] | null; // ej ["DAT"] -> "listado de dataloggers"
  soloEstado?: 'vencido' | 'por_vencer' | null; // filtra por estado ya calculado, sin depender de un periodo
  incluirFueraDeUsoPermanente?: boolean;
};

export async function queryVencimientos(query: VencimientosQuery) {
  // Un listado puro por tipo (ej "listado de dataloggers", sin periodo ni
  // filtro de estado) tiene que traer TODO lo de ese tipo, incluso equipos
  // sin fecha de recalibración cargada todavía. Un pedido de vencimientos
  // (con periodo o con soloEstado) sí necesita fecha para poder evaluarse.
  const esListadoPuro = Boolean(
    query.includePrefixes && query.includePrefixes.length && !query.startPeriod && !query.endPeriod && !query.soloEstado
  );

  let q = supabase.from('equipos_calibraciones').select('*');
  if (!esListadoPuro) {
    q = q.not('fecha_recalibracion', 'is', null);
  }

  if (query.startPeriod) {
    q = q.gte('fecha_recalibracion', `${query.startPeriod}-01`);
  }
  if (query.endPeriod) {
    const [y, m] = query.endPeriod.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    q = q.lte('fecha_recalibracion', lastDay);
  }
  if (!query.incluirFueraDeUsoPermanente) {
    q = q.neq('estado_uso', 'fuera_de_uso_permanente');
  }

  const { data, error } = await q.order('fecha_recalibracion', { ascending: true });
  if (error) throw error;

  let rows = data || [];
  if (query.excludePrefixes && query.excludePrefixes.length) {
    const prefixesNorm = query.excludePrefixes.map(p => norm(p));
    rows = rows.filter((r: any) => !prefixesNorm.some(p => norm(r.codigo).startsWith(p)));
  }
  if (query.includePrefixes && query.includePrefixes.length) {
    const prefixesNorm = query.includePrefixes.map(p => norm(p));
    rows = rows.filter((r: any) => prefixesNorm.some(p => norm(r.codigo).startsWith(p)));
  }
  if (query.soloEstado) {
    rows = rows.filter((r: any) => computeEstadoVencimiento(r.fecha_recalibracion) === query.soloEstado);
  }

  return rows;
}

export function formatVencimientosReport(rows: any[], opts: { label?: string } = {}): string {
  if (!rows.length) {
    return `No encontré equipos con vencimiento${opts.label ? ` para ${opts.label}` : ''}.`;
  }
  const hoy = new Date();
  const lineas = rows.map((r: any) => {
    const estado = computeEstadoVencimiento(r.fecha_recalibracion, hoy);
    const estadoTxt = estado === 'vencido' ? 'VENCIDO' : estado === 'por_vencer' ? 'por vencer' : estado === 'vigente' ? 'vigente' : 'sin periodicidad registrada';
    const subidTxt = r.subid && r.subid !== 'N.A.' ? ` (${r.subid})` : '';
    const venceTxt = r.fecha_recalibracion ? `vence ${r.fecha_recalibracion}` : 'sin fecha de vencimiento registrada';
    return `${r.codigo}${subidTxt} - ${r.equipo || 'sin nombre'} — ${venceTxt} (${estadoTxt}) — Proveedor: ${r.proveedor || 'sin dato'}${r.ubicacion ? ` — Ubicación: ${r.ubicacion}` : ''}`;
  });
  return [
    `Equipos${opts.label ? ` ${opts.label}` : ''} (${rows.length}):`,
    '',
    ...lineas
  ].join('\n');
}

export async function getEquipoInfo(codigo: string) {
  const codigoTrim = String(codigo || '').trim();
  const { data, error } = await supabase
    .from('equipos_calibraciones')
    .select('*')
    .ilike('codigo', codigoTrim)
    .order('subid', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Deteccion de pedidos AFIRMATIVOS (no preguntas) sobre equipos, para que
// "listado de dataloggers" o "dataloggers vencidos" lleguen al router de
// intencion en vez de cortar como nota generica (que es lo que pasaba: al
// no tener "que"/"?" no calificaban como pregunta). Es angosta a proposito
// -> exige una palabra de dominio de equipos o un patron de codigo, para no
// interceptar notas comunes que usan "vencido" en otro sentido (ej "la
// tarjeta vencida", "el contrato vencido").
const PALABRAS_DOMINIO_EQUIPOS = 'equipo|equipos|instrumento|instrumentos|datalogger|dataloggers|balanza|balanzas|autoclave|autoclaves|termohigrometro|termohigrometros|manometro|manometros|sonda|sondas|phmetro|conductimetro|conductimetros|freezer|heladera|heladeras|camara|estufa|estufas|microscopio|flujo laminar|rotavapor';
const PATRON_CODIGO_EQUIPO = /\b[a-z]{2,5}-\d{2,4}\b/i;

export function looksLikeEquipoQueryText(text: string): boolean {
  const t = norm(text);
  if (!t || t.startsWith('/')) return false;
  if (t.length > 200) return false;

  if (PATRON_CODIGO_EQUIPO.test(t)) return true;

  const tieneDominio = new RegExp(`\\b(${PALABRAS_DOMINIO_EQUIPOS})\\b`).test(t);
  if (/^(listado|lista)\b/.test(t) && tieneDominio) return true;
  if (/\b(vence|vencen|vencido|vencidos|vencimiento|vencimientos)\b/.test(t) && tieneDominio) return true;

  return false;
}

export function formatEquipoInfo(codigo: string, rows: any[]): string {
  if (!rows.length) {
    return `No tengo cargado nada con el código "${codigo}".`;
  }
  const hoy = new Date();
  const lineas = rows.map((r: any) => {
    const estado = computeEstadoVencimiento(r.fecha_recalibracion, hoy);
    const estadoTxt = estado === 'vencido' ? 'VENCIDO' : estado === 'por_vencer' ? 'por vencer' : estado === 'vigente' ? 'vigente' : 'sin periodicidad';
    const subidTxt = r.subid && r.subid !== 'N.A.' ? ` — sub-ítem ${r.subid}` : '';
    return [
      `${r.codigo}${subidTxt}: ${r.equipo || 'sin nombre'} (${r.marca || 's/marca'} ${r.modelo || ''})`.trim(),
      `  Ubicación: ${r.ubicacion || 'sin dato'} · Estado de uso: ${r.estado_uso_raw || 'sin dato'}`,
      `  Última calibración: ${r.fecha_calibracion || 'sin dato'} · Próximo vencimiento: ${r.fecha_recalibracion || 'sin dato'} (${estadoTxt}) · Proveedor: ${r.proveedor || 'sin dato'}`,
      r.observaciones ? `  Observaciones: ${r.observaciones}` : ''
    ].filter(Boolean).join('\n');
  });
  return [`Info de "${codigo}" (${rows.length} registro${rows.length > 1 ? 's' : ''}):`, '', ...lineas].join('\n\n');
}

// ---------------------------------------------------------------------------
// Fase 3: "memoria" de un equipo = todo lo que se guardó alguna vez (notas,
// fotos, hechos durables) mencionando su código, usando el sistema genérico
// de entidades/items/archivos/memorias que el bot ya tenía. Se busca por
// substring normalizado (sin acentos, sin mayúsculas) contra nombre y alias
// de la entidad, porque el clasificador de Gemini no siempre guarda el
// código exactamente igual (ej "EMP-001" vs "Empacadora EMP-001").
export type EquipoMemoria = {
  entidad: { id: string; tipo: string; nombre: string } | null;
  items: any[];
  archivos: Array<{ id: string; nombre_archivo: string | null; descripcion_ia: string | null; created_at: string; url: string | null }>;
  memorias: any[];
};

export async function getEquipoMemoria(codigo: string): Promise<EquipoMemoria> {
  const vacio: EquipoMemoria = { entidad: null, items: [], archivos: [], memorias: [] };
  const codigoTrim = String(codigo || '').trim();
  if (!codigoTrim) return vacio;
  const codigoNorm = norm(codigoTrim);

  const { data: entidadesCandidatas, error: entError } = await supabase
    .from('entidades')
    .select('*')
    .ilike('tipo', '%equipo%');
  if (entError) throw entError;

  const matches = (entidadesCandidatas || []).filter((e: any) => {
    const nombreNorm = norm(e.nombre || '');
    if (nombreNorm && (nombreNorm.includes(codigoNorm) || codigoNorm.includes(nombreNorm))) return true;
    return (e.alias || []).some((a: string) => norm(a).includes(codigoNorm));
  });
  if (!matches.length) return vacio;

  const entidadIds = matches.map((e: any) => e.id);
  const { data: links, error: linkError } = await supabase
    .from('item_entidades')
    .select('item_id')
    .in('entidad_id', entidadIds);
  if (linkError) throw linkError;

  const itemIds = [...new Set((links || []).map((l: any) => l.item_id))];
  if (!itemIds.length) return { entidad: matches[0], items: [], archivos: [], memorias: [] };

  const [{ data: items, error: itemsError }, { data: archivosRaw, error: archivosError }, { data: memorias, error: memoriasError }] = await Promise.all([
    supabase.from('items').select('*').in('id', itemIds).order('created_at', { ascending: false }),
    supabase.from('archivos').select('*').in('item_id', itemIds).order('created_at', { ascending: false }),
    supabase.from('memorias').select('*').eq('vigente', true).in('origen_item_id', itemIds)
  ]);
  if (itemsError) throw itemsError;
  if (archivosError) throw archivosError;
  if (memoriasError) throw memoriasError;

  const archivos = await Promise.all((archivosRaw || []).map(async (a: any) => ({
    id: a.id,
    nombre_archivo: a.nombre_archivo,
    descripcion_ia: a.descripcion_ia,
    created_at: a.created_at,
    url: a.storage_url ? await createSignedFileUrl(a.storage_url).catch(() => null) : null
  })));

  return { entidad: matches[0], items: items || [], archivos, memorias: memorias || [] };
}

// Combina los datos técnicos de Fase 1 (equipos_calibraciones) con la
// memoria de Fase 3 (notas/fotos/hechos durables) en una sola respuesta a
// "qué sabés de la EMP-001?". Es el reemplazo de equipo_info en el router.
export async function getEquipoCompleto(codigo: string) {
  const [filasTecnicas, memoria] = await Promise.all([
    getEquipoInfo(codigo),
    getEquipoMemoria(codigo)
  ]);
  return { filasTecnicas, memoria };
}

export function formatEquipoCompleto(codigo: string, data: { filasTecnicas: any[]; memoria: EquipoMemoria }): string {
  const { filasTecnicas, memoria } = data;
  if (!filasTecnicas.length && !memoria.items.length) {
    return `No tengo cargado nada con el código "${codigo}" (ni en calibraciones, ni en notas o fotos).`;
  }

  const partes: string[] = [];
  partes.push(filasTecnicas.length ? formatEquipoInfo(codigo, filasTecnicas) : `Info de "${codigo}": no tiene datos de calibración cargados todavía.`);

  if (memoria.items.length) {
    partes.push('');
    partes.push(`Notas guardadas (${memoria.items.length}):`);
    for (const item of memoria.items) {
      const fecha = String(item.created_at || '').slice(0, 10);
      const resumen = item.titulo || item.resumen || String(item.texto_original || '').slice(0, 80) || 'sin título';
      partes.push(`- [${fecha}] ${resumen}`);
      if (item.accion_futura) partes.push(`  Acción futura: ${item.accion_futura}`);
    }
  }

  if (memoria.archivos.length) {
    partes.push('');
    partes.push(`Fotos/archivos (${memoria.archivos.length}):`);
    for (const a of memoria.archivos) {
      const desc = a.descripcion_ia ? ` — ${a.descripcion_ia}` : '';
      partes.push(`- ${a.nombre_archivo || 'archivo'}${desc}${a.url ? `\n  ${a.url}` : ' (sin link disponible)'}`);
    }
  }

  if (memoria.memorias.length) {
    partes.push('');
    partes.push('Para tener en cuenta:');
    for (const m of memoria.memorias) {
      partes.push(`- ${m.afirmacion}`);
    }
  }

  return partes.join('\n');
}
