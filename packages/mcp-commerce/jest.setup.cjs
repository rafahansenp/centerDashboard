// Loads the repo-root .env before tests run so DATABASE_URL (and friends) are
// available without requiring every developer/CI runner to export it manually.
//
// Scoped to this package only (not jest.preset.cjs) because @center/mcp-commerce
// is the first package whose tests hit a real Postgres instance via Prisma.
//
// dotenv.config() does NOT override variables that are already set in
// process.env (see https://github.com/motdotla/dotenv#what-happens-to-environment-variables-that-were-already-set).
// In CI (T38) DATABASE_URL is set directly as a workflow env var and there is
// no .env file on disk, so this is a harmless no-op there: dotenv silently
// does nothing when the target file doesn't exist.
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
