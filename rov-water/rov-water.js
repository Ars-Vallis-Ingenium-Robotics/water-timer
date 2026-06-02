const API_BASE = "/api";
const RESET_HISTORY_LIMIT = 3;
const RUN_HISTORY_LIMIT = 5;

const TIMERS = [
  {
    id: "rov",
    name: "ROSIE",
    description: "ROSIE time in water",
    statusLabel: "ROSIE is the main vehicle timer.",
    storageKey: null,
  },
  {
    id: "float",
    name: "ADAM",
    description: "ADAM time in water",
    statusLabel: "ADAM is the vertical profiling float timer.",
    storageKey: null,
  },
];

const timerGrid = document.getElementById("timerGrid");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const passwordInput = document.getElementById("passwordInput");
const justificationInput = document.getElementById("justificationInput");
const errorText = document.getElementById("errorText");
const cancelPasswordBtn = document.getElementById("cancelPasswordBtn");
const confirmPasswordBtn = document.getElementById("confirmPasswordBtn");

const state = new Map();
const expandedResetHistory = new Set();
let pendingResetId = null;
let syncInFlight = null;
let lastSyncError = "";

function now() {
  return Date.now();
}

function defaultTimerState() {
  return {
    running: false,
    startedAt: null,
    overallMs: 0,
    currentRunMs: 0,
    lastResetAt: null,
    resetHistory: [],
    runHistory: [],
  };
}

function normalizeResetHistory(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((entry) => ({
      at: typeof entry?.at === "number" ? entry.at : null,
      runMs: Number.isFinite(entry?.runMs) ? entry.runMs : null,
      justification: typeof entry?.justification === "string" ? entry.justification.trim() : "",
    }))
    .filter((entry) => entry.at !== null && entry.runMs !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, RESET_HISTORY_LIMIT);
}

function normalizeRunHistory(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((entry) => ({
      at: typeof entry?.at === "number" ? entry.at : null,
      runMs: Number.isFinite(entry?.runMs) ? entry.runMs : null,
    }))
    .filter((entry) => entry.at !== null && entry.runMs !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, RUN_HISTORY_LIMIT);
}

function normalizeTimerState(raw) {
  const base = defaultTimerState();
  if (!raw || typeof raw !== "object") return base;

  base.running = Boolean(raw.running);
  base.startedAt = typeof raw.startedAt === "number" ? raw.startedAt : null;
  base.overallMs = Number.isFinite(raw.overallMs) ? raw.overallMs : 0;
  base.currentRunMs = Number.isFinite(raw.currentRunMs) ? raw.currentRunMs : 0;
  base.lastResetAt = typeof raw.lastResetAt === "number" ? raw.lastResetAt : null;
  base.resetHistory = normalizeResetHistory(raw.resetHistory);
  base.runHistory = normalizeRunHistory(raw.runHistory);
  return base;
}

function liveDelta(timerState) {
  if (!timerState.running || typeof timerState.startedAt !== "number") return 0;
  return Math.max(0, now() - timerState.startedAt);
}

function getOverallMs(timerState) {
  return timerState.overallMs + liveDelta(timerState);
}

function getCurrentRunMs(timerState) {
  return timerState.currentRunMs + liveDelta(timerState);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatDate(timestamp) {
  if (!timestamp) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function renderResetHistory(timerState, historyList) {
  historyList.innerHTML = "";

  if (!timerState.resetHistory.length) {
    const empty = document.createElement("li");
    empty.className = "historyEmpty";
    empty.textContent = "No resets yet.";
    historyList.appendChild(empty);
    return;
  }

  timerState.resetHistory.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "resetHistoryItem";

    const value = document.createElement("span");
    value.className = "resetHistoryValue";
    value.textContent = formatDuration(entry.runMs);

    const date = document.createElement("span");
    date.className = "resetHistoryDate";
    date.textContent = ` — ${formatDate(entry.at)}`;

    item.append(value, date);

    if (entry.justification) {
      const note = document.createElement("div");
      note.className = "resetHistoryJustification";
      note.textContent = `Justification: ${entry.justification}`;
      item.appendChild(note);
    }

    historyList.appendChild(item);
  });
}

