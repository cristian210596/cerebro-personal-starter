import { supabase } from './supabaseClient.js';

export type FinanceDashboardData = {
  generatedAt: string;
  mesActual: string;
  gastadoEsteMes: number;
  ingresosEsteMes: number;
  saldoEsteMes: number;
  categoriasEsteMes: { categoria: string; total: number }[];
  categoriasHistorico: { categoria: string; total: number }[];
  serieMensual: { mes: string; entradas: number; salidas: number; neto: number; acumulado: number }[];
  ultimosMovimientos: { fecha: string; descripcion: string; comercio: string; categoria: string; monto: number }[];
};

export async function buildFinanceDashboardData(): Promise<FinanceDashboardData> {
  const desde = new Date();
  desde.setUTCMonth(desde.getUTCMonth() - 12);
  desde.setUTCDate(1);
  const desdeIso = desde.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .select('fecha_movimiento, monto, categoria_financiera, tipo, comercio, descripcion')
    .gte('fecha_movimiento', desdeIso)
    .order('fecha_movimiento', { ascending: true })
    .limit(5000);
  if (error) throw error;
  const rows = data || [];

  const mesActual = new Date().toISOString().slice(0, 7); // YYYY-MM

  let gastadoEsteMes = 0;
  let ingresosEsteMes = 0;
  const catEsteMes = new Map<string, number>();
  const catHistorico = new Map<string, number>();
  const porMes = new Map<string, { entradas: number; salidas: number }>();

  for (const row of rows) {
    const monto = Number(row.monto || 0);
    const mes = String(row.fecha_movimiento || '').slice(0, 7);
    if (!mes) continue;

    if (!porMes.has(mes)) porMes.set(mes, { entradas: 0, salidas: 0 });
    const bucket = porMes.get(mes)!;
    if (monto >= 0) bucket.entradas += monto; else bucket.salidas += monto;

    if (row.tipo === 'gasto') {
      const cat = row.categoria_financiera || 'Otros';
      catHistorico.set(cat, (catHistorico.get(cat) || 0) + Math.abs(monto));
      if (mes === mesActual) {
        catEsteMes.set(cat, (catEsteMes.get(cat) || 0) + Math.abs(monto));
        gastadoEsteMes += Math.abs(monto);
      }
    }
    if (mes === mesActual && monto > 0) ingresosEsteMes += monto;
  }

  const meses = [...porMes.keys()].sort();
  let acumulado = 0;
  const serieMensual = meses.map(mes => {
    const b = porMes.get(mes)!;
    const neto = b.entradas + b.salidas;
    acumulado += neto;
    return { mes, entradas: b.entradas, salidas: b.salidas, neto, acumulado };
  });

  const toSortedArray = (m: Map<string, number>) =>
    [...m.entries()].map(([categoria, total]) => ({ categoria, total })).sort((a, b) => b.total - a.total);

  const ultimosMovimientos = rows.slice(-15).reverse().map(r => ({
    fecha: r.fecha_movimiento,
    descripcion: r.descripcion || '',
    comercio: r.comercio || '',
    categoria: r.categoria_financiera || '-',
    monto: Number(r.monto || 0)
  }));

  return {
    generatedAt: new Date().toISOString(),
    mesActual,
    gastadoEsteMes,
    ingresosEsteMes,
    saldoEsteMes: ingresosEsteMes - gastadoEsteMes,
    categoriasEsteMes: toSortedArray(catEsteMes),
    categoriasHistorico: toSortedArray(catHistorico),
    serieMensual,
    ultimosMovimientos
  };
}
