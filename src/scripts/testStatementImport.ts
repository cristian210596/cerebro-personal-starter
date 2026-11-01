import assert from 'node:assert/strict';
import fs from 'node:fs';

// Prueba lo puro del importador de resúmenes (parsers locales + import_statement_data):
// no toca Supabase, Notion ni Gemini. Variables dummy solo para que los módulos importen.
// Uso:
//   npm run test:statements
//   npm run test:statements -- /ruta/resumen_visa.pdf /ruta/resumen_master.pdf   (opcional: PDFs reales)
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy';
process.env.GEMINI_API_KEY ||= 'dummy';

const { parseFinanceStatementText, parseFinancePdfLocally, buildParsedStatementFromData } = await import('../financeImport.js');

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`ok  - ${name}`); })
    .catch((error) => { console.error(`FAIL - ${name}`); throw error; });
}

// Texto tal cual lo deja pdf-parse + cleanPdfText (columnas pegadas), datos personales anonimizados.
const MC_TEXT = `Resumen N° 000000000000
Tarjeta Crédito MASTERCARD BLACK
TITULAR,NOMBRE
CONSUMIDOR FINAL CUIT Banco: 30-50000173-5
CALLE 123, CIUDAD AUTONOMA BUEN, 01424 N° de Socio: 0000000-0-0Sucursal: 157
Página1 / 5Resumen de tarjeta de credito MASTERCARD BLACK
754.766,66
0,00
01-Oct-2609-Oct-2629-Oct-26
11-Nov-26
26-Nov-2604-Dic-26

PAGO MINIMOLÍMITES
En pesos
$ 185.090,00
De compras en un pago y en cuotas
$ 4.500.000,00
CONSOLIDADO
PESOSDÓLARES
SALDO ANTERIOR762.270,380,00
08-Oct-26SU PAGO -762.270,38-762.270,38
SALDO PENDIENTE 0,000,00
TOTAL CONSUMOS DEL MES 754.766,660,00
SUBTOTAL 754.766,660,00
TOTAL A PAGAR
754.766,660,00

DETALLE DEL CONSUMO
FECHAREFERENCIACOMPROBANTEPESOSDÓLARES
COMPRAS DEL MES
16-Oct-26UNICEF 10/18 0763718.000,00
CUOTA DEL MES
19-Jun-26MERPAGO*AUTOSZANET 05/0604689736.766,66
SUBTOTAL754.766,660,00
TOTAL A PAGAR
754.766,660,00`;

const VISA_TEXT = `CIERRE ACTUAL: 29 Oct 26
VENCIMIENTOSALDO $SALDO U$SPAGO MIN.$PAGO MIN.U$S
11 Nov 261.787.241,0569,85190.170,00-,--
VISA SIGNATURE
Galicia
0740480302
FECHA COMPROBANTE DETALLE DE TRANSACCION PESOS DOLARES
SALDO ANTERIOR 2.060.364,92 79,86
08.10.26 SU PAGO EN PESOS 2.024.020,64-
08.10.26 SU PAGO EN USD 79,86-
09.10.26 DEV.IMP. RG 5617 30%( 121147,62) 36.344,28- _
10.06.26 747738* MERPAGO*MERCADOLIBRE Cuota 05/09 35.342,22
14.07.26 669361* MERPAGO*FINAER Cuota 04/12 120.000,00
25.10.26 008321K RAPPI 28.980,00
27.10.26 962800K OPENAI *CHATGPT in1UUyDFCUSD 20,00 20,00
Tarjeta 1425 Total Consumos de TITULAR 184.322,22 20,00 _
29.10.26 IIBB PERCEP-CABA 2,00%( 15204,12) 304,08
29.10.26 IVA RG 4240 21%( 15204,12) 3.192,86
29.10.26 DB.RG 5617 30% ( 107708,70 ) 32.312,61
SALDO ACTUAL $ 1.787.241,05 U$S 69,85
PAGO MINIMO $ 190.170,00`;

const key = (m: any) => [m.fecha, m.descripcion_original, m.comprobante, m.monto, m.moneda, m.tipo, m.cuota_actual, m.cuotas_totales].join('|');

