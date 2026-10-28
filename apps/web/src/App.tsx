import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell.js';
import { RequireAuth } from './components/layout/RequireAuth.js';
import { LoginPage } from './pages/LoginPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { ProductsPage } from './pages/ProductsPage.js';
import { AcquisitionPage } from './pages/AcquisitionPage.js';
import { AppUsagePage } from './pages/AppUsagePage.js';
import { AppQualityPage } from './pages/AppQualityPage.js';
import { SprintPage } from './pages/SprintPage.js';
import { SettingsPage } from './pages/SettingsPage.js';

/** "Hoje" desce como prop a partir daqui: nenhum componente chama `new Date()`. */
export function App() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<OverviewPage today={today} />} />
          <Route path="/produtos" element={<ProductsPage today={today} />} />
          <Route path="/aquisicao" element={<AcquisitionPage today={today} />} />
          <Route path="/uso-do-app" element={<AppUsagePage today={today} />} />
          <Route path="/qualidade" element={<AppQualityPage today={today} />} />
          <Route path="/sprint" element={<SprintPage today={today} />} />
          <Route path="/configuracoes" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
