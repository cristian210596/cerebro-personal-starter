import 'dotenv/config';
import { supabase } from '../supabaseClient.js';
import { getNotionClient, syncNotionImportedMovements } from '../notion.js';

// V00 — Corrige el "tipo" de movimientos ya cargados con la lógica nueva y limpia basura del
// parser de PDFs de Mercado Pago. NO toca montos ni signos (el hash de importación usa el monto).
//
//  a) Transferencia ENVIADA (monto < 0) con categoría de consumo           -> tipo gasto
//  b) Línea negativa de TARJETA guardada como gasto (anulación/reintegro)  -> tipo devolucion
//  c) Plata RECIBIDA (monto > 0, sin tarjeta) guardada como gasto           -> tipo transferencia
//  d) "Rendimientos" positivos guardados como gasto                         -> tipo ingreso
//  e) Basura del PDF de MP (pie "Mercado Libre S.R.L. CUIT 30-70308853…")   -> se borra el movimiento
//     y la fila importada (también las pendientes) queda "ignorado"
//  g) Pase entre cuentas propias (categoría) guardado como gasto       -> tipo transferencia
//  f) Posibles duplicados (misma fecha, monto, moneda, tarjeta y descripción en importaciones
//     distintas) -> SOLO se informan, no se borran.
//
// Uso:  npm run fix:movimientos              -> muestra qué haría (no escribe)
//       npm run fix:movimientos -- --apply   -> aplica y re-sincroniza Notion

const APPLY = process.argv.includes('--apply');
const norm = (v: unknown) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const NON_SPENDING_CATEGORY_RE = /^(transferencias?|deudas \/ compartidos|ingresos?|ingreso laboral|inversion(es)?|ahorro|rendimientos?|sin (categoria|clasificar))/;
const INTERNAL_CATEGORY_RE = /cuentas propias|pases? de la cuenta/;
const JUNK_RE = /CUIT\s*30-?70308853|Encuentra nuestros canales|FechaDescripci/i;
const RECIBIDO_RE = /^(transferencia recibida|dinero recibido|devolucion de transferencia)/;
const PAGO_TARJETA_RE = /pago tarjeta|su pago|pago en pesos|payment/;

