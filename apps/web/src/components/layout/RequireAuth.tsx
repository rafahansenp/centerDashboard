import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getAuthToken } from '../../lib/api-client.js';

export function RequireAuth() {
  const location = useLocation();
  // Lemos o token direto do storage: o cliente de API o remove em qualquer 401,
  // então uma sessão expirada derruba o guard sem precisar de estado global.
  if (getAuthToken() === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
