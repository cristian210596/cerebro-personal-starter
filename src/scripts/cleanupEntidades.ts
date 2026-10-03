import 'dotenv/config';
import { supabase } from '../supabaseClient.js';
import { getNotionClient, syncNotionImportedMovements } from '../notion.js';
import { counterpartForMovement, displayName, loadEntities, normalizeText } from '../entityLinks.js';

// Limpia las entidades que creó la primera pasada de "npm run link:entidades" con la
// normalización vieja (fechas como entidad, "Payu*ar*uber", Sube/Sube Viajes/..., etc.).
//
// Solo toca entidades creadas desde --desde (por defecto 2026-10-03) que NO están vinculadas
// a ningún item/mail. Para cada una recalcula con la normalización nueva qué entidad le
// corresponde a sus movimientos:
//   - si coincide con la misma entidad -> la deja como está
//   - si no -> desvincula sus movimientos, borra la entidad, archiva su página de Notion y
//     vuelve a vincular esos movimientos (que caen en la entidad correcta o en ninguna).
//
// Uso:  npm run cleanup:entidades              -> muestra qué haría
//       npm run cleanup:entidades -- --apply   -> aplica

const APPLY = process.argv.includes('--apply');
const desdeArg = process.argv.find(a => a.startsWith('--desde='));
const DESDE = desdeArg ? desdeArg.split('=')[1] : '2026-10-03';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(APPLY ? '== MODO APLICAR ==' : '== MODO PRUEBA (no escribe nada; usar --apply para aplicar) ==');
  console.log(`Entidades creadas desde ${DESDE} y sin items vinculados.`);

  const probe = await supabase.from('finanzas_movimientos').select('id,entidad_id').limit(1);
  if (probe.error) throw new Error(`Falta la columna entidad_id: corré supabase/vinculos_entidades.sql. (${probe.error.message})`);

  const { data: recientes, error } = await supabase.from('entidades').select('*').gte('created_at', DESDE);
  if (error) throw error;
  const ids = (recientes || []).map((e: any) => e.id);
  const linked = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('item_entidades').select('entidad_id').in('entidad_id', ids.slice(i, i + 200));
    for (const r of data || []) linked.add(r.entidad_id);
  }
  const candidatas = (recientes || []).filter((e: any) => !linked.has(e.id));
  console.log(`Candidatas: ${candidatas.length}`);

  const borrar: any[] = [];
  const movsARevincular: any[] = [];
  for (const e of candidatas) {
    const { data: movs } = await supabase.from('finanzas_movimientos').select('*').eq('entidad_id', e.id);
    const nuevos = new Set<string>();
    for (const m of movs || []) {
      const cp = await counterpartForMovement(m);
      nuevos.add(cp ? normalizeText(displayName(cp.name)) : '(ninguna)');
    }
    const igual = nuevos.size === 1 && nuevos.has(normalizeText(e.nombre));
    if (igual) continue;
    borrar.push(e);
    movsARevincular.push(...(movs || []));
    console.log(`  - ${e.nombre} (${e.tipo}) | ${movs?.length || 0} mov. -> ${[...nuevos].join(', ') || 'sin movimientos'}`);
  }
  console.log(`\nEntidades a borrar/rehacer: ${borrar.length} | movimientos a revincular: ${movsARevincular.length}`);

  if (!APPLY) {
    console.log('Nada se escribió. Para aplicar: npm run cleanup:entidades -- --apply');
    return;
  }

  const notion = getNotionClient();
  for (const e of borrar) {
    await supabase.from('finanzas_movimientos').update({ entidad_id: null }).eq('entidad_id', e.id);
    await supabase.from('finanzas_deudas').update({ entidad_id: null }).eq('entidad_id', e.id);
    if (notion && e.notion_page_id) {
      try { await notion.pages.update({ page_id: e.notion_page_id, archived: true }); } catch (err) { console.warn(`No pude archivar la página de ${e.nombre}:`, (err as any)?.message); }
      await sleep(300);
    }
    const { error: delErr } = await supabase.from('entidades').delete().eq('id', e.id);
    if (delErr) console.warn(`No pude borrar ${e.nombre}:`, delErr.message);
  }

  await loadEntities(true); // que el matcher no vea las borradas
  let n = 0;
  for (const m of movsARevincular) {
    const { data: fresh } = await supabase.from('finanzas_movimientos').select('*').eq('id', m.id).maybeSingle();
    if (fresh) await syncNotionImportedMovements([fresh]);
    n += 1;
    if (n % 25 === 0) console.log(`  revinculados: ${n}/${movsARevincular.length}`);
    await sleep(350);
  }
  console.log(`Listo: ${borrar.length} entidades borradas, ${n} movimientos revinculados.`);
}

main().catch(err => {
  console.error('Error en la limpieza:', err);
  process.exit(1);
});
