import { config } from './config.js';
import { supabase } from './supabaseClient.js';

let bucketChecked = false;

export type StoredTelegramFile = {
  bucket: string;
  path: string;
  storageRef: string;
  signedUrl: string | null;
};

export async function uploadTelegramFileToStorage(input: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string | null;
  kind: string;
  chatId: number | string;
  messageId: number | string;
}) : Promise<StoredTelegramFile> {
  const bucket = config.supabaseStorageBucket();
  await ensureStorageBucket(bucket);

  const safeName = safeFileName(input.fileName || `${input.kind}-${input.messageId}`);
  const date = new Date().toISOString().slice(0, 10);
  const path = `${String(input.chatId)}/${date}/${input.kind}/${Date.now()}-${input.messageId}-${safeName}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, input.buffer, {
      contentType: input.mimeType || 'application/octet-stream',
      upsert: true
    });

  if (error) throw error;

  const signedUrl = await createSignedFileUrl(`supabase://${bucket}/${path}`);
  return {
    bucket,
    path,
    storageRef: `supabase://${bucket}/${path}`,
    signedUrl
  };
}

export async function createSignedFileUrl(storageRef?: string | null, expiresInSeconds = 60 * 60 * 24 * 7) {
  if (!storageRef) return null;
  const parsed = parseStorageRef(storageRef);
  if (!parsed) return storageRef.startsWith('http') ? storageRef : null;

  const { data, error } = await supabase.storage
    .from(parsed.bucket)
    .createSignedUrl(parsed.path, expiresInSeconds);

  if (error) {
    console.error('No se pudo crear signed URL:', error);
    return null;
  }

  return data?.signedUrl || null;
}

export function parseStorageRef(storageRef: string) {
  const match = storageRef.match(/^supabase:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], path: match[2] };
}

async function ensureStorageBucket(bucket: string) {
  if (bucketChecked) return;

  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;

  if (!(buckets || []).some(b => b.name === bucket)) {
    const { error } = await supabase.storage.createBucket(bucket, {
      public: false,
      fileSizeLimit: 50 * 1024 * 1024
    });

    if (error && !String(error.message || '').toLowerCase().includes('already')) {
      throw error;
    }
  }

  bucketChecked = true;
}

function safeFileName(name: string) {
  const clean = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 140);
  return clean || 'archivo';
}
