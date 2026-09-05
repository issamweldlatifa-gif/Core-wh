#!/usr/bin/env python3
"""Emit per-file ::error annotations for Kotlin/Java/Gradle errors and print them to stdout."""
import os
import re
import sys

KOTLIN_ERR_RE = re.compile(r"^e:\s*([^:]+):(\d+):(?:(\d+):)?\s*(.*)$")


def to_repo_rel(fpath: str) -> str:
    # Make a workspace-relative path like "mobile/app/.../Foo.kt" so GitHub can
    # attach the annotation to the right file.
    if "/mobile/" in fpath:
        return "mobile/" + fpath.split("/mobile/", 1)[1]
    if "/scanner-core/" in fpath:
        return "mobile/scanner-core/" + fpath.split("/scanner-core/", 1)[1]
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
        lines = f.read().splitlines()

    if exit_code == 0:
        print("::notice::Android build + scanner tests OK")
        return 0

    print("=== KOTLIN/GRADLE ERRORS (from build log) ===")
    emitted = 0
    for l in lines:
        s = l.strip()
        m = KOTLIN_ERR_RE.match(s)
        if m:
            fpath, lineno, col, msg = m.groups()
            rel = to_repo_rel(fpath)
            col_attr = f",col={col}" if col else ""
            safe = msg.replace("%", "%25").replace("\r", "").replace("\n", " ")
            print(f"::error file={rel},line={lineno}{col_attr}::{safe}")
            print(f"E {rel}:{lineno}: {msg}")
            emitted += 1
            if emitted >= 80:
                break
        elif s.startswith("* What went wrong") or s.startswith(">") or "FAILED" in s or "FAILURE:" in s:
            # Also surface Gradle's "What went wrong" block.
            print(f"GRADLE: {s}")

    if emitted == 0:
        # Fallback: print last 120 lines so they appear in the job log.
        print("--- (no per-file errors matched; tailing log) ---")
        for ln in lines[-120:]:
            print(ln)
        msg = "\n".join(lines[-60:])[-1400:]
        print("::error file=mobile/app/build.gradle.kts,line=1::" + msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A"))

    print(f"=== emitted {emitted} error annotations ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
