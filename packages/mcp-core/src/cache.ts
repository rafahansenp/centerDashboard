import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { MetricQuery, MetricSource } from '@center/shared';

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

export class RedisCacheStore implements CacheStore {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }
}

/** Ordena as chaves de todo objeto para que a serialização seja canônica. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

function digest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex').slice(0, 32);
}

/** `metric:v1:<orgId>:<hash>` — o `v1` permite invalidar tudo com um bump. */
export function cacheKeyFor(query: MetricQuery): string {
  const { tenant, ...rest } = query;
  return `metric:v1:${tenant.organizationId}:${digest({ ...rest, externalIds: tenant.externalIds })}`;
}

/**
 * O `tenant` é removido dos argumentos antes de gerar a chave: ele já está no
 * prefixo, e mantê-lo faria credenciais entrarem no hash sem necessidade.
 */
export function toolCacheKeyFor(
  source: MetricSource,
  name: string,
  args: Record<string, unknown>,
  organizationId: string,
): string {
  const { tenant: _omitted, ...rest } = args;
  return `tool:v1:${organizationId}:${source}:${name}:${digest(rest)}`;
}

/** Período que alcança hoje ainda está sendo escrito pelas fontes. */
export const SHORT_TTL_SECONDS = 300;
/** Período fechado no passado é imutável. */
export const LONG_TTL_SECONDS = 86_400;
