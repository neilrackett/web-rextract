// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
// The chip music: which files on the disks are the score, what each
// track is called on an Atari volume, and the run from a ProTracker
// module to a YM register stream.
//
// The Amiga score is sampled music, which a plain ST cannot play - no
// DMA sound, and this port has no software mixer. Every ST does have
// the YM2149, so each module is converted here into the register
// stream STDL's player reads. The two legs of that are mod2midi.ts and
// midi2stm.ts; this file is what decides which modules to run through
// them and what to call the results.

import { modToMidi, isModule, moduleTitle } from './mod2midi';
import { midiToStm } from './midi2stm';
import type { AmigaVolume } from './amigados';

export interface MusicTrack {
	/** The name on an Atari volume, e.g. TELEPOR2.STM. */
	out: string;
	/** The module's own title, minus the prefix every one of them carries. */
	title: string;
	/** Where it came from on the Amiga disk. */
	src: string;
	/** The module itself. Converted at the end, not when it is found. */
	bytes: Uint8Array;
}

export function isMusicPath(path: string): boolean {
	return path.startsWith('music/');
}

/**
 * The name comes from the module's own title rather than its filename,
 * and this is not a detail to tidy away. A module's FILENAME is the
 * engine's primary track name, but the port looks up the ALTERNATE
 * one - and the alternate is exactly what the module carries in its
 * 20-byte title. The port's own tools/extract-data.sh reads the title
 * for the same reason, so the two agree without a mapping table in
 * either of them.
 */
export function trackTitle(module: Uint8Array): string {
	let title = '';
	for (let i = 0; i < 20; i++) {
		const c = String.fromCharCode(module[i]);
		// Everything outside this set goes, which takes the NUL padding
		// with it. The port's shell tools do the same with `tr -cd`.
		if (/[A-Za-z0-9_-]/.test(c)) {
			title += c;
		}
	}
	return title.startsWith('flashback-') ? title.slice('flashback-'.length) : title;
}

/**
 * GEMDOS is eight characters and three. Where a title is too long the
 * LAST character is kept rather than truncating, because teleporta and
 * teleport2 differ only there and would otherwise both become
 * TELEPORT. The game works its own names out the same way, in
 * ATARIST_musicName - the two have to agree or a cue plays the wrong
 * track.
 */
export function trackName(title: string): string {
	const up = title.toUpperCase().replace(/_/g, '');
	return (up.length > 8 ? up.slice(0, 7) + up.slice(-1) : up) + '.STM';
}

export function selectModules(volume: AmigaVolume): MusicTrack[] {
	const tracks: MusicTrack[] = [];
	for (const file of volume.files) {
		if (!isMusicPath(file.path) || !isModule(file.bytes)) {
			continue;
		}
		const title = trackTitle(file.bytes);
		if (title === '') {
			continue;
		}
		tracks.push({ out: trackName(title), title, src: file.path, bytes: file.bytes });
	}
	return tracks;
}

/** One module, all the way to the stream the ST plays. */
export function convertTrack(module: Uint8Array): Uint8Array {
	return midiToStm(modToMidi(module));
}

export { isModule, moduleTitle };
