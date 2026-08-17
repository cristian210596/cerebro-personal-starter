export type ConversationalRoute =
  | { kind: 'help' }
  | { kind: 'delete'; target: 'gasto' | 'archivo' | 'pendiente' | 'ultimo'; confirm: boolean }
  | { kind: 'last' }
  | { kind: 'pending_list'; query: string }
  | { kind: 'done'; query: string }
  | { kind: 'search'; query: string }
  | { kind: 'summary'; period: string }
  | { kind: 'review'; period: string }
  | { kind: 'status' }
  | { kind: 'diagnostics' }
  | { kind: 'backup_status' }
  | { kind: 'do_not_save' }
  | { kind: 'clarify_correction' };

export function routeConversationalText(text: string): ConversationalRoute | null {
  const original = String(text || '').trim();
  if (!original || original.startsWith('/')) return null;

  const clean = normalize(original);
  if (!clean) return null;

  // Órdenes de no guardar / deshacer: prioridad máxima.
  if (looksLikeDoNotSave(clean)) {
    return { kind: 'delete', target: 'ultimo', confirm: false };
  }

  // Ayuda y uso del sistema. Nunca se guardan como item.
  if (looksLikeHelp(clean)) {
    return { kind: 'help' };
  }

  if (looksLikeStatus(clean)) {
    return { kind: 'status' };
  }

  if (looksLikeDiagnostics(clean)) {
    return { kind: 'diagnostics' };
  }

  if (looksLikeBackupStatus(clean)) {
    return { kind: 'backup_status' };
  }

  // Consultas sobre lo último guardado.
  if (looksLikeLastSaved(clean)) {
    return { kind: 'last' };
  }

  // Borrado/deshacer en lenguaje natural. Sin confirmar, pide confirmación.
  if (looksLikeDelete(clean)) {
    return { kind: 'delete', target: detectDeleteTarget(clean), confirm: hasConfirmation(clean) };
  }

  // Correcciones ambiguas sin instrucción concreta.
  if (looksLikeAmbiguousCorrection(clean)) {
    return { kind: 'clarify_correction' };
  }

  const pendingQuery = extractPendingQuery(clean);
  if (pendingQuery !== null) return { kind: 'pending_list', query: pendingQuery };

  const doneQuery = extractDoneQuery(clean);
  if (doneQuery !== null) return { kind: 'done', query: doneQuery };

  const searchQuery = extractSearchQuery(clean);
  if (searchQuery !== null) return { kind: 'search', query: searchQuery };

  const summaryPeriod = extractSummaryPeriod(clean);
  if (summaryPeriod !== null) return { kind: 'summary', period: summaryPeriod };

  const reviewPeriod = extractReviewPeriod(clean);
  if (reviewPeriod !== null) return { kind: 'review', period: reviewPeriod };

  return null;
}

export function naturalDeleteArgs(route: Extract<ConversationalRoute, { kind: 'delete' }>) {
  const target = route.target === 'ultimo' ? 'ultimo' : `${route.target} ultimo`;
  return route.confirm ? `${target} confirmar` : target;
}

export function formatNaturalDeletePrompt(route: Extract<ConversationalRoute, { kind: 'delete' }>) {
  const cmd = route.target === 'gasto'
    ? '/borrar gasto ultimo confirmar'
    : route.target === 'archivo'
      ? '/borrar archivo ultimo confirmar'
      : route.target === 'pendiente'
        ? '/borrar pendiente ultimo confirmar'
        : '/borrar ultimo confirmar';

  return [
    'No lo guardé como item.',
    '',
    'Para borrar el registro indicado, mandá:',
    cmd,
    '',
    'No borro sin “confirmar” para evitar pérdidas accidentales.'
  ].join('\n');
}

export function formatClarifyCorrection() {
  return [
    'No lo guardé como item.',
    '',
    'Para corregir, usá una instrucción concreta. Ejemplos:',
    'corregir último: categoría Trabajo, importancia Alta',
    'corregir último pendiente: prioridad alta',
    'corregir último gasto: fue con visa, categoría supermercado',
    '',
    'Para borrar el último registro:',
    '/borrar ultimo confirmar'
  ].join('\n');
}

