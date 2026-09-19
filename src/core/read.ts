// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pick a reader for whatever the user dropped.
//
// The IPF decoder is imported on demand rather than outright. It is the
// largest piece of code here by some way, and this keeps it out of the
// page's own bundle: it is pulled in inside the worker, and only when
// an IPF actually turns up.

import { isGzip, readAdf, readAdz } from './adf';
import { ImageError, type DiskImage } from './image';

export function looksLikeIpf(data: Uint8Array): boolean {
	// The CAPS signature, checked here as well as in the decoder so the
	// dispatcher can route without loading it.
	const sig = [0x43, 0x41, 0x50, 0x53];
	return data.length > 12 && sig.every((b, i) => data[i] === b);
}

export async function readImage(name: string, data: Uint8Array): Promise<DiskImage> {
	if (looksLikeIpf(data)) {
		const { decodeIpf } = await import('./ipf');
		const { imageFromIpf } = await import('./ipfimage');
		return imageFromIpf(decodeIpf(data));
	}
	if (isGzip(data)) {
		return readAdz(data);
	}
	if (/\.(adz|gz)$/i.test(name)) {
		throw new ImageError('the name says ADZ but the file is not gzipped.');
	}
	if (/\.dms$/i.test(name)) {
		throw new ImageError(
			'DMS archives are not supported. Unpack it to an ADF first, with xDMS or an Amiga emulator.',
		);
	}
	return readAdf(data);
}
