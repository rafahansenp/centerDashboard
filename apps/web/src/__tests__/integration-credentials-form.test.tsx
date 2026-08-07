import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { IntegrationCredentialsForm } from '../components/settings/IntegrationCredentialsForm.js';

function mockGet(view: object) {
  mswServer.use(http.get('/api/settings/integrations', () => HttpResponse.json(view)));
}

const unconfigured = {
  uappi: { configured: false }, ga4: { propertyId: null, bigQueryDataset: null },
};
const configured = {
  uappi: { configured: true }, ga4: { propertyId: '111', bigQueryDataset: 'analytics_111' },
};

describe('IntegrationCredentialsForm — leitura', () => {
  it('shows "não configurado" when the Uappi credentials are absent', async () => {
    mockGet(unconfigured);
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByText('Não configurado')).toBeInTheDocument());
  });

  it('shows a "Configurado" badge without ever displaying a secret value', async () => {
    mockGet(configured);
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByText('Configurado')).toBeInTheDocument());
    // Vários campos (GA4) legitimamente têm valor preenchido, então
    // queryByDisplayValue (que exige 0 ou 1 resultado) não serve aqui — o
    // que importa é que NENHUM desses campos preenchidos seja um segredo.
    for (const input of screen.queryAllByDisplayValue(/./)) {
      expect(input).not.toHaveAttribute('name', 'uappiApiKey');
      expect(input).not.toHaveAttribute('name', 'uappiSecretKey');
    }
  });

  it('pre-fills the GA4 fields — they are not secrets', async () => {
    mockGet(configured);
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('ID da propriedade GA4')).toHaveValue('111'));
    expect(screen.getByLabelText('Dataset do BigQuery')).toHaveValue('analytics_111');
  });

  it('leaves the apiKey and secretKey inputs empty even when configured', async () => {
    mockGet(configured);
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByText('Configurado')).toBeInTheDocument());
    expect(screen.getByLabelText('Chave de API da Uappi')).toHaveValue('');
    expect(screen.getByLabelText('Chave secreta da Uappi')).toHaveValue('');
  });
});

describe('IntegrationCredentialsForm — escrita', () => {
  it('sends only the fields the admin actually typed', async () => {
    mockGet(unconfigured);
    const handler = jest.fn((_body: unknown) => HttpResponse.json(configured));
    mswServer.use(http.put('/api/settings/integrations', async ({ request }) => {
      handler(await request.json());
      return HttpResponse.json(configured);
    }));

    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('ID da propriedade GA4')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('ID da propriedade GA4'), '222');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(handler).toHaveBeenCalledWith({ ga4PropertyId: '222' }));
  });

  it('includes the Uappi fields only when the admin typed something in them', async () => {
    mockGet(unconfigured);
    const handler = jest.fn((_body: unknown) => HttpResponse.json(configured));
    mswServer.use(http.put('/api/settings/integrations', async ({ request }) => {
      handler(await request.json());
      return HttpResponse.json(configured);
    }));

    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('Chave de API da Uappi')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Chave de API da Uappi'), 'ak-nova');
    await userEvent.type(screen.getByLabelText('Chave secreta da Uappi'), 'sk-nova');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(handler).toHaveBeenCalledWith({
      uappiApiKey: 'ak-nova', uappiSecretKey: 'sk-nova',
    }));
  });

  it('disables the button and shows saving state while the request is in flight', async () => {
    mockGet(unconfigured);
    mswServer.use(http.put('/api/settings/integrations', async () => {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      return HttpResponse.json(configured);
    }));
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('ID da propriedade GA4')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('ID da propriedade GA4'), '222');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(screen.getByRole('button', { name: 'Salvando…' })).toBeDisabled();
  });

  it('clears the secret inputs after a successful save — they never linger in the DOM', async () => {
    mockGet(unconfigured);
    mswServer.use(http.put('/api/settings/integrations', () => HttpResponse.json(configured)));
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('Chave de API da Uappi')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Chave de API da Uappi'), 'ak-nova');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.getByLabelText('Chave de API da Uappi')).toHaveValue(''));
  });

  it('shows the error message when the save fails', async () => {
    mockGet(unconfigured);
    mswServer.use(http.put('/api/settings/integrations', () =>
      HttpResponse.json({ message: 'requer papel de administrador' }, { status: 403 })));
    renderWithProviders(<IntegrationCredentialsForm />);
    await waitFor(() => expect(screen.getByLabelText('ID da propriedade GA4')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('ID da propriedade GA4'), '222');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('requer papel de administrador'));
  });
});
