import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class SessionStore:
    """Persist independent conversations and their visible execution runs."""

    def __init__(self, path="data/session.json"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.state = self._load()

    def _load(self):
        if not self.path.is_file():
            return {"conversations": {}}
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"conversations": {}}
        if not isinstance(state, dict):
            return {"conversations": {}}

        if "conversations" in state:
            conversations = state["conversations"]
            if isinstance(conversations, list):
                conversations = {
                    item["id"]: item
                    for item in conversations
                    if isinstance(item, dict) and item.get("id")
                }
            state["conversations"] = conversations if isinstance(conversations, dict) else {}
            return state

        messages = state.get("messages", [])
        runs = state.get("runs", [])
        conversation_id = "legacy-" + uuid.uuid4().hex
        return {
            "conversations": {
                conversation_id: {
                    "id": conversation_id,
                    "title": "Legacy conversation",
                    "created_at": now_iso(),
                    "updated_at": now_iso(),
                    "messages": messages if isinstance(messages, list) else [],
                    "runs": runs if isinstance(runs, list) else [],
                }
            }
        }

    def _save(self):
        content = json.dumps(self.state, ensure_ascii=False, indent=2)
        last_error = None
        for attempt in range(5):
            temporary = self.path.with_name(
                f".{self.path.name}.{uuid.uuid4().hex}.tmp"
            )
            try:
                with temporary.open("w", encoding="utf-8") as file:
                    file.write(content)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(temporary, self.path)
                return
            except PermissionError as exc:
                last_error = exc
                time.sleep(0.1 * (attempt + 1))
            finally:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass

        try:
            self.path.write_text(content, encoding="utf-8")
        except OSError as exc:
            raise PermissionError(
                f"Cannot save session history to {self.path}: {exc}"
            ) from (last_error or exc)

    def _conversations(self):
        return self.state.setdefault("conversations", {})

    def create_conversation(self, title="New conversation"):
        with self.lock:
            conversation_id = uuid.uuid4().hex
            timestamp = now_iso()
            self._conversations()[conversation_id] = {
                "id": conversation_id,
                "title": title or "New conversation",
                "created_at": timestamp,
                "updated_at": timestamp,
                "messages": [],
                "runs": [],
            }
            self._save()
            return conversation_id

    def get_conversation(self, conversation_id):
        with self.lock:
            conversation = self._conversations().get(conversation_id)
            if not conversation:
                raise KeyError(f"Unknown conversation: {conversation_id}")
            return conversation

    def list_conversations(self):
        with self.lock:
            conversations = []
            for conversation in self._conversations().values():
                runs = conversation.get("runs", [])
                conversations.append(
                    {
                        "id": conversation["id"],
                        "title": conversation.get("title") or "New conversation",
                        "created_at": conversation.get("created_at"),
                        "updated_at": conversation.get("updated_at"),
                        "run_count": len(runs),
                        "last_task": runs[-1].get("task") if runs else "",
                    }
                )
            return sorted(
                conversations,
                key=lambda item: item.get("updated_at") or "",
                reverse=True,
            )

    def recover_incomplete_runs(self):
        """Mark tasks left running by a crashed server as interrupted."""
        with self.lock:
            changed = False
            for conversation in self._conversations().values():
                conversation_changed = False
                for run in conversation.get("runs", []):
                    if run.get("status") == "running":
                        run["status"] = "interrupted"
                        run["answer"] = (
                            "Task was interrupted because the service restarted."
                        )
                        run["finished_at"] = now_iso()
                        run.setdefault("events", []).append(
                            {
                                "type": "error",
                                "message": (
                                    "Service restarted; the previous unfinished "
                                    "task was marked as interrupted."
                                ),
                            }
                        )
                        changed = True
                        conversation_changed = True
                if conversation_changed:
                    conversation["updated_at"] = now_iso()
            if changed:
                self._save()
            return changed

    def get_messages(self, conversation_id):
        with self.lock:
            return list(self.get_conversation(conversation_id).get("messages", []))

    def save_messages(self, conversation_id, messages):
        with self.lock:
            conversation = self.get_conversation(conversation_id)
            conversation["messages"] = messages
            conversation["updated_at"] = now_iso()
            self._save()

    def begin_run(self, conversation_id, task, project=None):
        with self.lock:
            conversation = self.get_conversation(conversation_id)
            run = {
                "id": uuid.uuid4().hex,
                "task": task,
                "project": project,
                "status": "running",
                "created_at": now_iso(),
                "events": [],
            }
            conversation.setdefault("runs", []).append(run)
            if (
                not conversation.get("title")
                or conversation["title"] == "New conversation"
            ):
                conversation["title"] = task[:40]
            conversation["updated_at"] = now_iso()
            self._save()
            return run["id"]

    def add_event(self, conversation_id, run_id, event):
        with self.lock:
            conversation = self.get_conversation(conversation_id)
            run = self._find_run(conversation, run_id)
            run["events"].append(event)
            conversation["updated_at"] = now_iso()
            self._save()

    def finish_run(self, conversation_id, run_id, status, answer):
        with self.lock:
            conversation = self.get_conversation(conversation_id)
            run = self._find_run(conversation, run_id)
            if run.get("status") != "running":
                return run.get("status")
            run["status"] = status
            run["answer"] = answer
            run["finished_at"] = now_iso()
            conversation["updated_at"] = now_iso()
            self._save()
            return status

    def interrupt_run(self, conversation_id, run_id, answer):
        with self.lock:
            conversation = self.get_conversation(conversation_id)
            run = self._find_run(conversation, run_id)
            if run.get("status") != "running":
                return run.get("status")
            run["status"] = "interrupted"
            run["answer"] = answer
            run["finished_at"] = now_iso()
            conversation["updated_at"] = now_iso()
            self._save()
            return "interrupted"

    def public_history(self, conversation_id):
        with self.lock:
            conversation = self.get_conversation(conversation_id)
            return {
                "conversation_id": conversation_id,
                "runs": conversation.get("runs", []),
            }

    @staticmethod
    def _find_run(conversation, run_id):
        for run in conversation.get("runs", []):
            if run["id"] == run_id:
                return run
        raise KeyError(f"Unknown run: {run_id}")
