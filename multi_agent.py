import json
import re

from agent import CodingAgent, SYSTEM_PROMPT


REQUIREMENTS_PROMPT = """You are the requirements and design agent.
Your job is to understand the user's coding task, inspect the workspace when useful,
and write a concise development document before implementation.
Use tools only to inspect the project and to write documentation files.
Do not implement product code.
For Web UI work, include a short Playwright smoke-test plan with only the
critical path: start the app once, open the main page, perform one
representative interaction, and optionally inspect console/network state.
Use at most one screenshot when the layout changed. Do not plan exhaustive
coverage of every page or control. Skip Playwright for non-Web tasks.
If the task cannot be solved with the available tools, start your final reply with
"UNSUPPORTED:" and explain why.
"""


IMPLEMENTATION_PROMPT = """You are the implementation, debugging, and testing agent.
Your job is to implement the task based on the user request and the development
document. Read files, edit code, run commands, debug failures, and verify behavior.
For Web UI work, start the app once with run_command and use one Playwright
smoke flow: open the main page, verify the most important changed interaction,
and inspect console/network state only when needed. Capture at most one
screenshot if the UI layout changed. Do not repeat checks for unrelated pages
or controls. Skip Playwright for non-Web tasks.
If the task cannot be solved with the available tools, start your final reply with
"UNSUPPORTED:" and explain why.
"""


REVIEW_PROMPT = """You are the code review and requirements verification agent.
Inspect the implementation against the original user request and the development
document. Run tests when practical. Do not rewrite code unless the project cannot
be reviewed without a tiny fix.
For Web UI work, run only one focused acceptance smoke test for the changed
critical path. Do not repeat the implementation agent's full browser checks.
Inspect console/network state or capture one screenshot only when the change
requires it. Skip Playwright when the task does not affect a Web UI.
Return APPROVED: followed by a concise review summary when the work is acceptable.
Return CHANGES_REQUIRED: followed by concrete issues when the work is incomplete.
Return UNSUPPORTED: if the available tools cannot verify the work.
"""