await test('Mastercard Galicia (diseño nuevo, columnas pegadas): encabezado y 2 consumos', () => {
  const doc = parseFinanceStatementText(MC_TEXT, 'mc.pdf');
  assert.ok(doc, 'debería reconocer el resumen');
  assert.equal(doc!.tarjeta, 'Mastercard');
  assert.equal(doc!.proveedor, 'Banco Galicia');
  assert.equal(doc!.fecha_cierre, '2026-10-29');
  assert.equal(doc!.fecha_vencimiento, '2026-11-11');
  assert.equal(doc!.periodo, '2026-10');
  assert.equal(doc!.total_pesos, 754766.66);
  assert.equal(doc!.pago_minimo, 185090);
  assert.equal(doc!.movimientos.length, 2);
  const [unicef, auto] = doc!.movimientos;
  assert.deepEqual([unicef.fecha, unicef.descripcion_original, unicef.comprobante, unicef.monto, unicef.cuota_actual], ['2026-10-16', 'UNICEF 10/18', '07637', 18000, null]);
  assert.deepEqual([auto.fecha, auto.descripcion_original, auto.comprobante, auto.monto, auto.cuota_actual, auto.cuotas_totales], ['2026-06-19', 'MERPAGO*AUTOSZANET', '04689', 736766.66, 5, 6]);
  assert.ok(doc!.movimientos.every(m => m.tipo === 'gasto' && m.moneda === 'ARS'));
});

await test('Mastercard: si la suma no cierra con TOTAL CONSUMOS no adivina (null)', () => {
  const roto = MC_TEXT.replace('TOTAL CONSUMOS DEL MES 754.766,660,00', 'TOTAL CONSUMOS DEL MES 754.700,000,00');
  assert.equal(parseFinanceStatementText(roto, 'mc.pdf'), null);
});

await test('Mastercard: comprobante de 6 dígitos pegado se corta donde cierra el total', () => {
  const seis = MC_TEXT
    .replace('TOTAL CONSUMOS DEL MES 754.766,660,00', 'TOTAL CONSUMOS DEL MES 18.000,000,00')
    .replace('16-Oct-26UNICEF 10/18 0763718.000,00\nCUOTA DEL MES\n19-Jun-26MERPAGO*AUTOSZANET 05/0604689736.766,66\n', '16-Oct-26UNICEF 10/18 12345618.000,00\n');
  const doc = parseFinanceStatementText(seis, 'mc.pdf');
  assert.ok(doc);
  assert.equal(doc!.movimientos.length, 1);
  assert.equal(doc!.movimientos[0].comprobante, '123456');
  assert.equal(doc!.movimientos[0].monto, 18000);
});

await test('Mastercard: fila con consumos en dólares -> no adivina (null)', () => {
  const usd = MC_TEXT.replace('TOTAL CONSUMOS DEL MES 754.766,660,00', 'TOTAL CONSUMOS DEL MES 754.766,6610,00');
  assert.equal(parseFinanceStatementText(usd, 'mc.pdf'), null);
});

await test('Visa Signature: devolución con "_" final entra como devolucion; SU PAGO (pesos y USD) no entra', () => {
  const doc = parseFinanceStatementText(VISA_TEXT, '0740480302.29-10-26.pdf');
  assert.ok(doc);
  assert.equal(doc!.tarjeta, 'Visa');
  assert.equal(doc!.fecha_cierre, '2026-10-29');
  assert.equal(doc!.fecha_vencimiento, '2026-11-11');
  const descs = doc!.movimientos.map(m => m.descripcion_original);
  assert.ok(!descs.some(d => /su pago/i.test(d)), 'no debe incluir pagos del resumen');
  const dev = doc!.movimientos.find(m => /DEV\.IMP/.test(m.descripcion_original));
  assert.ok(dev, 'debe incluir la devolución');
  assert.equal(dev!.tipo, 'devolucion');
  assert.equal(dev!.monto, 36344.28);
  assert.equal(doc!.movimientos.filter(m => m.tipo === 'cargo_financiero').length, 3);
  const openai = doc!.movimientos.find(m => /OPENAI/.test(m.descripcion_original));
  assert.equal(openai!.moneda, 'USD');
  assert.equal(openai!.monto, 20);
  const fin = doc!.movimientos.find(m => /FINAER/.test(m.descripcion_original));
  assert.deepEqual([fin!.cuota_actual, fin!.cuotas_totales, fin!.comprobante], [4, 12, '669361*']);
  // 1 devolución + 4 consumos (MELI, FINAER, RAPPI, OPENAI) + 3 cargos.
  assert.equal(doc!.movimientos.length, 8);
});

