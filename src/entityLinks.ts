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
  created_at?: string | null;
};

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'a', 'sa', 'srl', 'sas', 'sh', 'saci', 'cicsa', 'sacif', 'sociedad']);
const PREFIX = /^(transferencia\s+(enviada|recibida)|pago\s+con\s+qr|pago\s+qr|pago\s+a|pago|devoluci[oó]n\s+de\s+dinero|cobro|d[eé]bito\s+autom[aá]tico)\s+/i;
// Textos que no tienen contraparte (se evalúan sobre el texto completo, antes de sacar prefijos).
const GENERIC_FULL = /^(rendimientos?|ingreso\s+de\s+dinero|pago\s+de\s+estado\s+de\s+cuenta|devoluci[oó]n\s+de\s+dinero\s+compra\s+protegida|compra\s+protegida)\b/i;
// Lo que queda después de sacar el prefijo y sigue sin ser un nombre.
const GENERIC_REST = /^(transferencia|devoluci[oó]n|compra\s+protegida|tarjeta|de\s+estado\s+de\s+cuenta)\b/i;
const BUSINESS = /\b(kiosco|kiosko|tienda|ferreter[ií]a|shop|pet|pizza|pizzer[ií]a|carnes|carnicer[ií]a|srl|sa|sas|sh|almac[eé]n|super|supermercado|mercado|farmacia|panader[ií]a|verduler[ií]a|bar|resto|restaurante|caf[eé]|librer[ií]a|[oó]ptica|lavadero|estaci[oó]n|club|gym|gimnasio|fotos|lac|plaza|asamblea|distribuidora|comercial|store|market|hotel|taxi|remis|parrilla|helader[ií]a|cerveceri[aá]|bazar|cotill[oó]n|delivery|express|resto|grill|burger|sushi|empanadas|rotiser[ií]a|bebidas|vinoteca|indumentaria|deportes|motos|autos|tecnolog[ií]a|inform[aá]tica)\b/i;

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

// Comercios conocidos que llegan con mil variantes en los resúmenes de tarjeta.
// Se evalúan sobre el texto ya limpio (sin "PAYU*AR*", códigos, etc.).
export const CANONICAL_MERCHANTS: { name: string; tipo: string; re: RegExp }[] = [
  { name: 'Uber', tipo: 'Empresa', re: /\buber\b/i },
  { name: 'Rappi', tipo: 'Empresa', re: /\brappi\b/i },
  { name: 'Cabify', tipo: 'Empresa', re: /\bcabify\b/i },
  { name: 'DiDi', tipo: 'Empresa', re: /^didi\b/i },
  { name: 'PedidosYa', tipo: 'Empresa', re: /\bpedidos\s*ya\b/i },
  { name: 'SUBE', tipo: 'Empresa', re: /^sube\b/i },
  { name: 'Emova (Subte)', tipo: 'Empresa', re: /\bemova\b/i },
  { name: 'Apple', tipo: 'Empresa', re: /\bapple\s*\.?\s*com\b|^apple\b/i },
  { name: 'Anthropic / Claude', tipo: 'Empresa', re: /\banthropic\b|\bclaude\s*\.?\s*ai\b/i },
  { name: 'OpenAI / ChatGPT', tipo: 'Empresa', re: /\bopenai\b|\bchatgpt\b/i },
  { name: 'Google One', tipo: 'Empresa', re: /\bgoogle\s*one\b|^google\s+google\s+o\b|^google\s+o$/i },
  { name: 'YouTube Premium', tipo: 'Empresa', re: /\byoutube(p|premium)?\b/i },
  { name: 'Mercado Libre', tipo: 'Empresa', re: /^mercado\s*libre\b/i },
  { name: 'DIA', tipo: 'Comercio', re: /^(supermercados?\s+)?dia(\s+(supermercado|tienda))?$/i },
  { name: 'Coto', tipo: 'Comercio', re: /^coto\b/i },
  { name: 'Disco', tipo: 'Comercio', re: /^disco\b/i },
  { name: 'Farmacity', tipo: 'Comercio', re: /^farmacity\b/i },
  { name: 'Mackito', tipo: 'Comercio', re: /^mackito\b/i },
  { name: 'La Candela Resto', tipo: 'Comercio', re: /^la\s*candela\s*resto\b/i },
  { name: 'Médicos Sin Fronteras', tipo: 'Empresa', re: /^medicos\s+sin\s+fron/i },
  { name: 'Movistar', tipo: 'Empresa', re: /\bmovistar\b/i },
  { name: 'Personal (Telecom)', tipo: 'Empresa', re: /^personal$/i },
  { name: 'Universidad Kennedy', tipo: 'Empresa', re: /\bkennedy\b/i },
  { name: 'ARCA (ex AFIP)', tipo: 'Empresa', re: /^(afip|arca)$|\barca\b|^db\s*rg\b|^iva\s*rg\b/i },
  { name: 'AGIP (IIBB CABA)', tipo: 'Empresa', re: /^iibb\b|\bagip\b/i },
  { name: 'McDonald\'s (Arcos Dorados)', tipo: 'Comercio', re: /\barcos\s+dorados\b|\bmc\s*donald/i },
  { name: 'Productos Farmacéuticos Dr. Gray', tipo: 'Empresa', re: /\bdr\.?\s*gray\b/i },
  { name: 'Mercado Pago', tipo: 'Empresa', re: /^mercado\s*pago$/i },
  { name: 'Banco Galicia', tipo: 'Empresa', re: /\bgalicia\b/i },
  { name: 'Visa', tipo: 'Empresa', re: /^visa(\s+cr[eé]dito)?$/i },
  { name: 'Mastercard', tipo: 'Empresa', re: /^master\s*card(\s+cr[eé]dito)?$/i }
];

