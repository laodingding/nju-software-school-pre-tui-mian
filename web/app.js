const conversation = document.querySelector("#conversation");
const emptyState = document.querySelector("#emptyState");
const historyList = document.querySelector("#historyList");
const historyCount = document.querySelector("#historyCount");
const form = document.querySelector("#taskForm");
const taskInput = document.querySelector("#taskInput");
const sendButton = document.querySelector("#sendButton");
const projectSelect = document.querySelector("#projectSelect");
const scopeLabel = document.querySelector("#scopeLabel");

let conversations = [];
let projects = [];
let activeConversationId = null;

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
  if (event.type === "step") {
    const item = addElement("event");
    item.innerHTML = `<div class="event-head"><span class="tag">STEP</span> Agent 正在分析第 ${event.step} 步</div>`;
    return;
  }
  if (event.type === "model_waiting") {
    const item = addElement("event model-waiting");
    item.innerHTML = `<div class="event-head"><span class="tag">MODEL</span> ${escapeHtml(event.message)}</div>`;
    return;
  }
  if (event.type === "tool_start") {
    const item = addElement("event tool");
    const args = typeof event.arguments === "string"
      ? event.arguments
      : JSON.stringify(event.arguments, null, 2);
    item.innerHTML = `<div class="event-head"><span class="tag">TOOL</span> 调用 ${escapeHtml(event.name)}</div><div class="event-body">${escapeHtml(args)}</div>`;
    return;
  }
  if (event.type === "tool_result") {
    const item = addElement(`event ${event.ok === false ? "tool" : "code"}`);
    item.innerHTML = `<div class="event-head"><span class="tag">RESULT</span> ${escapeHtml(event.name)} 返回</div><div class="event-body">${escapeHtml(event.result || "")}</div>`;
    return;
  }
  if (event.type === "assistant") {
    const item = addElement("assistant");
    item.textContent = event.content || "";
    return;
  }
  if (event.type === "error") {
    const item = addElement("event tool");
    item.innerHTML = `<div class="event-head"><span class="tag">ERROR</span> 执行失败</div><div class="event-body">${escapeHtml(event.message)}</div>`;
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
  if (!conversationItem.run_count) return "空对话";
  return `${conversationItem.run_count} 次任务`;
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
    button.addEventListener("click", () => selectConversation(item.id));
    historyList.appendChild(button);
  });
}

async function createConversation(title = "新对话") {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: projectSelect.value, title })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "创建对话失败");
  activeConversationId = data.conversation_id;
  localStorage.setItem(projectStorageKey(), activeConversationId);
  await loadConversations(false);
}

async function loadConversations(loadActiveHistory = true) {
  const response = await fetch(
    `/api/conversations?project=${encodeURIComponent(projectSelect.value)}`
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取对话列表失败");
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
  if (!response.ok) throw new Error(data.error || "读取对话历史失败");
  clearConversation();
  (data.runs || []).forEach((run) => (run.events || []).forEach(renderEvent));
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
  if (projectSelect.value) await loadConversations();
}

function updateProjectLabel() {
  scopeLabel.textContent = `workspace/${projectSelect.value || ""}`;
}

async function runTask(task) {
  if (!activeConversationId) await createConversation();
  sendButton.disabled = true;
  taskInput.disabled = true;

  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task,
      project: projectSelect.value,
      conversation_id: activeConversationId
    })
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "任务启动失败");
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
  const task = taskInput.value.trim();
  if (!task || sendButton.disabled) return;
  taskInput.value = "";
  try {
    await runTask(task);
  } catch (error) {
    renderEvent({ type: "error", message: error.message });
  } finally {
    sendButton.disabled = false;
    taskInput.disabled = false;
    taskInput.focus();
  }
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

loadProjects().catch((error) => {
  renderEvent({ type: "error", message: error.message });
});
