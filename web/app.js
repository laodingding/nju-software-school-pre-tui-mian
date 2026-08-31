const conversation = document.querySelector("#conversation");
const emptyState = document.querySelector("#emptyState");
const historyList = document.querySelector("#historyList");
const historyCount = document.querySelector("#historyCount");
const form = document.querySelector("#taskForm");
const taskInput = document.querySelector("#taskInput");
const sendButton = document.querySelector("#sendButton");
const sendButtonLabel = sendButton.querySelector("span");
const forceStopButton = document.querySelector("#forceStopButton");
const projectSelect = document.querySelector("#projectSelect");
const scopeLabel = document.querySelector("#scopeLabel");

let conversations = [];
let projects = [];
let activeConversationId = null;
let isRunning = false;
let cancelRequested = false;
let currentRunSnapshot = null;

function projectStorageKey() {
  return `activeConversation:${projectSelect.value}`;
}

function clearConversation() {
  conversation.innerHTML = "";
  conversation.appendChild(emptyState);
  emptyState.style.display = "grid";
}

function addElement(className, text = "") {
  const element = document.createElement("div");
  element.className = className;
  if (text) element.textContent = text;
  conversation.appendChild(element);
  element.scrollIntoView({ behavior: "smooth", block: "end" });
  return element;
}

function finishRunningState() {
  if (!isRunning) return;
  setRunningState(false);
}

function renderEvent(event) {
  if (emptyState.parentElement) emptyState.remove();

  if (event.type === "task") {
    const message = addElement("message user");
    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = event.task;
    message.appendChild(bubble);
    return;
  }

  if (event.type === "run_started") {
    const item = addElement("event run-started");
    item.innerHTML = `<div class="event-head"><span class="tag">RUN</span> 任务已开始</div><div class="event-body">${escapeHtml(event.task || "")}</div>`;
    return;
  }

  if (event.type === "agent_decision") {
    const item = addElement("event agent-decision");
    item.innerHTML = `<div class="event-head"><span class="tag">ROUTE</span> ${escapeHtml(event.mode)}</div><div class="event-body">${escapeHtml(event.reason || "")}</div>`;
    return;
  }

  if (event.type === "agent_phase") {
    const item = addElement("event agent-phase");
    item.innerHTML = `<div class="event-head"><span class="tag">AGENT</span> ${escapeHtml(event.agent)} · ${escapeHtml(event.title)}</div>`;
    return;
  }

  if (event.type === "step") {
    const item = addElement("event");
    item.innerHTML = `<div class="event-head"><span class="tag">STEP</span> ${escapeHtml(event.agent || "agent")} analyzing step ${event.step}</div>`;
    return;
  }

  if (event.type === "model_waiting") {
    const item = addElement("event model-waiting");
    item.innerHTML = `<div class="event-head"><span class="tag">MODEL</span> ${escapeHtml(event.agent || "agent")} · ${escapeHtml(event.message)}</div>`;
    return;
  }

  if (event.type === "tool_start") {
    const item = addElement("event tool");
    const args = typeof event.arguments === "string"
      ? event.arguments
      : JSON.stringify(event.arguments, null, 2);
    item.innerHTML = `<div class="event-head"><span class="tag">TOOL</span> ${escapeHtml(event.agent || "agent")} calls ${escapeHtml(event.name)}</div><div class="event-body">${escapeHtml(args)}</div>`;
    return;
  }

  if (event.type === "tool_result") {
    const item = addElement(`event ${event.ok === false ? "tool" : "code"}`);
    item.innerHTML = `<div class="event-head"><span class="tag">RESULT</span> ${escapeHtml(event.agent || "agent")} · ${escapeHtml(event.name)}</div><div class="event-body">${escapeHtml(event.result || "")}</div>`;
    return;
  }

  if (event.type === "assistant") {
    const item = addElement("assistant");
    item.textContent = event.agent ? `[${event.agent}]\n${event.content || ""}` : event.content || "";
    return;
  }

  if (event.type === "runtime_state") {
    const item = addElement("event run-started");
    item.innerHTML = `<div class="event-head"><span class="tag">STATE</span> ${escapeHtml(event.title || "当前任务已恢复")}</div><div class="event-body">${escapeHtml(event.message || "")}</div>`;
    return;
  }

  if (event.type === "error") {
    const item = addElement("event tool");
    item.innerHTML = `<div class="event-head"><span class="tag">ERROR</span> ${escapeHtml(event.agent || "agent")} failed</div><div class="event-body">${escapeHtml(event.message)}</div>`;
    finishRunningState();
    return;
  }

  if (event.type === "cancel_requested") {
    const item = addElement("event cancelled");
    item.innerHTML = `<div class="event-head"><span class="tag">CANCEL</span> 已请求终止</div><div class="event-body">${escapeHtml(event.message || "")}</div>`;
    return;
  }

  if (event.type === "force_stopped") {
    const item = addElement("event cancelled");
    item.innerHTML = `<div class="event-head"><span class="tag">STOP</span> 已强制停止</div><div class="event-body">${escapeHtml(event.message || "")}</div>`;
    finishRunningState();
    return;
  }

  if (event.type === "cancelled") {
    const item = addElement("event cancelled");
    item.innerHTML = `<div class="event-head"><span class="tag">CANCEL</span> ${escapeHtml(event.agent || "agent")} stopped</div><div class="event-body">${escapeHtml(event.message || "Cancelled by user.")}</div>`;
    finishRunningState();
    return;
  }

  if (event.type === "done") {
    const status = (event.status || "completed").toLowerCase();
    const item = addElement(`event done done-${status}`);
    item.innerHTML = `<div class="event-head"><span class="tag">DONE</span> 任务${escapeHtml(statusLabel(status))}</div><div class="event-body">${escapeHtml(event.status || "")}</div>`;
    finishRunningState();
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function statusLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "completed") return "已完成";
  if (value === "cancelled") return "已终止";
  if (value === "error") return "已失败";
  return value || "unknown";
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function statusText(conversationItem) {
  if (!conversationItem.run_count) return "empty";
  return `${conversationItem.run_count} task(s)`;
}

function renderConversations() {
  historyCount.textContent = conversations.length;
  historyList.innerHTML = "";
  conversations.forEach((item) => {
    const button = document.createElement("button");
    button.className = `history-item ${item.id === activeConversationId ? "active" : ""}`;
    button.innerHTML = `
      <div class="history-task">${escapeHtml(item.title)}</div>
      <div class="history-meta">${statusText(item)} · ${formatDate(item.updated_at)}</div>
    `;
    button.addEventListener("click", () => {
      if (isRunning) return;
      selectConversation(item.id);
    });
    historyList.appendChild(button);
  });
}

async function createConversation(title = "New conversation") {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: projectSelect.value, title })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to create conversation");
  activeConversationId = data.conversation_id;
  localStorage.setItem(projectStorageKey(), activeConversationId);
  await loadConversations(false);
}

