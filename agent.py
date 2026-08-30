import json


SYSTEM_PROMPT = """You are a careful coding agent.
You work only inside the provided workspace.
Complete the user's programming task by inspecting files, editing files, and running tests.
Use tools whenever you need to inspect or change the workspace.
If the available tools cannot solve the task, explain the limitation clearly and stop.
When the task cannot be completed with the available tools, start your final reply
with "UNSUPPORTED:" followed by the concrete reason.
Do not claim a task is complete until you have verified it when practical.
When finished, briefly summarize what changed and what you tested.
"""


class CodingAgent:
    def __init__(self, client, tools, messages=None):
        self.client = client
        self.tools = tools
        self.messages = messages or [{"role": "system", "content": SYSTEM_PROMPT}]
        self.last_status = "idle"

    def _finish(self, answer, status, emit):
        self.last_status = status
        emit("assistant", content=answer)
        return answer

    def run(self, task, on_event=None):
        def emit(event_type, **data):
            event = {"type": event_type, **data}
            if on_event:
                on_event(event)

        self.last_status = "running"
        self.messages.append({"role": "user", "content": task})
        emit("task", task=task)
        print(f"\nTask: {task}")
        step = 0

        # The loop ends when the model returns a normal answer or an
        # unrecoverable model/tool error occurs. There is intentionally no
        # arbitrary maximum-step cutoff.
        while True:
            step += 1
            emit("step", step=step)
            emit("model_waiting", message="正在等待模型响应...")
            print(f"\n[step {step}] thinking...")
            try:
                message = self.client.chat(self.messages, self.tools.definitions())
            except Exception as exc:
                reason = f"{type(exc).__name__}: {exc}"
                emit("error", message=reason)
                return self._finish(
                    f"任务无法继续，原因：{reason}",
                    "error",
                    emit,
                )

            self.messages.append(message)
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                answer = message.get("content")
                if not answer:
                    reason = "模型返回了空消息，无法继续执行。"
                    emit("error", message=reason)
                    return self._finish(
                        f"任务无法继续，原因：{reason}",
                        "error",
                        emit,
                    )
                if answer.strip().upper().startswith("UNSUPPORTED:"):
                    reason = answer.split(":", 1)[1].strip() or "现有工具无法解决此任务。"
                    emit("error", message=reason)
                    return self._finish(
                        f"任务已结束，现有工具无法完成。\n原因：{reason}",
                        "error",
                        emit,
                    )
                return self._finish(answer, "completed", emit)

            for tool_call in tool_calls:
                function = tool_call.get("function") or {}
                name = function.get("name", "")
                arguments_text = function.get("arguments") or "{}"
                arguments = {}
                emit("tool_start", name=name, arguments=arguments_text)

                try:
                    if not name:
                        raise ValueError("模型没有提供工具名称")
                    arguments = json.loads(arguments_text)
                    if not isinstance(arguments, dict):
                        raise ValueError("工具参数必须是 JSON 对象")
                    result = self.tools.call(name, arguments)
                except Exception as exc:
                    reason = f"工具 {name or '(unknown)'} 执行失败：{type(exc).__name__}: {exc}"
                    emit(
                        "tool_result",
                        name=name or "(unknown)",
                        arguments=arguments,
                        result=reason,
                        ok=False,
                    )
                    emit("error", message=reason)
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.get("id", "unknown"),
                            "content": reason,
                        }
                    )
                    return self._finish(
                        f"任务已结束，Agent 无法使用现有工具继续完成。\n原因：{reason}",
                        "error",
                        emit,
                    )

                emit(
                    "tool_result",
                    name=name,
                    arguments=arguments,
                    result=result,
                    ok=True,
                )
                print(f"[tool] {name}({json.dumps(arguments, ensure_ascii=False)})")
                print(result[:1000])
                self.messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.get("id", "unknown"),
                        "content": result,
                    }
                )
