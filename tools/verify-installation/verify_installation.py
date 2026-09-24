#!/usr/bin/env python3
"""Smoke test client for the FreeLLMAPI + Langfuse installation.

Verifies, in order:
  1. FreeLLMAPI is up and healthy            (GET  <base>/api/ping)
  2. Langfuse is reachable from this host    (GET  <langfuse>/api/public/health)
  3. Langfuse is reachable from *inside* the freellmapi container (the path the
     OTel exporter will actually use)
  4. Langfuse API credentials are valid      (GET  <langfuse>/api/public/projects)
  5. A real inference response is returned over every gateway surface:
       - /v1/chat/completions   (OpenAI Chat Completions)
       - /v1/responses          (OpenAI Responses)
       - /v1/messages           (Anthropic Messages)
       - /v1/embeddings         (Embeddings)

Only the Python standard library is used, so the uv virtualenv has no packages
to install. Run from the repository root:

    uv run --project tools/verify-installation python tools/verify-installation/verify_installation.py

Exit code 0 = all checks passed, 1 = at least one check failed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

# ---------------------------------------------------------------------------
# Configuration (all overridable via environment variables / CLI flags)
# ---------------------------------------------------------------------------
DEFAULT_BASE_URL = os.environ.get("FREEPRICELLM_BASE_URL", "http://localhost:3001/v1")
DEFAULT_API_KEY = os.environ.get(
    "FREEPRICELLM_API_KEY", "freellmapi-810640a7a1898cc85c578dbc469348a08bee76d1bbd60b99"
)
DEFAULT_LANGFUSE_HOST = os.environ.get("LANGFUSE_HOST", "http://172.25.182.31:3000")
DEFAULT_LANGFUSE_PUBLIC = os.environ.get("LANGFUSE_PUBLIC_KEY", "pk-lf-341fb2ab-bd3e-4202-8e08-c0ed6e131675")
DEFAULT_LANGFUSE_SECRET = os.environ.get("LANGFUSE_SECRET_KEY", "sk-lf-1e5fba2e-2323-4008-98bc-93a0fc04f013")
DEFAULT_CONTAINER = os.environ.get("FREEPRICELLM_CONTAINER", "freellmapi-freellmapi-1")
DEFAULT_MODEL = os.environ.get("FREEPRICELLM_MODEL", "auto")


class Check:
    """Tiny pass/fail accumulator."""

    def __init__(self) -> None:
        self.results: list[tuple[str, bool, str]] = []

    def ok(self, name: str, detail: str = "") -> None:
        self.results.append((name, True, detail))

    def fail(self, name: str, detail: str) -> None:
        self.results.append((name, False, detail))

    def summary(self) -> str:
        lines = []
        for name, passed, detail in self.results:
            mark = "PASS" if passed else "FAIL"
            lines.append(f"  [{mark}] {name}" + (f"  ({detail})" if detail else ""))
        passed = sum(1 for _, p, _ in self.results if p)
        return "\n".join(lines) + f"\n\n{passed}/{len(self.results)} checks passed"


def http_json(
    method: str,
    url: str,
    *,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 60.0,
) -> tuple[int, dict[str, Any]]:
    """Perform an HTTP request and return (status, parsed JSON body)."""
    req = urllib.request.Request(url, method=method)
    hdrs = dict(headers or {})
    hdrs.setdefault("Accept", "application/json")
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    for k, v in hdrs.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as exc:  # non-2xx
        raw = exc.read()
        status = exc.code
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        parsed = {"_raw": raw.decode("utf-8", "replace")[:500]}
    return status, parsed


def bearer(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def langfuse_basic(public: str, secret: str) -> dict[str, str]:
    token = base64.b64encode(f"{public}:{secret}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------
def check_ping(check: Check, base_url: str) -> None:
    origin = base_url[:-3] if base_url.endswith("/v1") else base_url
    try:
        status, body = http_json("GET", f"{origin}/api/ping", timeout=10)
    except Exception as exc:  # noqa: BLE001
        check.fail("freellmapi /api/ping", f"unreachable: {exc}")
        return
    if status == 200 and body.get("status") == "ok":
        check.ok("freellmapi /api/ping", f"HTTP {status}")
    else:
        check.fail("freellmapi /api/ping", f"HTTP {status} body={body}")


def check_langfuse_host(check: Check, langfuse_host: str) -> None:
    try:
        status, body = http_json("GET", f"{langfuse_host}/api/public/health", timeout=10)
    except Exception as exc:  # noqa: BLE001
        check.fail("langfuse reachable (host)", f"unreachable: {exc}")
        return
    if status == 200:
        check.ok("langfuse reachable (host)", f"HTTP {status}")
    else:
        check.fail("langfuse reachable (host)", f"HTTP {status} body={body}")


def check_langfuse_from_container(check: Check, container: str, langfuse_host: str) -> None:
    url = f"{langfuse_host}/api/public/health"
    try:
        proc = subprocess.run(
            ["docker", "exec", container, "sh", "-c", f"curl -s -o /dev/null -w '%{{http_code}}' '{url}'"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        check.fail("langfuse reachable (inside container)", "docker CLI not available")
        return
    except Exception as exc:  # noqa: BLE001
        check.fail("langfuse reachable (inside container)", f"docker exec failed: {exc}")
        return
    code = proc.stdout.strip()
    if code == "200":
        check.ok("langfuse reachable (inside container)", f"HTTP {code}")
    else:
        msg = (proc.stderr or "").strip()
        check.fail("langfuse reachable (inside container)", f"curl exit={proc.returncode} code={code!r} stderr={msg}")


def check_langfuse_credentials(check: Check, langfuse_host: str, public: str, secret: str) -> None:
    try:
        status, body = http_json(
            "GET", f"{langfuse_host}/api/public/projects", headers=langfuse_basic(public, secret), timeout=15
        )
    except Exception as exc:  # noqa: BLE001
        check.fail("langfuse credentials", f"request failed: {exc}")
        return
    projects = body.get("data", []) if isinstance(body.get("data"), list) else []
    if status == 200 and projects:
        check.ok("langfuse credentials", f"project(s): {', '.join(p.get('name', '?') for p in projects)}")
    else:
        check.fail("langfuse credentials", f"HTTP {status} body={body}")


def _chat_completion(check: Check, base_url: str, api_key: str, model: str) -> None:
    name = "chat /v1/chat/completions"
    try:
        status, body = http_json(
            "POST",
            f"{base_url}/chat/completions",
            body={
                "model": model,
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "Reply with the single word OK and nothing else."}],
            },
            headers=bearer(api_key),
        )
    except Exception as exc:  # noqa: BLE001
        check.fail(name, f"request failed: {exc}")
        return
    try:
        content = body["choices"][0]["message"]["content"]
        served_model = body.get("model", "?")
    except (KeyError, IndexError, TypeError):
        check.fail(name, f"unexpected shape HTTP {status}: {json.dumps(body)[:300]}")
        return
    if status == 200 and content:
        check.ok(name, f"model={served_model!r} response={content!r}")
    else:
        check.fail(name, f"HTTP {status} body={json.dumps(body)[:300]}")


def _responses(check: Check, base_url: str, api_key: str, model: str) -> None:
    name = "chat /v1/responses"
    try:
        status, body = http_json(
            "POST",
            f"{base_url}/responses",
            body={"model": model, "max_output_tokens": 16, "instructions": "", "input": "Reply with the single word OK and nothing else."},
            headers=bearer(api_key),
        )
    except Exception as exc:  # noqa: BLE001
        check.fail(name, f"request failed: {exc}")
        return
    content = _walk(body, ["output", 0, "content", 0, "text"]) or _walk(body, ["output", 0, "content"])
    served_model = body.get("model", "?")
    if status == 200 and content:
        check.ok(name, f"model={served_model!r} response={content!r}")
    else:
        check.fail(name, f"HTTP {status} body={json.dumps(body)[:300]}")


def _messages(check: Check, base_url: str, api_key: str, model: str) -> None:
    name = "chat /v1/messages (Anthropic)"
    try:
        status, body = http_json(
            "POST",
            f"{base_url}/messages",
            body={
                "model": model,
                "max_tokens": 16,
                "messages": [{"role": "user", "content": "Reply with the single word OK and nothing else."}],
            },
            headers=bearer(api_key),
        )
    except Exception as exc:  # noqa: BLE001
        check.fail(name, f"request failed: {exc}")
        return
    content = _walk(body, ["content", 0, "text"])
    served_model = body.get("model", "?")
    if status == 200 and content:
        check.ok(name, f"model={served_model!r} response={content!r}")
    else:
        check.fail(name, f"HTTP {status} body={json.dumps(body)[:300]}")


def _embeddings(check: Check, base_url: str, api_key: str, model: str) -> None:
    name = "embed /v1/embeddings"
    try:
        status, body = http_json(
            "POST",
            f"{base_url}/embeddings",
            body={"model": model, "input": "Hello from the verify-installation smoke test."},
            headers=bearer(api_key),
        )
    except Exception as exc:  # noqa: BLE001
        check.fail(name, f"request failed: {exc}")
        return
    try:
        vector = body["data"][0]["embedding"]
        dim = len(vector)
    except (KeyError, IndexError, TypeError):
        check.fail(name, f"unexpected shape HTTP {status}: {json.dumps(body)[:300]}")
        return
    served_model = body.get("model", "?")
    if status == 200 and dim > 0:
        check.ok(name, f"model={served_model!r} dim={dim}")
    else:
        check.fail(name, f"HTTP {status} body={json.dumps(body)[:300]}")


def _walk(obj: Any, path: list[Any]) -> Any:
    """Descend a dict/list structure, returning None if any step is missing."""
    cur = obj
    for step in path:
        try:
            if isinstance(step, int):
                cur = cur[step]
            else:
                cur = cur.get(step)  # type: ignore[union-attr]
        except (KeyError, IndexError, TypeError, AttributeError):
            return None
    if isinstance(cur, list):
        return "".join(_walk(item, []) for item in cur) if cur and isinstance(cur[0], dict) and "text" in cur[0] else cur
    return cur


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the FreeLLMAPI + Langfuse installation.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--api-key", default=DEFAULT_API_KEY)
    parser.add_argument("--langfuse-host", default=DEFAULT_LANGFUSE_HOST)
    parser.add_argument("--langfuse-public", default=DEFAULT_LANGFUSE_PUBLIC)
    parser.add_argument("--langfuse-secret", default=DEFAULT_LANGFUSE_SECRET)
    parser.add_argument("--container", default=DEFAULT_CONTAINER)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--surface",
        default="all",
        choices=["all", "chat", "responses", "messages", "embeddings"],
        help="which inference surface(s) to exercise",
    )
    args = parser.parse_args()

    check = Check()
    print(f"Verifying installation:\n  base_url={args.base_url}\n  langfuse={args.langfuse_host}\n  model={args.model}")

    check_ping(check, args.base_url)
    check_langfuse_host(check, args.langfuse_host)
    check_langfuse_from_container(check, args.container, args.langfuse_host)
    check_langfuse_credentials(check, args.langfuse_host, args.langfuse_public, args.langfuse_secret)

    if args.surface in ("all", "chat"):
        _chat_completion(check, args.base_url, args.api_key, args.model)
    if args.surface in ("all", "responses"):
        _responses(check, args.base_url, args.api_key, args.model)
    if args.surface in ("all", "messages"):
        _messages(check, args.base_url, args.api_key, args.model)
    if args.surface in ("all", "embeddings"):
        _embeddings(check, args.base_url, args.api_key, args.model)

    print("\n" + check.summary())
    any_failed = any(not p for _, p, _ in check.results)
    return 1 if any_failed else 0


if __name__ == "__main__":
    sys.exit(main())