import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey() });

export async function embedText(text: string): Promise<number[]> {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
  if (!clean) return [];

  const response: any = await ai.models.embedContent({
    model: config.geminiEmbeddingModel(),
    contents: clean
  } as any);

  const values = response?.embeddings?.[0]?.values || response?.embedding?.values || response?.values || [];
  return Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (!a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function simpleHash(value: string) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
