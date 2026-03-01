const listEl = $("#experimentsList");
const emptyState = $("#emptyState");

async function loadExperiments() {
  try {
    const resp = await fetch("/api/experiments");
    if (!resp.ok) throw new Error("Failed to load experiments");
    const data = await resp.json();
    render(data.items);
  } catch (e) {
    showError(e.message);
  }
}

function render(items) {
  if (items.length === 0) {
    listEl.style.display = "none";
    emptyState.style.display = "block";
    return;
  }

  listEl.style.display = "block";
  emptyState.style.display = "none";

  listEl.innerHTML = `
    <table class="history-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Model</th>
          <th>Tests</th>
          <th>Last Run</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${items.map(exp => {
          let statusHtml = '<span class="text-dim">Not run</span>';
          if (exp.latest_run_status === "completed") {
            const pct = exp.latest_run_total > 0
              ? Math.round((exp.latest_run_passed / exp.latest_run_total) * 100)
              : 0;
            const cls = pct === 100 ? "badge-json" : "badge-text";
            statusHtml = `<span class="badge ${cls}">${exp.latest_run_passed}/${exp.latest_run_total} (${pct}%)</span>`;
          } else if (exp.latest_run_status === "running") {
            statusHtml = '<span class="badge badge-running">Running...</span>';
          }
          return `
            <tr onclick="window.location='/experiments/${exp.id}'" style="cursor:pointer;">
              <td><strong>${escHtml(exp.name)}</strong></td>
              <td>${escHtml(exp.model)}</td>
              <td>${exp.test_count}</td>
              <td>${exp.latest_run_at ? formatTime(exp.latest_run_at) : '-'}</td>
              <td>${statusHtml}</td>
              <td>
                <button class="btn-secondary btn-sm" onclick="event.stopPropagation(); deleteExp(${exp.id})">Delete</button>
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

async function deleteExp(id) {
  if (!confirm("Delete this experiment and all its tests?")) return;
  try {
    const resp = await fetch(`/api/experiments/${id}`, { method: "DELETE" });
    if (!resp.ok) throw new Error("Failed to delete");
    loadExperiments();
  } catch (e) {
    showError(e.message);
  }
}
window.deleteExp = deleteExp;

loadExperiments();
