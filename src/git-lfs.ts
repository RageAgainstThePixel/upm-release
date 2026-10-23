import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import * as core from '@actions/core';
import { exec } from '@actions/exec';

const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';
// pointer files are small text files, anything bigger is real content
const LFS_POINTER_MAX_SIZE = 1024;

/**
 * Lists tracked files under a directory that are Git LFS pointers rather than their real content.
 * @param directory Directory to scan, inside a git work tree.
 * @returns Absolute paths of pointer files.
 */
export async function findLfsPointers(directory: string): Promise<string[]> {
    const chunks: Buffer[] = [];
    await exec('git', ['ls-files', '-z'], {
        cwd: directory,
        silent: true,
        listeners: {
            stdout: (data: Buffer) => { chunks.push(data); }
        }
    });
    // decode once so multibyte filenames split across chunks stay intact
    const output = Buffer.concat(chunks).toString('utf-8');
    const pointers: string[] = [];

    for (const file of output.split('\0').filter(file => file.length > 0)) {
        const filePath = path.resolve(directory, file);
        let content: string;

        try {
            // stat and read through one handle so the file can't change in between, and don't follow symlinks
            const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));

            try {
                const stat = await handle.stat();

                if (!stat.isFile() || stat.size > LFS_POINTER_MAX_SIZE) { continue; }

                content = await handle.readFile({ encoding: 'utf-8' });
            } finally {
                await handle.close();
            }
        } catch {
            continue;
        }

        if (content.startsWith(LFS_POINTER_HEADER) && /^oid sha256:[0-9a-f]{64}$/m.test(content)) {
            pointers.push(filePath);
        }
    }

    return pointers;
}

/**
 * Replaces Git LFS pointer files under a directory with their real content, so the package is packed with the actual files.
 * Uses `git lfs smudge` on each pointer, which works even when the directory has no `.gitattributes` for those files
 * (e.g. a subtree split of a package whose LFS rules live in the repository root).
 * @param directory Directory to scan, inside a git work tree. The LFS remote is resolved from the work tree containing it.
 * @param configOverrides `key=value` git config entries passed to each smudge, e.g. from {@link getLfsConfigOverrides}.
 * @returns Number of files that were materialized.
 */
export async function materializeLfsFiles(directory: string, configOverrides: string[] = []): Promise<number> {
    const pointers = await findLfsPointers(directory);

    if (pointers.length === 0) {
        return 0;
    }

    // the work tree that owns the directory, e.g. a submodule, so its own LFS endpoint is used
    const repoRoot = path.resolve(await gitOutput(['rev-parse', '--show-toplevel'], directory));

    const lfsVersion = await exec('git', ['lfs', 'version'], { silent: true, ignoreReturnCode: true });

    if (lfsVersion !== 0) {
        throw new Error(`Found ${pointers.length} Git LFS pointer file(s) in ${directory}, but git-lfs is not installed on this runner. Install git-lfs before running this action.`);
    }

    core.startGroup(`Downloading ${pointers.length} Git LFS file(s)...`);
    try {
        for (const pointer of pointers) {
            const relativePath = path.relative(repoRoot, pointer).split(path.sep).join('/');
            await smudge(pointer, relativePath, repoRoot, configOverrides);
            core.info(`  ${relativePath}`);
        }
    } finally {
        core.endGroup();
    }

    const remaining = await findLfsPointers(directory);

    if (remaining.length > 0) {
        throw new Error(`Git LFS files are still pointers after download:\n${remaining.join('\n')}`);
    }

    return pointers.length;
}

/**
 * Streams `git lfs smudge` output for a pointer file into a temp file, then replaces the pointer with it.
 * @param pointer Absolute path of the pointer file.
 * @param relativePath Path of the file relative to `repoRoot`, with forward slashes.
 * @param repoRoot Root of the git work tree.
 * @param configOverrides `key=value` git config entries passed with `-c`.
 */
