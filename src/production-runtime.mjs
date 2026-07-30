import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, unlink } from 'node:fs/promises';
import { TaskStore } from './core/task-store.mjs';
import { loadConfig, storeOptionsFromConfig } from './core/config.mjs';
import { loadAppCatalog } from './core/app-catalog.mjs';
import { readPrivateJson, readPrivateSecret, resolvePrivatePath } from './core/private-config.mjs';
import { collectTelemetry as collectHostTelemetry } from './core/telemetry.mjs';
import { createSchedulerLoop } from './core/scheduler-loop.mjs';
import { TaskBrowserExecutor } from './execution/browser-executor.mjs';
import { createDeterministicExecutor } from './execution/deterministic-executor.mjs';
import { PowerShellAppLauncher, WindowsAppExecutor } from './execution/windows-app-executor.mjs';
import { createLazyPlaywrightEdge, connectPlaywrightEdge } from './integrations/playwright-edge-driver.mjs';
import { MulticaClient } from './integrations/multica-client.mjs';
import { createMulticaBridge } from './integrations/multica-bridge.mjs';
import { createFeishuEventHandler, createFeishuSdkTransport, startFeishuWebSocket } from './gateway/feishu-websocket.mjs';
import { createTerminalReceiptPump } from './gateway/terminal-receipt-pump.mjs';
import { VerificationBroker } from './gateway/verification-broker.mjs';
import { createLocalEvidenceSender } from './gateway/local-evidence-sender.mjs';
import { createTaskToolService } from './mcp/task-tools.mjs';
import { connectDailyTwinMcpStdio, createDailyTwinMcpServer } from './mcp/server.mjs';
import { verifyCapabilityTicket } from './core/capability-ticket.mjs';
import { createControlPlaneHealth } from './core/health-reporter.mjs';
import { prepareMulticaWorkerBinding } from './integrations/codex-worker-config.mjs';
import { deriveTaskCapabilities } from './integrations/planner-contract.mjs';
import { acquireProcessLock } from './core/process-lock.mjs';

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(SOURCE_ROOT);

function closeHandle(handle) {
  if (!handle) return Promise.resolve();
  for (const method of ['close', 'stop', 'disconnect']) {
    if (typeof handle[method] === 'function') return Promise.resolve(handle[method]());
  }
  return Promise.resolve();
}

async function optionalPriceTable(home, configuredPath, logger) {
  try {
    return await readPrivateJson(home, configuredPath);
  } catch (error) {
    logger.warn?.({ event: 'pricing_unavailable', message: error.message });
    return { models: {} };
  }
}

function unavailableAppLauncher(message) {
  return {
    async launch() {
      throw Object.assign(new Error(message), { code: 'windows_launcher_unconfigured' });
    }
  };
}

