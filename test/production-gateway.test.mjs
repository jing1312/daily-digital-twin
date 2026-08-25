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
  // 中文注释：这里必须显式给出允许名单。原来不传 allowedOpenIds 也能跑通，是因为
  //           网关"名单为空 => 放行所有人"，也就是把 B32 那个洞编码进了测试。
  //           断言意图（去重、只回一次、只派发一次）完整保留，只是补上身份前提。
  const handler = createFeishuEventHandler({
    store,
    allowedOpenIds: ['ou_owner'],
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

// 中文注释：B32 —— 允许名单为空时必须失败关闭。
//   修复前 `src/gateway/feishu-websocket.mjs` 是
//   `allowedOpenIds.length > 0 ? new Set(...) : null`，null 就跳过过滤；
//   而 DEFAULT_CONFIG 和 config/runtime.example.json 里这个字段都是 []，
//   所以按默认配置起服务时，任何能把消息投进那个会话的人都能驱动这台电脑。
//   下游 authorizeSender/claimOwner 只挡得住"归属账号绑定之后"的人，
//   挡不住首次配对之前的抢占窗口 —— 新库刚起、或刚跑过 runtime owner reset 时都存在。
test('B32：名单为空且未绑定归属账号时，网关必须拒绝所有人', async () => {
  const store = new TaskStore(':memory:');
  const replies = [];
  const warnings = [];
  const handler = createFeishuEventHandler({
    store,
    allowedOpenIds: [],
    sendText: async (chatId, text) => replies.push({ chatId, text }),
    logger: { warn: (entry) => warnings.push(entry), error() {} }
  });

  const handled = await handler(textEvent({ openId: 'ou_stranger' }));
  assert.equal(handled.ignored, true);
  assert.equal(handled.reason, 'allowlist_empty');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0, '不得建任务');
  assert.equal(replies.length, 0, '不得回复陌生人，避免确认这台机器存在');
  assert.equal(store.getOwner(), null, '不得让陌生人抢到归属账号');
  assert.equal(warnings.length, 1, '必须在本机日志里留下被拒记录');
  assert.equal(warnings[0].reason, 'allowlist_empty');
  assert.equal(warnings[0].senderOpenId, 'ou_s***', 'open_id 按仓库惯例掩码，不写全值');
  store.close();
});

// 中文注释：B32b —— 首次配对开关是唯一的放行途径，而且必须是显式打开的。
//           打开它就能逐字恢复 PR #2 原来的行为，所以这一版改的是默认值，不是能力。
test('B32b：显式打开 allowFirstPairing 后，首次配对仍然可用', async () => {
  const store = new TaskStore(':memory:');
  const warnings = [];
  const handler = createFeishuEventHandler({
    store,
    allowedOpenIds: [],
    allowFirstPairing: true,
    sendText: async () => {},
    logger: { warn: (entry) => warnings.push(entry), error() {} }
  });

  const handled = await handler(textEvent({ openId: 'ou_owner' }));
  await handled.background;
  assert.equal(handled.ignored, undefined, '配对窗口开着时必须放行');
  assert.equal(store.getOwner(), 'ou_owner', '首次发送者应完成绑定');
  assert.equal(warnings[0].event, 'feishu_first_pairing_open', '开着窗口必须每条都吵一次');
  store.close();
});

// 中文注释：B32c —— 绑定完成之后，名单留空也只认那个账号，而且要在网关层就挡掉别人：
//           不让陌生人走到"认领消息"和"收到回复"这两步。
//           这也是为什么用户不必为了能用而长期把 allowFirstPairing 开着。
test('B32c：已绑定归属账号后，名单留空也只认那个账号，且在网关层就挡掉', async () => {
  const store = new TaskStore(':memory:');
  store.claimOwner('ou_owner');
  const replies = [];
  const handler = createFeishuEventHandler({
    store,
    allowedOpenIds: [],
    sendText: async (chatId, text) => replies.push({ chatId, text }),
    logger: { warn() {}, error() {} }
  });

  const stranger = await handler(textEvent({ messageId: 'om_x', openId: 'ou_stranger' }));
  assert.equal(stranger.ignored, true);
  assert.equal(stranger.reason, 'sender_not_owner');
  assert.equal(replies.length, 0, '陌生人不该收到"只接受首次配对账号"这种回复');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS count FROM inbound_messages').get().count, 0,
    '陌生人的消息不该被认领，否则主人重发同一 message_id 会被判重复'
  );

  const owner = await handler(textEvent({ messageId: 'om_y', openId: 'ou_owner' }));
  await owner.background;
  assert.equal(owner.ignored, undefined, '主人必须仍然能用');
  store.close();
});

// 中文注释：B32d —— 名单里混进空串或空白时不能被算成"名单非空"，
//           否则一个写歪的配置又会退回放行所有人。
test('B32d：名单里只有空串时视为空名单，不得放行', async () => {
  const store = new TaskStore(':memory:');
  const handler = createFeishuEventHandler({
    store,
    allowedOpenIds: ['', '   '],
    sendText: async () => {},
    logger: { warn() {}, error() {} }
  });
  const handled = await handler(textEvent({ openId: 'ou_stranger' }));
  assert.equal(handled.reason, 'allowlist_empty');
  store.close();
});

// 中文注释：B32e —— 名单非空时行为与修复前完全一致，不能顺手改坏。
test('B32e：名单非空时只认名单，行为与修复前一致', async () => {
  const store = new TaskStore(':memory:');
  const handler = createFeishuEventHandler({
    store,
    allowedOpenIds: ['ou_owner'],
    sendText: async () => {},
    logger: { warn() {}, error() {} }
  });
  const blocked = await handler(textEvent({ messageId: 'om_a', openId: 'ou_stranger' }));
  assert.equal(blocked.reason, 'sender_not_allowed');
  const allowed = await handler(textEvent({ messageId: 'om_b', openId: 'ou_owner' }));
  await allowed.background;
  assert.equal(allowed.ignored, undefined);
  store.close();
});
