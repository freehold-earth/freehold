# pci-contracts Makefile
# Run 'make help' to see available targets

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

.PHONY: dev
dev: ## Start Yaci devnet (docker compose up -d)
	docker compose up -d

.PHONY: down
down: ## Stop devnet and remove volumes
	docker compose down -v

.PHONY: logs
logs: ## Tail devnet logs
	docker compose logs -f

.PHONY: status
status: ## Check devnet health
	@echo "Devnet containers:"
	@docker compose ps
	@echo ""
	@echo "Yaci Store API:"
	@curl -s http://localhost:8080/api/v1/blocks/latest | head -c 200 || echo "Not responding"
	@echo ""

.PHONY: test
test: ## Run unit tests
	pnpm test:run

.PHONY: test-int
test-int: ## Run integration tests (requires devnet running)
	pnpm test:integration

.PHONY: test-all
test-all: ## Run all tests
	pnpm test:run && pnpm test:integration

.PHONY: lint
lint: ## Type check with TypeScript
	pnpm lint

.PHONY: build
build: ## Build the package
	pnpm build

.PHONY: clean
clean: ## Clean build artifacts
	pnpm clean
