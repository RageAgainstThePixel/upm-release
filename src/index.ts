import core = require('@actions/core');
import { exec } from '@actions/exec';
import * as fs from 'fs';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import * as path from 'path';
import {
    UnityHub,
    UnityVersion
} from '@rage-against-the-pixel/unity-cli';

const main = async () => {
    try {
        const githubToken = core.getInput('github-token', { required: false }) || process.env.GITHUB_TOKEN || undefined;

        if (!githubToken) {
            throw new Error('GitHub token is required to create a release. Please ensure your workflow enables permissions for GITHUB_TOKEN or pass a personal access token.');
        }

        const octokit = github.getOctokit(githubToken);
        const username: string = core.getInput('username', { required: true });
        const password: string = core.getInput('password', { required: true });
        const organizationId: string = core.getInput('organization-id', { required: true });
        let releaseNotes: string = core.getInput('release-notes', { required: false });

        await git(['config', 'user.name', 'github-actions[bot]']);
        await git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
        await git(['fetch', '--tags', '--force']);

        let packageName = '';
        let packageVersion = '';
        let packageJsonPath = core.getInput('package-json', { required: false }) || `**/Packages/**/package.json`;

        const globber = await glob.create(packageJsonPath);
        const packageJsonFiles = await globber.glob();

        if (packageJsonFiles.length === 0) {
            throw new Error('No package.json file found in the working directory or its subdirectories');
        }

        if (packageJsonFiles.length > 1) {
            throw new Error('Multiple package.json files found in the working directory or its subdirectories. Please ensure there is only one package.json file.');
        }

        packageJsonPath = packageJsonFiles[0];
        let packageDir = path.dirname(packageJsonPath);
        core.info(`Package directory: ${packageDir}`);

        if (!packageJsonPath) {
            throw new Error('package.json path is not specified.');
        }

        try {
            const stat = await fs.promises.stat(packageJsonPath);

            if (!stat.isFile()) {
                throw new Error('package.json is not a file.');
            }

            await fs.promises.access(packageJsonPath, fs.constants.R_OK);
        } catch (error) {
            throw new Error('package.json file not found or is not readable.');
        }

        var packageJsonContent = fs.readFileSync(packageJsonPath, { encoding: 'utf-8' });
        var packageJson = JSON.parse(packageJsonContent);
        packageName = packageJson.name;
        packageVersion = packageJson.version;
        const isPreview = packageJson.version.includes('-pre');

        const tags = await getTags();
        const lastTag = Array.from(tags.keys()).pop() || '';

        if (tags.has(packageVersion)) {
            throw new Error(`Tag for ${packageName} ${packageVersion} already exists. Please ensure the package version is updated for a new release.`);
        }

        core.info(`Generating Release for ${packageName} ${packageVersion}...`);

        const splitUpmBranch = core.getInput('split-upm-branch', { required: false }) || 'upm';
        const split = splitUpmBranch.toLowerCase() !== 'none';
        let commitish = '';

        if (split) {
            const workspace = process.env.GITHUB_WORKSPACE;
            const relativeWorkspace = packageDir.replace(workspace, '').replace(/^[\/\\]/, '');
            await git(['subtree', 'split', '--prefix', relativeWorkspace, '-b', splitUpmBranch]);
            await git(['push', '-u', 'origin', splitUpmBranch, '--force']);
            commitish = (await git(['rev-parse', splitUpmBranch])).trim();
            await git(['checkout', commitish]);
            packageJsonPath = path.join(workspace, 'package.json');
            packageDir = workspace;
        } else {
            commitish = (github.context.sha || await git(['rev-parse', 'HEAD'])).trim();
        }

        core.info(`Using target commit ${commitish} for the release.`);

        if (!releaseNotes) {
            const commitMessage: string = (await git(['log', '-1', '--pretty=%B', commitish])).trim();
            releaseNotes = commitMessage;

            const releaseNotesLines = releaseNotes.split('\n');
            // escape packageName and packageVersion for use in RegExp
            const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pkgNameEsc = escapeForRegExp(packageName);
            const pkgVerEsc = escapeForRegExp(packageVersion);
            // allow optional parentheses around the PR number like "(#2)" or "#2"
            const firstLineRegex = new RegExp(`^${pkgNameEsc}\\s+v?${pkgVerEsc}\\s*(?:\\(|)\\#(\\d+)(?:\\)|)$`);
            let prNumber = '';
            const firstLineMatch = releaseNotesLines[0].match(firstLineRegex);

            if (firstLineMatch) {
                prNumber = firstLineMatch[1];
                releaseNotesLines.shift();
                releaseNotes = releaseNotesLines.join('\n').trim();
            }

            let actor = '';

            if (prNumber.length > 0) {
                let pr: any | null = null;
                try {
                    const { data } = await octokit.rest.pulls.get({
                        owner: github.context.repo.owner,
                        repo: github.context.repo.repo,
                        pull_number: parseInt(prNumber)
                    });
                    pr = data;
                } catch (error) {
                    core.warning(`Failed to get PR #${prNumber} details: ${error}`);
                }
                actor = pr?.user?.login;
            }

            if (!actor || actor.length === 0) {
                actor = process.env.GITHUB_ACTOR || github.context.actor;
            }

            const prInfo = prNumber ? ` in #${prNumber}` : '';
            let finalReleaseNotes = `## What's Changed\n- ${packageName} ${packageVersion} by @${actor}${prInfo}`;

            if (releaseNotes.length > 0) {
                const formatted = releaseNotes.split('\n').map(line => {
                    const trimmed = line.trimEnd();
                    if (trimmed.length === 0) return '';
                    // If the line already starts with a bullet, keep it and indent two spaces before it
                    if (/^[-]\s+/.test(trimmed)) {
                        return `  ${trimmed}`;
                    }
                    // otherwise add a bullet
                    return `  - ${trimmed}`;
                }).join('\n');
                finalReleaseNotes += `\n\n${formatted}`;
            }

            if (lastTag.length > 0) {
                finalReleaseNotes += `\n\n**Full Changelog**: https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/compare/${lastTag}...${packageVersion}`;
            } else {
                finalReleaseNotes += `\n\n**Full Changelog**: https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/commits/${packageVersion}`;
            }
            releaseNotes = finalReleaseNotes;
        }

        core.startGroup(`----- Release Notes -----`);
        core.info(releaseNotes);
        core.endGroup();

        const unityHub = new UnityHub();
        await unityHub.Install(true, undefined);
        // must use a unity editor 6000.3 or newer
        const unityVersion = new UnityVersion('6000.3');
        const unityEditor = await unityHub.GetEditor(unityVersion, undefined, ['f', 'b']);
        const outputDir = process.env.RUNNER_TEMP;

        await unityEditor.Run({
            args: [
                '-batchmode',
                '-username', username,
                '-password', password,
                '-cloudOrganization', organizationId,
                '-upmPack', packageDir, outputDir,
            ]
        });

        const tgzGlobber = await glob.create(path.join(outputDir, '*.tgz'));
        const tgzFiles = await tgzGlobber.glob();

        if (tgzFiles.length === 0) {
            throw new Error('Signed .tgz file not found in the output directory');
        }

        const signedTgzPath = tgzFiles[0];
        core.info(`Signed package created at ${signedTgzPath}`);

        let releaseTitle = core.getInput('release-title', { required: false }) || `${packageName} ${packageVersion}`;

        const { data: release } = await octokit.rest.repos.createRelease({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            tag_name: packageVersion,
            name: releaseTitle,
            body: releaseNotes,
            generate_release_notes: false,
            target_commitish: commitish,
            prerelease: isPreview,
            draft: true
        });
        core.info(`Release created: ${release.html_url}`);

        const { data: asset } = await octokit.rest.repos.uploadReleaseAsset({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            release_id: release.id,
            name: path.basename(signedTgzPath),
            data: fs.readFileSync(signedTgzPath) as unknown as string,
            headers: {
                'content-type': 'application/tar+gzip',
                'content-length': fs.statSync(signedTgzPath).size
            }
        });

        core.info(`Release asset uploaded: ${asset.browser_download_url}`);
    } catch (error) {
        core.setFailed(error);
    }
}

