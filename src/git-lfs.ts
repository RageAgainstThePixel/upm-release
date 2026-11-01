import * as fs from 'fs';
import * as path from 'path';
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
    let output = '';
    await exec('git', ['ls-files', '-z'], {
        cwd: directory,
        silent: true,
        listeners: {
            stdout: (data: Buffer) => { output += data.toString(); }
        }
    });
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
 * @param directory Directory to scan, inside the git work tree at `repoRoot`.
 * @param repoRoot Root of the git work tree, used to resolve the LFS remote.
 * @returns Number of files that were materialized.
 */
export async function materializeLfsFiles(directory: string, repoRoot: string): Promise<number> {
    const pointers = await findLfsPointers(directory);

    if (pointers.length === 0) {
        return 0;
    }

    const lfsVersion = await exec('git', ['lfs', 'version'], { silent: true, ignoreReturnCode: true });

    if (lfsVersion !== 0) {
        throw new Error(`Found ${pointers.length} Git LFS pointer file(s) in ${directory}, but git-lfs is not installed on this runner. Install git-lfs before running this action.`);
    }

    core.startGroup(`Downloading ${pointers.length} Git LFS file(s)...`);
    try {
        for (const pointer of pointers) {
            const relativePath = path.relative(repoRoot, pointer).split(path.sep).join('/');
            const chunks: Buffer[] = [];
            let stderr = '';
            const exitCode = await exec('git', ['lfs', 'smudge', '--', relativePath], {
                cwd: repoRoot,
                input: await fs.promises.readFile(pointer),
                silent: true,
                ignoreReturnCode: true,
                listeners: {
                    stdout: (data: Buffer) => { chunks.push(data); },
                    stderr: (data: Buffer) => { stderr += data.toString(); }
                }
            });

            if (exitCode !== 0) {
                throw new Error(`git lfs smudge failed for ${relativePath}: ${stderr.trim()}`);
            }

            await fs.promises.writeFile(pointer, Buffer.concat(chunks));
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
