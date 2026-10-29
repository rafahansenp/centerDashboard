import { IntegrationStatusList } from '../components/settings/IntegrationStatusList.js';

export function SettingsPage() {
  return (
    <section className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold">Integrações de dados</h2>
      <p className="text-sm text-gray-500">
        As credenciais são configuradas pela equipe de suporte. Aqui você acompanha o status.
      </p>
      <IntegrationStatusList />
    </section>
  );
}
