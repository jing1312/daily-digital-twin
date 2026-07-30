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

export function createFeishuEventHandler({
  store,
  sendText,
  dispatchTask = null,
  verificationBroker = null,
  sendEvidence = null,
  taskLifecycle = null,
  allowedOpenIds = null,
  logger = console
} = {}) {
  if (!store || typeof sendText !== 'function') throw new Error('飞书事件处理器缺少 store 或 sendText');
  const allow = Array.isArray(allowedOpenIds) && allowedOpenIds.length > 0 ? new Set(allowedOpenIds) : null;
  return async (data) => {
    const event = normalizeFeishuEvent(data);
    if (!event) return { ignored: true, reason: 'unsupported_event' };
    if (allow && !allow.has(event.sender.openId)) return { ignored: true, reason: 'sender_not_allowed' };
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
