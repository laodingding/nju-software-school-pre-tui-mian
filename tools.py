import os
import locale
import shlex
import shutil
import subprocess
import tempfile
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

    def _decode_stream(self, data):
        if not data:
            return ""
        encodings = ["utf-8", locale.getpreferredencoding(False), "gbk"]
        best = ""
        best_score = None
        for encoding in dict.fromkeys(encodings):
            try:
                return data.decode(encoding)
            except UnicodeDecodeError:
                decoded = data.decode(encoding, errors="replace")
                score = decoded.count("\ufffd")
                if best_score is None or score < best_score:
                    best = decoded
                    best_score = score
        return best

    def _read_output_files(self, stdout_file, stderr_file):
        output_parts = []
        for stream in (stdout_file, stderr_file):
            stream.flush()
            stream.seek(0)
            output_parts.append(self._decode_stream(stream.read()))
        return "".join(output_parts).strip()

    def _format_output(self, stdout, stderr, output_files=None):
        if output_files:
            return self._read_output_files(*output_files)
        return (
            self._decode_stream(stdout) + self._decode_stream(stderr)
        ).strip()

    def _collect_process_output(
        self,
        process,
        timeout_seconds,
        should_cancel=None,
        output_files=None,
    ):
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
                    output = self._format_output(stdout, stderr, output_files)
                    if len(output) > 12000:
                        output = output[:12000] + "\n...[output truncated]"
                    return (
                        "exit_code=124\n"
                        f"{output or f'(command timed out after {timeout_seconds} seconds)'}"
                    )

                try:
                    stdout, stderr = process.communicate(timeout=min(0.2, remaining))
                    output = self._format_output(stdout, stderr, output_files)
                    if len(output) > 12000:
                        output = output[:12000] + "\n...[output truncated]"
                    return f"exit_code={process.returncode}\n{output or '(no output)'}"
                except subprocess.TimeoutExpired:
                    continue
        finally:
            self._unregister_process(process)
            if process.poll() is None:
                self._terminate_process(process)

    def run_command(self, command, should_cancel=None):
        with tempfile.TemporaryFile(mode="w+b") as stdout_file:
            with tempfile.TemporaryFile(mode="w+b") as stderr_file:
                process = subprocess.Popen(
                    command,
                    cwd=self.root,
                    shell=True,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    stdin=subprocess.DEVNULL,
                    text=False,
                )
                self._register_process(process)
                return self._collect_process_output(
                    process,
                    timeout_seconds=30,
                    should_cancel=should_cancel,
                    output_files=(stdout_file, stderr_file),
                )

    def run_playwright_cli(self, command, args=None, session="default", should_cancel=None):
        """Run the Playwright agent CLI through npm without requiring global install."""
        if not command or not isinstance(command, str):
            raise ValueError("Playwright command is required.")
        if args is None:
            args = []
        if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
            raise ValueError("Playwright args must be a list of strings.")
        if not session or not isinstance(session, str):
            raise ValueError("Playwright session must be a non-empty string.")

        cli_args = [
            shutil.which("npm.cmd" if os.name == "nt" else "npm") or "npm",
            "exec",
            "--yes",
            "@playwright/cli@latest",
            "--",
            f"-s={session}",
            command,
            *args,
        ]
        with tempfile.TemporaryFile(mode="w+b") as stdout_file:
            with tempfile.TemporaryFile(mode="w+b") as stderr_file:
                process = subprocess.Popen(
                    cli_args,
                    cwd=self.root,
                    shell=False,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    stdin=subprocess.DEVNULL,
                    text=False,
                )
                self._register_process(process)
                rendered = " ".join(shlex.quote(part) for part in cli_args)
                output = self._collect_process_output(
                    process,
                    timeout_seconds=60,
                    should_cancel=should_cancel,
                    output_files=(stdout_file, stderr_file),
                )
                return f"command={rendered}\n{output}"

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
            {
                "type": "function",
                "function": {
                    "name": "run_playwright_cli",
                    "description": (
                        "Run the Playwright CLI for browser automation and UI "
                        "self-tests. Use it after starting a local web server. "
                        "Typical commands: install-browser, open, goto, snapshot, "
                        "find, click, fill, type, press, screenshot, console, "
                        "requests, run-code, close, close-all, kill-all."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": {
                                "type": "string",
                                "description": "Playwright CLI command, e.g. open, click, fill, screenshot.",
                            },
                            "args": {
                                "type": "array",
                                "items": {"type": "string"},
                                "default": [],
                                "description": "Command arguments in order.",
                            },
                            "session": {
                                "type": "string",
                                "default": "default",
                                "description": "Browser session name reused across CLI calls.",
                            },
                        },
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
        if name == "run_playwright_cli":
            return self.run_playwright_cli(
                arguments["command"],
                args=arguments.get("args", []),
                session=arguments.get("session", "default"),
                should_cancel=should_cancel,
            )
        raise ValueError(f"Unknown tool: {name}")
