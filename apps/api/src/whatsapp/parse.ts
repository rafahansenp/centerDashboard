export interface InboundMessage {
  wamid: string;
  fromPhoneE164: string;
  text: string;
  timestamp: number;
}
