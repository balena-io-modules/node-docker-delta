m = require 'mochainon'
m.chai.use(require('chai-events'))
m.chai.use(require('chai-stream'))

es = require 'event-stream'
JSONStream = require 'JSONStream'

Promise = require 'bluebird'
stream = require 'stream'
Docker = require 'dockerode'
docker = new Docker()

dockerDelta = require '../lib/docker-delta'

{ expect } = m.chai

buildImg = (name, dockerfile) ->
	docker.buildImage({ 
		context: './test',
		src: [ dockerfile ]
	}, { t: name, dockerfile })
	.then (res) ->
		new Promise (resolve, reject) ->
			outputStream = res
			.pipe(JSONStream.parse())
			.pipe es.through (data) ->
				if data.error
					reject(data.error)
				else
					console.log(data)
			.on('end', resolve)
			.on('error', reject)

describe 'docker-delta', ->
	@timeout(120000)
	before ->
		buildImg('source-image', 'Dockerfile.src')
		.then ->
			buildImg('dest-image', 'Dockerfile.dst')
		
	it 'creates a delta between two images and applies it', ->
		deltaStream = dockerDelta.createDelta('source-image', 'dest-image', true)
		expect(deltaStream).to.be.a.Stream
		str = deltaStream.pipe(dockerDelta.applyDelta('source-image'))
		.on 'id', (id) =>
			@imageId = id
		expect(str).to.emit('id')

	it 'produces a valid docker image', ->
		expect(@imageId).to.be.a.string
		pt = new stream.PassThrough()
		pt.setEncoding('utf8')
		docker.run(@imageId, undefined, pt).then (container) ->
			expect(container.output.StatusCode).to.equal(0)
			expect(pt.read()).to.equal("HeXXo from the image\r\n")
