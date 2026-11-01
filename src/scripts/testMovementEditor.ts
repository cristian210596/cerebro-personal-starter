import assert from 'node:assert/strict';

// Prueba las funciones puras de movementEditor (validación, armado del patch, sanitizado).
// No toca Supabase ni Notion: se cargan variables dummy solo para que el módulo importe.
// Uso: npm run test:movements
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'dummy';
process.env.GEMINI_API_KEY ||= 'dummy';

const { buildMovementPatch, sanitizeSearchTerm, isValidIsoDate } = await import('../movementEditor.js');

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error: any) { console.error(`  FALLA ${name}\n       ${error?.message || error}`); process.exitCode = 1; }
};

// Caso real: "Transferencia enviada Juan Carlos Schill" ($-3.000, 01-09-2026) quedó clasificado
// por error como Alimentos / Kiosco con comercio del kiosco.
const schill = {
  id: '11111111-1111-1111-1111-111111111111',
  fecha_movimiento: '2026-09-01', tipo: 'transferencia', monto: -3000,
  comercio: 'Bua Parama Orlando (kiosco)', descripcion: 'Transferencia enviada Juan Carlos Schill',
  categoria_financiera: 'Alimentos', subcategoria_financiera: 'Kiosco'
};

console.log('buildMovementPatch');
test('corrige comercio y categoría del caso Schill, limpia la subcategoría vieja', () => {
  const r = buildMovementPatch(schill, { comercio: 'Juan Carlos Schill', categoria: 'Otros' });
  assert.equal(r.patch.comercio, 'Juan Carlos Schill');
  assert.equal(r.patch.categoria_financiera, 'Otros');
  assert.equal(r.patch.subcategoria_financiera, null);
  assert.equal(r.imported.categoria_confirmada, 'Otros');
  assert.equal(r.imported.subcategoria_confirmada, null);
  assert.equal(r.imported.comercio_detectado, 'Juan Carlos Schill');
  assert.ok(r.patch.updated_at);
});
test('categoría + subcategoría nuevas se aplican juntas', () => {
  const r = buildMovementPatch(schill, { categoria: 'Mascotas', subcategoria: 'Alimento' });
  assert.equal(r.patch.categoria_financiera, 'Mascotas');
  assert.equal(r.patch.subcategoria_financiera, 'Alimento');
});
test('solo subcategoría no toca la categoría', () => {
  const r = buildMovementPatch(schill, { subcategoria: 'Cigarrillos' });
  assert.equal(r.patch.categoria_financiera, undefined);
  assert.equal(r.patch.subcategoria_financiera, 'Cigarrillos');
});
test('monto conserva el signo negativo del gasto aunque se pase positivo', () => {
  assert.equal(buildMovementPatch(schill, { monto: 3500 }).patch.monto, -3500);
  assert.equal(buildMovementPatch(schill, { monto: -3500 }).patch.monto, -3500);
});
test('monto conserva el signo positivo de un ingreso', () => {
  const ingreso = { ...schill, tipo: 'ingreso', monto: 36500 };
  assert.equal(buildMovementPatch(ingreso, { monto: 40000 }).patch.monto, 40000);
});
test('monto con decimales se redondea a 2', () => {
  assert.equal(buildMovementPatch(schill, { monto: 3000.456 }).patch.monto, -3000.46);
});
test('monto 0, NaN o texto inválido se rechazan', () => {
  assert.throws(() => buildMovementPatch(schill, { monto: 0 }), /monto inválido/);
  assert.throws(() => buildMovementPatch(schill, { monto: 'abc' }), /monto inválido/);
});
test('movimiento actual con monto 0: no se puede inferir signo', () => {
  assert.throws(() => buildMovementPatch({ ...schill, monto: 0 }, { monto: 100 }), /inferir el signo/);
});
test('fecha válida se aplica y se refleja en la fila importada', () => {
  const r = buildMovementPatch(schill, { fecha: '2026-09-02' });
  assert.equal(r.patch.fecha_movimiento, '2026-09-02');
  assert.equal(r.imported.fecha_movimiento, '2026-09-02');
});
test('fechas inválidas se rechazan (formato, día inexistente, año)', () => {
  assert.throws(() => buildMovementPatch(schill, { fecha: '02/09/2026' }), /fecha inválida/);
  assert.throws(() => buildMovementPatch(schill, { fecha: '2026-02-30' }), /fecha inválida/);
  assert.throws(() => buildMovementPatch(schill, { fecha: '2026-13-01' }), /fecha inválida/);
});
test('tipo fuera de la lista se rechaza; en mayúsculas se normaliza', () => {
  assert.throws(() => buildMovementPatch(schill, { tipo: 'regalo' }), /tipo inválido/);
  assert.equal(buildMovementPatch(schill, { tipo: 'GASTO' }).patch.tipo, 'gasto');
});
test('campos vacíos o solo espacios se rechazan', () => {
  assert.throws(() => buildMovementPatch(schill, { categoria: '   ' }), /categoria no puede estar vacía/);
  assert.throws(() => buildMovementPatch(schill, { comercio: '' }), /comercio no puede estar vacío/);
  assert.throws(() => buildMovementPatch(schill, { descripcion: ' ' }), /descripcion no puede estar vacía/);
});
test('sin ningún campo, o con valores iguales a los actuales, no hay cambios', () => {
  assert.throws(() => buildMovementPatch(schill, {}), /No hay nada que cambiar/);
  assert.throws(() => buildMovementPatch(schill, { comercio: 'Bua Parama Orlando (kiosco)', categoria: 'Alimentos', subcategoria: 'Kiosco' }), /No hay nada que cambiar/);
});
test('espacios múltiples se colapsan', () => {
  assert.equal(buildMovementPatch(schill, { comercio: '  Juan   Carlos  Schill ' }).patch.comercio, 'Juan Carlos Schill');
});
test('se listan los cambios con valor anterior y nuevo', () => {
  const r = buildMovementPatch(schill, { categoria: 'Otros' });
  assert.ok(r.cambios.some(c => c.includes('Alimentos') && c.includes('Otros')));
});

