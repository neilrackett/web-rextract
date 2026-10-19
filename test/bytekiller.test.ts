// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { BytekillerError, unpackBytekiller } from '../src/core/bytekiller';
import { noise, pack, type Token } from './bkpack';

describe('bytekiller', () => {
	it('round-trips every kind of token', () => {
		const used = new Set<Token>();
		const inputs = [
			noise(3000, 1),
			new TextEncoder().encode('Conrad B. Hart, agent of the Galaxia Bureau of Investigation. '.repeat(40)),
			new Uint8Array(1500).fill(0x55),
			// near repeats, far repeats and runs, all in one file
			Uint8Array.from({ length: 6000 }, (_, i) => (i % 700 < 300 ? (i * 7) & 0xff : (i % 3 === 0 ? i & 0x1f : 0))),
			Uint8Array.from({ length: 4000 }, (_, i) => noise(4000, 2)[i % 1100 < 600 ? i : i - 900]),
		];
		for (const input of inputs) {
			expect(unpackBytekiller(pack(input, used))).toEqual(input);
		}
		expect([...used].sort()).toEqual(['lit3', 'lit8', 'm12', 'm2', 'm3', 'm4']);
	});

	it('round-trips at every alignment of the first long', () => {
		// The first long carries whatever does not fill a whole one, from
		// nothing to 31 bits, so walk the length through all of them.
		for (let n = 0; n < 40; n++) {
			const input = noise(n, n + 7);
			expect(unpackBytekiller(pack(input)), `${n} bytes`).toEqual(input);
		}
	});

	it('refuses a stream whose checksum does not match', () => {
		const stream = pack(noise(500, 3));
		stream[stream.length - 9] ^= 0x10; // a data long
		expect(() => unpackBytekiller(stream)).toThrow(BytekillerError);
	});

	it('refuses a stream that has lost its start', () => {
		const stream = pack(noise(500, 4));
		expect(() => unpackBytekiller(stream.subarray(64))).toThrow(BytekillerError);
	});

	it('refuses a size nothing on the disks comes near', () => {
		const stream = pack(noise(16, 5));
		new DataView(stream.buffer).setUint32(stream.length - 4, 0x7fffffff);
		expect(() => unpackBytekiller(stream)).toThrow(BytekillerError);
	});
});
