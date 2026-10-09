#!/usr/bin/env python3
"""DDIA Study web app — local launcher.

Serves this folder over HTTP and opens the app in your browser.

Your progress is saved in the browser (localStorage), so closing and
reopening the app keeps everything. The port is fixed on purpose: the
browser ties saved data to the address, so a stable port means your
progress is always found in the same place.
"""
import functools
import http.server
import threading
import webbrowser
import os

PORT = 8123
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
        url = f"http://127.0.0.1:{PORT}/"
        print(f"DDIA Study is running at {url}")
        print("Press Ctrl+C to stop.")
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
