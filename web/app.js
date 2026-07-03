const elements = {
  scanMeta: document.querySelector("#scan-meta"),
  totalThreads: document.querySelector("#total-threads"),
  totalProjects: document.querySelector("#total-projects"),
  activeThreads: document.querySelector("#active-threads"),
  diagnostics: document.querySelector("#diagnostics"),
  visibilityMeta: document.querySelector("#visibility-meta"),
  visibilitySummary: document.querySelector("#visibility-summary"),
  visibilityProbes: document.querySelector("#visibility-probes"),
  visibilityRefresh: document.querySelector("#visibility-refresh"),
  threads: document.querySelector("#threads"),
  resultCount: document.querySelector("#result-count"),
  selectedCount: document.querySelector("#selected-count"),
  restorePlan: document.querySelector("#restore-plan"),
  restorePlanMeta: document.querySelector("#restore-plan-meta"),
  restorePlanOutput: document.querySelector("#restore-plan-output"),
  prevPage: document.querySelector("#prev-page"),
  nextPage: document.querySelector("#next-page"),
  projectColumnResizer: document.querySelector("#project-column-resizer"),
  sortButtons: Array.from(document.querySelectorAll("[data-sort-key]")),
  threadDialog: document.querySelector("#thread-dialog"),
  threadDialogTitle: document.querySelector("#thread-dialog-title"),
  threadDialogMeta: document.querySelector("#thread-dialog-meta"),
  threadDialogMessages: document.querySelector("#thread-dialog-messages"),
  threadDialogClose: document.querySelector("#thread-dialog-close"),
  refresh: document.querySelector("#refresh"),
  title: document.querySelector("#title-filter"),
  content: document.querySelector("#content-filter"),
  cwd: document.querySelector("#cwd-filter"),
  status: document.querySelector("#status-filter"),
};

let scan = null;
let filterTimer = null;
let offset = 0;
let sortKey = "updated";
let sortDirection = "desc";
const selectedThreadIds = new Set();
const limit = 100;
const projectColumnStorageKey = "codex-archiver.project-column-width";
const defaultProjectColumnWidth = 560;
const minProjectColumnWidth = 320;
const maxProjectColumnWidth = 1100;

initializeProjectColumnWidth();

elements.refresh.addEventListener("click", async () => {
  await rebuild();
});

elements.visibilityRefresh.addEventListener("click", async () => {
  await loadVisibility();
});

elements.restorePlan.addEventListener("click", async () => {
  await loadRestorePlan();
});

elements.threadDialogClose.addEventListener("click", () => {
  closeThreadDialog();
});

elements.threadDialog.addEventListener("click", (event) => {
  if (event.target === elements.threadDialog) {
    closeThreadDialog();
  }
});

for (const button of elements.sortButtons) {
  button.addEventListener("click", async () => {
    const nextKey = button.dataset.sortKey;
    if (!nextKey) {
      return;
    }
    if (sortKey === nextKey) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
      sortKey = nextKey;
      sortDirection = nextKey === "updated" || nextKey === "messages" ? "desc" : "asc";
    }
    offset = 0;
    renderSortState();
    await loadThreads();
  });
}

elements.projectColumnResizer.addEventListener("pointerdown", (event) => {
  startProjectColumnResize(event);
});

elements.projectColumnResizer.addEventListener("dblclick", () => {
  setProjectColumnWidth(defaultProjectColumnWidth);
  clearStoredProjectColumnWidth();
});

elements.projectColumnResizer.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") {
    return;
  }
  event.preventDefault();
  if (event.key === "Home") {
    setProjectColumnWidth(defaultProjectColumnWidth);
    clearStoredProjectColumnWidth();
    return;
  }
  const direction = event.key === "ArrowRight" ? 1 : -1;
  setProjectColumnWidth(currentProjectColumnWidth() + direction * 24);
});

for (const input of [elements.title, elements.content, elements.cwd, elements.status]) {
  input.addEventListener("input", () => {
    offset = 0;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(loadThreads, 150);
  });
}

