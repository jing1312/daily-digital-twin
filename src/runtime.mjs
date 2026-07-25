import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from './core/task-store.mjs';
import { parseRuntimeCommand } from './core/runtime-command.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

// 中文注释：创建私有目录结构，不把运行数据放进公开源码目录。
async function initializeHome(home) {
  const directories = ['data/tasks', 'data/receipts', 'data/screenshots', 'data/cache', 'data/logs', 'config'];
  await Promise.all(directories.map((directory) => mkdir(join(home, directory), { recursive: true })));
  console.log(JSON.stringify({ home, directories, initializedAt: new Date().toISOString() }, null, 2));
}

// 中文注释：在私有 SQLite 中创建任务并返回任务编号。
function createTask(home, request) {
  const store = new TaskStore(join(home, 'data/runtime.sqlite'));
  try {
    console.log(JSON.stringify(store.createTask({ request }), null, 2));
  } finally {
    store.close();
  }
}

// 中文注释：读取任务状态，供飞书适配器和本机诊断调用。
function showStatus(home) {
  const store = new TaskStore(join(home, 'data/runtime.sqlite'));
  try {
    console.log(JSON.stringify({ tasks: store.listActiveTasks() }, null, 2));
  } finally {
    store.close();
  }
}

// 中文注释：执行暂停、继续或取消，所有变化都写入任务事件。
function updateTask(home, command) {
  const store = new TaskStore(join(home, 'data/runtime.sqlite'));
  try {
    const task = store.getTask(command.taskId);
    if (!task) throw new Error(`任务 ${command.taskId} 不存在`);
    if (command.command === 'pause') console.log(JSON.stringify(store.pause(task.id), null, 2));
    if (command.command === 'resume') console.log(JSON.stringify(store.resume(task.id), null, 2));
    if (command.command === 'cancel') console.log(JSON.stringify(store.transition(task.id, 'cancelled', { reason: '用户取消' }), null, 2));
  } finally {
    store.close();
  }
}

const command = parseRuntimeCommand(process.argv.slice(2));
const home = resolve(process.env.DAILY_TWIN_HOME ?? join(scriptDirectory, '..', 'runtime'));

if (command.command === 'init') await initializeHome(resolve(command.home ?? home));
else if (command.command === 'create') createTask(home, command.request);
else if (command.command === 'status') showStatus(home);
else updateTask(home, command);
