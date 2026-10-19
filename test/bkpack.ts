// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Test helpers: bytekiller streams made from chosen bytes, for the
// tests of the decoder and of UNPACKED.

export type Token = 'lit3' | 'lit8' | 'm2' | 'm3' | 'm4' | 'm12';

/**
 * A packer, for these tests only: greedy, slow and never shipped. It
 * writes every kind of token the format has, so the decoder can be
 * checked on bytes the test chooses rather than on game data, which
 * this repository does not hold. The end-to-end test compares real
 * files against the port's own tool as well, so a misreading of the
 * format shared by this and the decoder would still be caught there.
 */
export function pack(data: Uint8Array, used: Set<Token> = new Set()): Uint8Array {
	const bits: number[] = [];
	const put = (v: number, n: number) => {
		for (let i = n - 1; i >= 0; i--) {
			bits.push((v >> i) & 1);
		}
	};
	// Output is produced from its end, so the tokens are chosen from the
	// end too: p is how many bytes are still to come, data[0..p).
	let pending: number[] = [];
	const flush = () => {
		for (let i = 0; i < pending.length; ) {
			const n = Math.min(pending.length - i, 264);
			if (n >= 9) {
				put(3, 2);
				put(1, 1);
				put(n - 9, 8);
				used.add('lit8');
			} else {
				put(0, 2);
				put(n - 1, 3);
				used.add('lit3');
			}
			for (let j = 0; j < n; j++) {
				put(pending[i + j], 8);
			}
			i += n;
		}
		pending = [];
	};
	let p = data.length;
	while (p > 0) {
		let bestLen = 0;
		let bestOff = 0;
		for (let off = 1; off <= Math.min(4095, data.length - p); off++) {
			let len = 0;
			while (len < 256 && p - 1 - len >= 0 && data[p - 1 - len] === data[p - 1 - len + off]) {
				len++;
			}
			if (len > bestLen) {
				bestLen = len;
				bestOff = off;
			}
		}
		let token: Token | null = null;
		if (bestLen >= 5) {
			token = 'm12';
		} else if (bestLen === 4) {
			token = bestOff <= 1023 ? 'm4' : 'm12';
		} else if (bestLen === 3) {
			token = bestOff <= 511 ? 'm3' : 'm12';
		} else if (bestLen === 2 && bestOff <= 255) {
			token = 'm2';
		}
		if (token === null) {
			pending.push(data[--p]);
			continue;
		}
		flush();
		used.add(token);
		switch (token) {
			case 'm2':
				put(1, 2);
				put(bestOff, 8);
				break;
			case 'm3':
				put(2, 2);
				put(0, 1);
				put(bestOff >> 1, 8);
				put(bestOff & 1, 1);
				break;
			case 'm4':
				put(2, 2);
				put(1, 1);
				put(bestOff >> 2, 8);
				put(bestOff & 3, 2);
				break;
			case 'm12':
				put(3, 2);
				put(0, 1);
				put(bestLen - 1, 8);
				put(bestOff >> 4, 8);
				put(bestOff & 15, 4);
				break;
		}
		p -= bestLen;
	}
	flush();

	// The first long holds what does not fill a whole one, under a
	// marker bit; the rest are full. They sit below the checksum and the
	// size in reverse of the order they are read in.
	const k = bits.length % 32;
	const longs: number[] = [];
	let first = 2 ** k;
	for (let i = 0; i < k; i++) {
		first += bits[i] * 2 ** i;
	}
	longs.push(first >>> 0);
	for (let at = k; at < bits.length; at += 32) {
		let v = 0;
		for (let i = 0; i < 32; i++) {
			v += bits[at + i] * 2 ** i;
		}
		longs.push(v >>> 0);
	}
	const out = new Uint8Array(4 * (longs.length + 2));
	const view = new DataView(out.buffer);
	let crc = 0;
	longs.forEach((v, i) => {
		view.setUint32(4 * (longs.length - 1 - i), v);
		crc = (crc ^ v) >>> 0;
	});
	view.setUint32(4 * longs.length, crc);
	view.setUint32(4 * longs.length + 4, data.length);
	return out;
}

/** Deterministic noise, so a failure reproduces. */
export function noise(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n);
	let s = seed;
	for (let i = 0; i < n; i++) {
		s = (s * 1103515245 + 12345) >>> 0;
		out[i] = s >>> 24;
	}
	return out;
}
