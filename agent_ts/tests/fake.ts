// tests/fake.ts —— 对应 agent_py/tests/fake.py
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Msg } from "../telegram";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function toolCall(id: string, name: string, args: Record<string, any>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

type ScriptStep = string | ToolCall[];

/** 按脚本依次返回模型回复，记录每次收到的 messages */
export class FakeClient {
  script: ScriptStep[];
  seen: ChatCompletionMessageParam[][] = [];
  pt: number;
  chat: { completions: { create: (p: any) => any } };

  constructor(script: ScriptStep[], promptTokens = 100) {
    this.script = [...script];
    this.pt = promptTokens;
    this.chat = { completions: { create: (p) => this.create(p) } };
  }

  create({ messages }: { messages: ChatCompletionMessageParam[] }) {
    this.seen.push(JSON.parse(JSON.stringify(messages)));
    const step = this.script.shift()!;
    const message =
      typeof step === "string"
        ? { role: "assistant", content: step }
        : { role: "assistant", content: null, tool_calls: step };
    return { choices: [{ message }], usage: { prompt_tokens: this.pt } };
  }
}

export class FakeChannel {
  incoming: Msg[];
  sent: [number, string][] = [];
  pending: Msg[] = [];

  constructor(incoming: Msg[] = []) {
    this.incoming = [...incoming];
  }

  async fetch(_timeout?: number): Promise<Msg[]> {
    return this.incoming.length ? [this.incoming.shift()!] : [];
  }

  async poll(_timeout?: number): Promise<Msg[]> {
    if (this.pending.length) {
      const out = this.pending;
      this.pending = [];
      return out;
    }
    return this.fetch();
  }

  async send(chatId: number, text: string): Promise<void> {
    this.sent.push([chatId, text]);
  }
}
