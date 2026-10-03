import 'dotenv/config';
import { supabase } from '../supabaseClient.js';
import { syncNotionImportedMovements } from '../notion.js';

// Repara movimientos que la conciliación automática fundió por error.
//
// Hasta el fix de conciliación (findManualMatch), un movimiento importado se podía unir con
// otro movimiento que YA estaba vinculado a otra operación del banco, con montos de hasta
// ~3,5% (mínimo $60) de diferencia. Resultado: dos operaciones reales distintas terminaban en
// un solo registro de finanzas_movimientos (se pisaba el monto, el comprobante y el hash) y
// además la categoría que confirmaba el usuario no se aplicaba.
//
// Qué hace este script:
//  1. Busca movimientos a los que apuntan 2+ filas importadas con ID de operación
//     (comprobante) DISTINTO. Distinto ID de operación = distinta operación real.
//  2. Restaura el movimiento con los datos de la fila original (la que lo creó) y crea un
//     movimiento nuevo por cada fila que se había fundido por error.
//  3. Aplica a los movimientos conciliados la categoría que el usuario confirmó.
//  4. Actualiza/crea las páginas de Notion de todo lo que tocó.
//
// Uso:  npm run repair:conciliaciones              -> solo muestra lo que haría (no escribe)
//       npm run repair:conciliaciones -- --apply   -> aplica los cambios

const APPLY = process.argv.includes('--apply');
const BRACKET = /\s*\[importado: ([\s\S]*)\]\s*$/;

function mapImportedTypeToMovementType(type: string) {
  const t = String(type || '').toLowerCase();
  if (t.includes('pago_tarjeta')) return 'transferencia';
  if (t.includes('devolucion')) return 'devolucion';
  if (t.includes('transferencia')) return 'transferencia';
  return 'gasto';
}

function fmt(n: any) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function fetchAll(table: string, select: string, apply: (q: any) => any) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(supabase.from(table).select(select)).range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function periodOf(importacionId: string | null, cache: Map<string, string | null>) {
  if (!importacionId) return null;
  if (cache.has(importacionId)) return cache.get(importacionId) || null;
  const { data } = await supabase.from('finanzas_importaciones').select('periodo').eq('id', importacionId).maybeSingle();
  cache.set(importacionId, data?.periodo || null);
  return data?.periodo || null;
}