async function smudge(pointer: string, relativePath: string, repoRoot: string, configOverrides: string[]): Promise<void> {
    // private temp dir beside the pointer, so the rename stays on the same file system
    const tempDir = await fs.promises.mkdtemp(path.join(path.dirname(pointer), '.upm-release-lfs-'));
    const tempPath = path.join(tempDir, path.basename(pointer));
    // override any skip smudge or fetch filters, every pointer in the package has to be downloaded
    const args = [...configOverrides.flatMap(entry => ['-c', entry]), '-c', 'lfs.fetchinclude=', '-c', 'lfs.fetchexclude=', 'lfs', 'smudge', '--', relativePath];
    const child = spawn('git', args, {
        cwd: repoRoot,
        env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '0' },
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const exited = new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => resolve(code ?? 1));
    });
    exited.catch(() => undefined);

    try {
        child.stdin.end(await fs.promises.readFile(pointer));
        await pipeline(child.stdout, fs.createWriteStream(tempPath, { flags: 'wx' }));
        const exitCode = await exited;

        if (exitCode !== 0) {
            throw new Error(`git lfs smudge failed for ${relativePath}: ${stderr.trim()}`);
        }

        // keep the checked out file mode, e.g. executable helpers
        await fs.promises.chmod(tempPath, (await fs.promises.stat(pointer)).mode & 0o7777);
        await fs.promises.rename(tempPath, pointer);
    } catch (error) {
        child.kill();
        throw error;
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

/**
 * Reads the LFS settings from a work tree's `.lfsconfig`, such as a custom `lfs.url`, so they can still be applied
 * after checking out a commit that doesn't have that file (e.g. a subtree split of a nested package).
 * Settings already set in the git config are skipped, since they take precedence over `.lfsconfig` anyway.
 * @param repoRoot Root of the git work tree.
 * @returns `key=value` entries for {@link materializeLfsFiles}.
 */
export async function getLfsConfigOverrides(repoRoot: string): Promise<string[]> {
    const lfsConfig = path.join(repoRoot, '.lfsconfig');

    if (!fs.existsSync(lfsConfig)) {
        return [];
    }

    const overrides: string[] = [];
    const entries = (await gitOutput(['config', '--file', lfsConfig, '--list', '-z'], repoRoot)).split('\0');

    for (const entry of entries.filter(entry => entry.length > 0)) {
        const newline = entry.indexOf('\n');
        const key = newline >= 0 ? entry.substring(0, newline) : entry;
        const value = newline >= 0 ? entry.substring(newline + 1) : '';

        // only the settings git-lfs itself accepts from .lfsconfig, anything else (e.g. custom transfer agents) could run programs
        if (!isSafeLfsConfigKey(key)) { continue; }

        const isSet = await exec('git', ['config', '--get', key], { cwd: repoRoot, silent: true, ignoreReturnCode: true });

        if (isSet !== 0) {
            overrides.push(`${key}=${value}`);
        }
    }

    return overrides;
}

// git-lfs's .lfsconfig allowlist, see https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc
const SAFE_LFS_CONFIG_KEYS = new Set([
    'lfs.allowincompletepush',
    'lfs.fetchexclude',
    'lfs.fetchinclude',
    'lfs.gitprotocol',
    'lfs.locksverify',
    'lfs.pushurl',
    'lfs.skipdownloaderrors',
    'lfs.url'
]);
const SAFE_LFS_CONFIG_PATTERNS = [
    /^lfs\..+\.access$/i,
    /^lfs\..+\.locksverify$/i,
    /^remote\..+\.lfsurl$/i,
    /^remote\..+\.lfspushurl$/i
];

function isSafeLfsConfigKey(key: string): boolean {
    return SAFE_LFS_CONFIG_KEYS.has(key.toLowerCase()) || SAFE_LFS_CONFIG_PATTERNS.some(pattern => pattern.test(key));
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
    const chunks: Buffer[] = [];
    await exec('git', args, {
        cwd,
        silent: true,
        listeners: {
            stdout: (data: Buffer) => { chunks.push(data); }
        }
    });
    return Buffer.concat(chunks).toString('utf-8').trim();
}

/**
 * Checks if a directory has a `.gitattributes` file with Git LFS rules.
 * @param directory Directory to check.
 */
export async function hasLfsAttributes(directory: string): Promise<boolean> {
    try {
        const attributes = await fs.promises.readFile(path.join(directory, '.gitattributes'), { encoding: 'utf-8' });
        return /filter=lfs/.test(attributes);
    } catch {
        return false;
    }
}
