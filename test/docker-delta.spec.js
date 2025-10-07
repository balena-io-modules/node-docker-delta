/* eslint-disable @typescript-eslint/no-require-imports */
const { describe, before, it } = require('mocha');
const chai = require('chai');

chai.use(require('chai-events'));
chai.use(require('chai-stream'));

const JSONStream = require('JSONStream');
const stream = require('node:stream');
const Dockerode = require('dockerode');

const docker = new Dockerode();

const dockerDelta = require('..');

const { expect } = chai;

async function buildImg(name, dockerfile) {
	const res = await docker.buildImage(
		{
			context: './test',
			src: [dockerfile],
		},
		{
			t: name,
			dockerfile: dockerfile,
		},
	);
	await stream.promises.pipeline(
		res,
		JSONStream.parse(),
		new stream.Transform({
			objectMode: true,
			transform(data, _enc, cb) {
				if (data.error) {
					cb(data.error);
				} else {
					console.log(data);
					cb();
				}
			},
		}),
	);
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
			.on('id', (id) => {
				this.imageId = id;
			});
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
