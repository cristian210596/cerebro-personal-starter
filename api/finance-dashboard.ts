import { config as appConfig } from '../src/config.js';
import { buildFinanceDashboardData, type FinanceDashboardData } from '../src/financeDashboardData.js';

export const config = {
  maxDuration: 15
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.status(405).send('method not allowed');
    return;
  }

  const secret = appConfig.dashboardSecret();
  if (secret) {
    const provided = String(req.query?.key || '');
    if (provided !== secret) {
      res.status(401).send('unauthorized: falta ?key=... correcto');
      return;
    }
  }

  try {
    const data = await buildFinanceDashboardData();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderHtml(data));
  } catch (error: any) {
    console.error('finance-dashboard falló:', error);
    res.status(500).send(`<pre>Error generando el panel: ${escapeHtml(String(error?.message || error))}</pre>`);
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function money(value: number) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(value);
}

function monthLabel(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const nombres = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${nombres[(m || 1) - 1]} ${String(y).slice(2)}`;
}

function renderHtml(data: FinanceDashboardData) {
  const catEsteMesLabels = data.categoriasEsteMes.map(c => c.categoria);
  const catEsteMesValues = data.categoriasEsteMes.map(c => c.total);
  const catHistLabels = data.categoriasHistorico.map(c => c.categoria);
  const catHistValues = data.categoriasHistorico.map(c => c.total);
  const mesesLabels = data.serieMensual.map(s => monthLabel(s.mes));
  const acumuladoValues = data.serieMensual.map(s => Math.round(s.acumulado));
  const netoValues = data.serieMensual.map(s => Math.round(s.neto));

  const filasMovimientos = data.ultimosMovimientos.map(m => `
    <tr>
      <td>${escapeHtml(m.fecha || '-')}</td>
      <td>${escapeHtml(m.comercio || m.descripcion || '-')}</td>
      <td>${escapeHtml(m.categoria)}</td>
      <td class="${m.monto < 0 ? 'neg' : 'pos'}">${money(m.monto)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Finanzas — Panel</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0f1115; --card: #171a21; --border: #2a2e38; --text: #e8e9ec; --muted: #9aa0ab;
    --accent: #6ea8fe; --pos: #4ade80; --neg: #f87171;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
  .card h3 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: .04em; }
  .kpi { font-size: 28px; font-weight: 700; }
  .kpi.neg { color: var(--neg); }
  .kpi.pos { color: var(--pos); }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .charts .card { min-height: 320px; }
  .charts .wide { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  td.pos { color: var(--pos); }
  td.neg { color: var(--neg); }
  @media (max-width: 800px) { .charts { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <h1>Finanzas — Panel</h1>
  <div class="sub">Generado ${new Date(data.generatedAt).toLocaleString('es-AR')} · mes actual: ${data.mesActual}</div>

  <div class="grid">
    <div class="card"><h3>Gastado este mes</h3><div class="kpi neg">${money(data.gastadoEsteMes)}</div></div>
    <div class="card"><h3>Ingresos este mes</h3><div class="kpi pos">${money(data.ingresosEsteMes)}</div></div>
    <div class="card"><h3>Saldo del mes</h3><div class="kpi ${data.saldoEsteMes < 0 ? 'neg' : 'pos'}">${money(data.saldoEsteMes)}</div></div>
  </div>

  <div class="charts">
    <div class="card"><h3>Por categoría (este mes)</h3><canvas id="donutMes"></canvas></div>
    <div class="card"><h3>Gasto por categoría (últimos 12 meses)</h3><canvas id="barHist"></canvas></div>
    <div class="card wide"><h3>Cashflow acumulado (últimos 12 meses)</h3><canvas id="lineAcum"></canvas></div>
  </div>

  <div class="card">
    <h3>Últimos movimientos</h3>
    <table>
      <thead><tr><th>Fecha</th><th>Comercio</th><th>Categoría</th><th>Monto</th></tr></thead>
      <tbody>${filasMovimientos || '<tr><td colspan="4">Sin movimientos.</td></tr>'}</tbody>
    </table>
  </div>

<script>
  Chart.defaults.color = '#9aa0ab';
  Chart.defaults.borderColor = '#2a2e38';
  const palette = ['#6ea8fe','#f87171','#4ade80','#fbbf24','#a78bfa','#22d3ee','#fb923c','#f472b6','#84cc16','#94a3b8'];

  new Chart(document.getElementById('donutMes'), {
    type: 'doughnut',
    data: {
      labels: ${JSON.stringify(catEsteMesLabels)},
      datasets: [{ data: ${JSON.stringify(catEsteMesValues)}, backgroundColor: palette, borderColor: '#171a21', borderWidth: 2 }]
    },
    options: { plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } } }
  });

  new Chart(document.getElementById('barHist'), {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(catHistLabels)},
      datasets: [{ data: ${JSON.stringify(catHistValues)}, backgroundColor: '#6ea8fe' }]
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { grid: { color: '#2a2e38' } }, y: { grid: { display: false } } }
    }
  });

  new Chart(document.getElementById('lineAcum'), {
    type: 'line',
    data: {
      labels: ${JSON.stringify(mesesLabels)},
      datasets: [
        { label: 'Acumulado', data: ${JSON.stringify(acumuladoValues)}, borderColor: '#6ea8fe', backgroundColor: 'rgba(110,168,254,0.15)', fill: true, tension: 0.3 },
        { label: 'Neto del mes', data: ${JSON.stringify(netoValues)}, borderColor: '#4ade80', borderDash: [4,4], tension: 0.3 }
      ]
    },
    options: { plugins: { legend: { position: 'bottom' } }, scales: { x: { grid: { display: false } }, y: { grid: { color: '#2a2e38' } } } }
  });
</script>
</body>
</html>`;
}