elements.prevPage.addEventListener("click", async () => {
  offset = Math.max(0, offset - limit);
  await loadThreads();
});

elements.nextPage.addEventListener("click", async () => {
  offset += limit;
  await loadThreads();
});

await loadThreads();
void loadDiagnostics();
renderSortState();

function initializeProjectColumnWidth() {
  const stored = readStoredProjectColumnWidth();
  setProjectColumnWidth(stored ?? defaultProjectColumnWidth, { persist: false });
}

function startProjectColumnResize(event) {
  event.preventDefault();
  elements.projectColumnResizer.setPointerCapture?.(event.pointerId);
  const startX = event.clientX;
  const startWidth = currentProjectColumnWidth();

  function move(moveEvent) {
    setProjectColumnWidth(startWidth + moveEvent.clientX - startX);
  }

  function stop() {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  }

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}

function currentProjectColumnWidth() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--project-column-width")
    .trim();
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultProjectColumnWidth;
}

function setProjectColumnWidth(width, options = {}) {
  const persist = options.persist ?? true;
  const nextWidth = Math.max(
    minProjectColumnWidth,
    Math.min(maxProjectColumnWidth, Math.round(width)),
  );
  document.documentElement.style.setProperty("--project-column-width", `${nextWidth}px`);
  elements.projectColumnResizer.setAttribute("aria-valuemin", String(minProjectColumnWidth));
  elements.projectColumnResizer.setAttribute("aria-valuemax", String(maxProjectColumnWidth));
  elements.projectColumnResizer.setAttribute("aria-valuenow", String(nextWidth));
  if (persist) {
    localStorage.setItem(projectColumnStorageKey, String(nextWidth));
  }
}

function readStoredProjectColumnWidth() {
  const stored = Number.parseInt(localStorage.getItem(projectColumnStorageKey) ?? "", 10);
  if (!Number.isFinite(stored)) {
    return null;
  }
  return stored;
}

function clearStoredProjectColumnWidth() {
  localStorage.removeItem(projectColumnStorageKey);
}

async function loadDiagnostics() {
  elements.scanMeta.textContent = "Checking cached index freshness...";
  try {
    scan = await fetchJson("/api/diagnostics");
    renderSummary(scan);
  } catch (error) {
    elements.scanMeta.textContent = "Index diagnostics failed.";
    renderDiagnosticsError(error);
  }
}

async function rebuild() {
  elements.refresh.disabled = true;
  elements.refresh.textContent = "Refreshing...";
  try {
    scan = await fetchJson("/api/index/rebuild", {
      method: "POST",
      headers: { "X-Codex-Archiver-Intent": "local-api" },
    });
    renderSummary(scan);
    await loadThreads();
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.textContent = "Refresh";
  }
}

async function loadThreads() {
  elements.resultCount.textContent = "Loading threads...";
  elements.resultCount.classList.remove("is-error");
  const params = new URLSearchParams();
  setParam(params, "title", elements.title.value);
  setParam(params, "content", elements.content.value);
  setParam(params, "cwd", elements.cwd.value);
  setParam(params, "status", elements.status.value);
  params.set("sort", sortKey);
  params.set("direction", sortDirection);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  params.set("cache", "1");
  try {
    const data = await fetchJson(`/api/threads?${params.toString()}`);
    renderStats(data.stats);
    renderThreads(data.threads);
    renderPagination(data);
    renderSelectionState();
  } catch (error) {
    elements.resultCount.textContent = "Thread loading failed.";
    elements.resultCount.classList.add("is-error");
    renderThreadError(error);
  }
}

async function loadVisibility() {
  elements.visibilityRefresh.disabled = true;
  elements.visibilityRefresh.textContent = "Checking...";
  try {
    const data = await fetchJson("/api/visibility?includeThreads=0");
    renderVisibility(data);
  } finally {
    elements.visibilityRefresh.disabled = false;
    elements.visibilityRefresh.textContent = "Check visibility";
  }
}

