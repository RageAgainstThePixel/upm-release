# upm-release

A GitHub action to sign and release a Unity UPM package.

## How to use

When the action runs, it will:

1. Check out the repository.
1. Read the `package.json` file to get the package name and version.
1. Optionally perform a subtree split to a specified branch (`upm` by default), then target that commit for the release.
1. Install or update the [Unity Package Manager CLI](https://docs.unity3d.com/6000.6/Documentation/Manual/upm-cli.html) to the latest release (via [`unity-cli`](https://github.com/RageAgainstThePixel/unity-cli)), then sign and pack the package with `upm pack`.
1. Create a draft GitHub release with the signed `.tgz` as a release asset.

> [!IMPORTANT]
> Make sure that the `package.json` file contains a valid semantic version (e.g., `1.0.0`, `2.1.3`, etc.) before running. If the version is not valid or an existing tag with the same version already exists, the action will fail.

The action generates a ***draft*** GitHub release tagged with the package version and uploads the signed package as a release asset.

### Requirements

- A **Unity Cloud** organization where you can use **Package Manager** features for signing.

**Package Manager service account (signing)**:

1. Open [Unity Cloud](https://cloud.unity.com/) and select the organization that should own signing (if you use several orgs, pick the right one before the next steps).
1. Create a **service account** on that organization.
1. Grant the account access at **organization** scope. In **Manage organization roles** (or your org’s equivalent role UI), set the **Package Manager** role to **Package Manager Package Signer**, then save.
1. Create or view credentials for that service account. You will get a **key id** and **secret**; store them as GitHub secrets (for example `UPM_SERVICE_ACCOUNT_KEY_ID` and `UPM_SERVICE_ACCOUNT_KEY_SECRET`) and pass them to the action inputs `upm-service-account-key-id` and `upm-service-account-key-secret`, **or** define those two names as environment variables on the job instead of inputs.
1. In the same org, open **Administration** → **Settings** and copy **Organization ID**. Store it as a GitHub secret (`UNITY_ORG_ID` or `UNITY_ORGANIZATION_ID`) and pass it to the **`organization-id`** input.

**CI authentication**:

- `GITHUB_TOKEN` (or `github-token`) with permission to create releases and upload assets. You may need a personal access token if the default token is insufficient (e.g. some private repo setups).

### workflow

```yaml
name: UPM Release
on:
  push:
    branches: [main]
  workflow_dispatch: # Optional: manual run; creates a draft release from the current ref and package version.

jobs:
  release:
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: RageAgainstThePixel/upm-release@v2
        id: upm_release
        with:
          organization-id: ${{ secrets.UNITY_ORG_ID }}
          upm-service-account-key-id: ${{ secrets.UPM_SERVICE_ACCOUNT_KEY_ID }}
          upm-service-account-key-secret: ${{ secrets.UPM_SERVICE_ACCOUNT_KEY_SECRET }}
          package-json: 'path/to/package.json' # optional; default glob is '**/Packages/**/package.json'
          release-title: 'Optional release title.' # optional
          release-notes: 'Optional release notes.' # optional; default from commit / PR
          github-token: ${{ secrets.GITHUB_TOKEN }} # optional
          split-upm-branch: 'upm' # optional; use 'none' to disable subtree split
      - name: Echo Signed Package path
        run: echo "Signed .tgz at ${{ steps.upm_release.outputs.artifact-path }}"
```

### inputs

| name | description | required |
| ---- | ----------- | -------- |
| organization-id | Unity Cloud organization id used for signing. Omit if `UNITY_ORG_ID` / `UNITY_ORGANIZATION_ID` is set in the environment. | true |
| upm-service-account-key-id | Service account key id. Omit if `UPM_SERVICE_ACCOUNT_KEY_ID` is set in the environment. | true |
| upm-service-account-key-secret | Service account key secret. Omit if `UPM_SERVICE_ACCOUNT_KEY_SECRET` is set in the environment. | true |
| package-json | Path glob for `package.json`. Default: `**/Packages/**/package.json`. | false |
| release-title | GitHub release title; default from package name and version. | false |
| release-notes | Release body; default from the target commit message. | false |
| github-token | Token for creating the release and uploading the asset. Defaults to `GITHUB_TOKEN`. | false |
| split-upm-branch | Branch name for `git subtree split`, or `none` to disable. Default: `upm`. | false |

### outputs

| name | description |
| ---- | ----------- |
| artifact-path | Absolute local path to the signed `.tgz` after signing and release upload succeed. |
