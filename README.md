# upm-release

A GitHub action to sign and release a upm package.

## How to use

This action is designed to be used in a GitHub Actions workflow that is triggered on a new tag push. The tag should match the version specified in the `package.json` file of your Unity package.

When the action runs, it will:

1. Check out the repository.
2. Read the `package.json` file to get the package name and version.
3. Sign the package using the `unity-cli` tool.
4. Create a draft GitHub release with the signed package artifact.

> [!IMPORTANT]
> Make sure that the `package.json` file contains a valid semantic version (e.g., `1.0.0`, `2.1.3`, etc.) before running. If the version is not valid, or does not match the target tag, the action will fail.

The action will then generate a ***draft*** GitHub release with the tag name and upload the signed package as a release asset.

### Requirements

- A Unity account with access to the organization that owns the package.
- Unity email and password stored as GitHub secrets.
- The organization cloud id stored as a GitHub secret.
- `GITHUB_TOKEN` secret to create releases and uploads. You may need to set the correct permissions or provide a personal access token if your repository is private or if the default token does not have sufficient permissions.

### workflow

```yaml
name: UPM Release
on:
  push:
    tags: ['*.*.*'] # Adjust this to your versioning scheme
  workflow_dispatch: # Optional: allows manual triggering of the workflow. Will attempt to make a draft release on the latest tag.
jobs:
  release:
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v5
      with:
        ref: main # Set to your default branch
    - uses: RageAgainstThePixel/upm-release@v1
      with:
        username: ${{ secrets.UNITY_USERNAME }}
        password: ${{ secrets.UNITY_PASSWORD }}
        organization-id: ${{ secrets.UNITY_ORG_ID }}
        package-json: 'path/to/package.json' # optional, default is '**/Packages/**/package.json' glob search
        release-title: 'Optional release title for this release.' # optional, default is generated from package name and version
        release-notes: 'Optional release notes.' # optional, default is generated from commit message
        github-token: ${{ secrets.GITHUB_TOKEN }} # optional, default is GITHUB_TOKEN secret
```

### inputs

| name | description | required |
| ---- | ----------- | -------- |
| username | The username for the Unity account. | true |
| password | The password for the Unity account. | true |
| organization-id | The organization ID for the Unity account. | true |
| package-json | Path to the package.json file. Defaults to `**/Packages/**/package.json` glob search. | false |
| release-title | The title for the GitHub release. If not provided, it will be generated from the package name and version. | false |
| release-notes | The release notes for the GitHub release. If not provided, it will be generated from the commit message. | false |
| github-token | GitHub token to create releases and upload assets. Defaults to the GITHUB_TOKEN secret, but may be required if permissions are not set correctly or the repository is private. | false |