function renderRunHistory(timerState, historyList) {
  historyList.innerHTML = "";

  if (!timerState.runHistory.length) {
    const empty = document.createElement("li");
    empty.className = "historyEmpty";
    empty.textContent = "No completed runs yet.";
    historyList.appendChild(empty);
    return;
  }

  timerState.runHistory.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "runHistoryItem";

    const value = document.createElement("span");
    value.className = "runHistoryValue";
    value.textContent = formatDuration(entry.runMs);

    const date = document.createElement("span");
    date.className = "runHistoryDate";
    date.textContent = ` — ${formatDate(entry.at)}`;

    item.append(value, date);
    historyList.appendChild(item);
  });
}

function renderTimer(timerDef) {
  const timerState = state.get(timerDef.id) || defaultTimerState();
  const card = document.querySelector(`[data-timer-card="${timerDef.id}"]`);
  if (!card) return;

  const overallValue = card.querySelector("[data-overall-value]");
  const currentValue = card.querySelector("[data-current-value]");
  const status = card.querySelector("[data-timer-status]");
  const actionBtn = card.querySelector("[data-toggle-btn]");
  const lastReset = card.querySelector("[data-last-reset]");
  const resetSummary = card.querySelector("[data-reset-summary]");
  const resetHistoryList = card.querySelector("[data-reset-history]");
  const resetMoreBtn = card.querySelector("[data-reset-more-btn]");
  const runHistoryList = card.querySelector("[data-run-history]");

  overallValue.textContent = formatDuration(getOverallMs(timerState));
  currentValue.textContent = formatDuration(getCurrentRunMs(timerState));
  status.textContent = timerState.running
    ? `${timerDef.statusLabel} Running since ${formatDate(timerState.startedAt)}.`
    : `${timerDef.statusLabel} Paused.`;
  actionBtn.textContent = timerState.running ? "Pause" : "Start";
  lastReset.textContent = formatDate(timerState.lastResetAt);

  const latestReset = timerState.resetHistory[0] || null;
  if (latestReset) {
    resetSummary.innerHTML = "";
    const summaryValue = document.createElement("span");
    summaryValue.className = "resetSummaryValue";
    summaryValue.textContent = formatDuration(latestReset.runMs);
    const summaryDate = document.createElement("span");
    summaryDate.className = "resetSummaryDate";
    summaryDate.textContent = ` — ${formatDate(latestReset.at)}`;
    resetSummary.append(summaryValue, summaryDate);

    if (latestReset.justification) {
      const summaryJustification = document.createElement("div");
      summaryJustification.className = "resetSummaryJustification";
      summaryJustification.textContent = `Justification: ${latestReset.justification}`;
      resetSummary.appendChild(summaryJustification);
    }
  } else {
    resetSummary.textContent = "No resets yet.";
  }

  const canExpandResets = timerState.resetHistory.length > 1;
  const expanded = expandedResetHistory.has(timerDef.id);
  resetMoreBtn.hidden = !canExpandResets;
  resetMoreBtn.textContent = expanded ? "Hide more resets" : "See more resets";
  resetHistoryList.hidden = !expanded || !canExpandResets;

  renderResetHistory(timerState, resetHistoryList);
  renderRunHistory(timerState, runHistoryList);
}

function renderAll() {
  TIMERS.forEach(renderTimer);

  const syncPill = document.querySelector("[data-sync-pill]");
  const syncText = document.querySelector("[data-sync-text]");
  if (syncPill && syncText) {
    if (lastSyncError) {
      syncPill.textContent = "Sync issue";
      syncText.textContent = lastSyncError;
    } else {
      syncPill.textContent = "Shared server state";
      syncText.textContent = "Everyone sees the same timer data.";
    }
  }
}

