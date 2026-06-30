import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config.js';
import { supabase, saveItem } from './supabaseClient.js';
import type { Clasificacion, EntidadClasificada, ItemInsert } from './types.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey() });

export type FinanceParse = {
  es_finanza: boolean;
  intencion: 'movimiento' | 'deuda' | 'pago_deuda' | 'ninguna' | string;
  titulo: string;
  resumen: string;
  tipo_movimiento: 'gasto' | 'ingreso' | 'devolucion' | 'transferencia' | 'ajuste' | string | null;
  monto: number | null;
  moneda: string | null;
  descripcion: string | null;
  categoria_financiera: string | null;
  subcategoria_financiera: string | null;
  medio_pago: string | null;
  tarjeta: string | null;
  banco_billetera: string | null;
  comercio: string | null;
  cuotas: number | null;
  estado: string | null;
  persona_deuda: string | null;
  tipo_deuda: 'me_debe' | 'yo_debo' | null | string;
  concepto_deuda: string | null;
  pago_deuda_monto: number | null;
  participantes: string[];
  participantes_pagaron: string[];
  dividir_incluye_usuario: boolean;
  fecha_movimiento: string | null;
  tags: string[];
  entidades: EntidadClasificada[];
};

const financeSchema = {
  type: Type.OBJECT,
  properties: {
    es_finanza: { type: Type.BOOLEAN },
    intencion: { type: Type.STRING },
    titulo: { type: Type.STRING },
    resumen: { type: Type.STRING },
    tipo_movimiento: { type: Type.STRING, nullable: true },
    monto: { type: Type.NUMBER, nullable: true },
    moneda: { type: Type.STRING, nullable: true },
    descripcion: { type: Type.STRING, nullable: true },
    categoria_financiera: { type: Type.STRING, nullable: true },
    subcategoria_financiera: { type: Type.STRING, nullable: true },
    medio_pago: { type: Type.STRING, nullable: true },
    tarjeta: { type: Type.STRING, nullable: true },
    banco_billetera: { type: Type.STRING, nullable: true },
    comercio: { type: Type.STRING, nullable: true },
    cuotas: { type: Type.NUMBER, nullable: true },
    estado: { type: Type.STRING, nullable: true },
    persona_deuda: { type: Type.STRING, nullable: true },
    tipo_deuda: { type: Type.STRING, nullable: true },
    concepto_deuda: { type: Type.STRING, nullable: true },
    pago_deuda_monto: { type: Type.NUMBER, nullable: true },
    participantes: { type: Type.ARRAY, items: { type: Type.STRING } },
    participantes_pagaron: { type: Type.ARRAY, items: { type: Type.STRING } },
    dividir_incluye_usuario: { type: Type.BOOLEAN },
    fecha_movimiento: { type: Type.STRING, nullable: true },
    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    entidades: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          tipo: { type: Type.STRING },
          nombre: { type: Type.STRING }
        },
        required: ['tipo', 'nombre']
      }
    }
  },
  required: [
    'es_finanza','intencion','titulo','resumen','tipo_movimiento','monto','moneda','descripcion',
    'categoria_financiera','subcategoria_financiera','medio_pago','tarjeta','banco_billetera','comercio',
    'cuotas','estado','persona_deuda','tipo_deuda','concepto_deuda','pago_deuda_monto','participantes',
    'participantes_pagaron','dividir_incluye_usuario','fecha_movimiento','tags','entidades'
  ]
};

