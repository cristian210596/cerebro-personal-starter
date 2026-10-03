import { supabase } from './supabaseClient.js';
import { resolveMasterEntity } from './entityBrain.js';

// Vinculación de TODO con entidades (personas, comercios, empresas).
//
// Fuente de verdad: tabla public.entidades (la misma que ya usan los items/mails vía
// item_entidades). Acá se agrega la resolución "nombre crudo -> entidad" para movimientos
// financieros y deudas, con un matcher conservador:
//   - "Transferencia enviada Daverio Daniel Emilio" -> contraparte "Daverio Daniel Emilio"
//   - matchea "Daniel Daverio" porque todos sus tokens están contenidos (sin importar orden)
//   - NO matchea "Maria Laura Molina" con "Maria Laura Gomez" (no hay contención)
//   - un solo token solo matchea si es exactamente igual ("Imperio" == "Imperio")
//   - si hay empate entre dos candidatas no vincula (mejor sin vínculo que mal vinculado)

export type EntityRow = {
  id: string;
  tipo: string | null;
  nombre: string | null;
  alias?: string[] | null;
  categoria_relacionada?: string | null;
  notion_page_id?: string | null;
};

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'a', 'sa', 'srl', 'sas', 'sh', 'saci', 'cicsa', 'sacif', 'sociedad']);
const PREFIX = /^(transferencia\s+(enviada|recibida)|pago\s+con\s+qr|pago\s+qr|pago\s+a|pago|devoluci[oó]n\s+de\s+dinero|cobro|d[eé]bito\s+autom[aá]tico)\s+/i;
// Textos que no tienen contraparte (se evalúan sobre el texto completo, antes de sacar prefijos).
const GENERIC_FULL = /^(rendimientos?|ingreso\s+de\s+dinero|pago\s+de\s+estado\s+de\s+cuenta|devoluci[oó]n\s+de\s+dinero\s+compra\s+protegida|compra\s+protegida)\b/i;
// Lo que queda después de sacar el prefijo y sigue sin ser un nombre.
const GENERIC_REST = /^(transferencia|devoluci[oó]n|compra\s+protegida|tarjeta|de\s+estado\s+de\s+cuenta)\b/i;
const BUSINESS = /\b(kiosco|kiosko|tienda|ferreter[ií]a|shop|pet|pizza|pizzer[ií]a|carnes|carnicer[ií]a|srl|sa|sas|sh|almac[eé]n|super|supermercado|mercado|farmacia|panader[ií]a|verduler[ií]a|bar|resto|restaurante|caf[eé]|librer[ií]a|[oó]ptica|lavadero|estaci[oó]n|club|gym|gimnasio|fotos|lac|plaza|asamblea|distribuidora|comercial|store|market|hotel|taxi|remis|parrilla|helader[ií]a|cerveceri[aá]|bazar|cotill[oó]n)\b/i;

const DEFAULT_SELF = ['Cristian', 'Cristian Santillan', 'Cristian Gabriel Santillan', 'Santillan Cristian Gabriel', 'Garantia Calidad', 'Garantía de Calidad'];

export function selfNames(): string[] {
  const env = process.env.CEREBRO_SELF_NAMES;
  return env ? env.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_SELF;
}

export function normalizeText(value: unknown) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokensOf(value: unknown): string[] {
  return [...new Set(normalizeText(value).split(' ').filter(t => t.length >= 2 && !STOPWORDS.has(t)))];
}

export function isSelf(name: unknown) {
  const key = tokensOf(name).sort().join(' ');
  if (!key) return false;
  return selfNames().some(s => tokensOf(s).sort().join(' ') === key);
}

// Extrae la contraparte de un texto de movimiento ("Transferencia enviada X — detalle [importado: ...]").
export function counterpartFromText(raw: unknown): string | null {
  let text = String(raw || '');
  text = text.split(' [importado:')[0];
  text = text.split(' — ')[0];
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/cuit|www\.|mercadopago\.com/i.test(text)) return null;
  const stripped = text.replace(PREFIX, '').trim();
  if (GENERIC_FULL.test(text) || !stripped || GENERIC_REST.test(stripped)) return null;
  if (tokensOf(stripped).length === 0) return null;
  return stripped;
}

export function guessTipo(rawText: unknown, counterpart: string): 'Persona' | 'Comercio' {
  const raw = String(rawText || '');
  if (/pago\s+con\s+qr/i.test(raw)) return 'Comercio';
  if (BUSINESS.test(normalizeText(counterpart))) return 'Comercio';
  if (/\d/.test(counterpart)) return 'Comercio';
  const words = counterpart.split(/\s+/).filter(Boolean);
  if (/transferencia/i.test(raw) && words.length >= 2 && words.length <= 5) return 'Persona';
  return 'Comercio';
}

