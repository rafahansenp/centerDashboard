import { z } from 'zod';

export interface InboundMessage {
  wamid: string;
  fromPhoneE164: string;
  text: string;
  timestamp: number;
}

/**
 * Schema deliberadamente frouxo: a Meta adiciona campos sem aviso e envia
 * dezenas de tipos de evento. Aceitamos qualquer forma e extraímos apenas
 * mensagens de texto; tudo mais é ignorado em silêncio.
 */
const PayloadSchema = z.object({
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        messages: z.array(z.object({
          from: z.string(),
          id: z.string(),
          timestamp: z.string(),
          type: z.string(),
          text: z.object({ body: z.string() }).optional(),
        })).optional(),
      }).passthrough(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

export function parseInboundMessages(payload: unknown): InboundMessage[] {
  const parsed = PayloadSchema.safeParse(payload);
  if (!parsed.success) return [];

  const messages: InboundMessage[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) {
        if (message.type !== 'text') continue;
        const text = message.text?.body.trim() ?? '';
        if (text === '') continue;
        messages.push({
          wamid: message.id,
          fromPhoneE164: message.from.startsWith('+') ? message.from : `+${message.from}`,
          text,
          timestamp: Number(message.timestamp),
        });
      }
    }
  }
  return messages;
}
