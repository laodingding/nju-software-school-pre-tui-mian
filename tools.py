import os
import subprocess
import time
import threading
from pathlib import Path


class ToolCancelled(Exception):
    pass


class WorkspaceTools:
    """Local tools restricted to one workspace directory."""

    def __init__(self, workspace):
        self.root = Path(workspace).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._process_lock = threading.Lock()
        self._active_processes = set()

    def _safe_path(self, path):
        candidate = (self.root / path).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise ValueError(f"Path is outside workspace: {path}")
        return candidate

    def list_files(self, path="."):
        directory = self._safe_path(path)
        if not directory.is_dir():
            raise ValueError(f"Not a directory: {path}")
        entries = []
        for item in sorted(directory.iterdir(), key=lambda item: item.name.lower()):
            kind = "DIR " if item.is_dir() else "FILE"
            relative = item.relative_to(self.root)
            entries.append(f"{kind} {relative}")
        return "\n".join(entries) or "(empty directory)"

    def read_file(self, path):
        file_path = self._safe_path(path)
        if not file_path.is_file():
            raise ValueError(f"Not a file: {path}")
        return file_path.read_text(encoding="utf-8")

    def write_file(self, path, content):
        file_path = self._safe_path(path)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
        return f"Wrote {file_path.relative_to(self.root)} ({len(content)} characters)."

    def _register_process(self, process):
        with self._process_lock:
            self._active_processes.add(process)

    def _unregister_process(self, process):
        with self._process_lock:
            self._active_processes.discard(process)

    def _terminate_process(self, process):
        if process.poll() is not None:
            return
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
            else:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    def terminate_active_processes(self):
        with self._process_lock:
            active = list(self._active_processes)
        for process in active:
            self._terminate_process(process)

    def run_command(self, command, should_cancel=None):
        process = subprocess.Popen(
            command,
            cwd=self.root,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self._register_process(process)
        timeout_seconds = 30
        deadline = time.monotonic() + timeout_seconds
        try:
            while True:
                if should_cancel and should_cancel():
                    self._terminate_process(process)
                    raise ToolCancelled("Command cancelled by user.")

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._terminate_process(process)
                    stdout, stderr = process.communicate()
                    output = (stdout + stderr).strip()
                    if len(output) > 12000:
                        output = output[:12000] + "\n...[output truncated]"
                    return (
                        "exit_code=124\n"
                        f"{output or '(command timed out after 30 seconds)'}"
                    )

                try:
                    stdout, stderr = process.communicate(timeout=min(0.2, remaining))
                    output = (stdout + stderr).strip()
                    if len(output) > 12000:
                        output = output[:12000] + "\n...[output truncated]"
                    return f"exit_code={process.returncode}\n{output or '(no output)'}"
                except subprocess.TimeoutExpired:
                    continue
        finally:
            self._unregister_process(process)
            if process.poll() is None:
                self._terminate_process(process)

    def definitions(self):
        return [
            {
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "List files and directories inside the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string", "default": "."}},
                        "required": [],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a UTF-8 text file inside the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Create or overwrite a UTF-8 text file inside the workspace.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "content": {"type": "string"},
                        },
                        "required": ["path", "content"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "run_command",
                    "description": "Run a shell command from the workspace. Use it for tests.",
                    "parameters": {
                        "type": "object",
                        "properties": {"command": {"type": "string"}},
                        "required": ["command"],
                    },
                },
            },
        ]

    def call(self, name, arguments, should_cancel=None):
        if name == "list_files":
            return self.list_files(arguments.get("path", "."))
        if name == "read_file":
            return self.read_file(arguments["path"])
        if name == "write_file":
            return self.write_file(arguments["path"], arguments["content"])
        if name == "run_command":
            return self.run_command(
                arguments["command"],
                should_cancel=should_cancel,
            )
        raise ValueError(f"Unknown tool: {name}")
