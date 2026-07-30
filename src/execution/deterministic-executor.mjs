import { resolveWebsite } from '../core/app-catalog.mjs';
import { VERIFICATION_REASON } from '../core/task-store.mjs';

export function classifyTaskMode(request) {
  const text = String(request ?? '').trim();
  if (/^打开\s*omicos\s*$/i.test(text)) return 'deterministic';
  if (/打开\s*biomni/i.test(text) && /输入/.test(text) && /运行\s*$/i.test(text)) return 'deterministic';
  return 'complex';
}

function biomniPrompt(request) {
  const text = String(request ?? '').trim();
  const beforeRun = text.replace(/(?:，|,)?\s*(?:并)?运行\s*$/i, '').trim();
  const index = beforeRun.lastIndexOf('输入');
  if (index < 0) return null;
  return beforeRun.slice(index + 2).trim().replace(/^[：:]\s*/, '').replace(/^["'“‘]|["'”’]$/g, '').trim();
}

export function createDeterministicExecutor({ browserExecutor, appExecutor, catalog, verificationBroker = null } = {}) {
  if (!browserExecutor || !appExecutor || !catalog) throw new Error('确定性执行器缺少 browser/app/catalog');

  async function checkUserGate({ task, store, website, stage, knownGate = null }) {
    const gate = knownGate ?? await browserExecutor.detectUserGate?.({ taskId: task.id });
    if (!gate) return null;
    store?.saveResumeState?.(task.id, { flow: 'biomni', stage, website: website.id });
    if (gate.kind === 'verification') {
      if (!verificationBroker) {
        return { outcome: 'waiting_for_user', reason: '需要验证码，但本机验证码通道未启动' };
      }
      verificationBroker.wait(task.id, async (code) => {
        const accepted = await browserExecutor.provideVerification({ taskId: task.id, code });
        const current = store?.getTask?.(task.id);
        if (current?.state === 'waiting_for_user' && !current.paused) store.continueTask(task.id);
        return accepted?.accepted !== false;
      });
      return { outcome: 'waiting_for_user', reason: VERIFICATION_REASON };
    }
    if (gate.kind === 'login') {
      return { outcome: 'waiting_for_user', reason: '需要登录，请在任务标签页完成登录后发送“继续 <任务号>”' };
    }
    return null;
  }

  return async ({ task, store = null }) => {
    const request = String(task?.request ?? '').trim();
    try {
      if (/^打开\s*omicos\s*$/i.test(request)) {
        const launched = await appExecutor.launch({ taskId: task.id, alias: 'omicos' });
        if (!launched?.evidenceRef || !launched?.processId) {
          return { outcome: 'failed', reason: 'Omicos 启动后没有通过进程验证' };
        }
        return { outcome: 'completed', summary: `Omicos 已启动并验证进程 ${launched.processId}` };
      }

      if (classifyTaskMode(request) === 'deterministic' && /biomni/i.test(request)) {
        const prompt = biomniPrompt(request);
        if (!prompt) return { outcome: 'failed', reason: '没有解析到要输入 Biomni 的内容' };
        const website = resolveWebsite(catalog, 'biomni');
        const saved = store?.getResumeState?.(task.id);
        let stage = saved?.flow === 'biomni' && saved?.website === website.id ? saved.stage : null;
        await browserExecutor.open({ taskId: task.id, website: website.id });
        if (stage !== 'submitted') {
          const gate = await checkUserGate({ task, store, website, stage: stage ?? 'opened' });
          if (gate) return gate;
          if (stage !== 'filled') {
            await browserExecutor.fill({ taskId: task.id, field: 'prompt', text: prompt });
            stage = 'filled';
            store?.saveResumeState?.(task.id, { flow: 'biomni', stage, website: website.id });
          }
          await browserExecutor.submit({ taskId: task.id, action: 'run' });
          stage = 'submitted';
          store?.saveResumeState?.(task.id, { flow: 'biomni', stage, website: website.id });
        }
        const submittedGate = await checkUserGate({ task, store, website, stage: 'submitted' });
        if (submittedGate) return submittedGate;
        const waited = await browserExecutor.wait({
          taskId: task.id,
          condition: String(website.resultCondition ?? '任务完成'),
          timeoutMs: Number(website.resultTimeoutMs ?? 900_000)
        });
        if (waited?.gate) {
          const lateGate = await checkUserGate({
            task,
            store,
            website,
            stage: 'submitted',
            knownGate: waited.gate
          });
          if (lateGate) return lateGate;
        }
        const captured = await browserExecutor.capture({ taskId: task.id });
        store?.saveResumeState?.(task.id, null);
        return { outcome: 'completed', summary: `Biomni 已提交并获得页面结果，证据 ${captured.evidenceRef}` };
      }
      return { outcome: 'failed', reason: '该任务不属于已登记的 0 Token 固定流程' };
    } catch (error) {
      if (error?.waitingForUser) return { outcome: 'waiting_for_user', reason: error.message };
      return { outcome: 'failed', reason: error?.message ?? String(error) };
    }
  };
}