const FINANCE_PROMPT = `
Sos el parser financiero del cerebro personal del usuario.
Convertí mensajes naturales sobre gastos, ingresos, tarjetas, Mercado Pago, deudas, pagos y gastos compartidos en JSON.

Reglas:
- Si no es financiero, es_finanza=false e intencion="ninguna".
- Moneda por defecto: ARS.
- Monto debe ser número sin símbolo, sin puntos de miles.
- Medios de pago normalizados: Visa crédito; Mastercard crédito; Mercado Pago; Banco Galicia; Débito; Efectivo; Transferencia; Otro.
- Si dice visa: medio_pago=Visa crédito y tarjeta=Visa.
- Si dice master/mastercard: medio_pago=Mastercard crédito y tarjeta=Mastercard.
- Si dice MP/mercado pago: medio_pago=Mercado Pago y banco_billetera=Mercado Pago.
- Si dice Galicia: banco_billetera=Banco Galicia.
- Categorías financieras: Alimentos; Supermercado; Comida afuera; Transporte; Casa; Servicios; Salud; Farmacia; Ropa; Tecnología; Educación; Trabajo; Ocio; Regalos; Suscripciones; Impuestos; Alquiler; Auto; Transferencias; Deudas / compartidos; Ingreso laboral; Otros.
- Para salario/sueldo/aguinaldo/vacaciones: intencion=movimiento, tipo_movimiento=ingreso, categoria_financiera=Ingreso laboral.
- Para gasto: intencion=movimiento, tipo_movimiento=gasto.
- Para "X me debe": intencion=deuda, tipo_deuda=me_debe.
- Para "yo le debo a X" o "le debo a X": intencion=deuda, tipo_deuda=yo_debo.
- Para "X me pagó/devolvió": intencion=pago_deuda, tipo_deuda=me_debe, persona_deuda=X.
- Para "pagué a X lo que debía": intencion=pago_deuda, tipo_deuda=yo_debo, persona_deuda=X.
- Si un gasto se divide entre varias personas, incluir participantes. Si aparece "yo", "mí", "Cristian" o "Cris", dividir_incluye_usuario=true.
- participantes_pagaron incluye personas que ya pagaron su parte.
- No inventes cuotas si no aparecen.
- Entidades útiles: Comercio, Persona, Medio de pago, Banco / billetera, Tarjeta, Categoría financiera.
`;

export function looksLikeFinanceText(text: string) {
  const t = normalizeLoose(text);
  if (!t) return false;
  if (/^\/?finanzas\b/.test(t)) return true;
  const keywords = [
    'gaste','gasté','compre','compré','pague','pagué','pago','pagó','me pago','me pagó','me devolvio','me devolvió',
    'me debe','le debo','debo','deuda','dividir','repartir','entre','tarjeta','visa','master','mastercard','mercado pago','mp',
    'sueldo','salario','aguinaldo','vacaciones','ingreso','transferencia','cuotas','cierre','vencimiento','carrefour','supermercado'
  ];
  if (keywords.some(k => t.includes(normalizeLoose(k)))) return true;
  return /\$\s*\d/.test(text) || /\b\d+[\.,]?\d*\s*(pesos|ars)\b/i.test(text);
}

export async function parseFinanceText(text: string): Promise<FinanceParse> {
  const response = await ai.models.generateContent({
    model: config.geminiModel(),
    contents: `${FINANCE_PROMPT}\n\nMensaje:\n${text}`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: financeSchema
    }
  });

  const raw = response.text;
  if (!raw) throw new Error('Gemini no devolvió texto financiero');
  return normalizeFinanceParse(JSON.parse(raw));
}

export async function saveFinanceFromText(input: {
  chatId: number;
  messageId: number;
  userId?: number;
  text: string;
}) {
  const parsed = await parseFinanceText(input.text);
  if (!parsed.es_finanza || parsed.intencion === 'ninguna') return { ok: false as const, reason: 'no_finance' };

  const clasificacion = financeToClassification(parsed, input.text);
  const insert: ItemInsert = {
    fuente: 'telegram',
    telegram_user_id: input.userId ? String(input.userId) : undefined,
    telegram_chat_id: String(input.chatId),
    telegram_message_id: String(input.messageId),
    texto_original: input.text,
    titulo: clasificacion.titulo,
    resumen: clasificacion.resumen,
    categoria_principal: clasificacion.categoria_principal,
    subcategorias: clasificacion.subcategorias,
    tipo_item: clasificacion.tipo_item,
    estado: clasificacion.estado,
    valoracion: clasificacion.valoracion,
    importancia: clasificacion.importancia,
    accion_futura: clasificacion.accion_futura,
    tags: clasificacion.tags,
    entidades_json: clasificacion.entidades,
    classifier_json: clasificacion
  };

  const item = await saveItem(insert);
  const persisted = await persistFinance(parsed, item.id);

  return { ok: true as const, item, parsed, clasificacion, persisted };
}

