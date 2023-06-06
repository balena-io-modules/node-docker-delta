'use strict';

const m = require('mochainon');

m.chai.use(require('chai-events'));
m.chai.use(require('chai-stream'));

const es = require('event-stream');
const JSONStream = require('JSONStream');
const Bluebird = require('bluebird');
const stream = require('stream');
const Docker = require('dockerode');

const docker = new Docker();

const dockerDelta = require('../lib/docker-delta');

const expect = m.chai.expect;

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
			return new Bluebird(function (resolve, reject) {
				var outputStream;
				return (outputStream = res
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
					.on('error', reject));
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
			'source-image',
			'dest-image',
			true,
		);
		expect(deltaStream).to.be.a.Stream;
		const str = deltaStream.pipe(dockerDelta.applyDelta('source-image')).on(
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
		return docker.run(this.imageId, void 0, pt).then(function (container) {
			expect(container.output.StatusCode).to.equal(0);
			return expect(pt.read()).to.equal('HeXXo from the image\r\n');
		});
	});
});