export function displayName(value: string) {
  let v = value.replace(/\s+/g, ' ').trim();
  // "LEDEZMA, KEVIN" (formato banco Apellido, Nombre) -> "KEVIN LEDEZMA"
  const parts = v.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 2) v = `${parts[1]} ${parts[0]}`;
  const isAllCaps = v === v.toUpperCase();
  const base = isAllCaps ? v.toLowerCase() : v;
  return base.replace(/(^|[\s'(-])([a-záéíóúñü])/g, (_m, p, c) => p + c.toUpperCase());
}

// Devuelve puntaje >0 si el nombre candidato corresponde a la contraparte, 0 si no.
export function nameMatchScore(counterpart: string, candidate: string): number {
  const a = tokensOf(counterpart);
  const b = tokensOf(candidate);
  if (!a.length || !b.length) return 0;
  if (a.slice().sort().join(' ') === b.slice().sort().join(' ')) return 100;
  const small = a.length <= b.length ? a : b;
  const large = a.length <= b.length ? b : a;
  if (small.length < 2) return 0; // un solo token: solo igualdad exacta (arriba)
  const contained = small.every(t => large.includes(t));
  if (!contained) return 0;
  return 50 + small.length * 10 - (large.length - small.length);
}

export function pickEntity(counterpart: string, entities: EntityRow[]): { entity: EntityRow; score: number } | null {
  let best: { entity: EntityRow; score: number } | null = null;
  let tie = false;
  for (const e of entities) {
    const names = [e.nombre || '', ...(e.alias || [])].filter(Boolean);
    let s = 0;
    for (const n of names) s = Math.max(s, nameMatchScore(counterpart, n));
    if (!s) continue;
    if (!best || s > best.score) { best = { entity: e, score: s }; tie = false; }
    else if (s === best.score && best.entity.id !== e.id) tie = true;
  }
  if (!best || (tie && best.score < 100)) return null;
  return best;
}

let cache: { at: number; rows: EntityRow[] } | null = null;
export async function loadEntities(force = false): Promise<EntityRow[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.rows;
  const rows: EntityRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('entidades').select('*').range(from, from + 999);
    if (error) throw error;
    rows.push(...((data || []) as EntityRow[]));
    if (!data || data.length < 1000) break;
  }
  cache = { at: Date.now(), rows };
  return rows;
}

async function addAlias(entity: EntityRow, alias: string) {
  const current = entity.alias || [];
  const key = normalizeText(alias);
  if (!key || normalizeText(entity.nombre) === key || current.some(a => normalizeText(a) === key)) return;
  const next = [...current, alias].slice(0, 50);
  const { error } = await supabase.from('entidades').update({ alias: next }).eq('id', entity.id);
  if (!error) entity.alias = next;
}

// Resuelve (y si hace falta crea) la entidad para un nombre. Devuelve null si no corresponde
// vincular (texto genérico, el propio usuario, etc.).
export async function resolveEntityByName(
  rawName: string,
  opts: { tipo?: string | null; categoria?: string | null; create?: boolean; rawText?: string | null } = {}
): Promise<{ entity: EntityRow; created: boolean } | null> {
  const name = String(rawName || '').trim();
  if (!name || isSelf(name)) return null;
  const entities = await loadEntities();
  const hit = pickEntity(name, entities);
  if (hit) {
    await addAlias(hit.entity, name).catch(() => undefined);
    return { entity: hit.entity, created: false };
  }
  if (opts.create === false) return null;
  const tipo = opts.tipo || guessTipo(opts.rawText || name, name);
  const nombre = displayName(name);
  const { data, error } = await supabase
    .from('entidades')
    .insert({ tipo, nombre, alias: name !== nombre ? [name] : [], categoria_relacionada: opts.categoria || null })
    .select()
    .single();
  if (error) {
    const fresh = await loadEntities(true);
    const again = fresh.find(e => e.tipo === tipo && normalizeText(e.nombre) === normalizeText(nombre));
    if (again) return { entity: again, created: false };
    throw error;
  }
  entities.push(data as EntityRow);
  return { entity: data as EntityRow, created: true };
}

// Contraparte de un movimiento financiero. Usa primero el "cerebro" de entidades financieras
// (alias conocidos de comercios: Uber, Coto, Rappi...) y si no, extrae el nombre del texto.
export async function counterpartForMovement(m: any): Promise<{ name: string; tipo: string | null; raw: string } | null> {
  const raw = String(m?.comercio || m?.descripcion || '').trim();
  if (!raw) return null;
  if (/rendimiento/i.test(raw) && /mercado\s*pago/i.test(String(m?.banco_billetera || m?.medio_pago || ''))) {
    return { name: 'Mercado Pago', tipo: 'Empresa', raw };
  }
  const counterpart = counterpartFromText(raw);
  if (!counterpart) return null;
  try {
    const master = await resolveMasterEntity(counterpart);
    if (master?.entidad?.nombre && master.score >= 0.75) {
      const t = String(master.entidad.tipo || '').toLowerCase();
      return { name: master.entidad.nombre, tipo: t === 'comercio' ? 'Comercio' : 'Empresa', raw };
    }
  } catch { /* el cerebro financiero es opcional */ }
  return { name: counterpart, tipo: null, raw };
}

export async function resolveEntityForMovement(m: any, create = true) {
  const cp = await counterpartForMovement(m);
  if (!cp) return null;
  return resolveEntityByName(cp.name, { tipo: cp.tipo, categoria: m?.categoria_financiera || null, create, rawText: cp.raw });
}

let warnedMissingColumn = false;
export async function saveEntityLink(table: 'finanzas_movimientos' | 'finanzas_deudas', rowId: string, entityId: string) {
  const { error } = await supabase.from(table).update({ entidad_id: entityId }).eq('id', rowId);
  if (error && !warnedMissingColumn) {
    warnedMissingColumn = true;
    console.warn(`No pude guardar entidad_id en ${table} (¿falta correr supabase/vinculos_entidades.sql?):`, error.message);
  }
}

let warnedNotionColumn = false;
export async function saveEntityNotionPage(entityId: string, pageId: string) {
  const { error } = await supabase.from('entidades').update({ notion_page_id: pageId }).eq('id', entityId);
  if (error && !warnedNotionColumn) {
    warnedNotionColumn = true;
    console.warn('No pude guardar notion_page_id en entidades (¿falta correr supabase/vinculos_entidades.sql?):', error.message);
  }
}
