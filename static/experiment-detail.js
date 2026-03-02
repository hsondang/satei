const runBtn = $("#runBtn");
const runSelect = $("#runSelect");
const runStatus = $("#runStatus");
const resultsSection = $("#resultsSection");
const resultsHead = $("#resultsHead");
const resultsBody = $("#resultsBody");
const summaryBar = $("#summaryBar");
const noResults = $("#noResults");

let experimentId = null;
let experiment = null;
let pollTimer = null;
let currentResults = [];

// ── Get experiment ID from URL ──────────────────────────────

function getExperimentId() {
  const match = window.location.pathname.match(/\/experiments\/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

// ── Load experiment info ────────────────────────────────────

async function loadExperiment() {
  experimentId = getExperimentId();
  if (!experimentId) return;

  try {
    const resp = await fetch(`/api/experiments/${experimentId}`);
    if (!resp.ok) throw new Error("Experiment not found");
    experiment = await resp.json();

    $("#expName").textContent = experiment.name;
    document.title = `Satei - ${experiment.name}`;
    $("#expPrompt").textContent = experiment.prompt;
    $("#expModel").textContent = experiment.model;
    $("#editLink").href = `/experiments/${experimentId}/edit`;

    await loadRuns();
    await loadLatestRun();
  } catch (e) {
    showError(e.message);
  }
}

// ── Load runs list ──────────────────────────────────────────

async function loadRuns() {
  try {
    const resp = await fetch(`/api/experiments/${experimentId}/runs`);
    if (!resp.ok) return;
    const runs = await resp.json();

    runSelect.innerHTML = "";
    if (runs.length === 0) {
      runSelect.innerHTML = '<option value="">No runs yet</option>';
      return;
    }

    for (const run of runs) {
      const opt = document.createElement("option");
      opt.value = run.id;
      const label = formatTime(run.started_at);
      const status = run.status === "completed"
        ? `${run.passed_count || 0}/${run.results_count || 0} passed`
        : run.status;
      opt.textContent = `${label} (${status})`;
      runSelect.appendChild(opt);
    }
  } catch (e) {
    // ignore
  }
}

runSelect.addEventListener("change", async () => {
  const runId = runSelect.value;
  if (runId) await loadRunDetail(runId);
});

// ── Load latest run ─────────────────────────────────────────

async function loadLatestRun() {
  try {
    const resp = await fetch(`/api/experiments/${experimentId}/runs/latest`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.run === null) {
      noResults.style.display = "block";
      resultsSection.style.display = "none";
      return;
    }
    renderRun(data);

    // If still running, start polling
    if (data.status === "running") {
      startPolling(data.id);
    }
  } catch (e) {
    noResults.style.display = "block";
  }
}

async function loadRunDetail(runId) {
  try {
    const resp = await fetch(`/api/experiments/${experimentId}/runs/${runId}`);
    if (!resp.ok) throw new Error("Run not found");
    const data = await resp.json();
    renderRun(data);
  } catch (e) {
    showError(e.message);
  }
}

// ── Render results table ────────────────────────────────────

function renderRun(run) {
  noResults.style.display = "none";
  resultsSection.style.display = "block";

  if (run.status === "running") {
    runStatus.innerHTML = '<span class="spinner"></span> Running...';
    runBtn.disabled = true;
  } else {
    runStatus.textContent = run.status === "completed" ? "Completed" : "Failed";
    runBtn.disabled = false;
  }

  const results = run.results || [];
  currentResults = results;
  if (results.length === 0) {
    resultsHead.innerHTML = "";
    resultsBody.innerHTML = '<tr><td class="text-dim" style="padding:20px;">Waiting for results...</td></tr>';
    return;
  }

  // Collect all unique criteria keys across all tests
  const allKeys = [];
  const keySet = new Set();
  for (const r of results) {
    for (const c of (r.criteria || [])) {
      if (!keySet.has(c.json_key)) {
        keySet.add(c.json_key);
        allKeys.push(c.json_key);
      }
    }
  }

  // Build header
  resultsHead.innerHTML = `<tr>
    <th>#</th>
    <th>Label</th>
    ${allKeys.map(k => `<th>${escHtml(k)}</th>`).join("")}
    <th>Duration</th>
    <th>Status</th>
  </tr>`;

  // Build rows
  resultsBody.innerHTML = "";
  let idx = 0;
  for (const r of results) {
    idx++;
    const tr = document.createElement("tr");
    const criteriaResults = r.criteria_results || {};

    if (!r.is_json) {
      // Entire row red
      tr.className = "result-row-fail";
      tr.innerHTML = `
        <td>${idx}</td>
        <td>${escHtml(r.label || `Test ${idx}`)}</td>
        <td colspan="${allKeys.length}" class="not-json-cell">NOT JSON</td>
        <td>${formatDuration(r.duration_ms)}</td>
        <td><span class="badge badge-fail">FAIL</span></td>
      `;
    } else {
      const rowPassed = r.passed;
      tr.className = rowPassed ? "result-row-pass" : "";

      // Build criteria cells
      let cellsHtml = "";
      for (const key of allKeys) {
        // Find the criterion for this key on this test
        const crit = (r.criteria || []).find(c => c.json_key === key);
        if (!crit) {
          cellsHtml += '<td class="result-cell-na">-</td>';
          continue;
        }

        const passed = criteriaResults[String(crit.id)];
        const actual = r.parsed_json ? getNestedValue(r.parsed_json, key) : null;
        const actualStr = actual !== null && actual !== undefined ? String(actual) : "null";

        if (passed) {
          const tooltip = `Expected: ${crit.expected_value}\nGot: ${actualStr}`;
          cellsHtml += `<td class="result-cell-pass" title="${escHtml(tooltip)}">${escHtml(actualStr)}</td>`;
        } else {
          cellsHtml += `<td class="result-cell-fail"><span class="toggle-value" data-actual="${escHtml(actualStr)}" data-expected="${escHtml(crit.expected_value)}" data-showing="actual">${escHtml(actualStr)}</span></td>`;
        }
      }

      tr.innerHTML = `
        <td>${idx}</td>
        <td>${escHtml(r.label || `Test ${idx}`)}</td>
        ${cellsHtml}
        <td>${formatDuration(r.duration_ms)}</td>
        <td><span class="badge ${rowPassed ? 'badge-json' : 'badge-fail'}">${rowPassed ? 'PASS' : 'FAIL'}</span></td>
      `;
    }

    resultsBody.appendChild(tr);
  }

  // Summary
  renderSummary(run, results);
}

function getNestedValue(obj, dottedKey) {
  const keys = dottedKey.split(".");
  let current = obj;
  for (const k of keys) {
    if (current && typeof current === "object" && k in current) {
      current = current[k];
    } else if (Array.isArray(current)) {
      const idx = parseInt(k);
      if (!isNaN(idx) && idx < current.length) current = current[idx];
      else return null;
    } else {
      return null;
    }
  }
  return current;
}

function renderSummary(run, results) {
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const jsonCount = results.filter(r => r.is_json).length;
  const jsonPct = total > 0 ? Math.round((jsonCount / total) * 100) : 0;
  const totalTime = run.total_duration_ms || results.reduce((s, r) => s + r.duration_ms, 0);
  const avgTime = total > 0 ? Math.round(totalTime / total) : 0;

  summaryBar.innerHTML = `
    <div class="summary-stat">
      <span class="summary-value ${pct === 100 ? 'text-green' : pct > 0 ? 'text-orange' : 'text-red'}">${passed}/${total}</span>
      <span class="summary-label">Passed (${pct}%)</span>
    </div>
    <div class="summary-stat">
      <span class="summary-value">${formatDuration(totalTime)}</span>
      <span class="summary-label">Total Time</span>
    </div>
    <div class="summary-stat">
      <span class="summary-value">${formatDuration(avgTime)}</span>
      <span class="summary-label">Avg / Test</span>
    </div>
    <div class="summary-stat">
      <span class="summary-value">${jsonCount}/${total}</span>
      <span class="summary-label">JSON Rate (${jsonPct}%)</span>
    </div>
  `;
}

// ── Run experiment ──────────────────────────────────────────

runBtn.addEventListener("click", async () => {
  if (!experimentId) return;
  hideError();

  try {
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="spinner"></span> Starting...';
    const resp = await fetch(`/api/experiments/${experimentId}/run`, { method: "POST" });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || "Failed to start run");
    }
    const data = await resp.json();
    runBtn.textContent = "Running...";
    startPolling(data.run_id);
  } catch (e) {
    showError(e.message);
    runBtn.disabled = false;
    runBtn.textContent = "Run Experiment";
  }
});

