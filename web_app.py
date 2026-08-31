import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from history import SessionStore
from llm import LLMClient
from multi_agent import MultiAgentOrchestrator
from projects import ProjectManager
from tools import WorkspaceTools


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"


class App:
    def __init__(self, workspace="workspace"):
        self.project_manager = ProjectManager(workspace)
        self.client = LLMClient()
        self.run_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.current_run = None
        self.recover_incomplete_runs()

    def recover_incomplete_runs(self):
        data_dir = Path("data/projects")
        if not data_dir.is_dir():
            return
        for history_file in data_dir.glob("*.json"):
            try:
                SessionStore(history_file).recover_incomplete_runs()
            except OSError as exc:
                print(f"[history] recovery skipped: {type(exc).__name__}: {exc}")

    def project_context(self, project_name, conversation_id=None):
        project_path = self.project_manager.get_project(project_name)
        store = SessionStore(f"data/projects/{project_name}.json")
        if conversation_id is None:
            conversation_id = store.create_conversation()
        else:
            store.get_conversation(conversation_id)
        tools = WorkspaceTools(project_path)
        agent = MultiAgentOrchestrator(
            client=self.client,
            tools=tools,
            messages=store.get_messages(conversation_id),
        )
        return store, conversation_id, tools, agent

    def clear_current_run(self, run_id=None):
        with self.state_lock:
            if run_id and (
                not self.current_run
                or self.current_run.get("run_id") != run_id
            ):
                return None
            current = self.current_run
            self.current_run = None
        return current

    def current_run_snapshot(self):
        with self.state_lock:
            if not self.current_run:
                return None
            snapshot = dict(self.current_run)
            snapshot.pop("cancel_event", None)
            snapshot.pop("store", None)
            snapshot.pop("tools", None)
            return snapshot


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MiniCodingAgent/1.0"

        def log_message(self, format_string, *args):
            print(f"[web] {self.address_string()} - {format_string % args}")

        def _send_json(self, payload, status=200):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_file(self, path, content_type):
            if not path.is_file():
                return self._send_json({"error": "Frontend file not found"}, 500)
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", f"{content_type}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/":
                return self._send_file(WEB_ROOT / "index.html", "text/html")
            if path == "/app.css":
                return self._send_file(WEB_ROOT / "app.css", "text/css")
            if path == "/app.js":
                return self._send_file(WEB_ROOT / "app.js", "application/javascript")
            if path == "/api/projects":
                return self._send_json(
                    {"projects": app.project_manager.list_projects()}
                )
            if path == "/api/current-run":
                return self._send_json({"current_run": app.current_run_snapshot()})
            if path == "/api/conversations":
                project_name = parse_qs(parsed.query).get("project", [""])[0]
                try:
                    app.project_manager.get_project(project_name)
                    store = SessionStore(f"data/projects/{project_name}.json")
                    return self._send_json(
                        {
                            "project": project_name,
                            "conversations": store.list_conversations(),
                        }
                    )
                except ValueError as exc:
                    return self._send_json({"error": str(exc)}, 400)
            if path == "/api/history":
                query = parse_qs(parsed.query)
                project_name = query.get("project", [""])[0]
                conversation_id = query.get("conversation_id", [""])[0]
                try:
                    store, conversation_id, _, _ = app.project_context(
                        project_name, conversation_id
                    )
                    return self._send_json(store.public_history(conversation_id))
                except (KeyError, ValueError) as exc:
                    return self._send_json({"error": str(exc)}, 400)
            return self._send_json({"error": "Not found"}, 404)

        def do_POST(self):
            path = urlparse(self.path).path
            if path not in {
                "/api/run",
                "/api/conversations",
                "/api/cancel",
                "/api/force-stop",
            }:
                return self._send_json({"error": "Not found"}, 404)
            if path == "/api/cancel":
                return self._cancel_task()
            if path == "/api/force-stop":
                return self._force_stop()
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                project_name = str(payload.get("project", "")).strip()
                if not project_name:
                    return self._send_json({"error": "Project is required"}, 400)
            except (ValueError, json.JSONDecodeError):
                return self._send_json({"error": "Invalid JSON request"}, 400)

            if path == "/api/conversations":
                return self._create_conversation(project_name, payload)
            return self._run_task(project_name, payload)

        def _cancel_task(self):
            with app.state_lock:
                current = app.current_run
                if not current:
                    return self._send_json({"error": "No task is running"}, 404)
                current["cancel_event"].set()
                return self._send_json(
                    {
                        "status": "cancel_requested",
                        "run_id": current["run_id"],
                        "conversation_id": current["conversation_id"],
                    }
                )

        def _force_stop(self):
            current = app.clear_current_run()
            if not current:
                if app.run_lock.locked():
                    try:
                        app.run_lock.release()
                    except RuntimeError:
                        pass
                    return self._send_json({"status": "stale_lock_cleared"})
                return self._send_json({"status": "no_task_running"})

            current["cancel_event"].set()
            tools = current.get("tools")
            if tools:
                tools.terminate_active_processes()

            try:
                current["store"].interrupt_run(
                    current["conversation_id"],
                    current["run_id"],
                    "Task was force-stopped by user.",
                )
                current["store"].add_event(
                    current["conversation_id"],
                    current["run_id"],
                    {
                        "type": "force_stopped",
                        "message": "Task was force-stopped by user.",
                    },
                )
            except (KeyError, OSError) as exc:
                print(f"[history] force-stop save skipped: {type(exc).__name__}: {exc}")

            try:
                app.run_lock.release()
            except RuntimeError:
                pass

            return self._send_json(
                {
                    "status": "force_stopped",
                    "run_id": current["run_id"],
                    "conversation_id": current["conversation_id"],
                    "project": current["project"],
                }
            )

        def _create_conversation(self, project_name, payload):
            title = str(payload.get("title", "")).strip() or "New conversation"
            try:
                app.project_manager.get_project(project_name)
                store = SessionStore(f"data/projects/{project_name}.json")
                conversation_id = store.create_conversation(title)
                return self._send_json(
                    {
                        "project": project_name,
                        "conversation_id": conversation_id,
                        "title": title,
                    }
                )
            except ValueError as exc:
                return self._send_json({"error": str(exc)}, 400)

        def _run_task(self, project_name, payload):
            task = str(payload.get("task", "")).strip()
            conversation_id = str(payload.get("conversation_id", "")).strip()
            if not task:
                return self._send_json({"error": "Task cannot be empty"}, 400)
            if not conversation_id:
                return self._send_json({"error": "Conversation is required"}, 400)

            if not app.run_lock.acquire(blocking=False):
                return self._send_json({"error": "Another task is already running"}, 409)

            try:
                store, conversation_id, tools, agent = app.project_context(
                    project_name, conversation_id
                )
                run_id = store.begin_run(
                    conversation_id, task, project=project_name
                )
                cancel_event = threading.Event()
                with app.state_lock:
                    app.current_run = {
                        "project": project_name,
                        "conversation_id": conversation_id,
                        "run_id": run_id,
                        "task": task,
                        "cancel_event": cancel_event,
                        "store": store,
                        "tools": tools,
                    }
            except (KeyError, OSError, ValueError) as exc:
                app.run_lock.release()
                return self._send_json({"error": str(exc)}, 400)

            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                stream_open = True

                def send_event(event):
                    nonlocal stream_open
                    with app.state_lock:
                        current = app.current_run
                        active = bool(
                            current
                            and current.get("run_id") == run_id
                        )
                    if not active:
                        return
                    try:
                        store.add_event(conversation_id, run_id, event)
                        store.save_messages(conversation_id, agent.messages)
                    except OSError as exc:
                        print(
                            f"[history] save skipped: {type(exc).__name__}: {exc}"
                        )
                    if not stream_open:
                        return
                    try:
                        data = json.dumps(event, ensure_ascii=False)
                        self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        stream_open = False

                send_event(
                    {
                        "type": "run_started",
                        "run_id": run_id,
                        "task": task,
                        "project": project_name,
                        "conversation_id": conversation_id,
                    }
                )
                answer = agent.run(
                    task,
                    on_event=send_event,
                    should_cancel=cancel_event.is_set,
                )
                status = agent.last_status
                with app.state_lock:
                    current = app.current_run
                    active = bool(
                        current
                        and current.get("run_id") == run_id
                    )
                if active:
                    try:
                        store.save_messages(conversation_id, agent.messages)
                        final_status = store.finish_run(
                            conversation_id, run_id, status, answer
                        )
                    except OSError as exc:
                        print(
                            f"[history] final save skipped: "
                            f"{type(exc).__name__}: {exc}"
                        )
                        final_status = status
                    send_event(
                        {"type": "done", "run_id": run_id, "status": final_status}
                    )
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                try:
                    store.finish_run(conversation_id, run_id, "error", error)
                except OSError as save_exc:
                    print(
                        f"[history] error save skipped: "
                        f"{type(save_exc).__name__}: {save_exc}"
                    )
                if "send_event" in locals():
                    send_event({"type": "error", "message": error})
                    send_event(
                        {"type": "done", "run_id": run_id, "status": "error"}
                    )
                else:
                    self._send_json({"error": error}, 500)
            finally:
                current = app.clear_current_run(run_id)
                if current and not current.get("force_stopped"):
                    try:
                        app.run_lock.release()
                    except RuntimeError:
                        pass

    return Handler


