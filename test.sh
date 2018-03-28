#!/bin/sh
set -o errexit

function cleanup() {
	docker stop deltatest &> /dev/null || true
	docker rm --volumes deltatest &> /dev/null || true
}
trap cleanup EXIT

docker build -f Dockerfile.node6.test -t localhost/docker-delta-node6-test .
docker run --privileged --name deltatest -d localhost/docker-delta-node6-test
docker exec deltatest bash -c "npm run lint && ./node_modules/.bin/mocha --compilers coffee:coffee-script/register"

cleanup

docker build -f Dockerfile.node8.test -t localhost/docker-delta-node8-test .
docker run --privileged --name deltatest -d localhost/docker-delta-node8-test
docker exec deltatest bash -c "npm run lint && ./node_modules/.bin/mocha --compilers coffee:coffee-script/register"
