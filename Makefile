.PHONY: up down clean logs ps tenant mcp test eval drill drill-fairness bench lint

up:            ## build + start the stack (api, worker, postgres, redis, forge + mock models)
	cp -n deploy/forge-tenants.example.yaml deploy/forge-tenants.yaml 2>/dev/null || true
	docker compose up -d --build --wait

down:
	docker compose down

clean:         ## down + wipe the postgres volume
	docker compose down -v

logs:
	docker compose logs -f api worker forge

ps:
	docker compose ps

tenant:        ## create a tenant and print its API key once: make tenant NAME=acme
	docker compose run --rm --no-deps --user $$(id -u):$$(id -g) api python -m app.scripts.create_tenant $(NAME)

mcp:           ## serve one tenant's documents over MCP on localhost:8090/mcp: make mcp KEY=atlas_...
	ATLAS_API_KEY=$(KEY) docker compose --profile mcp up -d --build --wait mcp

test:          ## all tests; the isolation tests need `make up` (Postgres on 5433) and skip without it
	pytest -q

eval:          ## the RAG app's eval set, end to end through the stack (gates at 85%)
	python scripts/run_eval.py

drill:         ## SIGKILL the worker mid-ingest, restart it, check the document lands exactly once
	python scripts/drill_kill_worker.py

drill-fairness: ## one tenant's backlog must delay another tenant's upload by ~one document, not all of it
	python scripts/drill_noisy_neighbour.py

bench:         ## k6 load test of /search and /ask (gates on errors and p95)
	python scripts/bench.py

lint:
	ruff check . && ruff format --check .
