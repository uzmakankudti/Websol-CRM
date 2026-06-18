import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'api_client.dart';
import 'app_state.dart';
import 'screens/login_screen.dart';
import 'screens/today_screen.dart';

void main() {
  runApp(const WebsolFieldApp());
}

class WebsolFieldApp extends StatelessWidget {
  const WebsolFieldApp({super.key});

  @override
  Widget build(BuildContext context) {
    final api = ApiClient();
    return ChangeNotifierProvider(
      create: (_) => AppState(api)..init(),
      child: MaterialApp(
        title: 'Websol Field Service',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorSchemeSeed: const Color(0xFF2563EB),
          useMaterial3: true,
        ),
        home: const _Root(),
      ),
    );
  }
}

/// Decides between Login and the technician's day view based on auth state.
class _Root extends StatelessWidget {
  const _Root();

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    return state.isAuthenticated ? const TodayScreen() : const LoginScreen();
  }
}
