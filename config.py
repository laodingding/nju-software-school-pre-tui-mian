import json
from pathlib import Path


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / "config.json"


def load_config(path=DEFAULT_CONFIG_PATH):
    config = {
        "api_key": None,
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen3.8-flash",
        "request_timeout": 180,
        "enable_thinking": False,
    }
    config_path = Path(path)
    if config_path.is_file():
        with config_path.open("r", encoding="utf-8") as f:
            user_config = json.load(f)
        if isinstance(user_config, dict):
            config.update({k: v for k, v in user_config.items() if v is not None})
    return config
