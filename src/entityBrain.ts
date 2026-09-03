import { supabase } from './supabaseClient.js';

type MasterEntityInput = {
  tipo?: string | null;
  nombre: string;
  categoria?: string | null;
  subcategoria?: string | null;
  notas?: string | null;
};

export function normalizeEntityKey(value: string) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[*_./\\-]+/g, ' ')
    .replace(/\b(sa|saci|srl|sas|s\.a\.|s\.r\.l\.|cicsa)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function defaultKnownEntityAliases() {
  return [
    { tipo: 'suscripcion', nombre: 'OpenAI / ChatGPT', categoria: 'Suscripciones', subcategoria: 'Herramientas IA', aliases: ['OPENAI *CHATGPT', 'OPENAI CHATGPT', 'ChatGPT', 'chat gpt', 'openai.com'] },
    { tipo: 'suscripcion', nombre: 'Anthropic / Claude', categoria: 'Suscripciones', subcategoria: 'Herramientas IA', aliases: ['ANTHROPIC* CLAUDE', 'ANTHROPIC CLAUDE', 'Claude', 'Anthropic'] },
    { tipo: 'suscripcion', nombre: 'Google One', categoria: 'Suscripciones', subcategoria: 'Cloud', aliases: ['Google One', 'GOOGLE ONE'] },
    { tipo: 'suscripcion', nombre: 'YouTube Premium', categoria: 'Suscripciones', subcategoria: 'Streaming', aliases: ['GOOGLE *YouTubePremium', 'YouTubePremium', 'YouTube Premium'] },
    { tipo: 'comercio', nombre: 'Coto', categoria: 'Supermercado', subcategoria: 'Supermercado', aliases: ['COTO', 'SUC151 COTO CICSA', 'COTO CICSA', 'COTO PARQUE CHACABUCO'] },
    { tipo: 'comercio', nombre: 'Arredo / JAS Diseño S.A.', categoria: 'Casa', subcategoria: 'Decoración', aliases: ['ARREDO', 'JAS DISEÑO S.A.', 'JAS DISENO S.A.', 'GALLO-FB', 'GALLO'] },
    { tipo: 'comercio', nombre: 'Uber', categoria: 'Transporte', subcategoria: 'Apps de transporte', aliases: ['PAYU*AR*UBER', 'UBER', 'Uber'] },
    { tipo: 'comercio', nombre: 'Cabify', categoria: 'Transporte', subcategoria: 'Apps de transporte', aliases: ['CABIFY AR', 'Cabify'] },
    { tipo: 'comercio', nombre: 'Rappi', categoria: 'Comida afuera', subcategoria: 'Delivery', aliases: ['DLO*RAPPI', 'RAPPI ARG S.A.S.', 'Rappi'] },
    { tipo: 'comercio', nombre: 'Universidad Kennedy', categoria: 'Educación', subcategoria: 'Universidad', aliases: ['PAGOS360*UNIV_ KENNEDY', 'UNIV KENNEDY', 'Kennedy'] },
    { tipo: 'empleador', nombre: 'Productos Farmacéuticos Dr. Gray S.A.C.I.', categoria: 'Ingresos', subcategoria: 'Sueldo', aliases: ['Productos Farmaceuticos Dr. Gray SACI', 'Dr Gray', 'Productos Farmacéuticos Dr. Gray'] }
  ];
}

export async function seedDefaultEntityBrain() {
  let inserted = 0;
  for (const entry of defaultKnownEntityAliases()) {
    const master = await upsertMasterEntity(entry);
    for (const alias of entry.aliases) {
      const ok = await upsertEntityAlias(master.id, alias, 'seed');
      if (ok) inserted++;
    }
  }
  return { inserted };
}

export async function upsertMasterEntity(input: MasterEntityInput) {
  const nombre = clean(input.nombre);
  const tipo = clean(input.tipo || 'comercio') || 'comercio';
  const key = normalizeEntityKey(`${tipo}:${nombre}`);

  const { data: existing, error: findError } = await supabase
    .from('entidades_maestras')
    .select('*')
    .eq('clave_normalizada', key)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return existing;

  const { data, error } = await supabase
    .from('entidades_maestras')
    .insert({
      tipo,
      nombre,
      clave_normalizada: key,
      categoria: clean(input.categoria) || null,
      subcategoria: clean(input.subcategoria) || null,
      notas: clean(input.notas) || null
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function upsertEntityAlias(entidadId: string, alias: string, origen = 'manual') {
  const cleanAlias = clean(alias);
  if (!cleanAlias) return false;
  const aliasKey = normalizeEntityKey(cleanAlias);
  const { error } = await supabase
    .from('entidades_aliases')
    .upsert({ entidad_id: entidadId, alias: cleanAlias, alias_normalizado: aliasKey, origen }, { onConflict: 'alias_normalizado' });
  if (error) throw error;
  return true;
}

export async function resolveMasterEntity(text: string, tipo?: string | null) {
  const q = normalizeEntityKey(text);
  if (!q) return null;
  const { data: aliases, error } = await supabase
    .from('entidades_aliases')
    .select('*, entidades_maestras(*)')
    .limit(1000);
  if (error) throw error;
  let best: any = null;
  let bestScore = 0;
  for (const row of aliases || []) {
    const a = row.alias_normalizado || normalizeEntityKey(row.alias || '');
    const master = row.entidades_maestras;
    if (!a || !master) continue;
    if (tipo && master?.tipo && normalizeEntityKey(master.tipo) !== normalizeEntityKey(tipo)) continue;
    const score = scoreAliasMatch(q, a);
    if (score > bestScore) { best = master; bestScore = score; }
  }
  return bestScore >= 0.55 ? { entidad: best, score: bestScore } : null;
}

// Los resumenes de tarjeta suelen pegarle un sufijo/codigo al comercio conocido
// (ej: "UBERX25151", "MERPAGO*NEGOCIO123"). Antes esto perdia contra el umbral de
// similitud porque el largo relativo entre alias y texto era muy chico. Ahora, si
// el alias conocido aparece como PREFIJO (o el texto es prefijo del alias), se
// considera una senal fuerte de que es la misma entidad aunque el texto sea mas largo.
function scoreAliasMatch(q: string, a: string): number {
  if (!q || !a) return 0;
  if (q === a) return 1;
  if (a.length >= 4 && (q.startsWith(a) || a.startsWith(q))) {
    return Math.max(0.75, (Math.min(a.length, q.length) / Math.max(a.length, q.length)) * 0.9);
  }
  if (q.includes(a) || a.includes(q)) {
    return (Math.min(a.length, q.length) / Math.max(a.length, q.length)) * 0.9;
  }
  if (a.split(' ').some((p) => p.length > 3 && q.includes(p))) return 0.55;
  return 0;
}

// Resuelve una entidad a partir de un texto crudo (comercio o descripcion de un
// movimiento) y, si el match fue por similitud (no exacto), aprende ese texto como
// alias nuevo para que la proxima vez sea un match exacto y barato. Este es el punto
// central de "que se de cuenta que uberx25151 y uber son lo mismo": la primera vez
// matchea por similitud, de ahi en adelante matchea exacto.
export async function resolveAndLearnEntity(rawText: string, tipo?: string | null) {
  const text = clean(rawText);
  if (!text) return null;
  const match = await resolveMasterEntity(text, tipo);
  if (!match || !match.entidad) return null;
  if (match.score < 0.97) {
    try { await upsertEntityAlias(match.entidad.id, text, 'auto_fuzzy'); } catch (_) { /* no bloquea el flujo principal */ }
  }
  return match.entidad as { id: string; nombre: string; tipo: string; categoria: string | null; subcategoria: string | null };
}

export async function listMasterEntities(query = '', limit = 30) {
  const q = normalizeEntityKey(query);
  const { data, error } = await supabase
    .from('entidades_maestras')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = (data || []).filter((r: any) => !q || normalizeEntityKey(`${r.nombre} ${r.tipo} ${r.categoria} ${r.subcategoria}`).includes(q));
  return rows.slice(0, limit);
}

export async function listAliases(query = '', limit = 30) {
  const q = normalizeEntityKey(query);
  const { data, error } = await supabase
    .from('entidades_aliases')
    .select('*, entidades_maestras(nombre,tipo,categoria,subcategoria)')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).filter((r: any) => !q || normalizeEntityKey(`${r.alias} ${r.entidades_maestras?.nombre || ''}`).includes(q)).slice(0, limit);
}

export async function addAliasFromText(text: string) {
  const m = String(text || '').match(/(.+?)\s*(?:=>|->|como|=)\s*(.+)/i);
  if (!m) throw new Error('Usá: /alias OPENAI *CHATGPT => OpenAI / ChatGPT');
  const alias = m[1].replace(/^agregar\s+/i, '').trim();
  const nombre = m[2].trim();
  const master = await upsertMasterEntity({ nombre, tipo: guessTipo(nombre), categoria: guessCategoria(nombre) });
  await upsertEntityAlias(master.id, alias, 'manual');
  return { alias, master };
}

export function formatMasterEntities(rows: any[]) {
  if (!rows.length) return 'Entidades maestras\n\nSin resultados.';
  return ['Entidades maestras', '', ...rows.map(r => `• ${r.nombre}\n  Tipo: ${r.tipo || '-'}\n  Categoría: ${[r.categoria, r.subcategoria].filter(Boolean).join(' / ') || '-'}`)].join('\n');
}

export function formatAliases(rows: any[]) {
  if (!rows.length) return 'Aliases\n\nSin resultados.';
  return ['Aliases', '', ...rows.map(r => `• ${r.alias}\n  → ${r.entidades_maestras?.nombre || r.entidad_id}\n  Tipo: ${r.entidades_maestras?.tipo || '-'}`)].join('\n');
}

export function formatAliasAdded(result: any) {
  return [`Alias agregado.`, '', `${result.alias} → ${result.master.nombre}`, `Tipo: ${result.master.tipo || '-'}`, `Categoría: ${[result.master.categoria, result.master.subcategoria].filter(Boolean).join(' / ') || '-'}`].join('\n');
}

function guessTipo(nombre: string) {
  const n = normalizeEntityKey(nombre);
  if (/openai|chatgpt|anthropic|claude|spotify|youtube|google one/.test(n)) return 'suscripcion';
  if (/dr gray|farmaceuticos/.test(n)) return 'empleador';
  return 'comercio';
}

function guessCategoria(nombre: string) {
  const n = normalizeEntityKey(nombre);
  if (/openai|chatgpt|anthropic|claude|spotify|youtube|google one/.test(n)) return 'Suscripciones';
  if (/coto|disco|super/.test(n)) return 'Supermercado';
  if (/arredo|gallo|jas diseno/.test(n)) return 'Casa';
  return null;
}

function clean(value: any) { return String(value || '').trim(); }
