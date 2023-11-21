/* eslint-disable @typescript-eslint/no-var-requires */
const { describe, before, it } = require('mocha');
const chai = require('chai');

chai.use(require('chai-events'));
chai.use(require('chai-stream'));

const es = require('event-stream');
const JSONStream = require('JSONStream');
const stream = require('stream');
const Dockerode = require('dockerode');

const docker = new Dockerode();

const dockerDelta = require('..');

const { expect } = chai;

function buildImg(name, dockerfile) {
	return docker
		.buildImage(
			{
				context: './test',
				src: [dockerfile],
			},
			{
				t: name,
				dockerfile: dockerfile,
			},
		)
		.then(function (res) {
			return new Promise(function (resolve, reject) {
				res
					.pipe(JSONStream.parse())
					.pipe(
						es.through(function (data) {
							if (data.error) {
								return reject(data.error);
							} else {
								return console.log(data);
							}
						}),
					)
					.on('end', resolve)
					.on('error', reject);
			});
		});
}

describe('docker-delta', function () {
	this.timeout(120000);

	before(function () {
		return buildImg('source-image', 'Dockerfile.src').then(function () {
			return buildImg('dest-image', 'Dockerfile.dst');
		});
	});

	it('creates a delta between two images and applies it', function () {
		const deltaStream = dockerDelta.createDelta(
			docker,
			'source-image',
			'dest-image',
			true,
			{ log: console.log },
		);
		expect(deltaStream).to.be.a.Stream;
		const str = deltaStream
			.pipe(
				dockerDelta.applyDelta(docker, 'source-image', { log: console.log }),
			)
			.on(
				'id',
				(function (_this) {
					return function (id) {
						return (_this.imageId = id);
					};
				})(this),
			);
		return expect(str).to.emit('id');
	});

	it('produces a valid docker image', function () {
		expect(this.imageId).to.be.a.string;
		const pt = new stream.PassThrough();
		pt.setEncoding('utf8');
		return docker.run(this.imageId, [], pt).then(function ([data, _container]) {
			expect(data.StatusCode).to.equal(0);
			return expect(pt.read()).to.equal('HeXXo from the image\r\n');
		});
	});
});
