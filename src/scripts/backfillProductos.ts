import 'dotenv/config';
import { supabase } from '../supabaseClient.js';
import { linkComprobanteItemsToProducts } from '../productCatalog.js';
import { syncProductosToNotion } from '../notion.js';

// Vincula todos los ítems de comprobantes ya cargados con el catálogo de productos y
// sincroniza la base "🛒 Productos" de Notion. Requiere supabase/productos.sql.
//
// Uso: npm run productos:backfill

async function main() {
  const { data: comps, error } = await supabase.from('finanzas_comprobantes').select('id, comercio, fecha_emision');
  if (error) throw error;
  let items = 0;
  for (const c of comps || []) {
    const n = await linkComprobanteItemsToProducts(c.id);
    items += n;
    console.log(`  ${c.fecha_emision || '?'} ${c.comercio || '?'}: ${n} productos vinculados`);
  }
  console.log(`Ítems vinculados: ${items}`);
  let pending = 1;
  let total = 0;
  while (pending > 0) {
    const r = await syncProductosToNotion(40);
    total += r.synced;
    pending = r.pending;
    console.log(`  Notion: ${total} sincronizados, ${pending} pendientes`);
    if (!r.synced) break;
  }
  console.log('Listo.');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
