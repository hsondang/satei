import os
import asyncio
import base64
import json
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
import httpx

from db import (
    init_db, save_inference, get_history, get_inference, delete_inference,
    save_experiment, get_experiments, get_experiment, get_experiment_with_images,
    update_experiment, delete_experiment,
    save_test, get_test_image, delete_test,
    create_run, save_test_result, complete_run, fail_run,
    get_runs, get_run_detail, get_latest_run,
)

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

KNOWN_VISION_FAMILIES = {"qwen3vl", "qwen2vl", "clip", "mllama", "llava", "gemma3", "minicpm"}


@asynccontextmanager
async def lifespan(app):
    init_db()
    yield


app = FastAPI(title="Satei", lifespan=lifespan)


# ── Helpers ──────────────────────────────────────────────────────────

def parse_llm_response(ollama_data):
    """Extract response text, detect JSON. Returns (response_text, is_json, parsed_json, ollama_meta)."""
    response_text = ollama_data.get("message", {}).get("content", "")
    ollama_meta = {k: v for k, v in ollama_data.items() if k != "message"}

    is_json = False
    parsed_json = None
    text = response_text.strip()

    if text.startswith("```"):
        lines = text.split("\n")
        inner = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        try:
            parsed_json = json.loads(inner)
            is_json = True
        except (json.JSONDecodeError, ValueError):
            pass
    if not is_json:
        try:
            parsed_json = json.loads(text)
            is_json = True
        except (json.JSONDecodeError, ValueError):
            pass

    return response_text, is_json, parsed_json, ollama_meta


async def call_ollama(*, model, prompt, image_b64):
    """Send an image+prompt to Ollama. Returns raw response dict."""
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
        resp.raise_for_status()
    return resp.json()


