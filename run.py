#!/usr/bin/env python3
"""Tiny static server for the DDIA Study web app. Run: python3 run.py [port]"""
import http.server
import functools
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HERE = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def end_headers(self):
        # Never cache content JSON during development
        if self.path.startswith("/content/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as srv:
        print(f"DDIA Study running at http://localhost:{PORT}/")
        print("Press Ctrl+C to stop.")
        srv.serve_forever()