// ── Polling for progressive results ─────────────────────────

function startPolling(runId) {
  if (pollTimer) clearInterval(pollTimer);

  runStatus.innerHTML = '<span class="spinner"></span> Running...';

  pollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`/api/experiments/${experimentId}/runs/${runId}`);
      if (!resp.ok) return;
      const data = await resp.json();
      renderRun(data);

      if (data.status !== "running") {
        clearInterval(pollTimer);
        pollTimer = null;
        runBtn.disabled = false;
        runBtn.textContent = "Run Experiment";
        loadRuns(); // Refresh run history dropdown
      }
    } catch (e) {
      // ignore poll errors
    }
  }, 3000);
}

// ── Toggle + row click (event delegation) ───────────────────

resultsBody.addEventListener("click", function (e) {
  // Handle toggle-value clicks (actual/expected toggle)
  const toggleSpan = e.target.closest(".toggle-value");
  if (toggleSpan) {
    e.stopPropagation();
    if (toggleSpan.dataset.showing === "actual") {
      toggleSpan.textContent = toggleSpan.dataset.expected;
      toggleSpan.dataset.showing = "expected";
      toggleSpan.classList.add("showing-expected");
    } else {
      toggleSpan.textContent = toggleSpan.dataset.actual;
      toggleSpan.dataset.showing = "actual";
      toggleSpan.classList.remove("showing-expected");
    }
    return;
  }

  // Handle row clicks (open detail modal)
  const row = e.target.closest("tr");
  if (!row || !resultsBody.contains(row)) return;
  const rowIndex = Array.from(resultsBody.children).indexOf(row);
  if (rowIndex < 0 || rowIndex >= currentResults.length) return;
  showTestModal(currentResults[rowIndex]);
});