def get_nested_value(obj, dotted_key):
    """Traverse obj with dot-notation key like 'address.city'."""
    keys = dotted_key.split(".")
    current = obj
    for k in keys:
        if isinstance(current, dict) and k in current:
            current = current[k]
        elif isinstance(current, list):
            try:
                current = current[int(k)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return current


def evaluate_criteria(criteria, parsed_json, is_json):
    """Returns (overall_passed, {criterion_id: bool})."""
    if not is_json or parsed_json is None:
        return False, {str(c["id"]): False for c in criteria}

    results = {}
    for c in criteria:
        actual = get_nested_value(parsed_json, c["json_key"])
        cid = str(c["id"])
        if c["match_mode"] == "contains":
            results[cid] = c["expected_value"] in str(actual) if actual is not None else False
        else:  # exact
            results[cid] = str(actual) == c["expected_value"]

    overall = all(results.values()) if results else is_json
    return overall, results


# ── Pages ────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/experiments")
async def experiments_page():
    return FileResponse(os.path.join(STATIC_DIR, "experiments.html"))


@app.get("/experiments/new")
async def experiment_new_page():
    return FileResponse(os.path.join(STATIC_DIR, "experiment-edit.html"))


@app.get("/experiments/{experiment_id}")
async def experiment_detail_page(experiment_id: int):
    return FileResponse(os.path.join(STATIC_DIR, "experiment-detail.html"))


@app.get("/experiments/{experiment_id}/edit")
async def experiment_edit_page(experiment_id: int):
    return FileResponse(os.path.join(STATIC_DIR, "experiment-edit.html"))


# ── API: Models ──────────────────────────────────────────────────────

@app.get("/api/models")
async def list_models():
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            resp.raise_for_status()
    except httpx.ConnectError:
        raise HTTPException(502, "Cannot connect to Ollama. Is it running?")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama error: {e}")

    all_models = resp.json().get("models", [])
    vision = []
    for m in all_models:
        families = m.get("details", {}).get("families") or []
        if any(f in KNOWN_VISION_FAMILIES for f in families):
            vision.append({
                "name": m["name"],
                "size": m.get("size"),
                "family": m.get("details", {}).get("family"),
                "parameter_size": m.get("details", {}).get("parameter_size"),
            })
    return {"models": vision}


# ── API: Ad-hoc Inference ────────────────────────────────────────────

@app.post("/api/infer")
async def infer(image: UploadFile, prompt: str = Form(...), model: str = Form(...)):
    image_bytes = await image.read()
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(413, "Image too large (max 20MB)")

    b64_image = base64.b64encode(image_bytes).decode("utf-8")
    mime = image.content_type or "image/png"

    start = time.time()
    try:
        data = await call_ollama(model=model, prompt=prompt, image_b64=b64_image)
    except httpx.ConnectError:
        raise HTTPException(502, "Cannot connect to Ollama. Is it running?")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama error: {e}")
    duration_ms = int((time.time() - start) * 1000)

    response_text, is_json, parsed_json, ollama_meta = parse_llm_response(data)

    record = save_inference(
        model=model, prompt=prompt, response_text=response_text,
        is_json=is_json, parsed_json=parsed_json,
        image_b64=b64_image, image_mime=mime,
        duration_ms=duration_ms, ollama_meta=ollama_meta,
    )
    return record


@app.get("/api/history")
async def history_list(page: int = 1, per_page: int = 20):
    return get_history(page=page, per_page=per_page)


@app.get("/api/history/{inference_id}")
async def history_detail(inference_id: int):
    record = get_inference(inference_id)
    if record is None:
        raise HTTPException(404, "Inference not found")
    return record


@app.delete("/api/history/{inference_id}")
async def history_delete(inference_id: int):
    record = get_inference(inference_id)
    if record is None:
        raise HTTPException(404, "Inference not found")
    delete_inference(inference_id)
    return {"ok": True}


# ── API: Experiments CRUD ────────────────────────────────────────────

class ExperimentCreate(BaseModel):
    name: str
    prompt: str
    model: str


@app.get("/api/experiments")
async def experiments_list():
    return get_experiments()


@app.post("/api/experiments")
async def experiment_create(body: ExperimentCreate):
    return save_experiment(name=body.name, prompt=body.prompt, model=body.model)


@app.get("/api/experiments/{experiment_id}")
async def experiment_detail(experiment_id: int):
    exp = get_experiment(experiment_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    return exp


@app.put("/api/experiments/{experiment_id}")
async def experiment_update(experiment_id: int, body: ExperimentCreate):
    exp = get_experiment(experiment_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    return update_experiment(experiment_id, name=body.name, prompt=body.prompt, model=body.model)


@app.delete("/api/experiments/{experiment_id}")
async def experiment_delete(experiment_id: int):
    exp = get_experiment(experiment_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    delete_experiment(experiment_id)
    return {"ok": True}


# ── API: Tests CRUD ──────────────────────────────────────────────────

@app.post("/api/experiments/{experiment_id}/tests")
async def test_create(experiment_id: int, image: UploadFile,
                      label: str = Form(""), criteria: str = Form("[]")):
    exp = get_experiment(experiment_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")

    image_bytes = await image.read()
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(413, "Image too large (max 20MB)")

    b64_image = base64.b64encode(image_bytes).decode("utf-8")
    mime = image.content_type or "image/png"

    try:
        criteria_list = json.loads(criteria)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid criteria JSON")

    return save_test(
        experiment_id=experiment_id,
        label=label, image_b64=b64_image, image_mime=mime,
        criteria=criteria_list,
    )


@app.get("/api/experiments/{experiment_id}/tests/{test_id}/image")
async def test_image(experiment_id: int, test_id: int):
    img = get_test_image(test_id)
    if img is None:
        raise HTTPException(404, "Test image not found")
    image_bytes = base64.b64decode(img["image_b64"])
    return Response(content=image_bytes, media_type=img["image_mime"])


@app.delete("/api/experiments/{experiment_id}/tests/{test_id}")
async def test_delete(experiment_id: int, test_id: int):
    delete_test(test_id)
    return {"ok": True}


# ── API: Experiment Runs ─────────────────────────────────────────────

@app.post("/api/experiments/{experiment_id}/run")
async def experiment_run(experiment_id: int):
    exp = get_experiment_with_images(experiment_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    if not exp["tests"]:
        raise HTTPException(400, "Experiment has no tests")

    run = create_run(experiment_id)
    asyncio.create_task(_run_experiment(run["id"], exp))
    return {"run_id": run["id"]}


async def _run_experiment(run_id, exp):
    """Background task: run each test sequentially."""
    total_start = time.time()
    try:
        for test in exp["tests"]:
            start = time.time()
            try:
                data = await call_ollama(
                    model=exp["model"],
                    prompt=exp["prompt"],
                    image_b64=test["image_b64"],
                )
                duration_ms = int((time.time() - start) * 1000)
                response_text, is_json, parsed_json, ollama_meta = parse_llm_response(data)
            except Exception as e:
                duration_ms = int((time.time() - start) * 1000)
                response_text = f"Error: {e}"
                is_json = False
                parsed_json = None
                ollama_meta = None

            passed, criteria_results = evaluate_criteria(
                test["criteria"], parsed_json, is_json
            )

            save_test_result(
                run_id=run_id, test_id=test["id"],
                response_text=response_text,
                is_json=is_json, parsed_json=parsed_json,
                duration_ms=duration_ms, ollama_meta=ollama_meta,
                passed=passed, criteria_results=criteria_results,
            )

        total_duration = int((time.time() - total_start) * 1000)
        complete_run(run_id, total_duration)
    except Exception:
        fail_run(run_id)


@app.get("/api/experiments/{experiment_id}/runs")
async def experiment_runs_list(experiment_id: int):
    return get_runs(experiment_id)


@app.get("/api/experiments/{experiment_id}/runs/latest")
async def experiment_latest_run(experiment_id: int):
    run = get_latest_run(experiment_id)
    if run is None:
        return {"run": None}
    return run


@app.get("/api/experiments/{experiment_id}/runs/{run_id}")
async def experiment_run_detail(experiment_id: int, run_id: int):
    run = get_run_detail(run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return run


# ── Static files (must be last) ─────────────────────────────────────

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
