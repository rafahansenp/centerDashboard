/**
 * O contrato que qualquer consumidor deve depender — nunca da classe concreta
 * `BigQueryEventsClient`. É o que permite um cliente falso (ex.: nos testes)
 * substituir o cliente real sem que o tool saiba a diferença.
 */
export interface BigQueryEventsClientLike {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>;
}
