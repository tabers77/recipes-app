"""Assemble the deployable artifact in dist/.

    python tools/build.py                     # SHELL_VERSION stays 'v1'
    python tools/build.py --commit <sha>      # stamp it, as CI does

There is nothing to compile -- the app is static files -- so this does exactly
two things:

  1. Copies public/ to dist/.
  2. Rewrites SHELL_VERSION in dist/sw.js to the commit being deployed.

Step 2 is the whole reason this script exists. SHELL_VERSION names the service
worker's cache, so shipping new code under an unchanged key leaves installed
phones serving the old app forever, and silently. Stamping it with the commit
makes that impossible to forget. The source file keeps the 'v1' placeholder;
only dist/ is stamped, so local development is not churning cache names on
every commit.

dist/ is generated and gitignored. Never edit it.
"""

import argparse
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "public")
DIST = os.path.join(ROOT, "dist")

PLACEHOLDER = "v1"
# Matches the declaration in public/sw.js. Anchored to the start of a line so a
# mention of SHELL_VERSION in a comment cannot be rewritten by accident.
VERSION_RE = re.compile(r"^var SHELL_VERSION = '([^']*)';$", re.MULTILINE)


def stamp(path, commit):
    """Rewrite SHELL_VERSION in dist/sw.js. Returns the value written."""
    with open(path, encoding="utf-8") as fh:
        source = fh.read()

    match = VERSION_RE.search(source)
    if not match:
        sys.exit("build: no SHELL_VERSION declaration found in %s" % path)
    if match.group(1) != PLACEHOLDER:
        # The source file is supposed to carry the placeholder; anything else
        # means someone hand-edited it and the stamping contract has drifted.
        sys.exit("build: expected SHELL_VERSION '%s' in source, found '%s'"
                 % (PLACEHOLDER, match.group(1)))

    if not commit:
        return PLACEHOLDER

    version = commit[:12]
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(VERSION_RE.sub("var SHELL_VERSION = '%s';" % version, source, count=1))
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA", ""),
                        help="commit to stamp into SHELL_VERSION (default: $GITHUB_SHA)")
    args = parser.parse_args()

    if not os.path.isdir(SRC):
        sys.exit("build: %s does not exist" % SRC)

    # Rebuilt from scratch every time: a leftover file from a previous layout
    # would otherwise be deployed forever, invisible in git.
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    shutil.copytree(SRC, DIST)

    version = stamp(os.path.join(DIST, "sw.js"), args.commit)

    files = sum(len(names) for _, _, names in os.walk(DIST))
    print("build: dist/ has %d files, SHELL_VERSION = %s%s"
          % (files, version, "" if args.commit else "  (placeholder, not stamped)"))


if __name__ == "__main__":
    main()
