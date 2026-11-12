// telegram.ts —— 第 6 课：Telegram 渠道（长轮询，不需要公网 IP）
const MAX_LEN = 4000; // Telegram 单条上限 4096，留点余量
const RETRIES = 3; // 瞬时网络错误（TLS 握手超时等）的重试次数

export type Msg = [chatId: number, userId: number, text: string];

export class Telegram {
  base: string;
  timeout: number;
  offset = 0;
  pending: Msg[] = []; // 等待确认期间收到的"别的消息"，稍后处理

  constructor(token: string, timeout = 30) {
    this.base = `https://api.telegram.org/bot${token}/`;
    this.timeout = timeout;
  }

  /** 网络错误重试（指数退避）；API 业务错误不重试。
   * Node 的 fetch 不读 HTTP(S)_PROXY 环境变量，需要代理时用 HTTPS_PROXY +
   * undici 的 EnvHttpProxyAgent，或直接在系统层代理。 */
  private async call(method: string, params: Record<string, any>): Promise<any> {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      let body: { ok: boolean; result?: any };
      try {
        const resp = await fetch(this.base + method, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout((this.timeout + 10) * 1000),
        });
        body = (await resp.json()) as { ok: boolean; result?: any };
      } catch (e) {
        if (attempt === RETRIES) throw e;
        const wait = 2 ** attempt; // 2s、4s，指数退避
        console.log(
          `[tg] ${method} 网络错误（第 ${attempt} 次）：${(e as Error).message}，${wait} 秒后重试`,
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!body.ok) throw new Error(`Telegram API 错误：${JSON.stringify(body)}`);
      return body.result;
    }
  }

  /** 只拉新消息。返回 [(chat_id, user_id, text)]，只要私聊文本。 */
  async fetch(timeout?: number): Promise<Msg[]> {
    const updates = (await this.call("getUpdates", {
      offset: this.offset,
      timeout: timeout ?? this.timeout,
    })) as any[];
    const out: Msg[] = [];
    for (const u of updates) {
      this.offset = u.update_id + 1; // 确认已收到，下次不再返回
      const m = u.message;
      if (m && "text" in m && m.chat.type === "private") {
        out.push([m.chat.id, m.from.id, m.text]);
      }
    }
    return out;
  }

  /** 先交出积压的消息，没有积压再去拉新的。 */
  async poll(timeout?: number): Promise<Msg[]> {
    if (this.pending.length) {
      const out = this.pending;
      this.pending = [];
      return out;
    }
    return this.fetch(timeout);
  }

  async send(chatId: number, text: string): Promise<void> {
    text = text || "（空回复）";
    for (let i = 0; i < text.length; i += MAX_LEN) {
      await this.call("sendMessage", { chat_id: chatId, text: text.slice(i, i + MAX_LEN) });
    }
  }
}
