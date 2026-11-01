"""Create a tenant and its atlas API key.

Usage (in the stack):  make tenant NAME=acme
The key is printed once; only its SHA-256 is stored. forge needs nothing: atlas
names the tenant on each call, so the tenant can ask questions straight away.
"""

import asyncio
import secrets
import sys

from app.api.deps import hash_key
from app.config import get_settings
from app.db.session import make_engine, make_sessionmaker
from app.models import ApiKey, Tenant


async def main(name: str) -> None:
    engine = make_engine(get_settings())
    raw_key = "atlas_" + secrets.token_urlsafe(32)
    async with make_sessionmaker(engine)() as session:
        tenant = Tenant(name=name)
        session.add(tenant)
        await session.flush()
        session.add(ApiKey(tenant_id=tenant.id, key_hash=hash_key(raw_key), name="default"))
        await session.commit()
    await engine.dispose()
    print(f"tenant {name!r} created (id {tenant.id})")
    print(f"API key (shown once): {raw_key}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.scripts.create_tenant NAME")
    asyncio.run(main(sys.argv[1]))
