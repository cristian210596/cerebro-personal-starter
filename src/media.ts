import { config } from './config.js';
import { withGemini } from './geminiPool.js';

export type TelegramFileInfo = {
  fileId: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  kind: 'voice' | 'audio' | 'photo' | 'document';
};

export async function transcribeAudio(buffer: Buffer, mimeType = 'audio/ogg') {
  const response = await withGemini(ai => ai.models.generateContent({
    model: config.geminiModel(),
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Transcribí este audio en español. Si hay partes dudosas, marcá [inaudible]. Devolvé solo la transcripción.' },
          { inlineData: { mimeType, data: buffer.toString('base64') } }
        ]
      }
    ]
  }), { operationName: 'transcripción de audio' });

  return (response.text || '').trim();
}

export async function describeImage(buffer: Buffer, mimeType = 'image/jpeg', caption = '') {
  const response = await withGemini(ai => ai.models.generateContent({
    model: config.geminiModel(),
    contents: [
      {
        role: 'user',
        parts: [
          { text: [
            'Describí esta imagen para guardarla en un cerebro personal.',
            'Extraé texto visible si lo hay.',
            'No inventes datos que no se vean.',
            caption ? `Caption del usuario: ${caption}` : ''
          ].filter(Boolean).join('\n') },
          { inlineData: { mimeType, data: buffer.toString('base64') } }
        ]
      }
    ]
  }), { operationName: 'descripción de imagen' });

  return (response.text || '').trim();
}

export function buildDocumentText(file: TelegramFileInfo, caption = '') {
  return [
    `Documento recibido por Telegram: ${file.fileName || 'sin nombre'}`,
    `Tipo: ${file.mimeType || '-'}`,
    file.fileSize ? `Tamaño: ${file.fileSize} bytes` : '',
    caption ? `Comentario del usuario: ${caption}` : '',
    'Guardar como documento/archivo pendiente de revisión.'
  ].filter(Boolean).join('\n');
}
