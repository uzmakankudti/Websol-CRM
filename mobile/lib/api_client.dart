import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import 'config.dart';
import 'models.dart';

/// Thrown for any non-2xx response so the UI can show `error.message`.
class ApiException implements Exception {
  final int status;
  final String message;
  final String? code;
  ApiException(this.status, this.message, [this.code]);
  @override
  String toString() => message;
}

/// ApiClient wraps REST calls and owns the offline action queue.
///
/// ── How offline sync works (in one paragraph) ─────────────────────────────
/// Every field action (en route, check-in, meter reading, parts, close,
/// escalate) is tagged with a unique `clientActionId` generated on the device.
/// When we have a connection we POST the action straight to its endpoint. When
/// we don't — or the call fails — we save the action to a queue in local
/// storage and move on, so the technician is never blocked. Later,
/// `flushQueue()` replays the whole queue in one POST to
/// `/service-tickets/sync`. Because the server remembers every `clientActionId`
/// it has already applied, replaying the same action twice is harmless: the
/// second time it just answers "DUPLICATE". That idempotency is what makes
/// "work offline and sync later" safe even over a flaky mobile connection.
class ApiClient {
  ApiClient({http.Client? client}) : _http = client ?? http.Client();

  final http.Client _http;
  final _uuid = const Uuid();
  String? _token;

  // --- auth/token ----------------------------------------------------------

  Future<void> loadToken() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString(Config.kToken);
  }

  Future<void> _saveToken(String token) async {
    _token = token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(Config.kToken, token);
  }

  Future<void> logout() async {
    _token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(Config.kToken);
    await prefs.remove(Config.kUser);
  }

  bool get isAuthenticated => _token != null;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
      };

  // --- low-level helpers ---------------------------------------------------

  Future<dynamic> _get(String path) async {
    final res = await _http.get(Uri.parse('${Config.apiBaseUrl}$path'), headers: _headers);
    return _decode(res);
  }

  Future<dynamic> _post(String path, Map<String, dynamic> body) async {
    final res = await _http.post(
      Uri.parse('${Config.apiBaseUrl}$path'),
      headers: _headers,
      body: jsonEncode(body),
    );
    return _decode(res);
  }

  dynamic _decode(http.Response res) {
    final data = res.body.isEmpty ? {} : jsonDecode(res.body);
    if (res.statusCode >= 200 && res.statusCode < 300) return data;
    final err = (data is Map && data['error'] is Map) ? data['error'] as Map : {};
    throw ApiException(res.statusCode, err['message']?.toString() ?? 'Request failed', err['code']?.toString());
  }

  // --- auth (reuses Module 1's /auth/login) --------------------------------

  Future<Map<String, dynamic>> login(String email, String password) async {
    final data = await _post('/auth/login', {'email': email, 'password': password});
    final token = data['token'] as String?;
    if (token == null) throw ApiException(500, 'Login response missing token');
    await _saveToken(token);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(Config.kUser, jsonEncode(data['user'] ?? {}));
    return data;
  }

  // --- tickets (reads) -----------------------------------------------------

  /// Today's assigned tickets, already sorted by the backend (priority +
  /// geography). Pass the device position so the server sorts by distance.
  Future<List<Ticket>> myTickets({String? date, double? lat, double? lng}) async {
    final qs = <String, String>{};
    if (date != null) qs['date'] = date;
    if (lat != null && lng != null) {
      qs['lat'] = '$lat';
      qs['lng'] = '$lng';
    }
    final query = qs.isEmpty ? '' : '?${qs.entries.map((e) => '${e.key}=${e.value}').join('&')}';
    final data = await _get('/service-tickets/my$query');
    final list = (data['tickets'] as List).cast<Map<String, dynamic>>();
    final tickets = list.map(Ticket.fromJson).toList();
    tickets.sort((a, b) => a.priorityRank.compareTo(b.priorityRank));
    return tickets;
  }

  Future<Map<String, dynamic>> ticketDetail(int id) async =>
      (await _get('/service-tickets/$id')) as Map<String, dynamic>;

  // --- field actions (write, queued when offline) --------------------------

  /// Run a field action. If online we hit the action endpoint directly; on any
  /// network failure we enqueue it for later sync and report it as "queued".
  ///
  /// Returns true if it was applied online, false if it was queued offline.
  Future<bool> doAction({
    required String type,
    required int ticketId,
    required Map<String, dynamic> payload,
  }) async {
    final action = QueuedAction(
      clientActionId: _uuid.v4(),
      type: type,
      ticketId: ticketId,
      payload: payload,
      occurredAt: DateTime.now().toUtc().toIso8601String(),
    );

    try {
      // Carry occurredAt so an online action is timestamped consistently too.
      await _post('/service-tickets/$ticketId/$type', {...payload, 'occurredAt': action.occurredAt});
      return true;
    } on ApiException {
      // A real business-rule rejection (4xx) should surface, not be silently
      // queued — only queue when it's a *connectivity* failure (below).
      rethrow;
    } catch (_) {
      // Network/socket failure → queue for later.
      await _enqueue(action);
      return false;
    }
  }

  // --- offline queue -------------------------------------------------------

  Future<List<QueuedAction>> _readQueue() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(Config.kQueue);
    if (raw == null || raw.isEmpty) return [];
    final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    return list.map(QueuedAction.fromJson).toList();
  }

  Future<void> _writeQueue(List<QueuedAction> queue) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(Config.kQueue, jsonEncode(queue.map((a) => a.toJson()).toList()));
  }

  Future<void> _enqueue(QueuedAction action) async {
    final queue = await _readQueue();
    queue.add(action);
    await _writeQueue(queue);
  }

  Future<int> pendingCount() async => (await _readQueue()).length;

  /// Replay all queued actions in one idempotent batch. Applied/duplicate
  /// actions are removed from the queue; actions the server rejects with a
  /// business error are also removed (they'd never succeed on replay) and
  /// returned so the UI can flag them. Returns the server's per-action results.
  Future<List<Map<String, dynamic>>> flushQueue() async {
    final queue = await _readQueue();
    if (queue.isEmpty) return [];

    final data = await _post('/service-tickets/sync', {
      'actions': queue.map((a) => a.toJson()).toList(),
    });
    final results = (data['results'] as List).cast<Map<String, dynamic>>();

    // Anything the server has now seen (APPLIED/DUPLICATE/ERROR) can leave the
    // queue. We keep nothing that the server acknowledged.
    final acknowledged = results.map((r) => r['clientActionId']).toSet();
    final remaining = queue.where((a) => !acknowledged.contains(a.clientActionId)).toList();
    await _writeQueue(remaining);
    return results;
  }
}
