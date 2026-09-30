import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/use-auth.js';
import { AssistantWidget } from '../assistant/AssistantWidget.js';

const LINKS = [
  { to: '/', label: 'Visão geral', end: true },
  { to: '/produtos', label: 'Produtos', end: false },
  { to: '/aquisicao', label: 'Aquisição', end: false },
  { to: '/uso-do-app', label: 'Uso do app', end: false },
  { to: '/qualidade', label: 'Qualidade', end: false },
  { to: '/sprint', label: 'Sprint', end: false },
  { to: '/configuracoes', label: 'Configurações', end: false },
];

export function AppShell() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen">
      <header
        role="banner"
        className="border-b px-6 py-4"
        style={{ borderColor: 'var(--hairline)', backgroundColor: 'var(--surface-1)' }}
      >
        <div className="mx-auto flex max-w-7xl items-center gap-8">
          <h1 className="text-lg font-semibold">Center Analytics</h1>
          <nav aria-label="Principal" className="flex flex-wrap gap-1">
            {LINKS.map((link) => (
              <NavLink
                key={link.to} to={link.to} end={link.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-viz-1 text-white' : ''}`}
                style={({ isActive }) => (isActive ? undefined : { color: 'var(--text-secondary)' })}
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => { logout(); navigate('/login', { replace: true }); }}
            className="ml-auto rounded-md border px-3 py-1.5 text-sm"
            style={{ borderColor: 'var(--hairline)', color: 'var(--text-secondary)' }}
          >
            Sair
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-6">
        <Outlet />
      </main>
      <AssistantWidget />
    </div>
  );
}
