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
          <span
            role="img"
            aria-label="Center Analytics"
            className="flex items-center rounded-md px-3 py-2"
            style={{ backgroundColor: '#0E1A24' }}
          >
            <svg width="65" height="24" viewBox="0 0 65 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path fillRule="evenodd" clipRule="evenodd" d="M21.7351 4.56901L18.719 18.9158C18.1722 22.6328 20.0521 23.9855 23.3037 24H38.4109C41.4992 23.9756 43.4876 22.5956 44.0035 19.4357L45.6818 10.1762H32.9248L31.6845 15.5798H33.4842C33.3718 16.1318 33.2578 16.6884 33.1453 17.2452C32.9571 18.1315 32.1649 18.622 31.4283 18.6075C30.8121 18.5915 30.2018 18.241 30.3975 17.2243L32.5058 6.522C33.1852 4.72558 35.3782 5.03377 35.1625 6.522L34.9561 7.4405H46.2429C47.5372 3.62656 47.7329 0.41159 42.5968 0.0805478C40.6688 0.0805478 36.7156 0.0645399 33.051 0.0306451C30.0152 0.00327392 27.175 -0.0954678 25.859 0.308186C23.6043 0.997499 22.285 2.46131 21.7351 4.56901Z" fill="white" />
              <path d="M13.7476 3.41479H12.2045C11.7224 3.41479 11.2369 3.82793 11.1255 4.33281L7.58797 20.3806C7.47661 20.8855 7.78008 21.2986 8.26216 21.2986H9.80535C10.2874 21.2986 10.7729 20.8855 10.8843 20.3806L14.4218 4.33281C14.5332 3.82793 14.2297 3.41479 13.7476 3.41479Z" fill="#009EE0" />
              <path d="M8.2039 4.37708H7.72005C6.51478 4.37708 5.30104 5.4097 5.02281 6.67198L2.51651 18.0416C2.23828 19.3039 2.99666 20.3365 4.20178 20.3365H4.68579C5.02741 20.3365 5.37142 20.0439 5.45025 19.6863L8.68153 5.02749C8.76051 4.6697 8.54553 4.37708 8.2039 4.37708Z" fill="#009EE0" />
              <path d="M14.2715 14.4896H17.0131L17.9534 10.224H15.2118L14.2715 14.4896Z" fill="#009EE0" />
              <path d="M0.654032 10.9124L0.0172476 13.8011C-0.066188 14.1797 0.161264 14.4895 0.522935 14.4895H1.97303L2.91328 10.224H1.46319C1.10167 10.224 0.737472 10.5338 0.654032 10.9124Z" fill="#009EE0" />
              <path d="M57.2569 3.41479H55.7136C55.2315 3.41479 54.746 3.82793 54.6348 4.33281L51.0972 20.3806C50.9859 20.8855 51.2892 21.2986 51.7713 21.2986H53.3146C53.7967 21.2986 54.2822 20.8855 54.3936 20.3806L57.9311 4.33281C58.0424 3.82793 57.739 3.41479 57.2569 3.41479Z" fill="#009EE0" />
              <path d="M60.8505 4.37708H60.3667C60.025 4.37708 59.6811 4.6697 59.6022 5.02733L56.3708 19.6863C56.292 20.0439 56.5069 20.3365 56.8485 20.3365H57.3324C58.5377 20.3365 59.7514 19.3039 60.0296 18.0416L62.536 6.67198C62.8142 5.4097 62.0558 4.37708 60.8505 4.37708Z" fill="#009EE0" />
              <path d="M47.0293 14.4896H50.3069L51.2472 10.224H47.9696L47.0293 14.4896Z" fill="#009EE0" />
              <path d="M64.4772 10.224H63.0796L62.1392 14.4895H63.5368C63.8983 14.4895 64.2626 14.1797 64.346 13.8011L64.9828 10.9124C65.0662 10.5338 64.8388 10.224 64.4772 10.224Z" fill="#009EE0" />
            </svg>
          </span>
          <nav aria-label="Principal" className="flex flex-wrap gap-1">
            {LINKS.map((link) => (
              <NavLink
                key={link.to} to={link.to} end={link.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-accent text-white' : ''}`}
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
