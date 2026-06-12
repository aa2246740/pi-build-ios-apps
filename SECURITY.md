# Security

`pi-build-ios-apps` is a local Pi package for iOS build and Simulator workflows.
Like any Pi extension, it can run local commands when the agent calls its tools.

Review the source before installing it in a sensitive environment.

## What the package can run

The extension wraps local developer tools such as:

- `xcodebuild`
- `xcrun simctl`
- `npx --yes serve-sim@latest`
- `cmux`
- `node`, `npm`, and shell discovery commands

## Explicit boundaries

- It does not modify system proxy settings.
- It does not read or upload API keys.
- It does not contact a remote service except through the tools you already run,
  for example npm resolving `serve-sim` through `npx`.
- It scopes `serve-sim --kill` to one explicit Simulator UDID.
- It does not require CocoaPods unless the target project itself uses Pods.

## Reporting

Please report security issues privately through GitHub security advisories when
available, or open a minimal issue that does not include secrets.
