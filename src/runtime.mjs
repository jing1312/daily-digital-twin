import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskStore } from './core/task-store.mjs';
import { parseRuntimeCommand, RuntimeCommandError, USAGE } from './core/runtime-command.mjs';
import { resolveHome, databasePath, HOME_DIRECTORIES, HOME_ENV } from './core/home.mjs';
import { loadConfig, storeOptionsFromConfig, ConfigError, DEFAULT_CONFIG, CONFIG_FILE } from './core/config.mjs';
import { createSchedulerLoop } from './core/scheduler-loop.mjs';
import { collectTelemetry, TELEMETRY_HINT } from './core/telemetry.mjs';
import { decideResourcePolicy } from './core/resource-policy.mjs';

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
    // 中文注释：公开仓不内置任何真实执行器 —— 执行器涉及本机软件路径，属于私有配置。
    executor: async ({ task }) => ({
      outcome: 'partial',
      reason: '未配置执行器：请在私有目录提供 executor，本次不谎报成功',
      summary: `任务 ${task.id} 已被调度，但没有可用执行器`
    })
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
  if (command.command === 'daemon') return runDaemon(home);
  if (command.command === 'doctor') return runDoctor(home);
  return updateTask(home, command);
}

try {
  await main();
} catch (error) {
  reportError(error);
}
