"""Tiny static dev server that disables caching so edits show up on refresh."""
import http.server

PORT = 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


# ThreadingHTTPServer handles the multiple parallel connections browsers open;
# a single-threaded server would serialize them and appear to hang.
with http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"Serving http://localhost:{PORT}/  (no-cache, threaded)")
    httpd.serve_forever()
