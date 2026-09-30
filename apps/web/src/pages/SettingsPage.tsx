import { IntegrationCredentialsForm } from '../components/settings/IntegrationCredentialsForm.js';

export function SettingsPage() {
  return (
    <section className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold">Integrações de dados</h2>
      <IntegrationCredentialsForm />
    </section>
  );
}