function normalize(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeHelp(clean: string) {
  return (
    /^(que|q) puedo hacer$/.test(clean) ||
    /^(que|q) hago$/.test(clean) ||
    /^(como|cómo) uso esto$/.test(clean) ||
    /^(como|cómo) se usa$/.test(clean) ||
    /^(como|cómo) arranco$/.test(clean) ||
    /^(ayuda|ayudame|comandos|menu|menú|opciones)$/.test(clean) ||
    /^(mostrame|mostrar|dame|pasame) (los )?(comandos|opciones|ayuda)$/.test(clean) ||
    /^(que comandos hay|que opciones tengo|para que servis|para que sirve esto)$/.test(clean)
  );
}

function looksLikeStatus(clean: string) {
  return /^(estado|estado del sistema|como esta el sistema|esta andando|anda el sistema|funciona el sistema)$/.test(clean);
}

function looksLikeDiagnostics(clean: string) {
  return /^(diagnostico|diagnostico del sistema|revisar sistema|revisa sistema|chequear sistema|chequea sistema)$/.test(clean);
}

function looksLikeBackupStatus(clean: string) {
  return /^(backup estado|estado backup|estado del backup|supervivencia|estado supervivencia)$/.test(clean);
}

function looksLikeLastSaved(clean: string) {
  return /^(que guardaste ultimo|que guardaste|ultimo guardado|que fue lo ultimo|que fue lo ultimo que guardaste|que quedo guardado|mostrame lo ultimo|ver ultimo)$/.test(clean);
}

function looksLikeDoNotSave(clean: string) {
  return (
    /^(no guardes|no guardar|no lo guardes|no guardes eso|no guardes esto|no era para guardar|eso no iba|esto no iba)$/.test(clean) ||
    /^(eso estaba mal|esto estaba mal|lo guardaste mal|esta mal guardado|esta mal eso|esta mal esto)$/.test(clean) ||
    /^(deshacer|undo|revertir|reverti|revertí)$/.test(clean)
  );
}

function looksLikeDelete(clean: string) {
  const hasVerb = /^(eliminar|elimina|eliminame|borrar|borra|borrame|quitar|quita|sacar|saca|suprimir|suprimi|suprimí)\b/.test(clean);
  const hasTarget = (
    clean.includes('ultimo') ||
    clean.includes('esto') ||
    clean.includes('eso') ||
    clean.includes('gasto') ||
    clean.includes('archivo') ||
    clean.includes('documento') ||
    clean.includes('foto') ||
    clean.includes('audio') ||
    clean.includes('pendiente') ||
    clean.includes('recordatorio')
  );
  return hasVerb && hasTarget;
}

function detectDeleteTarget(clean: string): 'gasto' | 'archivo' | 'pendiente' | 'ultimo' {
  if (clean.includes('gasto') || clean.includes('movimiento')) return 'gasto';
  if (clean.includes('archivo') || clean.includes('documento') || clean.includes('foto') || clean.includes('audio')) return 'archivo';
  if (clean.includes('pendiente') || clean.includes('recordatorio')) return 'pendiente';
  return 'ultimo';
}

function hasConfirmation(clean: string) {
  return /\b(confirmar|confirmo|si confirmo|confirmado)\b/.test(clean);
}

function looksLikeAmbiguousCorrection(clean: string) {
  return /^(corregi eso|corregir eso|arregla eso|arreglar eso|modifica eso|modificar eso|editar eso|edita eso)$/.test(clean);
}

function extractPendingQuery(clean: string): string | null {
  const patterns = [
    /^(mostra|mostrame|mostrar|ver|listame|lista|consultar|consulta)\s+(mis\s+)?pendientes(?:\s+(.+))?$/,
    /^pendientes(?:\s+(.+))?$/,
    /^que tengo pendiente(?:\s+(.+))?$/,
    /^que me falta(?:\s+(.+))?$/,
    /^que tengo que hacer(?:\s+(.+))?$/
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (m) return (m[m.length - 1] || '').trim();
  }
  return null;
}

function extractDoneQuery(clean: string): string | null {
  const patterns = [
    /^(marcar|marca)\s+(.+?)\s+como\s+(hecho|listo|terminado)$/,
    /^(ya hice|ya compre|hice|termine|listo)\s+(.+)$/,
    /^(cerrar|cerra|completar|completa)\s+pendiente\s+(.+)$/
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (!m) continue;
    if (p.source.includes('como')) return (m[2] || '').trim();
    return (m[2] || '').trim();
  }
  return null;
}

function extractSearchQuery(clean: string): string | null {
  const patterns = [
    /^(buscar|busca|buscame|encontrar|encontra|mostrame|mostrar)\s+(.+)$/,
    /^donde esta\s+(.+)$/,
    /^donde guarde\s+(.+)$/
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (!m) continue;
    const q = (m[2] || m[1] || '').trim();
    if (!q || ['pendientes', 'mis pendientes', 'comandos', 'ayuda'].includes(q)) return null;
    return q;
  }
  return null;
}

function extractSummaryPeriod(clean: string): string | null {
  const m = clean.match(/^(resumen|resumime|resumir)\s+(hoy|semana|mes)$/);
  return m ? m[2] : null;
}

function extractReviewPeriod(clean: string): string | null {
  const m = clean.match(/^(revision|revisar|revisame)\s+(hoy|semana|mes)$/);
  return m ? m[2] : null;
}
