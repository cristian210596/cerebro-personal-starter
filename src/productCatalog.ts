import { supabase } from './supabaseClient.js';
import { resolveEntityByName } from './entityLinks.js';

// Catálogo de productos para el historial de precios.
//
// Clave del producto:
//  1. Código de barras (EAN/GTIN) si el ticket lo trae: es el mismo en Coto, Día, Disco, etc.
//     Coto imprime "0000508195 07793253003760": código interno + GTIN-14; se queda el GTIN
//     válido (dígito verificador) y se lo pasa a EAN-13.
//  2. Si no hay código: la descripción normalizada. Se agrupa con otra descripción solo si
//     todas las palabras de la más corta están en la más larga Y los números (tamaños: 500,
//     1, 2250...) coinciden, para no mezclar "Fideos 500 g" con "Fideos 1 kg".

export type ProductRow = {
  id: string;
  ean: string | null;
  clave_normalizada: string;
  nombre: string;
  alias: string[] | null;
  marca: string | null;
  marca_entidad_id: string | null;
  categoria: string | null;
  subcategoria: string | null;
  notion_page_id: string | null;
  tipo_producto?: string | null;
  contenido?: number | null;
  unidad?: string | null;
};

const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'con', 'sin', 'para', 'x']);

function norm(v: unknown) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function productKey(desc: unknown) { return norm(desc); }

function tokens(desc: unknown) {
  return [...new Set(norm(desc).split(' ').filter(t => t && !STOP.has(t) && (t.length >= 2 || /^\d+$/.test(t))))];
}

function gtinValid(code: string) {
  if (![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function normalizeEan(codigo: unknown): string | null {
  const parts = String(codigo || '').split(/[^0-9]+/).filter(Boolean);
  for (const raw of parts.sort((a, b) => b.length - a.length)) {
    let c = raw;
    if (c.length === 14 && c.startsWith('0')) c = c.slice(1);
    if (gtinValid(c) && !/^0+$/.test(c)) return c.length === 12 ? `0${c}` : c;
  }
  return null;
}

export function sameProductByName(a: string, b: string) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.slice().sort().join(' ') === tb.slice().sort().join(' ')) return true;
  const small = ta.length <= tb.length ? ta : tb;
  const large = ta.length <= tb.length ? tb : ta;
  const words = small.filter(t => !/^\d+$/.test(t));
  if (words.length < 2) return false;
  const numsA = ta.filter(t => /^\d+$/.test(t)).sort().join(',');
  const numsB = tb.filter(t => /^\d+$/.test(t)).sort().join(',');
  if (numsA !== numsB) return false;
  return words.every(t => large.some(l => l === t || (t.length >= 4 && l.length >= 4 && (l.startsWith(t) || t.startsWith(l)))));
}

export function netUnitPrice(importe: unknown, descuento: unknown, cantidad: unknown): number | null {
  const imp = Number(importe);
  if (!Number.isFinite(imp)) return null;
  const desc = Math.abs(Number(descuento || 0)) || 0;
  const qty = Number(cantidad) > 0 ? Number(cantidad) : 1;
  return Math.round(((imp - desc) / qty) * 100) / 100;
}

let cache: { at: number; rows: ProductRow[] } | null = null;
async function loadProducts(force = false): Promise<ProductRow[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.rows;
  const rows: ProductRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('productos').select('*').range(from, from + 999);
    if (error) throw error;
    rows.push(...((data || []) as ProductRow[]));
    if (!data || data.length < 1000) break;
  }
  cache = { at: Date.now(), rows };
  return rows;
}

async function brandEntityId(marca: string | null | undefined) {
  if (!marca) return null;
  try { return (await resolveEntityByName(marca, { tipo: 'Marca' }))?.entity.id || null; } catch { return null; }
}

