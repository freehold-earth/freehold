# Build context is the repository root: docker build -f demo/operator/server/Dockerfile .
FROM golang:1.27.4-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY demo/operator/server ./demo/operator/server
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./demo/operator/server

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=builder /out/server /usr/local/bin/server
EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/server"]
CMD ["-listen", "0.0.0.0:9000"]
