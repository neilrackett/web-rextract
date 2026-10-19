// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bytekiller, the packer most of the Amiga data went through.
//
// A transcription of the port's own decoder (src/unpack.cpp, and
// tools/make-unpacked.py beside it), which it has to match byte for
// byte: the ST reads what this writes in place of unpacking the file
// itself.
//
// A stream is read from its end. The last long is the unpacked size,
// the one before it a checksum, and below those the data a long at a
// time, downwards. Bits come off the bottom of each long, and a field
// is built most significant bit first; the first long carries a marker
// bit above its data so that the end of it can be found. The output is
// written backwards too, from its end.

export class BytekillerError extends Error {}

/** Far beyond anything on the disks: a size past this is a corrupt trailer. */
const MAX_SIZE = 1 << 24;

export function unpackBytekiller(src: Uint8Array): Uint8Array {
	if (src.length < 12) {
		throw new BytekillerError('too short to be a packed stream');
	}
	const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
	let pos = src.length - 4;
	const size = view.getUint32(pos);
	pos -= 4;
	if (size > MAX_SIZE) {
		throw new BytekillerError(`unpacked size ${size} is not believable`);
	}
	let crc = view.getUint32(pos);
	pos -= 4;
	let bits = view.getUint32(pos);
	pos -= 4;
	crc = (crc ^ bits) >>> 0;

	const nextBit = (): number => {
		let bit = bits & 1;
		bits >>>= 1;
		if (bits === 0) {
			// the marker went with that bit: the next long, and a
			// marker of its own above the 31 bits left in it
			if (pos < 0) {
				throw new BytekillerError('ran off the start of the stream');
			}
			bits = view.getUint32(pos);
			pos -= 4;
			crc = (crc ^ bits) >>> 0;
			bit = bits & 1;
			bits = ((bits >>> 1) | 0x80000000) >>> 0;
		}
		return bit;
	};
	const field = (n: number): number => {
		let v = 0;
		for (let i = 0; i < n; i++) {
			v = (v << 1) | nextBit();
		}
		return v;
	};

	const out = new Uint8Array(size);
	let o = size;
	let left = size;
	while (left > 0) {
		let len: number;
		let offset = 0;
		const code = field(2);
		if (code === 0) {
			len = field(3) + 1;
		} else if (code === 1) {
			len = 2;
			offset = field(8);
		} else {
			const sub = ((code & 1) << 1) | field(1);
			if (sub === 3) {
				len = field(8) + 9;
			} else if (sub === 2) {
				len = field(8) + 1;
				offset = (field(8) << 4) | field(4);
			} else {
				len = sub + 3;
				offset = (field(8) << (sub + 1)) | field(sub + 1);
			}
		}
		len = Math.min(len, left);
		left -= len;
		// A zero offset reads the bytes from the stream, as the C does
		// for any code: the packer never writes one, but the two have
		// to agree on what a stream means.
		if (offset !== 0) {
			if (o + offset > size) {
				throw new BytekillerError('a reference past the end of the output');
			}
			for (let i = 0; i < len; i++) {
				o--;
				out[o] = out[o + offset];
			}
		} else {
			for (let i = 0; i < len; i++) {
				out[--o] = field(8);
			}
		}
	}
	if (crc !== 0) {
		throw new BytekillerError('the checksum does not match');
	}
	return out;
}
