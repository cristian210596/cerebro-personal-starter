import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Falta variable de entorno: ${name}`);
  }
  return value.trim();
}

export const config = {
  telegramBotToken: () => required('TELEGRAM_BOT_TOKEN'),
  supabaseUrl: () => required('SUPABASE_URL'),
  supabaseServiceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseDbUrl: () => process.env.SUPABASE_DB_URL?.trim() || '',
  geminiApiKey: () => required('GEMINI_API_KEY'),
  geminiApiKeys: () => {
    const values: string[] = [];
    const primary = process.env.GEMINI_API_KEY?.trim();
    if (primary) values.push(primary);

    const packed = process.env.GEMINI_API_KEYS || '';
    for (const key of packed.split(/[\n,;]/).map(v => v.trim()).filter(Boolean)) {
      values.push(key);
    }

    for (let i = 2; i <= 10; i++) {
      const key = process.env[`GEMINI_API_KEY_${i}`]?.trim();
      if (key) values.push(key);
    }

    const unique = [...new Set(values)];
    if (!unique.length) throw new Error('Falta variable de entorno: GEMINI_API_KEY');
    return unique;
  },
  geminiModel: () => process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  geminiEmbeddingModel: () => process.env.GEMINI_EMBEDDING_MODEL?.trim() || 'text-embedding-004',
  // Cerebras es opcional: si no hay keys configuradas, cerebrasApiKeys() devuelve [] y el
  // codigo sigue usando Gemini como si esto no existiera (no rompe nada por defecto).
  cerebrasApiKeys: () => {
    const values: string[] = [];
    const primary = process.env.CEREBRAS_API_KEY?.trim();
    if (primary) values.push(primary);

    const packed = process.env.CEREBRAS_API_KEYS || '';
    for (const key of packed.split(/[\n,;]/).map(v => v.trim()).filter(Boolean)) {
      values.push(key);
    }

    for (let i = 2; i <= 10; i++) {
      const key = process.env[`CEREBRAS_API_KEY_${i}`]?.trim();
      if (key) values.push(key);
    }

    return [...new Set(values)];
  },
  cerebrasModel: () => process.env.CEREBRAS_MODEL?.trim() || 'gpt-oss-120b',
  notionToken: () => process.env.NOTION_TOKEN?.trim() || '',
  notionParentPageId: () => process.env.NOTION_PARENT_PAGE_ID?.trim() || '',
  notionItemsDatabaseId: () => process.env.NOTION_ITEMS_DATABASE_ID?.trim() || '',
  supabaseStorageBucket: () => process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'cerebro-archivos'
};