async function main() {
  console.log(APPLY ? '== MODO APLICAR ==' : '== MODO PRUEBA (no escribe nada; usar --apply para aplicar) ==');
  const periodCache = new Map<string, string | null>();
  const touched = new Set<string>();

  const imported = await fetchAll('finanzas_movimientos_importados', '*', q =>
    q.not('movimiento_id', 'is', null).in('estado', ['importado', 'conciliado', 'clasificado']).order('created_at', { ascending: true })
  );
  const byMovement = new Map<string, any[]>();
  for (const row of imported) {
    const list = byMovement.get(row.movimiento_id) || [];
    list.push(row);
    byMovement.set(row.movimiento_id, list);
  }

  // ---------- 1 y 2: separar operaciones fundidas ----------
  let splits = 0;
  for (const [movementId, rows] of byMovement) {
    if (rows.length < 2) continue;
    const owner = rows.find(r => r.estado !== 'conciliado') || rows[0];
    const keeperComp = owner.comprobante || rows.find(r => r.comprobante)?.comprobante || null;
    if (!keeperComp) continue;
    const intruders = rows.filter(r => r.id !== owner.id && r.comprobante && String(r.comprobante) !== String(keeperComp));
    if (!intruders.length) continue;

    const { data: mov, error: movErr } = await supabase.from('finanzas_movimientos').select('*').eq('id', movementId).single();
    if (movErr) throw movErr;

    // Descripción: mergeDescription agregaba " [importado: <otra operación>]" al final.
    const bracket = String(mov.descripcion || '').match(BRACKET);
    const restoredDesc = bracket ? String(mov.descripcion).replace(BRACKET, '') : (mov.descripcion || owner.descripcion_original);
    const restore = {
      monto: Number(owner.monto),
      moneda: owner.moneda || mov.moneda || 'ARS',
      comprobante: owner.comprobante || null,
      external_hash: owner.external_hash || null,
      movimiento_importado_id: owner.id,
      comercio: owner.comercio_detectado || mov.comercio,
      merchant_key: owner.merchant_key || mov.merchant_key || null,
      descripcion: restoredDesc,
      categoria_financiera: owner.categoria_confirmada || mov.categoria_financiera,
      subcategoria_financiera: owner.categoria_confirmada ? (owner.subcategoria_confirmada || null) : mov.subcategoria_financiera,
      updated_at: new Date().toISOString()
    };
    console.log(`\n[SEPARAR] movimiento ${movementId} (${mov.fecha_movimiento})`);
    console.log(`  hoy:      ${fmt(mov.monto)} | ${mov.comercio} | ${mov.categoria_financiera}`);
    console.log(`  restaurar: ${fmt(restore.monto)} | ${restore.comercio} | ${restore.categoria_financiera} (comprobante ${restore.comprobante})`);
    if (APPLY) {
      const { error } = await supabase.from('finanzas_movimientos').update(restore).eq('id', movementId);
      if (error) throw error;
    }
    touched.add(movementId);

    for (const row of intruders) {
      const ownDesc = bracket && intruders.length === 1 ? bracket[1] : row.descripcion_original;
      const insert = {
        fecha_movimiento: row.fecha_movimiento,
        tipo: mapImportedTypeToMovementType(row.tipo),
        monto: Number(row.monto),
        moneda: row.moneda || 'ARS',
        descripcion: ownDesc,
        categoria_financiera: row.categoria_confirmada || row.categoria_sugerida || 'Otros',
        subcategoria_financiera: row.categoria_confirmada ? (row.subcategoria_confirmada || null) : (row.subcategoria_sugerida || null),
        medio_pago: row.tarjeta ? `${row.tarjeta} crédito` : row.proveedor || null,
        tarjeta: row.tarjeta || null,
        banco_billetera: row.proveedor || null,
        comercio: row.comercio_detectado || row.descripcion_original,
        cuotas: row.cuotas_totales || null,
        estado: 'confirmado',
        origen: 'importacion',
        importacion_id: row.importacion_id,
        movimiento_importado_id: row.id,
        external_hash: row.external_hash,
        comprobante: row.comprobante,
        cuota_actual: row.cuota_actual,
        cuotas_totales: row.cuotas_totales,
        periodo_resumen: await periodOf(row.importacion_id, periodCache),
        merchant_key: row.merchant_key
      };
      console.log(`  crear:    ${row.fecha_movimiento} | ${fmt(insert.monto)} | ${insert.comercio} | ${insert.categoria_financiera} (comprobante ${insert.comprobante})`);
      if (APPLY) {
        const { data: created, error } = await supabase.from('finanzas_movimientos').insert(insert).select().single();
        if (error) throw error;
        await supabase.from('finanzas_conciliaciones').delete().eq('movimiento_importado_id', row.id);
        const { error: upErr } = await supabase.from('finanzas_movimientos_importados')
          .update({ estado: 'importado', movimiento_id: created.id, match_score: null, match_reason: null, updated_at: new Date().toISOString() })
          .eq('id', row.id);
        if (upErr) throw upErr;
        touched.add(created.id);
      }
      splits += 1;
    }
  }

  // ---------- 3: categoría confirmada que no se aplicó al conciliar ----------
  let recats = 0;
  const conciliated = imported.filter(r => r.estado === 'conciliado' && r.categoria_confirmada);
  for (const row of conciliated) {
    const { data: mov } = await supabase.from('finanzas_movimientos').select('id,fecha_movimiento,monto,comercio,categoria_financiera,subcategoria_financiera,movimiento_importado_id').eq('id', row.movimiento_id).maybeSingle();
    if (!mov || mov.movimiento_importado_id !== row.id) continue; // no es el dueño actual (o se separó recién)
    const sub = row.subcategoria_confirmada || null;
    if (mov.categoria_financiera === row.categoria_confirmada && (mov.subcategoria_financiera || null) === sub) continue;
    console.log(`\n[CATEGORÍA] ${mov.fecha_movimiento} | ${fmt(mov.monto)} | ${mov.comercio}: ${mov.categoria_financiera}${mov.subcategoria_financiera ? ' / ' + mov.subcategoria_financiera : ''} -> ${row.categoria_confirmada}${sub ? ' / ' + sub : ''}`);
    if (APPLY) {
      const { error } = await supabase.from('finanzas_movimientos')
        .update({ categoria_financiera: row.categoria_confirmada, subcategoria_financiera: sub, updated_at: new Date().toISOString() })
        .eq('id', mov.id);
      if (error) throw error;
    }
    touched.add(mov.id);
    recats += 1;
  }

  // ---------- 4: Notion ----------
  let notionSynced = 0;
  if (APPLY && touched.size) {
    const { data: rows, error } = await supabase.from('finanzas_movimientos').select('*').in('id', [...touched]);
    if (error) throw error;
    const res = await syncNotionImportedMovements(rows || []);
    notionSynced = res.movimientos;
  }

  console.log(`\nResumen: ${splits} operación(es) separada(s), ${recats} categoría(s) corregida(s), ${touched.size} movimiento(s) tocados${APPLY ? `, ${notionSynced} sincronizado(s) en Notion` : ''}.`);
  if (!APPLY) console.log('Nada se escribió. Para aplicar: npm run repair:conciliaciones -- --apply');
}

main().catch(err => {
  console.error('Error en la reparación:', err);
  process.exit(1);
});
