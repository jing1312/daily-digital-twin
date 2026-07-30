import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const base = {
  ticket: z.string().min(3).describe('由 Daily Twin 本机网关签发的一次性能力票'),
  workerId: z.string().min(1).describe('当前隔离 worker 标识')
};

const TOOL_CONFIG = {
  browser_open: {
    description: '在 Daily Twin 管理的 Edge 任务标签中打开已登记网站。只返回任务 target 标识。',
    inputSchema: z.object({ ...base, website: z.string().min(1) })
  },
  browser_fill: {
    description: '填写已登记的 Edge 任务页输入框，并回读验证值。不能使用任意选择器。',
    inputSchema: z.object({ ...base, field: z.string().min(1), text: z.string() })
  },
  browser_submit: {
    description: '触发已登记的 Edge 页面提交动作。不能点击任意元素。',
    inputSchema: z.object({ ...base, action: z.string().min(1) })
  },
  browser_wait: {
    description: '等待当前任务页出现已登记的结果条件，最长等待由本机策略限制。',
    inputSchema: z.object({ ...base, condition: z.string().min(1), timeoutMs: z.number().int().min(100).max(900_000).default(60_000) })
  },
  browser_capture: {
    description: '截取当前 Edge 任务页证据。只返回证据编号，原图路径不离开本机。',
    inputSchema: z.object({ ...base })
  },
  app_launch: {
    description: '启动并验证私有目录中已登记的 Windows 软件。未登记路径会被拒绝。',
    inputSchema: z.object({ ...base, app: z.string().min(1) })
  },
  task_checkpoint: {
    description: '保存当前 worker 的结构化检查点，用于 90 分钟后续跑。',
    inputSchema: z.object({ ...base, checkpoint: z.record(z.string(), z.unknown()) })
  },
  task_checkpoint_read: {
    description: '读取当前隔离 worker 自己最近保存的检查点；不存在时返回 null。',
    inputSchema: z.object({ ...base })
  }
};

function resultPayload(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

export function createDailyTwinMcpServer({ toolService } = {}) {
  if (!toolService) throw new Error('MCP server 需要 toolService');
  const server = new McpServer({ name: 'daily-digital-twin', version: '0.2.0' });
  for (const name of toolService.names) {
    const config = TOOL_CONFIG[name];
    const registered = toolService.bound
      ? { ...config, inputSchema: config.inputSchema.omit({ ticket: true, workerId: true }) }
      : config;
    server.registerTool(name, registered, async (args) => {
      try {
        return resultPayload(await toolService.invoke(name, args));
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ code: error?.code ?? 'tool_error', message: error?.message ?? String(error) }) }]
        };
      }
    });
  }
  return server;
}

export async function connectDailyTwinMcpStdio({
  server,
  transportFactory = () => new StdioServerTransport()
} = {}) {
  if (!server || typeof server.connect !== 'function') throw new Error('MCP stdio 入口缺少 server');
  const transport = transportFactory();
  await server.connect(transport);
  return { server, transport };
}