def runtime_pid_file(host, port):
    runtime_dir = ROOT / "data" / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    safe_host = str(host).replace(":", "_").replace("/", "_")
    return runtime_dir / f"web_{safe_host}_{port}.pid"


def kill_previous_web_process(pid_file):
    if os.name != "nt" or not pid_file.is_file():
        return
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return
    if pid == os.getpid():
        return

    probe = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            (
                f'$process = Get-CimInstance Win32_Process -Filter "ProcessId = {pid}"; '
                "if ($process) { $process.CommandLine }"
            ),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if "main.py --web" not in (probe.stdout or ""):
        return

    subprocess.run(
        ["taskkill", "/PID", str(pid), "/T", "/F"],
        check=False,
        capture_output=True,
        text=True,
    )


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Run the Mini Coding Agent web UI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--workspace", default="workspace")
    args = parser.parse_args()

    pid_file = runtime_pid_file(args.host, args.port)
    kill_previous_web_process(pid_file)
    time.sleep(0.2)
    app = App(workspace=args.workspace)
    try:
        server = ThreadingHTTPServer((args.host, args.port), make_handler(app))
    except OSError as exc:
        kill_previous_web_process(pid_file)
        time.sleep(0.2)
        try:
            server = ThreadingHTTPServer((args.host, args.port), make_handler(app))
        except OSError as retry_exc:
            raise SystemExit(
                f"Cannot start web server: port {args.port} is already in use. "
                "Stop the existing main.py --web process or choose another port."
            ) from retry_exc
    try:
        pid_file.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass
    print(f"Mini Coding Agent UI: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()
        try:
            pid_file.unlink()
        except OSError:
            pass


if __name__ == "__main__":
    main()