export async function persistFinance(parsed: FinanceParse, itemId: string) {
  let movimiento: any = null;
  let deuda: any = null;
  let pago: any = null;
  const particiones: any[] = [];
  const deudasCreadas: any[] = [];

  if (parsed.intencion === 'movimiento') {
    movimiento = await insertMovimiento(parsed, itemId);
    const split = normalizeParticipants(parsed.participantes);
    if (parsed.tipo_movimiento === 'gasto' && movimiento && split.length >= 2 && parsed.monto) {
      const share = roundMoney(parsed.monto / split.length);
      for (const person of split) {
        const isSelf = isSelfPerson(person);
        const paid = parsed.participantes_pagaron.some(p => samePerson(p, person));
        const { data, error } = await supabase
          .from('finanzas_particiones')
          .insert({
            movimiento_id: movimiento.id,
            persona: person,
            monto_asignado: share,
            monto_pagado: isSelf || paid ? share : 0,
            estado: isSelf || paid ? 'pagado' : 'pendiente'
          })
          .select()
          .single();
        if (error) throw error;
        particiones.push(data);

        if (!isSelf && !paid) {
          const d = await insertDebt({
            itemId,
            movimientoId: movimiento.id,
            persona: person,
            tipo: 'me_debe',
            montoTotal: share,
            montoPagado: 0,
            concepto: parsed.descripcion || parsed.comercio || parsed.titulo || 'Gasto compartido',
            fecha: parsed.fecha_movimiento
          });
          deudasCreadas.push(d);
        }
      }
    }
  }

  if (parsed.intencion === 'deuda') {
    deuda = await insertDebt({
      itemId,
      movimientoId: null,
      persona: parsed.persona_deuda || 'Persona sin identificar',
      tipo: parsed.tipo_deuda === 'yo_debo' ? 'yo_debo' : 'me_debe',
      montoTotal: parsed.monto || 0,
      montoPagado: 0,
      concepto: parsed.concepto_deuda || parsed.descripcion || parsed.titulo || 'Deuda',
      fecha: parsed.fecha_movimiento
    });
  }

  if (parsed.intencion === 'pago_deuda') {
    movimiento = await insertMovimiento({
      ...parsed,
      intencion: 'movimiento',
      tipo_movimiento: parsed.tipo_deuda === 'yo_debo' ? 'gasto' : 'devolucion',
      categoria_financiera: 'Deudas / compartidos',
      descripcion: parsed.descripcion || parsed.concepto_deuda || 'Pago de deuda',
      comercio: parsed.persona_deuda || parsed.comercio,
      monto: parsed.pago_deuda_monto || parsed.monto
    }, itemId);
    pago = await applyDebtPayment(parsed);
  }

  return { movimiento, deuda, pago, particiones, deudasCreadas };
}

