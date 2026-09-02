import json

from tools import ToolCancelled


SYSTEM_PROMPT = """You are a careful coding agent.
You work only inside the provided workspace.
Complete the user's programming task by inspecting files, editing files, and running tests.
Use tools whenever you need to inspect or change the workspace.
When you build or change a Web UI, start the local app and use run_playwright_cli
to open the page, interact with it, inspect snapshots/console/network state, and
capture screenshots when useful.
If the available tools cannot solve the task, explain the limitation clearly and stop.
When the task cannot be completed with the available tools, start your final reply
with "UNSUPPORTED:" followed by the concrete reason.
Do not claim a task is complete until you have verified it when practical.
When finished, briefly summarize what changed and what you tested.
"""


class CodingAgent:
    def __init__(self, client, tools, messages=None, system_prompt=None, agent_name=None):
        self.client = client
        self.tools = tools
        self.agent_name = agent_name or "coding-agent"
        self.messages = messages or [
            {"role": "system", "content": system_prompt or SYSTEM_PROMPT}
        ]
        self.last_status = "idle"

    def _finish(self, answer, status, emit):
        self.last_status = status
        emit("assistant", agent=self.agent_name, content=answer)
        return answer

    def run(self, task, on_event=None, emit_task=True, should_cancel=None):
        def emit(event_type, **data):
            event = {"type": event_type, **data}
            if on_event:
                on_event(event)

        def cancelled():
            return bool(should_cancel and should_cancel())

        self.last_status = "running"
        self.messages.append({"role": "user", "content": task})
        if emit_task:
            emit("task", task=task)
        print(f"\nTask: {task}")
        step = 0

        while True:
            if cancelled():
                emit("cancelled", agent=self.agent_name, message="Cancelled by user.")
                return self._finish("Task cancelled by user.", "cancelled", emit)

            step += 1
            emit("step", agent=self.agent_name, step=step)
            emit(
                "model_waiting",
                agent=self.agent_name,
                message="Waiting for model response...",
            )
            print(f"\n[{self.agent_name} step {step}] thinking...")
            try:
                message = self.client.chat(self.messages, self.tools.definitions())
            except Exception as exc:
                reason = f"{type(exc).__name__}: {exc}"
                emit("error", agent=self.agent_name, message=reason)
                return self._finish(
                    f"Task cannot continue. Reason: {reason}",
                    "error",
                    emit,
                )

            if cancelled():
                emit("cancelled", agent=self.agent_name, message="Cancelled by user.")
                return self._finish("Task cancelled by user.", "cancelled", emit)

            self.messages.append(message)
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                answer = message.get("content")
                if not answer:
                    reason = "The model returned an empty message."
                    emit("error", agent=self.agent_name, message=reason)
                    return self._finish(
                        f"Task cannot continue. Reason: {reason}",
                        "error",
                        emit,
                    )
                if answer.strip().upper().startswith("UNSUPPORTED:"):
                    reason = answer.split(":", 1)[1].strip() or (
                        "The available tools cannot solve this task."
                    )
                    emit("error", agent=self.agent_name, message=reason)
                    return self._finish(
                        "Task ended because the available tools cannot complete it.\n"
                        f"Reason: {reason}",
                        "error",
                        emit,
                    )
                return self._finish(answer, "completed", emit)

            for tool_call in tool_calls:
                if cancelled():
                    emit("cancelled", agent=self.agent_name, message="Cancelled by user.")
                    return self._finish("Task cancelled by user.", "cancelled", emit)

                function = tool_call.get("function") or {}
                name = function.get("name", "")
                arguments_text = function.get("arguments") or "{}"
                arguments = {}
                emit(
                    "tool_start",
                    agent=self.agent_name,
                    name=name,
                    arguments=arguments_text,
                )

                try:
                    if not name:
                        raise ValueError("The model did not provide a tool name.")
                    arguments = json.loads(arguments_text)
                    if not isinstance(arguments, dict):
                        raise ValueError("Tool arguments must be a JSON object.")
                    result = self.tools.call(
                        name,
                        arguments,
                        should_cancel=should_cancel,
                    )
                except ToolCancelled:
                    emit("cancelled", agent=self.agent_name, message="Cancelled by user.")
                    return self._finish("Task cancelled by user.", "cancelled", emit)
                except Exception as exc:
                    reason = (
                        f"Tool {name or '(unknown)'} failed: "
                        f"{type(exc).__name__}: {exc}"
                    )
                    emit(
                        "tool_result",
                        agent=self.agent_name,
                        name=name or "(unknown)",
                        arguments=arguments,
                        result=reason,
                        ok=False,
                    )
                    emit("error", agent=self.agent_name, message=reason)
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.get("id", "unknown"),
                            "content": reason,
                        }
                    )
                    return self._finish(
                        "Task ended because the agent cannot continue with the "
                        f"available tools.\nReason: {reason}",
                        "error",
                        emit,
                    )

                emit(
                    "tool_result",
                    agent=self.agent_name,
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
