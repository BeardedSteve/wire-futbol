# Lives outside the repo root so Railway does not auto-detect it for the Bun services. Build from the repo root:
#   docker build -f deploy/Dockerfile .
# Build: Go toolchain only. Module fetches never run code, and go.sum pins every dependency.
FROM golang:1.27.3-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /wire ./cmd/wire

# Run: a static binary on distroless, no shell, non-root.
FROM gcr.io/distroless/static-debian13:nonroot@sha256:d62067879de890a1def9da0e7766b7d20810a5e5555cef8506b752437d7a3e88
COPY --from=build /wire /wire
USER nonroot:nonroot
EXPOSE 3000
ENTRYPOINT ["/wire"]
CMD ["serve"]
