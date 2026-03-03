// ── Shared utilities ────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatElapsed(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTime(iso) {
  const d = new Date(iso + "Z");
  return d.toLocaleString();
}

function formatValue(v) {
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

function getJsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
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

function showError(msg, box) {
  const el = box || $("#error");
  el.textContent = msg;
  el.classList.add("visible");
}

function hideError(box) {
  const el = box || $("#error");
  el.classList.remove("visible");
}

async function loadModels(selectEl) {
  try {
    const resp = await fetch("/api/models");
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to load models");
    }
    const data = await resp.json();
    selectEl.innerHTML = "";
    if (data.models.length === 0) {
      selectEl.innerHTML = '<option value="">No vision models found</option>';
      return;
    }
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = `${m.name} (${m.parameter_size || "?"})`;
      selectEl.appendChild(opt);
    }
  } catch (e) {
    showError(e.message);
    selectEl.innerHTML = '<option value="">Error loading models</option>';
  }
}

function setupDropZone(zoneEl, inputEl, onSet, onRemove) {
  zoneEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", (e) => {
    if (e.target.files[0]) _applyImage(zoneEl, e.target.files[0], onSet);
  });
  zoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    zoneEl.classList.add("dragover");
  });
  zoneEl.addEventListener("dragleave", () => zoneEl.classList.remove("dragover"));
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    zoneEl.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) _applyImage(zoneEl, file, onSet);
  });

  window._clearDropZone = (zoneId) => {
    const z = document.getElementById(zoneId);
    if (z) {
      z.innerHTML = "<p>Drop image here<br>or click to browse</p>";
      if (onRemove) onRemove();
    }
  };
}

function _applyImage(zoneEl, file, onSet) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const zoneId = zoneEl.id;
    zoneEl.innerHTML = `
      <img src="${e.target.result}" alt="Selected image">
      <button class="remove-img" onclick="event.stopPropagation(); _clearDropZone('${zoneId}');">&times;</button>
    `;
  };
  reader.readAsDataURL(file);
  if (onSet) onSet(file);
}

function copyToClipboard(text, btnEl) {
  navigator.clipboard.writeText(text).then(() => {
    btnEl.textContent = "Copied!";
    setTimeout(() => (btnEl.textContent = "Copy"), 1500);
  });
}
