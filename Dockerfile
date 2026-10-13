FROM --platform=$BUILDPLATFORM node:22-alpine AS ui
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=ui /web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /articlecms ./cmd/articlecms

FROM alpine:3.20
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app && mkdir /data && chown app /data
USER app
COPY --from=build /articlecms /usr/local/bin/articlecms
ENV DATABASE_PATH=/data/articlecms.db PORT=8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/ping || exit 1
ENTRYPOINT ["articlecms"]
