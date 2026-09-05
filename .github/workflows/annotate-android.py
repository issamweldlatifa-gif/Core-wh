#!/usr/bin/env python3
"""Annotate Android build log for GitHub Actions."""
import sys


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
    errors = []
    for l in lines:
        s = l.strip()
        if (
            s.startswith("e:")
            or "unresolved reference" in s.lower()
            or "type mismatch" in s.lower()
            or "cannot access" in s.lower()
            or "too many arguments" in s.lower()
            or "no value passed" in s.lower()
            or "none of the following functions" in s.lower()
            or ("error:" in s.lower() and ".kt:" in s)
        ):
            errors.append(s)
        if len(errors) >= 80:
            break
    if not errors:
        # Look for failure footer
        for i, l in enumerate(lines):
            if l.startswith("* What went wrong"):
                errors = lines[i:i+20]
                break
    if not errors:
        errors = lines[-60:]
    msg = "\n".join(errors)
    if len(msg) > 1400:
        msg = msg[:1400] + "\n...truncated"
    print("::error file=mobile/app/build.gradle.kts,line=1,title=Build errors::" + msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
