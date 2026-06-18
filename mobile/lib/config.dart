/// Central app configuration — mirrors the backend's `config.ts` pattern of
/// keeping every environment knob in ONE place.
class Config {
  /// Base URL of the Azure Functions API.
  /// Local dev: the Functions host. Override at build time with:
  ///   flutter run --dart-define=API_BASE_URL=https://<your-app>.azurewebsites.net/api
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://localhost:7071/api',
  );

  /// SharedPreferences keys.
  static const String kToken = 'auth_token';
  static const String kUser = 'auth_user';
  static const String kQueue = 'offline_action_queue';
}
