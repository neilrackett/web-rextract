// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: GPL-3.0-or-later
//
import { describe, expect, it } from 'vitest';
import { readAdf } from '../src/core/adf';
import { readVolume } from '../src/core/amigados';
import { fixture, haveFixture } from './fixtures';

describe.skipIf(!haveFixture('disk1.adf'))('AmigaDOS walk', () => {
	it('reads the four Flashback disks', () => {
		for (let n = 1; n <= 4; n++) {
			const volume = readVolume(readAdf(fixture(`disk${n}.adf`)));
			expect(volume.filesystem).toBe('OFS');
			expect(volume.name).toBe(`flashback disk ${n}`);
			expect(volume.warnings).toEqual([]);
			for (const f of volume.files) {
				expect(f.problems, `${volume.name}:${f.path}`).toEqual([]);
				expect(f.bytes.length).toBe(f.size);
			}
		}
	});
});
