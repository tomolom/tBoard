#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createTBoardMcpContext } from './context';
import { createTBoardMcpServer } from './server';

async function main(): Promise<void> {
  const context = createTBoardMcpContext();
  const server = createTBoardMcpServer(context);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      context.close();
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await server.connect(transport);
}

main().catch((error) => {
  console.error('tBoard MCP server failed to start:', error);
  process.exit(1);
});
