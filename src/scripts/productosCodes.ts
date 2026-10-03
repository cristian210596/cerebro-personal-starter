import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../supabaseClient.js';
import { downloadStorageRef } from '../processingQueue.js';
import { setComprobanteItemCodes } from '../productCatalog.js';

// Herramientas locales para el catálogo (sirven aunque el servidor no esté desplegado):
//   npm run productos:codes -- aplicar <archivo.json>     aplica {comprobante_id, codes:[{descripcion,codigo}]}
//   npm run productos:codes -- fotos photo-3361.jpg ...   baja esas fotos de la cola a _fotos/ para leerlas

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'aplicar') {
    const file = path.resolve(process.cwd(), args[0] || '');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = await setComprobanteItemCodes(json.comprobante_id, json.codes);
    console.log(`Códigos aplicados: ${r.updated} | productos vinculados: ${r.linked}`);
    if (r.sinMatch.length) console.log('Sin coincidencia:', r.sinMatch.join(' | '));
    return;
  }
  if (cmd === 'fotos') {
    const dir = path.resolve(process.cwd(), '_fotos');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of args) {
      const { data, error } = await supabase.from('procesamiento_cola').select('storage_ref').eq('nombre_archivo', name).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error || !data?.storage_ref) { console.log(`No encontré ${name} en la cola.`); continue; }
      fs.writeFileSync(path.join(dir, name), await downloadStorageRef(data.storage_ref));
      console.log(`Guardada: _fotos/${name}`);
    }
    return;
  }
  console.log('Uso: productos:codes -- aplicar <archivo.json> | fotos <nombre1> <nombre2> ...');
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