await test('import_statement_data: mismos datos que el parser -> mismos movimientos (dedup con PDF de Gmail)', () => {
  const doc = parseFinanceStatementText(VISA_TEXT, 'visa.pdf')!;
  const input = {
    proveedor: 'Banco Galicia',
    tarjeta: 'Visa',
    fecha_cierre: '2026-10-29',
    fecha_vencimiento: '2026-11-11',
    total_consumos_pesos: 184322.22,
    total_consumos_dolares: 20,
    movimientos: doc.movimientos.map(m => ({
      fecha: m.fecha!,
      descripcion: m.descripcion_original,
      comprobante: m.comprobante,
      monto: m.monto!,
      moneda: m.moneda,
      es_credito: m.tipo === 'devolucion',
      cuota_actual: m.cuota_actual,
      cuotas_totales: m.cuotas_totales
    }))
  };
  const built = buildParsedStatementFromData(input);
  assert.equal(built.ok, true, JSON.stringify(built.errores));
  assert.deepEqual(built.avisos, []);
  assert.deepEqual(built.parsed!.movimientos.map(key), doc.movimientos.map(key));
  assert.deepEqual(built.parsed!.movimientos.map(m => m.categoria_sugerida), doc.movimientos.map(m => m.categoria_sugerida));
  assert.equal(built.parsed!.periodo, '2026-10');
  assert.equal(built.parsed!.tarjeta, 'Visa');
});

await test('import_statement_data: totales que no cierran -> aviso (no guarda sin forzar)', () => {
  const built = buildParsedStatementFromData({
    tarjeta: 'Visa',
    total_consumos_pesos: 1000,
    movimientos: [{ fecha: '2026-10-25', descripcion: 'RAPPI', comprobante: '008321K', monto: 999 }]
  });
  assert.equal(built.ok, true);
  assert.equal(built.avisos.length, 1);
  assert.match(built.avisos[0], /no coincide/);
});

await test('import_statement_data: datos inválidos -> errores claros, nada armado', () => {
  const built = buildParsedStatementFromData({
    tarjeta: 'Visa',
    fecha_cierre: '29/10/2026',
    movimientos: [
      { fecha: '2026-13-40', descripcion: 'X', monto: 10 },
      { fecha: '2026-10-01', descripcion: 'DEVOLUCION', monto: -50 },
      { fecha: '2026-10-01', descripcion: 'CUOTA RARA', monto: 50, cuota_actual: 4, cuotas_totales: 3 },
      { fecha: '2026-10-01', descripcion: '', monto: 50 }
    ]
  });
  assert.equal(built.ok, false);
  assert.equal(built.parsed, null);
  assert.ok(built.errores.some(e => /fecha_cierre/.test(e)));
  assert.ok(built.errores.some(e => /Movimiento 1/.test(e) && /fecha/.test(e)));
  assert.ok(built.errores.some(e => /Movimiento 2/.test(e) && /es_credito/.test(e)));
  assert.ok(built.errores.some(e => /Movimiento 3/.test(e) && /cuota/.test(e)));
  assert.ok(built.errores.some(e => /Movimiento 4/.test(e) && /descripcion/.test(e)));
  const sinTarjeta = buildParsedStatementFromData({ movimientos: [{ fecha: '2026-10-01', descripcion: 'A', monto: 1 }] });
  assert.ok(sinTarjeta.errores.some(e => /tarjeta/.test(e)));
});