function renderSummary(data) {
  renderStats(data.stats);
  if (!data.codexHome || !data.scannedAt) {
    return;
  }
  const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
  const rebuiltAt = new Date(data.scannedAt);
  const rebuiltLabel = Number.isNaN(rebuiltAt.valueOf())
    ? data.scannedAt
    : rebuiltAt.toLocaleString();
  elements.scanMeta.textContent = `Indexed ${data.codexHome} at ${rebuiltLabel}`;
  elements.diagnostics.replaceChildren(
    ...diagnostics.map((diagnostic) => {
      const item = document.createElement("div");
      item.className = `diagnostic ${diagnostic.level}`;
      item.textContent = diagnostic.message;
      return item;
    }),
  );
}

function renderStats(stats) {
  elements.totalThreads.textContent = number(stats.totalThreads);
  elements.totalProjects.textContent = number(stats.totalProjects);
  elements.activeThreads.textContent = number(stats.activeThreads);
}

function renderDiagnosticsError(error) {
  elements.diagnostics.replaceChildren(errorDiagnostic(error));
}

function renderThreadError(error) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 6;
  const wrapper = document.createElement("div");
  wrapper.className = "table-error";
  const icon = document.createElement("span");
  icon.className = "table-error-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "!";
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "Thread loading failed";
  const detail = document.createElement("p");
  detail.textContent = error instanceof Error ? error.message : String(error);
  copy.append(title, detail);
  wrapper.append(icon, copy);
  cell.append(wrapper);
  row.append(cell);
  elements.threads.replaceChildren(row);
}

function errorDiagnostic(error) {
  const item = document.createElement("div");
  item.className = "diagnostic error";
  item.textContent = error instanceof Error ? error.message : String(error);
  return item;
}

function renderVisibility(data) {
  elements.visibilityMeta.textContent = `Generated ${new Date(
    data.generatedAt,
  ).toLocaleString()} from ${data.codexHome}`;
  elements.visibilitySummary.replaceChildren(
    visibilityMetric("Active local", data.summary.activeInLocalStorage),
    visibilityMetric("Archived local", data.summary.archivedInLocalStorage),
    visibilityMetric("Missing rollout", data.summary.rolloutFileMissing),
    visibilityMetric("SQLite present", data.summary.sqlitePresent),
    visibilityMetric("Session index", nullableNumber(data.summary.sessionIndexPresent)),
    visibilityMetric("Search index", data.summary.indexedPresent),
    visibilityMetric("codex resume", nullableNumber(data.summary.codexResumeVisible)),
    visibilityMetric("Desktop app-server", nullableNumber(data.summary.appServerVisible)),
  );
  elements.visibilityProbes.replaceChildren(
    ...data.probes.map((probe) => {
      const item = document.createElement("div");
      item.className = `probe ${probe.status}`;
      const name = document.createElement("strong");
      name.textContent = probe.name;
      const message = document.createElement("span");
      message.textContent = probe.message;
      item.append(name, message);
      if (Array.isArray(probe.warnings) && probe.warnings.length > 0) {
        const warnings = document.createElement("ul");
        warnings.className = "probe-warnings";
        for (const warning of probe.warnings.slice(0, 5)) {
          const warningItem = document.createElement("li");
          warningItem.textContent = warning;
          warnings.append(warningItem);
        }
        if (probe.warnings.length > 5) {
          const warningItem = document.createElement("li");
          warningItem.textContent = `${probe.warnings.length - 5} more warning(s) omitted.`;
          warnings.append(warningItem);
        }
        item.append(warnings);
      }
      return item;
    }),
  );
}

function visibilityMetric(label, value) {
  const item = document.createElement("div");
  item.className = "visibility-metric";
  const text = document.createElement("span");
  text.textContent = label;
  const count = document.createElement("strong");
  count.textContent = typeof value === "number" ? number(value) : value;
  item.append(text, count);
  return item;
}

