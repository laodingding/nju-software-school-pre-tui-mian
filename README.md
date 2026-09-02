# Mini Coding Agent

Mini Coding Agent 是一个使用 Python 编写的轻量级编程智能体 Demo。项目不依赖 LangChain、AutoGen 或其他 Agent 框架，直接通过 DashScope 的 OpenAI 兼容接口调用千问模型，并在受控工作区内完成文件读写、命令执行和 Web 界面自测。

## 项目能力

- 浏览器对话界面，实时展示 Agent 的完整执行过程。
- 支持需求分析、代码实现、调试测试和代码审查。
- Agent 会根据任务难度自动选择单 Agent 或三 Agent 协同模式。
- 多 Agent 任务会显示协作看板，按总控、需求分析、开发测试、代码审查四个角色展示接力分工和实时状态。
- 三 Agent 协同流程：
  - 需求分析 Agent：理解需求并撰写开发文档。
  - 开发与测试 Agent：读取文件、修改代码、调试并执行测试。
  - 代码审查 Agent：检查代码质量、需求覆盖情况和验证结果。
- 前端实时展示模型等待、Agent 阶段、步骤、工具调用、工具结果、测试过程和最终结果。
- 子 Agent 完成阶段后会生成可点击的交付记录，展示阶段结果、交接双方、交接标题、交付产物和完整内容，方便下一位 Agent 及用户审查；即使任务在正式交接前中断，也会保留该 Agent 已返回的阶段结果。
- 支持取消任务和强制停止任务，可清理正在运行的本地命令进程并释放任务锁。
- 页面刷新后可以恢复正在执行的任务状态，不会因为刷新自动清理任务。
- 服务重启后会将未完成任务标记为“已中断”，避免出现永久占用状态。
- 每个一级工作区目录都是独立项目。
- 同一项目可以创建多个相互隔离的对话，对话上下文不会互相污染。
- 支持 Playwright CLI 对 Web 项目进行自动化交互、控制台检查、网络检查和截图验证。
- Agent 循环没有固定最大步骤数，会在模型完成任务或确认无法继续时结束。

## 项目结构

```text
mini-coding-agent/
├── main.py                 # 命令行入口和 Web 服务入口
├── llm.py                  # DashScope/Qwen OpenAI 兼容客户端
├── config.py               # 配置文件读取
├── agent.py                # 单 Agent 工具调用循环
├── multi_agent.py          # 单 Agent / 多 Agent 路由和协同流程
├── tools.py                # 文件、命令和 Playwright 工具
├── history.py              # 项目和对话历史持久化
├── projects.py             # 工作区项目发现和路径校验
├── web_app.py              # HTTP API 和 SSE 事件流服务
├── web/
│   ├── index.html          # 前端页面结构
│   ├── app.css             # 前端样式
│   └── app.js              # 前端交互和事件渲染
├── workspace/              # Agent 允许操作的项目目录
├── config.example.json     # 配置示例
├── requirements.txt        # Python 依赖
└── CHANGELOG.md            # 版本变更记录
```

## 环境要求

- Python 3.9 及以上。
- 可用的 DashScope API Key。
- 如果需要进行 Web 界面自测，还需要 Node.js 和 npm。
- Playwright 浏览器由 `@playwright/cli` 按需管理。

## 安装和启动

在项目根目录执行：

```powershell
pip install -r requirements.txt
python main.py --web
```

浏览器打开：

```text
http://127.0.0.1:8000
```

也可以指定地址和端口：

```powershell
python main.py --web --host 127.0.0.1 --port 8000
```

## 配置千问 API

复制 `config.example.json` 为项目根目录下的 `config.json`，然后填写自己的 Key：

```powershell
Copy-Item config.example.json config.json
```

配置示例：

```json
{
  "api_key": "你的 DashScope API Key",
  "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "model": "qwen3.8-max",
  "request_timeout": 180,
  "enable_thinking": false
}
```

`config.json` 已加入 `.gitignore`，不会被提交到 Git。请不要把真实 API Key 写入代码、README 或提交记录。

## 使用方式

1. 在 `workspace/` 下创建一个项目目录，例如 `workspace/demo-project/`。
2. 启动 Web 服务并打开浏览器页面。
3. 在左侧选择项目，点击“新建对话”创建独立上下文。
4. 在输入框描述编程任务并点击“执行任务”。
5. 在页面中查看 Agent 的分析、工具调用、代码修改、命令执行、测试和审查过程。
6. 在“最终结果”区域查看任务完成说明或异常原因。
7. 任务执行期间可以点击红色“执行中”按钮发送取消请求，也可以使用“强制停止”清理任务和本地进程。

## 内置工具