await test('import_statement_data: tipos y categorías (crédito, cargos, categoría explícita, USD)', () => {
  const built = buildParsedStatementFromData({
    tarjeta: 'Visa',
    total_consumos_pesos: 117000,
    total_consumos_dolares: 2.99,
    movimientos: [
      { fecha: '2026-10-09', descripcion: 'DEV.IMP. RG 5617 30%( 121147,62)', monto: 36344.28, es_credito: true },
      { fecha: '2026-10-29', descripcion: 'IVA RG 4240 21%( 15204,12)', monto: 3192.86 },
      { fecha: '2026-10-17', descripcion: 'CAFE SAN JUAN', comprobante: '508080K', monto: 117000, categoria: 'comida afuera' },
      { fecha: '2026-10-05', descripcion: 'APPLE.COM/BILL MTZ54VBJ0', comprobante: '635013', monto: 2.99, moneda: 'usd' }
    ]
  });
  assert.equal(built.ok, true, JSON.stringify(built.errores));
  assert.deepEqual(built.avisos, []);
  const [dev, iva, cafe, apple] = built.parsed!.movimientos;
  assert.equal(dev.tipo, 'devolucion');
  assert.equal(iva.tipo, 'cargo_financiero');
  assert.equal(cafe.tipo, 'gasto');
  assert.equal(cafe.categoria_sugerida, 'Comida afuera');
  assert.ok(cafe.confianza >= 0.78, 'categoría explícita entra clasificada');
  assert.equal(apple.moneda, 'USD');
  assert.ok(apple.confianza < 0.78, 'sin categoría ni regla queda pendiente');
  assert.deepEqual(built.sumas_consumos, { ARS: 117000, USD: 2.99 });
});

await test('Mes de cobro: ciclo por cierre − 14 días (dos cierres en el mismo mes caen en meses distintos)', async () => {
  const { cycleMonthFromClosing, billingMonthFor, shiftMonth } = await import('../financeImport.js');
  assert.equal(cycleMonthFromClosing('2026-10-01'), '2026-09');
  assert.equal(cycleMonthFromClosing('2026-10-29'), '2026-10');
  assert.equal(cycleMonthFromClosing('2026-11-26'), '2026-11');
  assert.equal(cycleMonthFromClosing('2027-01-07'), '2026-12');
  assert.equal(cycleMonthFromClosing(null), null);
  assert.equal(cycleMonthFromClosing('29/10/2026'), null);
  const cycles = new Map([['imp-oct', '2026-10']]);
  // Cuota 5/6 de una compra de junio cobrada en el resumen de octubre -> octubre.
  assert.equal(billingMonthFor({ fecha_movimiento: '2026-06-19', importacion_id: 'imp-oct' }, cycles), '2026-10');
  // Sin resumen de tarjeta (efectivo, transferencia, resumen de cuenta) -> mes de la fecha.
  assert.equal(billingMonthFor({ fecha_movimiento: '2026-10-05', importacion_id: 'imp-cuenta-mp' }, cycles), '2026-10');
  assert.equal(billingMonthFor({ fecha_movimiento: '2026-10-05' }, cycles), '2026-10');
  assert.equal(shiftMonth('2026-10', -24), '2024-10');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});

// Opcional: PDFs reales pasados por argumento (no se versionan: tienen datos personales).
const pdfs = process.argv.slice(2).filter(f => /\.pdf$/i.test(f));
for (const file of pdfs) {
  await test(`PDF real ${file.split('/').pop()}: parser local sin Gemini + equivalencia con import_statement_data`, async () => {
    const { parsed } = await parseFinancePdfLocally(fs.readFileSync(file), file.split('/').pop()!, 'application/pdf');
    assert.ok(parsed && parsed.movimientos.length > 0, 'el parser local debería reconocerlo');
    const consumos: Record<string, number> = {};
    for (const m of parsed!.movimientos) if (m.tipo === 'gasto') consumos[m.moneda] = Math.round(((consumos[m.moneda] || 0) + Number(m.monto)) * 100) / 100;
    console.log(`     ${parsed!.tarjeta} cierre ${parsed!.fecha_cierre}: ${parsed!.movimientos.length} líneas, consumos ${JSON.stringify(consumos)}`);
    const built = buildParsedStatementFromData({
      proveedor: parsed!.proveedor,
      tarjeta: parsed!.tarjeta,
      fecha_cierre: parsed!.fecha_cierre,
      total_consumos_pesos: consumos.ARS ?? null,
      total_consumos_dolares: consumos.USD ?? null,
      movimientos: parsed!.movimientos.map(m => ({ fecha: m.fecha!, descripcion: m.descripcion_original, comprobante: m.comprobante, monto: m.monto!, moneda: m.moneda, es_credito: m.tipo === 'devolucion', cuota_actual: m.cuota_actual, cuotas_totales: m.cuotas_totales }))
    });
    assert.equal(built.ok, true, JSON.stringify(built.errores));
    assert.deepEqual(built.parsed!.movimientos.map(key), parsed!.movimientos.map(key));
  });
}

console.log(`\n${passed} tests OK`);
