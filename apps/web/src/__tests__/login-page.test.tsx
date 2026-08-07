import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test/msw-server.js';
import { renderWithProviders } from '../test/render.js';
import { LoginPage } from '../pages/LoginPage.js';
import { getAuthToken, setAuthToken } from '../lib/api-client.js';

afterEach(() => setAuthToken(null));

async function submit(email: string, password: string) {
  await userEvent.type(screen.getByLabelText('E-mail'), email);
  await userEvent.type(screen.getByLabelText('Senha'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

describe('LoginPage', () => {
  it('stores the token on success', async () => {
    mswServer.use(http.post('/auth/login', () => HttpResponse.json({
      token: 'jwt-token', user: { id: 'u1', name: 'Ana', email: 'ana@example.com', role: 'ADMIN' },
    })));
    renderWithProviders(<LoginPage />, { route: '/login' });
    await submit('ana@example.com', 'segredo123');
    await waitFor(() => expect(getAuthToken()).toBe('jwt-token'));
  });

  it('shows the server message on invalid credentials', async () => {
    mswServer.use(http.post('/auth/login', () =>
      HttpResponse.json({ message: 'credenciais inválidas' }, { status: 401 })));
    renderWithProviders(<LoginPage />, { route: '/login' });
    await submit('ana@example.com', 'errada');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('credenciais inválidas'));
    expect(getAuthToken()).toBeNull();
  });

  it('disables the submit button while the request is in flight', async () => {
    mswServer.use(http.post('/auth/login', async () => {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      return HttpResponse.json({ token: 't', user: { id: 'u1', name: 'A', email: 'a@b.c', role: 'ADMIN' } });
    }));
    renderWithProviders(<LoginPage />, { route: '/login' });
    await submit('ana@example.com', 'segredo123');
    expect(screen.getByRole('button', { name: 'Entrando…' })).toBeDisabled();
  });

  it('requires both fields before submitting', async () => {
    const handler = jest.fn(() => HttpResponse.json({ token: 't' }));
    mswServer.use(http.post('/auth/login', handler));
    renderWithProviders(<LoginPage />, { route: '/login' });
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(handler).not.toHaveBeenCalled();
  });
});
