# Satei

Vision language model experiment platform. Send images + text prompts to vision LLMs running on Ollama, view responses with JSON detection, and browse inference history.

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
cd /Users/hson/projects/satei
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

1. **Run inference** — Select a vision model from the dropdown, drop or browse an image, type a prompt, and click "Run Inference".
2. **JSON detection** — If the model response is valid JSON, a key-value table shows all keys with their values and types.
3. **History** — Click "History" in the top nav to browse all past inferences. Click any row to see the full detail including the original image.
4. **Re-run** — From the history detail view, click "Re-run with same prompt" to go back to the main page with the model and prompt pre-filled.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server address |
| `SATEI_DB` | `satei.db` (project root) | SQLite database file path |

## Project structure

```
main.py            FastAPI app, all API routes
db.py              SQLite database layer
requirements.txt   Python dependencies
static/
  index.html       Main inference page
  history.html     History browser page
  app.js           Main page frontend logic
  history.js       History page frontend logic
  style.css        Shared styles (dark theme)
```