main();

/**
 * Get the list of valid SemVer tags and their parent sha
 * @returns Map of tags and their parent sha
 */
async function getTags(): Promise<Map<string, string>> {
    const semverRegex = /^v?\d+\.\d+\.\d+$/;
    const tags = (await git(['tag', '--list', `--sort=version:refname`])).split('\n').filter(tag => tag.trim() !== '').filter(tag => semverRegex.test(tag));
    const tagMap = new Map<string, string>();
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        tagMap.set(tag, await getParentSha(tag));
    }
    return tagMap;
}

/**
 * Get the parent sha of a ref
 * @param ref Ref to get parent sha for
 * @returns Parent sha
 */
async function getParentSha(ref: string): Promise<string> {
    return (await git(['rev-parse', '--verify', `${ref}^{}`])).trim();
}

/**
 * Run a git command
 * @param params Git command parameters
 * @returns Git command output
 */
async function git(params: string[], warnOnError: boolean = false): Promise<string> {
    let output: string = '';
    let error: string = '';
    const exitCode = await exec('git', params, {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            },
            stderr: (data: Buffer) => {
                error += data.toString();
            }
        }
    });
    if (exitCode !== 0) {
        throw new Error(error);
    }
    if (error && warnOnError) {
        core.warning(error);
    }
    return output;
}
