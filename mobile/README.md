# Mobile (Flutter)

The Flutter app is scaffolded with the Flutter CLI rather than committed by
hand, so the generated platform folders (`android/`, `ios/`, …) match your
installed Flutter/SDK versions.

## One-time setup

1. Install Flutter: https://docs.flutter.dev/get-started/install
2. Verify your toolchain:

   ```bash
   flutter doctor
   ```

3. Generate the app **into this folder** (run from the repo root):

   ```bash
   flutter create --org com.websol --project-name websol_crm mobile
   ```

## Run it

```bash
cd mobile
flutter pub get
flutter run
```

## Talking to the backend

Point the app at the local Functions host (`http://localhost:7071/api`) during
development, and at your deployed Azure Functions URL in production. Keep the
base URL in a single config/constants file (mirrors the `config.ts` pattern used
in `/backend`).
