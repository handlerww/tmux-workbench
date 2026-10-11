.PHONY: build frontend test clean run docker-build docker-run docker-stop docker-logs
BIN := bin/workbench
export GOCACHE ?= /tmp/workbench-go-cache
build: frontend
	go build -trimpath -o $(BIN) ./cmd/workbench
frontend:
	npm --prefix frontend ci
	npm --prefix frontend run build
test: frontend
	go test ./...
	npm --prefix frontend test
clean:
	rm -rf bin
run:
	go run ./cmd/workbench
docker-build:
	docker compose build workbench
docker-run:
	docker compose up -d
docker-stop:
	docker compose stop workbench
docker-logs:
	docker compose logs --follow workbench
