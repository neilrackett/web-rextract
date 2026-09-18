// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
// The MFM decoder, tested against sectors this file encodes itself.
// Nothing here comes off anybody's disk: the payload is a pattern, and
// the encoder below is the inverse of the thing under test written out
// longhand from the same description of the format.

import { describe, expect, it } from 'vitest';
import { decodeTrack } from '../src/core/mfm';

/**
 * Data bits to MFM cells: each data bit is preceded by a clock bit,
 * and the clock is set only when neither the bit before nor the bit
 * itself is a one. Returns encoded bytes, eight cells to the byte.
 */
function toMfm(dataBits: number[], previous = 0): Uint8Array {
	const cells: number[] = [];
	let prev = previous;
	for (const bit of dataBits) {
		cells.push(prev === 0 && bit === 0 ? 1 : 0, bit);
		prev = bit;
	}
	const out = new Uint8Array(cells.length / 8);
	for (let i = 0; i < cells.length; i++) {
		out[i >> 3] |= cells[i] << (7 - (i & 7));
	}
	return out;
}

/** The odd bits of every byte, then the even bits, as a bit list. */
function splitOddEven(data: Uint8Array): number[] {
	const odd: number[] = [];
	const even: number[] = [];
	for (const byte of data) {
		for (let b = 7; b >= 0; b--) {
			(b % 2 === 1 ? odd : even).push((byte >> b) & 1);
		}
	}
	return odd.concat(even);
}

function checksum(raw: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < raw.length; i += 4) {
		sum ^= ((raw[i] << 24) | (raw[i + 1] << 16) | (raw[i + 2] << 8) | raw[i + 3]) >>> 0;
	}
	return (sum & 0x55555555) >>> 0;
}

function u32bytes(v: number): Uint8Array {
	return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function encodeSector(track: number, sector: number, payload: Uint8Array): Uint8Array {
	const info = new Uint8Array([0xff, track, sector, 11 - sector]);
	const label = new Uint8Array(16);
	const infoLabel = toMfm(splitOddEven(info).concat(splitOddEven(label)));
	const data = toMfm(splitOddEven(payload));
	const headerSum = toMfm(splitOddEven(u32bytes(checksum(infoLabel))));
	const dataSum = toMfm(splitOddEven(u32bytes(checksum(data))));

	const sync = new Uint8Array([0x44, 0x89, 0x44, 0x89]);
	const out = new Uint8Array(sync.length + infoLabel.length + headerSum.length + dataSum.length + data.length);
	let at = 0;
	for (const part of [sync, infoLabel, headerSum, dataSum, data]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** Lay encoded sectors out in a track, with a gap either side. */
function buildTrack(sectors: Uint8Array[], leadIn: number): { bits: Uint8Array; bitCount: number } {
	const gap = new Uint8Array(20).fill(0xaa);
	const parts: Uint8Array[] = [new Uint8Array(leadIn).fill(0xaa)];
	for (const sector of sectors) {
		parts.push(sector, gap);
	}
	const total = parts.reduce((n, p) => n + p.length, 0);
	const bits = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		bits.set(part, at);
		at += part.length;
	}
	return { bits, bitCount: total * 8 };
}

function payload(seed: number): Uint8Array {
	const data = new Uint8Array(512);
	for (let i = 0; i < data.length; i++) {
		data[i] = (i * 7 + seed * 31) & 0xff;
	}
	return data;
}

describe('Amiga MFM', () => {
	it('decodes a whole track of sectors, out of order', () => {
		// Sector 0 is not written first on a real disk, so it is not
		// written first here either.
		const order = [4, 5, 6, 7, 8, 9, 10, 0, 1, 2, 3];
		const track = buildTrack(
			order.map((s) => encodeSector(2, s, payload(s))),
			50,
		);
		const got = decodeTrack(track.bits, track.bitCount);
		expect(got.length).toBe(11);
		for (const sector of got) {
			expect(sector.headerOk, `sector ${sector.sector} header`).toBe(true);
			expect(sector.dataOk, `sector ${sector.sector} data`).toBe(true);
			expect(sector.track).toBe(2);
			expect([...sector.data]).toEqual([...payload(sector.sector)]);
		}
		expect(got.map((s) => s.sector).sort((a, b) => a - b)).toEqual([...Array(11).keys()]);
	});

	it('reads a sector that runs off the end of the track and back to the start', () => {
		// A revolution has no beginning, so the buffer's end is not one
		// either - a sector that straddles it must still come out.
		const one = encodeSector(7, 3, payload(3));
		const track = buildTrack([one], 50);
		const shift = one.length - 40;
		const rotated = new Uint8Array(track.bits.length);
		for (let i = 0; i < rotated.length; i++) {
			rotated[i] = track.bits[(i + shift) % track.bits.length];
		}
		const got = decodeTrack(rotated, track.bitCount);
		expect(got.length).toBe(1);
		expect(got[0].dataOk).toBe(true);
		expect([...got[0].data]).toEqual([...payload(3)]);
	});

	it('marks a sector with a flipped byte as bad rather than returning it quietly', () => {
		const one = encodeSector(0, 0, payload(1));
		one[600] ^= 0x44;
		const track = buildTrack([one], 50);
		const got = decodeTrack(track.bits, track.bitCount);
		expect(got.length).toBe(1);
		expect(got[0].dataOk).toBe(false);
	});
});
