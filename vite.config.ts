// RExtract - Flashback data extractor for the Atari ST
// Copyright (c) 2026 Neil Rackett
// SPDX-License-Identifier: BSD-2-Clause
//
import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo>/, so the built asset
// URLs need that prefix. A user site or a custom domain serves from the
// root instead, which is what BASE is for:
//
//   BASE=/ npm run build
export default defineConfig({
	base: process.env.BASE ?? '/web-rextract/',
	build: {
		target: 'es2022',
	},
});
