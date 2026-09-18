// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: MIT
//
// ADF and ADZ readers.
//
// An ADF is already the thing everything downstream wants - 1760
// sectors in block order - so the reader is really a size check. An ADZ
// is a gzipped ADF and gets unwrapped first.

import { gunzipSync } from 'fflate';
import { BLOCK_COUNT, emptyImage, IMAGE_SIZE, ImageError, type DiskImage } from './image';

export function isGzip(data: Uint8Array): boolean {
	return data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

export function readAdf(data: Uint8Array, format: 'adf' | 'adz' = 'adf'): DiskImage {
	if (data.length !== IMAGE_SIZE) {
		// Worth naming the two usual causes: a high-density image, and a
		// download that stopped early. Either way the message should say
		// what was wrong with the file rather than fail in the parser.
		throw new ImageError(
			`this is ${data.length.toLocaleString()} bytes, and an Amiga DD disk image is ` +
				`${IMAGE_SIZE.toLocaleString()}. ` +
				(data.length > IMAGE_SIZE
					? 'A high-density or hard-disk image will not do - Flashback shipped on DD floppies.'
					: 'The file looks truncated, so the copy may be incomplete.'),
		);
	}
	const image = emptyImage(format);
	image.bytes.set(data);
	image.present.fill(1, 0, BLOCK_COUNT);
	return image;
}

export function readAdz(data: Uint8Array): DiskImage {
	let plain: Uint8Array;
	try {
		plain = gunzipSync(data);
	} catch (e) {
		throw new ImageError(`this does not unzip: ${(e as Error).message}`);
	}
	return readAdf(plain, 'adz');
}