export async function resolveProduct(item: any): Promise<ProductRow | null> {
  const desc = String(item?.descripcion || '').trim();
  if (!desc) return null;
  const ean = normalizeEan(item?.codigo);
  const clave = productKey(desc);
  const products = await loadProducts();

  let found: ProductRow | undefined;
  if (ean) found = products.find(p => p.ean === ean);
  if (!found) found = products.find(p => !p.ean && (p.clave_normalizada === clave || [p.nombre, ...(p.alias || [])].some(n => sameProductByName(desc, n))));
  if (!found && !ean) found = products.find(p => p.clave_normalizada === clave);

  if (found) {
    const patch: any = {};
    if (ean && !found.ean) patch.ean = ean;
    const alias = new Set(found.alias || []);
    if (productKey(found.nombre) !== clave && ![...alias].some(a => productKey(a) === clave)) { alias.add(desc); patch.alias = [...alias].slice(0, 30); }
    if (!found.marca && item.marca) { patch.marca = item.marca; patch.marca_entidad_id = await brandEntityId(item.marca); }
    if (!found.categoria && item.categoria) { patch.categoria = item.categoria; patch.subcategoria = item.subcategoria || null; }
    if (!found.tipo_producto) { const tipo = productTipo(desc); if (tipo) patch.tipo_producto = tipo; }
    if (found.contenido == null) { const c = productContent(desc); if (c) { patch.contenido = c.contenido; patch.unidad = c.unidad; } }
    if (Object.keys(patch).length) {
      const { data } = await supabase.from('productos').update({ ...patch, notion_sync_pending: true, updated_at: new Date().toISOString() }).eq('id', found.id).select().single();
      if (data) Object.assign(found, data);
    }
    return found;
  }

  const { data, error } = await supabase.from('productos').insert({
    ean,
    clave_normalizada: clave,
    nombre: desc,
    marca: item.marca || null,
    marca_entidad_id: await brandEntityId(item.marca),
    categoria: item.categoria || null,
    subcategoria: item.subcategoria || null,
    tipo_producto: productTipo(desc),
    contenido: productContent(desc)?.contenido ?? null,
    unidad: productContent(desc)?.unidad ?? null
  }).select().single();
  if (error) {
    const fresh = await loadProducts(true);
    const again = fresh.find(p => (ean && p.ean === ean) || (!p.ean && p.clave_normalizada === clave));
    if (again) return again;
    throw error;
  }
  products.push(data as ProductRow);
  return data as ProductRow;
}

// Vincula cada ítem de un comprobante con su producto y calcula el precio unitario pagado.
export async function linkComprobanteItemsToProducts(comprobanteId: string): Promise<number> {
  try {
    const { data: items, error } = await supabase.from('finanzas_comprobante_items').select('*').eq('comprobante_id', comprobanteId);
    if (error) throw error;
    let n = 0;
    const touched = new Set<string>();
    for (const it of items || []) {
      const product = await resolveProduct(it);
      const neto = netUnitPrice(it.importe, it.descuento, it.cantidad);
      const patch: any = { precio_unitario_neto: neto };
      if (product) { patch.producto_id = product.id; touched.add(product.id); }
      const { error: upErr } = await supabase.from('finanzas_comprobante_items').update(patch).eq('id', it.id);
      if (!upErr && product) n += 1;
    }
    if (touched.size) await supabase.from('productos').update({ notion_sync_pending: true }).in('id', [...touched]);
    return n;
  } catch (error) {
    console.error('No pude vincular los productos del comprobante (¿falta correr supabase/productos.sql?):', (error as any)?.message || error);
    return 0;
  }
}

export type PricePoint = { fecha: string | null; comercio: string | null; sucursal: string | null; precio: number | null; precio_lista: number | null; descuento: number | null; cantidad: number | null };

