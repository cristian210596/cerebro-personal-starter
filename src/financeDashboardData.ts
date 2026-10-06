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

  // Paginado: Supabase/PostgREST devuelve como máximo 1000 filas por consulta aunque se pida
  // .limit(5000); antes el panel se cortaba en jul-26 y "este mes" daba 0.
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('finanzas_movimientos')
      .select('fecha_movimiento, monto, moneda, categoria_financiera, tipo, comercio, descripcion')
      .gte('fecha_movimiento', desdeIso)
      .order('fecha_movimiento', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const mesActual = new Date().toISOString().slice(0, 7); // YYYY-MM

  let gastadoEsteMes = 0;
  let ingresosEsteMes = 0;
  const catEsteMes = new Map<string, number>();
  const catHistorico = new Map<string, number>();
  const porMes = new Map<string, { entradas: number; salidas: number }>();

  for (const row of rows) {
    const montoRaw = Number(row.monto || 0);
    const tipo = String(row.tipo || '').toLowerCase();
    const mes = String(row.fecha_movimiento || '').slice(0, 7);
    if (!mes) continue;
    // Totales en pesos: los consumos en USD no se mezclan con ARS (antes 20 USD sumaban como $20).
    if (String(row.moneda || 'ARS').toUpperCase() !== 'ARS') continue;
    // Movimientos entre cuentas propias no son gasto ni ingreso.
    if (isInternalCategory(row.categoria_financiera)) continue;
    // Los pagos de tarjeta no son flujo nuevo: el consumo ya se contó al comprar.
    if (tipo === 'pago_tarjeta') continue;

    const monto = signedAmount(tipo, montoRaw);
    if (!porMes.has(mes)) porMes.set(mes, { entradas: 0, salidas: 0 });
    const bucket = porMes.get(mes)!;
    if (monto >= 0) bucket.entradas += monto; else bucket.salidas += monto;

    // Gasto por categoría: gastos (cualquier signo guardado), transferencias enviadas con categoría
    // de consumo (ej. pagar el kiosco por transferencia) y devoluciones restando.
    const cat = row.categoria_financiera || 'Otros';
    let gasto = 0;
    if (tipo === 'gasto') gasto = Math.abs(montoRaw);
    else if (tipo === 'devolucion') gasto = -Math.abs(montoRaw);
    else if (tipo === 'transferencia' && montoRaw < 0 && isSpendingCategory(row.categoria_financiera)) gasto = Math.abs(montoRaw);
    if (gasto !== 0) {
      catHistorico.set(cat, (catHistorico.get(cat) || 0) + gasto);
      if (mes === mesActual) {
        catEsteMes.set(cat, (catEsteMes.get(cat) || 0) + gasto);
        gastadoEsteMes += gasto;
      }
    }
    if (mes === mesActual && monto > 0 && tipo !== 'devolucion') ingresosEsteMes += monto;
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
    [...m.entries()].filter(([, total]) => total > 0).map(([categoria, total]) => ({ categoria, total })).sort((a, b) => b.total - a.total);

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

// Convención histórica mixta: tarjetas y gastos manuales se guardan en positivo, Mercado Pago en
// negativo. Para el flujo de caja se normaliza por tipo; transferencias/ajustes respetan el signo.
function signedAmount(tipo: string, monto: number): number {
  if (tipo === 'gasto') return -Math.abs(monto);
  if (tipo === 'ingreso' || tipo === 'devolucion') return Math.abs(monto);
  return monto;
}

const NON_SPENDING_CATEGORY_RE = /^(transferencias?|deudas \/ compartidos|ingresos?|ingreso laboral|inversion(es)?|ahorro|rendimientos?|sin (categoria|clasificar))/;
const INTERNAL_CATEGORY_RE = /cuentas propias|pases? de la cuenta|^ignorar/;
function isInternalCategory(categoria: string | null | undefined): boolean {
  return INTERNAL_CATEGORY_RE.test(String(categoria || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim());
}
function isSpendingCategory(categoria: string | null | undefined): boolean {
  const c = String(categoria || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return !!c && !NON_SPENDING_CATEGORY_RE.test(c);
}
