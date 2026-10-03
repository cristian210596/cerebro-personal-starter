import 'dotenv/config';
import { supabase } from '../supabaseClient.js';
import { getNotionClient, linkItemEntitiesInNotion, relinkArchivoInNotion, relinkCalendarioInNotion, syncNotionDebtsAndSplits, syncNotionImportedMovements } from '../notion.js';
import { counterpartForMovement, isSelf, loadEntities, pickEntity, guessTipo, displayName, linkComprobanteEntity, linkSueldoEntity } from '../entityLinks.js';

// Vincula TODO lo que ya existe con sus entidades (Supabase + relaciones en Notion):
// movimientos, deudas, gastos compartidos e items (mails, notas).
//
// Uso:  npm run link:entidades              -> muestra qué vincularía y qué entidades crearía
//       npm run link:entidades -- --apply   -> aplica (puede tardar: respeta el límite de Notion)
//
// Antes de --apply conviene correr supabase/vinculos_entidades.sql (agrega entidad_id y
// notion_page_id). Sin eso igual vincula en Notion, pero no queda guardado en Supabase.

const APPLY = process.argv.includes('--apply');
// --solo=movimientos,items,deudas,comprobantes,sueldos,archivos,calendario  (por defecto: todo)
const soloArg = process.argv.find(a => a.startsWith('--solo='));
const SOLO = soloArg ? new Set(soloArg.split('=')[1].split(',').map(x => x.trim())) : null;
const fase = (name: string) => !SOLO || SOLO.has(name);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchAll(table: string, apply: (q: any) => any = q => q) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await apply(supabase.from(table).select('*')).range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(APPLY ? '== MODO APLICAR ==' : '== MODO PRUEBA (no escribe nada; usar --apply para aplicar) ==');
  const entities = await loadEntities(true);
  console.log(`Entidades existentes: ${entities.length}`);

  // ---- Movimientos ----
  const movimientos = await fetchAll('finanzas_movimientos', q => q.order('fecha_movimiento', { ascending: true }));
  const plan = { vincular: 0, crear: new Map<string, string>(), sin: 0 };
  for (const m of fase('movimientos') ? movimientos : []) {
    const cp = await counterpartForMovement(m);
    if (!cp || isSelf(cp.name)) { plan.sin += 1; continue; }
    const hit = pickEntity(cp.name, entities, cp.tipo || guessTipo(cp.raw, cp.name));
    if (hit) {
      plan.vincular += 1;
      if (!APPLY) console.log(`  ${m.fecha_movimiento} ${String(m.monto).padStart(10)} ${cp.name}  ->  ${hit.entity.nombre}`);
    } else {
      const key = displayName(cp.name);
      if (!plan.crear.has(key)) plan.crear.set(key, cp.tipo || guessTipo(cp.raw, cp.name));
      if (!APPLY) console.log(`  ${m.fecha_movimiento} ${String(m.monto).padStart(10)} ${cp.name}  ->  (nueva) ${key}`);
    }
  }
  console.log(`\nMovimientos: ${movimientos.length} | con entidad existente: ${plan.vincular} | sin contraparte (rendimientos, pagos de tarjeta...): ${plan.sin}`);
  console.log(`Entidades nuevas a crear: ${plan.crear.size}`);
  for (const [n, t] of plan.crear) console.log(`  + ${n} (${t})`);

  const deudas = await fetchAll('finanzas_deudas');
  const particiones = await fetchAll('finanzas_particiones').catch(() => []);
  const items = await fetchAll('items', q => q.not('notion_page_id', 'is', null));
  const itemsConEntidades = items.filter(i => Array.isArray(i.entidades_json) && i.entidades_json.some((e: any) => e?.nombre && !isSelf(e.nombre)));
  const comprobantes = await fetchAll('finanzas_comprobantes').catch(() => []);
  const sueldos = await fetchAll('sueldos_recibos').catch(() => []);
  const archivos = await fetchAll('archivos').catch(() => []);
  console.log(`Deudas: ${deudas.length} | Gastos compartidos: ${particiones.length} | Items con entidades: ${itemsConEntidades.length}`);
  console.log(`Comprobantes: ${comprobantes.length} | Recibos de sueldo: ${sueldos.length} | Archivos: ${archivos.length} | Calendario: se recorre en Notion`);
  if (SOLO) console.log(`Fases: ${[...SOLO].join(', ')}`);

  if (!APPLY) {
    console.log('\nNada se escribió. Para aplicar: npm run link:entidades -- --apply');
    return;
  }

  const notion = getNotionClient();
  if (!notion) throw new Error('Falta NOTION_TOKEN.');

  let n = 0;
  for (const m of fase('movimientos') ? movimientos : []) {
    await syncNotionImportedMovements([m]);
    n += 1;
    if (n % 25 === 0) console.log(`  movimientos: ${n}/${movimientos.length}`);
    await sleep(350);
  }
  console.log(`Movimientos procesados: ${n}`);

  const ds = fase('deudas') ? await syncNotionDebtsAndSplits(deudas, particiones) : { deudas: 0, particiones: 0 };
  console.log(`Deudas: ${ds.deudas} | Gastos compartidos: ${ds.particiones}`);

  let it = 0;
  for (const item of fase('items') ? itemsConEntidades : []) {
    await linkItemEntitiesInNotion(notion, item);
    it += 1;
    if (it % 25 === 0) console.log(`  items: ${it}/${itemsConEntidades.length}`);
    await sleep(350);
  }
  console.log(`Items vinculados: ${it}`);

  if (fase('comprobantes')) {
    let c = 0;
    for (const comp of comprobantes) { if (await linkComprobanteEntity(comp)) c += 1; }
    console.log(`Comprobantes vinculados: ${c}/${comprobantes.length}`);
  }
  if (fase('sueldos')) {
    let r = 0;
    for (const rec of sueldos) { if (await linkSueldoEntity(rec)) r += 1; }
    console.log(`Recibos de sueldo vinculados: ${r}/${sueldos.length}`);
  }
  if (fase('archivos')) {
    let a = 0;
    for (const arch of archivos) {
      if (await relinkArchivoInNotion(arch)) a += 1;
      await sleep(350);
      if ((a + 1) % 25 === 0) console.log(`  archivos: ${a}`);
    }
    console.log(`Archivos vinculados en Notion: ${a}/${archivos.length}`);
  }
  if (fase('calendario')) {
    console.log(`Eventos de calendario vinculados: ${await relinkCalendarioInNotion()}`);
  }
  console.log('Listo.');
}

main().catch(err => {
  console.error('Error vinculando entidades:', err);
  process.exit(1);
});
