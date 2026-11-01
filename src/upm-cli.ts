import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import { HttpClient } from '@actions/http-client';
import { exec } from '@actions/exec';
import * as semver from 'semver';

const TOOL_NAME = 'upm-cli';

/**
 * Base url of Unity's UPM CLI CDN. `UPM_CDN_BASE_URL` overrides the host, same as Unity's install scripts.
 */
function getCdnBaseUrl(): string {
    const override = process.env.UPM_CDN_BASE_URL?.trim();

    if (override && override.length > 0) {
        return `${override.replace(/\/$/, '')}/upm-cli`;
    }

    return 'https://cdn.packages.unity.com/upm-cli';
}

/**
 * Platform id used in the CDN zip names (upm-<platform>.zip).
 */
function getPlatformId(): string {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

    switch (process.platform) {
        case 'win32':
            return `windows-${arch}`;
        case 'darwin':
            return `macos-${arch}`;
        case 'linux':
            return `linux-${arch}`;
        default:
            throw new Error(`Unsupported platform for the UPM CLI: ${process.platform} ${process.arch}`);
    }
}

/**
 * Normalizes a release tag (v9.27.0) or version (9.27.0) to a v-prefixed release tag.
 */
function toReleaseTag(version: string): string {
    const clean = semver.valid(version.trim());

    if (!clean) {
        throw new Error(`Invalid UPM CLI version: "${version}". Expected a semver version like v9.27.0 or latest.`);
    }

    return `v${clean}`;
}

async function getText(url: string): Promise<string> {
    const client = new HttpClient('upm-release');
    const response = await client.get(url);
    const body = await response.readBody();

    if (response.message.statusCode !== 200) {
        throw new Error(`GET ${url} failed with status ${response.message.statusCode}`);
    }

    return body;
}

async function resolveReleaseTag(version: string): Promise<string> {
    if (version.length === 0 || version.toLowerCase() === 'latest') {
        const latest = (await getText(`${getCdnBaseUrl()}/latest.txt`)).trim();
        core.info(`Latest UPM CLI release: ${latest}`);
        return toReleaseTag(latest);
    }

    return toReleaseTag(version);
}

async function sha256(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        fs.createReadStream(filePath)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve())
            .on('error', reject);
    });
    return hash.digest('hex');
}

/**
 * Finds the UnityPackageManager binary inside an install folder.
 */
function findExecutable(installDir: string): string {
    const name = process.platform === 'win32' ? 'UnityPackageManager.exe' : 'UnityPackageManager';
    const candidates = [path.join(installDir, name)];

    for (const entry of fs.readdirSync(installDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            candidates.push(path.join(installDir, entry.name, name));
        }
    }

    const executable = candidates.find(candidate => fs.existsSync(candidate));

    if (!executable) {
        throw new Error(`Could not find ${name} under ${installDir}`);
    }

    return executable;
}

/**
 * Runs `--version` and returns the semver the binary reports.
 */
export async function getVersion(executable: string): Promise<string> {
    let output = '';
    // quoted, exec parses the tool path as a command line
    await exec(`"${executable}"`, ['--version'], {
        silent: true,
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        }
    });
    const lines = output.trim().split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).reverse();

    for (const line of lines) {
        const version = semver.valid(line) || semver.coerce(line)?.version;

        if (version) {
            return version;
        }
    }

    throw new Error(`Failed to parse the UPM CLI version from: ${JSON.stringify(output.trim())}`);
}

async function download(releaseTag: string): Promise<string> {
    const platform = getPlatformId();
    const zipName = `upm-${platform}.zip`;
    const releaseUrl = `${getCdnBaseUrl()}/releases/${releaseTag}`;
    core.info(`Downloading UPM CLI ${releaseTag} (${platform})...`);
    // keep the .zip extension, Windows PowerShell's Expand-Archive fallback rejects extensionless files
    const zipDest = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `${crypto.randomUUID()}.zip`);
    const zipPath = await tc.downloadTool(`${releaseUrl}/${zipName}`, zipDest);

    try {
        const expected = (await getText(`${releaseUrl}/${zipName}.sha256`)).trim().split(/\s+/)[0]?.toLowerCase();

        if (!expected) {
            throw new Error(`Could not read the SHA-256 for ${zipName}`);
        }

        const actual = await sha256(zipPath);

        if (actual !== expected) {
            throw new Error(`SHA-256 mismatch for ${zipName}. Expected ${expected}, got ${actual}`);
        }

        const extracted = await tc.extractZip(zipPath);
        const executable = findExecutable(extracted);

        if (process.platform !== 'win32') {
            await fs.promises.chmod(executable, 0o755);
        }

        return await tc.cacheDir(path.dirname(executable), TOOL_NAME, releaseTag.substring(1), process.arch);
    } finally {
        await fs.promises.rm(zipPath, { force: true });
    }
}

/**
 * Resolves the UPM CLI to run: `UPM_CLI_PATH` when set, otherwise the requested version from the tool cache, downloading it on a miss.
 * @param version Release tag (v9.27.0), version (9.27.0) or `latest`.
 * @returns Absolute path to the UnityPackageManager executable.
 */
export async function setupUpmCli(version: string): Promise<string> {
    const override = process.env.UPM_CLI_PATH?.trim();

    if (override && override.length > 0) {
        await fs.promises.access(override, fs.constants.R_OK | fs.constants.X_OK);
        core.info(`Using UPM CLI from UPM_CLI_PATH (${override}) ${await getVersion(override)}`);
        return override;
    }

    const releaseTag = await resolveReleaseTag(version);
    const toolVersion = releaseTag.substring(1);
    let toolDir = tc.find(TOOL_NAME, toolVersion, process.arch);

    if (toolDir) {
        core.info(`Found UPM CLI ${releaseTag} in the tool cache.`);
    } else {
        toolDir = await download(releaseTag);
    }

    const executable = findExecutable(toolDir);
    const installed = await getVersion(executable);

    if (semver.neq(installed, toolVersion)) {
        throw new Error(`UPM CLI version mismatch: ${executable} reports ${installed}, expected ${toolVersion}.`);
    }

    core.addPath(toolDir);
    core.info(`UPM CLI ${installed}: ${executable}`);
    return executable;
}
