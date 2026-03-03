// ── DOM refs ────────────────────────────────────────────────
const dropZone = $("#dropZone");
const fileInput = $("#fileInput");
const modelSel = $("#model");
const promptEl = $("#prompt");
const runBtn = $("#runBtn");
const clearBtn = $("#clearBtn");
const elapsedEl = $("#elapsed");
const responseSection = $("#responseSection");
const responseText = $("#responseText");
const respBadge = $("#respBadge");
const respDuration = $("#respDuration");
const jsonSection = $("#jsonSection");
const jsonBody = $("#jsonBody");
const copyBtn = $("#copyBtn");
const abortBtn = $("#abortBtn");

// History refs
const historyBody = $("#historyBody");
const paginationEl = $("#pagination");
const emptyState = $("#emptyState");
const historyList = $("#historyList");
const detailPanel = $("#detailPanel");

let selectedFile = null;
let elapsedTimer = null;
let currentPage = 1;
let selectedId = null;
let inferTimeout = null;

// ── Image handling ──────────────────────────────────────────

setupDropZone(
  dropZone, fileInput,
  (file) => { selectedFile = file; updateRunBtn(); },
  () => { selectedFile = null; fileInput.value = ""; updateRunBtn(); }
);

function updateRunBtn() {
  runBtn.disabled = !selectedFile || !modelSel.value;
}
modelSel.addEventListener("change", updateRunBtn);

// ── Pre-fill from URL params ────────────────────────────────

function prefillFromParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("model")) {
    const trySelect = () => {
      const opt = modelSel.querySelector(`option[value="${params.get("model")}"]`);
      if (opt) opt.selected = true;
    };
    setTimeout(trySelect, 500);
  }
  if (params.get("prompt")) {
    promptEl.value = params.get("prompt");
  }
}

// ── Run inference ───────────────────────────────────────────

runBtn.addEventListener("click", runInference);

async function runInference() {
  if (!selectedFile || !modelSel.value) return;

  hideError();
  runBtn.disabled = true;
  runBtn.innerHTML = '<span class="spinner"></span>Running...';
  abortBtn.style.display = "inline-block";
  responseSection.classList.remove("visible");

  let seconds = 0;
  const timeoutLabel = inferTimeout ? `timeout after ${formatElapsed(inferTimeout)}` : "";
  elapsedEl.textContent = timeoutLabel ? `0s · ${timeoutLabel}` : "0s";
  elapsedTimer = setInterval(() => {
    seconds++;
    const elapsed = formatElapsed(seconds);
    elapsedEl.textContent = timeoutLabel ? `${elapsed} · ${timeoutLabel}` : elapsed;
  }, 1000);

  const formData = new FormData();
  formData.append("image", selectedFile);
  formData.append("prompt", promptEl.value);
  formData.append("model", modelSel.value);

  try {
    const resp = await fetch("/api/infer", { method: "POST", body: formData });
    clearInterval(elapsedTimer);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `Inference failed (${resp.status})`);
    }

    const data = await resp.json();
    showResponse(data);
    loadHistory(1);
  } catch (e) {
    clearInterval(elapsedTimer);
    showError(e.message);
    loadHistory(1);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Run Inference";
    abortBtn.style.display = "none";
    abortBtn.disabled = false;
    abortBtn.textContent = "Abort";
    updateRunBtn();
  }
}

abortBtn.addEventListener("click", async () => {
  abortBtn.disabled = true;
  abortBtn.textContent = "Aborting...";
  try {
    await fetch("/api/infer/abort", { method: "POST" });
  } catch (e) {
    // Ignore - the /api/infer response will handle it
  }
});

// ── Display response ────────────────────────────────────────

function statusBadge(item) {
  const s = item.status || "success";
  if (s === "timeout") return '<span class="badge badge-timeout">Timeout</span>';
  if (s === "aborted") return '<span class="badge badge-aborted">Aborted</span>';
  if (s === "error") return '<span class="badge badge-error">Error</span>';
  return item.is_json
    ? '<span class="badge badge-json">JSON</span>'
    : '<span class="badge badge-text">Text</span>';
}

function statusMessage(data) {
  const s = data.status || "success";
  if (s === "timeout") return `Inference timed out after ${formatDuration(data.duration_ms)}`;
  if (s === "aborted") return "Inference was aborted by user";
  if (s === "error") return data.response_text || "Inference failed with an error";
  return null;
}

