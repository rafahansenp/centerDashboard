import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { IntegrationStatusList } from '../components/settings/IntegrationStatusList.js';

function mockIntegrations(integrations: unknown[]) {
  mswServer.use(http.get('/api/settings/integrations', () => HttpResponse.json({ integrations })));
}

describe('IntegrationStatusList', () => {
  it('shows "Conectada", "Com erro" and "Aguardando configuração" for OK, ERROR and PENDING', async () => {
    mockIntegrations([
      { kind: 'COMMERCE', provider: 'UAPPI', status: 'OK', lastSyncedAt: null },
      { kind: 'PLAY_STORE', provider: 'GOOGLE_PLAY', status: 'ERROR', lastSyncedAt: null },
      { kind: 'APP_STORE', provider: 'APP_STORE_CONNECT', status: 'PENDING', lastSyncedAt: null },
    ]);
    renderWithProviders(<IntegrationStatusList />);
    expect(await screen.findByText('Conectada')).toBeInTheDocument();
    expect(screen.getByText('Com erro')).toBeInTheDocument();
    expect(screen.getByText('Aguardando configuração')).toBeInTheDocument();
    expect(screen.getByText('Loja (e-commerce)')).toBeInTheDocument();
  });

  it('shows the last sync date', async () => {
    mockIntegrations([
      { kind: 'COMMERCE', provider: 'UAPPI', status: 'OK', lastSyncedAt: '2026-03-15T12:00:00.000Z' },
    ]);
    renderWithProviders(<IntegrationStatusList />);
    expect(await screen.findByText(/Última sincronização: 15\/03\/2026/)).toBeInTheDocument();
  });

  it('renders no credential inputs', async () => {
    mockIntegrations([{ kind: 'COMMERCE', provider: 'UAPPI', status: 'OK', lastSyncedAt: null }]);
    renderWithProviders(<IntegrationStatusList />);
    await screen.findByText('Conectada');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
