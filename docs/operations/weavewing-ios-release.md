# Release the Weavewing iOS app

> For maintainers. Using Weavewing? See [docs/user](../user/).

The mobile app ships as `Weavewing` with bundle identifier `dev.wingstack.weavewing.mobile`;
preview and development builds append `.preview` and `.dev`. Its widget, share extension, app
group and keychain group derive from that identifier. Development builds need no accounts.

Preview and production builds need the settings below. Loading a preview or production config
stops with an error naming any missing Expo setting, and `expo prebuild` stops before it generates
an iOS project without the Apple team ID. A build with no `APP_VARIANT` is a production build, so
prebuild checks it the same way.

| Setting                  | Needed by       | Source                               |
| ------------------------ | --------------- | ------------------------------------ |
| `T3CODE_APPLE_TEAM_ID`   | iOS             | Apple developer account, step 2      |
| `T3CODE_EXPO_OWNER`      | iOS and Android | Expo account or organization, step 3 |
| `T3CODE_EXPO_PROJECT_ID` | iOS and Android | Expo project, step 3                 |

None of these values is a secret. Keep the App Store Connect API key out of the repository.

## Tools

Install the EAS CLI and sign in to the Expo account that will own the project:

```bash
npm install --global eas-cli
eas login
eas whoami
```

## First release: direct pairing only

The first release has no accounts, relay or push notifications: users pair the app with their own
server. Without Clerk and relay settings the build requests no push, Sign in with Apple or
associated-domain entitlement, and the app offers no T3 Connect sign-in.

The app config reads settings from four places, and none may set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE` or `T3CODE_RELAY_URL`, or their `VITE_` and `EXPO_PUBLIC_` spellings
such as `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` and `VITE_T3CODE_RELAY_URL`:

- the repository-root `.env`, which `.env.example` tells readers to create by copying it; delete
  any Clerk or relay lines a copy carries;
- the repository-root `.env.local`;
- the `preview` EAS environment, checked with `eas env:list preview`;
- the `production` EAS environment, checked with `eas env:list production`.

Your shell's own environment also counts for local commands. Before each release build, confirm
what each EAS environment resolves to together with the local files. From `apps/mobile`:

```bash
set -e
out="$(mktemp -d)"
for env in preview production; do
  eas env:exec "$env" \
    "APP_VARIANT=$env pnpm exec expo config --type introspect --json > $out/$env.json"
  node -e '
    const c = require(process.argv[1]);
    const text = (value) => (typeof value === "string" ? value : null);
    console.log(process.argv[1], {
      relay: text(c.extra.relay.url),
      clerk: text(c.extra.clerk.publishableKey),
      domains: c.ios.associatedDomains ?? [],
      push: c.ios.entitlements["aps-environment"] ?? null,
    });
  ' "$out/$env.json"
done
```

The check writes to a new temporary folder and stops at the first failure, so a failed `eas`
call cannot print an earlier run's result. `eas env:exec` supplies only values your account can
read: also confirm in `eas env:list` that no Clerk or relay setting is stored with Secret
visibility, because the build would use it while this check would not see it.

Each line must show `relay: null, clerk: null, domains: [], push: null`.

## Owner steps, in order

1. **Join the Apple Developer Program and accept its agreements.** Accept the Program License
   Agreement in the developer account, and in App Store Connect under Business accept any
   agreement it lists as pending. A free app needs no Paid Apps agreement.
2. **Note the Team ID** from the developer account's Membership details. It fills
   `T3CODE_APPLE_TEAM_ID`, which also signs the macOS app.
3. **Create the Expo project.** On expo.dev, create a project named `weavewing` under the account
   or organization that will own it; the slug must stay `weavewing` to match the app config. The
   owner's name fills `T3CODE_EXPO_OWNER` and the project ID fills `T3CODE_EXPO_PROJECT_ID`.
   Over-the-air updates stay off, so the app never contacts Expo's update service; the first
   release ships that way. Setting `T3CODE_MOBILE_UPDATES_ENABLED=1` turns them on, and the
   privacy policy must name Expo before a build does that.
4. **Store the settings.** Put the three values in the repository-root `.env.local` for local
   commands. Then, from `apps/mobile`, create each one in the `preview` and `production` EAS
   environments so cloud builds see it. The EAS CLI finds the project through the project ID in
   `.env.local`, so set that file first:

   ```bash
   eas env:set --environment preview --environment production \
     --name T3CODE_EXPO_OWNER --value <owner> --visibility plaintext
   eas env:list preview
   eas env:list production
   ```

   Both lists must show the three values and no Clerk or relay value.

5. **Run the first production build** (below) and sign in with the Apple account when EAS asks.
   EAS registers the app, widget and share-extension identifiers and the app group, and creates
   the signing certificate and provisioning profiles.
6. **Create the App Store Connect record.** In Apps, add a new iOS app named `Weavewing` with
   bundle ID `dev.wingstack.weavewing.mobile` and any SKU. Copy the numeric Apple ID from App
   Information into `apps/mobile/eas.json` as `submit.production.ios.ascAppId` and commit it;
   `eas.json` cannot read environment variables, and the ID is public.
7. **Create the App Store Connect API key.** Under Users and Access, Integrations, generate a team
   key with the App Manager role and download the `.p8` file, which Apple offers only once. Give
   it to EAS with `eas credentials --platform ios`, choosing the App Store Connect API key, so
   submissions run without an Apple ID password. It fills no repository variable.
8. **Publish the legal and support pages** on `https://weavewing.wingstack.dev` before you
   submit. The app's Settings screen opens `/legal` and follows links only to these four pages, so
   `/legal` should link the other three:

   - `https://weavewing.wingstack.dev/legal`
   - `https://weavewing.wingstack.dev/privacy-policy`
   - `https://weavewing.wingstack.dev/terms-of-service`
   - `https://weavewing.wingstack.dev/security-policy`

   Enter the privacy policy URL under App Privacy and a Support URL on the version page. Answer
   the App Privacy questions for what the app collects.