// Prefijos de procesadores de pago que no son el comercio real.
const PROCESSOR_PREFIX = /^(payu\s*\*?\s*ar\s*\*?|merpago\s*\*|mercadopago\s*\*|dlo\s*\*|propina\s*\*|paypal\s*\*?|google\s*\*|sp\s*\*|k\s+(?=anthropic))\s*/i;
// Textos que nunca son una contraparte (restos de parseo de PDF, leyendas, impuestos sueltos).
const NOT_A_NAME = /(\d{1,2}\/\d{1,2}\/\d{2,4})|^(fecha|intervalo|se\s+utiliz|comercio\s+sin\s+identificar|saldo|total|subtotal|resumen|vencimiento|cierre|p[aá]gina)\b|^(puchos|cigarrillos|yerba|yerba\s+y\s+puchos|caf[eé]|comida|almuerzo|cena|desayuno|merienda|nafta|varios|gasto|compra|regalo|propina)$/i;

export function cleanMerchantText(value: string): string {
  let t = String(value || '').trim();
  for (let i = 0; i < 3; i++) t = t.replace(PROCESSOR_PREFIX, '');
  t = t.replace(/\*/g, ' ');
  // Códigos de referencia al final: tokens alfanuméricos mezclados (in1TaL88B, MTZ4ML8H2, 26223ECGO32X) y "USD".
  const words = t.split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1];
    const mixed = /[a-z]/i.test(last) && /\d/.test(last) && last.length >= 5;
    if (mixed || /^(usd|ars|ar)$/i.test(last)) words.pop(); else break;
  }
  return words.join(' ').replace(/\s+-\s+/g, ' - ').trim();
}

export function canonicalMerchant(value: string): { name: string; tipo: string } | null {
  const t = cleanMerchantText(value);
  const n = normalizeText(t);
  for (const c of CANONICAL_MERCHANTS) if (c.re.test(t) || c.re.test(n)) return { name: c.name, tipo: c.tipo };
  return null;
}

// Extrae la contraparte de un texto de movimiento ("Transferencia enviada X — detalle [importado: ...]").
export function counterpartFromText(raw: unknown): string | null {
  let text = String(raw || '');
  text = text.split(' [importado:')[0];
  text = text.split(' — ')[0];
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/cuit|www\.|mercadopago\.com/i.test(text)) return null;
  if (GENERIC_FULL.test(text) || NOT_A_NAME.test(text)) return null;
  let stripped = text.replace(PREFIX, '').trim();
  if (!stripped || GENERIC_REST.test(stripped)) return null;
  stripped = stripped.replace(/^de\s+servicio\s+/i, '');
  const canon = canonicalMerchant(stripped);
  if (canon) return canon.name;
  stripped = cleanMerchantText(stripped);
  if (!stripped || NOT_A_NAME.test(stripped) || tokensOf(stripped).length === 0) return null;
  if (!/[a-z]{2,}/i.test(stripped)) return null;
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