function renderThreads(threads) {
  if (threads.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "No matching threads.";
    row.append(cell);
    elements.threads.replaceChildren(row);
    return;
  }

  elements.threads.replaceChildren(
    ...threads.map((thread) => {
      const row = document.createElement("tr");
      row.className = "thread-row";
      row.tabIndex = 0;
      row.setAttribute("aria-label", `Open ${thread.title || thread.id}`);
      row.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("input, button")) {
          return;
        }
        void openThread(thread.id);
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        if (event.target instanceof Element && event.target.closest("input, button")) {
          return;
        }
        event.preventDefault();
        void openThread(thread.id);
      });
      row.append(
        cell(selectionCheckbox(thread)),
        cell(threadCell(thread)),
        cell(statusBadge(thread.restoreStatus)),
        cell(pathText(thread.cwd || "No project path")),
        cell(formatDate(thread.updatedAt)),
        cell(number(thread.messageCount)),
      );
      return row;
    }),
  );
}

async function loadRestorePlan() {
  const ids = Array.from(selectedThreadIds);
  if (ids.length === 0) {
    return;
  }

  elements.restorePlan.disabled = true;
  elements.restorePlan.textContent = "Planning...";
  elements.restorePlanMeta.textContent = "Building read-only dry-run restore plan...";
  try {
    const plan = await fetchJson("/api/restore/plan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Archiver-Intent": "local-api",
      },
      body: JSON.stringify({ selectedThreadIds: ids }),
    });
    renderRestorePlan(plan);
  } catch (error) {
    elements.restorePlanMeta.textContent = "Restore planning failed.";
    elements.restorePlanOutput.replaceChildren(
      restoreNote(error instanceof Error ? error.message : String(error)),
    );
  } finally {
    elements.restorePlan.textContent = "Plan restore";
    renderSelectionState();
  }
}

function renderRestorePlan(plan) {
  elements.restorePlanMeta.textContent = `Dry run generated ${new Date(
    plan.generatedAt,
  ).toLocaleString()}. No backups or Codex mutations were performed.`;
  elements.restorePlanOutput.replaceChildren(
    restorePreflight(plan.preflight),
    restoreSummary(plan.impactPreview),
    restoreNote(
      `Future apply would require backups under ${plan.backupPreview.plannedBackupRoot}. This dry run created none.`,
    ),
    restoreBackupPreview(plan.backupPreview),
    restoreReportPreview(plan.reportPreview),
    ...plan.items.map(restorePlanItem),
  );
}

function restorePreflight(preflight) {
  const wrapper = document.createElement("div");
  wrapper.className = "preflight";
  const header = document.createElement("div");
  header.className = "preflight-header";
  const title = document.createElement("strong");
  title.textContent = "Preflight";
  const summary = document.createElement("span");
  summary.textContent = `${preflight.summary.failed} failed, ${preflight.summary.warning} warning, ${preflight.summary.unknown} unknown`;
  header.append(title, summary);
  wrapper.append(header);
  wrapper.append(
    ...preflight.checks.map((check) => {
      const item = document.createElement("div");
      item.className = `preflight-check ${check.status}`;
      const label = document.createElement("strong");
      label.textContent = check.label;
      const status = document.createElement("span");
      status.textContent = check.status;
      const detail = document.createElement("p");
      detail.textContent = check.evidence[0] || check.remediation;
      item.append(label, status, detail);
      return item;
    }),
  );
  return wrapper;
}

function restoreSummary(impact) {
  const wrapper = document.createElement("div");
  wrapper.className = "restore-summary";
  wrapper.append(
    visibilityMetric("Selected", impact.selectedCount),
    visibilityMetric("Future apply", impact.futureApplyCount),
    visibilityMetric("Diagnostics", impact.diagnosticOnlyCount),
    visibilityMetric("Blocked", impact.blockedCount),
    visibilityMetric("No-op/rejected", impact.noopCount + impact.rejectedCount),
  );
  return wrapper;
}

