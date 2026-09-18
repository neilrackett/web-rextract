// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
// Reading a disk is a second or two of solid arithmetic - decoding an
// IPF's 160 tracks, mostly - so it happens here rather than on the
// thread that is drawing the page.

/// <reference lib="webworker" />

import { examine, type DiskResult } from './core/pipeline';

declare const self: DedicatedWorkerGlobalScope;

export interface ExamineRequest {
	id: number;
	fileName: string;
	data: ArrayBuffer;
}

export type ExamineResponse =
	| { id: number; ok: true; result: DiskResult }
	| { id: number; ok: false; error: string };

self.onmessage = async (event: MessageEvent<ExamineRequest>) => {
	const { id, fileName, data } = event.data;
	try {
		const result = await examine(fileName, new Uint8Array(data));
		const response: ExamineResponse = { id, ok: true, result };
		// The file bytes are handed over rather than copied: there are a
		// few megabytes of them and this side is finished with them.
		self.postMessage(response, {
			transfer: result.files.map((f) => f.bytes.buffer as ArrayBuffer),
		});
	} catch (e) {
		const response: ExamineResponse = { id, ok: false, error: (e as Error).message };
		self.postMessage(response);
	}
};