function compactKey(v: unknown) { return tokensOf(v).join(''); }

function tokenHit(t: string, pool: string[]) {
  return pool.some(p => p === t || (t.length >= 4 && p.length >= 4 && (p.startsWith(t) || t.startsWith(p))));
}

// Devuelve puntaje >0 si el nombre candidato corresponde a la contraparte, 0 si no.
// loose=true (solo comercios/empresas, nunca personas): un único token alcanza si es el
// primero del otro nombre ("Mackito" ~ "Mackito Srl Jamonjamonem", "Sube" ~ "Sube Viajes").
export function nameMatchScore(counterpart: string, candidate: string, loose = false): number {
  const a = tokensOf(counterpart);
  const b = tokensOf(candidate);
  if (!a.length || !b.length) return 0;
  if (a.slice().sort().join(' ') === b.slice().sort().join(' ')) return 100;
  if (compactKey(counterpart) === compactKey(candidate) && compactKey(counterpart).length >= 5) return 95; // "Lacandelaresto" = "La Candelaresto"
  const small = a.length <= b.length ? a : b;
  const large = a.length <= b.length ? b : a;
  if (small.length < 2) {
    if (loose && small[0].length >= 4 && large[0] === small[0]) return 40;
    return 0;
  }
  const contained = small.every(t => tokenHit(t, large));
  if (!contained) return 0;
  return 50 + small.length * 10 - (large.length - small.length);
}

const isPersona = (tipo: unknown) => normalizeText(tipo) === 'persona';

