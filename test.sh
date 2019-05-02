#!/bin/sh
set -o errexit

function cleanup() {
	docker stop deltatest &> /dev/null || true
	docker rm --volumes deltatest &> /dev/null || true
}
trap cleanup EXIT

docker build -f "Dockerfile.node${NODE_VERSION}.test" -t docker-delta-test .
docker run --privileged --name deltatest -d docker-delta-test
docker exec deltatest bash -c "npm run lint && ./node_modules/.bin/mocha --compilers coffee:coffee-script/register"

cleanup
