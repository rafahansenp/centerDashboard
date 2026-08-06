const WINDOW_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Janela deslizante. Guarda o instante das últimas N chamadas; quando a janela
 * está cheia, dorme até a mais antiga sair dela.
 *
 * Existe porque a Uappi bloqueia por excesso de requisições e um backfill
 * ingênuo estoura 120 req/min em segundos. O relógio é injetável para que o
 * teste rode em microssegundos.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];
  /**
   * Maior timestamp já atribuído. Chamadas liberadas "de graça" no mesmo tick
   * do relógio (comum sob rajada, e sempre o caso no relógio falso dos testes)
   * receberiam o mesmo valor de `now()`; sem desempate elas expirariam juntas
   * mais tarde, liberando 2+ vagas de uma vez e distorcendo o ritmo de espera.
   * Forçar crescimento estrito garante que cada chamada expire
   * individualmente, uma de cada vez.
   */
  private lastTimestamp = -Infinity;

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    if (maxPerMinute <= 0) throw new Error('maxPerMinute precisa ser positivo');
  }

  async acquire(): Promise<void> {
    this.evictExpired();

    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0]!;
      const waitMs = oldest + WINDOW_MS - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      this.evictExpired();
    }

    const ts = Math.max(this.now(), this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    this.timestamps.push(ts);
  }

  private evictExpired(): void {
    const cutoff = this.now() - WINDOW_MS;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }
}