function restorePlanItem(item) {
  const wrapper = document.createElement("article");
  wrapper.className = "restore-item";
  const header = document.createElement("div");
  header.className = "restore-item-header";
  const title = document.createElement("h3");
  title.textContent = item.title || item.threadId;
  const badge = document.createElement("span");
  badge.className = `classification ${item.actionability}`;
  badge.textContent = item.actionability;
  header.append(title, badge);
  wrapper.append(header);
  wrapper.append(reasonList("Reasons", item.reasons));
  if (item.futureActions.length > 0) {
    wrapper.append(reasonList("Future actions", item.futureActions));
  }
  if (item.backupPreview.length > 0) {
    wrapper.append(reasonList("Backup preview", item.backupPreview.slice(0, 6)));
  }
  const issues = item.validations.filter(
    (validation) => validation.status === "failed" || validation.status === "warning",
  );
  if (issues.length > 0) {
    wrapper.append(reasonList("Validation", issues.map((validation) => validation.message)));
  }
  return wrapper;
}

function restoreBackupPreview(backupPreview) {
  const wrapper = document.createElement("div");
  wrapper.className = "restore-note";
  const existing = backupPreview.targets.filter((target) => target.exists).length;
  const missing = backupPreview.targets.length - existing;
  wrapper.textContent = `Backup manifest preview: ${existing} existing target(s), ${missing} missing/non-file target(s), report-only hashes for small files.`;
  return wrapper;
}

function restoreReportPreview(reportPreview) {
  const wrapper = document.createElement("div");
  wrapper.className = "restore-note";
  wrapper.textContent = `Report preview: ${reportPreview.requiredFields.length} required fields planned at ${reportPreview.plannedReportPath}. No report was written.`;
  return wrapper;
}

function reasonList(label, values) {
  const list = document.createElement("ul");
  list.setAttribute("aria-label", label);
  for (const value of values) {
    const item = document.createElement("li");
    item.textContent = value;
    list.append(item);
  }
  return list;
}

function restoreNote(text) {
  const note = document.createElement("div");
  note.className = "restore-note";
  note.textContent = text;
  return note;
}

function renderPagination(data) {
  const start = data.totalMatches === 0 ? 0 : data.offset + 1;
  const end = Math.min(data.offset + data.threads.length, data.totalMatches);
  elements.resultCount.textContent = `${number(start)}-${number(end)} of ${number(
    data.totalMatches,
  )} matching threads`;
  elements.prevPage.disabled = data.offset <= 0;
  elements.nextPage.disabled = data.offset + data.limit >= data.totalMatches;
}

function selectionCheckbox(thread) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = selectedThreadIds.has(thread.id);
  checkbox.setAttribute("aria-label", `Select ${thread.title || thread.id}`);
  checkbox.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      selectedThreadIds.add(thread.id);
    } else {
      selectedThreadIds.delete(thread.id);
    }
    renderSelectionState();
  });
  return checkbox;
}

function renderSelectionState() {
  const selectedCount = selectedThreadIds.size;
  elements.selectedCount.textContent = `${number(selectedCount)} selected`;
  elements.restorePlan.disabled = selectedCount === 0;
}

function threadCell(thread) {
  const wrapper = document.createElement("div");
  wrapper.className = "thread-cell";
  const title = document.createElement("div");
  title.className = "thread-title";
  title.textContent = thread.title || thread.id;
  const preview = document.createElement("div");
  preview.className = "preview";
  preview.textContent = thread.contentPreview || thread.rolloutPath || "No preview available.";
  wrapper.append(title, preview);
  return wrapper;
}

async function openThread(threadId) {
  elements.threadDialogTitle.textContent = "Loading thread...";
  elements.threadDialogMeta.textContent = "";
  elements.threadDialogMessages.replaceChildren(restoreNote("Loading messages..."));
  showThreadDialog();
  try {
    const detail = await fetchJson(`/api/thread?id=${encodeURIComponent(threadId)}`);
    renderThreadDialog(detail);
  } catch (error) {
    elements.threadDialogTitle.textContent = "Thread loading failed";
    elements.threadDialogMeta.textContent = error instanceof Error ? error.message : String(error);
    elements.threadDialogMessages.replaceChildren();
  }
}

