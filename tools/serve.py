"""Development server for public/.

    python tools/serve.py            # http://localhost:8080
    python tools/serve.py 9000       # a different port

Why this exists rather than `python -m http.server`:

  * **No caching, ever.** Every response carries `Cache-Control: no-store`, so a
    reload always fetches the file on disk. The stock server sends
    `Last-Modified` and nothing else, which lets a browser hold a stale copy of
    app.js and show you an old bug you already fixed. That cost an evening once.

  * **The right directory by default.** `--directory public` is easy to forget,
    and forgetting it from the repo root serves the source tree instead of the
    app, including PLAN.md and the test suite.

  * **A clear message when the port is taken.** Windows reports an occupied port
    as WinError 10013 "forbidden by its access permissions", which reads like a
    firewall problem. On this machine Docker Desktop and WSL hold 8000.

The service worker is NOT disabled here -- localhost is a secure context, so it
registers and then serves the shell from its own cache, which no-store does not
touch. If you are iterating on the app and seeing stale code anyway, that is the
service worker, not HTTP: DevTools > Application > Service Workers > Unregister,
or tick "Update on reload".
"""

import functools
import http.server
import os
import socket
import socketserver
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(os.path.dirname(HERE), "public")
DEFAULT_PORT = 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # The whole point of this file.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Drop the date prefix; the interesting part is the request line.
        sys.stderr.write("%s\n" % (fmt % args))


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            sys.exit("serve: %r is not a port number" % sys.argv[1])

    if not os.path.isdir(PUBLIC):
        sys.exit("serve: %s does not exist" % PUBLIC)

    handler = functools.partial(Handler, directory=PUBLIC)
    socketserver.TCPServer.allow_reuse_address = True

    try:
        server = socketserver.TCPServer(("", port), handler)
    except OSError as err:
        # WinError 10013 and 10048 both mean "someone else has this port", but
        # 10013 phrases it as a permissions problem and sends people to their
        # firewall settings for an hour.
        sys.exit(
            "serve: cannot bind port %d (%s).\n"
            "       Something else is already listening. Try another port:\n"
            "           python tools/serve.py 9000\n"
            "       To see what holds it:\n"
            "           Get-NetTCPConnection -LocalPort %d -State Listen"
            % (port, err, port)
        )

    print("serving %s" % PUBLIC)
    print("  http://localhost:%d" % port)
    print("  no-store on every response, so a reload always gets the file on disk")
    print("  Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
