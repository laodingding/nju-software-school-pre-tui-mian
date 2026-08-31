import json
import threading
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
        return store, conversation_id, agent


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
                    store, conversation_id, _ = app.project_context(
                        project_name, conversation_id
                    )
                    return self._send_json(store.public_history(conversation_id))
                except (KeyError, ValueError) as exc:
                    return self._send_json({"error": str(exc)}, 400)
            return self._send_json({"error": "Not found"}, 404)

        def do_POST(self):
            path = urlparse(self.path).path
            if path not in {"/api/run", "/api/conversations"}:
                return self._send_json({"error": "Not found"}, 404)
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
                store, conversation_id, agent = app.project_context(
                    project_name, conversation_id
                )
                run_id = store.begin_run(
                    conversation_id, task, project=project_name
                )
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
                answer = agent.run(task, on_event=send_event)
                status = agent.last_status
                try:
                    store.save_messages(conversation_id, agent.messages)
                    store.finish_run(conversation_id, run_id, status, answer)
                except OSError as exc:
                    print(f"[history] final save skipped: {type(exc).__name__}: {exc}")
                send_event({"type": "done", "run_id": run_id, "status": status})
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
                app.run_lock.release()

    return Handler


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Run the Mini Coding Agent web UI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--workspace", default="workspace")
    args = parser.parse_args()

    app = App(workspace=args.workspace)
    try:
        server = ThreadingHTTPServer((args.host, args.port), make_handler(app))
    except OSError as exc:
        raise SystemExit(
            f"Cannot start web server: port {args.port} is already in use. "
            "Stop the existing main.py --web process or choose another port."
        ) from exc
    print(f"Mini Coding Agent UI: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
