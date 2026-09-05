#!/usr/bin/env python3
"""Annotate Android build log for GitHub Actions.

Prints *every* Kotlin compiler error line (``e: file.kt:line:col: ...``) we
can find, plus the Gradle ``* What went wrong`` footer. GitHub annotations
truncate at ~1500 chars, so we stay tight but include ALL errors (not just
the first 80-line window) to diagnose multi-error builds.
"""
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: annotate-android.py <exit_code> <log_path>", file=sys.stderr)
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

    # Collect every Kotlin error line (e: ...); cap at 200 lines to fit the
    # annotation budget.
    error_lines = []
    for i, l in enumerate(lines):
        stripped = l.strip()
        if (
            stripped.startswith("e:")
            or "unresolved reference" in stripped.lower()
            or "type mismatch" in stripped.lower()
            or "cannot access" in stripped.lower()
            or "too many arguments" in stripped.lower()
            or "no value passed" in stripped.lower()
            or "none of the following functions" in stripped.lower()
            or "exception in thread" in stripped.lower()
            or "execution failed for task" in stripped.lower()
            or "compilation error" in stripped.lower()
            or "error:" in stripped.lower()
        ):
            error_lines.append(stripped)
        if len(error_lines) >= 250:
            break

    # Also grab the Gradle failure footer if present.
    footer_idx = next(
        (i for i, l in enumerate(lines) if l.startswith("* What went wrong")),
        -1,
    )
    footer = []
    if footer_idx >= 0:
        footer = lines[footer_idx : footer_idx + 30]

    chunks = []
    if error_lines:
        chunks.append("KOTLIN ERRORS:")
        chunks.extend(error_lines)
    if footer:
        chunks.append("---")
        chunks.extend(footer)
    if not chunks:
        # Fallback: last 80 lines of log.
        chunks = lines[-80:]

    msg = "\n".join(chunks)
    # Stay well under the ~1500-char annotation limit; if too long, split into multiple notices.
    def emit(prefix, text):
        print(prefix + text.replace("%", "%25").replace("\r", "").replace("\n", "%0A"))
    if len(msg) <= 1400:
        emit("::error::", msg)
    else:
        # Chunk into several error annotations so nothing is lost.
        piece = ""
        idx = 0
        for ln in msg.split("\n"):
            if len(piece) + len(ln) + 1 > 1300:
                emit(f"::error file=.github,line=19,title=Build log chunk {idx}::", piece)
                piece = ln
                idx += 1
            else:
                piece = piece + "\n" + ln if piece else ln
        if piece:
            emit(f"::error file=.github,line=19,title=Build log chunk {idx}::", piece)
    return 0


if __name__ == "__main__":
    sys.exit(main())
