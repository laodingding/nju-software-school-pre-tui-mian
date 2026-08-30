import os
import subprocess
from pathlib import Path


class WorkspaceTools:
    """Local tools restricted to one workspace directory."""

    def __init__(self, workspace):
        self.root = Path(workspace).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

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

    def run_command(self, command):
        completed = subprocess.run(
            command,
            cwd=self.root,
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        output = (completed.stdout + completed.stderr).strip()
        if len(output) > 12000:
            output = output[:12000] + "\n...[output truncated]"
        return f"exit_code={completed.returncode}\n{output or '(no output)'}"

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

    def call(self, name, arguments):
        if name == "list_files":
            return self.list_files(arguments.get("path", "."))
        if name == "read_file":
            return self.read_file(arguments["path"])
        if name == "write_file":
            return self.write_file(arguments["path"], arguments["content"])
        if name == "run_command":
            return self.run_command(arguments["command"])
        raise ValueError(f"Unknown tool: {name}")
