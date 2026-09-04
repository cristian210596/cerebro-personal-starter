import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

type GeminiClientEntry = {
  index: number;
  label: string;
  key: string;
  client: GoogleGenAI;
  disabledUntil: number;
  failures: number;
  lastError?: string;
  lastUsedAt?: string;
};

type GeminiPoolState = {
  initialized: boolean;
  nextIndex: number;
  clients: GeminiClientEntry[];
};

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_MULTIPLIER = 2;
const DEFAULT_CALL_TIMEOUT_MS = 20 * 1000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout: ${label} superó ${ms}ms sin responder`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

const state: GeminiPoolState = {
  initialized: false,
  nextIndex: 0,
  clients: []
};

function initializePool() {
  if (state.initialized) return;

  const keys = config.geminiApiKeys();
  state.clients = keys.map((key, index) => ({
    index,
    label: index === 0 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY_${index + 1}`,
    key,
    client: new GoogleGenAI({ apiKey: key }),
    disabledUntil: 0,
    failures: 0
  }));
  state.initialized = true;
}

export async function withGemini<T>(
  operation: (ai: GoogleGenAI, meta: { keyIndex: number; keyLabel: string }) => Promise<T>,
  options: { operationName?: string; cooldownMs?: number; timeoutMs?: number } = {}
): Promise<T> {
  initializePool();

  if (!state.clients.length) {
    throw new Error('No hay GEMINI_API_KEY configurada.');
  }

  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxAttempts = Math.max(state.clients.length, state.clients.length * MAX_ATTEMPTS_MULTIPLIER);
  let lastError: any = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const entry = pickClient();
    if (!entry) break;

    try {
      entry.lastUsedAt = new Date().toISOString();
      const result = await withTimeout(
        operation(entry.client, { keyIndex: entry.index, keyLabel: entry.label }),
        timeoutMs,
        options.operationName || 'gemini'
      );
      entry.failures = 0;
      entry.lastError = undefined;
      return result;
    } catch (error: any) {
      lastError = error;
      const reason = classifyGeminiError(error);
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
  throw new Error(`Gemini sin cuota temporalmente${op}. ${activeAgain}`.trim());
}

function pickClient(): GeminiClientEntry | null {
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

function classifyGeminiError(error: any): { retryable: boolean; detail: string; cooldownMs?: number } {
  const status = Number(error?.status || error?.code || error?.response?.status || 0);
  const text = [
    error?.message,
    error?.statusText,
    error?.error?.message,
    typeof error === 'string' ? error : ''
  ].filter(Boolean).join(' ').toLowerCase();

  const retryDelayMs = extractRetryDelayMs(error);

  if (text.startsWith('timeout:')) {
    return {
      retryable: true,
      detail: 'timeout (sin respuesta de Gemini)',
      cooldownMs: retryDelayMs || 60 * 1000
    };
  }

  if (
    status === 429 ||
    text.includes('resource_exhausted') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('rate_limit') ||
    text.includes('too many requests')
  ) {
    return {
      retryable: true,
      detail: 'cuota/rate limit',
      cooldownMs: retryDelayMs || DEFAULT_COOLDOWN_MS
    };
  }

  if (status === 503 || status === 502 || status === 504 || text.includes('overloaded') || text.includes('temporarily unavailable')) {
    return {
      retryable: true,
      detail: `error temporal ${status || ''}`.trim(),
      cooldownMs: retryDelayMs || 2 * 60 * 1000
    };
  }

  return { retryable: false, detail: error?.message || String(error) };
}

function extractRetryDelayMs(error: any): number | undefined {
  const candidates = [
    error?.error?.details,
    error?.details,
    error?.response?.data?.error?.details
  ].filter(Boolean).flat();

  for (const detail of candidates) {
    const retryDelay = detail?.retryDelay || detail?.['retryDelay'];
    if (typeof retryDelay === 'string') {
      const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
      if (match) return Math.ceil(Number(match[1]) * 1000);
    }
  }

  const headers = error?.response?.headers || error?.headers;
  const retryAfter = headers?.['retry-after'] || headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  }

  return undefined;
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

export function getGeminiPoolStatus() {
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


export function getGeminiConfiguredKeyCount() {
  initializePool();
  return state.clients.length;
}

export async function testGeminiPoolOnce(): Promise<{ ok: boolean; keyLabel?: string; keyIndex?: number; text?: string; error?: string; status: ReturnType<typeof getGeminiPoolStatus> }> {
  try {
    const result: any = await withGemini((ai, meta) => ai.models.generateContent({
      model: config.geminiModel(),
      contents: [{ role: 'user', parts: [{ text: 'Respondé solamente: OK' }] }]
    }).then((response: any) => ({
      text: String(response?.text || '').trim(),
      keyLabel: meta.keyLabel,
      keyIndex: meta.keyIndex
    })), { operationName: 'prueba gemini', cooldownMs: 60 * 1000 });

    return {
      ok: true,
      keyLabel: result.keyLabel,
      keyIndex: result.keyIndex,
      text: result.text || 'OK',
      status: getGeminiPoolStatus()
    };
  } catch (error: any) {
    return {
      ok: false,
      error: String(error?.message || error),
      status: getGeminiPoolStatus()
    };
  }
}
