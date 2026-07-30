import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskStore } from '../src/core/task-store.mjs';
import { createFeishuEventHandler, createFeishuSdkTransport, normalizeFeishuEvent } from '../src/gateway/feishu-websocket.mjs';
import { createTerminalReceiptPump } from '../src/gateway/terminal-receipt-pump.mjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const evidenceModule = await import('../src/gateway/local-evidence-sender.mjs').catch(() => ({}));

function textEvent({ messageId = 'om_1', text = '打开 Omicos', openId = 'ou_owner', chatId = 'oc_chat' } = {}) {
  return {
    sender: { sender_id: { open_id: openId } },
    message: {
      message_id: messageId,
      chat_id: chatId,
      message_type: 'text',
      content: JSON.stringify({ text })
    }
  };
}

test('飞书事件只接受文本，并保留 message/chat/open id 供去重和回执', () => {
  assert.deepEqual(normalizeFeishuEvent(textEvent()), {
    messageId: 'om_1',
    chatId: 'oc_chat',
    text: '打开 Omicos',
    sender: { openId: 'ou_owner', chatId: 'oc_chat', messageId: 'om_1' }
  });
  assert.equal(normalizeFeishuEvent({ message: { message_type: 'image' } }), null);
});

test('同一 message_id 重推不会重复建任务、回复或派发', async () => {
  const store = new TaskStore(':memory:');
  const replies = [];
  let dispatches = 0;
  const handler = createFeishuEventHandler({
    store,
    sendText: async (chatId, text) => replies.push({ chatId, text }),
    dispatchTask: async () => { dispatches += 1; return { issueId: 'MUL-1' }; }
  });
  const event = textEvent();
  const first = await handler(event);
  await first.background;
  const duplicate = await handler(event);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
  assert.equal(replies.length, 1);
  assert.equal(dispatches, 1);
  assert.equal(store.getTask(first.result.task.id).replyChatId, 'oc_chat');
  store.close();
});

test('任务上限等本机拒绝必须回复一次，不能认领消息后静默消失', async () => {
  const store = new TaskStore(':memory:');
  store.claimOwner('ou_owner');
  for (let index = 0; index < 4; index += 1) {
    store.createTask({ request: `占用任务 ${index}` });
  }
  const replies = [];
  const handler = createFeishuEventHandler({
    store,
    sendText: async (chatId, text) => replies.push({ chatId, text }),
    logger: { error() {} }
  });

  const handled = await handler(textEvent({ messageId: 'om_limit', text: '第五个任务' }));
  const duplicate = await handler(textEvent({ messageId: 'om_limit', text: '第五个任务' }));

  assert.equal(handled.result.action, 'failed');
  assert.match(replies[0].text, /未执行|上限/);
  assert.equal(replies.length, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.countOpenTasks(), 4);
  store.close();
});

test('终态回执重启可续发，发送成功后永不重复', async () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({
    request: '打开 Omicos',
    ownerOpenId: 'ou_owner',
    replyChatId: 'oc_chat',
    sourceMessageId: 'om_1'
  });
  store.transition(task.id, 'running');
  store.insertExecutionEvidence({ taskId: task.id, kind: 'process', processId: 42, processName: 'Omicos' });
  store.transition(task.id, 'completed', { summary: 'Omicos 已启动并验证进程' });

  const sent = [];
  const pump = createTerminalReceiptPump({
    store,
    sendText: async (chatId, text) => sent.push({ chatId, text })
  });
  assert.equal((await pump.flush()).sent, 1);
  assert.equal((await pump.flush()).sent, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'oc_chat');
  assert.match(sent[0].text, new RegExp(task.publicId));
  assert.match(sent[0].text, /完成/);
  assert.ok(store.getTerminalReceipt(task.id).sentAt);
  store.close();
});

test('终态回执发送前统一脱敏，不把授权头或真实用户目录发到飞书', async () => {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ request: '失败任务', replyChatId: 'oc_chat' });
  const fakeTokenBody = 'abcdef0123456789ABCDEF0123456789';
  const privatePath = 'C:' + '\\' + 'Users' + '\\' + 'private-owner' + '\\' + 'secret.txt';
  store.transition(task.id, 'running');
  store.transition(task.id, 'failed', {
    reason: `Authorization: Bearer ${fakeTokenBody} at ${privatePath}`
  });
  const sent = [];
  const pump = createTerminalReceiptPump({
    store,
    sendText: async (_chatId, text) => sent.push(text)
  });

  await pump.flush();

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], new RegExp(fakeTokenBody));
  assert.doesNotMatch(sent[0], /private-owner/i);
  store.close();
});

test('本机证据发送器只允许 screenshots 根目录内的图片', async () => {
  assert.equal(typeof evidenceModule.createLocalEvidenceSender, 'function');
  const home = mkdtempSync(join(tmpdir(), 'ddt-evidence-'));
  try {
    const root = join(home, 'screenshots');
    mkdirSync(root);
    const image = join(root, 'task.png');
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sent = [];
    const send = evidenceModule.createLocalEvidenceSender({
      screenshotRoot: root,
      sendImage: async (path) => sent.push(path)
    });
    await send({ kind: 'page', target: image });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].toLowerCase(), image.toLowerCase());
    await assert.rejects(
      () => send({ kind: 'page', target: join(home, 'outside.png') }),
      (error) => error.code === 'evidence_path_denied'
    );
    await assert.rejects(
      () => send({ kind: 'file', target: image }),
      (error) => error.code === 'evidence_kind_denied'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('飞书图片发送先上传本机 Buffer，再用 image_key 发消息', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ddt-feishu-image-'));
  try {
    const image = join(home, 'evidence.png');
    writeFileSync(image, Buffer.from([1, 2, 3]));
    const calls = [];
    class FakeClient {
      im = { v1: {
        image: { create: async (request) => { calls.push(['upload', request]); return { image_key: 'img_123' }; } },
        message: { create: async (request) => { calls.push(['message', request]); return { ok: true }; } }
      } };
    }
    const sdk = { Client: FakeClient, AppType: { SelfBuild: 1 }, Domain: { Feishu: 'feishu' } };
    const transport = createFeishuSdkTransport({ appId: 'cli_test', appSecret: 'secret', sdk });
    await transport.sendImage('oc_chat', image);
    assert.equal(Buffer.isBuffer(calls[0][1].data.image), true);
    assert.equal(calls[0][1].data.image_type, 'message');
    assert.equal(calls[1][1].data.msg_type, 'image');
    assert.deepEqual(JSON.parse(calls[1][1].data.content), { image_key: 'img_123' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
