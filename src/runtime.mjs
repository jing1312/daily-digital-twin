import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskStore } from './core/task-store.mjs';
import { parseRuntimeCommand, RuntimeCommandError, USAGE } from './core/runtime-command.mjs';
import { resolveHome, databasePath, HOME_DIRECTORIES, HOME_ENV } from './core/home.mjs';
import { loadConfig, storeOptionsFromConfig, ConfigError, DEFAULT_CONFIG, CONFIG_FILE } from './core/config.mjs';
import { createSchedulerLoop } from './core/scheduler-loop.mjs';
import { collectTelemetry, TELEMETRY_HINT } from './core/telemetry.mjs';
import { decideResourcePolicy } from './core/resource-policy.mjs';
import { planTasks, groupByParent } from './core/planner.mjs';
import { createCompositeExecutor } from './core/ai-executor.mjs';
import { readFile } from 'node:fs/promises';

// 中文注释：所有命令共用同一套 home 解析与配置加载，杜绝 init 写一个目录、status 读另一个目录（修 B13b）。

function print(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// 中文注释：创建私有目录结构，并写入一份可编辑的默认配置。
async function initializeHome(home) {
  await Promise.all(HOME_DIRECTORIES.map((directory) => mkdir(join(home, directory), { recursive: true })));
  const configPath = join(home, CONFIG_FILE);
  let configWritten = false;
  if (!(await fileExists(configPath))) {
    await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    configWritten = true;
  }
  print({
    home,
    directories: HOME_DIRECTORIES,
    configPath: CONFIG_FILE,
    configWritten,
    schedulerEnabled: DEFAULT_CONFIG.scheduler.enabled,
    initializedAt: new Date().toISOString()
  });
}

// 中文注释：打开任务库。所有需要数据库的命令都走这里，参数一致。
async function openStore(home) {
  const { config, source } = await loadConfig(home);
  const store = new TaskStore(databasePath(home, config.database), storeOptionsFromConfig(config));
  return { store, config, configSource: source };
}

async function withStore(home, work) {
  const context = await openStore(home);
  try {
    return await work(context);
  } finally {
    context.store.close();
  }
}

async function createTask(home, request) {
  await withStore(home, ({ store }) => print(store.createTask({ request })));
}

async function showStatus(home) {
  await withStore(home, ({ store, config }) => {
    const tasks = store.listActiveTasks();
    print({
      home,
      tasks,
      runnable: store.countRunnableTasks(),
      open: store.countOpenTasks(),
      maxSlots: config.maxSlots,
      schedulerEnabled: config.scheduler.enabled
    });
  });
}

// 中文注释：暂停、继续、取消。目标任务不存在时给出可读错误而不是把 null 传进数据库（修 B4）。
async function updateTask(home, command) {
  await withStore(home, ({ store }) => {
    const task = store.getTask(command.taskId);
    if (!task) throw new RuntimeCommandError(`任务 ${command.taskId} 不存在`, 'task_not_found');
    if (command.command === 'pause') return print(store.pause(task.id));
    if (command.command === 'resume') return print(store.resume(task.id));
    return print(store.transition(task.id, 'cancelled', { reason: '用户取消' }));
  });
}

// 中文注释：调度开关。默认休眠，只有用户显式 enable 才会运行。
async function manageScheduler(home, action) {
  await withStore(home, async ({ store, config }) => {
    if (action === 'status') {
      return print({
        enabled: config.scheduler.enabled,
        pollSeconds: config.scheduler.pollSeconds,
        note: '开关写在私有目录的 config/runtime.json，不在公开仓。'
      });
    }
    const configPath = join(home, CONFIG_FILE);
    const next = { ...config, scheduler: { ...config.scheduler, enabled: action === 'enable' } };
    await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    store.setSetting('scheduler_enabled_changed_at', new Date().toISOString());
    print({ enabled: next.scheduler.enabled, configPath: CONFIG_FILE });
  });
}

// 中文注释：查看或重置飞书归属账号。重置只能在本机执行，远程消息无法触发。
async function manageOwner(home, action) {
  await withStore(home, ({ store }) => {
    if (action === 'reset') return print({ reset: true, ...store.resetOwner() });
    const owner = store.getOwner();
    print({ paired: Boolean(owner), ownerOpenId: owner ? `${owner.slice(0, 4)}***` : null });
  });
}

// 中文注释：前台运行调度循环。未启用时明确拒绝并给出开启方法。
async function runDaemon(home) {
  const { store, config } = await openStore(home);
  let daemonTelemetry = {};
  const loop = createSchedulerLoop({
    store,
    config,
    telemetry: () => daemonTelemetry,
    // 中文注释：使用复合执行器：ai_call 类型由 AI 执行，desktop/browser 返回 partial。
    executor: await createCompositeExecutor({ home, config })
  });
  const started = loop.start({ keepAlive: true });
  if (!started.started) {
    store.close();
    print({ ...started, telemetryHint: TELEMETRY_HINT });
    return;
  }
  print({ ...started, message: '调度循环已启动，Ctrl+C 退出。' });
  const refresh = setInterval(async () => {
    daemonTelemetry = (await collectTelemetry(home)).reading;
  }, Math.max(2, config.scheduler.pollSeconds) * 1000);
  process.on('SIGINT', () => {
    clearInterval(refresh);
    loop.stop();
    store.close();
    process.exit(0);
  });
}

// 中文注释：环境自检。把 home、配置来源、WAL、归属账号、调度开关、遥测状态一次性打出来。
async function runDoctor(home) {
  const telemetry = await collectTelemetry(home);
  await withStore(home, ({ store, config, configSource }) => {
    const policy = decideResourcePolicy(telemetry.reading, config.resource);
    print({
      home,
      homeEnvSet: Boolean(process.env[HOME_ENV]),
      configSource: configSource ?? '(使用内置默认值)',
      database: config.database,
      sqlite: store.pragmaInfo(),
      migration: store.migration,
      ownerPaired: Boolean(store.getOwner()),
      schedulerEnabled: config.scheduler.enabled,
      tasks: { runnable: store.countRunnableTasks(), open: store.countOpenTasks() },
      telemetry: telemetry.reading,
      telemetrySources: telemetry.sources,
      telemetryReasons: { cpu: telemetry.cpuReason, power: telemetry.powerReason },
      telemetryFile: telemetry.telemetryFile,
      disk: telemetry.disk,
      resourcePolicy: policy,
      telemetryHint: policy.acceptsNewActions ? null : TELEMETRY_HINT
    });
  });
}

// 中文注释：从文件读取任务列表，每行一个任务，空行和 # 开头的行跳过。
async function readTaskFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// 中文注释：批量导入任务。每行一个任务，逐个创建。
async function batchImport(home, filePath) {
  const tasks = await readTaskFile(filePath);
  if (tasks.length === 0) throw new RuntimeCommandError('文件中没有有效任务', 'empty_file');
  await withStore(home, ({ store }) => {
    const results = [];
    for (const request of tasks) {
      try {
        results.push(store.createTask({ request }));
      } catch (error) {
        results.push({ error: error.message, request });
      }
    }
    print({ imported: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length, results });
  });
}

// 中文注释：晨间工作流 —— 核心入口。
// 中文注释：读取任务文件 → 调 AI 规划器分解 → 创建父任务和子任务 → 可选启动调度 → 打出计划概览。
async function morningWorkflow(home, filePath, enableScheduler) {
  const tasks = await readTaskFile(filePath);
  if (tasks.length === 0) throw new RuntimeCommandError('文件中没有有效任务', 'empty_file');

  const { config, source } = await loadConfig(home);

  // 中文注释：第一步：调 AI 规划器分解任务。
  let plan;
  try {
    plan = await planTasks(tasks, config.planner ?? {});
  } catch (error) {
    // 中文注释：规划失败不阻止创建任务，降级为透传。
    print({ warning: `AI 规划失败，降级为透传：${error.message}`, code: error.code });
    plan = tasks.map((request, index) => ({ parentIndex: index, request, taskType: 'unknown', priority: 1 }));
  }

  // 中文注释：第二步：创建父任务和子任务。
  await withStore(home, ({ store }) => {
    const groups = groupByParent(plan);
    const taskTree = [];

    for (let index = 0; index < tasks.length; index += 1) {
      const parentRequest = tasks[index];
      const parent = store.createTask({ request: parentRequest, taskType: 'unknown', priority: 5 });
      const subItems = groups.get(index) ?? [];
      const subTasks = [];

      for (const item of subItems) {
        try {
          const sub = store.createSubTask(parent.id, {
            request: item.request,
            taskType: item.taskType,
            priority: item.priority
          });
          subTasks.push(sub);
        } catch (error) {
          subTasks.push({ error: error.message, request: item.request });
        }
      }

      taskTree.push({
        parent: { id: parent.id, request: parent.request, state: parent.state },
        subTasks: subTasks.map((s) => s.error ? { error: s.error, request: s.request } : { id: s.id, request: s.request, taskType: s.taskType, priority: s.priority, state: s.state })
      });
    }

    // 中文注释：第三步：可选启动调度器。
    let schedulerAction = null;
    if (enableScheduler) {
      const configPath = join(home, CONFIG_FILE);
      const next = { ...config, scheduler: { ...config.scheduler, enabled: true } };
      writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      store.setSetting('scheduler_enabled_changed_at', new Date().toISOString());
      schedulerAction = { enabled: true, message: '调度器已启用' };
    }

    // 中文注释：打出计划概览。
    print({
      morning: new Date().toISOString(),
      configSource: source ?? '(使用内置默认值)',
      originalTaskCount: tasks.length,
      plannedSubTaskCount: plan.length,
      taskTree,
      scheduler: schedulerAction ?? { enabled: config.scheduler.enabled, message: '调度器状态未变（使用 --enable 可自动启动）' }
    });
  });
}

// 中文注释：统一错误出口。默认只打结构化错误，堆栈需要显式开 DAILY_TWIN_DEBUG=1（修 B13c）。
function reportError(error) {
  const payload = {
    error: {
      code: error?.code ?? 'runtime_error',
      message: error?.message ?? String(error)
    }
  };
  if (error instanceof ConfigError) payload.error.problems = error.problems;
  if (error?.code === 'unknown_command') payload.usage = USAGE;
  console.error(JSON.stringify(payload, null, 2));
  if (process.env.DAILY_TWIN_DEBUG === '1' && error?.stack) console.error(error.stack);
  process.exitCode = 1;
}

async function main() {
  const command = parseRuntimeCommand(process.argv.slice(2));
  const home = resolveHome({ cliHome: command.home ?? null });

  if (command.command === 'init') return initializeHome(home);
  if (command.command === 'create') return createTask(home, command.request);
  if (command.command === 'status') return showStatus(home);
  if (command.command === 'scheduler') return manageScheduler(home, command.action);
  if (command.command === 'owner') return manageOwner(home, command.action);
  if (command.command === 'batch') return batchImport(home, command.filePath);
  if (command.command === 'morning') return morningWorkflow(home, command.filePath, command.enableScheduler);
  if (command.command === 'daemon') return runDaemon(home);
  if (command.command === 'doctor') return runDoctor(home);
  return updateTask(home, command);
}

try {
  await main();
} catch (error) {
  reportError(error);
}
