from urllib.parse import parse_qs, urlsplit

from server import Handler


class handler(Handler):
    """Route all /api/* calls through the same handler used by local development."""

    def do_GET(self):
        route = parse_qs(urlsplit(self.path).query).get("route", [None])[0]
        if route:
            self.path = route
        super().do_GET()

    def do_POST(self):
        route = parse_qs(urlsplit(self.path).query).get("route", [None])[0]
        if route:
            self.path = route
        super().do_POST()
