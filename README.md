# Satei

Vision language model experiment platform. Send images + text prompts to vision LLMs running on Ollama, view responses with JSON detection, and run automated experiments with pass/fail criteria evaluation.

## Prerequisites

- Python 3.10+
- [Ollama](https://ollama.com) installed and running
- At least one vision model pulled in Ollama

### Pull a vision model

```bash
ollama pull qwen2.5-vl:3b
```

Other supported vision models: `qwen2.5-vl`, `llava`, `llama3.2-vision`, `gemma3`, `granite3.2-vision`, `minicpm-v`.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
source venv/bin/activate
uvicorn main:app --reload --port 8000
```

Open http://localhost:8000 in your browser.

## Usage

### Ad-hoc inference

1. Select a vision model, drop/browse an image, type a prompt, and click **Run Inference**.
2. If the response is valid JSON, a key-value table shows all keys with their values and types.
3. Past inferences appear in the **Recent Inferences** section below the form. Click any row to expand the full detail including the original image.
4. From the detail view, click **Re-run with same prompt** to pre-fill the model and prompt.

### Experiments

1. Navigate to **Experiments** from the top nav.
2. Click **+ New Experiment** — give it a name, select a model, and write a prompt.
3. After saving, add **tests** — each test is an image with criteria (JSON key + expected value + match mode).
4. Go to the experiment detail page and click **Run Experiment**. Results stream in progressively as each test completes.
5. The results table shows pass/fail per criterion (green/red cells), with a summary bar showing pass rate, total time, average time per test, and JSON response rate.
6. **Failed criteria** are shown as red pills — click to toggle between the actual value (red) and the expected value (orange).
7. **Click any result row** to open a detail modal showing the test image, full response text, parsed JSON keys, and a criteria comparison table (expected vs actual for each key).

#### Criteria match modes

- **exact** — The actual JSON value (as string) must exactly equal the expected value.
- **contains** — The actual JSON value (as string) must contain the expected value as a substring.

Criteria keys support dot-notation for nested JSON (e.g. `address.city`).

## Pages

| Path | Description |
|---|---|
| `/` | Ad-hoc inference + inline history |
| `/experiments` | Experiments list |
| `/experiments/new` | Create a new experiment |
| `/experiments/{id}` | Experiment detail — run, view results, summary stats |
| `/experiments/{id}/edit` | Edit experiment — manage tests and criteria |

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server address |
| `SATEI_DB` | `satei.db` (project root) | SQLite database file path |

## Project structure

```
main.py                          FastAPI app, all API routes
db.py                            SQLite database layer (6 tables)
requirements.txt                 Python dependencies
static/
  shared.js                      Shared utilities (DOM helpers, formatters, drop zones)
  index.html / app.js            Ad-hoc inference + inline history
  experiments.html / .js          Experiments list page
  experiment-edit.html / .js      Experiment creation & test management
  experiment-detail.html / .js    Experiment results, run execution, summary
  style.css                      Styles (dark theme)
```
