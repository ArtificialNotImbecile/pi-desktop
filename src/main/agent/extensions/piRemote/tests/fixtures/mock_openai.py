#!/usr/bin/env python3
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write((fmt % args) + "\n")

    def do_GET(self):
        payload = json.dumps({"object": "list", "data": [{"id": "mock", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        with open("mock.requests.jsonl", "a", encoding="utf-8") as log:
            log.write(json.dumps({"client": self.client_address[0], "body": body}, separators=(",", ":")) + "\n")
        content = "REMOTE_MOCK_OK"
        if any("disconnect-survival" in str(message.get("content", "")) for message in body.get("messages", [])):
            time.sleep(3)
            content = "REMOTE_DISCONNECT_SURVIVED"
        if any("history-check" in str(message.get("content", "")) for message in body.get("messages", [])):
            content = "REMOTE_HISTORY_RESUMED" if any("live-headless" in str(message.get("content", "")) for message in body.get("messages", [])) else "REMOTE_HISTORY_MISSING"
        chunks = [
            {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":0,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","content":content},"finish_reason":None}]},
            {"id":"chatcmpl-mock","object":"chat.completion.chunk","created":0,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True

ThreadingHTTPServer(("127.0.0.1", 18080), Handler).serve_forever()
