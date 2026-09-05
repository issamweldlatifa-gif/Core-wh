#!/usr/bin/env python3
"""Strip ANSI, find any line containing obvious error keywords, emit annotations + a gist dump."""
import json
import os
import re
import sys
import urllib.request

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
LINE_RE = re.compile(r"(?:^|\n)(?:e:\s*|w:\s*)?([^\s:][^:]+):(?:\((\d+),\s*(\d+)\)|(\d+):(?:(\d+):)?)\s*:?\s*(error|warning):\s*(.*)")


def strip_ansi(s: str) -> str:
    return ANSI_RE.sub("", s)


def to_rel(fpath: str) -> str:
    if "/mobile/" in fpath:
        return "mobile/" + fpath.split("/mobile/", 1)[1]
    if "/scanner-core/" in fpath:
        return "mobile/scanner-core/" + fpath.split("/scanner-core/", 1)[1]
    if "scanner-core/" in fpath:
        return "mobile/scanner-core/" + fpath.split("scanner-core/", 1)[1]
    return os.path.basename(fpath)


def main() -> int:
    if len(sys.argv) < 3:
        return 2
    try:
        exit_code = int(sys.argv[1])
    except ValueError:
        exit_code = 1
    log_path = sys.argv[2]
    with open(log_path, errors="replace") as f:
        raw = f.read()
    text = strip_ansi(raw)
    lines = text.splitlines()

    if exit_code == 0:
        print("::notice::Android build + scanner tests OK")
        return 0

    # Collect any line that looks like a Kotlin/Java compile error.
    # Patterns seen in the wild:
    #   e: /path/file.kt:12:3: Some message
    #   e: file.kt:12: Some message
    #   /path/file.kt: (12, 3): error: Unresolved reference...
    #   e: /path/file.kt: (12, 3): Unresolved reference
    errors = []
    for ln in lines:
        s = ln.strip()
        # Kotlin compiler form
        m = re.match(r"^[we]:\s*(.+?):(?:\s*\((\d+),\s*(\d+)\)|(\d+):(?:(\d+):)?)\s*:?\s*(.*)$", s)
        if m:
            fpath = m.group(1)
            lineno = m.group(2) or m.group(4)
            col = m.group(3) or m.group(5)
            msg = m.group(6) or ""
            errors.append((fpath, lineno, col, msg))
            continue
        # Javac form: file.kt:12: error: message
        m2 = re.match(r"^(.+?):(\d+):(?:\s*error|\s*warning):\s*(.*)$", s)
        if m2 and (".kt" in m2.group(1) or ".java" in m2.group(1) or ".kts" in m2.group(1)):
            errors.append((m2.group(1), m2.group(2), None, m2.group(3)))

    print(f"=== found {len(errors)} compiler errors ===")
    emitted = 0
    for fpath, lineno, col, msg in errors[:80]:
        rel = to_rel(fpath)
        col_attr = f",col={col}" if col else ""
        safe = msg.replace("%", "%25").replace("\r", "").replace("\n", " ")
        print(f"::error file={rel},line={lineno}{col_attr}::{safe}")
        print(f"E {rel}:{lineno}: {msg}")
        emitted += 1

    if emitted == 0:
        # Dump everything containing error keywords into stdout and one big annotation.
        interesting = []
        for i, ln in enumerate(lines):
            sl = ln.strip().lower()
            if any(k in sl for k in ("error", "unresolved", "type mismatch", "cannot", "failure:", "what went wrong", "exception", "execution failed", "build failed", "> task", "build ")):
                interesting.append(f"{i+1}: {ln}")
        for ln in interesting[-150:]:
            print(ln)
        tail = "\n".join(lines[-120:])
        if len(tail) > 1400:
            tail = tail[-1400:]
        print("::error file=mobile/app/build.gradle.kts,line=1::" + tail.replace("%", "%25").replace("\r", "").replace("\n", "%0A"))

    # Push the full error section to a gist using the built-in token so we can read it.
    try:
        gh = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if gh:
            body = {
                "description": f"Android build log tail run {os.environ.get('GITHUB_RUN_ID','?')}",
                "public": False,
                "files": {
                    "build-tail.txt": {"content": "\n".join(lines[-2000:])[-290000:]},
                },
            }
            req = urllib.request.Request(
                "https://api.github.com/gists",
                data=json.dumps(body).encode(),
                headers={
                    "Authorization": f"Bearer {gh}",
                    "Accept": "application/vnd.github+json",
                    "Content-Type": "application/json",
                    "User-Agent": "android-ci",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read())
                print(f"::warning::Full log tail: {data.get('html_url')}")
    except Exception as e:
        print(f"(gist upload failed: {e})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