export function createRuntimeSupervisor({
  startFeishu,
  scheduler,
  refreshTelemetry,
  multicaBridge,
  receiptPump,
  healthReporter = null,
  browser = null,
  processLock = null,
  store,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervals = {}
} = {}) {
  if (typeof startFeishu !== 'function' || !scheduler || !store) {
    throw new Error('统一运行时缺少飞书、调度器或任务库');
  }
  const delays = {
    telemetryMs: Number(intervals.telemetryMs ?? 5_000),
    multicaMs: Number(intervals.multicaMs ?? 15_000),
    receiptsMs: Number(intervals.receiptsMs ?? 2_000),
    healthMs: Number(intervals.healthMs ?? 60_000)
  };
  const timers = [];
  const activeBackgroundRuns = new Set();
  let feishu = null;
  let started = false;
  let stopped = false;

  async function safely(label, action) {
    try {
      return await action();
    } catch (error) {
      logger.error?.({ event: `${label}_failed`, message: error?.message ?? String(error) });
      return null;
    }
  }

  function repeat(label, delay, action) {
    let inFlight = null;
    const timer = setIntervalFn(() => {
      if (inFlight) return;
      const run = safely(label, action);
      inFlight = run;
      activeBackgroundRuns.add(run);
      run.finally(() => {
        if (inFlight === run) inFlight = null;
        activeBackgroundRuns.delete(run);
      });
    }, Math.max(100, delay));
    timer?.unref?.();
    timers.push(timer);
  }

  async function stopRuntime() {
    if (stopped) return { stopped: false, alreadyStopped: true };
    stopped = true;
    const failures = [];
    const attempt = async (action) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    for (const timer of timers.splice(0)) await attempt(() => clearIntervalFn(timer));
    await attempt(() => scheduler.stop?.());
    await attempt(() => closeHandle(feishu));
    const backgroundResults = await Promise.allSettled([...activeBackgroundRuns]);
    for (const result of backgroundResults) if (result.status === 'rejected') failures.push(result.reason);
    await attempt(() => closeHandle(browser));
    await attempt(() => healthReporter?.stop?.());
    await attempt(() => store.close());
    await attempt(() => processLock?.release?.());
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Daily Twin 停止时有 ${failures.length} 项清理失败：${failures[0]?.message ?? String(failures[0])}`
      );
    }
    return { stopped: true };
  }

  return {
    async start() {
      if (started) return { started: true, alreadyStarted: true };
      if (stopped) throw new Error('统一运行时已停止，不能重复启动');
      try {
        await refreshTelemetry?.();
        feishu = await startFeishu();
        await multicaBridge?.sync?.();
        await receiptPump?.flush?.();
        const schedulerStatus = scheduler.start({ keepAlive: true });
        await healthReporter?.start?.();
        repeat('telemetry_refresh', delays.telemetryMs, () => refreshTelemetry?.());
        repeat('multica_sync', delays.multicaMs, () => multicaBridge?.sync?.());
        repeat('receipt_flush', delays.receiptsMs, () => receiptPump?.flush?.());
        if (healthReporter) repeat('health_heartbeat', delays.healthMs, () => healthReporter.heartbeat());
        started = true;
        return { started: true, scheduler: schedulerStatus };
      } catch (error) {
        try {
          await stopRuntime();
        } catch (cleanupError) {
          logger.error?.({ event: 'startup_cleanup_failed', message: cleanupError?.message ?? String(cleanupError) });
        }
        throw error;
      }
    },

    stop: stopRuntime
  };
}

export async function buildProductionRuntime({
  home,
  dependencies = {},
  supervisorOptions = {},
  logger = console,
  repositoryRoot = REPOSITORY_ROOT
} = {}) {
  if (!home) throw new Error('生产运行时缺少 DAILY_TWIN_HOME');
  const { config, source: configSource } = await loadConfig(home);
  const runtimeDatabasePath = resolvePrivatePath(home, config.database);
  await mkdir(dirname(runtimeDatabasePath), { recursive: true });
  const lockFactory = dependencies.acquireProcessLock ?? acquireProcessLock;
  const processLock = await lockFactory({ home, name: 'control-plane' });
  let store = null;
  try {
    store = new TaskStore(runtimeDatabasePath, storeOptionsFromConfig(config));
    const catalogPath = resolvePrivatePath(home, config.integrations.appCatalog);
    const catalog = await loadAppCatalog(catalogPath);
    const priceTable = await optionalPriceTable(home, config.integrations.pricing, logger);
    const appSecret = await readPrivateSecret(home, config.integrations.feishu.appSecretFile, { minLength: 8 });
    if (!config.integrations.feishu.appId) {
      throw Object.assign(new Error('私有 runtime.json 未配置飞书 appId'), { code: 'feishu_app_id_missing' });
    }

    const connectEdge = dependencies.connectEdge ?? (() => connectPlaywrightEdge({
      command: config.browser.playwrightCommand,
      outputDir: resolvePrivatePath(home, 'data/screenshots'),
      cwd: repositoryRoot,
      env: process.env
    }));
    const lazyEdge = createLazyPlaywrightEdge({ connect: connectEdge });
    const browserExecutor = new TaskBrowserExecutor({ store, catalog, driver: lazyEdge });

    const appLauncher = dependencies.createAppLauncher
      ? await dependencies.createAppLauncher({ config, catalogPath, repositoryRoot })
      : (config.windows.pwshPath
          ? new PowerShellAppLauncher({
              pwshPath: config.windows.pwshPath,
              scriptPath: join(repositoryRoot, 'platform', 'windows', 'Start-DailyTwinApp.ps1'),
              catalogPath
            })
          : unavailableAppLauncher('windows.pwshPath 未配置，软件启动失败关闭'));
    const appExecutor = new WindowsAppExecutor({ store, catalog, launcher: appLauncher });
    const verificationBroker = new VerificationBroker();
    const deterministicExecutor = createDeterministicExecutor({
      browserExecutor,
      appExecutor,
      catalog,
      verificationBroker
    });

    let telemetryReading = {};
    const collectTelemetry = dependencies.collectTelemetry ?? collectHostTelemetry;
    const refreshTelemetry = async () => {
      const collected = await collectTelemetry(home);
      telemetryReading = collected?.reading ?? {};
      return telemetryReading;
    };

    const scheduler = createSchedulerLoop({
      store,
      config,
      executor: deterministicExecutor,
      telemetry: () => telemetryReading,
      eligibleTask: (task) => task.taskKind === 'deterministic',
      requiresForeground: (task) => /^打开\s*omicos\s*$/i.test(String(task.request ?? '').trim()),
      logger
    });

    const multicaFactory = dependencies.createMulticaClient ?? ((options) => new MulticaClient(options));
    const multicaClient = config.integrations.multica.enabled
      ? multicaFactory({
          command: config.integrations.multica.command,
          plannerAgent: config.integrations.multica.plannerAgent,
          cwd: repositoryRoot
        })
      : null;
    let multicaBridge = { async sync() { return []; } };
    if (multicaClient) {
      const capabilitySecret = await readPrivateSecret(home, config.integrations.capabilitySecretFile, { minLength: 32 });
      const prepareWorker = dependencies.prepareMulticaWorker ?? ((options) => prepareMulticaWorkerBinding({
        ...options,
        home,
        capabilitySecret,
        expiresInMinutes: config.execution.workerMaxMinutes + 10
      }));
      multicaBridge = createMulticaBridge({
        store,
        client: multicaClient,
        priceTable,
        telemetry: () => telemetryReading,
        resourceLimits: config.resource,
        workerAgents: config.integrations.multica.workerAgents,
        allowedCapabilities: (task) => deriveTaskCapabilities({
          task,
          catalog,
          allowedDirectories: config.integrations.multica.allowedDirectories
        }),
        prepareWorker,
        workerMaxMinutes: config.execution.workerMaxMinutes,
        logger
      });
    }

    const transportFactory = dependencies.createFeishuTransport ?? createFeishuSdkTransport;
    const feishuTransport = transportFactory({
      appId: config.integrations.feishu.appId,
      appSecret,
      sdk: dependencies.feishuSdk
    });
    const localEvidenceSender = createLocalEvidenceSender({
      screenshotRoot: resolvePrivatePath(home, 'data/screenshots'),
      sendImage: (path, context) => feishuTransport.sendImage(context.chatId, path)
    });
    const handleFeishuEvent = createFeishuEventHandler({
      store,
      sendText: (chatId, text) => feishuTransport.sendText(chatId, text),
      dispatchTask: multicaClient ? (task, options) => multicaClient.dispatch(task, options) : null,
      verificationBroker,
      taskLifecycle: multicaBridge,
      sendEvidence: (chatId, evidence) => localEvidenceSender(evidence, { chatId }),
      allowedOpenIds: config.integrations.feishu.allowedOpenIds,
      logger
    });
    const receiptPump = createTerminalReceiptPump({
      store,
      sendText: (chatId, text) => feishuTransport.sendText(chatId, text),
      logger
    });
    const socketStarter = dependencies.startFeishuSocket ?? startFeishuWebSocket;
    const startFeishu = async () => socketStarter({
      transport: feishuTransport,
      handleEvent: handleFeishuEvent,
      sdk: dependencies.feishuSdk
    });

    const supervisor = createRuntimeSupervisor({
      startFeishu,
      scheduler,
      refreshTelemetry,
      multicaBridge,
      receiptPump,
      healthReporter: createControlPlaneHealth({ home }),
      browser: lazyEdge,
      processLock,
      store,
      logger,
      intervals: {
        telemetryMs: Math.max(2, config.scheduler.pollSeconds) * 1000,
        multicaMs: 15_000,
        receiptsMs: 2_000,
        healthMs: 60_000
      },
      ...supervisorOptions
    });

    return {
      supervisor,
      config,
      configSource,
      services: {
        store,
        catalog,
        browserExecutor,
        appExecutor,
        scheduler,
        multicaClient,
        multicaBridge,
        receiptPump,
        verificationBroker,
        handleFeishuEvent
      }
    };
  } catch (error) {
    try {
      store?.close();
    } finally {
      await processLock.release();
    }
    throw error;
  }
}

export async function buildMcpRuntime({
  home,
  bindingPath = null,
  dependencies = {},
  repositoryRoot = REPOSITORY_ROOT
} = {}) {
  if (!home) throw new Error('MCP 运行时缺少 DAILY_TWIN_HOME');
  const { config } = await loadConfig(home);
  const runtimeDatabasePath = resolvePrivatePath(home, config.database);
  await mkdir(dirname(runtimeDatabasePath), { recursive: true });
  const store = new TaskStore(runtimeDatabasePath, storeOptionsFromConfig(config));
  let server = null;
  let lazyEdge = null;
  try {
    const catalogPath = resolvePrivatePath(home, config.integrations.appCatalog);
    const catalog = await loadAppCatalog(catalogPath);
    const capabilitySecret = await readPrivateSecret(home, config.integrations.capabilitySecretFile, { minLength: 32 });
    let boundCapability = null;
    if (bindingPath) {
      const absoluteBindingPath = resolvePrivatePath(home, bindingPath);
      const binding = await readPrivateJson(home, bindingPath);
      if (!binding?.ticket || !binding?.workerId) {
        throw Object.assign(new Error('worker binding 缺少 ticket 或 workerId'), { code: 'invalid_worker_binding' });
      }
      boundCapability = verifyCapabilityTicket(binding.ticket, {
        secret: capabilitySecret,
        store,
        consume: true,
        request: { workerId: String(binding.workerId) }
      });
      await unlink(absoluteBindingPath);
    }
    const connectEdge = dependencies.connectEdge ?? (() => connectPlaywrightEdge({
      command: config.browser.playwrightCommand,
      outputDir: resolvePrivatePath(home, 'data/screenshots'),
      cwd: repositoryRoot,
      env: process.env
    }));
    lazyEdge = createLazyPlaywrightEdge({ connect: connectEdge });
    const browserExecutor = new TaskBrowserExecutor({ store, catalog, driver: lazyEdge });
    const appLauncher = dependencies.createAppLauncher
      ? await dependencies.createAppLauncher({ config, catalogPath, repositoryRoot })
      : (config.windows.pwshPath
          ? new PowerShellAppLauncher({
              pwshPath: config.windows.pwshPath,
              scriptPath: join(repositoryRoot, 'platform', 'windows', 'Start-DailyTwinApp.ps1'),
              catalogPath
            })
          : unavailableAppLauncher('windows.pwshPath 未配置，软件启动失败关闭'));
    const appExecutor = new WindowsAppExecutor({ store, catalog, launcher: appLauncher });
    const toolService = createTaskToolService({
      store,
      capabilitySecret,
      boundCapability,
      browserExecutor,
      appExecutor
    });
    server = createDailyTwinMcpServer({ toolService });
    const connectMcp = dependencies.connectMcp ?? connectDailyTwinMcpStdio;
    const connection = await connectMcp({ server });
    let closed = false;
    return {
      server,
      connection,
      toolService,
      async close() {
        if (closed) return;
        closed = true;
        await server.close?.();
        await lazyEdge.close();
        store.close();
      }
    };
  } catch (error) {
    try { await server?.close?.(); } catch {}
    try { await lazyEdge?.close?.(); } catch {}
    store.close();
    throw error;
  }
}
