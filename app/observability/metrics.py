"""Prometheus metrics: API side."""

import time

from prometheus_client import Counter, Histogram
from starlette.requests import Request

REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency",
    ["route", "method", "status"],
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0],
)
API_ERRORS = Counter("api_errors_total", "Unhandled API errors", ["route"])


async def latency_middleware(request: Request, call_next):
    start = time.perf_counter()
    status = "500"
    try:
        response = await call_next(request)
        status = str(response.status_code)
        return response
    except Exception:
        API_ERRORS.labels(route=_route_label(request)).inc()
        raise
    finally:
        REQUEST_LATENCY.labels(route=_route_label(request), method=request.method, status=status).observe(
            time.perf_counter() - start
        )


def _route_label(request: Request) -> str:
    # never fall back to the raw URL path: every scanner probe would mint a
    # new label value and blow up Prometheus cardinality
    return getattr(request.scope.get("route"), "path", "unmatched")