class MultiAgentOrchestrator:
    """Decide whether to use one agent or a three-agent collaboration flow."""

    SIMPLE_HINTS = {
        "hello",
        "print",
        "readme",
        "single",
        "one file",
        "一个文件",
        "简单",
        "打印",
    }
    COMPLEX_HINTS = {
        "debug",
        "test",
        "tests",
        "refactor",
        "frontend",
        "backend",
        "database",
        "api",
        "多文件",
        "多个文件",
        "测试",
        "调试",
        "重构",
        "前端",
        "后端",
        "框架",
        "项目",
    }

    def __init__(self, client, tools, messages=None):
        self.client = client
        self.tools = tools
        self.messages = messages or [{"role": "system", "content": SYSTEM_PROMPT}]
        self.last_status = "idle"

    def run(self, task, on_event=None, should_cancel=None):
        def emit(event_type, **data):
            # Role agents already emit event dictionaries. Flatten those
            # callbacks instead of storing them as {"type": {...}}.
            if isinstance(event_type, dict):
                event = {**event_type, **data}
            else:
                event = {"type": event_type, **data}
            if on_event:
                on_event(event)

        def cancelled():
            return bool(should_cancel and should_cancel())

        emit("task", task=task)
        if cancelled():
            self.last_status = "cancelled"
            emit("cancelled", agent="orchestrator", message="Cancelled by user.")
            emit("assistant", agent="orchestrator", content="Task cancelled by user.")
            return "Task cancelled by user."

        emit("agent_phase", agent="orchestrator", title="Task routing")
        emit(
            "model_waiting",
            agent="orchestrator",
            message="Deciding whether multi-agent collaboration is needed...",
        )
        use_multi, reason = self._decide(task)
        emit(
            "agent_decision",
            mode="multi-agent" if use_multi else "single-agent",
            reason=reason,
        )

        if cancelled():
            self.last_status = "cancelled"
            emit("cancelled", agent="orchestrator", message="Cancelled by user.")
            emit("assistant", agent="orchestrator", content="Task cancelled by user.")
            return "Task cancelled by user."

        if not use_multi:
            agent = CodingAgent(
                self.client,
                self.tools,
                messages=self.messages,
                agent_name="coding-agent",
            )
            answer = agent.run(
                task,
                on_event=on_event,
                emit_task=False,
                should_cancel=should_cancel,
            )
            self.messages = agent.messages
            self.last_status = agent.last_status
            return answer

        self.messages.append({"role": "user", "content": task})
        answer = self._run_multi_agent(task, emit, should_cancel=should_cancel)
        self.messages.append({"role": "assistant", "content": answer})
        emit("assistant", agent="orchestrator", content=answer)
        return answer

    def _decide(self, task):
        fallback = self._heuristic_decision(task)
        prompt = (
            "Decide whether this coding task needs a three-agent workflow. "
            "Return only JSON like "
            '{"use_multi_agent": true, "reason": "short reason"}.'
        )
        try:
            message = self.client.chat(
                [
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": task},
                ],
                [],
            )
            content = (message.get("content") or "").strip()
            data = self._parse_decision_json(content)
            return bool(data["use_multi_agent"]), str(data.get("reason", ""))
        except Exception as exc:
            return fallback, f"Decision fallback used: {type(exc).__name__}: {exc}"

    def _parse_decision_json(self, content):
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", content, re.DOTALL)
            if not match:
                raise
            return json.loads(match.group(0))

    def _heuristic_decision(self, task):
        lower = task.lower()
        if any(hint in lower for hint in self.COMPLEX_HINTS):
            return True
        if len(task) > 80 and not any(hint in lower for hint in self.SIMPLE_HINTS):
            return True
        return False

    def _run_multi_agent(self, task, emit, should_cancel=None):
        def cancelled():
            return bool(should_cancel and should_cancel())

        if cancelled():
            self.last_status = "cancelled"
            emit("cancelled", agent="orchestrator", message="Cancelled by user.")
            return "Task cancelled by user."

        emit("agent_phase", agent="requirements-agent", title="Requirements and design")
        requirements = self._run_role_agent(
            agent_name="requirements-agent",
            system_prompt=REQUIREMENTS_PROMPT,
            task=(
                "Analyze this task and create .agent/requirements.md with: "
                "goals, constraints, implementation plan, files likely affected, "
                "and verification plan.\n\nTask:\n" + task
            ),
            emit=emit,
            should_cancel=should_cancel,
        )
        if self.last_status == "error":
            return requirements
        if self.last_status == "cancelled" or cancelled():
            self.last_status = "cancelled"
            return "Task cancelled by user."

        emit(
            "agent_handoff",
            from_agent="requirements-agent",
            to_agent="implementation-agent",
            title="需求分析完成，交接开发文档",
            content=requirements,
            artifact=".agent/requirements.md",
        )
        emit("agent_phase", agent="implementation-agent", title="Implementation and debug")
        implementation = self._run_role_agent(
            agent_name="implementation-agent",
            system_prompt=IMPLEMENTATION_PROMPT,
            task=(
                "Implement the task using the development document below. "
                "Run tests or commands to verify the result.\n\n"
                f"Original task:\n{task}\n\nDevelopment document:\n{requirements}"
            ),
            emit=emit,
            should_cancel=should_cancel,
        )
        if self.last_status == "error":
            return implementation
        if self.last_status == "cancelled" or cancelled():
            self.last_status = "cancelled"
            return "Task cancelled by user."

        emit(
            "agent_handoff",
            from_agent="implementation-agent",
            to_agent="review-agent",
            title="开发与测试完成，交接审查材料",
            content=implementation,
            artifact="已修改的项目文件和测试结果",
        )
        emit("agent_phase", agent="review-agent", title="Review and acceptance")
        review = self._run_role_agent(
            agent_name="review-agent",
            system_prompt=REVIEW_PROMPT,
            task=(
                "Review the finished work against the request and development "
                "document. Run verification commands when useful.\n\n"
                f"Original task:\n{task}\n\nDevelopment document:\n{requirements}\n\n"
                f"Implementation summary:\n{implementation}"
            ),
            emit=emit,
            should_cancel=should_cancel,
        )
        if self.last_status == "error":
            return review
        if self.last_status == "cancelled" or cancelled():
            self.last_status = "cancelled"
            return "Task cancelled by user."

        if review.strip().upper().startswith("CHANGES_REQUIRED:"):
            emit(
                "agent_handoff",
                from_agent="review-agent",
                to_agent="implementation-agent",
                title="审查发现问题，交接修复清单",
                content=review,
                artifact="审查问题和待修复项",
            )
            emit(
                "agent_phase",
                agent="implementation-agent",
                title="Revision from review feedback",
            )
            implementation = self._run_role_agent(
                agent_name="implementation-agent",
                system_prompt=IMPLEMENTATION_PROMPT,
                task=(
                    "Fix the review findings below, then run verification again.\n\n"
                    f"Original task:\n{task}\n\nDevelopment document:\n{requirements}\n\n"
                    f"Previous implementation summary:\n{implementation}\n\n"
                    f"Review feedback:\n{review}"
                ),
                emit=emit,
                should_cancel=should_cancel,
            )
            if self.last_status == "error":
                return implementation
            if self.last_status == "cancelled" or cancelled():
                self.last_status = "cancelled"
                return "Task cancelled by user."

            emit(
                "agent_handoff",
                from_agent="implementation-agent",
                to_agent="review-agent",
                title="根据审查意见修复完成，重新交接验收",
                content=implementation,
                artifact="修复后的项目文件和复测结果",
            )
            emit("agent_phase", agent="review-agent", title="Final review")
            review = self._run_role_agent(
                agent_name="review-agent",
                system_prompt=REVIEW_PROMPT,
                task=(
                    "Review the revised work. Return APPROVED or CHANGES_REQUIRED.\n\n"
                    f"Original task:\n{task}\n\nDevelopment document:\n{requirements}\n\n"
                    f"Revision summary:\n{implementation}"
                ),
                emit=emit,
                should_cancel=should_cancel,
            )
            if self.last_status == "error":
                return review
            if self.last_status == "cancelled" or cancelled():
                self.last_status = "cancelled"
                return "Task cancelled by user."

        emit(
            "agent_handoff",
            from_agent="review-agent",
            to_agent="orchestrator",
            title="代码审查完成，交接最终验收结论",
            content=review,
            artifact="审查结论和需求验收结果",
        )
        if review.strip().upper().startswith("CHANGES_REQUIRED:"):
            self.last_status = "error"
            emit("error", agent="orchestrator", message=review)
            return (
                "Multi-agent workflow finished with unresolved review findings.\n\n"
                f"{review}"
            )

        self.last_status = "completed"
        return (
            "Multi-agent workflow completed.\n\n"
            "Requirements agent:\n"
            f"{requirements}\n\n"
            "Implementation agent:\n"
            f"{implementation}\n\n"
            "Review agent:\n"
            f"{review}"
        )

    def _run_role_agent(self, agent_name, system_prompt, task, emit, should_cancel=None):
        agent = CodingAgent(
            self.client,
            self.tools,
            system_prompt=system_prompt,
            agent_name=agent_name,
        )
        answer = agent.run(
            task,
            on_event=emit,
            emit_task=False,
            should_cancel=should_cancel,
        )
        self.last_status = agent.last_status
        return answer