console.log('sanitizeSearchTerm');
test('saca caracteres que romperían el filtro .or() de PostgREST', () => {
  assert.equal(sanitizeSearchTerm('a,b),comercio.eq.x'), 'a b comercio.eq.x');
  assert.equal(sanitizeSearchTerm('50%*'), '50');
});
test('null/undefined → vacío, y se corta a 60 caracteres', () => {
  assert.equal(sanitizeSearchTerm(null), '');
  assert.equal(sanitizeSearchTerm('x'.repeat(100)).length, 60);
});
test('conserva tildes y puntos de razones sociales', () => {
  assert.equal(sanitizeSearchTerm('Mercado Libre S.R.L.'), 'Mercado Libre S.R.L.');
  assert.equal(sanitizeSearchTerm('Peñalba'), 'Peñalba');
});

console.log('isValidIsoDate');
test('acepta fecha real y año bisiesto; rechaza inexistentes', () => {
  assert.ok(isValidIsoDate('2028-02-29'));
  assert.ok(!isValidIsoDate('2026-02-29'));
  assert.ok(!isValidIsoDate('2026-9-1'));
  assert.ok(!isValidIsoDate(''));
});


// ---------------------------------------------------------------------------------------
// Flujos contra una base simulada en memoria (se reemplaza supabase.from). Cubre el
// control de flujo de updateMovement/deleteMovement; NO prueba Supabase ni Notion reales.
// ---------------------------------------------------------------------------------------
const { supabase } = await import('../supabaseClient.js');
const { updateMovement, deleteMovement, findMovements } = await import('../movementEditor.js');

