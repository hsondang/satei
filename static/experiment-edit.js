const expName = $("#expName");
const expModel = $("#expModel");
const expPrompt = $("#expPrompt");
const saveMetaBtn = $("#saveMetaBtn");
const testsSection = $("#testsSection");
const testCards = $("#testCards");
const addTestBtn = $("#addTestBtn");
const newTestCard = $("#newTestCard");
const testDropZone = $("#testDropZone");
const testFileInput = $("#testFileInput");
const testLabel = $("#testLabel");
const newCriteriaList = $("#newCriteriaList");
const addCriterionBtn = $("#addCriterionBtn");
const saveTestBtn = $("#saveTestBtn");
const cancelTestBtn = $("#cancelTestBtn");

let experimentId = null;
let testFile = null;

// ── Detect edit mode from URL ───────────────────────────────

function getExperimentId() {
  const match = window.location.pathname.match(/\/experiments\/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

// ── Load existing experiment ────────────────────────────────

async function loadExperiment(id) {
  try {
    const resp = await fetch(`/api/experiments/${id}`);
    if (!resp.ok) throw new Error("Experiment not found");
    const exp = await resp.json();

    experimentId = exp.id;
    expName.value = exp.name;
    expPrompt.value = exp.prompt;
    $("#pageTitle").textContent = `Edit: ${exp.name}`;
    saveMetaBtn.textContent = "Update Experiment";

    // Select model after models load
    setTimeout(() => {
      const opt = expModel.querySelector(`option[value="${exp.model}"]`);
      if (opt) opt.selected = true;
    }, 500);

    testsSection.style.display = "block";
    renderExistingTests(exp.tests);
  } catch (e) {
    showError(e.message);
  }
}

function renderExistingTests(tests) {
  testCards.innerHTML = "";
  if (tests.length === 0) {
    testCards.innerHTML = '<div class="empty-state" style="padding:20px;">No tests yet. Click "+ Add Test" to add one.</div>';
    return;
  }

  for (const test of tests) {
    const card = document.createElement("div");
    card.className = "card test-card";
    card.innerHTML = `
      <div class="test-card-header">
        <strong>${escHtml(test.label || `Test #${test.id}`)}</strong>
        <button class="btn-danger btn-sm" onclick="deleteTest(${test.id})">Delete</button>
      </div>
      <div class="test-card-body">
        <div class="test-thumb">
          <img src="/api/experiments/${experimentId}/tests/${test.id}/image" alt="test image"
               onerror="this.parentElement.innerHTML='<span class=text-dim>Image</span>'">
        </div>
        <div class="criteria-display">
          ${test.criteria.length === 0
            ? '<span class="text-dim">No criteria defined</span>'
            : `<table class="criteria-mini-table">
                <tr><th>Key</th><th>Expected</th><th>Mode</th></tr>
                ${test.criteria.map(c => `
                  <tr>
                    <td class="key">${escHtml(c.json_key)}</td>
                    <td>${escHtml(c.expected_value)}</td>
                    <td class="text-dim">${c.match_mode}</td>
                  </tr>
                `).join("")}
              </table>`
          }
        </div>
      </div>
    `;
    testCards.appendChild(card);
  }
}

// ── Save experiment metadata ────────────────────────────────

saveMetaBtn.addEventListener("click", async () => {
  const name = expName.value.trim();
  const prompt = expPrompt.value.trim();
  const model = expModel.value;

  if (!name || !prompt || !model) {
    showError("Name, prompt, and model are required");
    return;
  }

  hideError();

  try {
    if (experimentId) {
      // Update
      const resp = await fetch(`/api/experiments/${experimentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt, model }),
      });
      if (!resp.ok) throw new Error("Failed to update experiment");
    } else {
      // Create
      const resp = await fetch("/api/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt, model }),
      });
      if (!resp.ok) throw new Error("Failed to create experiment");
      const exp = await resp.json();
      experimentId = exp.id;
      // Redirect to edit URL
      window.history.replaceState(null, "", `/experiments/${experimentId}/edit`);
    }

    $("#pageTitle").textContent = `Edit: ${name}`;
    saveMetaBtn.textContent = "Update Experiment";
    testsSection.style.display = "block";
  } catch (e) {
    showError(e.message);
  }
});

// ── Add test UI ─────────────────────────────────────────────

addTestBtn.addEventListener("click", () => {
  newTestCard.style.display = "block";
  testFile = null;
  testLabel.value = "";
  testDropZone.innerHTML = "<p>Drop image</p>";
  newCriteriaList.innerHTML = "<label>Criteria</label>";
  addCriterionRow();
});

cancelTestBtn.addEventListener("click", () => {
  newTestCard.style.display = "none";
});

// Drop zone for test image
setupDropZone(
  testDropZone, testFileInput,
  (file) => { testFile = file; },
  () => { testFile = null; }
);

// ── Criteria rows ───────────────────────────────────────────

addCriterionBtn.addEventListener("click", addCriterionRow);

function addCriterionRow() {
  const row = document.createElement("div");
  row.className = "criteria-row";
  row.innerHTML = `
    <input type="text" placeholder="json_key" class="input-field input-sm crit-key">
    <input type="text" placeholder="expected value" class="input-field input-sm crit-value">
    <select class="input-field input-sm crit-mode">
      <option value="exact">exact</option>
      <option value="contains">contains</option>
    </select>
    <button class="btn-danger btn-sm" onclick="this.parentElement.remove()">&times;</button>
  `;
  newCriteriaList.appendChild(row);
}

// ── Save test ───────────────────────────────────────────────

saveTestBtn.addEventListener("click", async () => {
  if (!testFile) {
    showError("Please select an image for the test");
    return;
  }
  if (!experimentId) {
    showError("Save the experiment first");
    return;
  }

  hideError();

  // Collect criteria
  const criteria = [];
  newCriteriaList.querySelectorAll(".criteria-row").forEach(row => {
    const key = row.querySelector(".crit-key").value.trim();
    const value = row.querySelector(".crit-value").value.trim();
    const mode = row.querySelector(".crit-mode").value;
    if (key && value) {
      criteria.push({ json_key: key, expected_value: value, match_mode: mode });
    }
  });

  const formData = new FormData();
  formData.append("image", testFile);
  formData.append("label", testLabel.value.trim());
  formData.append("criteria", JSON.stringify(criteria));

  try {
    saveTestBtn.disabled = true;
    saveTestBtn.textContent = "Saving...";
    const resp = await fetch(`/api/experiments/${experimentId}/tests`, {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) throw new Error("Failed to save test");

    newTestCard.style.display = "none";
    // Reload experiment to show updated tests
    loadExperiment(experimentId);
  } catch (e) {
    showError(e.message);
  } finally {
    saveTestBtn.disabled = false;
    saveTestBtn.textContent = "Save Test";
  }
});

// ── Delete test ─────────────────────────────────────────────

async function deleteTest(testId) {
  if (!confirm("Delete this test?")) return;
  try {
    const resp = await fetch(`/api/experiments/${experimentId}/tests/${testId}`, {
      method: "DELETE",
    });
    if (!resp.ok) throw new Error("Failed to delete test");
    loadExperiment(experimentId);
  } catch (e) {
    showError(e.message);
  }
}
window.deleteTest = deleteTest;

// ── Init ────────────────────────────────────────────────────

loadModels(expModel);
const existingId = getExperimentId();
if (existingId) {
  loadExperiment(existingId);
}
