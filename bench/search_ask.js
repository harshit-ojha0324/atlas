// k6 load test: /search and /ask at a steady arrival rate, run by scripts/bench.py.
//
// /search exercises atlas alone: query embedding on CPU plus the pgvector scan.
// /ask adds the security layer and a forge round trip; it cycles through the
// eval questions, so after the first pass forge serves them from its cache and
// what's measured is atlas's own overhead on top of forge.
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL;
const HEADERS = { "X-API-Key": __ENV.API_KEY, "Content-Type": "application/json" };
const QUESTIONS = JSON.parse(__ENV.QUESTIONS);
const DURATION = __ENV.DURATION || "60s";

export const options = {
  scenarios: {
    search: {
      executor: "constant-arrival-rate", exec: "search",
      rate: Number(__ENV.SEARCH_RPS || 50), timeUnit: "1s", duration: DURATION,
      preAllocatedVUs: 20, maxVUs: 200,
    },
    ask: {
      executor: "constant-arrival-rate", exec: "ask",
      rate: Number(__ENV.ASK_RPS || 10), timeUnit: "1s", duration: DURATION,
      preAllocatedVUs: 10, maxVUs: 100,
    },
  },
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration{scenario:search}": [`p(95)<${__ENV.SEARCH_P95_MS || 250}`],
    "http_req_duration{scenario:ask}": [`p(95)<${__ENV.ASK_P95_MS || 500}`],
    // per-scenario request counts in the summary (k6 only splits out thresholded metrics)
    "http_reqs{scenario:search}": ["count>0"],
    "http_reqs{scenario:ask}": ["count>0"],
  },
};

const pick = () => QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];

export function search() {
  const r = http.post(`${BASE}/search`, JSON.stringify({ query: pick(), k: 4 }), { headers: HEADERS });
  check(r, { "search 200": (res) => res.status === 200 });
}

export function ask() {
  const r = http.post(`${BASE}/ask`, JSON.stringify({ question: pick() }), { headers: HEADERS });
  check(r, { "ask 200 with sources": (res) => res.status === 200 && res.json("sources").length > 0 });
}