function buildCard(timerDef) {
  const card = document.createElement("article");
  card.className = "timerCard";
  card.dataset.timerCard = timerDef.id;
  card.innerHTML = `
    <div class="timerTop">
      <span class="badge">${timerDef.name}</span>
      <span class="smallPill">Time in water</span>
    </div>

    <h2 class="timerName">${timerDef.description}</h2>

    <div class="timerMetrics">
      <div class="metric">
        <p class="metricLabel">Overall</p>
        <div class="metricValue" data-overall-value>00:00:00</div>
        <p class="metricHint">Lifetime total.</p>
      </div>

      <div class="metric">
        <p class="metricLabel">Current run</p>
        <div class="metricValue" data-current-value>00:00:00</div>
        <p class="metricHint">Resets on Start.</p>
      </div>
    </div>

    <p class="timerStatus" data-timer-status></p>

    <div class="metaRow">
      <span class="smallPill">Last reset: <strong data-last-reset></strong></span>
    </div>

    <div class="historyBlock">
      <div class="historyHeader">
        <span class="smallPill">Last runs</span>
      </div>
      <ul class="runHistory" data-run-history></ul>
    </div>

    <div class="historyBlock">
      <div class="historyHeader">
        <span class="smallPill">Last lifetime reset</span>
        <button type="button" class="btn btnGhost compactBtn" data-reset-more-btn hidden>See more resets</button>
      </div>
      <div class="resetSummary" data-reset-summary></div>
      <ul class="resetHistory" data-reset-history hidden></ul>
    </div>

    <div class="timerActions">
      <button type="button" class="btn" data-toggle-btn>Start</button>
      <button type="button" class="btn btnGhost" data-reset-btn>Reset</button>
    </div>
  `;

  const toggleBtn = card.querySelector("[data-toggle-btn]");
  const resetBtn = card.querySelector("[data-reset-btn]");
  const resetMoreBtn = card.querySelector("[data-reset-more-btn]");

  toggleBtn.addEventListener("click", () => toggleTimer(timerDef));
  resetBtn.addEventListener("click", () => openPasswordModal(timerDef.id));
  resetMoreBtn.addEventListener("click", () => toggleResetHistory(timerDef.id));

  return card;
}

async function apiJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }

  return payload;
}

function applyServerTimers(timers) {
  TIMERS.forEach((timerDef) => {
    state.set(timerDef.id, normalizeTimerState(timers?.[timerDef.id]));
  });
}

async function syncState() {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    try {
      const payload = await apiJson(`${API_BASE}/state`);
      applyServerTimers(payload?.timers);
      lastSyncError = "";
    } catch (error) {
      lastSyncError = error?.message || "Unable to reach the timer server.";
      console.error(error);
    } finally {
      syncInFlight = null;
      renderAll();
    }
  })();

  return syncInFlight;
}

async function toggleTimer(timerDef) {
  try {
    await apiJson(`${API_BASE}/timers/${timerDef.id}/toggle`, { method: "POST" });
    await syncState();
  } catch (error) {
    lastSyncError = error?.message || "Could not update the timer.";
    renderAll();
  }
}

function openPasswordModal(timerId) {
  const timerDef = TIMERS.find((timer) => timer.id === timerId);
  if (!timerDef) return;

  pendingResetId = timerId;
  modalTitle.textContent = `Reset ${timerDef.name}`;
  modalBody.textContent = `Enter the password and a justification to reset the ${timerDef.name} timer.`;
  errorText.textContent = "";
  passwordInput.value = "";
  justificationInput.value = "";
  modalBackdrop.hidden = false;
  passwordInput.focus();
}

function closePasswordModal() {
  pendingResetId = null;
  modalBackdrop.hidden = true;
  errorText.textContent = "";
  justificationInput.value = "";
}

function toggleResetHistory(timerId) {
  if (expandedResetHistory.has(timerId)) {
    expandedResetHistory.delete(timerId);
  } else {
    expandedResetHistory.add(timerId);
  }
  renderAll();
}

async function confirmPassword() {
  if (!pendingResetId) return;

  const justification = justificationInput.value.trim();
  if (!justification) {
    errorText.textContent = "Justification is required.";
    justificationInput.focus();
    return;
  }

  try {
    await apiJson(`${API_BASE}/timers/${pendingResetId}/reset`, {
      method: "POST",
      body: JSON.stringify({ password: passwordInput.value, justification }),
    });
    closePasswordModal();
    await syncState();
  } catch (error) {
    errorText.textContent = error?.message || "Reset failed.";
    passwordInput.select();
  }
}

function initialize() {
  timerGrid.innerHTML = "";

  TIMERS.forEach((timerDef) => {
    state.set(timerDef.id, defaultTimerState());
    timerGrid.appendChild(buildCard(timerDef));
  });

  renderAll();
  syncState();
  setInterval(renderAll, 1000);
  setInterval(syncState, 5000);
}

cancelPasswordBtn.addEventListener("click", closePasswordModal);
confirmPasswordBtn.addEventListener("click", confirmPassword);
passwordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") confirmPassword();
  if (event.key === "Escape") closePasswordModal();
});

justificationInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePasswordModal();
});

modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closePasswordModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalBackdrop.hidden) {
    closePasswordModal();
  }
});

initialize();
