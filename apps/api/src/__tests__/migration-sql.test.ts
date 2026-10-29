import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20261030000000_multitenant_foundation/migration.sql'),
  'utf8',
);

describe('multitenant_foundation migration', () => {
  it('renames VIEWER to MEMBER in place', () => {
    expect(sql).toContain(`ALTER TYPE "Role" RENAME VALUE 'VIEWER' TO 'MEMBER'`);
  });

  it('makes the audit log append-only', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "OperatorAuditLog"');
  });

  it('drops nothing', () => {
    expect(sql).not.toContain('DROP COLUMN');
    expect(sql).not.toContain('DROP TABLE');
  });
});
