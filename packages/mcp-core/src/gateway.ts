import {
  MetricSeriesSchema,
  type MetricDescriptor, type MetricQuery, type MetricSeries, type MetricSource,
} from '@center/shared';
import { LONG_TTL_SECONDS, SHORT_TTL_SECONDS, cacheKeyFor, toolCacheKeyFor, type CacheStore } from './cache.js';
import type { McpPool } from './pool.js';

export interface MetricGatewayOptions {
  now?: () => Date;
}

/**
 * O fuso do negócio, não o do servidor. Todo o resto do sistema resolve "hoje"
 * em São Paulo (worker do WhatsApp, rota de análise, sync, App.tsx); o TTL
 * precisa concordar com eles, senão entre 21h e 23h59 — quando o UTC já virou
 * mas São Paulo não — um intervalo que termina hoje é classificado como
 * período fechado e cacheado por 24h.
 */
const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

export interface CallToolOptions {
  /** `false` desliga o cache — use em ferramentas que listam registros voláteis. */
  cache?: boolean;
  /** Sobrescreve o TTL. Sem isto, a regra de "alcança hoje" decide. */
  ttlSeconds?: number;
  /** Necessário para escolher o TTL de ferramentas com período. */
  rangeEnd?: string;
}

/**
 * A única porta de entrada para dados no sistema. Dashboard e agente de IA
 * passam por aqui — é o que garante que não exista lógica de agregação
 * duplicada entre os dois consumidores.
 */
export class MetricGateway {
  private readonly now: () => Date;

  constructor(
    private readonly pool: McpPool,
    private readonly cache: CacheStore,
    options: MetricGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  listMetrics(): Promise<MetricDescriptor[]> {
    return this.pool.listMetrics();
  }

  async queryMetric(query: MetricQuery): Promise<MetricSeries> {
    const key = cacheKeyFor(query);

    // Falha de cache nunca derruba uma requisição: vira miss.
    try {
      const cached = await this.cache.get(key);
      if (cached !== null) return MetricSeriesSchema.parse(JSON.parse(cached));
    } catch {
      // segue para a origem
    }

    const series = await this.pool.queryMetric(query);

    try {
      await this.cache.set(key, JSON.stringify(series), this.ttlFor(query.to));
    } catch {
      // gravação é best-effort
    }

    return series;
  }

  /** Uma tela carrega vários KPIs de uma vez; isto evita N round-trips em série. */
  queryBatch(queries: MetricQuery[]): Promise<MetricSeries[]> {
    return Promise.all(queries.map((query) => this.queryMetric(query)));
  }

  async callTool<T>(
    source: MetricSource,
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions = {},
  ): Promise<T> {
    const organizationId =
      (args.tenant as { organizationId?: string } | undefined)?.organizationId ?? 'anon';

    if (options.cache === false) {
      return this.pool.callTool<T>(source, name, args);
    }

    const key = toolCacheKeyFor(source, name, args, organizationId);

    try {
      const cached = await this.cache.get(key);
      if (cached !== null) return JSON.parse(cached) as T;
    } catch {
      // segue para a origem
    }

    const payload = await this.pool.callTool<T>(source, name, args);

    try {
      const ttl = options.ttlSeconds
        ?? this.ttlFor(options.rangeEnd ?? (args.to as string | undefined));
      await this.cache.set(key, JSON.stringify(payload), ttl);
    } catch {
      // best-effort
    }

    return payload;
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  /**
   * Um intervalo que alcança hoje ainda está sendo escrito pelas fontes, então
   * expira rápido. Um intervalo fechado no passado é imutável.
   */
  private ttlFor(rangeEnd: string | undefined): number {
    if (!rangeEnd) return SHORT_TTL_SECONDS;
    // 'en-CA' devolve YYYY-MM-DD, comparável lexicograficamente com rangeEnd.
    const today = this.now().toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE });
    return rangeEnd >= today ? SHORT_TTL_SECONDS : LONG_TTL_SECONDS;
  }
}