async function loadConversations(loadActiveHistory = true) {
  const response = await fetch(
    `/api/conversations?project=${encodeURIComponent(projectSelect.value)}`
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load conversations");
  conversations = data.conversations || [];

  const savedId = localStorage.getItem(projectStorageKey());
  const savedConversation = conversations.find((item) => item.id === savedId);
  activeConversationId = savedConversation
    ? savedConversation.id
    : conversations[0]?.id || null;

  if (!activeConversationId) {
    await createConversation();
    return;
  }
  localStorage.setItem(projectStorageKey(), activeConversationId);
  renderConversations();
  if (loadActiveHistory) await loadConversationHistory();
}

async function selectConversation(conversationId) {
  activeConversationId = conversationId;
  localStorage.setItem(projectStorageKey(), activeConversationId);
  renderConversations();
  await loadConversationHistory();
}

async function loadConversationHistory() {
  if (!activeConversationId) {
    clearConversation();
    return;
  }
  const query = new URLSearchParams({
    project: projectSelect.value,
    conversation_id: activeConversationId
  });
  const response = await fetch(`/api/history?${query.toString()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load history");
  clearConversation();
  (data.runs || []).forEach((run) => (run.events || []).forEach(renderEvent));
}

async function loadProjects() {
  const response = await fetch("/api/projects");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load projects");
  projects = data.projects || [];
  projectSelect.innerHTML = "";
  projects.forEach((project) => {
    const option = document.createElement("option");
    option.value = project.name;
    option.textContent = project.name;
    projectSelect.appendChild(option);
  });
  const savedProject = localStorage.getItem("selectedProject");
  if (projects.some((project) => project.name === savedProject)) {
    projectSelect.value = savedProject;
  }
  updateProjectLabel();
}

async function loadRuntimeState() {
  const response = await fetch("/api/current-run");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to load runtime state");
  currentRunSnapshot = data.current_run || null;
  if (!currentRunSnapshot) return false;

  const runningProject = currentRunSnapshot.project || projectSelect.value;
  if (runningProject && projectSelect.value !== runningProject) {
    projectSelect.value = runningProject;
    localStorage.setItem("selectedProject", runningProject);
    updateProjectLabel();
  }

  activeConversationId = currentRunSnapshot.conversation_id || null;
  if (activeConversationId) {
    localStorage.setItem(projectStorageKey(), activeConversationId);
  }
  return true;
}

function updateProjectLabel() {
  scopeLabel.textContent = `workspace/${projectSelect.value || ""}`;
}

function setRunningState(running) {
  isRunning = running;
  cancelRequested = false;
  sendButton.disabled = false;
  sendButton.classList.toggle("running", running);
  sendButtonLabel.textContent = running ? "执行中" : "执行任务";
  sendButton.title = running ? "点击终止当前任务" : "";
  forceStopButton.disabled = !running;
  taskInput.disabled = running;
  projectSelect.disabled = running;
  document.querySelector("#newTask").disabled = running;
}

async function cancelTask() {
  if (!isRunning || cancelRequested) return;
  cancelRequested = true;
  sendButtonLabel.textContent = "终止中";
  renderEvent({
    type: "cancel_requested",
    agent: "user",
    message: "已发送终止请求，当前模型调用会在下一个安全检查点停止。"
  });
  try {
    const response = await fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to cancel task");
    }
  } catch (error) {
    renderEvent({ type: "error", agent: "ui", message: error.message });
    cancelRequested = false;
    if (isRunning) {
      sendButtonLabel.textContent = "执行中";
    }
  }
}

async function forceStopTask(options = {}) {
  const silent = Boolean(options.silent);
  if (!projectSelect.value && !currentRunSnapshot) {
    setRunningState(false);
    return;
  }
  forceStopButton.disabled = true;
  cancelRequested = true;
  if (!silent) {
    sendButtonLabel.textContent = "终止中";
    renderEvent({
      type: "cancel_requested",
      agent: "user",
      message: "正在强制停止当前任务和它启动的本地命令。"
    });
  }
  try {
    const response = await fetch("/api/force-stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to force stop task");
    if (!silent) {
      renderEvent({
        type: "force_stopped",
        agent: "system",
        message:
          data.status === "no_task_running"
            ? "当前没有正在执行的任务。"
            : data.status === "stale_lock_cleared"
              ? "已清理残留锁，可以启动新的任务。"
              : "已清理当前任务状态，可以启动新的任务。"
      });
    }
    currentRunSnapshot = null;
    if (projectSelect.value) {
      await loadConversations(false);
      await loadConversationHistory();
    }
  } catch (error) {
    if (!silent) {
      renderEvent({ type: "error", agent: "ui", message: error.message });
    }
  } finally {
    setRunningState(false);
    if (!silent) {
      taskInput.focus();
    }
  }
}

async function runTask(task) {
  if (!activeConversationId) await createConversation();
  setRunningState(true);

  const payload = JSON.stringify({
    task,
    project: projectSelect.value,
    conversation_id: activeConversationId
  });

  let response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload
  });
  if (!response.ok) {
    let error = {};
    try {
      error = await response.json();
    } catch (_) {
      error = {};
    }
    if (response.status === 409) {
      await forceStopTask({ silent: true });
      response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload
      });
      if (!response.ok) {
        try {
          error = await response.json();
        } catch (_) {
          error = {};
        }
      } else {
        setRunningState(true);
      }
    }
    if (!response.ok) {
      throw new Error(error.error || "Failed to start task");
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop();
    chunks.forEach((chunk) => {
      const line = chunk.split("\n").find((part) => part.startsWith("data: "));
      if (!line) return;
      const event = JSON.parse(line.slice(6));
      if (event.conversation_id) activeConversationId = event.conversation_id;
      renderEvent(event);
    });
  }
  await loadConversations(false);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isRunning) {
    await cancelTask();
    return;
  }
  const task = taskInput.value.trim();
  if (!task) return;
  taskInput.value = "";
  try {
    await runTask(task);
  } catch (error) {
    renderEvent({ type: "error", message: error.message });
  } finally {
    setRunningState(false);
    taskInput.focus();
  }
});

sendButton.addEventListener("click", async (event) => {
  if (isRunning) {
    event.preventDefault();
    await cancelTask();
  }
});

forceStopButton.addEventListener("click", async () => {
  await forceStopTask();
});

document.querySelector("#newTask").addEventListener("click", async () => {
  if (sendButton.disabled) return;
  try {
    await createConversation();
    clearConversation();
    renderConversations();
    taskInput.focus();
  } catch (error) {
    renderEvent({ type: "error", message: error.message });
  }
});

projectSelect.addEventListener("change", async () => {
  localStorage.setItem("selectedProject", projectSelect.value);
  activeConversationId = null;
  updateProjectLabel();
  try {
    await loadConversations();
  } catch (error) {
    renderEvent({ type: "error", message: error.message });
  }
});

taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    form.requestSubmit();
  }
});

async function bootstrap() {
  await loadProjects();
  await loadRuntimeState();
  await forceStopTask({ silent: true });
}

bootstrap().catch((error) => {
  renderEvent({ type: "error", message: error.message });
});
