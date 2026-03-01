const $ = (sel) => document.querySelector(sel);
const historyBody = $("#historyBody");
const pagination = $("#pagination");
const emptyState = $("#emptyState");
const historyList = $("#historyList");
const detailPanel = $("#detailPanel");
const errorBox = $("#error");

let currentPage = 1;
let selectedId = null;

// ── Load history list ───────────────────────────────────────

async function loadHistory(page = 1) {
  try {
    const resp = await fetch(`/api/history?page=${page}&per_page=20`);
    if (!resp.ok) throw new Error("Failed to load history");
    const data = await resp.json();
    currentPage = page;
    renderList(data);
  } catch (e) {
    showError(e.message);
  }
}

function renderList(data) {
  if (data.total === 0) {
    historyList.style.display = "none";
    emptyState.style.display = "block";
    return;
  }

  historyList.style.display = "block";
  emptyState.style.display = "none";
  historyBody.innerHTML = "";

  for (const item of data.items) {
    const tr = document.createElement("tr");
    tr.dataset.id = item.id;
    if (item.id === selectedId) tr.classList.add("active");

    tr.innerHTML = `
      <td>${item.id}</td>
      <td>${escHtml(item.model)}</td>
      <td class="prompt-cell" title="${escHtml(item.prompt)}">${escHtml(item.prompt)}</td>
      <td>${item.is_json ? '<span class="badge badge-json">JSON</span>' : '<span class="badge badge-text">Text</span>'}</td>
      <td>${formatDuration(item.duration_ms)}</td>
      <td>${formatTime(item.created_at)}</td>
    `;
    tr.addEventListener("click", () => loadDetail(item.id));
    historyBody.appendChild(tr);
  }

  renderPagination(data);
}

function renderPagination(data) {
  const totalPages = Math.ceil(data.total / data.per_page);
  if (totalPages <= 1) {
    pagination.innerHTML = "";
    return;
  }

  pagination.innerHTML = `
    <button class="btn-secondary" ${data.page <= 1 ? "disabled" : ""} id="prevBtn">Prev</button>
    <span>Page ${data.page} of ${totalPages}</span>
    <button class="btn-secondary" ${data.page >= totalPages ? "disabled" : ""} id="nextBtn">Next</button>
  `;

  const prevBtn = $("#prevBtn");
  const nextBtn = $("#nextBtn");
  if (prevBtn) prevBtn.addEventListener("click", () => loadHistory(currentPage - 1));
  if (nextBtn) nextBtn.addEventListener("click", () => loadHistory(currentPage + 1));
}

// ── Load detail ─────────────────────────────────────────────

async function loadDetail(id) {
  selectedId = id;

  // Highlight active row
  historyBody.querySelectorAll("tr").forEach((tr) => {
    tr.classList.toggle("active", Number(tr.dataset.id) === id);
  });

  try {
    const resp = await fetch(`/api/history/${id}`);
    if (!resp.ok) throw new Error("Failed to load inference detail");
    const data = await resp.json();
    renderDetail(data);
  } catch (e) {
    showError(e.message);
  }
}

function renderDetail(data) {
  detailPanel.classList.add("visible");

  $("#detailImg").src = `data:${data.image_mime};base64,${data.image_b64}`;
  $("#detailModel").textContent = data.model;
  $("#detailDuration").textContent = formatDuration(data.duration_ms);
  $("#detailTime").textContent = formatTime(data.created_at);
  $("#detailPrompt").textContent = data.prompt;
  $("#detailResponse").textContent = data.response_text;

  if (data.is_json) {
    $("#detailBadge").innerHTML = '<span class="badge badge-json">JSON</span>';
    const jsonSection = $("#detailJsonSection");
    const jsonBody = $("#detailJsonBody");
    jsonSection.style.display = "block";
    jsonBody.innerHTML = "";
    renderJsonRows(data.parsed_json, jsonBody, "");
  } else {
    $("#detailBadge").innerHTML = '<span class="badge badge-text">Text</span>';
    $("#detailJsonSection").style.display = "none";
  }

  // Re-run link
  const params = new URLSearchParams({ model: data.model, prompt: data.prompt });
  $("#rerunLink").href = `/?${params.toString()}`;

  // Delete handler
  $("#deleteBtn").onclick = () => deleteInference(data.id);

  // Copy handler
  $("#detailCopy").onclick = () => {
    navigator.clipboard.writeText(data.response_text).then(() => {
      $("#detailCopy").textContent = "Copied!";
      setTimeout(() => ($("#detailCopy").textContent = "Copy"), 1500);
    });
  };
}

// ── Delete ──────────────────────────────────────────────────

async function deleteInference(id) {
  if (!confirm("Delete this inference record?")) return;

  try {
    const resp = await fetch(`/api/history/${id}`, { method: "DELETE" });
    if (!resp.ok) throw new Error("Failed to delete");
    selectedId = null;
    detailPanel.classList.remove("visible");
    loadHistory(currentPage);
  } catch (e) {
    showError(e.message);
  }
}

// ── JSON renderer (shared logic with app.js) ────────────────

function renderJsonRows(obj, tbody, prefix) {
  if (typeof obj !== "object" || obj === null) return;

  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj);

  for (const [key, value] of entries) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const tr = document.createElement("tr");
    const type = getJsonType(value);

    if (type === "object" || type === "array") {
      tr.innerHTML = `
        <td class="key">${escHtml(fullKey)}</td>
        <td class="value">${type === "array" ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`}</td>
        <td class="type">${type}</td>
      `;
      tbody.appendChild(tr);
      renderJsonRows(value, tbody, fullKey);
    } else {
      tr.innerHTML = `
        <td class="key">${escHtml(fullKey)}</td>
        <td class="value">${escHtml(formatValue(value))}</td>
        <td class="type">${type}</td>
      `;
      tbody.appendChild(tr);
    }
  }
}

function getJsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function formatValue(v) {
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

// ── Helpers ─────────────────────────────────────────────────

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add("visible");
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso) {
  const d = new Date(iso + "Z");
  return d.toLocaleString();
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Init ────────────────────────────────────────────────────

loadHistory(1);
