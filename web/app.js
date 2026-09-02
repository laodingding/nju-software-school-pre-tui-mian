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

const runOverview = document.querySelector("#runOverview");
const runStatusIcon = document.querySelector("#runStatusIcon");
const runKicker = document.querySelector("#runKicker");
const runTitle = document.querySelector("#runTitle");
const runSummary = document.querySelector("#runSummary");
const runPhase = document.querySelector("#runPhase");
const runStep = document.querySelector("#runStep");
const runStatus = document.querySelector("#runStatus");
const runProgress = document.querySelector("#runProgress");
const finalResult = document.querySelector("#finalResult");
const resultStatus = document.querySelector("#resultStatus");
const resultContent = document.querySelector("#resultContent");

let conversations = [];
let projects = [];
let activeConversationId = null;
let isRunning = false;
let cancelRequested = false;
let currentRunSnapshot = null;
let currentRunId = null;
let streamConnected = false;
let pollTimer = null;
let lastRenderedTask = "";

const STATUS_LABELS = {
  completed: "已完成",
  error: "失败",
  cancelled: "已终止",
  interrupted: "已中断",
  force_stopped: "已强制停止",
  running: "执行中",
  idle: "待执行",
};

const AGENT_LABELS = {
  orchestrator: "总控 Agent",
  "requirements-agent": "需求分析 Agent",
  "implementation-agent": "开发与测试 Agent",
  "review-agent": "代码审查 Agent",
  "coding-agent": "编码 Agent",
  user: "用户",
  system: "系统",
  ui: "界面",
};

