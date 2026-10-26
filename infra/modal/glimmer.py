"""
Meta Muse Glimmer (open weights, Apache 2.0) on a Modal GPU, behind vLLM's
OpenAI-compatible API, for SocialPilot's "Modal" AI provider.

One-time setup (pick any long random string as the key):
    pip install modal
    modal setup
    modal secret create socialpilot-glimmer VLLM_API_KEY=<random-key>

Deploy:
    modal deploy infra/modal/glimmer.py

Then in SocialPilot, Settings -> AI models: provider "Modal", base URL
https://<workspace>--socialpilot-glimmer-serve.modal.run/v1 and the same key.

The GPU scales to zero after 5 idle minutes, so you only pay while it's used.
The first request after idling waits for the model to load (a few minutes).
Serving flags follow the vLLM recipe for meta-models/Muse-Glimmer-30B.
"""

import os
import subprocess

import modal

MODEL = "meta-models/Muse-Glimmer-30B"  # BF16, about 60 GB: fits one 80 GB H100
SERVED_NAME = "muse-glimmer"
PORT = 8000

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install("vllm==0.28.0", "huggingface_hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

# Model weights and compiled kernels are cached across cold starts.
hf_cache = modal.Volume.from_name("socialpilot-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("socialpilot-vllm-cache", create_if_missing=True)

app = modal.App("socialpilot-glimmer")


@app.function(
    image=image,
    gpu="H100",
    volumes={"/root/.cache/huggingface": hf_cache, "/root/.cache/vllm": vllm_cache},
    secrets=[modal.Secret.from_name("socialpilot-glimmer")],
    scaledown_window=5 * 60,
    timeout=60 * 60,
)
@modal.concurrent(max_inputs=32)
@modal.web_server(port=PORT, startup_timeout=20 * 60)
def serve():
    cmd = [
        "vllm", "serve", MODEL,
        "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        # 32K context keeps the KV cache inside one GPU; plenty for posts and replies.
        "--max-model-len", "32768",
        "--gpu-memory-utilization", "0.92",
        "--max-num-seqs", "32",
        # Glimmer writes XML-style tool calls and channel-scoped reasoning: both parsers are needed.
        "--enable-auto-tool-choice", "--tool-call-parser", "muse_glimmer",
        "--reasoning-parser", "muse_glimmer",
        "--generation-config", "auto",
        "--api-key", os.environ["VLLM_API_KEY"],
    ]
    subprocess.Popen(cmd)