export async function priceHistory(query: string, limit = 60) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, message: 'Decime el producto o el código de barras.' };
  const ean = normalizeEan(q);
  const products = await loadProducts();
  const matches = ean
    ? products.filter(p => p.ean === ean)
    : products.filter(p => {
        const k = productKey(q);
        return [p.nombre, ...(p.alias || [])].some(n => productKey(n).includes(k)) || (p.marca && productKey(p.marca).includes(k)) || (p.tipo_producto && productKey(p.tipo_producto).includes(k));
      });
  if (!matches.length) return { ok: true, productos: [], message: `No encontré productos para "${q}".` };

  const out = [] as any[];
  for (const p of matches.slice(0, 20)) {
    const { data, error } = await supabase
      .from('finanzas_comprobante_items')
      .select('cantidad, precio_unitario, descuento, precio_unitario_neto, importe, finanzas_comprobantes!inner(fecha_emision, comercio, sucursal)')
      .eq('producto_id', p.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    const puntos: PricePoint[] = (data || []).map((r: any) => ({
      fecha: r.finanzas_comprobantes?.fecha_emision || null,
      comercio: r.finanzas_comprobantes?.comercio || null,
      sucursal: r.finanzas_comprobantes?.sucursal || null,
      precio: r.precio_unitario_neto ?? netUnitPrice(r.importe, r.descuento, r.cantidad),
      precio_lista: r.precio_unitario ?? null,
      descuento: r.descuento ?? null,
      cantidad: r.cantidad ?? null
    })).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
    const precios = puntos.map(x => x.precio).filter((x): x is number => typeof x === 'number');
    const porComercio: Record<string, { ultimo: number | null; minimo: number | null; compras: number }> = {};
    for (const pt of puntos) {
      const k = pt.comercio || 'Sin comercio';
      const e = porComercio[k] || { ultimo: null, minimo: null, compras: 0 };
      e.compras += 1;
      e.ultimo = pt.precio;
      if (pt.precio != null) e.minimo = e.minimo == null ? pt.precio : Math.min(e.minimo, pt.precio);
      porComercio[k] = e;
    }
    const ultimo = precios.length ? precios[precios.length - 1] : null;
    out.push({
      producto: p.nombre, ean: p.ean, marca: p.marca, categoria: p.categoria,
      tipo_producto: p.tipo_producto || null,
      contenido: p.contenido ?? null, unidad: p.unidad ?? null,
      precio_por_unidad_base: ultimo != null && p.contenido ? Math.round((ultimo / Number(p.contenido)) * 100) / 100 : null,
      compras: puntos.length,
      ultimo_precio: precios.length ? precios[precios.length - 1] : null,
      precio_minimo: precios.length ? Math.min(...precios) : null,
      precio_maximo: precios.length ? Math.max(...precios) : null,
      por_comercio: porComercio,
      historial: puntos
    });
  }
  return { ok: true, productos: out };
}

// Corrige/agrega códigos de barras a ítems ya cargados (ej: tickets cargados sin código).
export async function setComprobanteItemCodes(comprobanteId: string, codes: { descripcion: string; codigo: string }[]) {
  const { data: items, error } = await supabase.from('finanzas_comprobante_items').select('id, descripcion, codigo').eq('comprobante_id', comprobanteId);
  if (error) throw error;
  let updated = 0;
  const sinMatch: string[] = [];
  for (const c of codes) {
    const it = (items || []).find((i: any) => productKey(i.descripcion) === productKey(c.descripcion)) ||
               (items || []).find((i: any) => productKey(i.descripcion).includes(productKey(c.descripcion)));
    if (!it) { sinMatch.push(c.descripcion); continue; }
    const { error: upErr } = await supabase.from('finanzas_comprobante_items').update({ codigo: c.codigo, producto_id: null }).eq('id', it.id);
    if (!upErr) updated += 1;
  }
  cache = null;
  const linked = await linkComprobanteItemsToProducts(comprobanteId);
  return { updated, linked, sinMatch };
}