| 工具 | 作用 |
| --- | --- |
| `list_files(path)` | 查看工作区目录下的文件 |
| `read_file(path)` | 读取文件内容 |
| `write_file(path, content)` | 新建或修改文件 |
| `run_command(command)` | 在当前项目目录执行命令 |
| `run_playwright_cli(command)` | 使用 Playwright CLI 进行 Web 自动化和界面验证 |

Agent 只能操作当前项目工作区内的文件。命令执行结果会回传给模型，并同步显示在前端时间线中。

## 多 Agent 协同流程

对于简单任务，系统会选择单 Agent 直接完成。对于涉及多个文件、前后端、测试、调试、重构或 Web 界面的复杂任务，系统会尝试启动三 Agent 协同流程：

```text
用户任务
   ↓
总控 Agent 判断任务难度
   ├── 简单任务 → 编码 Agent
   └── 复杂任务 → 需求分析 Agent
                         ↓
                  开发与测试 Agent
                         ↓
                    代码审查 Agent
                         ↓
                 必要时进行一次修复
```

每个阶段完成后，系统会记录一条交接事件。例如，需求分析 Agent 会把开发文档交给开发与测试 Agent，开发与测试 Agent 会把实现摘要和测试结果交给代码审查 Agent。前端会以“交接”卡片展示这些内容，完整文本可以展开查看。

如果模型的路由判断请求失败，系统会使用关键词和任务长度进行兜底判断。

### 查看阶段交付

多 Agent 看板中的每张 Agent 卡片都可以点击：

1. Agent 完成当前阶段后，卡片会显示“查看交付内容”。
2. 点击需求分析 Agent，可以查看需求分析结果和 `.agent/requirements.md`。
3. 点击开发与测试 Agent，可以查看实现摘要、修改文件和测试结果。
4. 点击代码审查 Agent，可以查看审查意见和需求验收结论。

阶段结果会随着事件流实时保存到当前对话。即使任务在正式交接前被中断，已经返回的阶段结果仍然可以在卡片中查看。正式交接到达后，系统会自动补充交接对象和交付产物，并合并为一条记录。

## Web 界面自测

当 Agent 开发 Web 项目时，可以先启动项目服务，再使用 Playwright CLI 访问本地页面：

```powershell
npm exec --yes @playwright/cli@latest -- --help
```

常用操作包括：

```text
open <url>       打开页面
goto <url>       跳转页面
snapshot         获取页面结构
find <text>      查找页面文本
click <target>   点击元素
fill <target>    填写输入框
press <key>      模拟键盘操作
console          查看浏览器控制台
requests         查看网络请求
screenshot       截图进行视觉检查
```

Agent 会将这些操作的调用参数和返回结果同步到前端执行时间线。

## 运行测试

检查 Python 文件语法：

```powershell
python -m py_compile main.py agent.py multi_agent.py tools.py web_app.py
```

检查前端 JavaScript 语法：

```powershell
node --check web/app.js
```

## API 接口

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/projects` | GET | 获取工作区项目列表 |
| `/api/conversations?project=...` | GET | 获取项目下的对话列表 |
| `/api/conversations` | POST | 创建新对话 |
| `/api/history?project=...&conversation_id=...` | GET | 获取对话执行历史 |
| `/api/current-run` | GET | 获取当前正在执行的任务 |
| `/api/run` | POST | 创建任务并通过 SSE 返回事件 |
| `/api/cancel` | POST | 请求在安全检查点取消任务 |
| `/api/force-stop` | POST | 强制停止任务并清理本地进程 |

## 数据和安全说明

- `config.json` 保存本地 API Key，不纳入 Git。
- `data/` 保存本地对话历史，不纳入 Git。
- `workspace/` 下的项目文件默认不纳入 Git，仅保留 `workspace/README.md`。
- 命令工具应只执行当前任务需要的命令。
- 不建议在公网直接暴露此 Demo 服务；当前版本没有用户认证和权限管理。

## 当前限制

- 同一服务进程同一时间只执行一个 Agent 任务。
- Agent 的实际能力取决于模型、工具返回结果和本地开发环境。
- Playwright 首次运行可能需要下载浏览器，耗时会比普通命令更长。
- 任务被强制停止后，已写入的文件不会自动回滚。

## 常见问题

### 页面仍显示旧状态

重启 Web 服务后使用浏览器强制刷新：

```powershell
python main.py --web
```

然后按 `Ctrl + F5` 刷新页面。历史任务会从 `data/` 中恢复，旧格式的执行事件也会被前端兼容解析。

### 提示已有任务正在执行

在页面点击“强制停止”，或者请求接口清理当前任务：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/force-stop -Method Post -ContentType "application/json" -Body "{}"
```

如果服务进程本身已经异常退出，重新启动服务即可；启动时会自动处理残留的运行状态。
