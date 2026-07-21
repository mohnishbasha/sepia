import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createEngine } from '../../engine/index.js';
import type { EngineOptions } from '../../engine/index.js';
import type { SepiaConfig } from '../../config/index.js';

export interface McpServerOptions {
  config: SepiaConfig;
  transport?: 'stdio';
}

// Tool schemas for MCP
const TOOL_DEFINITIONS = [
  {
    name: 'open',
    description: 'Navigate to a URL',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to (must be http:// or https://)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'observe',
    description: 'Get the current page accessibility tree as a compact view',
    inputSchema: {
      type: 'object' as const,
      properties: {
        verbosity: {
          type: 'string',
          enum: ['minimal', 'standard', 'full'],
          description: 'Level of detail in the output',
        },
      },
    },
  },
  {
    name: 'click',
    description: 'Click an element by its handle',
    inputSchema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'The element handle (e.g. e12)' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'type',
    description: 'Type text into an element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'The element handle' },
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['handle', 'text'],
    },
  },
  {
    name: 'select',
    description: 'Select an option in a select/combobox element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'The element handle' },
        option: { type: 'string', description: 'The option value or label to select' },
      },
      required: ['handle', 'option'],
    },
  },
  {
    name: 'check',
    description: 'Check or uncheck a checkbox',
    inputSchema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'The element handle' },
        checked: { type: 'boolean', description: 'Whether to check (true) or uncheck (false)' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'The element handle' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: '"up", "down", or an element handle' },
        distance: { type: 'number', description: 'Scroll distance in pixels' },
      },
      required: ['target'],
    },
  },
  {
    name: 'press',
    description: 'Press a keyboard key',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Key name (e.g. "Enter", "Escape", "Tab")' },
      },
      required: ['key'],
    },
  },
  {
    name: 'read',
    description: 'Read the inner text of an element',
    inputSchema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'The element handle' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'back',
    description: 'Navigate back in browser history',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'forward',
    description: 'Navigate forward in browser history',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// MCP 2024-11 server — Phase 2 M3
export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const server = new Server({ name: 'sepia', version: '0.1.0' }, { capabilities: { tools: {} } });

  // Create a shared engine instance for the session
  const engineOpts: EngineOptions = {
    headless: opts.config.browser.headless,
  };
  if (opts.config.browser.executablePath !== undefined) {
    engineOpts.executablePath = opts.config.browser.executablePath;
  }
  const engine = await createEngine(engineOpts);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFINITIONS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const params = (args ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case 'open': {
          result = await engine.open(String(params['url'] ?? ''));
          break;
        }
        case 'observe': {
          const verbosity = params['verbosity'] as 'minimal' | 'standard' | 'full' | undefined;
          const obsOpts: { verbosity?: 'minimal' | 'standard' | 'full' } = {};
          if (verbosity !== undefined) obsOpts.verbosity = verbosity;
          result = await engine.observe(obsOpts);
          break;
        }
        case 'click': {
          result = await engine.click(String(params['handle'] ?? ''));
          break;
        }
        case 'type': {
          result = await engine.type(String(params['handle'] ?? ''), String(params['text'] ?? ''), {
            submit: Boolean(params['submit']),
          });
          break;
        }
        case 'select': {
          result = await engine.select(
            String(params['handle'] ?? ''),
            String(params['option'] ?? ''),
          );
          break;
        }
        case 'check': {
          result = await engine.check(String(params['handle'] ?? ''), params['checked'] !== false);
          break;
        }
        case 'hover': {
          result = await engine.hover(String(params['handle'] ?? ''));
          break;
        }
        case 'scroll': {
          result = await engine.scroll(
            String(params['target'] ?? 'down'),
            typeof params['distance'] === 'number' ? params['distance'] : undefined,
          );
          break;
        }
        case 'press': {
          result = await engine.press(String(params['key'] ?? ''));
          break;
        }
        case 'read': {
          result = await engine.read(String(params['handle'] ?? ''));
          break;
        }
        case 'back': {
          result = await engine.back();
          break;
        }
        case 'forward': {
          result = await engine.forward();
          break;
        }
        default: {
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
