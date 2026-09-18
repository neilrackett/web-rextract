// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: MIT
//
// Turn a decoded IPF - one cell stream per track - into the flat block
// image everything downstream reads.

import {
	CYLINDERS,
	HEADS,
	SECTORS_PER_TRACK,
	SECTOR_SIZE,
	ImageError,
	blockNumber,
	emptyImage,
	type DiskImage,
} from './image';
import { decodeTrack } from './mfm';
import type { IpfImage } from './ipf';

export function imageFromIpf(ipf: IpfImage): DiskImage {
	const image = emptyImage('ipf');
	image.warnings.push(...ipf.warnings);

	let read = 0;
	let unreadable = 0;
	for (const track of ipf.tracks) {
		if (track.cylinder >= CYLINDERS || track.head >= HEADS) {
			// Cylinder 80 and beyond exists on some dumps. Nothing in the
			// filesystem lives there, so it is not worth a warning.
			continue;
		}
		let got = 0;
		for (const sector of decodeTrack(track.bits, track.bitCount)) {
			if (!sector.headerOk || !sector.dataOk || sector.sector >= SECTORS_PER_TRACK) {
				continue;
			}
			// The sector's own track byte is not trusted for placement:
			// copy-protection tracks deliberately lie about it. Where the
			// IMGE record says the track is, is where it goes.
			const n = blockNumber(track.cylinder, track.head, sector.sector);
			if (image.present[n]) {
				continue;
			}
			image.bytes.set(sector.data, n * SECTOR_SIZE);
			image.present[n] = 1;
			got++;
			read++;
		}
		unreadable += SECTORS_PER_TRACK - got;
	}

	if (read === 0) {
		// Amiga sectors are not the only thing an IPF can hold: the
		// format covers Atari ST and PC disks too, and those are written
		// in a different MFM dialect that this decoder does not look for.
		// Saying so beats reporting a missing root block.
		throw new ImageError(
			'none of the tracks in this image are Amiga sectors. An Atari ST or PC disk image ' +
				'cannot be read here - the files this tool is after are on the Amiga release.',
		);
	}

	if (unreadable > 0) {
		// Protection tracks never decode as AmigaDOS sectors and never
		// hold game files, so this is reported but not treated as a
		// failure. What matters is whether the filesystem asks for one of
		// the missing blocks, and that shows up when it does.
		image.warnings.push(
			`${unreadable} of ${CYLINDERS * HEADS * SECTORS_PER_TRACK} sectors did not decode ` +
				'(copy-protection tracks normally do not)',
		);
	}
	return image;
}
