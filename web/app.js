const elements = {
  scanMeta: document.querySelector("#scan-meta"),
  totalThreads: document.querySelector("#total-threads"),
  totalProjects: document.querySelector("#total-projects"),
  activeThreads: document.querySelector("#active-threads"),
  diagnostics: document.querySelector("#diagnostics"),
  threads: document.querySelector("#threads"),
  refresh: document.querySelector("#refresh"),
  title: document.querySelector("#title-filter"),
  content: document.querySelector("#content-filter"),
  cwd: document.querySelector("#cwd-filter"),
  status: document.querySelector("#status-filter"),
};

let scan = null;
let filterTimer = null;

elements.refresh.addEventListener("click", async () => {
  await rebuild();
});

for (const input of [elements.title, elements.content, elements.cwd, elements.status]) {
  input.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(loadThreads, 150);
  });
}

await loadDiagnostics();
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
  const data = await fetchJson(`/api/threads?${params.toString()}`);
  renderThreads(data.threads);
}

function renderSummary(data) {
  elements.totalThreads.textContent = number(data.stats.totalThreads);
  elements.totalProjects.textContent = number(data.stats.totalProjects);
  elements.activeThreads.textContent = number(data.stats.activeThreads);
  elements.scanMeta.textContent = `Scanned ${data.codexHome} at ${new Date(
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
