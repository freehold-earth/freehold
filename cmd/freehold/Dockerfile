# Build context is the repository root: docker build -f cmd/freehold/Dockerfile .
FROM golang:1.27.4-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
# What `freehold --version` reports. A build that passes none says "dev".
ARG VERSION=dev
ARG COMMIT=unknown
ARG DATE=unknown
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w \
      -X 'github.com/freehold-earth/freehold/internal/version.version=${VERSION}' \
      -X 'github.com/freehold-earth/freehold/internal/version.commit=${COMMIT}' \
      -X 'github.com/freehold-earth/freehold/internal/version.date=${DATE}'" \
    -o /out/freehold ./cmd/freehold
# The directory an operator's key and audit record are kept in, made here so that it can be handed to the user the
# image runs as: the image below has no shell to make it with.
RUN mkdir -p /out/data

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=builder /out/freehold /usr/local/bin/freehold
COPY --from=builder --chown=nonroot:nonroot --chmod=0700 /out/data /var/lib/freehold
VOLUME /var/lib/freehold
ENTRYPOINT ["/usr/local/bin/freehold"]
