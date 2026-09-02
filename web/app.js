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
const collaborationBoard = document.querySelector("#collaborationBoard");
const collaborationSummary = document.querySelector("#collaborationSummary");
const deliveryModal = document.querySelector("#deliveryModal");
const deliveryTitle = document.querySelector("#deliveryTitle");
const deliveryRole = document.querySelector("#deliveryRole");
const deliveryStatus = document.querySelector("#deliveryStatus");
const deliveryRoute = document.querySelector("#deliveryRoute");
const deliveryList = document.querySelector("#deliveryList");
const closeDelivery = document.querySelector("#closeDelivery");

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
let activeCollaborationAgent = null;
let agentDeliveries = {};

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

const AGENT_DEFAULT_DETAILS = {
  orchestrator: "等待分配协作任务",
  "requirements-agent": "等待接收任务",
  "implementation-agent": "等待接收开发文档",
  "review-agent": "等待接收实现结果",
};

const AGENT_DELIVERY_DEFAULTS = {
  "requirements-agent": {
    title: "需求分析阶段交付",
    artifact: ".agent/requirements.md",
  },
  "implementation-agent": {
    title: "开发与测试阶段交付",
    artifact: "已修改的项目文件和测试结果",
  },
  "review-agent": {
    title: "代码审查阶段交付",
    artifact: "审查结论和需求验收结果",
  },
};

