// Mesma justificativa de packages/mcp-commerce/jest.setup.cjs: os testes deste
// pacote batem num Postgres real via Prisma, então carregam o .env da raiz do
// repo para DATABASE_URL estar disponível sem exigir export manual.
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
