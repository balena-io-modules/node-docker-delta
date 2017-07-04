#!/bin/sh
set -o errexit

function cleanup() {
	docker stop deltatest &> /dev/null || true
	docker rm --volumes deltatest &> /dev/null || true
}
trap cleanup EXIT

docker build -f Dockerfile.test -t localhost/docker-delta-test .
cleanup
docker run --privileged --name deltatest -d localhost/docker-delta-test
docker exec deltatest bash -c "npm run lint && ./node_modules/.bin/mocha --compilers coffee:coffee-script/register"
