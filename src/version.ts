export const CEREBRO_VERSION = 'mega-conexion-v1';
export const CEREBRO_VERSION_DETAIL = [
  'cola-ia-v1',
  'entidades-maestras-v1',
  'conciliacion-financiera-v1',
  'bandeja-v1',
  'comprobantes-v1',
  'sueldos-v1',
  'finanzas-importador-final'
];

export function formatVersionInfo() {
  return [
    'CerebroTL versión',
    '',
    `Versión: ${CEREBRO_VERSION}`,
    `Build generado: ${new Date().toISOString()}`,
    '',
    'Módulos incluidos:',
    ...CEREBRO_VERSION_DETAIL.map(m => `- ${m}`),
    '',
    'Comandos nuevos relevantes:',
    '/cola',
    '/cola procesar',
    '/bandeja',
    '/conciliacion pendientes',
    '/entidades maestras',
    '/alias openai',
    '/version'
  ].join('\n');
}
