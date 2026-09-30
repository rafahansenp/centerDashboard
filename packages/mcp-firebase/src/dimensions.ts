/**
 * Nome canônico → nome de dimensão do GA4 (Firebase Analytics é a mesma API,
 * property diferente). Só o vocabulário do app mobile — para dimensões web
 * (campanha, origem…) use `@center/mcp-ga4`.
 */
export const FIREBASE_DIMENSIONS: Record<string, string> = {
  eventName: 'eventName',
  appVersion: 'appVersion',
  platform: 'platform',
  country: 'country',
};

export const FIREBASE_DIMENSION_NAMES = Object.keys(FIREBASE_DIMENSIONS);

export function assertFirebaseDimension(name: string): string {
  const ga4Name = FIREBASE_DIMENSIONS[name];
  if (!ga4Name) {
    throw new Error(
      `dimensão não suportada: "${name}". Disponíveis: ${FIREBASE_DIMENSION_NAMES.join(', ')}`,
    );
  }
  return ga4Name;
}

/** Nomes de evento do app (T5A/T6A/T7A/T8A/T9A/T10A) — cadastro, módulos, funil de loja. */
export const APP_EVENT_NAMES = [
  'cadastro_usuario',
  'nivel_treino_selecionado',
  'alimento_registrado',
  'dieta_criada',
  'treino_iniciado',
  'exercicio_concluido',
  'Loja_view_promotion',
  'Loja_shop_busca',
  'Loja_select_item',
  'Loja_view_categories',
  'Loja_shop_view',
  'Loja_add_to_cart',
  'Loja_search',
  'Loja_cart_view',
  'Loja_AddToCart_GoToCart',
  'Loja_select_promotion',
] as const;

/// Da mais recente para a mais antiga — index 0 é sempre "versão atual" nos
/// fatores determinísticos do mock (ver mock-client.ts).
export const APP_VERSIONS = ['2.4.0', '2.3.1', '2.2.0', '2.1.0'] as const;
