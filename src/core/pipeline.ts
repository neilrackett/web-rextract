// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
// One disk image in, one report out. This is the whole of what the
// worker does, and it is kept free of DOM and worker plumbing so it can
// be run straight from a test.

import { readVolume, type Filesystem } from './amigados';
import { identifyDisk, selectFiles, type Identification, type SelectedFile } from './dataset';
import { selectModules, type MusicTrack } from './music';
import type { ImageFormat } from './image';
import { readImage } from './read';

export interface DiskResult {
	fileName: string;
	format: ImageFormat;
	volumeName: string;
	filesystem: Filesystem;
	identification: Identification;
	files: SelectedFile[];
	/** The score, still as ProTracker modules - converting is cheap and
	 *  happens once at the end rather than four times over here. */
	music: MusicTrack[];
	/** Anything odd about the image or the filesystem, in plain words. */
	warnings: string[];
}

export async function examine(fileName: string, data: Uint8Array): Promise<DiskResult> {
	const image = await readImage(fileName, data);
	const volume = readVolume(image);
	const warnings = [...image.warnings, ...volume.warnings];
	for (const file of volume.files) {
		for (const problem of file.problems) {
			warnings.push(`${file.name}: ${problem}`);
		}
	}
	return {
		fileName,
		format: image.format,
		volumeName: volume.name,
		filesystem: volume.filesystem,
		identification: identifyDisk(volume),
		files: selectFiles(volume),
		music: selectModules(volume),
		warnings,
	};
}
