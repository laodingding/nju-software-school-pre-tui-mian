from pathlib import Path


class ProjectManager:
    """Manage first-level project directories under workspace/."""

    IGNORED_DIRECTORIES = {
        "__pycache__",
        ".git",
        ".venv",
        "node_modules",
    }

    def __init__(self, workspace="workspace"):
        self.root = Path(workspace).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def list_projects(self):
        return sorted(
            [
                {
                    "name": item.name,
                    "path": item.name,
                }
                for item in self.root.iterdir()
                if item.is_dir()
                and not item.name.startswith(".")
                and item.name not in self.IGNORED_DIRECTORIES
            ],
            key=lambda item: item["name"].lower(),
        )

    def get_project(self, name):
        if not name or Path(name).name != name:
            raise ValueError("Invalid project name")
        project = (self.root / name).resolve()
        if project.parent != self.root or not project.is_dir():
            raise ValueError(f"Project not found: {name}")
        return project
