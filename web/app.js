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
  prevPage: document.querySelector("#prev-page"),
  nextPage: document.querySelector("#next-page"),
  refresh: document.querySelector("#refresh"),
  title: document.querySelector("#title-filter"),
  content: document.querySelector("#content-filter"),
  cwd: document.querySelector("#cwd-filter"),
  status: document.querySelector("#status-filter"),
};

let scan = null;
let filterTimer = null;
let offset = 0;
const limit = 100;

elements.refresh.addEventListener("click", async () => {
  await rebuild();
});

elements.visibilityRefresh.addEventListener("click", async () => {
  await loadVisibility();
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

await loadDiagnostics();
await loadVisibility();
await loadThreads();

async function loadDiagnostics() {
  scan = await fetchJson("/api/diagnostics");
  renderSummary(scan);
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
  const params = new URLSearchParams();
  setParam(params, "title", elements.title.value);
  setParam(params, "content", elements.content.value);
  setParam(params, "cwd", elements.cwd.value);
  setParam(params, "status", elements.status.value);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  const data = await fetchJson(`/api/threads?${params.toString()}`);
  renderThreads(data.threads);
  renderPagination(data);
}

async function loadVisibility() {
  elements.visibilityRefresh.disabled = true;
  elements.visibilityRefresh.textContent = "Checking...";
  try {
    const data = await fetchJson("/api/visibility");
    renderVisibility(data);
  } finally {
    elements.visibilityRefresh.disabled = false;
    elements.visibilityRefresh.textContent = "Check visibility";
  }
}

function renderSummary(data) {
  elements.totalThreads.textContent = number(data.stats.totalThreads);
  elements.totalProjects.textContent = number(data.stats.totalProjects);
  elements.activeThreads.textContent = number(data.stats.activeThreads);
  elements.scanMeta.textContent = `Indexed ${data.codexHome} at ${new Date(
    data.scannedAt,
  ).toLocaleString()}`;
  elements.diagnostics.replaceChildren(
    ...data.diagnostics.map((diagnostic) => {
      const item = document.createElement("div");
      item.className = `diagnostic ${diagnostic.level}`;
      item.textContent = diagnostic.message;
      return item;
    }),
  );
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
    visibilityMetric("App server", nullableNumber(data.summary.appServerVisible)),
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
    cell.colSpan = 5;
    cell.textContent = "No matching threads.";
    row.append(cell);
    elements.threads.replaceChildren(row);
    return;
  }

  elements.threads.replaceChildren(
    ...threads.map((thread) => {
      const row = document.createElement("tr");
      row.append(
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

function renderPagination(data) {
  const start = data.totalMatches === 0 ? 0 : data.offset + 1;
  const end = Math.min(data.offset + data.threads.length, data.totalMatches);
  elements.resultCount.textContent = `${number(start)}-${number(end)} of ${number(
    data.totalMatches,
  )} matching threads`;
  elements.prevPage.disabled = data.offset <= 0;
  elements.nextPage.disabled = data.offset + data.limit >= data.totalMatches;
}

function threadCell(thread) {
  const wrapper = document.createElement("div");
  const title = document.createElement("div");
  title.className = "thread-title";
  title.textContent = thread.title || thread.id;
  const preview = document.createElement("div");
  preview.className = "preview";
  preview.textContent = thread.contentPreview || thread.rolloutPath || "No preview available.";
  wrapper.append(title, preview);
  return wrapper;
}

function statusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `status ${status}`;
  badge.textContent = status;
  return badge;
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

function number(value) {
  return new Intl.NumberFormat().format(value);
}

function nullableNumber(value) {
  return value === null ? "Not checked" : value;
}
