"""Create a tenant, its atlas API key, and its forge API key.

Usage (in the stack):  make tenant NAME=acme
The atlas key is printed once; only its SHA-256 is stored. The forge key is
appended to forge's tenants file, which forge re-reads every 30s, so the
tenant can ask questions within half a minute.
"""

import asyncio
import os
import secrets
import sys

from app.api.deps import hash_key
from app.config import get_settings
from app.db.session import make_engine, make_sessionmaker
from app.models import ApiKey, Tenant

FORGE_TENANTS_FILE = os.environ.get("FORGE_TENANTS_FILE", "deploy/forge-tenants.yaml")
FORGE_DAILY_TOKEN_QUOTA = int(os.environ.get("FORGE_DAILY_TOKEN_QUOTA", "200000"))


async def main(name: str) -> None:
    engine = make_engine(get_settings())
    raw_key = "atlas_" + secrets.token_urlsafe(32)
    forge_key = "forge-atlas-" + secrets.token_urlsafe(32)
    async with make_sessionmaker(engine)() as session:
        tenant = Tenant(name=name, forge_api_key=forge_key)
        session.add(tenant)
        await session.flush()
        session.add(ApiKey(tenant_id=tenant.id, key_hash=hash_key(raw_key), name="default"))
        # ponytail: appending to a YAML file is the local-dev stand-in for
        # provisioning forge; on GKE this would write forge's tenants Secret.
        # Append mode keeps the file's inode, so forge's bind mount sees it.
        with open(FORGE_TENANTS_FILE, "a") as f:
            f.write(
                f"  - name: atlas-{name}\n"
                f"    api_key: {forge_key}\n"
                f"    daily_token_quota: {FORGE_DAILY_TOKEN_QUOTA}\n"
            )
        await session.commit()  # only once forge knows the key
    await engine.dispose()
    print(f"tenant {name!r} created (id {tenant.id}); forge picks it up within 30s")
    print(f"API key (shown once): {raw_key}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.scripts.create_tenant NAME")
    asyncio.run(main(sys.argv[1]))