export function pickEntity(counterpart: string, entities: EntityRow[], counterpartTipo?: string | null): { entity: EntityRow; score: number } | null {
  let best: { entity: EntityRow; score: number } | null = null;
  let tie = false;
  for (const e of entities) {
    const loose = !isPersona(counterpartTipo) && !isPersona(e.tipo) && Boolean(counterpartTipo);
    const names = [e.nombre || '', ...(e.alias || [])].filter(Boolean);
    let sc = 0;
    for (const n of names) sc = Math.max(sc, nameMatchScore(counterpart, n, loose));
    if (!sc) continue;
    if (!best || sc > best.score) { best = { entity: e, score: sc }; tie = false; }
    else if (sc === best.score && best.entity.id !== e.id) tie = true;
  }
  if (!best || (tie && best.score < 95)) return null;
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
  const guessed = opts.tipo || guessTipo(opts.rawText || name, name);
  const hit = pickEntity(name, entities, guessed);
  if (hit) {
    await addAlias(hit.entity, name).catch(() => undefined);
    return { entity: hit.entity, created: false };
  }
  if (opts.create === false) return null;
  const tipo = guessed;
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
  const canon = CANONICAL_MERCHANTS.find(c => c.name === counterpart);
  if (canon) return { name: canon.name, tipo: canon.tipo, raw };
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
export type LinkTable = 'finanzas_movimientos' | 'finanzas_deudas' | 'finanzas_comprobantes' | 'sueldos_recibos';
export async function saveEntityLink(table: LinkTable, rowId: string, entityId: string) {
  const { error } = await supabase.from(table).update({ entidad_id: entityId }).eq('id', rowId);
  if (error && !warnedMissingColumn) {
    warnedMissingColumn = true;
    console.warn(`No pude guardar entidad_id en ${table} (¿falta correr supabase/vinculos_entidades.sql / vinculos_entidades_v2.sql?):`, error.message);
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


// ---------- Comprobantes y recibos de sueldo ----------

function merchantNameFor(raw: string) {
  const canon = canonicalMerchant(raw);
  if (canon) return { name: canon.name, tipo: canon.tipo };
  const cleaned = cleanMerchantText(raw);
  return cleaned && !NOT_A_NAME.test(cleaned) ? { name: cleaned, tipo: 'Comercio' } : null;
}

async function propagateToMovement(movementId: string | null | undefined, entityId: string) {
  if (!movementId) return;
  const { data } = await supabase.from('finanzas_movimientos').select('id,entidad_id').eq('id', movementId).maybeSingle();
  if (data && !data.entidad_id) await saveEntityLink('finanzas_movimientos', data.id, entityId);
}

export async function linkComprobanteEntity(c: any): Promise<EntityRow | null> {
  if (!c?.id) return null;
  try {
    if (c.entidad_id) return (await loadEntities()).find(e => e.id === c.entidad_id) || null;
    const base = merchantNameFor(String(c.comercio || c.razon_social || ''));
    if (!base) return null;
    const res = await resolveEntityByName(base.name, { tipo: base.tipo, categoria: c.categoria_sugerida || c.categoria || null });
    if (!res) return null;
    if (c.razon_social && normalizeText(c.razon_social) !== normalizeText(res.entity.nombre)) await addAlias(res.entity, String(c.razon_social)).catch(() => undefined);
    await saveEntityLink('finanzas_comprobantes', c.id, res.entity.id);
    await propagateToMovement(c.movimiento_financiero_id, res.entity.id);
    return res.entity;
  } catch (error) {
    console.error('No pude vincular el comprobante con su entidad:', error);
    return null;
  }
}

export async function linkSueldoEntity(r: any): Promise<EntityRow | null> {
  if (!r?.id || !r.empresa) return null;
  try {
    if (r.entidad_id) return (await loadEntities()).find(e => e.id === r.entidad_id) || null;
    const canon = canonicalMerchant(String(r.empresa));
    const res = await resolveEntityByName(canon?.name || String(r.empresa), { tipo: 'Empresa', categoria: 'Ingreso laboral' });
    if (!res) return null;
    await saveEntityLink('sueldos_recibos', r.id, res.entity.id);
    await propagateToMovement(r.movimiento_financiero_id, res.entity.id);
    return res.entity;
  } catch (error) {
    console.error('No pude vincular el recibo de sueldo con su entidad:', error);
    return null;
  }
}


// ---------- Plan de unión de duplicados (puro, testeable) ----------
const ORG_TIPOS = new Set(['empresa', 'comercio', 'marca', 'organizacion', 'institucion', 'laboratorio', 'proveedor', 'banco', 'entidad', 'organismo']);
export function entityFamily(tipo: unknown) {
  const t = normalizeText(tipo);
  if (t === 'persona') return 'persona';
  if (ORG_TIPOS.has(t)) return 'org';
  return `tipo:${t}`;
}

export function planEntityMerges(entities: EntityRow[], links: Map<string, number>) {
  const sorted = entities
    .filter(e => tokensOf(e.nombre).length > 0)
    .sort((a, b) => tokensOf(b.nombre).length - tokensOf(a.nombre).length || (links.get(b.id) || 0) - (links.get(a.id) || 0));
  const index = new Map<string, EntityRow[]>();
  const clusters = new Map<string, EntityRow[]>();
  let ambiguos = 0;
  for (const e of sorted) {
    const fam = entityFamily(e.tipo);
    const toks = tokensOf(e.nombre);
    const seen = new Set<string>();
    const matches: EntityRow[] = [];
    for (const t of toks) {
      for (const c of index.get(t) || []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (entityFamily(c.tipo) !== fam) continue;
        const names = [c.nombre || '', ...(c.alias || [])];
        if (names.some(n => nameMatchScore(e.nombre || '', n, false) > 0)) matches.push(c);
      }
    }
    if (matches.length === 1) clusters.get(matches[0].id)!.push(e);
    else if (matches.length === 0) {
      clusters.set(e.id, [e]);
      for (const t of toks) { const arr = index.get(t) || []; arr.push(e); index.set(t, arr); }
    } else ambiguos += 1;
  }
  const merges = [...clusters.values()].filter(c => c.length > 1).map(members => {
    const keeper = [...members].sort((a, b) =>
      (links.get(b.id) || 0) - (links.get(a.id) || 0) ||
      String(a.created_at || '').localeCompare(String(b.created_at || ''))
    )[0];
    return { keeper, losers: members.filter(m => m.id !== keeper.id) };
  });
  return { merges, ambiguos };
}


// Entidad para el emisor de un resumen (banco/billetera/tarjeta): "Mercado Pago", "Visa", "Banco Galicia".
export async function resolveIssuerEntity(name: string | null | undefined): Promise<EntityRow | null> {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const canon = canonicalMerchant(raw);
  return (await resolveEntityByName(canon?.name || raw, { tipo: 'Empresa' }))?.entity || null;
}
