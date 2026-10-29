import { z } from 'zod';
import type { IntegrationProvider } from '@prisma/client';
import type { IntegrationKind } from '@center/entitlements';

const propertyId = z.string().regex(/^\d+$/);

/** Config NÃO secreta por tipo. COMMERCE é validado pelo conector (Task 5). */
export const IntegrationConfigSchemas = {
  WEB_ANALYTICS: z.object({ propertyId, bigQueryDataset: z.string().min(1).optional() }),
  APP_ANALYTICS: z.object({ propertyId }),
  PLAY_STORE: z.object({ packageName: z.string().min(1) }),
  APP_STORE: z.object({ appId: z.string().min(1) }),
  SPRINT_BOARD: z.object({ boardId: z.string().min(1) }),
};

/** Segredos (cifrados em `Integration.secrets`) por tipo. */
export const IntegrationSecretSchemas = {
  PLAY_STORE: z.object({ credentialsJson: z.string().min(1) }),
  APP_STORE: z.object({ keyJson: z.string().min(1) }),
};

/** Cada tipo de integração só aceita um provedor. */
export const ALLOWED_PROVIDERS: Record<IntegrationKind, IntegrationProvider> = {
  COMMERCE: 'UAPPI',
  WEB_ANALYTICS: 'GA4',
  APP_ANALYTICS: 'GA4',
  PLAY_STORE: 'GOOGLE_PLAY',
  APP_STORE: 'APP_STORE_CONNECT',
  SPRINT_BOARD: 'MONDAY',
};
