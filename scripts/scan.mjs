// The static analysis n8n runs before verifying a community node (@n8n/scan-community-package):
// the same ESLint rules on this source tree and on the npm tarball. n8n also checks the npm
// provenance, which exists only once the release workflow has published.
//
//   npm install --prefix /tmp/scan @n8n/scan-community-package
//   npm pack && mkdir -p /tmp/pkg && tar -xzf n8n-nodes-honk-*.tgz -C /tmp/pkg --strip-components=1
//   node scripts/scan.mjs /tmp/scan /tmp/pkg
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [scannerPrefix, tarballDir] = process.argv.slice(2);
if (!scannerPrefix || !tarballDir) {
	console.error('usage: node scripts/scan.mjs <scanner install prefix> <unpacked tarball dir>');
	process.exit(2);
}
const scanner = resolve(scannerPrefix, 'node_modules/@n8n/scan-community-package/scanner/scanner.mjs');
const { analyzePackage, SOURCE_FILE_PATTERNS } = await import(pathToFileURL(scanner).href);

let failed = false;
for (const [label, dir, patterns] of [
	['source', resolve('.'), SOURCE_FILE_PATTERNS],
	['tarball', resolve(tarballDir), ['**/*.js', 'package.json']],
]) {
	const result = await analyzePackage(dir, patterns);
	console.log(`${label}: ${result.passed ? 'passed' : 'FAILED'}${result.message ? ` (${result.message})` : ''}`);
	if (!result.passed) {
		failed = true;
		if (result.details) console.log(result.details);
	}
}
process.exit(failed ? 1 : 0);
