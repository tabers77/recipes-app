"""Verify dist/ is a complete, deployable artifact.

    python tools/verify_dist.py
    python tools/verify_dist.py --expect-commit <full-sha>

Run by CI immediately before handing dist/ to Cloudflare, and runnable locally
for the same check. Deliberately a script rather than inline YAML steps, so the
identical checks are available on a laptop.

Reports every problem it finds rather than stopping at the first, so one CI run
tells you everything that is wrong.

What it is actually guarding against:

  * A missing _worker.js means the Pages project serves every recipe to anyone
    who has the URL. That is the one failure here with a real consequence.
  * An unstamped SHELL_VERSION means installed phones keep serving old code
    silently, which is the failure mode nobody notices for weeks.
  * A file in public/ missing from the service worker's SHELL_FILES is broken
    offline and works perfectly on a desktop, so it survives casual testing.
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, "dist")

REQUIRED_FILES = (
    "index.html",
    "app.js",
    "db.js",
    "style.css",
    "sw.js",
    "manifest.webmanifest",
    # Without this the Pages project serves the app to anyone with the URL.
    "_worker.js",
)

REQUIRED_ICONS = (
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-192-maskable.png",
    "icons/icon-512-maskable.png",
)

# Files starting with "_" are normally development leftovers, except this one.
ALLOWED_UNDERSCORE = {"_worker.js"}

PLACEHOLDER_VERSION = "v1"

# Not listed in SHELL_FILES on purpose: a service worker must not cache itself,
# index.html is precached as './', and _worker.js runs server-side and is never
# fetched by the browser at all.
NOT_IN_SHELL = {"sw.js", "index.html", "_worker.js"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect-commit", default="",
                        help="full SHA this deploy is for; SHELL_VERSION must be a prefix of it")
    args = parser.parse_args()

    problems = []

    if not os.path.isdir(DIST):
        sys.exit("verify: dist/ does not exist -- run tools/build.py first")

    # --------------------------------------------------------- files present
    for name in REQUIRED_FILES + REQUIRED_ICONS:
        path = os.path.join(DIST, name)
        if not os.path.isfile(path):
            problems.append("missing: %s" % name)
        elif os.path.getsize(path) == 0:
            problems.append("empty: %s" % name)

    # ------------------------------------------------------- no dev leftovers
    for dirpath, _, names in os.walk(DIST):
        for name in names:
            if name.startswith("_") and name not in ALLOWED_UNDERSCORE:
                rel = os.path.relpath(os.path.join(dirpath, name), DIST)
                problems.append("unexpected underscore file: %s" % rel)
            if name.endswith((".map", ".orig", ".rej", ".bak")):
                rel = os.path.relpath(os.path.join(dirpath, name), DIST)
                problems.append("build leftover: %s" % rel)

    # -------------------------------------------------------------- manifest
    manifest_path = os.path.join(DIST, "manifest.webmanifest")
    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path, encoding="utf-8") as fh:
                manifest = json.load(fh)
        except ValueError as err:
            problems.append("manifest.webmanifest is not valid JSON: %s" % err)
        else:
            for key in ("name", "start_url", "display", "icons"):
                if not manifest.get(key):
                    problems.append("manifest.webmanifest is missing %r" % key)
            for icon in manifest.get("icons", []):
                src = icon.get("src", "")
                if src and not os.path.isfile(os.path.join(DIST, src)):
                    problems.append("manifest references a missing icon: %s" % src)

    # ------------------------------------------------------- SHELL_VERSION
    sw_path = os.path.join(DIST, "sw.js")
    shell_files = []
    if os.path.isfile(sw_path):
        with open(sw_path, encoding="utf-8") as fh:
            sw = fh.read()

        match = re.search(r"^var SHELL_VERSION = '([^']*)';$", sw, re.MULTILINE)
        if not match:
            problems.append("sw.js has no SHELL_VERSION declaration")
        else:
            version = match.group(1)
            if args.expect_commit:
                if version == PLACEHOLDER_VERSION:
                    problems.append(
                        "sw.js SHELL_VERSION is still the %r placeholder -- "
                        "tools/build.py did not stamp it, so installed phones "
                        "would keep serving the previous deploy"
                        % PLACEHOLDER_VERSION)
                elif not args.expect_commit.startswith(version):
                    problems.append(
                        "sw.js SHELL_VERSION %r is not a prefix of the deploying "
                        "commit %r" % (version, args.expect_commit))

        shell_files = re.findall(r"'(\./[^']*)'", sw)

    # ------------------------------------------- every asset is cached offline
    if shell_files:
        listed = set(shell_files)
        for dirpath, _, names in os.walk(DIST):
            for name in names:
                rel = os.path.relpath(os.path.join(dirpath, name), DIST).replace(os.sep, "/")
                if rel in NOT_IN_SHELL:
                    continue
                if "./" + rel not in listed:
                    problems.append(
                        "in dist/ but not in sw.js SHELL_FILES, so unavailable "
                        "offline: %s" % rel)
        for entry in listed:
            rel = entry[2:]
            if rel and not os.path.isfile(os.path.join(DIST, rel)):
                problems.append("sw.js precaches a file that is not in dist/: %s" % entry)

    # ----------------------------------------------------------------- report
    if problems:
        print("verify: %d problem(s)" % len(problems))
        for p in problems:
            print("  - %s" % p)
        sys.exit(1)

    print("verify: dist/ is deployable")


if __name__ == "__main__":
    main()
