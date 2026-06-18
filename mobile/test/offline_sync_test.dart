/// Offline sync tests (Module 7, requirement 6):
///   "Offline: data saved locally and syncs correctly when back online."
///
/// These exercise the client-side queue in `ApiClient`:
///   - an action that fails on the network is saved locally (not lost),
///   - a real business-rule rejection is surfaced (not silently queued),
///   - reconnecting replays the whole queue to /service-tickets/sync,
///   - acknowledged actions (APPLIED *or* DUPLICATE) leave the queue,
///   - the field timestamp + unique clientActionId are preserved for replay.
///
/// Run with:  flutter test
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:websol_crm/api_client.dart';
import 'package:websol_crm/config.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    // Start each test signed in with an empty offline queue.
    SharedPreferences.setMockInitialValues({Config.kToken: 'header.payload.sig'});
  });

  Future<List<dynamic>> readQueue() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(Config.kQueue);
    return raw == null ? [] : jsonDecode(raw) as List;
  }

  group('doAction online', () {
    test('posts directly and does not queue when the network is available', () async {
      var posted = false;
      final client = MockClient((req) async {
        posted = true;
        expect(req.url.path, endsWith('/service-tickets/100/checkin'));
        return http.Response(jsonEncode({'ticket': {}}), 200);
      });
      final api = ApiClient(client: client);
      await api.loadToken();

      final applied = await api.doAction(type: 'checkin', ticketId: 100, payload: {'lat': -33.9, 'lng': 18.4});

      expect(applied, isTrue);
      expect(posted, isTrue);
      expect(await api.pendingCount(), 0);
    });

    test('a business-rule rejection (4xx) is thrown, not queued', () async {
      final client = MockClient((req) async => http.Response(
            jsonEncode({'error': {'message': 'reading too low', 'code': 'READING_BELOW_PREVIOUS'}}),
            422,
          ));
      final api = ApiClient(client: client);
      await api.loadToken();

      await expectLater(
        api.doAction(type: 'meter', ticketId: 100, payload: {'readingBw': 1}),
        throwsA(isA<ApiException>()),
      );
      // A genuine rejection must NOT be hidden in the offline queue.
      expect(await api.pendingCount(), 0);
    });
  });

  group('doAction offline', () {
    test('saves the action locally when the network call fails', () async {
      final client = MockClient((req) async => throw Exception('no connection'));
      final api = ApiClient(client: client);
      await api.loadToken();

      final applied = await api.doAction(
        type: 'close',
        ticketId: 100,
        payload: {'method': 'OTP', 'otp': '123456'},
      );

      expect(applied, isFalse); // queued, not applied
      expect(await api.pendingCount(), 1);

      // The persisted action keeps a unique id and the field timestamp so it can
      // be replayed idempotently later.
      final queue = await readQueue();
      final entry = queue.single as Map<String, dynamic>;
      expect(entry['clientActionId'], isNotEmpty);
      expect(entry['type'], 'close');
      expect(entry['ticketId'], 100);
      expect(entry['payload']['otp'], '123456');
      expect(entry['payload']['occurredAt'], isNotEmpty);
    });

    test('queues multiple actions in order', () async {
      final client = MockClient((req) async => throw Exception('offline'));
      final api = ApiClient(client: client);
      await api.loadToken();

      await api.doAction(type: 'transit', ticketId: 100, payload: {});
      await api.doAction(type: 'checkin', ticketId: 100, payload: {'lat': 1, 'lng': 2});

      expect(await api.pendingCount(), 2);
      final queue = await readQueue();
      expect((queue[0] as Map)['type'], 'transit');
      expect((queue[1] as Map)['type'], 'checkin');
    });
  });

  group('flushQueue (back online)', () {
    test('replays the queue to /sync and clears APPLIED actions', () async {
      // This single client fails direct posts (forcing a queue) but answers /sync.
      final client = MockClient((req) async {
        if (req.url.path.endsWith('/service-tickets/sync')) {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          final actions = (body['actions'] as List).cast<Map<String, dynamic>>();
          // Echo each clientActionId back as APPLIED.
          final results = actions
              .map((a) => {'clientActionId': a['clientActionId'], 'status': 'APPLIED'})
              .toList();
          return http.Response(jsonEncode({'results': results}), 200);
        }
        throw Exception('offline'); // direct action → queue it
      });
      final api = ApiClient(client: client);
      await api.loadToken();

      await api.doAction(type: 'transit', ticketId: 100, payload: {});
      await api.doAction(type: 'start', ticketId: 100, payload: {});
      expect(await api.pendingCount(), 2);

      final results = await api.flushQueue();

      expect(results.length, 2);
      expect(results.every((r) => r['status'] == 'APPLIED'), isTrue);
      expect(await api.pendingCount(), 0); // queue drained
    });

    test('a DUPLICATE result also clears the action (idempotent replay)', () async {
      final client = MockClient((req) async {
        if (req.url.path.endsWith('/service-tickets/sync')) {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          final actions = (body['actions'] as List).cast<Map<String, dynamic>>();
          // Server has seen this id before → DUPLICATE (no double-apply).
          final results = actions
              .map((a) => {'clientActionId': a['clientActionId'], 'status': 'DUPLICATE'})
              .toList();
          return http.Response(jsonEncode({'results': results}), 200);
        }
        throw Exception('offline');
      });
      final api = ApiClient(client: client);
      await api.loadToken();

      await api.doAction(type: 'transit', ticketId: 100, payload: {});
      final results = await api.flushQueue();

      expect(results.single['status'], 'DUPLICATE');
      expect(await api.pendingCount(), 0);
    });

    test('flushQueue is a no-op when nothing is queued', () async {
      final client = MockClient((req) async => http.Response(jsonEncode({'results': []}), 200));
      final api = ApiClient(client: client);
      await api.loadToken();

      final results = await api.flushQueue();
      expect(results, isEmpty);
    });

    test('the exact field actions queued are the ones sent to /sync', () async {
      List<dynamic>? sentActions;
      final client = MockClient((req) async {
        if (req.url.path.endsWith('/service-tickets/sync')) {
          sentActions = (jsonDecode(req.body) as Map<String, dynamic>)['actions'] as List;
          final results = sentActions!
              .map((a) => {'clientActionId': (a as Map)['clientActionId'], 'status': 'APPLIED'})
              .toList();
          return http.Response(jsonEncode({'results': results}), 200);
        }
        throw Exception('offline');
      });
      final api = ApiClient(client: client);
      await api.loadToken();

      await api.doAction(type: 'parts', ticketId: 100, payload: {'consumableId': 3, 'warehouseId': 1, 'quantity': 2});
      await api.flushQueue();

      expect(sentActions, hasLength(1));
      final sent = (sentActions!.single as Map)['payload'] as Map;
      expect(sent['consumableId'], 3);
      expect(sent['quantity'], 2);
      expect(sent['occurredAt'], isNotEmpty); // field timestamp travels to the server
    });
  });
}
