# Mini Coding Agent

A small coding-agent demo implemented without LangChain, AutoGen, OpenAI Agents
SDK, or any other agent framework. It uses the DashScope OpenAI-compatible API
to call Qwen and runs all file/command tools locally.

## Run

```powershell
pip install -r requirements.txt
python main.py --web
```

Open `http://127.0.0.1:8000`.

Create `config.json` in the project root:

```json
{
  "api_key": "your API key",
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3.8-max",
  "request_timeout": 180,
  "enable_thinking": false
}
```

`config.json`, runtime history, cache files, and generated workspace projects are
ignored by Git.

## Features

- Browser chat UI with live execution events through SSE.
- Manual force-stop button to clear the active run, kill current command processes,
  and release the workspace lock for the next task.
- Local tools: `list_files`, `read_file`, `write_file`, and `run_command`.
- Project isolation: every first-level directory under `workspace/` is a project.
- Conversation isolation: each project can contain multiple independent chats.
- Persistent history in `data/projects/<project>.json`.
- Crash recovery: stale `running` tasks are marked as `interrupted` on startup.
- No fixed step limit inside one agent loop; it stops when the model finishes or
  a model/tool error makes progress impossible.
- Multi-agent orchestration for complex tasks:
  - requirements agent: analyzes the task and writes a development document
  - implementation agent: edits, debugs, and tests code
  - review agent: checks code quality and requirement coverage
- The orchestrator asks the model to decide whether a task needs multi-agent
  handling, with a heuristic fallback when the decision call fails.
- If review returns `CHANGES_REQUIRED:`, the implementation agent gets one repair
  pass and the review agent verifies again.

## Structure

- `main.py`: CLI and Web entry point
- `agent.py`: reusable role agent and tool-calling loop
- `multi_agent.py`: single-agent / multi-agent decision and orchestration
- `llm.py`: DashScope OpenAI-compatible client
- `tools.py`: local file and command tools
- `history.py`: persistent project/conversation history
- `projects.py`: project discovery and path validation
- `web_app.py`: HTTP server and SSE API
- `web/`: browser UI
- `workspace/`: allowed project workspace
