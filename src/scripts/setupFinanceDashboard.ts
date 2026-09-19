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

  const filtroGastoMes = {
    and: [
      { property: 'Tipo', select: { equals: 'gasto' } },
      { property: 'Fecha', date: { this_month: {} } }
    ]
  };
  const filtroGasto = { property: 'Tipo', select: { equals: 'gasto' } };

  // 1) Board agrupado por categoría (tab nueva en la base).
  console.log('Creando board "Por categoría"...');
  const board = await createView({
    database_id: databaseId,
    data_source_id: dataSourceId,
    name: 'Por categoría',
    type: 'board',
    configuration: {
      type: 'board',
      group_by: { type: 'select', property_id: categoriaId, sort: { type: 'manual' } },
      card_layout: 'compact'
    }
  });
  console.log('  ->', board.url);

  // 2) Dashboard con 4 gráficos.
  console.log('Creando dashboard "Panel financiero"...');
  const dashboard = await createView({
    database_id: databaseId,
    data_source_id: dataSourceId,
    name: 'Panel financiero',
    type: 'dashboard'
  });
  console.log('  ->', dashboard.url);

  console.log('Agregando widget: Gastado este mes (número)...');
  await createView({
    view_id: dashboard.id,
    data_source_id: dataSourceId,
    name: 'Gastado este mes',
    type: 'chart',
    filter: filtroGastoMes,
    configuration: {
      type: 'chart',
      chart_type: 'number',
      value: { aggregator: 'sum', property_id: montoId }
    },
    placement: { type: 'new_row' }
  });

  console.log('Agregando widget: Por categoría este mes (dona)...');
  await createView({
    view_id: dashboard.id,
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
    },
    placement: { type: 'existing_row', row_index: 0 }
  });

  console.log('Agregando widget: Gasto por categoría histórico (columnas)...');
  await createView({
    view_id: dashboard.id,
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
    },
    placement: { type: 'new_row' }
  });

  console.log('Agregando widget: Cashflow mensual acumulado (línea)...');
  await createView({
    view_id: dashboard.id,
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
    },
    placement: { type: 'new_row' }
  });

  console.log('');
  console.log('Listo. En "Finanzas - Movimientos" en Notion ahora hay dos tabs nuevas: "Por categoría" y "Panel financiero".');
  console.log('Los montos de gasto están guardados en negativo (como en el resumen bancario), así que la dona/columnas/número van a mostrar números negativos. Es esperable, no un error.');
}

main().catch((error) => {
  console.error('Error creando el dashboard financiero:', error?.message || error);
  process.exit(1);
});
