const BUSINESS_TIME_ZONE_OFFSET = '-03:00';

export function rangeToUtc(from: string, to: string): { start: Date; end: Date } {
  return {
    start: new Date(`${from}T00:00:00${BUSINESS_TIME_ZONE_OFFSET}`),
    end: new Date(new Date(`${to}T00:00:00${BUSINESS_TIME_ZONE_OFFSET}`).getTime() + 24 * 60 * 60 * 1000),
  };
}

export const STATUS_LABEL: Record<string, string> = {
  PLANEJADO: 'Planejado',
  ADICIONAL: 'Adicional',
  ENTREGUE: 'Entregue',
};

export const TYPE_LABEL: Record<string, string> = {
  MELHORIA: 'Melhoria',
  CORRECAO: 'Correção',
  BUGFIX: 'Bugfix',
  MODULO: 'Módulo',
};

export const AREA_LABEL: Record<string, string> = {
  FRONT: 'Front',
  BACK: 'Back',
};
