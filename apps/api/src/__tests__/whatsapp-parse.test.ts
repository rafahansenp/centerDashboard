import { parseInboundMessages } from '../whatsapp/parse.js';

function payloadWith(value: unknown) {
  return { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value }] }] };
}

const textMessage = {
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '5511999999999', phone_number_id: '123' },
  messages: [{
    from: '5511988887777', id: 'wamid.ABC', timestamp: '1773532800',
    type: 'text', text: { body: 'quanto vendemos mês passado?' },
  }],
};

describe('parseInboundMessages', () => {
  it('extracts a text message', () => {
    expect(parseInboundMessages(payloadWith(textMessage))).toEqual([{
      wamid: 'wamid.ABC', fromPhoneE164: '+5511988887777',
      text: 'quanto vendemos mês passado?', timestamp: 1773532800,
    }]);
  });

  it('trims surrounding whitespace', () => {
    const payload = payloadWith({
      ...textMessage, messages: [{ ...textMessage.messages[0], text: { body: '  oi  ' } }],
    });
    expect(parseInboundMessages(payload)[0]?.text).toBe('oi');
  });

  it('ignores status update events', () => {
    expect(parseInboundMessages(payloadWith({
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '5511999999999', phone_number_id: '123' },
      statuses: [{ id: 'wamid.XYZ', status: 'delivered', timestamp: '1773532800' }],
    }))).toEqual([]);
  });

  it('ignores non-text message types', () => {
    expect(parseInboundMessages(payloadWith({
      ...textMessage,
      messages: [{ from: '5511988887777', id: 'wamid.IMG', timestamp: '1773532800', type: 'image', image: { id: 'x' } }],
    }))).toEqual([]);
  });

  it('ignores a text message with an empty body', () => {
    expect(parseInboundMessages(payloadWith({
      ...textMessage, messages: [{ ...textMessage.messages[0], text: { body: '   ' } }],
    }))).toEqual([]);
  });

  it('extracts every message when a batch arrives', () => {
    const payload = payloadWith({
      ...textMessage,
      messages: [
        { ...textMessage.messages[0], id: 'wamid.1', text: { body: 'a' } },
        { ...textMessage.messages[0], id: 'wamid.2', text: { body: 'b' } },
      ],
    });
    expect(parseInboundMessages(payload).map((m) => m.wamid)).toEqual(['wamid.1', 'wamid.2']);
  });

  it('returns an empty array for a malformed payload instead of throwing', () => {
    expect(parseInboundMessages({ nada: true })).toEqual([]);
    expect(parseInboundMessages(null)).toEqual([]);
    expect(parseInboundMessages('texto')).toEqual([]);
  });

  it('normalises the phone to E.164 with a leading plus', () => {
    expect(parseInboundMessages(payloadWith({
      ...textMessage, messages: [{ ...textMessage.messages[0], from: '+5511988887777' }],
    }))[0]?.fromPhoneE164).toBe('+5511988887777');
  });

  it('keeps a well-formed message when a sibling message in the same batch is malformed', () => {
    const payload = payloadWith({
      ...textMessage,
      messages: [
        { ...textMessage.messages[0], id: 'wamid.GOOD', text: { body: 'oi' } },
        // timestamp como número (não string) — formato inesperado que não
        // deve derrubar o lote inteiro, só esta mensagem.
        { ...textMessage.messages[0], id: 'wamid.BAD', timestamp: 1773532800, text: { body: 'oi de novo' } },
      ],
    });
    expect(parseInboundMessages(payload).map((m) => m.wamid)).toEqual(['wamid.GOOD']);
  });

  it('ignores a message with a non-numeric timestamp instead of producing NaN', () => {
    expect(parseInboundMessages(payloadWith({
      ...textMessage, messages: [{ ...textMessage.messages[0], timestamp: 'não é um número' }],
    }))).toEqual([]);
  });
});
