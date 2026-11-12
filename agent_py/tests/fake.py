import json
from types import SimpleNamespace as NS

from openai.types.chat import ChatCompletionMessage


def tool_call(id, name, args):
    return {"id": id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}

class FakeClient:
    """按脚本依次返回模型回复，记录每次收到的 messages"""
    def __init__(self, script, prompt_tokens=100):
        self.script = list(script); self.seen = []; self.pt = prompt_tokens
        self.chat = NS(completions=NS(create=self.create))
    def create(self, model, messages, tools=None):
        self.seen.append(json.loads(json.dumps(messages, default=str)))
        step = self.script.pop(0)
        if isinstance(step, str):
            msg = ChatCompletionMessage(role="assistant", content=step)
        else:
            msg = ChatCompletionMessage(role="assistant", content=None, tool_calls=step)
        return NS(choices=[NS(message=msg)], usage=NS(prompt_tokens=self.pt))

class FakeChannel:
    def __init__(self, incoming=()):
        self.incoming = list(incoming); self.sent = []; self.pending = []
    def fetch(self, timeout=None):
        return [self.incoming.pop(0)] if self.incoming else []
    def poll(self, timeout=None):
        if self.pending:
            out, self.pending = self.pending, []; return out
        return self.fetch()
    def send(self, chat_id, text): self.sent.append((chat_id, text))