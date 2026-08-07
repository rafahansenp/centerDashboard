import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'node:util';
import { mswServer } from './msw-server.js';

// MSW 2 e o Recharts precisam destas APIs, ausentes no jsdom.
Object.assign(globalThis, { TextEncoder, TextDecoder });

globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

// O Recharts mede o container; em jsdom toda medida é 0 e o gráfico não
// renderiza. Forçamos um tamanho para que os elementos existam no DOM.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });

// `ResponsiveContainer` (T27) lê `getBoundingClientRect`, não `offsetWidth` —
// sem isto ele mede 0x0 e emite um aviso de console em todo teste de gráfico.
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0,
    toJSON() { return this; },
  } as DOMRect;
};

// `onUnhandledRequest: 'error'` obriga cada teste a declarar o que a tela chama.
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