async function fetchAll(table: string, filter?: (q: any) => any) {
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select('*');
    if (filter) q = filter(q);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

const fmt = (m: any) => `${m.fecha_movimiento} | ${m.monto} ${m.moneda || 'ARS'} | ${m.tipo} | ${m.categoria_financiera || '-'} | ${String(m.comercio || m.descripcion || '').slice(0, 60)} | ${m.id}`;

async function main() {
  console.log(APPLY ? '== MODO APLICAR ==' : '== MODO PRUEBA (no escribe nada; usar --apply para aplicar) ==');
  const movs = await fetchAll('finanzas_movimientos');
  const cambios: { m: any; nuevo: string; regla: string }[] = [];
  const basura: any[] = [];

  for (const m of movs) {
    const monto = Number(m.monto || 0);
    const desc = norm(String(m.descripcion || '').split(' [importado:')[0]);
    const cat = norm(m.categoria_financiera);
    if (JUNK_RE.test(String(m.descripcion || '')) || JUNK_RE.test(String(m.comercio || ''))) { basura.push(m); continue; }

    if (m.tipo === 'gasto' && !m.tarjeta && INTERNAL_CATEGORY_RE.test(cat)) {
      cambios.push({ m, nuevo: 'transferencia', regla: 'g) pase entre cuentas propias guardado como gasto' });
    } else if (m.tipo === 'gasto' && !m.tarjeta && monto > 0 && /^rendimientos?/.test(cat)) {
      cambios.push({ m, nuevo: 'ingreso', regla: 'd) rendimientos' });
    } else if (m.tipo === 'transferencia' && monto < 0 && cat && !NON_SPENDING_CATEGORY_RE.test(cat) && !PAGO_TARJETA_RE.test(desc)) {
      cambios.push({ m, nuevo: 'gasto', regla: 'a) transferencia enviada con categoría de consumo' });
    } else if (m.tipo === 'gasto' && m.tarjeta && monto < 0) {
      cambios.push({ m, nuevo: 'devolucion', regla: 'b) línea negativa de tarjeta' });
    } else if (m.tipo === 'gasto' && !m.tarjeta && monto > 0 && RECIBIDO_RE.test(desc)) {
      cambios.push({ m, nuevo: 'transferencia', regla: 'c) plata recibida guardada como gasto' });
    } else if (m.tipo === 'gasto' && !m.tarjeta && monto > 0 && /^rendimientos?\b/.test(desc)) {
      cambios.push({ m, nuevo: 'ingreso', regla: 'd) rendimientos' });
    }
  }

  const porRegla = new Map<string, typeof cambios>();
  for (const c of cambios) porRegla.set(c.regla, [...(porRegla.get(c.regla) || []), c]);
  for (const [regla, lista] of porRegla) {
    console.log(`\n${regla}: ${lista.length}`);
    for (const c of lista) console.log(`  - ${fmt(c.m)}  -> ${c.nuevo}`);
  }
  console.log(`\ne) Basura del PDF de MP a borrar: ${basura.length}`);
  for (const m of basura) console.log(`  - ${fmt(m)}`);

  const pendientesBasura = (await fetchAll('finanzas_movimientos_importados', q => q.in('estado', ['pendiente', 'pendiente_revision', 'requiere_revision'])))
    .filter(r => JUNK_RE.test(String(r.descripcion_original || '')) || JUNK_RE.test(String(r.comercio_detectado || '')));
  console.log(`   Filas importadas pendientes con esa basura (pasan a ignorado): ${pendientesBasura.length}`);

  // f) duplicados
  const byKey = new Map<string, any[]>();
  for (const m of movs) {
    if (m.origen !== 'importacion' || !m.importacion_id) continue;
    const k = [m.fecha_movimiento, Number(m.monto).toFixed(2), m.moneda || 'ARS', m.tarjeta || '', norm(String(m.descripcion || '').split(' [importado:')[0])].join('|');
    byKey.set(k, [...(byKey.get(k) || []), m]);
  }
  const dups = [...byKey.values()].filter(g => new Set(g.map(m => m.importacion_id)).size > 1);
  console.log(`\nf) Posibles duplicados entre importaciones distintas (solo informe): ${dups.length}`);
  for (const g of dups) { console.log('  *'); for (const m of g) console.log(`    - ${fmt(m)} | importacion ${m.importacion_id}`); }

  if (!APPLY) { console.log('\nNada se escribió. Para aplicar: npm run fix:movimientos -- --apply'); return; }

  const now = () => new Date().toISOString();
  let okTipos = 0;
  for (const c of cambios) {
    const { data, error } = await supabase.from('finanzas_movimientos').update({ tipo: c.nuevo, updated_at: now() }).eq('id', c.m.id).select().single();
    if (error) { console.warn(`No pude actualizar ${c.m.id}:`, error.message); continue; }
    okTipos += 1;
    try { await syncNotionImportedMovements([data]); } catch (e) { console.warn('Notion:', (e as any)?.message); }
  }

  const notion = getNotionClient();
  let okBasura = 0;
  for (const m of basura) {
    if (notion && m.notion_page_id) {
      try { await notion.pages.update({ page_id: m.notion_page_id, archived: true }); } catch (e) { console.warn('No pude archivar en Notion:', (e as any)?.message); }
    }
    await supabase.from('finanzas_movimientos_importados').update({ estado: 'ignorado', movimiento_id: null, updated_at: now() }).eq('movimiento_id', m.id);
    await supabase.from('finanzas_comprobantes').update({ movimiento_financiero_id: null }).eq('movimiento_financiero_id', m.id);
    const { error } = await supabase.from('finanzas_movimientos').delete().eq('id', m.id);
    if (error) console.warn(`No pude borrar ${m.id}:`, error.message); else okBasura += 1;
  }
  for (const r of pendientesBasura) {
    await supabase.from('finanzas_movimientos_importados').update({ estado: 'ignorado', updated_at: now() }).eq('id', r.id);
  }
  console.log(`\nListo: ${okTipos}/${cambios.length} tipos corregidos, ${okBasura}/${basura.length} movimientos basura borrados, ${pendientesBasura.length} pendientes basura ignorados.`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
