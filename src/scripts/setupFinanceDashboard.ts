import dotenv from 'dotenv';
import { config } from '../config.js';
import { getAppConfigValue } from '../supabaseClient.js';

dotenv.config();

// La Views API (board/chart/dashboard) es nueva (2025-09-03+) y el SDK
// @notionhq/client instalado en este repo (2.2.15) es de antes de eso, así que
// acá se pega directo a la API REST con fetch en vez de usar el cliente viejo.
const NOTION_VERSION = '2026-03-11';
const token = config.notionToken();

if (!token) {
  console.error('Falta NOTION_TOKEN.');
  process.exit(1);
}

async function notionFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Notion API ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createView(body: Record<string, any>) {
  return notionFetch('/views', { method: 'POST', body: JSON.stringify(body) });
}

async function updateView(viewId: string, body: Record<string, any>) {
  return notionFetch(`/views/${viewId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

async function main() {
  const databaseId = await getAppConfigValue('notion_finanzas_movimientos_database_id');
  if (!databaseId) {
    console.error(
      'No encontré notion_finanzas_movimientos_database_id en app_config. ' +
      'Corré primero npm run setup:notion (o /finanzas setup por Telegram) para crear la base "Finanzas - Movimientos".'
    );
    process.exit(1);
  }

  console.log('Base Finanzas - Movimientos:', databaseId);
  const db = await notionFetch(`/databases/${databaseId}`);
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) throw new Error('No encontré data_source_id de la base. ¿Es una base vieja pre-2025-09-03? Puede necesitar migración en Notion.');

  const dataSource = await notionFetch(`/data_sources/${dataSourceId}`);
  const properties = dataSource.properties || {};

  function propId(name: string): string {
    const p = properties[name];
    if (!p) throw new Error(`No encontré la propiedad "${name}" en la base. Propiedades disponibles: ${Object.keys(properties).join(', ')}`);
    return p.id;
  }

  const categoriaId = propId('Categoría');
  const montoId = propId('Monto');
  const fechaId = propId('Fecha');
  const comercioId = propId('Comercio');
  const estadoId = propId('Estado');
  const tituloId = propId('Título');

  // Qué se ve en cada tarjeta del board: lo útil de un vistazo (monto, fecha,
  // comercio, estado), todo lo demás oculto para que no quede sobrecargado.
  const cardProperties = [
    { property_id: tituloId, visible: true },
    { property_id: montoId, visible: true },
    { property_id: fechaId, visible: true },
    { property_id: comercioId, visible: true },
    { property_id: estadoId, visible: true },
    { property_id: categoriaId, visible: false }
  ];
  for (const name of ['Tipo', 'Moneda', 'Medio pago', 'Tarjeta', 'Banco / billetera', 'Cuotas', 'Descripción', 'Movimiento ID', 'Item ID']) {
    if (properties[name]) cardProperties.push({ property_id: properties[name].id, visible: false });
  }

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)).toISOString().slice(0, 10);
  const startOfNextMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1)).toISOString().slice(0, 10);

  const filtroGastoMes = {
    and: [
      { property: 'Tipo', select: { equals: 'gasto' } },
      { property: 'Fecha', date: { on_or_after: startOfMonth } },
      { property: 'Fecha', date: { before: startOfNextMonth } }
    ]
  };
  const filtroGasto = { property: 'Tipo', select: { equals: 'gasto' } };

  const existingViews = new Map<string, string>();
  const existingViewsList = await notionFetch(`/views?database_id=${databaseId}`);
  for (const ref of existingViewsList.results || []) {
    try {
      const full = await notionFetch(`/views/${ref.id}`);
      if (full?.name) existingViews.set(full.name, full.id);
    } catch (_) { /* ignorar vistas que no se puedan leer */ }
  }

  // Si la vista ya existe la actualiza (config/filtro nuevos pisan los viejos);
  // si no, la crea. Así se puede correr el script de nuevo después de ajustar
  // algo sin tener que borrar nada a mano en Notion primero.
  async function upsertView(name: string, body: Record<string, any>) {
    const existingId = existingViews.get(name);
    if (existingId) {
      console.log(`Actualizando "${name}"...`);
      const { database_id, data_source_id, type, ...patchable } = body;
      const view = await updateView(existingId, patchable);
      console.log('  ->', view.url);
      return view;
    }
    console.log(`Creando "${name}"...`);
    const view = await createView(body);
    console.log('  ->', view.url);
    return view;
  }

  // 1) Board agrupado por categoría. card_layout "list" (en vez de "compact")
  // muestra las propiedades debajo del título, no solo el nombre pelado.
  await upsertView('Por categoría', {
    database_id: databaseId,
    data_source_id: dataSourceId,
    name: 'Por categoría',
    type: 'board',
    configuration: {
      type: 'board',
      group_by: { type: 'select', property_id: categoriaId, sort: { type: 'manual' } },
      card_layout: 'list',
      properties: cardProperties
    }
  });

  // 2) Cuatro vistas de gráfico independientes (tabs en la base), en vez de un
  // dashboard con widgets: Notion pide plan Business para agregar/editar widgets
  // dentro de una vista tipo "dashboard", pero las vistas de gráfico sueltas no
  // deberían estar detrás de ese mismo límite.
  await upsertView('Gastado este mes', {
    database_id: databaseId,
    data_source_id: dataSourceId,
    name: 'Gastado este mes',
    type: 'chart',
    filter: filtroGastoMes,
    configuration: {
      type: 'chart',
      chart_type: 'number',
      value: { aggregator: 'sum', property_id: montoId }
    }
  });

  await upsertView('Por categoría (este mes)', {
    database_id: databaseId,
    data_source_id: dataSourceId,
    name: 'Por categoría (este mes)',
    type: 'chart',
    filter: filtroGastoMes,
    configuration: {
      type: 'chart',
      chart_type: 'donut',
      x_axis: { type: 'select', property_id: categoriaId, sort: { type: 'manual' } },
      y_axis: { aggregator: 'sum', property_id: montoId },
      donut_labels: 'name_and_value',
      legend_position: 'side'
    }
  });

  await upsertView('Gasto por categoría (histórico)', {
    database_id: databaseId,
    data_source_id: dataSourceId,
    name: 'Gasto por categoría (histórico)',
    type: 'chart',
    filter: filtroGasto,
    configuration: {
      type: 'chart',
      chart_type: 'column',
      x_axis: { type: 'select', property_id: categoriaId, sort: { type: 'y_ascending' } },
      y_axis: { aggregator: 'sum', property_id: montoId },
      color_by_value: true,
      show_data_labels: true
    }
  });

  await upsertView('Cashflow mensual acumulado', {
    database_id: databaseId,
    data_source_id: dataSourceId,
    name: 'Cashflow mensual acumulado',
    type: 'chart',
    configuration: {
      type: 'chart',
      chart_type: 'line',
      x_axis: { type: 'date', property_id: fechaId, group_by: 'month', sort: { type: 'manual' } },
      y_axis: { aggregator: 'sum', property_id: montoId },
      cumulative: true,
      smooth_line: true
    }
  });

  console.log('');
  console.log('Listo. En "Finanzas - Movimientos" en Notion: "Por categoría" (board) y 4 gráficos.');
  console.log('Si tenías una tab vacía "Panel financiero" de un intento anterior (bloqueada por plan Business para dashboards), borrala a mano: abrila, "..." arriba a la derecha -> Eliminar vista.');
  console.log('Los montos de gasto están guardados en negativo (como en el resumen bancario), así que la dona/columnas/número van a mostrar números negativos. Es esperable, no un error.');
}

main().catch((error) => {
  console.error('Error creando el dashboard financiero:', error?.message || error);
  process.exit(1);
});
