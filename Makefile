.PHONY: build ui build-web dev test lint docker

build:
	CGO_ENABLED=0 go build -o bin/articlecms ./cmd/articlecms

ui:
	cd web && npm ci && npm run build

build-web: ui build

test:
	go test -race ./...

lint:
	gofmt -l . | (! grep .) && go vet ./...

docker:
	docker build -t articlecms .
