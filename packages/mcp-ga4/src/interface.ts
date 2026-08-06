import type { Ga4ReportParams, Ga4Row } from './client.js';

/**
 * O contrato que qualquer consumidor deve depender — nunca da classe concreta
 * `Ga4Client`. É o que permite um cliente mock (T17B) substituir o cliente real
 * sem que o provider saiba a diferença.
 */
export interface Ga4ClientLike {
  runReport(params: Ga4ReportParams): Promise<Ga4Row[]>;
}