function installFakeDb(tables: Record<string, any[]>, failDeleteOn: string | null = null) {
  (supabase as any).from = (table: string) => {
    const rows = tables[table] ?? (tables[table] = []);
    const st: any = { op: 'select', filters: [] as Array<(r: any) => boolean>, patch: null, head: false, single: null };
    const run = () => {
      const matches = rows.filter(r => st.filters.every((f: any) => f(r)));
      if (st.op === 'update') { matches.forEach(m => Object.assign(m, st.patch)); }
      if (st.op === 'delete') {
        if (failDeleteOn === table) return { data: null, error: { message: 'FK violation simulada' }, count: null };
        matches.forEach(m => rows.splice(rows.indexOf(m), 1));
        return { data: null, error: null, count: null };
      }
      // Como la base real: cada consulta devuelve COPIAS independientes de las filas, no
      // referencias a lo almacenado (si no, un "estado anterior" capturado se pisa con el update).
      const copies = matches.map(m => ({ ...m }));
      if (st.head) return { data: null, error: null, count: matches.length };
      if (st.single) return { data: copies[0] ?? null, error: null, count: null };
      return { data: copies, error: null, count: null };
    };
    const b: any = {
      select(_c?: string, o?: any) { if (o?.head) st.head = true; return b; },
      update(p: any) { st.op = 'update'; st.patch = p; return b; },
      delete() { st.op = 'delete'; return b; },
      eq(c: string, v: any) { st.filters.push((r: any) => r[c] === v); return b; },
      in(c: string, vs: any[]) { st.filters.push((r: any) => vs.includes(r[c])); return b; },
      or(expr: string) { const conds = expr.split(',').map(x => x.split('.eq.')); st.filters.push((r: any) => conds.some(([c, v]) => r[c] === v)); return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { st.single = 'maybe'; return b; },
      single() { st.single = 'one'; return b; },
      then(resolve: any, reject: any) { try { resolve(run()); } catch (e) { reject(e); } }
    };
    return b;
  };
}

const MOV = '22222222-2222-2222-2222-222222222222';
const IMP = '33333333-3333-3333-3333-333333333333';
const CMP = '44444444-4444-4444-4444-444444444444';
const baseTables = (): Record<string, any[]> => ({
  finanzas_movimientos: [{ id: MOV, fecha_movimiento: '2026-09-01', tipo: 'transferencia', monto: -3000, moneda: 'ARS', comercio: 'Bua Parama Orlando (kiosco)', descripcion: 'Transferencia enviada Juan Carlos Schill', categoria_financiera: 'Alimentos', subcategoria_financiera: 'Kiosco', entidad_id: 'ent-1', notion_page_id: 'page-1', movimiento_importado_id: IMP }],
  finanzas_movimientos_importados: [{ id: IMP, estado: 'importado', movimiento_id: MOV, categoria_confirmada: 'Alimentos', subcategoria_confirmada: 'Kiosco', comercio_detectado: 'Bua Parama Orlando (kiosco)', match_score: null, match_reason: null }],
  finanzas_comprobantes: [{ id: CMP, movimiento_financiero_id: MOV }],
  sueldos_recibos: [],
  finanzas_particiones: [],
  finanzas_deudas: []
});

console.log('flujos con base simulada');
const asyncTest = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error: any) { console.error(`  FALLA ${name}\n       ${error?.message || error}`); process.exitCode = 1; }
};

