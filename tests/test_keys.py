"""make tenant and make new-key, against the real database."""

import pytest
from sqlalchemy.exc import IntegrityError

from app.scripts import create_tenant, new_key


async def documents(env, key):
    return await env.client.get("/documents", headers={"X-API-Key": key})


async def test_a_new_key_opens_the_same_workspace_and_the_old_key_still_works(env):
    await env.upload("a", "alpha.pdf", ["Alpha budget report."])

    key = await new_key.issue(env.sessions, "a")

    assert key.startswith("atlas_")
    assert [d["name"] for d in (await documents(env, key)).json()] == ["alpha.pdf"]
    assert (await documents(env, env.keys["a"])).status_code == 200


async def test_a_new_key_doesnt_open_another_workspace(env):
    await env.upload("b", "theirs.pdf", ["Tenant B's report."])
    key = await new_key.issue(env.sessions, "a")
    assert (await documents(env, key)).json() == []


async def test_no_key_for_a_workspace_that_doesnt_exist(env):
    assert await new_key.issue(env.sessions, "nobody") is None


async def test_creating_a_workspace_gives_a_working_key(env):
    _, key = await create_tenant.create(env.sessions, "fresh")
    assert (await documents(env, key)).json() == []


async def test_a_taken_name_is_refused(env):
    with pytest.raises(IntegrityError):
        await create_tenant.create(env.sessions, "a")
