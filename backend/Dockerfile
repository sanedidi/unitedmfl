# ---- build ----
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# ---- runtime: poppler (PDF text layer) + tesseract (scanned protocols / photos) ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata poppler-utils tesseract-ocr tesseract-ocr-data-eng \
 && addgroup -S app && adduser -S app -G app \
 && mkdir -p /data/uploads && chown -R app:app /data
ENV TZ=Asia/Tashkent UPLOAD_DIR=/data/uploads ADDR=:8080
COPY --from=build /out/api /usr/local/bin/api
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/api"]
