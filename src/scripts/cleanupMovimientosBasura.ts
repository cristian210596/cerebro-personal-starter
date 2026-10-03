import 'dotenv/config';
import { supabase } from '../supabaseClient.js';
import { getNotionClient, syncNotionImportedMovements } from '../notion.js';

// Borra los movimientos falsos que generó el parseo de PDFs (fechas sueltas, encabezados,
// leyendas) y corrige fechas con el año mal leído (ej: 2027 en un resumen de 2026).
//
// Uso:  npm run cleanup:movimientos-basura              -> muestra qué haría
//       npm run cleanup:movimientos-basura -- --apply   -> aplica

const APPLY = process.argv.includes('--apply');
const norm = (v: unknown) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const JUNK = (t: string) =>
  /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(t) ||
  /^(fecha actual|intervalo de consulta|se utilizo mercado pago|pagina \d|hoja \d|detalle de movimientos|fecha descripcion)/.test(t);

async function main() {
  console.log(APPLY ? '== MODO APLICAR ==' : '== MODO PRUEBA (no escribe nada; usar --apply para aplicar) ==');
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('finanzas_movimientos').select('*').range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const basura = all.filter(m => {
    const c = norm(m.comercio);
    const d = norm(String(m.descripcion || '').split(' [importado:')[0]);
    return (JUNK(c) || JUNK(d)) && Math.abs(Number(m.monto || 0)) < 1000;
  });
  const limite = Date.now() + 31 * 86400000;
  const futuras = all.filter(m => m.fecha_movimiento && Date.parse(m.fecha_movimiento) > limite);

  console.log(`\nMovimientos falsos a borrar: ${basura.length}`);
  for (const m of basura) console.log(`  - ${m.fecha_movimiento} | ${m.monto} | ${m.comercio || m.descripcion}`);
  console.log(`\nFechas con año a corregir (-1 año): ${futuras.length}`);
  for (const m of futuras) console.log(`  - ${m.fecha_movimiento} -> ${Number(m.fecha_movimiento.slice(0, 4)) - 1}${m.fecha_movimiento.slice(4)} | ${m.monto} | ${m.comercio || m.descripcion}`);

  if (!APPLY) { console.log('\nNada se escribió. Para aplicar: npm run cleanup:movimientos-basura -- --apply'); return; }

  const notion = getNotionClient();
  for (const m of basura) {
    if (notion && m.notion_page_id) {
      try { await notion.pages.update({ page_id: m.notion_page_id, archived: true }); } catch (e) { console.warn('No pude archivar en Notion:', (e as any)?.message); }
    }
    await supabase.from('finanzas_movimientos_importados').update({ estado: 'ignorado', movimiento_id: null, updated_at: new Date().toISOString() }).eq('movimiento_id', m.id);
    await supabase.from('finanzas_comprobantes').update({ movimiento_financiero_id: null }).eq('movimiento_financiero_id', m.id);
    await supabase.from('sueldos_recibos').update({ movimiento_financiero_id: null }).eq('movimiento_financiero_id', m.id);
    const { error } = await supabase.from('finanzas_movimientos').delete().eq('id', m.id);
    if (error) console.warn(`No pude borrar ${m.id}:`, error.message);
  }
  for (const m of futuras) {
    const fecha = `${Number(m.fecha_movimiento.slice(0, 4)) - 1}${m.fecha_movimiento.slice(4)}`;
    const { data, error } = await supabase.from('finanzas_movimientos').update({ fecha_movimiento: fecha, updated_at: new Date().toISOString() }).eq('id', m.id).select().single();
    if (error) { console.warn(`No pude corregir ${m.id}:`, error.message); continue; }
    await supabase.from('finanzas_movimientos_importados').update({ fecha_movimiento: fecha }).eq('movimiento_id', m.id);
    await syncNotionImportedMovements([data]);
  }
  console.log(`\nListo: ${basura.length} borrados, ${futuras.length} fechas corregidas.`);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
