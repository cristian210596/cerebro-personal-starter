import JSZip from 'jszip';
import { supabase } from './supabaseClient.js';

const TABLES = [
  'items',
  'entidades',
  'item_entidades',
  'memorias',
  'archivos',
  'taxonomia',
  'finanzas_movimientos',
  'finanzas_deudas',
  'finanzas_particiones',
  'finanzas_cierres',
  'finanzas_presupuestos',
  'finanzas_importaciones',
  'finanzas_movimientos_importados',
  'finanzas_reglas_comercios',
  'finanzas_conciliaciones',
  'sueldos_recibos',
  'sueldos_conceptos',
  'pendientes'
];

export async function generateBackupZip() {
  const zip = new JSZip();
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    try {
      const rows = await fetchAllRows(table);
      counts[table] = rows.length;
      zip.file(`${table}.json`, JSON.stringify(rows, null, 2));
      zip.file(`${table}.csv`, toCsv(rows));
    } catch (error: any) {
      counts[table] = -1;
      zip.file(`${table}-ERROR.txt`, `No se pudo exportar ${table}: ${error?.message || error}`);
    }
  }

  zip.file('backup-info.json', JSON.stringify({
    generated_at: now.toISOString(),
    source: 'cerebro-personal',
    tables: TABLES,
    counts
  }, null, 2));

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    filename: `backup-cerebro-${stamp}.zip`,
    buffer,
    counts
  };
}

async function fetchAllRows(table: string) {
  const pageSize = 1000;
  let from = 0;
  const all: any[] = [];

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + pageSize - 1);

    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
    if (from > 20000) break;
  }

  return all;
}

function toCsv(rows: any[]) {
  if (!rows.length) return '';
  const cols = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
  const lines = [cols.join(',')];

  for (const row of rows) {
    lines.push(cols.map(col => csvCell(row[col])).join(','));
  }

  return lines.join('\n');
}

function csvCell(value: any) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}
