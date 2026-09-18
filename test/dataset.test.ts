// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
import { describe, expect, it } from 'vitest';
import { buildDataSet, dataFileName, isGemdosName, isWanted } from '../src/core/dataset';
import { KNOWN_DISKS, REQUIRED_FILES } from '../src/core/manifest';

describe('what goes in DATA', () => {
	it('takes data/ and cine/ and font8.spr, and nothing else', () => {
		expect(isWanted('data/level1.mbk')).toBe(true);
		expect(isWanted('cine/intro.cmp')).toBe(true);
		expect(isWanted('font8.spr')).toBe(true);
		expect(isWanted('music/jungle')).toBe(false);
		expect(isWanted('s/startup-sequence')).toBe(false);
		expect(isWanted('read.me')).toBe(false);
		expect(isWanted('flashback')).toBe(false);
	});

	it('shortens the one name GEMDOS would have truncated silently', () => {
		expect(dataFileName('data/replicant.spm')).toBe('REPLICAN.SPM');
		expect(dataFileName('data/level2.CT')).toBe('LEVEL2.CT');
	});

	it('leaves every name the manifest records safe for an Atari volume', () => {
		const bad = REQUIRED_FILES.filter((n) => !isGemdosName(n));
		expect(bad).toEqual([]);
	});

	it('has no two names that collide once GEMDOS has had them', () => {
		expect(new Set(REQUIRED_FILES).size).toBe(REQUIRED_FILES.length);
	});
});

describe('building the set from four disks', () => {
	const file = (out: string, byte: number) => ({ out, src: `data/${out.toLowerCase()}`, bytes: new Uint8Array([byte]) });

	it('keeps one copy of a file that is on more than one disk', () => {
		const set = buildDataSet(
			[
				{ label: 1, files: [file('A.CMP', 1)] },
				{ label: 2, files: [file('A.CMP', 1), file('B.CMP', 2)] },
			],
			['A.CMP', 'B.CMP'],
		);
		expect(set.files.map((f) => f.out)).toEqual(['A.CMP', 'B.CMP']);
		expect(set.files[0].fromDisk).toBe(1);
		expect(set.conflicts).toEqual([]);
		expect(set.missing).toEqual([]);
	});

	it('reports two copies that differ rather than letting the last one win', () => {
		const set = buildDataSet(
			[
				{ label: 1, files: [file('A.CMP', 1)] },
				{ label: 2, files: [file('A.CMP', 9)] },
			],
			['A.CMP'],
		);
		expect(set.conflicts).toEqual(['A.CMP']);
	});

	it('names what is missing', () => {
		const set = buildDataSet([{ label: 1, files: [file('A.CMP', 1)] }], ['A.CMP', 'B.CMP']);
		expect(set.missing).toEqual(['B.CMP']);
	});
});

describe('the manifest', () => {
	it('describes four disks and the files the port asks for', () => {
		expect(KNOWN_DISKS.map((d) => d.disk)).toEqual([1, 2, 3, 4]);
		expect(REQUIRED_FILES.length).toBe(107);
		for (const disk of KNOWN_DISKS) {
			expect(disk.files.length, `disk ${disk.disk}`).toBeGreaterThan(10);
			for (const f of disk.files) {
				expect(REQUIRED_FILES).toContain(f.out);
			}
		}
	});
});
