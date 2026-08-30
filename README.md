# Mini Coding Agent

一个不依赖 Agent 框架的编程智能体 Demo。它通过 DashScope 的 OpenAI 兼容接口调用 Qwen，在本地项目目录中读取文件、修改代码和执行命令。

## 运行

需要 Python 3.9+：

```powershell
pip install -r requirements.txt
python main.py --web
```

浏览器打开 `http://127.0.0.1:8000`。

在项目根目录创建 `config.json`：

```json
{
  "api_key": "你的 API Key",
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3.8-max"
}
```

`config.json` 已加入 `.gitignore`，不会提交到仓库。

## 功能

- 浏览器输入任务，实时查看 Agent 步骤、工具调用和工具结果。
- 当前对话内连续发送任务，消息会追加到同一个聊天时间线。
- 点击“新建对话”创建独立上下文；同一项目下不同对话不会互相读取历史消息。
- 每个项目使用独立的工作目录和历史文件。
- Agent 不使用固定最大步数，直到模型返回最终答复或发生无法恢复的模型/工具异常。
- 工具异常会立即结束任务，并把异常原因显示给用户。
- 如果模型判断现有工具无法解决任务，也会结束任务并显示具体原因。
- 模型请求默认 180 秒超时，并关闭 Qwen 思考模式以提升工具调用响应速度；超时后会把错误原因返回到界面，不会永久卡在某一步。
- 服务重启时会自动将遗留的运行中任务标记为中断，不会阻塞新任务。
- 同一端口重复启动会明确提示端口占用。
- 文件工具限制在当前项目目录内，命令在当前项目目录执行，命令超时为 30 秒。

## 项目结构

- `main.py`：命令行和 Web 启动入口
- `agent.py`：上下文、工具调用循环和终止逻辑
- `llm.py`：DashScope OpenAI 兼容客户端
- `tools.py`：本地文件和命令工具
- `history.py`：多对话历史持久化
- `projects.py`：项目发现和路径校验
- `web_app.py`：HTTP 服务和 SSE 流式接口
- `web/`：前端对话界面
- `workspace/`：Agent 可操作的项目目录

历史记录保存在 `data/projects/`，运行数据不会提交到 Git。
