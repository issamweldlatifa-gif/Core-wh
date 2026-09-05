#!/usr/bin/env python3
"""Strip ANSI, find any line containing obvious error keywords, emit annotations."""
import os
import re
import sys
import glob
import xml.etree.ElementTree as ET

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


def escape(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def summarize_reports() -> None:
    # Accessible through the Checks API even if an artifact CDN is unavailable.
    for module in ("scanner-core", "worker-core"):
        files = glob.glob(f"{module}/build/test-results/test/TEST-*.xml")
        total = failed = skipped = 0
        for path in files:
            root = ET.parse(path).getroot()
            total += int(root.get("tests", 0))
            failed += int(root.get("failures", 0)) + int(root.get("errors", 0))
            skipped += int(root.get("skipped", 0))
            for case in root.findall("testcase"):
                for failure in list(case.findall("failure")) + list(case.findall("error")):
                    message = f"{module}: {case.get('classname')}.{case.get('name')}: {failure.get('message', '')}\n{failure.text or ''}"
                    print("::error::" + escape(message[:3500]))
        if files:
            print(f"::notice::{module}: {total} tests, {failed} failures, {skipped} skipped")
    for path in glob.glob("app/build/reports/lint-results-*.xml"):
        for issue in ET.parse(path).getroot().findall("issue"):
            if issue.get("severity") not in ("Error", "Fatal"):
                continue
            message = f"Lint {issue.get('id')}: {issue.get('message')}"
            location = issue.find("location")
            where = "" if location is None else f" file={to_rel(location.get('file', 'mobile/app/build.gradle.kts'))},line={location.get('line', '1')}"
            print(f"::error{where}::" + escape(message))


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

    summarize_reports()
    if exit_code == 0:
        print("::notice::Android core tests, compile and lint OK")
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

    # Full logs stay in the controlled CI artifact; never publish build logs to a gist.

    return 0


if __name__ == "__main__":
    sys.exit(main())