function renderThreadDialog(detail) {
  const thread = detail.thread;
  elements.threadDialogTitle.textContent = thread.title || thread.id;
  elements.threadDialogMeta.textContent = [
    statusLabel(thread.restoreStatus),
    thread.cwd || "No project path",
    `${number(thread.messageCount)} message(s)`,
    formatDate(thread.updatedAt),
  ].join(" · ");

  const messages = Array.isArray(detail.messages) ? detail.messages : [];
  if (messages.length === 0) {
    elements.threadDialogMessages.replaceChildren(
      restoreNote("No user or assistant messages were found in readable rollout files."),
    );
  } else {
    elements.threadDialogMessages.replaceChildren(...messages.map(threadMessage));
  }
  elements.threadDialogMessages.scrollTop = 0;
}

function threadMessage(message) {
  const item = document.createElement("article");
  item.className = `thread-message ${message.role}`;
  const header = document.createElement("div");
  header.className = "thread-message-header";
  const role = document.createElement("strong");
  role.textContent = message.role === "assistant" ? "Assistant" : "User";
  const timestamp = document.createElement("span");
  timestamp.textContent = formatTimestamp(message.timestamp);
  header.append(role, timestamp);
  const text = document.createElement("p");
  text.textContent = message.text || "(empty message)";
  item.append(header, text);
  return item;
}

function showThreadDialog() {
  if (typeof elements.threadDialog.showModal === "function" && !elements.threadDialog.open) {
    elements.threadDialog.showModal();
  } else {
    elements.threadDialog.setAttribute("open", "");
  }
  requestAnimationFrame(() => {
    elements.threadDialogMessages.scrollTop = 0;
  });
}

function closeThreadDialog() {
  if (typeof elements.threadDialog.close === "function") {
    elements.threadDialog.close();
  } else {
    elements.threadDialog.removeAttribute("open");
  }
}

function renderSortState() {
  for (const button of elements.sortButtons) {
    const active = button.dataset.sortKey === sortKey;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.dataset.direction = active ? sortDirection : "";
    const label = button.textContent?.replace(/\s+[↑↓]$/, "") ?? "";
    button.textContent = active ? `${label} ${sortDirection === "asc" ? "↑" : "↓"}` : label;
  }
}

function statusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `status ${status}`;
  badge.textContent = statusLabel(status);
  badge.title = statusHelp(status);
  return badge;
}

function statusLabel(status) {
  return (
    {
      active: "Local active",
      archived: "Archived",
      hidden: "Hidden",
      orphaned: "Orphaned",
      restorable: "Restorable",
      unknown: "Unknown",
    }[status] ?? status
  );
}

function statusHelp(status) {
  return (
    {
      active:
        "Unarchived local Codex state with an active rollout file. This does not prove Codex Desktop shows it in the sidebar.",
      archived: "Archived local Codex state with archived rollout evidence.",
      hidden: "Active-session rollout evidence that is not fully represented in SQLite.",
      orphaned: "SQLite row whose rollout file is missing.",
      restorable: "Archived JSONL evidence without a matching SQLite row.",
      unknown: "The scanner could not classify this thread state.",
    }[status] ?? "Local restore status."
  );
}

function pathText(value) {
  const path = document.createElement("div");
  path.className = "path";
  path.textContent = value;
  return path;
}

function cell(value) {
  const td = document.createElement("td");
  if (value instanceof Node) {
    td.append(value);
  } else {
    td.textContent = value;
  }
  return td;
}

function setParam(params, key, value) {
  if (value && value !== "all") {
    params.set(key, value);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function formatDate(epoch) {
  if (!epoch) {
    return "-";
  }
  return new Date(epoch * 1000).toLocaleString();
}

function formatTimestamp(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function number(value) {
  return new Intl.NumberFormat().format(value);
}

function nullableNumber(value) {
  return value === null ? "Not checked" : value;
}
