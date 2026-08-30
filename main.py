import argparse
from agent import CodingAgent
from llm import LLMClient
from tools import WorkspaceTools


def build_parser():
    parser = argparse.ArgumentParser(description="A minimal coding agent.")
    parser.add_argument(
        "task",
        nargs="*",
        help="The programming task. Omit it to enter interactive mode.",
    )
    parser.add_argument(
        "--workspace",
        default="workspace",
        help="Directory that the agent is allowed to edit.",
    )
    parser.add_argument(
        "--web",
        action="store_true",
        help="Start the browser-based chat interface.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    return parser


def main():
    args = build_parser().parse_args()
    task = " ".join(args.task).strip()

    if args.web:
        from web_app import main as web_main

        web_main_args = ["--host", args.host, "--port", str(args.port)]
        if args.workspace:
            web_main_args.extend(["--workspace", args.workspace])
        import sys

        old_argv = sys.argv
        sys.argv = [old_argv[0], *web_main_args]
        try:
            web_main()
        finally:
            sys.argv = old_argv
        return

    tools = WorkspaceTools(args.workspace)
    client = LLMClient()
    agent = CodingAgent(client=client, tools=tools)

    if task:
        agent.run(task)
        return

    print("Mini Coding Agent")
    print("Type a task, or type 'exit' to quit.")
    while True:
        try:
            task = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if task.lower() in {"exit", "quit"}:
            break
        if task:
            agent.run(task)


if __name__ == "__main__":
    main()