// ── Test detail modal ────────────────────────────────────────

function showTestModal(r) {
  const modal = $("#testModal");

  $("#modalImg").src = `/api/experiments/${experimentId}/tests/${r.test_id}/image`;
  $("#modalLabel").textContent = r.label || "Unlabeled";
  $("#modalModel").textContent = experiment ? experiment.model : "";
  $("#modalDuration").textContent = formatDuration(r.duration_ms);
  $("#modalPrompt").textContent = experiment ? experiment.prompt : "";
  $("#modalResponse").textContent = r.response_text;

  if (r.is_json) {
    $("#modalBadge").innerHTML = '<span class="badge badge-json">JSON</span>';
  } else {
    $("#modalBadge").innerHTML = '<span class="badge badge-text">Text</span>';
  }

  // JSON table
  const jsonSection = $("#modalJsonSection");
  const jsonBody = $("#modalJsonBody");
  if (r.is_json && r.parsed_json) {
    jsonSection.style.display = "block";
    jsonBody.innerHTML = "";
    renderJsonRows(r.parsed_json, jsonBody, "");
  } else {
    jsonSection.style.display = "none";
  }

  // Criteria comparison table
  const criteriaSection = $("#modalCriteriaSection");
  const criteriaBody = $("#modalCriteriaBody");
  const criteria = r.criteria || [];
  if (criteria.length > 0) {
    criteriaSection.style.display = "block";
    criteriaBody.innerHTML = "";
    const criteriaResults = r.criteria_results || {};

    for (const c of criteria) {
      const actual = r.parsed_json ? getNestedValue(r.parsed_json, c.json_key) : null;
      const actualStr = actual !== null && actual !== undefined ? String(actual) : "null";
      const passed = criteriaResults[String(c.id)];
      const statusBadge = passed
        ? '<span class="badge badge-json">PASS</span>'
        : '<span class="badge badge-fail">FAIL</span>';

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="key">${escHtml(c.json_key)}</td>
        <td>${escHtml(c.expected_value)}</td>
        <td>${escHtml(actualStr)}</td>
        <td class="text-dim">${escHtml(c.match_mode)}</td>
        <td>${statusBadge}</td>
      `;
      criteriaBody.appendChild(tr);
    }
  } else {
    criteriaSection.style.display = "none";
  }

  $("#modalCopy").onclick = () => copyToClipboard(r.response_text, $("#modalCopy"));

  modal.classList.add("visible");
}

$("#modalClose").addEventListener("click", () => {
  $("#testModal").classList.remove("visible");
});

$("#testModal").addEventListener("click", (e) => {
  if (e.target === $("#testModal")) {
    $("#testModal").classList.remove("visible");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = $("#testModal");
    if (modal.classList.contains("visible")) {
      modal.classList.remove("visible");
    }
  }
});

// ── Init ────────────────────────────────────────────────────

loadExperiment();
