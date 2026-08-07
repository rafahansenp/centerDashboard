import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        viz: { 1: 'var(--viz-1)', 2: 'var(--viz-2)', 3: 'var(--viz-3)', 4: 'var(--viz-4)' },
      },
    },
  },
  // Sem `safelist`. Toda classe `bg-viz-N` deste projeto é escrita literalmente
  // no código-fonte, então o scanner do Tailwind a encontra. Onde a cor é
  // escolhida em runtime (série de gráfico, swatch por fonte), usamos
  // `var(--viz-N)` em `style`, não uma classe montada por template string —
  // classes dinâmicas seriam invisíveis ao scanner e sumiriam no build.
} satisfies Config;
