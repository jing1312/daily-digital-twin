import * as LarkSdk from '@larksuiteoapi/node-sdk';
import { readFile } from 'node:fs/promises';
import { createFeishuController } from './feishu-controller.mjs';
import { redactText } from '../core/redact.mjs';

export function normalizeFeishuEvent(data) {
  const message = data?.message;
  if (message?.message_type !== 'text') return null;
  const messageId = String(message.message_id ?? '').trim();
  const chatId = String(message.chat_id ?? '').trim();
  const openId = String(data?.sender?.sender_id?.open_id ?? '').trim();
  if (!messageId || !chatId || !openId) return null;
  let content;
  try { content = JSON.parse(message.content ?? '{}'); } catch { return null; }
  const text = String(content?.text ?? '').trim();
  if (!text) return null;
  return { messageId, chatId, text, sender: { openId, chatId, messageId } };
}

// 中文注释：open_id 按仓库既有惯例掩码（与 `runtime owner show` 一致），日志里不写全值。
function maskOpenId(openId) {
  const text = String(openId ?? '').trim();
  return text ? `${text.slice(0, 4)}***` : '(空)';
}

// 中文注释：发送者准入判定，失败关闭。
//   原实现是"allowedOpenIds 为空 => 不过滤任何人"，而 DEFAULT_CONFIG 和
//   config/runtime.example.json 里这个字段都是 []，所以按默认配置起服务时，
//   任何能把消息投进那个会话的人都能驱动这台电脑。
//   下游 authorizeSender/claimOwner 只挡得住"归属账号已绑定之后"的人，
//   挡不住首次配对之前的抢占窗口 —— 新库刚起、或刚跑过 `runtime owner reset` 时都存在。
//   改成三种情况分开判：
//     1) 名单非空 —— 只认名单，与原来完全一致；
//     2) 名单为空但库里已绑定归属账号 —— 只认那个账号，并且在网关层就挡掉，
//        不让陌生人走到认领消息和收到回复那一步；
//     3) 名单为空且还没有归属账号 —— 除非显式打开 allowFirstPairing，一律拒绝。
//   把 allowFirstPairing 设为 true 就能逐字恢复原来的行为，所以这里改的是默认值，不是能力。
function admitSender({ store, allow, allowFirstPairing, openId, logger }) {
  if (allow.size > 0) {
    return allow.has(openId) ? { ok: true } : { ok: false, reason: 'sender_not_allowed' };
  }
  const boundOwner = typeof store.getOwner === 'function' ? store.getOwner() : null;
  if (boundOwner) {
    return boundOwner === openId ? { ok: true } : { ok: false, reason: 'sender_not_owner' };
  }
  if (allowFirstPairing === true) {
    logger.warn?.({
      event: 'feishu_first_pairing_open',
      senderOpenId: maskOpenId(openId),
      message: 'allowedOpenIds 为空且尚未绑定归属账号，首次配对窗口是开着的：本条消息会完成绑定。绑定完成后请把 allowFirstPairing 改回 false。'
    });
    return { ok: true };
  }
  logger.warn?.({
    event: 'feishu_sender_rejected',
    reason: 'allowlist_empty',
    senderOpenId: maskOpenId(openId),
    message: '已拒绝：allowedOpenIds 为空且尚未绑定归属账号。请把主人 open_id 填进 integrations.feishu.allowedOpenIds，或临时把 integrations.feishu.allowFirstPairing 设为 true 完成一次首次配对。'
  });
  return { ok: false, reason: 'allowlist_empty' };
}

export function createFeishuEventHandler({
  store,
  sendText,
  dispatchTask = null,
  verificationBroker = null,
  sendEvidence = null,
  taskLifecycle = null,
  allowedOpenIds = null,
  allowFirstPairing = false,
  logger = console
} = {}) {
  if (!store || typeof sendText !== 'function') throw new Error('飞书事件处理器缺少 store 或 sendText');
  // 中文注释：先归一化名单。空串和纯空白不算有效条目 —— 否则 allowedOpenIds: ['']
  //           这种写歪的配置会被判成"名单非空"，然后放行一个谁都不是的身份。
  const allow = new Set(
    (Array.isArray(allowedOpenIds) ? allowedOpenIds : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  );
  return async (data) => {
    const event = normalizeFeishuEvent(data);
    if (!event) return { ignored: true, reason: 'unsupported_event' };
    const gate = admitSender({ store, allow, allowFirstPairing, openId: event.sender.openId, logger });
    if (!gate.ok) return { ignored: true, reason: gate.reason };
    if (!store.claimInboundMessage({
      messageId: event.messageId,
      senderOpenId: event.sender.openId,
      chatId: event.chatId
    })) return { duplicate: true, messageId: event.messageId };

    const controller = createFeishuController({
      store,
      dispatchTask,
      verificationBroker,
      taskLifecycle,
      sendEvidence: typeof sendEvidence === 'function'
        ? (evidence) => sendEvidence(event.chatId, evidence)
        : null,
      logger,
      sendText: (text) => sendText(event.chatId, text)
    });
    let handled;
    try {
      handled = await controller.handle({ text: event.text, sender: event.sender });
    } catch (error) {
      const reason = error?.code ?? 'local_command_failed';
      const message = redactText(error?.message ?? String(error)).trim().slice(0, 300) || '本机指令执行失败';
      logger.error?.({ event: 'feishu_command_failed', messageId: event.messageId, code: reason, message });
      const result = { action: 'failed', reason, message: `指令未执行：${message}` };
      await sendText(event.chatId, result.message);
      return { result, background: null };
    }
    if (handled.result?.task?.id) store.linkInboundMessage(event.messageId, handled.result.task.id);
    return handled;
  };
}

export function createFeishuSdkTransport({ appId, appSecret, sdk = LarkSdk } = {}) {
  if (!appId || !appSecret) throw new Error('飞书 transport 缺少 appId/appSecret');
  const base = { appId, appSecret, appType: sdk.AppType?.SelfBuild, domain: sdk.Domain?.Feishu };
  const client = new sdk.Client(base);
  return {
    async sendText(chatId, text) {
      return client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ text: String(text) }), msg_type: 'text' }
      });
    },
    async sendImage(chatId, path) {
      const image = await readFile(path);
      const uploaded = await client.im.v1.image.create({
        data: { image_type: 'message', image }
      });
      const imageKey = uploaded?.image_key ?? uploaded?.data?.image_key;
      if (!imageKey) throw new Error('飞书图片上传没有返回 image_key');
      return client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ image_key: imageKey }), msg_type: 'image' }
      });
    },
    client,
    base
  };
}

export function startFeishuWebSocket({ transport, handleEvent, sdk = LarkSdk, loggerLevel = null } = {}) {
  if (!transport?.base || typeof handleEvent !== 'function') throw new Error('飞书 WebSocket 缺少 transport 或事件处理器');
  const dispatcher = new sdk.EventDispatcher({}).register({ 'im.message.receive_v1': handleEvent });
  const wsClient = new sdk.WSClient({
    ...transport.base,
    loggerLevel: loggerLevel ?? sdk.LoggerLevel?.info
  });
  wsClient.start({ eventDispatcher: dispatcher });
  return {
    wsClient,
    dispatcher,
    async close() {
      if (typeof wsClient.close === 'function') return wsClient.close();
      if (typeof wsClient.stop === 'function') return wsClient.stop();
    }
  };
}
