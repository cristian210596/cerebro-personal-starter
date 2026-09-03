import { config } from './config.js';

type CerebrasClientEntry = {
  index: number;
  label: string;
  key: string;
  disabledUntil: number;
  failures: number;
  lastError?: string;
  lastUsedAt?: string;
};

type CerebrasPoolState = {
  initialized: boolean;
  nextIndex: number;
  clients: CerebrasClientEntry[];
};

const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';
// El free tier de Cerebras limita por minuto (ej: 5 req/min en gpt-oss-120b) y no publica
// un header Retry-After, asi que usamos un cooldown fijo pensado para esas ventanas.
const DEFAULT_COOLDOWN_MS = 90 * 1000;
const MAX_ATTEMPTS_MULTIPLIER = 2;

const state: CerebrasPoolState = {
  initialized: false,
  nextIndex: 0,
  clients: []
};

function initializePool() {
  if (state.initialized) return;
  const keys = config.cerebrasApiKeys();
  state.clients = keys.map((key, index) => ({
    index,
    label: index === 0 ? 'CEREBRAS_API_KEY' : `CEREBRAS_API_KEY_${index + 1}`,
    key,
    disabledUntil: 0,
    failures: 0
  }));
  state.initialized = true;
}

export type CerebrasChatBody = {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_completion_tokens?: number;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; strict: true; schema: any };
  };
};

// Cerebras es un proveedor OPCIONAL y aditivo: si no hay CEREBRAS_API_KEY configurada,
// esto devuelve false y el resto del código sigue usando Gemini exactamente como antes.
export function isCerebrasConfigured() {
  initializePool();
  return state.clients.length > 0;
}

export async function withCerebras<T>(
  operation: (call: (body: CerebrasChatBody) => Promise<any>, meta: { keyIndex: number; keyLabel: string }) => Promise<T>,
  options: { operationName?: string; cooldownMs?: number } = {}
): Promise<T> {
  initializePool();

  if (!state.clients.length) {
    throw new Error('No hay CEREBRAS_API_KEY configurada.');
  }

  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxAttempts = Math.max(state.clients.length, state.clients.length * MAX_ATTEMPTS_MULTIPLIER);
  let lastError: any = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const entry = pickClient();
    if (!entry) break;

    try {
      entry.lastUsedAt = new Date().toISOString();
      const call = (body: CerebrasChatBody) => callCerebrasApi(entry.key, body);
      const result = await operation(call, { keyIndex: entry.index, keyLabel: entry.label });
      entry.failures = 0;
      entry.lastError = undefined;
      return result;
    } catch (error: any) {
      lastError = error;
      const reason = classifyCerebrasError(error);
      entry.lastError = reason.detail;

      if (reason.retryable) {
        entry.failures += 1;
        entry.disabledUntil = Date.now() + (reason.cooldownMs || cooldownMs);
        continue;
      }

      throw error;
    }
  }

  const activeAgain = getEarliestRecoveryText();
  const op = options.operationName ? ` (${options.operationName})` : '';
  throw new Error(`Cerebras sin cuota temporalmente${op}. ${activeAgain}`.trim());
}

async function callCerebrasApi(apiKey: string, body: CerebrasChatBody): Promise<any> {
  const response = await fetch(CEREBRAS_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const rawText = await response.text();
  let json: any = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    // Cerebras no documenta un formato de error verbatim; probamos los campos mas
    // comunes y si no hay nada legible, devolvemos el texto crudo del body.
    const message = json?.error?.message || json?.message || rawText || `HTTP ${response.status}`;
    const error: any = new Error(`Cerebras ${response.status}: ${message}`);
    error.status = response.status;
    throw error;
  }

  return json;
}

function pickClient(): CerebrasClientEntry | null {
  const now = Date.now();
  const clients = state.clients;
  if (!clients.length) return null;

  for (let i = 0; i < clients.length; i++) {
    const idx = (state.nextIndex + i) % clients.length;
    const entry = clients[idx];
    if (entry.disabledUntil <= now) {
      state.nextIndex = (idx + 1) % clients.length;
      return entry;
    }
  }

  return null;
}

function classifyCerebrasError(error: any): { retryable: boolean; detail: string; cooldownMs?: number } {
  const status = Number(error?.status || 0);
  const text = String(error?.message || error || '').toLowerCase();

  if (status === 429 || text.includes('rate limit') || text.includes('ratelimiterror')) {
    return { retryable: true, detail: 'cuota/rate limit', cooldownMs: 90 * 1000 };
  }

  // 402 = sin credito en esa cuenta puntual; con pool de varias keys probamos la siguiente.
  if (status === 402 || text.includes('payment')) {
    return { retryable: true, detail: 'sin credito en esta key', cooldownMs: 30 * 60 * 1000 };
  }

  if (status === 500 || status === 502 || status === 503 || text.includes('unavailable')) {
    return { retryable: true, detail: `error temporal ${status || ''}`.trim(), cooldownMs: 2 * 60 * 1000 };
  }

  return { retryable: false, detail: error?.message || String(error) };
}

function getEarliestRecoveryText() {
  const now = Date.now();
  const waits = state.clients
    .map(c => c.disabledUntil - now)
    .filter(v => v > 0)
    .sort((a, b) => a - b);

  if (!waits.length) return 'Probá de nuevo en unos minutos.';
  const minutes = Math.max(1, Math.ceil(waits[0] / 60000));
  return `Probá de nuevo en aproximadamente ${minutes} min.`;
}

export function getCerebrasPoolStatus() {
  initializePool();
  const now = Date.now();
  return state.clients.map(entry => ({
    label: entry.label,
    index: entry.index,
    available: entry.disabledUntil <= now,
    cooldownSeconds: Math.max(0, Math.ceil((entry.disabledUntil - now) / 1000)),
    failures: entry.failures,
    lastError: entry.lastError || null,
    lastUsedAt: entry.lastUsedAt || null
  }));
}

export function getCerebrasConfiguredKeyCount() {
  initializePool();
  return state.clients.length;
}

export async function testCerebrasPoolOnce(): Promise<{ ok: boolean; keyLabel?: string; keyIndex?: number; text?: string; error?: string; status: ReturnType<typeof getCerebrasPoolStatus> }> {
  try {
    const result = await withCerebras(async (call, meta) => {
      const response = await call({
        model: config.cerebrasModel(),
        messages: [{ role: 'user', content: 'Respondé solamente: OK' }],
        max_completion_tokens: 16
      });
      return {
        text: String(response?.choices?.[0]?.message?.content || '').trim(),
        keyLabel: meta.keyLabel,
        keyIndex: meta.keyIndex
      };
    }, { operationName: 'prueba cerebras', cooldownMs: 60 * 1000 });

    return {
      ok: true,
      keyLabel: result.keyLabel,
      keyIndex: result.keyIndex,
      text: result.text || 'OK',
      status: getCerebrasPoolStatus()
    };
  } catch (error: any) {
    return {
      ok: false,
      error: String(error?.message || error),
      status: getCerebrasPoolStatus()
    };
  }
}