const PHASE_LABELS = {
  "Task routing": "任务路由与调度",
  "Requirements and design": "需求分析与开发设计",
  "Implementation and debug": "代码实现与调试",
  "Review and acceptance": "代码审查与需求验收",
  "Revision from review feedback": "根据审查意见修复",
  "Final review": "最终代码审查",
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

function phaseLabel(title) {
  return PHASE_LABELS[title] || title || "工作阶段";
}

function agentClassName(agent) {
  if (!agent) return "";
  return `agent-${String(agent).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

function normalizeEvent(event) {
  if (
    event
    && event.type
    && typeof event.type === "object"
    && typeof event.type.type === "string"
  ) {
    return { ...event, ...event.type, type: event.type.type };
  }
  return event;
}

function agentCard(agent) {
  return collaborationBoard.querySelector(`[data-agent="${agent}"]`);
}

function updateAgentCardAction(agent) {
  const card = agentCard(agent);
  if (!card) return;
  const action = card.querySelector(".agent-card-action");
  if (!action) return;
  const count = (agentDeliveries[agent] || []).length;
  action.textContent = count
    ? `查看交付内容（${count}）`
    : "查看交付内容";
  card.classList.toggle("has-delivery", count > 0);
  card.setAttribute("aria-label", `${agentLabel(agent)}，点击查看交付内容`);
}

function recordAgentDelivery(agent, packet) {
  if (!AGENT_DEFAULT_DETAILS[agent]) return;
  if (!agentDeliveries[agent]) agentDeliveries[agent] = [];
  const delivery = {
    title: packet.title || "阶段结果交接",
    content: packet.content || "",
    artifact: packet.artifact || "",
    toAgent: packet.toAgent || "",
    provisional: Boolean(packet.provisional),
  };

  // A role agent emits its final assistant message just before the
  // orchestrator emits the formal handoff. Merge those two records so a
  // normal run shows one complete delivery, while interrupted runs still
  // retain the assistant result as a reviewable fallback.
  const provisionalIndex = agentDeliveries[agent].findLastIndex(
    (item) => item.provisional,
  );
  if (!delivery.provisional && provisionalIndex >= 0) {
    agentDeliveries[agent][provisionalIndex] = {
      ...agentDeliveries[agent][provisionalIndex],
      ...delivery,
      provisional: false,
    };
  } else {
    agentDeliveries[agent].push(delivery);
  }
  updateAgentCardAction(agent);
}

function closeDeliveryModal() {
  deliveryModal.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function openDeliveryModal(agent) {
  const card = agentCard(agent);
  if (!card) return;
  deliveryTitle.textContent = agentLabel(agent);
  deliveryRole.textContent = card.querySelector(".agent-role")?.textContent
    || "查看该 Agent 的阶段产出和交接记录。";
  deliveryStatus.textContent = card.querySelector(".agent-status")?.textContent || "待开始";
  deliveryRoute.textContent = "";
  deliveryList.innerHTML = "";

  const deliveries = agentDeliveries[agent] || [];
  if (!deliveries.length) {
    const empty = document.createElement("div");
    empty.className = "delivery-empty";
    empty.textContent = "该 Agent 目前还没有可查看的交付内容。";
    deliveryList.appendChild(empty);
  } else {
    deliveries.forEach((delivery, index) => {
      const entry = document.createElement("article");
      entry.className = `delivery-entry ${agentClassName(agent)}`.trim();

      const entryHead = document.createElement("div");
      entryHead.className = "delivery-entry-head";
      const entryTitle = document.createElement("strong");
      entryTitle.textContent = delivery.title;
      const entryIndex = document.createElement("span");
      entryIndex.className = "delivery-entry-index";
      entryIndex.textContent = `DELIVERY ${index + 1}`;
      entryHead.append(entryTitle, entryIndex);
      entry.appendChild(entryHead);

      if (delivery.toAgent) {
        const route = document.createElement("div");
        route.className = "delivery-entry-route";
        route.textContent = `交接给：${agentLabel(delivery.toAgent)}`;
        entry.appendChild(route);
      }
      if (delivery.artifact) {
        const artifact = document.createElement("div");
        artifact.className = "delivery-entry-artifact";
        artifact.textContent = `交付产物：${delivery.artifact}`;
        entry.appendChild(artifact);
      }

      const content = document.createElement("div");
      content.className = "delivery-entry-content";
      content.textContent = delivery.content || "本次交付没有附加文字内容。";
      entry.appendChild(content);
      deliveryList.appendChild(entry);
    });
  }

  const latest = deliveries[deliveries.length - 1];
  deliveryRoute.textContent = latest?.toAgent
    ? `最近一次交接：${agentLabel(agent)} → ${agentLabel(latest.toAgent)}`
    : "查看该 Agent 的阶段交付内容";
  deliveryModal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  closeDelivery.focus();
}

function bindAgentCardInteractions() {
  collaborationBoard.querySelectorAll(".agent-card").forEach((card) => {
    const agent = card.dataset.agent;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `${agentLabel(agent)}，点击查看交付内容`);
    card.addEventListener("click", () => openDeliveryModal(agent));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDeliveryModal(agent);
      }
    });
  });
}

function setAgentCardState(agent, state, detail) {
  const card = agentCard(agent);
  if (!card) return;
  card.classList.remove("active", "completed", "error");
  if (state) card.classList.add(state);
  const status = card.querySelector(".agent-status");
  const detailElement = card.querySelector(".agent-detail");
  if (status) {
    status.textContent = state === "active"
      ? "进行中"
      : state === "completed"
        ? "已完成"
        : state === "error"
          ? "需处理"
          : "待开始";
  }
  if (detailElement && detail) detailElement.textContent = detail;
}

function resetCollaborationBoard() {
  activeCollaborationAgent = null;
  agentDeliveries = {};
  collaborationBoard.classList.add("hidden");
  collaborationSummary.textContent = "等待协作启动";
  Object.entries(AGENT_DEFAULT_DETAILS).forEach(([agent, detail]) => {
    setAgentCardState(agent, "", detail);
    updateAgentCardAction(agent);
  });
}

function updateCollaboration(event) {
  const { type, agent } = event;
  if (type === "agent_decision") {
    if (event.mode !== "multi-agent") {
      resetCollaborationBoard();
      return;
    }
    collaborationBoard.classList.remove("hidden");
    collaborationSummary.textContent = "3 个专业 Agent 接力协作";
    setAgentCardState(
      "orchestrator",
      "active",
      "已完成难度判断，正在调度专业 Agent",
    );
    activeCollaborationAgent = "orchestrator";
    return;
  }

  if (type === "agent_handoff") {
    collaborationBoard.classList.remove("hidden");
    recordAgentDelivery(event.from_agent, {
      title: event.title,
      content: event.content,
      artifact: event.artifact,
      toAgent: event.to_agent,
    });
    const fromAgent = AGENT_DEFAULT_DETAILS[event.from_agent]
      ? event.from_agent
      : null;
    const toAgent = AGENT_DEFAULT_DETAILS[event.to_agent]
      ? event.to_agent
      : null;
    if (fromAgent) {
      setAgentCardState(
        fromAgent,
        "completed",
        `已将交接材料发送给${agentLabel(event.to_agent)}`,
      );
    }
    if (toAgent) {
      activeCollaborationAgent = toAgent;
      setAgentCardState(
        toAgent,
        "active",
        `已收到${agentLabel(event.from_agent)}的交接材料`,
      );
    }
    collaborationSummary.textContent = `${agentLabel(event.from_agent)} → ${agentLabel(event.to_agent)} 已完成交接`;
    return;
  }

  const trackedAgent = AGENT_DEFAULT_DETAILS[agent] ? agent : null;
  if (type === "agent_phase" && trackedAgent) {
    collaborationBoard.classList.remove("hidden");
    if (
      activeCollaborationAgent
      && activeCollaborationAgent !== trackedAgent
    ) {
      setAgentCardState(
        activeCollaborationAgent,
        "completed",
        "已完成当前阶段，结果已交接",
      );
    }
    activeCollaborationAgent = trackedAgent;
    collaborationSummary.textContent = `${agentLabel(trackedAgent)} 正在接力执行`;
    setAgentCardState(trackedAgent, "active", event.title || "正在执行当前阶段");
    return;
  }

  if (trackedAgent && ["step", "model_waiting", "tool_start", "tool_result"].includes(type)) {
    collaborationBoard.classList.remove("hidden");
    activeCollaborationAgent = trackedAgent;
    const detail = type === "step"
      ? `正在分析第 ${event.step || "-"} 步`
      : type === "model_waiting"
        ? "正在等待模型给出下一步方案"
        : type === "tool_start"
          ? `正在使用 ${event.name || "工具"}`
          : event.ok === false
            ? `${event.name || "工具"} 执行失败`
            : `${event.name || "工具"} 已返回结果`;
    collaborationSummary.textContent = `${agentLabel(trackedAgent)} 正在工作`;
    setAgentCardState(trackedAgent, "active", detail);
    return;
  }

  if (type === "assistant" && trackedAgent) {
    const defaults = AGENT_DELIVERY_DEFAULTS[trackedAgent];
    recordAgentDelivery(trackedAgent, {
      title: defaults.title,
      content: event.content,
      artifact: defaults.artifact,
      provisional: true,
    });
    setAgentCardState(trackedAgent, "completed", "已提交本阶段工作结果");
    return;
  }

  if (type === "error") {
    if (trackedAgent) {
      setAgentCardState(trackedAgent, "error", event.message || "执行过程中出现异常");
    } else if (activeCollaborationAgent) {
      setAgentCardState(activeCollaborationAgent, "error", event.message || "执行过程中出现异常");
    }
    collaborationSummary.textContent = "协作流程遇到异常";
    return;
  }

  if (type === "cancelled" || type === "force_stopped") {
    if (activeCollaborationAgent) {
      setAgentCardState(activeCollaborationAgent, "error", "任务已被终止");
    }
    collaborationSummary.textContent = "协作流程已终止";
    return;
  }

  if (type === "done" && !collaborationBoard.classList.contains("hidden")) {
    const completed = String(event.status || "").toLowerCase() === "completed";
    if (event.answer) {
      recordAgentDelivery("orchestrator", {
        title: completed ? "任务完成，交付最终结果" : "任务结束，交付终态说明",
        content: event.answer,
        artifact: completed ? "最终执行结果" : "任务终态说明",
      });
    }
    Object.keys(AGENT_DEFAULT_DETAILS).forEach((role) => {
      const card = agentCard(role);
      if (!card || card.classList.contains("error")) return;
      setAgentCardState(
        role,
        completed ? "completed" : "",
        completed ? "已完成并交付结果" : AGENT_DEFAULT_DETAILS[role],
      );
    });
    collaborationSummary.textContent = completed
      ? "协作完成，结果已交付"
      : "协作流程已结束";
  }
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

function addEventCard(className, tag, title, body = "", scroll = true, agent = "") {
  const item = addElement(
    `event ${className} ${agentClassName(agent)}`.trim(),
    "",
    scroll,
  );
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
  resetCollaborationBoard();
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
    runTitle.textContent = phaseLabel(event.title);
    runSummary.textContent = `${agentLabel(event.agent)} 正在执行当前阶段。`;
    runPhase.textContent = phaseLabel(event.title) || agentLabel(event.agent);
    runStatus.textContent = "执行中";
    classes.push("running");
  } else if (type === "agent_handoff") {
    runKicker.textContent = "HANDOFF";
    runTitle.textContent = `${agentLabel(event.from_agent)} → ${agentLabel(event.to_agent)}`;
    runSummary.textContent = event.title || "阶段结果正在交接给下一位 Agent。";
    runPhase.textContent = "任务交接";
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
  event = normalizeEvent(event);
  if (!event || !event.type) return;
  if (event.run_id) currentRunId = event.run_id;
  updateRunOverview(event);
  updateCollaboration(event);

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
      "orchestrator",
    );
    return;
  }

  if (event.type === "agent_phase") {
    addEventCard(
      "agent-phase",
      "AGENT",
      `${agentLabel(event.agent)} · ${phaseLabel(event.title)}`,
      "",
      scroll,
      event.agent,
    );
    return;
  }

  if (event.type === "agent_handoff") {
    const item = addElement(
      `handoff ${agentClassName(event.from_agent)}`.trim(),
      "",
      scroll,
    );
    const head = document.createElement("div");
    head.className = "handoff-head";
    const tag = document.createElement("span");
    tag.className = "handoff-tag";
    tag.textContent = "HANDOFF";
    const route = document.createElement("strong");
    route.textContent = `${agentLabel(event.from_agent)} → ${agentLabel(event.to_agent)}`;
    head.append(tag, route);
    item.appendChild(head);

    const title = document.createElement("div");
    title.className = "handoff-title";
    title.textContent = event.title || "阶段结果交接";
    item.appendChild(title);

    if (event.artifact) {
      const artifact = document.createElement("div");
      artifact.className = "handoff-artifact";
      artifact.textContent = `交接产物：${event.artifact}`;
      item.appendChild(artifact);
    }

    const details = document.createElement("details");
    details.className = "handoff-details";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "查看完整交接内容";
    details.appendChild(summary);
    const content = document.createElement("div");
    content.className = "handoff-content";
    content.textContent = event.content || "本阶段没有附加文字说明。";
    details.appendChild(content);
    item.appendChild(details);
    return;
  }

  if (event.type === "step") {
    addEventCard(
      "",
      "STEP",
      `${agentLabel(event.agent)} · 第 ${event.step || "-"} 步`,
      "Agent 正在分析任务并决定下一步操作。",
      scroll,
      event.agent,
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
      event.agent,
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
      event.agent,
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
      event.agent,
    );
    return;
  }

  if (event.type === "assistant") {
    const item = addElement(`assistant ${agentClassName(event.agent)}`.trim(), "", scroll);
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
      event.agent,
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
      event.agent,
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

bindAgentCardInteractions();
closeDelivery.addEventListener("click", closeDeliveryModal);
document.querySelector("[data-close-delivery]").addEventListener("click", closeDeliveryModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !deliveryModal.classList.contains("hidden")) {
    closeDeliveryModal();
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
