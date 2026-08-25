export class VerificationBroker {
  constructor() {
    this.waiters = new Map();
  }

  wait(taskId, deliver) {
    if (typeof deliver !== 'function') throw new Error('验证码等待器必须是函数');
    this.waiters.set(Number(taskId), deliver);
  }

  has(taskId) {
    return this.waiters.has(Number(taskId));
  }

  cancel(taskId) {
    return this.waiters.delete(Number(taskId));
  }

  async deliver(taskId, code) {
    const key = Number(taskId);
    const receiver = this.waiters.get(key);
    if (!receiver) return false;
    const result = await receiver(String(code));
    if (result !== false) this.waiters.delete(key);
    return result;
  }
}
