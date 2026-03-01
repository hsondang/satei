const $ = (sel) => document.querySelector(sel);
const dropZone = $("#dropZone");
const fileInput = $("#fileInput");
const modelSel = $("#model");
const promptEl = $("#prompt");
const runBtn = $("#runBtn");
const clearBtn = $("#clearBtn");
const elapsedEl = $("#elapsed");
const errorBox = $("#error");
const responseSection = $("#responseSection");
const responseText = $("#responseText");
const respBadge = $("#respBadge");
const respDuration = $("#respDuration");
const jsonSection = $("#jsonSection");
const jsonBody = $("#jsonBody");
const copyBtn = $("#copyBtn");

let selectedFile = null;
let elapsedTimer = null;

// ── Load models ─────────────────────────────────────────────

async function loadModels() {
  try {
    const resp = await fetch("/api/models");
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to load models");
    }
    const data = await resp.json();
    modelSel.innerHTML = "";
    if (data.models.length === 0) {
      modelSel.innerHTML = '<option value="">No vision models found</option>';
      return;
    }
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = `${m.name} (${m.parameter_size || "?"})`;
      modelSel.appendChild(opt);
    }
    updateRunBtn();
  } catch (e) {
    showError(e.message);
    modelSel.innerHTML = '<option value="">Error loading models</option>';
  }
}

// ── Image handling ──────────────────────────────────────────

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  if (e.target.files[0]) setImage(e.target.files[0]);
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("image/")) setImage(file);
});

function setImage(file) {
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    dropZone.innerHTML = `
      <img src="${e.target.result}" alt="Selected image">
      <button class="remove-img" onclick="event.stopPropagation(); removeImage();">&times;</button>
    `;
  };
  reader.readAsDataURL(file);
  updateRunBtn();
}

function removeImage() {
  selectedFile = null;
  fileInput.value = "";
  dropZone.innerHTML = "<p>Drop image here<br>or click to browse</p>";
  updateRunBtn();
}
// expose globally for inline onclick
window.removeImage = removeImage;

function updateRunBtn() {
  runBtn.disabled = !selectedFile || !modelSel.value;
}
modelSel.addEventListener("change", updateRunBtn);

// ── Pre-fill from URL params (for re-run from history) ──────

function prefillFromParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("model")) {
    // Try to select the model after models load
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
  responseSection.classList.remove("visible");

  // Start elapsed timer
  let seconds = 0;
  elapsedEl.textContent = "0s";
  elapsedTimer = setInterval(() => {
    seconds++;
    elapsedEl.textContent = `${seconds}s`;
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
  } catch (e) {
    clearInterval(elapsedTimer);
    showError(e.message);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Run Inference";
    updateRunBtn();
  }
}

// ── Display response ────────────────────────────────────────

function showResponse(data) {
  responseSection.classList.add("visible");
  responseText.textContent = data.response_text;
  respDuration.textContent = formatDuration(data.duration_ms);

  if (data.is_json) {
    respBadge.innerHTML = '<span class="badge badge-json">JSON</span>';
    jsonSection.style.display = "block";
    jsonBody.innerHTML = "";
    renderJsonRows(data.parsed_json, jsonBody, "");
  } else {
    respBadge.innerHTML = '<span class="badge badge-text">Text</span>';
    jsonSection.style.display = "none";
  }
}

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
        <td class="value"><button class="nested-toggle">${type === "array" ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`}</button></td>
        <td class="type">${type}</td>
      `;
      tbody.appendChild(tr);
      // Render nested rows
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

// ── Copy ────────────────────────────────────────────────────

copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(responseText.textContent).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  });
});

// ── Clear ───────────────────────────────────────────────────

clearBtn.addEventListener("click", () => {
  removeImage();
  promptEl.value = "";
  responseSection.classList.remove("visible");
  hideError();
  elapsedEl.textContent = "";
});

// ── Helpers ─────────────────────────────────────────────────

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add("visible");
}
function hideError() {
  errorBox.classList.remove("visible");
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Init ────────────────────────────────────────────────────

loadModels();
prefillFromParams();