// ---------- Tipo genérico y contenido ----------
// El tipo agrupa marcas distintas del mismo producto ("LECHE ... CONAPROLE" y "LECHE ... SERENISIMA"
// son "Leche"). Se evalúa en orden: lo más específico primero ("Crema de leche" antes que "Leche").
const TIPOS: [RegExp, string][] = [
  [/\bcrema\b.*\bleche\b|\bcrema de leche\b/, 'Crema de leche'],
  [/\bdulce de leche\b/, 'Dulce de leche'],
  [/\bleche\b/, 'Leche'],
  [/\byogur|\byogh?urt/, 'Yogur'],
  [/\bmanteca\b/, 'Manteca'],
  [/\bqueso\b/, 'Queso'],
  [/\byerba\b/, 'Yerba mate'],
  [/\bfideos?\b|\bspaghetti|\bmostachol|\btallarin/, 'Fideos'],
  [/\barroz\b/, 'Arroz'],
  [/\baceite\b/, 'Aceite'],
  [/\bagua\b/, 'Agua'],
  [/\bgaseosa|\bcoca cola\b|\bsprite\b|\bpepsi\b/, 'Gaseosa'],
  [/\bvino\b/, 'Vino'],
  [/\bcerveza\b/, 'Cerveza'],
  [/\bgalletitas?\b|\bgall\b|\bcrackers?\b/, 'Galletitas'],
  [/\bpan\b/, 'Pan'],
  [/\btorta\b|\bbizcochuelo\b/, 'Torta / bizcochuelo'],
  [/\bmayonesa/, 'Mayonesa'],
  [/\bpure de tomate|\bpure tomate|\bpure de tomatela\b|\btomate triturado/, 'Puré de tomate'],
  [/\blavandina\b/, 'Lavandina'],
  [/\bdetergente\b/, 'Detergente'],
  [/\blim cr\b|\blimpiador\b|\bcif\b/, 'Limpiador'],
  [/\bguantes?\b/, 'Guantes de limpieza'],
  [/\bfranela\b|\bpano\b|\brejilla\b/, 'Paños / franelas'],
  [/\brollo d?\s*cocina\b|\brollo de cocina\b/, 'Rollo de cocina'],
  [/\bp higienico\b|\bpapel higienico\b/, 'Papel higiénico'],
  [/\bsensodyne\b|\bcrema dental\b|\bpasta dental\b|\bcolgate\b/, 'Pasta dental'],
  [/\bcepillo dental\b/, 'Cepillo dental'],
  [/\bantitran|\bantitranspirante\b|\bdesodorante\b|\brexona\b/, 'Desodorante / antitranspirante'],
  [/\bjabon\b/, 'Jabón'],
  [/\bshampoo\b|\bacondicionador\b/, 'Shampoo / acondicionador'],
  [/\btalco\b/, 'Talco'],
  [/\bcafe\b/, 'Café'],
  [/\bazucar\b/, 'Azúcar'],
  [/\bharina\b/, 'Harina'],
  [/\bhuevos?\b/, 'Huevos']
];

export function productTipo(desc: unknown): string | null {
  const t = norm(desc);
  for (const [re, tipo] of TIPOS) if (re.test(t)) return tipo;
  return null;
}

// Contenido en unidad base: "1,5 LTR" -> 1.5 l; "500 GRM" -> 0.5 kg; "2250 CMQ" -> 2.25 l; "X4 UNI" -> 4 u.
export function productContent(desc: unknown): { contenido: number; unidad: 'l' | 'kg' | 'u' } | null {
  const t = String(desc || '').toUpperCase().replace(/(\d),(\d)/g, '$1.$2');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(LTR|LTS|LT|L|ML|CC|CMQ|KGM|KG|KGS|GRM|GR|G|GRS)\b/);
  if (m) {
    const n = Number(m[1]);
    const u = m[2];
    if (!Number.isFinite(n) || n <= 0) return null;
    if (['LTR', 'LTS', 'LT', 'L'].includes(u)) return { contenido: n, unidad: 'l' };
    if (['ML', 'CC', 'CMQ'].includes(u)) return { contenido: n / 1000, unidad: 'l' };
    if (['KGM', 'KG', 'KGS'].includes(u)) return { contenido: n, unidad: 'kg' };
    return { contenido: n / 1000, unidad: 'kg' };
  }
  const u = t.match(/\bX\s?(\d+)\s*(UNI|U)\b/);
  if (u) return { contenido: Number(u[1]), unidad: 'u' };
  return null;
}
