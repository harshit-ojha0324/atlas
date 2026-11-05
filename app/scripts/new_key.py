"""Issue another API key for an existing tenant, for when a key is lost.

Usage (in the stack):  make new-key NAME=acme
The key is printed once. Keys already issued keep working.
"""

# ponytail: no revocation, so this can't shut out a leaked key; add it when keys
# are shared beyond one person. The API's key cache would delay it by up to 60s.

import asyncio
import sys

from sqlalchemy import select

from app.config import get_settings
from app.db.session import make_engine, make_sessionmaker
from app.models import Tenant
from app.scripts.create_tenant import add_key


async def issue(sessions, name: str) -> str | None:
    """A new key for the named tenant, or None if there's no such tenant."""
    async with sessions() as session:
        tenant_id = await session.scalar(select(Tenant.id).where(Tenant.name == name))
        if tenant_id is None:
            return None
        raw_key = add_key(session, tenant_id, "reissued")
        await session.commit()
        return raw_key


async def main(name: str) -> None:
    engine = make_engine(get_settings())
    try:
        raw_key = await issue(make_sessionmaker(engine), name)
    finally:
        await engine.dispose()
    if raw_key is None:
        sys.exit(f"There's no workspace called {name!r}. Create one with: make tenant NAME={name}")
    print(f"new key for tenant {name!r}; keys already issued keep working")
    print(f"API key (shown once): {raw_key}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.scripts.new_key NAME")
    asyncio.run(main(sys.argv[1]))
