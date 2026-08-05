import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PACKAGE_NAME } from '../index.js';

describe('toolchain', () => {
  it('resolves relative ESM imports written with a .js suffix', () => {
    expect(PACKAGE_NAME).toBe('@center/shared');
  });

  it('loads the ESM-first MCP SDK inside Jest', () => {
    expect(new McpServer({ name: 'probe', version: '0.0.0' })).toBeInstanceOf(McpServer);
  });
});
