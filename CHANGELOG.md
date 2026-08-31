# Changelog

## 2026-08-31

### Added

- Added multi-agent orchestration that lets the agent decide between a simple
  single-agent run and a three-agent workflow.
- Added requirements, implementation/debug/testing, and review agents for
  complex tasks.
- Added live frontend rendering for each sub-agent phase, model wait, tool call,
  tool result, cancellation, force-stop, and completion event.
- Added manual force-stop support to clear the current run, terminate active
  command subprocesses, and release the run lock.
- Added `/api/current-run`, `/api/cancel`, and `/api/force-stop` runtime APIs.
- Added startup recovery for unfinished historical runs.
- Added a PID-file based web startup guard so a new `main.py --web` instance can
  stop the previous local web process before binding the port.

### Changed

- Removed the fixed maximum step limit from the agent loop.
- Updated the agent to stop with a clear error when a task cannot continue with
  the available tools.
- Improved project and conversation isolation so histories stay separated by
  project and chat.
- Bound the frontend execute button to runtime state: it shows `执行中` while a
  task is running and returns to normal after completion, cancellation, or error.
- Updated the frontend to automatically clear stale runtime state and retry once
  when a new task hits `Another task is already running`.
- Made `run_command` cancellable and ensured active subprocesses can be killed
  during manual force-stop.
- Updated README feature documentation for force-stop, crash recovery, and
  multi-agent behavior.
