import 'dart:async';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'api_client.dart';

/// App-wide state: auth status, connectivity, and the pending-sync count.
///
/// Watches connectivity and auto-flushes the offline queue the moment a
/// connection returns — the technician's field actions reach the server
/// without them having to think about it.
class AppState extends ChangeNotifier {
  AppState(this.api);
  final ApiClient api;

  bool _online = true;
  bool get online => _online;

  int _pending = 0;
  int get pending => _pending;

  bool get isAuthenticated => api.isAuthenticated;

  StreamSubscription? _connSub;

  Future<void> init() async {
    await api.loadToken();
    await refreshPending();

    final conn = Connectivity();
    final initial = await conn.checkConnectivity();
    _online = !initial.contains(ConnectivityResult.none);

    _connSub = conn.onConnectivityChanged.listen((results) async {
      final nowOnline = !results.contains(ConnectivityResult.none);
      final cameOnline = nowOnline && !_online;
      _online = nowOnline;
      notifyListeners();
      if (cameOnline) await sync();
    });
    notifyListeners();
  }

  Future<void> refreshPending() async {
    _pending = await api.pendingCount();
    notifyListeners();
  }

  /// Flush the offline queue (no-op when empty). Safe to call repeatedly.
  Future<List<Map<String, dynamic>>> sync() async {
    if (!_online) return [];
    try {
      final results = await api.flushQueue();
      await refreshPending();
      return results;
    } catch (_) {
      // Still offline / server unreachable — leave the queue for next time.
      return [];
    }
  }

  Future<void> logout() async {
    await api.logout();
    notifyListeners();
  }

  @override
  void dispose() {
    _connSub?.cancel();
    super.dispose();
  }
}
