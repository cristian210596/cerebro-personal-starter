import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../supabaseClient.js';
import { getNotionClient, linkItemEntitiesInNotion, syncNotionImportedMovements } from '../notion.js';
import { loadEntities, normalizeText, planEntityMerges } from '../entityLinks.js';

// Une entidades duplicadas (las ~3800 que se fueron creando desde mails con nombres distintos
// para la misma persona/empresa: "Daniel Daverio" / "Daverio Daniel Emilio",
// "M. De Los Angeles Mendoza" / "Maria De Los Angeles Mendoza", etc.).
//
// Criterio (conservador):
//  - Solo une dentro de la misma familia: personas con personas; empresas/comercios/marcas
//    entre sí; cualquier otro tipo (producto, equipo, documento...) solo con su mismo tipo.
//  - Une si los tokens del nombre más corto están TODOS en el más largo (sin importar orden),
//    o si los nombres son iguales sin espacios. Un solo token: solo igualdad exacta.
//  - Agrupa en estrella alrededor del nombre más completo. Si un nombre calza con 2 grupos
//    distintos (ej: "Juan Carlos" con "Juan Carlos Pérez" y "Juan Carlos Gómez") NO se une.
//  - Se conserva la entidad con más vínculos (mails/movimientos); las demás pasan a ser alias.
//
// Uso:  npm run dedupe:entidades              -> genera dedupe-entidades-plan.txt (no escribe)
//       npm run dedupe:entidades -- --apply   -> aplica (une en Supabase, archiva duplicados en
//                                                Notion y revincula mails/movimientos afectados)

const APPLY = process.argv.includes('--apply');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function fetchAll(table: string, select: string) {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(APPLY ? '== MODO APLICAR ==' : '== MODO PRUEBA (no escribe nada; usar --apply para aplicar) ==');
  const entities = await loadEntities(true);
  const itemLinks = await fetchAll('item_entidades', 'item_id,entidad_id');
  const movLinks = await fetchAll('finanzas_movimientos', 'id,entidad_id').catch(() => []);
  const links = new Map<string, number>();
  for (const r of itemLinks) links.set(r.entidad_id, (links.get(r.entidad_id) || 0) + 1);
  for (const r of movLinks) if (r.entidad_id) links.set(r.entidad_id, (links.get(r.entidad_id) || 0) + 1);
  console.log(`Entidades: ${entities.length} | vínculos con mails: ${itemLinks.length}`);

  const { merges, ambiguos } = planEntityMerges(entities, links);
  const totalLosers = merges.reduce((n, m) => n + m.losers.length, 0);

  const lines = merges.map(m => `${m.keeper.nombre} [${m.keeper.tipo}] (${links.get(m.keeper.id) || 0} vínc.)  <=  ${m.losers.map(l => `${l.nombre} (${links.get(l.id) || 0})`).join(' | ')}`);
  const planPath = path.resolve(process.cwd(), 'dedupe-entidades-plan.txt');
  fs.writeFileSync(planPath, lines.join('\n') + '\n', 'utf8');
  console.log(`\nGrupos a unir: ${merges.length} | entidades que desaparecen: ${totalLosers} | nombres ambiguos que se dejan sin unir: ${ambiguos}`);
  console.log(`Plan completo: ${planPath}`);
  for (const l of lines.slice(0, 40)) console.log('  ' + l);
  if (lines.length > 40) console.log(`  ... y ${lines.length - 40} más (ver archivo)`);

  if (!APPLY) { console.log('\nNada se escribió. Para aplicar: npm run dedupe:entidades -- --apply'); return; }

  const notion = getNotionClient();
  const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'notion-databases.json'), 'utf8'));
  const affectedItems = new Set<string>();
  const affectedMovs = new Set<string>();
  let done = 0;

  for (const { keeper, losers } of merges) {
    const alias = new Set<string>(keeper.alias || []);
    for (const l of losers) {
      if (normalizeText(l.nombre) !== normalizeText(keeper.nombre)) alias.add(String(l.nombre));
      for (const a of l.alias || []) if (normalizeText(a) !== normalizeText(keeper.nombre)) alias.add(a);

      const { data: rows } = await supabase.from('item_entidades').select('item_id').eq('entidad_id', l.id);
      for (const r of rows || []) {
        affectedItems.add(r.item_id);
        await supabase.from('item_entidades').upsert({ item_id: r.item_id, entidad_id: keeper.id }, { onConflict: 'item_id,entidad_id', ignoreDuplicates: true });
      }
      await supabase.from('item_entidades').delete().eq('entidad_id', l.id);
      for (const table of ['finanzas_movimientos', 'finanzas_deudas', 'finanzas_comprobantes', 'sueldos_recibos']) {
        const { data: moved } = await supabase.from(table).update({ entidad_id: keeper.id }).eq('entidad_id', l.id).select('id');
        if (table === 'finanzas_movimientos') for (const m of moved || []) affectedMovs.add(m.id);
      }

      // Archivar la página duplicada en Notion.
      if (notion) {
        let pageId = l.notion_page_id || null;
        if (!pageId && cfg.entidadesDatabaseId && l.nombre) {
          try {
            const res: any = await notion.databases.query({ database_id: cfg.entidadesDatabaseId, filter: { property: 'Nombre', title: { equals: String(l.nombre).slice(0, 180) } }, page_size: 2 });
            if (res.results?.length === 1 && res.results[0].id !== keeper.notion_page_id) pageId = res.results[0].id;
          } catch { /* sin página */ }
        }
        if (pageId && pageId !== keeper.notion_page_id) {
          try { await notion.pages.update({ page_id: pageId, archived: true }); } catch (e) { console.warn(`No pude archivar ${l.nombre}:`, (e as any)?.message); }
          await sleep(300);
        }
      }
      const { error: delErr } = await supabase.from('entidades').delete().eq('id', l.id);
      if (delErr) console.warn(`No pude borrar ${l.nombre}:`, delErr.message);
    }
    await supabase.from('entidades').update({
      alias: [...alias].slice(0, 50),
      categoria_relacionada: keeper.categoria_relacionada || losers.find(l => l.categoria_relacionada)?.categoria_relacionada || null
    }).eq('id', keeper.id);
    done += 1;
    if (done % 25 === 0) console.log(`  unidos: ${done}/${merges.length}`);
  }

  await loadEntities(true);
  console.log(`\nRevinculando en Notion: ${affectedItems.size} mails/items y ${affectedMovs.size} movimientos...`);
  if (notion) {
    const ids = [...affectedItems];
    for (let i = 0; i < ids.length; i += 100) {
      const { data: items } = await supabase.from('items').select('*').in('id', ids.slice(i, i + 100));
      for (const item of items || []) {
        if (!item.notion_page_id) continue;
        await linkItemEntitiesInNotion(notion, item);
        await sleep(350);
      }
      console.log(`  items: ${Math.min(i + 100, ids.length)}/${ids.length}`);
    }
    const movIds = [...affectedMovs];
    for (let i = 0; i < movIds.length; i += 100) {
      const { data: movs } = await supabase.from('finanzas_movimientos').select('*').in('id', movIds.slice(i, i + 100));
      for (const m of movs || []) { await syncNotionImportedMovements([m]); await sleep(350); }
    }
  }
  console.log(`\nListo: ${merges.length} grupos unidos, ${totalLosers} duplicados eliminados.`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