function showResponse(data) {
  const msg = statusMessage(data);
  if (msg) {
    responseSection.classList.remove("visible");
    showError(msg);
    return;
  }

  responseSection.classList.add("visible");
  responseText.textContent = data.response_text;
  respDuration.textContent = formatDuration(data.duration_ms);
  respBadge.innerHTML = statusBadge(data);

  if (data.is_json) {
    jsonSection.style.display = "block";
    jsonBody.innerHTML = "";
    renderJsonRows(data.parsed_json, jsonBody, "");
  } else {
    jsonSection.style.display = "none";
  }
}

// ── Copy & Clear ────────────────────────────────────────────

copyBtn.addEventListener("click", () => copyToClipboard(responseText.textContent, copyBtn));

clearBtn.addEventListener("click", () => {
  selectedFile = null;
  fileInput.value = "";
  dropZone.innerHTML = "<p>Drop image here<br>or click to browse</p>";
  promptEl.value = "";
  responseSection.classList.remove("visible");
  hideError();
  elapsedEl.textContent = "";
  updateRunBtn();
});

// ── History list ────────────────────────────────────────────

async function loadHistory(page = 1) {
  try {
    const resp = await fetch(`/api/history?page=${page}&per_page=20`);
    if (!resp.ok) throw new Error("Failed to load history");
    const data = await resp.json();
    currentPage = page;
    renderHistoryList(data);
  } catch (e) {
    // Silent fail for history — don't block inference
  }
}

function renderHistoryList(data) {
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
      <td>${statusBadge(item)}</td>
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
    paginationEl.innerHTML = "";
    return;
  }

  paginationEl.innerHTML = `
    <button class="btn-secondary" ${data.page <= 1 ? "disabled" : ""} id="prevBtn">Prev</button>
    <span>Page ${data.page} of ${totalPages}</span>
    <button class="btn-secondary" ${data.page >= totalPages ? "disabled" : ""} id="nextBtn">Next</button>
  `;

  const prevBtn = $("#prevBtn");
  const nextBtn = $("#nextBtn");
  if (prevBtn) prevBtn.addEventListener("click", () => loadHistory(currentPage - 1));
  if (nextBtn) nextBtn.addEventListener("click", () => loadHistory(currentPage + 1));
}

// ── History detail ──────────────────────────────────────────

async function loadDetail(id) {
  selectedId = id;
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

  const notice = $("#detailStatusNotice");
  const respHeader = detailPanel.querySelector(".response-header");
  const respText = $("#detailResponse");
  const djSection = $("#detailJsonSection");
  const copyEl = $("#detailCopy");

  const msg = statusMessage(data);
  if (msg) {
    // Non-success: show status notice, hide response
    const colorClass = data.status === "aborted" ? "status-notice-warn" : "status-notice-error";
    notice.className = `status-notice ${colorClass}`;
    notice.textContent = msg;
    notice.style.display = "block";
    respHeader.style.display = "none";
    respText.style.display = "none";
    djSection.style.display = "none";
    copyEl.style.display = "none";
  } else {
    // Success: show response, hide notice
    notice.style.display = "none";
    respHeader.style.display = "";
    respText.style.display = "";
    copyEl.style.display = "";
    respText.textContent = data.response_text;
    $("#detailBadge").innerHTML = statusBadge(data);

    if (data.is_json) {
      const djBody = $("#detailJsonBody");
      djSection.style.display = "block";
      djBody.innerHTML = "";
      renderJsonRows(data.parsed_json, djBody, "");
    } else {
      djSection.style.display = "none";
    }
  }

  const params = new URLSearchParams({ model: data.model, prompt: data.prompt });
  $("#rerunLink").href = `/?${params.toString()}`;
  $("#deleteBtn").onclick = () => deleteInference(data.id);
  $("#detailCopy").onclick = () => copyToClipboard(data.response_text, $("#detailCopy"));
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

// ── Init ────────────────────────────────────────────────────

fetch("/api/config").then(r => r.json()).then(c => { inferTimeout = c.infer_timeout; }).catch(() => {});
loadModels(modelSel).then(() => updateRunBtn());
prefillFromParams();
loadHistory(1);
