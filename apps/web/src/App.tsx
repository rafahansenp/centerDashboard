import { Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <div className="min-h-screen">
      <header role="banner" className="border-b px-6 py-4" style={{ borderColor: 'var(--hairline)' }}>
        <h1 className="text-lg font-semibold">Center Analytics</h1>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<p>Carregando painel…</p>} />
        </Routes>
      </main>
    </div>
  );
}
