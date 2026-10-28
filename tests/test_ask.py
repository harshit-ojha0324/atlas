"""/ask: every LLM call goes to forge as the asking tenant, with only that tenant's context."""

import json

import httpx
import pytest
import respx
from conftest import FORGE

ALPHA = "Alpha budget report for the river restoration project."
ZEBRA = "Zebra migration patterns across the Serengeti in the dry season."
PENGUIN = "Penguin colonies nest on the Antarctic coast through the winter."


@pytest.fixture
def forge():
    """Mock forge. Records every chat request; answers condense prompts with ZEBRA."""
    calls = []

    def reply(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append({"auth": request.headers["authorization"], **body})
        prompt = body["messages"][0]["content"]
        text = ZEBRA if prompt.rstrip().endswith("Standalone Question:") else "grounded answer [p1]"
        return httpx.Response(
            200,
            json={"choices": [{"message": {"role": "assistant", "content": text}}]},
            headers={"x-forge-backend": "vllm", "x-forge-cache": "miss"},
        )

    with respx.mock(base_url=FORGE, assert_all_called=False) as router:
        route = router.post("/v1/chat/completions").mock(side_effect=reply)
        yield route, calls


async def ask(env, tenant: str, question: str, **extra) -> httpx.Response:
    return await env.client.post("/ask", headers=env.as_tenant(tenant), json={"question": question, **extra})


async def test_answers_as_the_tenant_from_only_its_documents(env, forge):
    _, calls = forge
    await env.upload("a", "alpha.pdf", [ALPHA])
    await env.upload("b", "zebra.pdf", [ZEBRA])
    await env.drain()

    r = await ask(env, "a", "Where do zebras migrate?")
    assert r.status_code == 200
    out = r.json()
    assert out["answer"] == "grounded answer [p1]"
    assert {s["document"] for s in out["sources"]} == {"alpha.pdf"}
    assert (out["forge_backend"], out["forge_cache"]) == ("vllm", "miss")

    (call,) = calls
    assert call["auth"] == "Bearer forge-a"  # A's own forge key: A's quota, A's cache
    assert call["temperature"] == 0 and call["model"] == "forge-default"
    prompt = call["messages"][0]["content"]
    assert "[alpha.pdf, page 1]\n" + ALPHA in prompt
    assert "Serengeti" not in prompt  # B's chunk never reaches A's prompt


async def test_follow_up_is_rewritten_then_used_for_retrieval(env, forge):
    _, calls = forge
    await env.upload("b", "animals.pdf", [PENGUIN, ZEBRA])
    await env.drain()

    history = [
        {"role": "user", "content": "Tell me about zebras."},
        {"role": "assistant", "content": "They are striped."},
    ]
    out = (await ask(env, "b", "Where do they go in the dry season?", history=history, k=1)).json()

    assert len(calls) == 2
    assert "Human: Tell me about zebras.\nAssistant: They are striped." in calls[0]["messages"][0]["content"]
    assert out["question"] == ZEBRA  # the rewrite, which (FakeEmbedder) exactly matches page 2
    assert [s["page"] for s in out["sources"]] == [2]
    assert ZEBRA in calls[1]["messages"][0]["content"] and PENGUIN not in calls[1]["messages"][0]["content"]


async def test_no_documents_means_no_llm_call(env, forge):
    route, _ = forge
    out = (await ask(env, "a", "Anything?")).json()
    assert out["sources"] == [] and out["forge_backend"] is None
    assert not route.called


@pytest.mark.parametrize(
    "forge_response, status, retry_after",
    [
        (
            httpx.Response(429, json={"error": {"message": "quota exhausted"}}, headers={"Retry-After": "7"}),
            429,
            "7",
        ),
        (httpx.Response(401, json={"error": {"message": "invalid key"}}), 503, None),
        (httpx.Response(502, json={"error": {"message": "all backends failed"}}), 502, None),
        (httpx.ConnectError("refused"), 502, None),
    ],
)
async def test_forge_failures_map_to_honest_statuses(env, forge, forge_response, status, retry_after):
    route, _ = forge
    await env.upload("a", "alpha.pdf", [ALPHA])
    await env.drain()
    route.mock(side_effect=[forge_response])
    r = await ask(env, "a", "budget?")
    assert r.status_code == status
    assert r.headers.get("retry-after") == retry_after


async def test_tenant_without_a_forge_key_is_refused(env, forge):
    from sqlalchemy import update

    from app.models import Tenant

    async with env.sessions.begin() as session:
        await session.execute(update(Tenant).values(forge_api_key=None))
    assert (await ask(env, "a", "budget?")).status_code == 503