await asyncTest('update: corrige el caso Schill, refleja en importado y suelta entidad_id', async () => {
  const t = baseTables(); installFakeDb(t);
  const r: any = await updateMovement(MOV, { comercio: 'Juan Carlos Schill', categoria: 'Otros' });
  assert.equal(r.ok, true);
  assert.equal(r.antes.comercio, 'Bua Parama Orlando (kiosco)');
  assert.equal(r.despues.comercio, 'Juan Carlos Schill');
  const mov = t.finanzas_movimientos[0];
  assert.equal(mov.categoria_financiera, 'Otros');
  assert.equal(mov.subcategoria_financiera, null);
  assert.equal(mov.entidad_id, null);
  const imp = t.finanzas_movimientos_importados[0];
  assert.equal(imp.categoria_confirmada, 'Otros');
  assert.equal(imp.comercio_detectado, 'Juan Carlos Schill');
  assert.equal(r.filas_importadas_actualizadas, 1);
  assert.equal(r.notion_sincronizado, false);
  assert.ok(r.aviso);
});
await asyncTest('update: cambiar solo categoría NO suelta entidad_id', async () => {
  const t = baseTables(); installFakeDb(t);
  await updateMovement(MOV, { categoria: 'Otros' });
  assert.equal(t.finanzas_movimientos[0].entidad_id, 'ent-1');
});
await asyncTest('update: id inexistente e id inválido dan error claro', async () => {
  installFakeDb(baseTables());
  await assert.rejects(() => updateMovement('99999999-9999-9999-9999-999999999999', { categoria: 'Otros' }), /No existe un movimiento/);
  await assert.rejects(() => updateMovement('no-es-uuid', { categoria: 'Otros' }), /movimiento_id inválido/);
});
await asyncTest('delete sin confirmar: vista previa y NO borra nada', async () => {
  const t = baseTables(); installFakeDb(t);
  const r: any = await deleteMovement(MOV, {});
  assert.equal(r.ok, false);
  assert.equal(r.requiere_confirmacion, true);
  assert.equal(r.efectos.filas_importadas, 1);
  assert.equal(r.efectos.comprobantes_que_se_desvinculan, 1);
  assert.equal(t.finanzas_movimientos.length, 1);
  assert.equal(t.finanzas_movimientos_importados[0].estado, 'importado');
});
await asyncTest('delete confirmado: borra, ignora la fila importada y desvincula el comprobante', async () => {
  const t = baseTables(); installFakeDb(t);
  const r: any = await deleteMovement(MOV, { confirmar: true });
  assert.equal(r.ok, true);
  assert.equal(t.finanzas_movimientos.length, 0);
  assert.equal(t.finanzas_movimientos_importados[0].estado, 'ignorado');
  assert.equal(t.finanzas_movimientos_importados[0].movimiento_id, null);
  assert.equal(t.finanzas_comprobantes[0].movimiento_financiero_id, null);
  assert.equal(r.notion_archivado, false); // sin NOTION_TOKEN no puede archivar: debe avisar
  assert.ok(r.aviso && r.aviso.includes('page-1'));
});
await asyncTest('delete con devolver_a_pendientes: la fila importada vuelve a pendiente_revision limpia', async () => {
  const t = baseTables(); installFakeDb(t);
  await deleteMovement(MOV, { confirmar: true, devolver_a_pendientes: true });
  const imp = t.finanzas_movimientos_importados[0];
  assert.equal(imp.estado, 'pendiente_revision');
  assert.equal(imp.categoria_confirmada, null);
  assert.equal(imp.movimiento_id, null);
});
await asyncTest('delete sin página de Notion: notion_archivado true y sin aviso', async () => {
  const t = baseTables(); t.finanzas_movimientos[0].notion_page_id = null as any; installFakeDb(t);
  const r: any = await deleteMovement(MOV, { confirmar: true });
  assert.equal(r.notion_archivado, true);
  assert.equal(r.aviso, null);
});
await asyncTest('delete bloqueado si hay particiones de gasto compartido, aunque se confirme', async () => {
  const t = baseTables(); t.finanzas_particiones.push({ id: 'p1', movimiento_id: MOV } as any); installFakeDb(t);
  const r: any = await deleteMovement(MOV, { confirmar: true });
  assert.equal(r.bloqueado, true);
  assert.equal(t.finanzas_movimientos.length, 1);
  assert.equal(t.finanzas_movimientos_importados[0].estado, 'importado');
});
await asyncTest('delete bloqueado si hay deudas vinculadas', async () => {
  const t = baseTables(); t.finanzas_deudas.push({ id: 'd1', movimiento_id: MOV } as any); installFakeDb(t);
  const r: any = await deleteMovement(MOV, { confirmar: true });
  assert.equal(r.bloqueado, true);
});
await asyncTest('delete que falla en la base: ROLLBACK restaura importado y comprobante', async () => {
  const t = baseTables(); installFakeDb(t, 'finanzas_movimientos');
  await assert.rejects(() => deleteMovement(MOV, { confirmar: true }), /se restauraron los vínculos/);
  assert.equal(t.finanzas_movimientos.length, 1);
  const imp = t.finanzas_movimientos_importados[0];
  assert.equal(imp.estado, 'importado');
  assert.equal(imp.movimiento_id, MOV);
  assert.equal(imp.categoria_confirmada, 'Alimentos');
  assert.equal(t.finanzas_comprobantes[0].movimiento_financiero_id, MOV);
});
await asyncTest('find sin ningún filtro se rechaza (evita volcar toda la tabla)', async () => {
  installFakeDb(baseTables());
  await assert.rejects(() => findMovements({}), /al menos un filtro/);
});

console.log(`\n${passed} pruebas OK${process.exitCode ? ' — HAY FALLAS' : ''}`);
