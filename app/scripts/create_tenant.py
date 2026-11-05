"""Create a tenant and its atlas API key.

Usage (in the stack):  make tenant NAME=acme
The key is printed once; only its SHA-256 is stored. forge needs nothing: atlas
names the tenant on each call, so the tenant can ask questions straight away.
"""

import asyncio
import secrets
import sys

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import hash_key
from app.config import get_settings
from app.db.session import make_engine, make_sessionmaker
from app.models import ApiKey, Tenant


def add_key(session: AsyncSession, tenant_id: int, key_name: str) -> str:
    """Add a new key to the session and return it. It can't be read back later."""
    raw_key = "atlas_" + secrets.token_urlsafe(32)
    session.add(ApiKey(tenant_id=tenant_id, key_hash=hash_key(raw_key), name=key_name))
    return raw_key


async def create(sessions, name: str) -> tuple[int, str]:
    """The new tenant's id and key. Raises IntegrityError if the name is taken."""
    async with sessions() as session:
        tenant = Tenant(name=name)
        session.add(tenant)
        await session.flush()
        raw_key = add_key(session, tenant.id, "default")
        await session.commit()
        return tenant.id, raw_key


async def main(name: str) -> None:
    engine = make_engine(get_settings())
    try:
        tenant_id, raw_key = await create(make_sessionmaker(engine), name)
    except IntegrityError:
        sys.exit(
            f"A workspace called {name!r} already exists. Choose another name, "
            f"or get a new key for it: make new-key NAME={name}"
        )
    finally:
        await engine.dispose()
    print(f"tenant {name!r} created (id {tenant_id})")
    print(f"API key (shown once): {raw_key}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.scripts.create_tenant NAME")
    asyncio.run(main(sys.argv[1]))
