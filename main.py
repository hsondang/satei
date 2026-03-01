import os
import base64
import json
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import httpx

from db import init_db, save_inference, get_history, get_inference, delete_inference

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

KNOWN_VISION_FAMILIES = {"qwen3vl", "qwen2vl", "clip", "mllama", "llava", "gemma3", "minicpm"}


@asynccontextmanager
async def lifespan(app):
    init_db()
    yield


app = FastAPI(title="Satei", lifespan=lifespan)


# ── Pages ────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/history")
async def history_page():
    return FileResponse(os.path.join(STATIC_DIR, "history.html"))


# ── API ──────────────────────────────────────────────────────────────

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


@app.post("/api/infer")
async def infer(image: UploadFile, prompt: str = Form(...), model: str = Form(...)):
    image_bytes = await image.read()
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(413, "Image too large (max 20MB)")

    b64_image = base64.b64encode(image_bytes).decode("utf-8")
    mime = image.content_type or "image/png"

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt, "images": [b64_image]}],
        "stream": False,
    }

    start = time.time()
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
            resp.raise_for_status()
    except httpx.ConnectError:
        raise HTTPException(502, "Cannot connect to Ollama. Is it running?")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Ollama error: {e}")
    duration_ms = int((time.time() - start) * 1000)

    data = resp.json()
    response_text = data.get("message", {}).get("content", "")

    # JSON detection
    is_json = False
    parsed_json = None
    text = response_text.strip()
    # Try to extract JSON from markdown code fences
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first and last lines (fences)
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

    # Build ollama metadata (exclude the message content to save space)
    ollama_meta = {k: v for k, v in data.items() if k != "message"}

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


# ── Static files (must be last) ─────────────────────────────────────

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