async function insertMovimiento(parsed: Partial<FinanceParse>, itemId: string) {
  const { data, error } = await supabase
    .from('finanzas_movimientos')
    .insert({
      fecha_movimiento: normalizeDate(parsed.fecha_movimiento) || new Date().toISOString().slice(0, 10),
      tipo: normalizeTipoMovimiento(parsed.tipo_movimiento),
      monto: Number(parsed.monto || parsed.pago_deuda_monto || 0),
      moneda: parsed.moneda || 'ARS',
      descripcion: parsed.descripcion || parsed.resumen || parsed.titulo || null,
      categoria_financiera: parsed.categoria_financiera || 'Otros',
      subcategoria_financiera: parsed.subcategoria_financiera || null,
      medio_pago: normalizePaymentMethod(parsed.medio_pago || parsed.tarjeta || parsed.banco_billetera),
      tarjeta: normalizeTarjeta(parsed.tarjeta || parsed.medio_pago),
      banco_billetera: normalizeBancoBilletera(parsed.banco_billetera || parsed.medio_pago),
      comercio: parsed.comercio || null,
      cuotas: parsed.cuotas ? Number(parsed.cuotas) : null,
      estado: parsed.estado || 'confirmado',
      item_id: itemId
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function insertDebt(input: {
  itemId: string;
  movimientoId?: string | null;
  persona: string;
  tipo: 'me_debe' | 'yo_debo';
  montoTotal: number;
  montoPagado?: number;
  concepto: string;
  fecha?: string | null;
}) {
  const montoPagado = Number(input.montoPagado || 0);
  const total = Number(input.montoTotal || 0);
  const saldo = Math.max(0, roundMoney(total - montoPagado));
  const { data, error } = await supabase
    .from('finanzas_deudas')
    .insert({
      persona: normalizePerson(input.persona),
      tipo: input.tipo,
      monto_total: total,
      monto_pagado: montoPagado,
      saldo_pendiente: saldo,
      moneda: 'ARS',
      concepto: input.concepto || 'Deuda',
      estado: saldo <= 0 ? 'saldado' : montoPagado > 0 ? 'parcial' : 'pendiente',
      fecha_origen: normalizeDate(input.fecha) || new Date().toISOString().slice(0, 10),
      movimiento_id: input.movimientoId || null,
      item_id: input.itemId
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function applyDebtPayment(parsed: FinanceParse) {
  const persona = parsed.persona_deuda ? normalizePerson(parsed.persona_deuda) : '';
  const amount = Number(parsed.pago_deuda_monto || parsed.monto || 0);
  if (!persona || !amount) return { applied: false, reason: 'faltan persona o monto' };

  const type = parsed.tipo_deuda === 'yo_debo' ? 'yo_debo' : 'me_debe';
  const { data, error } = await supabase
    .from('finanzas_deudas')
    .select('*')
    .eq('tipo', type)
    .neq('estado', 'saldado')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;

  const rows = (data || []).filter((d: any) => samePerson(d.persona, persona));
  if (!rows.length) return { applied: false, reason: 'no encontré deuda abierta para esa persona' };

  const conceptKey = normalizeLoose(parsed.concepto_deuda || parsed.descripcion || '');
  const target = conceptKey
    ? rows.find((d: any) => normalizeLoose(d.concepto || '').includes(conceptKey) || conceptKey.includes(normalizeLoose(d.concepto || ''))) || rows[0]
    : rows[0];

  const paid = roundMoney(Number(target.monto_pagado || 0) + amount);
  const saldo = Math.max(0, roundMoney(Number(target.monto_total || 0) - paid));
  const estado = saldo <= 0 ? 'saldado' : 'parcial';

  const { data: updated, error: updateError } = await supabase
    .from('finanzas_deudas')
    .update({ monto_pagado: paid, saldo_pendiente: saldo, estado })
    .eq('id', target.id)
    .select()
    .single();

  if (updateError) throw updateError;
  return { applied: true, deuda: updated, pago: amount };
}

export async function getFinanceSummary() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const { data: movements, error: movementError } = await supabase
    .from('finanzas_movimientos')
    .select('*')
    .gte('fecha_movimiento', monthStart)
    .lte('fecha_movimiento', today)
    .order('fecha_movimiento', { ascending: false })
    .limit(200);
  if (movementError) throw movementError;

  const { data: debts, error: debtError } = await supabase
    .from('finanzas_deudas')
    .select('*')
    .neq('estado', 'saldado')
    .order('created_at', { ascending: false })
    .limit(100);
  if (debtError) throw debtError;

  const rows = movements || [];
  const gastos = rows.filter((m: any) => m.tipo === 'gasto').reduce((a: number, m: any) => a + Number(m.monto || 0), 0);
  const ingresos = rows.filter((m: any) => ['ingreso','devolucion'].includes(m.tipo)).reduce((a: number, m: any) => a + Number(m.monto || 0), 0);
  const byCategory = groupMoney(rows.filter((m: any) => m.tipo === 'gasto'), 'categoria_financiera');
  const byPayment = groupMoney(rows.filter((m: any) => m.tipo === 'gasto'), 'medio_pago');
  const meDeben = (debts || []).filter((d: any) => d.tipo === 'me_debe').reduce((a: number, d: any) => a + Number(d.saldo_pendiente || 0), 0);
  const debo = (debts || []).filter((d: any) => d.tipo === 'yo_debo').reduce((a: number, d: any) => a + Number(d.saldo_pendiente || 0), 0);

  return { monthStart, today, gastos, ingresos, balance: ingresos - gastos, byCategory, byPayment, debts: debts || [], movements: rows, meDeben, debo };
}

export function formatFinanceSummary(summary: Awaited<ReturnType<typeof getFinanceSummary>>) {
  const lines = [
    'Finanzas',
    '',
    `Período: ${summary.monthStart} a ${summary.today}`,
    `Ingresos/devoluciones: ${money(summary.ingresos)}`,
    `Gastos: ${money(summary.gastos)}`,
    `Balance registrado: ${money(summary.balance)}`,
    '',
    `Me deben: ${money(summary.meDeben)}`,
    `Yo debo: ${money(summary.debo)}`
  ];

  if (summary.byCategory.length) {
    lines.push('', 'Gastos por categoría:');
    for (const row of summary.byCategory.slice(0, 8)) lines.push(`• ${row.label}: ${money(row.amount)}`);
  }

  if (summary.byPayment.length) {
    lines.push('', 'Gastos por medio:');
    for (const row of summary.byPayment.slice(0, 6)) lines.push(`• ${row.label}: ${money(row.amount)}`);
  }

  const debts = summary.debts.slice(0, 8);
  if (debts.length) {
    lines.push('', 'Deudas abiertas:');
    for (const d of debts) {
      const label = d.tipo === 'me_debe' ? `${d.persona} me debe` : `Yo debo a ${d.persona}`;
      lines.push(`• ${label}: ${money(d.saldo_pendiente)} — ${d.concepto || '-'}`);
    }
  }

  if (!summary.movements.length && !summary.debts.length) lines.push('', 'Todavía no hay movimientos financieros registrados.');
  return lines.join('\n');
}

export function formatFinanceSaved(result: Awaited<ReturnType<typeof saveFinanceFromText>>) {
  if (!result.ok) return 'No era un movimiento financiero.';
  const p = result.parsed;
  const persisted = result.persisted;
  const lines = ['Finanzas guardado.', ''];

  if (persisted.movimiento) {
    lines.push(`Movimiento: ${labelTipoMovimiento(persisted.movimiento.tipo)}`);
    lines.push(`Monto: ${money(persisted.movimiento.monto)}`);
    lines.push(`Categoría: ${persisted.movimiento.categoria_financiera || '-'}`);
    lines.push(`Medio: ${persisted.movimiento.medio_pago || '-'}`);
    if (persisted.movimiento.comercio) lines.push(`Comercio/persona: ${persisted.movimiento.comercio}`);
  }

  if (persisted.deuda) {
    const d = persisted.deuda;
    lines.push(`Deuda: ${d.tipo === 'me_debe' ? `${d.persona} me debe` : `Yo debo a ${d.persona}`}`);
    lines.push(`Monto: ${money(d.monto_total)}`);
    lines.push(`Concepto: ${d.concepto || '-'}`);
    lines.push(`Estado: ${d.estado}`);
  }

  if (persisted.deudasCreadas?.length) {
    lines.push('', 'Partes pendientes:');
    for (const d of persisted.deudasCreadas) lines.push(`• ${d.persona}: ${money(d.saldo_pendiente)}`);
  }

  if (persisted.pago?.applied) {
    const d = persisted.pago.deuda;
    lines.push(`Pago aplicado: ${money(persisted.pago.pago)}`);
    lines.push(`Saldo pendiente: ${money(d.saldo_pendiente)}`);
  } else if (persisted.pago && !persisted.pago.applied) {
    lines.push(`Pago registrado, pero no encontré deuda abierta para imputarlo automáticamente.`);
  }

  if (!persisted.movimiento && !persisted.deuda && !persisted.pago) {
    lines.push(p.resumen || 'Movimiento financiero registrado.');
  }

  return lines.join('\n');
}

function financeToClassification(p: FinanceParse, originalText: string): Clasificacion {
  const entities = uniqueFinanceEntities([
    ...(p.entidades || []),
    p.comercio ? { tipo: 'Comercio', nombre: p.comercio } : null,
    p.persona_deuda ? { tipo: 'Persona', nombre: p.persona_deuda } : null,
    p.medio_pago ? { tipo: 'Medio de pago', nombre: p.medio_pago } : null,
    p.tarjeta ? { tipo: 'Tarjeta', nombre: p.tarjeta } : null,
    p.banco_billetera ? { tipo: 'Banco / billetera', nombre: p.banco_billetera } : null,
    p.categoria_financiera ? { tipo: 'Categoría financiera', nombre: p.categoria_financiera } : null,
    ...normalizeParticipants(p.participantes).map(nombre => ({ tipo: 'Persona', nombre }))
  ].filter(Boolean) as EntidadClasificada[]);

  const tags = uniqueStrings([
    'finanzas',
    p.tipo_movimiento || '',
    p.intencion || '',
    p.categoria_financiera || '',
    p.medio_pago || '',
    p.tarjeta || '',
    p.comercio || ''
  ].concat(p.tags || [])).map(toTag);

  let tipoItem = 'Movimiento financiero';
  if (p.intencion === 'deuda') tipoItem = 'Deuda';
  if (p.intencion === 'pago_deuda') tipoItem = 'Pago de deuda';

  const montoTxt = p.monto ? ` ${money(p.monto)}` : '';
  return {
    titulo: p.titulo || `${tipoItem}${montoTxt}`.trim(),
    resumen: p.resumen || originalText,
    categoria_principal: 'Finanzas personales',
    subcategorias: uniqueStrings([p.categoria_financiera || 'General', p.medio_pago || '', p.tarjeta || '']).filter(Boolean),
    tipo_item: tipoItem,
    estado: p.estado || (p.intencion === 'deuda' ? 'Pendiente' : 'Confirmado'),
    valoracion: null,
    importancia: 'Media',
    accion_futura: p.intencion === 'deuda' ? 'Seguimiento de deuda/pago pendiente.' : null,
    tags,
    entidades: entities,
    memorias_sugeridas: []
  };
}

function normalizeFinanceParse(raw: any): FinanceParse {
  const parsed: FinanceParse = {
    es_finanza: Boolean(raw?.es_finanza),
    intencion: raw?.intencion || 'ninguna',
    titulo: clean(raw?.titulo) || 'Movimiento financiero',
    resumen: clean(raw?.resumen) || '',
    tipo_movimiento: normalizeTipoMovimiento(raw?.tipo_movimiento),
    monto: toNumber(raw?.monto),
    moneda: clean(raw?.moneda) || 'ARS',
    descripcion: clean(raw?.descripcion) || null,
    categoria_financiera: normalizeFinanceCategory(raw?.categoria_financiera),
    subcategoria_financiera: clean(raw?.subcategoria_financiera) || null,
    medio_pago: normalizePaymentMethod(raw?.medio_pago || raw?.tarjeta || raw?.banco_billetera),
    tarjeta: normalizeTarjeta(raw?.tarjeta || raw?.medio_pago),
    banco_billetera: normalizeBancoBilletera(raw?.banco_billetera || raw?.medio_pago),
    comercio: clean(raw?.comercio) || null,
    cuotas: toNumber(raw?.cuotas),
    estado: clean(raw?.estado) || null,
    persona_deuda: clean(raw?.persona_deuda) || null,
    tipo_deuda: raw?.tipo_deuda === 'yo_debo' ? 'yo_debo' : raw?.tipo_deuda === 'me_debe' ? 'me_debe' : null,
    concepto_deuda: clean(raw?.concepto_deuda) || null,
    pago_deuda_monto: toNumber(raw?.pago_deuda_monto),
    participantes: Array.isArray(raw?.participantes) ? raw.participantes.map(clean).filter(Boolean) : [],
    participantes_pagaron: Array.isArray(raw?.participantes_pagaron) ? raw.participantes_pagaron.map(clean).filter(Boolean) : [],
    dividir_incluye_usuario: Boolean(raw?.dividir_incluye_usuario),
    fecha_movimiento: normalizeDate(raw?.fecha_movimiento),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(clean).filter(Boolean) : [],
    entidades: Array.isArray(raw?.entidades) ? raw.entidades.filter((e: any) => e?.tipo && e?.nombre).map((e: any) => ({ tipo: clean(e.tipo), nombre: clean(e.nombre) })) : []
  };

  // Ajustes obvios por texto de parser.
  if (parsed.intencion === 'deuda' && !parsed.tipo_deuda) parsed.tipo_deuda = 'me_debe';
  if (parsed.intencion === 'pago_deuda' && !parsed.tipo_deuda) parsed.tipo_deuda = 'me_debe';
  return parsed;
}

function normalizeTipoMovimiento(value: any) {
  const v = normalizeLoose(value);
  if (!v) return null;
  if (v.includes('ingreso') || v.includes('sueldo') || v.includes('salario')) return 'ingreso';
  if (v.includes('devol')) return 'devolucion';
  if (v.includes('trans')) return 'transferencia';
  if (v.includes('ajuste')) return 'ajuste';
  if (v.includes('gasto') || v.includes('compra') || v.includes('pago')) return 'gasto';
  return v;
}

function normalizePaymentMethod(value: any) {
  const v = normalizeLoose(value);
  if (!v) return null;
  if (v.includes('visa')) return 'Visa crédito';
  if (v.includes('master')) return 'Mastercard crédito';
  if (v.includes('mercado') || v === 'mp') return 'Mercado Pago';
  if (v.includes('galicia')) return 'Banco Galicia';
  if (v.includes('debito') || v.includes('débito')) return 'Débito';
  if (v.includes('efectivo')) return 'Efectivo';
  if (v.includes('trans')) return 'Transferencia';
  return clean(value) || 'Otro';
}

function normalizeTarjeta(value: any) {
  const v = normalizeLoose(value);
  if (v.includes('visa')) return 'Visa';
  if (v.includes('master')) return 'Mastercard';
  return null;
}

function normalizeBancoBilletera(value: any) {
  const v = normalizeLoose(value);
  if (v.includes('mercado') || v === 'mp') return 'Mercado Pago';
  if (v.includes('galicia')) return 'Banco Galicia';
  return null;
}

function normalizeFinanceCategory(value: any) {
  const v = normalizeLoose(value);
  if (!v) return 'Otros';
  if (v.includes('super')) return 'Supermercado';
  if (v.includes('alimento')) return 'Alimentos';
  if (v.includes('comida') || v.includes('restaurant') || v.includes('cena') || v.includes('almuerzo')) return 'Comida afuera';
  if (v.includes('transporte')) return 'Transporte';
  if (v.includes('servicio')) return 'Servicios';
  if (v.includes('salud')) return 'Salud';
  if (v.includes('farm')) return 'Farmacia';
  if (v.includes('ropa')) return 'Ropa';
  if (v.includes('tecno')) return 'Tecnología';
  if (v.includes('educ')) return 'Educación';
  if (v.includes('sueldo') || v.includes('salario') || v.includes('ingreso')) return 'Ingreso laboral';
  if (v.includes('deuda') || v.includes('compart')) return 'Deudas / compartidos';
  return clean(value) || 'Otros';
}

function normalizeParticipants(values: string[]) {
  return uniqueStrings((values || []).map(normalizePerson).filter(Boolean));
}

function normalizePerson(value: string) {
  const v = clean(value).replace(/^a\s+/i, '');
  const key = normalizeLoose(v);
  if (['yo','mi','mí','cristian','cris','matias','matías'].includes(key)) return 'Cristian';
  return v ? v[0].toUpperCase() + v.slice(1) : '';
}

function isSelfPerson(value: string) {
  return normalizeLoose(normalizePerson(value)) === 'cristian';
}

function samePerson(a: string, b: string) {
  return normalizeLoose(normalizePerson(a)) === normalizeLoose(normalizePerson(b));
}

function normalizeDate(value: any) {
  const v = clean(value);
  if (!v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function groupMoney(rows: any[], key: string) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const label = row[key] || 'Sin clasificar';
    map.set(label, (map.get(label) || 0) + Number(row.monto || 0));
  }
  return [...map.entries()]
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => b.amount - a.amount);
}

function labelTipoMovimiento(value: string) {
  if (value === 'gasto') return 'Gasto';
  if (value === 'ingreso') return 'Ingreso';
  if (value === 'devolucion') return 'Devolución';
  if (value === 'transferencia') return 'Transferencia';
  return value || 'Movimiento';
}

function money(value: any) {
  const n = Number(value || 0);
  return `$${Math.round(n).toLocaleString('es-AR')}`;
}

function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toNumber(value: any) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).replace(/\./g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function uniqueFinanceEntities(values: EntidadClasificada[]) {
  const seen = new Set<string>();
  const out: EntidadClasificada[] = [];
  for (const e of values) {
    const tipo = clean(e.tipo);
    const nombre = clean(e.nombre);
    if (!tipo || !nombre) continue;
    const key = `${normalizeLoose(tipo)}::${normalizeLoose(nombre)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tipo, nombre });
  }
  return out;
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values || []) {
    const v = clean(raw);
    const key = normalizeLoose(v);
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function toTag(value: string) {
  return normalizeLoose(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function clean(value: any) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeLoose(value: any) {
  return clean(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