9. **Prepare App Review access.** The app does nothing until it pairs with a Weavewing server, and
   reviewers cannot run one. Keep a demo server reachable from the public internet over HTTPS for
   the whole review, for example behind a reverse proxy at `https://review.example.com`. A pairing
   link is single-use and expires after five minutes by default, so mint links that outlast the
   review on that server:

   ```bash
   t3 pair --ttl 14d --label "App Review 1"
   ```

   `t3 pair` builds the link over http from the address the server listens on, such as
   `http://192.168.1.20:3773/pair#token=…`. It has no option for a public origin, so a proxy in
   front of the server does not change the link, and the QR code it prints encodes the same
   address. Replace everything before `/pair` with the public HTTPS origin and keep
   `/pair#token=…` exactly as printed: `https://review.example.com/pair#token=…`.

   Before submitting, rewrite one extra link the same way, paste it into the app on a phone
   outside the server's network, such as one on cellular data, and confirm it pairs. That uses up
   the link, so leave it out of the notes. Each link pairs one device, so put two or three unused
   links in App Review Information, Notes, with the steps: open the app, go to Settings, then
   Environments, and paste a link. Mint fresh links if a review outlasts them. Upload screenshots
   from the [screenshot harness](./mobile-app-store-screenshots.md).

## Optional services

These stay unset for the first release. Each adds entitlements only when it is set, so an unset
service never names another domain.

- `T3CODE_CLERK_PUBLISHABLE_KEY` adds passkey and Clerk return-link domains for the Clerk
  instance's Frontend API host, and Sign in with Apple. The Clerk instance must list the app's
  `<Team ID>.dev.wingstack.weavewing.mobile` identifier for its associated domains.
- `T3CODE_RELAY_URL` adds the push notification entitlement to the app and its widgets, because
  push reaches the app only through the relay.
- `T3CODE_HOSTED_APP_URL`, an https origin, lets copied thread links on that host open the app, and
  adds Copy link to the thread-link menu. The host must serve
  `apps/web/public/.well-known/apple-app-site-association.json` with
  `<Team ID>.dev.wingstack.weavewing.mobile` and the `.preview` and `.dev` identifiers added to
  `appIDs`; the file lists none until the Team ID exists.

## Build and submit

From `apps/mobile`:

```bash
vp run config:prod
vp run eas:ios:prod
eas submit --platform ios --profile production --latest
```

Run the resolved-config check from [First release](#first-release-direct-pairing-only) for both
EAS environments first. `vp run config:prod` shows the resolved config, or the Expo settings still
missing; the Apple team ID is checked when the build's prebuild step runs. The app version defaults
to `0.1.0` in `app.config.ts`; set `T3CODE_MOBILE_VERSION` or change the default for a new version.
EAS keeps and increments the build number.

Then submit the build for review in App Store Connect:

1. Wait until Apple finishes processing the upload; App Store Connect emails when it does, and the
   build then appears under TestFlight.
2. Open the app's iOS version page under Distribution. Its version number must match the build's
   version, `0.1.0` unless `T3CODE_MOBILE_VERSION` set another; edit the version number to match.
3. In the Build section, choose Add Build and select the uploaded build. The app declares that it
   uses no non-exempt encryption, so no export compliance question follows.
4. Fill in the version's screenshots, description, keywords, support URL and App Review
   Information, including the pairing links and steps from owner step 9. The app needs no sign-in.
5. Choose Add for Review, then submit the review submission it opens. After approval, release the
   version from the same page unless it was set to release automatically.

## Android builds

The Android app is unpublished. Its preview and production builds need the two Expo settings and
not the Apple team ID. `vp run android` builds the production variant, so it needs them too;
`vp run android:dev` builds the development variant and needs no accounts.

## Before enabling push

With a relay configured, a production build requests the development push environment:
the widgets plugin sets `aps-environment` to `development` before `expo-notifications` would set
`production`, because Expo runs plugin modifications in reverse order. Fix the plugin order, then
confirm `aps-environment` is `production` in a signed production build's entitlements, before
shipping any build with `T3CODE_RELAY_URL` set.
