import { z } from 'zod';

export interface InboundMessage {
  wamid: string;
  fromPhoneE164: string;
  text: string;
  timestamp: number;
}

/**
 * Envelope deliberadamente frouxo: a Meta adiciona campos sem aviso e envia
 * dezenas de tipos de evento. Valida só a forma de navegação (entry/changes/
 * value) — cada mensagem individual é validada separadamente em
 * `parseInboundMessages`, para que uma mensagem malformada num lote não
 * derrube as demais mensagens (boas) do mesmo lote.
 */
const EnvelopeSchema = z.object({
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        messages: z.array(z.unknown()).optional(),
      }).passthrough(),
    }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();

const MessageSchema = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
});

export function parseInboundMessages(payload: unknown): InboundMessage[] {
  const parsed = EnvelopeSchema.safeParse(payload);
  if (!parsed.success) return [];

  const messages: InboundMessage[] = [];
  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const rawMessage of change.value.messages ?? []) {
        // Cada mensagem é validada isoladamente: uma mensagem com formato
        // inesperado é ignorada em silêncio, sem afetar as demais do lote.
        const messageParsed = MessageSchema.safeParse(rawMessage);
        if (!messageParsed.success) continue;
        const message = messageParsed.data;

        if (message.type !== 'text') continue;
        const text = message.text?.body.trim() ?? '';
        if (text === '') continue;

        const timestamp = Number(message.timestamp);
        // Um timestamp que não converte para número finito indicaria um NaN
        // gravado silenciosamente no processamento a jusante — tratamos como
        // mensagem malformada, igual a um corpo vazio.
        if (!Number.isFinite(timestamp)) continue;

        messages.push({
          wamid: message.id,
          fromPhoneE164: message.from.startsWith('+') ? message.from : `+${message.from}`,
          text,
          timestamp,
        });
      }
    }
  }
  return messages;
}
