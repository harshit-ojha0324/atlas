"""atlas over MCP: one tenant's documents as tools for any MCP client
(the navigator's agent, Claude Code, Claude Desktop, ...).

A thin client of atlas's REST API, run with one tenant's atlas API key. Every
call goes through the API, so tenant isolation, rate limits, the security
layer and forge apply exactly as they do over HTTP. The server adds no auth of
its own: whoever can reach it acts as that tenant, so it binds to localhost by
default. (Per-caller MCP auth would let one server serve many tenants; not
needed while each tenant runs its own.)

Pattern from smart-city-navigator: the mcp SDK's MCPServer over streamable
HTTP. API errors become ToolError, so the calling model reads the API's own
reason ("rate limit exceeded", "question blocked: ...") instead of a crash.

Run:  ATLAS_API_KEY=atlas_... python -m app.mcp_server           # streamable HTTP, :8090/mcp
      ATLAS_API_KEY=atlas_... python -m app.mcp_server --stdio   # for clients that launch it
"""

import os
import sys

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

API_URL = os.environ.get("ATLAS_API_URL", "http://localhost:8000")
HOST = os.environ.get("ATLAS_MCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("ATLAS_MCP_PORT", "8090"))

mcp = MCPServer("atlas")


def api() -> httpx.AsyncClient:
    """A client for atlas's REST API, as this server's tenant. One per call, as
    the navigator's MCP client does: nothing to keep alive or go stale."""
    key = os.environ.get("ATLAS_API_KEY")
    if not key:
        raise ToolError("this server has no ATLAS_API_KEY; start it with a tenant's atlas API key")
    # above /ask's own worst case (forge's 90s), so the API's answer or error always arrives first
    return httpx.AsyncClient(base_url=API_URL, headers={"X-API-Key": key}, timeout=120)


async def call(method: str, path: str, **kwargs):
    try:
        async with api() as client:
            r = await client.request(method, path, **kwargs)
    except httpx.HTTPError as e:
        raise ToolError(f"atlas is unreachable at {API_URL}: {e.__class__.__name__}")
    if r.status_code >= 400:
        try:
            detail = r.json()["detail"]
        except Exception:
            detail = r.text[:200]
        retry = f" Retry after {r.headers['retry-after']}s." if "retry-after" in r.headers else ""
        raise ToolError(f"atlas returned {r.status_code}: {detail}.{retry}")
    return r.json()


@mcp.tool(annotations=ToolAnnotations(title="List documents", readOnlyHint=True, idempotentHint=True))
async def list_documents() -> dict:
    """The documents this tenant has uploaded, every version.

    Each has an id, name, status (ready, pending or failed, with an error) and,
    once ready, its page and chunk counts. Only ready documents are searched.
    """
    docs = await call("GET", "/documents")
    return {"count": len(docs), "documents": docs}


@mcp.tool(annotations=ToolAnnotations(title="Search documents", readOnlyHint=True, idempotentHint=True))
async def search_documents(query: str, k: int = 4) -> dict:
    """The k passages (1-20) from this tenant's documents nearest to `query`.

    Each result has the document name, page, text and a cosine score (1.0 means
    identical). Use it to read the documents yourself; use `ask` for an answer.
    """
    return {"query": query, "results": await call("POST", "/search", json={"query": query, "k": k})}


@mcp.tool(annotations=ToolAnnotations(title="Ask the documents", readOnlyHint=True, openWorldHint=True))
async def ask(question: str) -> dict:
    """Answer a question from this tenant's documents, with page citations.

    Ask a standalone question (name the subject; don't rely on earlier turns).
    Returns the answer, its sources, and any security warnings (PII redacted,
    passages withheld). Questions that look like prompt injections are refused;
    if nothing in the documents is relevant, the answer says so.
    """
    return await call("POST", "/ask", json={"question": question})


if __name__ == "__main__":
    if not os.environ.get("ATLAS_API_KEY"):
        sys.exit("set ATLAS_API_KEY to a tenant's atlas API key (make tenant prints one)")
    if "--stdio" in sys.argv:
        mcp.run()
    else:
        mcp.run(transport="streamable-http", host=HOST, port=PORT)
