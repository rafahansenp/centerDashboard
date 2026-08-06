/** Nome canônico → nome de dimensão do GA4. */
export const GA4_DIMENSIONS: Record<string, string> = {
  campaign: 'sessionCampaignName',
  source: 'sessionSource',
  medium: 'sessionMedium',
  sourceMedium: 'sessionSourceMedium',
  channelGroup: 'sessionDefaultChannelGroup',
  device: 'deviceCategory',
  platform: 'platform',
  country: 'country',
  eventName: 'eventName',
  pagePath: 'pagePath',
  appVersion: 'appVersion',
  landingPage: 'landingPage',
};

export const GA4_DIMENSION_NAMES = Object.keys(GA4_DIMENSIONS);

export function assertGa4Dimension(name: string): string {
  const ga4Name = GA4_DIMENSIONS[name];
  if (!ga4Name) {
    throw new Error(
      `dimensão não suportada: "${name}". Disponíveis: ${GA4_DIMENSION_NAMES.join(', ')}`,
    );
  }
  return ga4Name;
}
