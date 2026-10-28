.PHONY: up down clean logs ps test lint

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

test:          ## unit tests, no Docker needed
	pytest -q

lint:
	ruff check . && ruff format --check .
