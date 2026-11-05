module github.com/sanedidi/unitedmfl/backend

go 1.24.7

replace golang.org/x/crypto => github.com/golang/crypto v0.31.0

replace golang.org/x/text => github.com/golang/text v0.21.0

replace golang.org/x/sys => github.com/golang/sys v0.28.0

replace golang.org/x/net => github.com/golang/net v0.33.0

replace golang.org/x/term => github.com/golang/term v0.27.0

require (
	github.com/go-chi/chi/v5 v5.1.0
	github.com/golang-jwt/jwt/v5 v5.2.1
	github.com/lib/pq v1.10.9
	golang.org/x/crypto v0.31.0
)
