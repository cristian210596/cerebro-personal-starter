async function handleBackupAutoTestCommand(chatId: number) {
  await sendMessage(chatId, 'Ejecutando mantenimiento y backup automático de prueba...');
  try {
    const result = await runScheduledMaintenance({ forceBackup: true, manualChatId: chatId });
    return sendMessage(chatId, formatMaintenanceRunResult(result));
  } catch (error: any) {
    console.error('No pude probar backup automático:', error);
    return sendMessage(chatId, `No pude probar backup automático: ${error?.message || 'error desconocido'}`);
  }
}

async function handleSupervivenciaCommand(chatId: number) {
  try {
    const status = await getMaintenanceStatus();
    return sendMessage(chatId, formatMaintenanceStatus(status));
  } catch (error: any) {
    console.error('No pude obtener supervivencia:', error);
    return sendMessage(chatId, `No pude obtener supervivencia: ${error?.message || 'error desconocido'}`);
  }
}

function introText() {
  return [
    'Cerebro personal activo.',
    '',
    'Mandame cualquier texto y lo guardo clasificado.',
    '',
    'Comandos:',
    '/buscar hplc lampara d2',
    '/resumen semana',
    '/resumen mes',
    '/ultimo',
    '/limpiar duplicados',
    '/archivos dni',
    '/archivo ultimo',
    '/ultimos',
    '/pendientes',
    '/hecho comprar detergente',
    '/memorias',
    '/entidades',
    '/entidad hplc',
    '/estado',
    '/diagnostico',
    '/test sistema',
    '/logs',
    '/revision hoy',
    '/revision semana',
    '/stats',
    '/finanzas',
    '/gastos visa',
    '/importaciones',
    '/comprobantes',
    '/comprobante ultimo',
    '/comprobante items ultimo',
    '/productos coto',
    '/producto gasto sensodyne 2026',
    '/clasificar producto sensodyne como Higiene personal guardar regla',
    '/sueldos',
    '/sueldo ultimo',
    '/sueldo conceptos ultimo',
    '/importacion revisar',
    '/clasificar 1 Suscripciones guardar regla',
    '/reporte gasto chatgpt 2026',
    'cuánto cobré este año',
    '/deudas',
    '/tarjetas',
    '/presupuesto supermercado 250000 mensual',
    '/presupuestos',
    '/pagar Juan 5000',
    '/borrar gasto ultimo confirmar',
    '/borrar archivo ultimo confirmar',
    '/backup',
    '/backup estado',
    '/backup auto probar',
    '/supervivencia',
    '/version',
    '/cola',
    '/cola procesar',
    '/bandeja',
    '/conciliacion pendientes',
    '/alias openai',
    '/entidades maestras',
    '/normalizar'
  ].join('\n');
}

function formatSaved(c: any) {
  const lines = [
    'Guardado.',
    '',
    `Título: ${c.titulo}`,
    `Categoría: ${c.categoria_principal}`,
    `Subcategorías: ${(c.subcategorias || []).join(', ') || '-'}`,
    `Tipo: ${c.tipo_item}`,
    `Estado: ${c.estado || '-'}`,
    `Valoración: ${c.valoracion || '-'}`,
    `Importancia: ${c.importancia || '-'}`,
    `Tags: ${(c.tags || []).join(', ') || '-'}`,
    `Entidades: ${(c.entidades || []).map((e: any) => `${e.tipo}: ${e.nombre}`).join(', ') || '-'}`
  ];

  if (c.accion_futura) lines.push(`Acción futura: ${c.accion_futura}`);
  if (c.memorias_sugeridas?.length) {
    lines.push('', 'Memorias sugeridas:');
    for (const m of c.memorias_sugeridas) lines.push(`- ${m.afirmacion}`);
  }
  return lines.join('\n');
}

function formatItems(items: any[], title: string) {
  if (!items.length) return `${title}\n\nSin resultados.`;
  const lines = [title, ''];
  for (const item of items) {
    lines.push(`• ${item.titulo || 'Sin título'}`);
    lines.push(`  ${item.categoria_principal || '-'} / ${item.tipo_item || '-'}`);
    if (item.estado) lines.push(`  Estado: ${item.estado}`);
    if (item.tags?.length) lines.push(`  Tags: ${item.tags.join(', ')}`);
    if (item.resumen) lines.push(`  ${String(item.resumen).slice(0, 220)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatMemorias(memorias: any[], title = 'Memorias vigentes') {
  if (!memorias.length) return `${title}\n\nSin memorias.`;
  const lines = [title, ''];
  for (const memoria of memorias) {
    lines.push(`• ${memoria.afirmacion}`);
    if (memoria.categoria) lines.push(`  Categoría: ${memoria.categoria}`);
    if (memoria.confianza) lines.push(`  Confianza: ${memoria.confianza}`);
    lines.push('');
