# upm-release

A GitHub action to sign and release a upm package.

## How to use

Once a pull request is merged into the target branch, this action will create a new git tag based on the version specified in the `package.json` file located at the root of the repository.

> [!NOTE]
> Make sure that the `package.json` file contains a valid semantic version (e.g., `1.0.0`, `2.1.3`, etc.) before pushing to the target branch! If the version is not valid, or the git tag already exists, the action will fail.

Once the tag is created, the package will be signed and the resulting `.tgz` file will be uploaded as a release asset to the corresponding GitHub release.

The action will then generate a ***draft*** GitHub release with the tag name and upload the signed package as a release asset.

### workflow

```yaml
name: UPM Release
on:
  push:
    branches: [upm]
jobs:
  release:
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v5
    - uses: RageAgainstThePixel/upm-release@v1
      with:
        username: ${{ secrets.UNITY_USERNAME }}
        password: ${{ secrets.UNITY_PASSWORD }}
        organization-id: ${{ secrets.UNITY_ORGANIZATION_ID }}
        package-json: 'path/to/package.json' # optional, default is searching in the repository root for package.json
        release-title: 'Optional release title for this release.' # optional, default is generated from package name and version
        release-notes: 'Optional release notes.' # optional, default is generated from commit message that triggered the action
        github-token: ${{ secrets.GITHUB_TOKEN }} # optional, default is GITHUB_TOKEN secret
```

### inputs

| name | description | required |
| ---- | ----------- | -------- |
| username | The username for the Unity account. | true |
| password | The password for the Unity account. | true |
| organization-id | The organization ID for the Unity account. | true |
| package-json | Path to the package.json file. Defaults to searching in the repository root for package.json. | false |
| release-title | The title for the GitHub release. If not provided, it will be generated from the package name and version. | false |
| release-notes | The release notes for the GitHub release. If not provided, it will be generated from the commit message that triggered the action. | false |
| github-token | GitHub token to create releases and upload assets. Defaults to the GITHUB_TOKEN secret, but may be required if permissions are not set correctly or the repository is private. | false |
