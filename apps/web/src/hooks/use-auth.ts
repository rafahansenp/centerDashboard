import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, getAuthToken, setAuthToken } from '../lib/api-client.js';

export function useAuth() {
  const queryClient = useQueryClient();
  const [isAuthenticated, setIsAuthenticated] = useState(() => getAuthToken() !== null);

  const mutation = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      apiClient.login(email, password),
    onSuccess: (data) => {
      setAuthToken(data.token);
      setIsAuthenticated(true);
    },
  });

  const login = useCallback(
    async (email: string, password: string) => { await mutation.mutateAsync({ email, password }); },
    [mutation],
  );

  const logout = useCallback(() => {
    setAuthToken(null);
    setIsAuthenticated(false);
    // Sem isto, o próximo usuário veria os dados em cache do anterior.
    queryClient.clear();
  }, [queryClient]);

  return {
    isAuthenticated, login, logout,
    isLoggingIn: mutation.isPending,
    loginError: mutation.error instanceof Error ? mutation.error : null,
  };
}
