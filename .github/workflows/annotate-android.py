#!/usr/bin/env python3
"""Emit proper per-file ::error annotations for Kotlin compiler errors."""
import os
import re
import sys

KOTLIN_ERR_RE = re.compile(r"^e:\s*([^:]+):(\d+):(\d+):\s*(.*)$")


def main() -> int:
    if len(sys.argv) < 3:
        return 2
    try:
        exit_code = int(sys.argv[1])
    except ValueError:
        exit_code = 1
    log_path = sys.argv[2]
    with open(log_path, errors="replace") as f:
        lines = f.read().splitlines()

    if exit_code == 0:
        print("::notice::Android build + scanner tests OK")
        return 0

    repo_root = os.getcwd()  # GITHUB_WORKSPACE/mobile when script runs; repo root is parent
    emitted = 0
    for l in lines:
        m = KOTLIN_ERR_RE.match(l.strip())
        if m:
            fpath, lineno, col, msg = m.groups()
            # Map absolute /gradle-cache style paths to repo-relative paths.
            rel = fpath
            if "/mobile/" in fpath:
                rel = "mobile/" + fpath.split("/mobile/", 1)[1]
            elif fpath.startswith("/") and not fpath.startswith(repo_root):
                # absolute path outside workspace — fall back to file name only
                rel = os.path.basename(fpath)
            safe = msg.replace("%", "%25").replace("\r", "").replace("\n", " ")
            print(f"::error file={rel},line={lineno},col={col}::{safe}")
            print(f"KOTLIN-ERR {rel}:{lineno}:{col}: {safe}", file=sys.stderr)
            emitted += 1
            if emitted >= 80:
                break

    if emitted == 0:
        # Fallback: last 80 lines as a single annotation on build.gradle.kts
        tail = "\n".join(lines[-80:])
        if len(tail) > 1400:
            tail = tail[:1400] + "\n...truncated"
        print("::error file=mobile/app/build.gradle.kts,line=1::" + tail.replace("%", "%25").replace("\r", "").replace("\n", "%0A"))

    return 0


if __name__ == "__main__":
    sys.exit(main())
