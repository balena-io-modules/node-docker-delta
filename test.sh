#!/bin/sh
set -o errexit

function cleanup() {
	docker stop deltatest &> /dev/null || true
	docker rm --volumes deltatest &> /dev/null || true
}
trap cleanup EXIT

docker build -f "Dockerfile.test" -t docker-delta-test .
docker run --privileged --name deltatest -d docker-delta-test

# give docker daemon a few moments to finish starting up...
sleep 5

docker exec deltatest /bin/sh -c "npm run lint && ./node_modules/.bin/mocha"

cleanup
