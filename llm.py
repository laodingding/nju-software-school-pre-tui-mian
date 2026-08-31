from config import load_config
from openai import OpenAI


class LLMClient:
    """OpenAI-compatible client configured for DashScope/Qwen by default."""

    def __init__(self):
        config = load_config()
        self.api_key = config["api_key"]
        if not self.api_key:
            raise RuntimeError(
                "Missing config.json api_key. Create mini-coding-agent/config.json first."
            )
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=config["base_url"],
            timeout=float(config.get("request_timeout", 60)),
            max_retries=0,
        )
        self.model = config["model"]
        self.enable_thinking = bool(config.get("enable_thinking", False))

    def chat(self, messages, tools):
        payload = {
            "model": self.model,
            "messages": messages,
            "extra_body": {"enable_thinking": self.enable_thinking},
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        completion = self.client.chat.completions.create(**payload)
        # Convert the SDK message object into the plain dict format expected
        # by agent.py, preserving tool calls and their JSON arguments.
        return completion.choices[0].message.model_dump(exclude_none=True)
