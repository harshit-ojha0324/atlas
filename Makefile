.PHONY: up down clean logs ps tenant test lint

up:            ## build + start the stack (api, postgres, redis, forge + mock models)
	docker compose up -d --build --wait

down:
	docker compose down

clean:         ## down + wipe the postgres volume
	docker compose down -v

logs:
	docker compose logs -f api forge

ps:
	docker compose ps

tenant:        ## create a tenant and print its API key once: make tenant NAME=acme
	docker compose run --rm --no-deps api python -m app.scripts.create_tenant $(NAME)

test:          ## all tests; the isolation tests need `make up` (Postgres on 5433) and skip without it
	pytest -q

lint:
	ruff check . && ruff format --check .