function projectStorageKey() {
  return `activeConversation:${projectSelect.value}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function statusLabel(status) {
  const value = String(status || "").toLowerCase();
  return STATUS_LABELS[value] || value || "未知";
}

function agentLabel(agent) {
  return AGENT_LABELS[agent] || agent || "Agent";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusText(item) {
  if (!item.run_count) return "暂无任务";
  return `${item.run_count} 次任务`;
}

function clearConversation() {
  conversation.innerHTML = "";
  conversation.appendChild(emptyState);
  emptyState.style.display = "grid";
  lastRenderedTask = "";
}

function addElement(className, text = "", scroll = true) {
  if (emptyState.parentElement) emptyState.remove();
  const element = document.createElement("div");
  element.className = className;
  if (text) element.textContent = text;
  conversation.appendChild(element);
  if (scroll) element.scrollIntoView({ behavior: "smooth", block: "end" });
  return element;
}

function addEventCard(className, tag, title, body = "", scroll = true) {
  const item = addElement(`event ${className}`.trim(), "", scroll);
  const head = document.createElement("div");
  head.className = "event-head";
  const tagElement = document.createElement("span");
  tagElement.className = "tag";
  tagElement.textContent = tag;
  head.append(tagElement, document.createTextNode(title));
  item.appendChild(head);
  if (body !== undefined && body !== null && String(body) !== "") {
    const bodyElement = document.createElement("div");
    bodyElement.className = "event-body";
    bodyElement.textContent = String(body);
    item.appendChild(bodyElement);
  }
  return item;
}

function resetRunOverview() {
  runOverview.className = "run-overview";
  runStatusIcon.textContent = "○";
  runKicker.textContent = "READY";
  runTitle.textContent = "等待新的编程任务";
  runSummary.textContent = "选择一个项目，描述你希望 Agent 完成的内容。";
  runPhase.textContent = "-";
  runStep.textContent = "-";
  runStatus.textContent = "待执行";
  runProgress.style.width = "0";
  finalResult.classList.add("hidden");
  finalResult.classList.remove("error");
  resultStatus.textContent = "-";
  resultContent.textContent = "";
}

function updateRunOverview(event) {
  const type = event.type;
  const status = String(event.status || "").toLowerCase();
  const classes = ["run-overview"];

  if (type === "run_started") {
    currentRunId = event.run_id || currentRunId;
    runKicker.textContent = "RUNNING";
    runTitle.textContent = "任务正在执行";
    runSummary.textContent = event.task || "Agent 正在处理当前任务。";
    runStatus.textContent = "执行中";
    classes.push("running");
  } else if (type === "agent_decision") {
    runKicker.textContent = "ROUTING";
    runTitle.textContent = event.mode === "multi-agent"
      ? "已启动多 Agent 协同"
      : "已分配给单 Agent 执行";
    runSummary.textContent = event.reason || "正在根据任务难度选择执行方式。";
    runPhase.textContent = event.mode === "multi-agent" ? "多 Agent 协同" : "单 Agent 执行";
    runStatus.textContent = "执行中";
    classes.push("running");
  } else if (type === "agent_phase") {
    runKicker.textContent = "AGENT PHASE";
    runTitle.textContent = event.title || "Agent 正在工作";
    runSummary.textContent = `${agentLabel(event.agent)} 正在执行当前阶段。`;
    runPhase.textContent = event.title || agentLabel(event.agent);
    runStatus.textContent = "执行中";
    classes.push("running");
  } else if (type === "step") {
    runKicker.textContent = "WORKING";
    runTitle.textContent = `${agentLabel(event.agent)} 正在分析`;
    runSummary.textContent = "Agent 正在规划下一步操作。";
    runPhase.textContent = agentLabel(event.agent);
    runStep.textContent = String(event.step || "-");
    runStatus.textContent = "执行中";
    classes.push("running");
  } else if (type === "model_waiting") {
    runKicker.textContent = "MODEL";
    runTitle.textContent = "正在等待模型响应";
    runSummary.textContent = event.message || `${agentLabel(event.agent)} 正在思考。`;
    runPhase.textContent = agentLabel(event.agent);
    runStatus.textContent = "执行中";
    classes.push("running");
  } else if (type === "tool_start") {
    runKicker.textContent = "TOOL CALL";
    runTitle.textContent = `${agentLabel(event.agent)} 正在调用工具`;
    runSummary.textContent = `${event.name || "tool"} 正在执行。`;
    runPhase.textContent = event.name || "工具调用";
    runStatus.textContent = "执行中";
    classes.push("running");
  } else if (type === "tool_result") {
    runKicker.textContent = event.ok === false ? "TOOL ERROR" : "TOOL RESULT";
    runTitle.textContent = event.ok === false ? "工具执行失败" : "工具执行完成";
    runSummary.textContent = `${agentLabel(event.agent)} 返回了 ${event.name || "tool"} 的结果。`;
    runPhase.textContent = event.name || "工具结果";
    runStatus.textContent = event.ok === false ? "失败" : "执行中";
    classes.push(event.ok === false ? "error" : "running");
  } else if (type === "error") {
    runKicker.textContent = "ERROR";
    runTitle.textContent = "任务未能完成";
    runSummary.textContent = event.message || "Agent 遇到了无法继续处理的问题。";
    runStatus.textContent = "失败";
    classes.push("error");
  } else if (type === "cancel_requested") {
    runKicker.textContent = "STOPPING";
    runTitle.textContent = "正在终止任务";
    runSummary.textContent = event.message || "正在等待当前操作结束。";
    runStatus.textContent = "终止中";
    classes.push("running");
  } else if (type === "cancelled" || type === "force_stopped") {
    runKicker.textContent = "STOPPED";
    runTitle.textContent = "任务已终止";
    runSummary.textContent = event.message || "任务已被用户停止。";
    runStatus.textContent = "已终止";
    classes.push("error");
  } else if (type === "done") {
    const finalStatus = status || "completed";
    runKicker.textContent = finalStatus === "completed" ? "DELIVERED" : "FINISHED";
    runTitle.textContent = `任务${statusLabel(finalStatus)}`;
    runSummary.textContent = event.answer || `Agent 返回状态：${statusLabel(finalStatus)}。`;
    runStatus.textContent = statusLabel(finalStatus);
    classes.push(finalStatus === "completed" ? "completed" : "error");
  } else if (type === "runtime_state") {
    runKicker.textContent = "RECOVERED";
    runTitle.textContent = event.title || "已恢复任务状态";
    runSummary.textContent = event.message || "";
  }

  runOverview.className = classes.join(" ");
}

function renderFinalResult(status, answer) {
  if (answer === undefined || answer === null || String(answer) === "") {
    finalResult.classList.add("hidden");
    return;
  }
  const normalized = String(status || "completed").toLowerCase();
  finalResult.classList.remove("hidden");
  finalResult.classList.toggle("error", normalized !== "completed");
  resultStatus.textContent = statusLabel(normalized).toUpperCase();
  resultContent.textContent = String(answer);
}

function finishRunningState() {
  currentRunSnapshot = null;
  setRunningState(false);
  stopPolling();
}

function renderEvent(event, options = {}) {
  const live = options.live !== false;
  const scroll = options.scroll !== false;
  if (!event || !event.type) return;
  if (event.run_id) currentRunId = event.run_id;
  updateRunOverview(event);

  if (event.type === "task") {
    if (lastRenderedTask === event.task) return;
    lastRenderedTask = event.task || "";
    const message = addElement("message user", "", scroll);
    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = event.task || "";
    message.appendChild(bubble);
    return;
  }

  if (event.type === "run_started") {
    addEventCard("run-started", "RUN", "任务已开始", event.task || "", scroll);
    return;
  }

  if (event.type === "agent_decision") {
    addEventCard(
      "agent-decision",
      "ROUTE",
      event.mode === "multi-agent" ? "多 Agent 协同" : "单 Agent 执行",
      event.reason || "",
      scroll,
    );
    return;
  }

  if (event.type === "agent_phase") {
    addEventCard(
      "agent-phase",
      "AGENT",
      `${agentLabel(event.agent)} · ${event.title || "工作阶段"}`,
      "",
      scroll,
    );
    return;
  }

  if (event.type === "step") {
    addEventCard(
      "",
      "STEP",
      `${agentLabel(event.agent)} · 第 ${event.step || "-"} 步`,
      "Agent 正在分析任务并决定下一步操作。",
      scroll,
    );
    return;
  }

  if (event.type === "model_waiting") {
    addEventCard(
      "model-waiting",
      "MODEL",
      `${agentLabel(event.agent)} · 等待模型响应`,
      event.message || "",
      scroll,
    );
    return;
  }

  if (event.type === "tool_start") {
    const args = typeof event.arguments === "string"
      ? event.arguments
      : JSON.stringify(event.arguments || {}, null, 2);
    addEventCard(
      "tool",
      "TOOL",
      `${agentLabel(event.agent)} · ${event.name || "未知工具"}`,
      args,
      scroll,
    );
    return;
  }

  if (event.type === "tool_result") {
    addEventCard(
      event.ok === false ? "tool" : "code",
      "RESULT",
      `${agentLabel(event.agent)} · ${event.name || "工具结果"}`,
      event.result || "",
      scroll,
    );
    return;
  }

  if (event.type === "assistant") {
    const item = addElement("assistant", "", scroll);
    item.textContent = event.agent
      ? `[${agentLabel(event.agent)}]\n${event.content || ""}`
      : event.content || "";
    return;
  }

  if (event.type === "runtime_state") {
    addEventCard(
      "run-started",
      "STATE",
      event.title || "任务状态已恢复",
      event.message || "",
      scroll,
    );
    return;
  }

  if (event.type === "error") {
    addEventCard(
      "tool",
      "ERROR",
      `${agentLabel(event.agent)} · 执行失败`,
      event.message || "",
      scroll,
    );
    if (live) setRunningState(false);
    return;
  }

  if (event.type === "cancel_requested") {
    addEventCard(
      "cancelled",
      "CANCEL",
      "已发送终止请求",
      event.message || "",
      scroll,
    );
    return;
  }

  if (event.type === "force_stopped") {
    addEventCard(
      "cancelled",
      "STOP",
      "任务已强制停止",
      event.message || "",
      scroll,
    );
    if (live) finishRunningState();
    return;
  }

  if (event.type === "cancelled") {
    addEventCard(
      "cancelled",
      "CANCEL",
      `${agentLabel(event.agent)} · 任务已终止`,
      event.message || "任务已被用户终止。",
      scroll,
    );
    if (live) finishRunningState();
    return;
  }

  if (event.type === "done") {
    const finalStatus = String(event.status || "completed").toLowerCase();
    addEventCard(
      `done done-${finalStatus}`,
      "DONE",
      `任务${statusLabel(finalStatus)}`,
      finalStatus,
      scroll,
    );
    renderFinalResult(finalStatus, event.answer);
    if (live) finishRunningState();
  }
}

function renderConversations() {
  historyCount.textContent = String(conversations.length);
  historyList.innerHTML = "";
  conversations.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `history-item ${item.id === activeConversationId ? "active" : ""}`;
    button.disabled = isRunning;
    const title = document.createElement("div");
    title.className = "history-task";
    title.textContent = item.title || "新建对话";
    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.textContent = `${statusText(item)} · ${formatDate(item.updated_at)}`;
    button.append(title, meta);
    button.addEventListener("click", () => selectConversation(item.id));
    historyList.appendChild(button);
  });
}

async function createConversation(title = "新建对话") {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: projectSelect.value, title }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "创建对话失败");
  activeConversationId = data.conversation_id;
  localStorage.setItem(projectStorageKey(), activeConversationId);
  await loadConversations(false);
}

async function loadConversations(loadActiveHistory = true) {
  const response = await fetch(
    `/api/conversations?project=${encodeURIComponent(projectSelect.value)}`,
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取对话失败");
  conversations = data.conversations || [];

  const preferredId = currentRunSnapshot
    && currentRunSnapshot.project === projectSelect.value
    ? currentRunSnapshot.conversation_id
    : localStorage.getItem(projectStorageKey());
  const preferredConversation = conversations.find((item) => item.id === preferredId);
  activeConversationId = preferredConversation
    ? preferredConversation.id
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
  if (isRunning || conversationId === activeConversationId) return;
  activeConversationId = conversationId;
  localStorage.setItem(projectStorageKey(), activeConversationId);
  renderConversations();
  await loadConversationHistory();
}

function latestRunStatus(runs) {
  return runs.length ? String(runs[runs.length - 1].status || "idle") : "idle";
}

async function loadConversationHistory() {
  if (!activeConversationId) {
    clearConversation();
    resetRunOverview();
    return;
  }
  const query = new URLSearchParams({
    project: projectSelect.value,
    conversation_id: activeConversationId,
  });
  const response = await fetch(`/api/history?${query.toString()}`, {
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取执行历史失败");

  clearConversation();
  resetRunOverview();
  const runs = data.runs || [];
  runs.forEach((run) => {
    (run.events || []).forEach((event) => renderEvent(event, {
      live: false,
      scroll: false,
    }));
    if (run.answer !== undefined && run.answer !== null) {
      renderFinalResult(run.status, run.answer);
    }
  });

  const activeRun = currentRunSnapshot
    && currentRunSnapshot.conversation_id === activeConversationId
    ? currentRunSnapshot
    : null;
  const status = activeRun ? "running" : latestRunStatus(runs);
  setRunningState(status === "running");
  if (runs.length && status !== "running") {
    const latest = runs[runs.length - 1];
    updateRunOverview({
      type: "done",
      run_id: latest.id,
      status: latest.status,
      answer: latest.answer,
    });
    renderFinalResult(latest.status, latest.answer);
  }
}

async function loadProjects() {
  const response = await fetch("/api/projects");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取项目失败");
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

async function fetchCurrentRun() {
  const response = await fetch("/api/current-run", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取运行状态失败");
  return data.current_run || null;
}

async function loadRuntimeState() {
  currentRunSnapshot = await fetchCurrentRun();
  if (!currentRunSnapshot) return false;

  const runningProject = currentRunSnapshot.project || projectSelect.value;
  if (runningProject && projectSelect.value !== runningProject) {
    projectSelect.value = runningProject;
    localStorage.setItem("selectedProject", runningProject);
    updateProjectLabel();
  }
  activeConversationId = currentRunSnapshot.conversation_id || null;
  currentRunId = currentRunSnapshot.run_id || null;
  if (activeConversationId) {
    localStorage.setItem(projectStorageKey(), activeConversationId);
  }
  return true;
}

function updateProjectLabel() {
  scopeLabel.textContent = `workspace/${projectSelect.value || ""}`;
}

function setRunningState(running) {
  isRunning = Boolean(running);
  if (!running) cancelRequested = false;
  sendButton.disabled = false;
  sendButton.classList.toggle("running", isRunning);
  sendButtonLabel.textContent = isRunning
    ? (cancelRequested ? "终止中" : "执行中")
    : "执行任务";
  sendButton.title = isRunning ? "点击发送终止请求" : "";
  forceStopButton.disabled = !isRunning;
  taskInput.disabled = isRunning;
  projectSelect.disabled = isRunning;
  document.querySelector("#newTask").disabled = isRunning;
  renderConversations();
}

async function cancelTask() {
  if (!isRunning || cancelRequested) return;
  cancelRequested = true;
  setRunningState(true);
  renderEvent({
    type: "cancel_requested",
    agent: "user",
    message: "已发送终止请求，当前操作将在安全点停止。",
  });
  try {
    const response = await fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "终止请求失败");
    currentRunId = data.run_id || currentRunId;
  } catch (error) {
    cancelRequested = false;
    setRunningState(true);
    renderEvent({ type: "error", agent: "ui", message: error.message });
  }
}

async function forceStopTask(options = {}) {
  const silent = Boolean(options.silent);
  forceStopButton.disabled = true;
  cancelRequested = true;
  if (!silent) {
    renderEvent({
      type: "cancel_requested",
      agent: "user",
      message: "正在强制停止任务及其启动的本地进程。",
    });
  }
  try {
    const response = await fetch("/api/force-stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "强制停止失败");
    currentRunSnapshot = null;
    currentRunId = null;
    if (!silent) {
      renderEvent({
        type: "force_stopped",
        agent: "system",
        message: data.status === "no_task_running"
          ? "当前没有正在执行的任务。"
          : "已清理当前任务状态，可以启动新的任务。",
      });
    }
    setRunningState(false);
    await loadConversations(false);
    await loadConversationHistory();
  } catch (error) {
    if (!silent) renderEvent({ type: "error", agent: "ui", message: error.message });
    setRunningState(false);
  } finally {
    if (!silent) taskInput.focus();
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    syncRuntimeState().catch((error) => console.warn("runtime polling failed", error));
  }, 1600);
}

async function syncRuntimeState() {
  const snapshot = await fetchCurrentRun();
  if (snapshot) {
    const changedRun = !currentRunSnapshot
      || currentRunSnapshot.run_id !== snapshot.run_id;
    currentRunSnapshot = snapshot;
    currentRunId = snapshot.run_id;
    if (projectSelect.value !== snapshot.project) {
      projectSelect.value = snapshot.project;
      localStorage.setItem("selectedProject", snapshot.project);
      updateProjectLabel();
      await loadConversations(false);
    }
    if (activeConversationId !== snapshot.conversation_id) {
      activeConversationId = snapshot.conversation_id;
      localStorage.setItem(projectStorageKey(), activeConversationId);
      await loadConversations(false);
    }
    setRunningState(true);
    if (!streamConnected || changedRun) await loadConversationHistory();
    return;
  }

  if (currentRunSnapshot) {
    currentRunSnapshot = null;
    currentRunId = null;
    streamConnected = false;
    setRunningState(false);
    stopPolling();
    await loadConversations(false);
    await loadConversationHistory();
  }
}

function parseSseChunk(chunk) {
  const line = chunk.split("\n").find((part) => part.startsWith("data: "));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(6));
  } catch (error) {
    console.warn("Invalid SSE event", error);
    return null;
  }
}

async function runTask(task) {
  if (!activeConversationId) await createConversation();
  currentRunId = null;
  currentRunSnapshot = null;
  streamConnected = false;
  finalResult.classList.add("hidden");
  resultContent.textContent = "";
  setRunningState(true);

  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task,
      project: projectSelect.value,
      conversation_id: activeConversationId,
    }),
  });
  if (!response.ok) {
    let error = {};
    try {
      error = await response.json();
    } catch (_) {
      // The server may close before returning JSON.
    }
    throw new Error(error.error || "启动任务失败");
  }

  currentRunSnapshot = await fetchCurrentRun().catch(() => null);
  currentRunId = currentRunSnapshot?.run_id || currentRunId;
  startPolling();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalEvent = false;
  streamConnected = true;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      chunks.forEach((chunk) => {
        const event = parseSseChunk(chunk);
        if (!event) return;
        if (event.conversation_id) activeConversationId = event.conversation_id;
        if (event.run_id) currentRunId = event.run_id;
        renderEvent(event, { live: true });
        if (["done", "cancelled", "force_stopped"].includes(event.type)) {
          terminalEvent = true;
        }
      });
    }
    if (buffer.trim()) {
      const event = parseSseChunk(buffer);
      if (event) renderEvent(event, { live: true });
    }
  } catch (error) {
    streamConnected = false;
    renderEvent({
      type: "runtime_state",
      title: "实时连接已断开",
      message: "任务仍会在服务端继续执行，页面正在通过历史记录恢复进度。",
    });
    startPolling();
    return;
  }

  streamConnected = false;
  if (terminalEvent) {
    currentRunSnapshot = null;
    stopPolling();
    setRunningState(false);
    await loadConversations(false);
  } else {
    await syncRuntimeState();
  }
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
    renderEvent({ type: "error", agent: "ui", message: error.message });
    setRunningState(false);
  } finally {
    taskInput.focus();
  }
});

sendButton.addEventListener("click", async (event) => {
  if (isRunning) {
    event.preventDefault();
    await cancelTask();
  }
});

forceStopButton.addEventListener("click", () => forceStopTask());

document.querySelector("#newTask").addEventListener("click", async () => {
  if (isRunning) return;
  try {
    await createConversation();
    clearConversation();
    resetRunOverview();
    renderConversations();
    taskInput.focus();
  } catch (error) {
    renderEvent({ type: "error", agent: "ui", message: error.message });
  }
});

projectSelect.addEventListener("change", async () => {
  if (isRunning) return;
  localStorage.setItem("selectedProject", projectSelect.value);
  activeConversationId = null;
  updateProjectLabel();
  try {
    await loadConversations();
  } catch (error) {
    renderEvent({ type: "error", agent: "ui", message: error.message });
  }
});

taskInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    form.requestSubmit();
  }
});

async function bootstrap() {
  resetRunOverview();
  await loadProjects();
  const hasActiveRun = await loadRuntimeState();
  await loadConversations();
  if (hasActiveRun) {
    setRunningState(true);
    startPolling();
  }
}

bootstrap().catch((error) => {
  resetRunOverview();
  renderEvent({ type: "error", agent: "ui", message: error.message });
});
