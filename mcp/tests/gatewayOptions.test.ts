import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGatewayOptions } from '../src/http.js';

test('gateway options retain compatibility with legacy HTTP environment names', () => {
	const options = loadGatewayOptions({
		OBSIDIAN_HTTP_API_KEY: 'test-legacy-api-key-1234567890',
		OBSIDIAN_HTTP_HOST: '127.0.0.2',
		OBSIDIAN_HTTP_PORT: '28123',
		OBSIDIAN_HTTP_ALLOWED_ORIGINS: 'https://example.test, https://second.example.test',
		OBSIDIAN_HTTP_MAX_BODY_BYTES: '2048',
		OBSIDIAN_HTTP_RATE_LIMIT: '321',
	});

	assert.equal(options.apiKey, 'test-legacy-api-key-1234567890');
	assert.equal(options.host, '127.0.0.2');
	assert.equal(options.port, 28_123);
	assert.deepEqual([...options.allowedOrigins], [
		'https://example.test',
		'https://second.example.test',
	]);
	assert.equal(options.maxBodyBytes, 2_048);
	assert.equal(options.rateLimitPerMinute, 321);
});

test('canonical gateway environment names take precedence over legacy aliases', () => {
	const options = loadGatewayOptions({
		OBSIDIAN_GATEWAY_API_KEY: 'test-canonical-api-key-1234567890',
		OBSIDIAN_HTTP_API_KEY: 'test-legacy-api-key-1234567890',
		OBSIDIAN_GATEWAY_HOST: '127.0.0.3',
		OBSIDIAN_HTTP_HOST: '127.0.0.4',
		OBSIDIAN_GATEWAY_PORT: '29123',
		OBSIDIAN_HTTP_PORT: '30123',
	});

	assert.equal(options.apiKey, 'test-canonical-api-key-1234567890');
	assert.equal(options.host, '127.0.0.3');
	assert.equal(options.port, 29_123);
});
