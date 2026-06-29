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
  geminiModel: () => process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  notionToken: () => process.env.NOTION_TOKEN?.trim() || '',
  notionParentPageId: () => process.env.NOTION_PARENT_PAGE_ID?.trim() || '',
  notionItemsDatabaseId: () => process.env.NOTION_ITEMS_DATABASE_ID?.trim() || ''
};
