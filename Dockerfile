FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /server .
COPY migrations ./migrations
COPY web ./web
EXPOSE 4000
CMD ["./server"]
