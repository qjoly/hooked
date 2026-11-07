# hooked for iOS

A native SwiftUI remote for hooked: list sessions, read conversations, reply, answer questions, permissions and plans, switch mode or model, launch new sessions.

## Build

Requires Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
cd ios
xcodegen generate
open Hooked.xcodeproj
```

The `.xcodeproj` is generated, not committed: rerun `xcodegen generate` after pulling.

## Run on your iPhone (free Apple ID)

1. Xcode → Settings → Accounts: add your Apple ID (a free personal team is enough).
2. Select the **Hooked** target → Signing & Capabilities → Team: your personal team. If the bundle id `dev.qjoly.hooked.ios` is taken, change it to something unique.
3. Plug in the phone, enable Developer Mode (Settings → Privacy & Security), pick it as the run destination and press Run.
4. First launch: trust the developer profile in Settings → General → VPN & Device Management.

A free team signs the app for **7 days**. After that it won't open: plug the phone in and press Run again to re-sign. No push notifications with a free team.

## Pair

The phone needs to reach the hooked machine (same LAN, or WireGuard) and hooked must listen on it (`HOST=0.0.0.0`). In the app, enter host and port (4123), then tap **Test & Save**.

Or open a pairing link on the phone, which fills and saves everything:

```
hooked://connect?host=192.168.1.20&port=4123
```

Add `&https=1` if hooked sits behind TLS. Plain HTTP is allowed on purpose (LAN / WireGuard, personal app).
