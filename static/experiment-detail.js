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
        const cellClass = passed ? "result-cell-pass" : "result-cell-fail";
        const actualStr = actual !== null && actual !== undefined ? String(actual) : "null";
        const tooltip = `Expected: ${crit.expected_value}\nGot: ${actualStr}`;

        cellsHtml += `<td class="${cellClass}" title="${escHtml(tooltip)}">${escHtml(actualStr)}</td>`;
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

// ── Init ────────────────────────────────────────────────────

loadExperiment();
