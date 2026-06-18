import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../app_state.dart';
import '../models.dart';
import 'ticket_detail_screen.dart';

/// The technician's "my day": today's assigned tickets, sorted by priority
/// then geography (the device sends its GPS so the server sorts by distance).
class TodayScreen extends StatefulWidget {
  const TodayScreen({super.key});
  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> {
  List<Ticket> _tickets = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final state = context.read<AppState>();
    try {
      // Flush anything queued offline first, then refresh the list.
      await state.sync();

      double? lat, lng;
      try {
        final pos = await _position();
        lat = pos?.latitude;
        lng = pos?.longitude;
      } catch (_) {/* GPS optional for the list */}

      final today = DateFormat('yyyy-MM-dd').format(DateTime.now());
      final tickets = await state.api.myTickets(date: today, lat: lat, lng: lng);
      if (mounted) setState(() => _tickets = tickets);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<Position?> _position() async {
    LocationPermission perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) return null;
    return Geolocator.getCurrentPosition();
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(
        title: const Text("Today's Tickets"),
        actions: [
          _SyncBadge(online: state.online, pending: state.pending),
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
          IconButton(
            onPressed: () async {
              await state.logout();
            },
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) {
      return ListView(children: [
        Padding(padding: const EdgeInsets.all(24), child: Text('Could not load tickets:\n$_error')),
      ]);
    }
    if (_tickets.isEmpty) {
      return ListView(children: const [
        SizedBox(height: 120),
        Center(child: Text('No tickets assigned for today 🎉')),
      ]);
    }
    return ListView.separated(
      itemCount: _tickets.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) => _TicketTile(
        ticket: _tickets[i],
        onTap: () async {
          await Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => TicketDetailScreen(ticketId: _tickets[i].id)),
          );
          _load();
        },
      ),
    );
  }
}

class _TicketTile extends StatelessWidget {
  const _TicketTile({required this.ticket, required this.onTap});
  final Ticket ticket;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      leading: _PriorityChip(priority: ticket.priority),
      title: Text('${ticket.ticketNo} · ${ticket.customerName}'),
      subtitle: Text(
        '${ticket.visitType.replaceAll('_', ' ')}'
        '${ticket.site?.city != null ? ' · ${ticket.site!.city}' : ''}'
        '${ticket.description != null ? '\n${ticket.description}' : ''}',
      ),
      isThreeLine: ticket.description != null,
      trailing: _StatusChip(status: ticket.status),
    );
  }
}

class _PriorityChip extends StatelessWidget {
  const _PriorityChip({required this.priority});
  final String priority;
  @override
  Widget build(BuildContext context) {
    final color = const {
          'CRITICAL': Colors.red,
          'HIGH': Colors.orange,
          'MEDIUM': Colors.blue,
          'LOW': Colors.grey,
        }[priority] ??
        Colors.grey;
    return CircleAvatar(
      backgroundColor: color.withOpacity(0.15),
      child: Icon(Icons.flag, color: color, size: 18),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final String status;
  @override
  Widget build(BuildContext context) {
    return Chip(
      label: Text(status.replaceAll('_', ' '), style: const TextStyle(fontSize: 11)),
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
    );
  }
}

/// Shows online/offline and how many actions are waiting to sync.
class _SyncBadge extends StatelessWidget {
  const _SyncBadge({required this.online, required this.pending});
  final bool online;
  final int pending;
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Center(
        child: Row(
          children: [
            Icon(online ? Icons.cloud_done : Icons.cloud_off,
                color: online ? Colors.green : Colors.grey, size: 20),
            if (pending > 0) ...[
              const SizedBox(width: 4),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(color: Colors.orange, borderRadius: BorderRadius.circular(10)),
                child: Text('$pending', style: const TextStyle(color: Colors.white, fontSize: 11)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
