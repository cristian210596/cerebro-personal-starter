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

  // Ayuda y uso del sistema. Nunca se guardan como item.
  if (/^(que|qué) puedo hacer\??$/.test(clean) || /^(ayuda|ayudame|comandos|como uso esto|cómo uso esto|como se usa|cómo se usa)$/.test(clean)) {
    return { kind: 'help' };
  }

  if (/^(estado|como esta el sistema|cómo esta el sistema|esta andando|anda el sistema)\??$/.test(clean)) {
    return { kind: 'status' };
  }

  if (/^(diagnostico|diagnóstico|revisar sistema|chequear sistema)$/.test(clean)) {
    return { kind: 'diagnostics' };
  }

  if (/^(backup estado|estado backup|estado del backup|supervivencia)$/.test(clean)) {
    return { kind: 'backup_status' };
  }

  // Consultas sobre lo último guardado.
  if (/^(que guardaste ultimo|qué guardaste ultimo|que guardaste último|qué guardaste último|ultimo guardado|último guardado|que fue lo ultimo|qué fue lo ultimo|que fue lo último|qué fue lo último)$/.test(clean)) {
    return { kind: 'last' };
  }

  // Borrado/deshacer en lenguaje natural. Sin confirmar, pide confirmación.
  if (looksLikeDelete(clean)) {
    return { kind: 'delete', target: detectDeleteTarget(clean), confirm: hasConfirmation(clean) };
  }

  // “No guardes eso” es una orden al bot, no contenido. Se trata como borrado del último con confirmación requerida.
  if (/^(no guardes eso|no guardes esto|eso no iba|esto no iba|eso estaba mal|lo guardaste mal|esta mal guardado|está mal guardado)$/.test(clean)) {
    return { kind: 'delete', target: 'ultimo', confirm: false };
  }

  // Correcciones ambiguas sin instrucción concreta.
  if (/^(corregi eso|corregí eso|corregir eso|arregla eso|arreglá eso|modifica eso|modificá eso)$/.test(clean)) {
    return { kind: 'clarify_correction' };
  }

  // Pendientes por lenguaje natural de consulta/cierre.
  const pendingQuery = extractPendingQuery(clean);
  if (pendingQuery !== null) return { kind: 'pending_list', query: pendingQuery };

  const doneQuery = extractDoneQuery(clean);
  if (doneQuery !== null) return { kind: 'done', query: doneQuery };

  // Búsqueda natural. Ojo: solo con verbo de consulta; no bloquea notas normales.
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

function looksLikeDelete(clean: string) {
  return (
    /^(eliminar|elimina|eliminame|borrar|borra|borrame|quitar|quita|sacar|saca)\b/.test(clean) ||
    /^(deshacer|undo)$/.test(clean)
  ) && (
    clean.includes('ultimo') ||
    clean.includes('esto') ||
    clean.includes('eso') ||
    clean.includes('gasto') ||
    clean.includes('archivo') ||
    clean.includes('pendiente') ||
    clean === 'deshacer' ||
    clean === 'undo'
  );
}

function detectDeleteTarget(clean: string): 'gasto' | 'archivo' | 'pendiente' | 'ultimo' {
  if (clean.includes('gasto') || clean.includes('movimiento')) return 'gasto';
  if (clean.includes('archivo') || clean.includes('documento') || clean.includes('foto') || clean.includes('audio')) return 'archivo';
  if (clean.includes('pendiente') || clean.includes('recordatorio')) return 'pendiente';
  return 'ultimo';
}

function hasConfirmation(clean: string) {
  return /\b(confirmar|confirmo|si confirmo|sí confirmo|confirmado)\b/.test(clean);
}

function extractPendingQuery(clean: string): string | null {
  const patterns = [
    /^(mostra|mostrame|mostrar|ver|listame|lista|consultar|consulta)\s+(mis\s+)?pendientes(?:\s+(.+))?$/,
    /^pendientes(?:\s+(.+))?$/,
    /^que tengo pendiente(?:\s+(.+))?$/,
    /^qué tengo pendiente(?:\s+(.+))?$/
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
    /^(ya hice|ya compre|ya compré|hice|termine|terminé|listo)\s+(.+)$/,
    /^(cerrar|cerra|cerrá|completar|completa)\s+pendiente\s+(.+)$/
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
    /^(buscar|busca|buscame|encontrar|encontra|encontrá|mostrame|mostrar)\s+(.+)$/,
    /^donde esta\s+(.+)$/,
    /^dónde esta\s+(.+)$/,
    /^donde guarde\s+(.+)$/,
    /^dónde guardé\s+(.+)$/
  ];
  for (const p of patterns) {
    const m = clean.match(p);
    if (!m) continue;
    const q = (m[2] || m[1] || '').trim();
    if (!q || ['pendientes', 'mis pendientes'].includes(q)) return null;
    return q;
  }
  return null;
}

function extractSummaryPeriod(clean: string): string | null {
  const m = clean.match(/^(resumen|resumime|resumir)\s+(hoy|semana|mes)$/);
  return m ? m[2] : null;
}

function extractReviewPeriod(clean: string): string | null {
  const m = clean.match(/^(revision|revisión|revisar|revisame)\s+(hoy|semana|mes)$/);
  return m ? m[2] : null;
}
