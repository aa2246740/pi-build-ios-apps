---
name: pi-build-ios-apps
description: Build, launch, and debug iOS Simulator apps from Pi using Xcode CLI, simctl, serve-sim, and optional cmux browser panes.
---

# pi-build-ios-apps

Use this skill when the user asks Pi to build, run, test, preview, or debug an iOS app.

## Non-Negotiable Constraints

- Do not modify the user's system proxy settings. Never run `scutil --proxy` mutating commands, `networksetup` proxy mutations, or unset `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY` for the user's environment.
- Do not modify the original source tree when the user asks for test-only work. If native generation, dependency changes, or Pods are needed, use a runner clone or temporary copy.
- Prefer Apple CLI tools and the extension tools over Xcode GUI steps.
- Keep validation evidence explicit: command, simulator UDID, URL, build result, screenshot/preview status, and known proof boundary.

## Tool Order

1. Run `pi_ios_doctor` to inspect Xcode, `xcrun`, simulator runtimes, Node/npm, CocoaPods, `serve-sim`, and cmux.
2. Use `pi_ios_xcodebuild` for native Xcode project/workspace build/test/list-schemes actions.
3. Use `pi_ios_simulator` for boot, install, launch, terminate, screenshot, and simulator list actions.
4. Use `pi_ios_serve_sim` to start a scoped `serve-sim` helper for one explicit Simulator UDID.
5. Use `pi_ios_cmux_open` to open or reuse a cmux browser surface when running inside cmux.
6. Use `pi_ios_preview` for a direct MJPEG preview if the official `serve-sim` page remains stuck on `Connecting`.

## cmux Browser Discipline

- Do not open a second browser tab/surface unless it is necessary.
- First reuse an explicit `cmuxSurface` if the user provided one.
- Then reuse the surface remembered by `pi_ios_cmux_open`.
- Only create a new cmux browser surface when no reusable surface exists or `newSurface: true` is explicitly requested.
- When creating a cmux surface, pass `--focus false` and route to `CMUX_WORKSPACE_ID` when available.

## serve-sim Connecting Recovery

If a `serve-sim` preview URL such as `http://localhost:3210/?device=<UDID>` stays on `Connecting`:

1. Do not touch system proxy settings.
2. Check whether the simulator and helper are alive:

   ```sh
   xcrun simctl list devices booted
   npx --yes serve-sim@latest --list <UDID>
   curl http://127.0.0.1:3100/health
   curl http://127.0.0.1:3100/stream.mjpeg | head -c 32 | xxd -p
   ```

3. If `health` is ok and `stream.mjpeg` has frame bytes, the simulator stream is healthy and the issue is the official preview UI state. Start a direct preview with `pi_ios_preview`.
4. If `health` fails or the simulator is not booted, boot the simulator, launch the app, and restart `pi_ios_serve_sim` for that exact UDID.

## React Native / Expo Notes

- Ensure Metro is running before launching the app.
- For dev client launches, pass `RCT_METRO_PORT`, for example `{"RCT_METRO_PORT":"8081"}`, through `pi_ios_simulator` launch env.
- CocoaPods is needed only when the generated native iOS project uses Pods. Do not assume SwiftPM replaces Pods for React Native native modules.

## Reporting

Always report:

- project/runner directory
- simulator name and UDID
- bundle ID
- build command or tool used
- preview URL
- whether the preview is official `serve-sim` or direct MJPEG fallback
- whether interaction was verified by `simctl`, `serve-sim tap`, cmux browser, or visual inspection only
