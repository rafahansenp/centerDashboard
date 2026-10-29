import type { CommerceConnector, CommerceProvider } from './types.js';
import { createUappiConnector } from './uappi/connector.js';

export interface ConnectorRegistry {
  get(provider: CommerceProvider): CommerceConnector;
}

export function createConnectorRegistry(opts: { uappiBaseUrl: string; mock: boolean }): ConnectorRegistry {
  const connectors: Record<CommerceProvider, CommerceConnector> = {
    UAPPI: createUappiConnector({ baseUrl: opts.uappiBaseUrl, mock: opts.mock }) as CommerceConnector,
  };
  return {
    get(provider) {
      const connector = connectors[provider];
      if (!connector) throw new Error(`conector desconhecido: ${provider}`);
      return connector;
    },
  };
}
