import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import '../app_state.dart';
import 'meter_screen.dart';
import 'close_screen.dart';

/// Ticket detail + the field workflow. The action buttons available depend on
/// the ticket's current status, mirroring the backend lifecycle:
///   ASSIGNED → (En route) → IN_TRANSIT → (Check in) → ON_SITE →
///   (Start) → IN_PROGRESS → (Meter / Parts / Close / Escalate)
class TicketDetailScreen extends StatefulWidget {
  const TicketDetailScreen({super.key, required this.ticketId});
  final int ticketId;
  @override
  State<TicketDetailScreen> createState() => _TicketDetailScreenState();
}

class _TicketDetailScreenState extends State<TicketDetailScreen> {
  Map<String, dynamic>? _detail;
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
    try {
      final d = await context.read<AppState>().api.ticketDetail(widget.ticketId);
      if (mounted) setState(() => _detail = d);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Map<String, dynamic> get _ticket => _detail!['ticket'] as Map<String, dynamic>;
  String get _status => _ticket['status'] as String;

  /// Run an action; show whether it went through online or was queued offline.
  Future<void> _action(String type, Map<String, dynamic> payload) async {
    final state = context.read<AppState>();
    try {
      final applied = await state.api.doAction(type: type, ticketId: widget.ticketId, payload: payload);
      await state.refreshPending();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(applied ? 'Done' : 'Saved offline — will sync when back online'),
        backgroundColor: applied ? Colors.green : Colors.orange,
      ));
      _load();
    } on Exception catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$e'), backgroundColor: Colors.red),
      );
    }
  }

  Future<void> _checkIn() async {
    // GPS check-in records arrival location + time (server computes SLA met).
    LocationPermission perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Location permission is required to check in')),
        );
      }
      return;
    }
    final pos = await Geolocator.getCurrentPosition();
    await _action('checkin', {'lat': pos.latitude, 'lng': pos.longitude});
  }

  Future<void> _addParts() async {
    final consumable = TextEditingController();
    final warehouse = TextEditingController();
    final qty = TextEditingController(text: '1');
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Record part used'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: consumable, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Consumable ID')),
          TextField(controller: warehouse, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Warehouse / van stock ID')),
          TextField(controller: qty, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Quantity')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Add')),
        ],
      ),
    );
    if (ok == true) {
      final c = int.tryParse(consumable.text);
      final w = int.tryParse(warehouse.text);
      final q = int.tryParse(qty.text);
      if (c != null && w != null && q != null && q > 0) {
        // Auto-deducts inventory server-side (BR-021 guards against negatives).
        await _action('parts', {'consumableId': c, 'warehouseId': w, 'quantity': q});
      }
    }
  }

  Future<void> _escalate() async {
    final idCtrl = TextEditingController();
    final reasonCtrl = TextEditingController(text: 'Unable to resolve within SLA');
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Escalate to Senior Technician'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: idCtrl, keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Senior technician user ID')),
          TextField(controller: reasonCtrl, decoration: const InputDecoration(labelText: 'Reason')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Escalate')),
        ],
      ),
    );
    if (ok == true && int.tryParse(idCtrl.text) != null) {
      await _action('escalate', {'seniorTechnicianId': int.parse(idCtrl.text), 'reason': reasonCtrl.text});
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_loading ? 'Ticket' : (_ticket['ticketNo'] as String))),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!)))
              : _buildDetail(),
      bottomNavigationBar: _loading || _error != null ? null : _buildActions(),
    );
  }

  Widget _buildDetail() {
    final t = _ticket;
    final site = t['site'] as Map<String, dynamic>?;
    final printer = t['printer'] as Map<String, dynamic>?;
    final meters = (_detail!['meterReadings'] as List).cast<Map<String, dynamic>>();
    final parts = (_detail!['partsUsed'] as List).cast<Map<String, dynamic>>();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _row('Status', (t['status'] as String).replaceAll('_', ' ')),
        _row('Type', (t['visitType'] as String).replaceAll('_', ' ')),
        _row('Priority', t['priority'] as String),
        _row('Customer', t['customer']['name'] as String? ?? '—'),
        if (site != null) _row('Site', '${site['name']} · ${site['address'] ?? ''}, ${site['city'] ?? ''}'),
        if (printer != null) _row('Printer', '${printer['serialNo']} · ${printer['model']}${printer['isColour'] == true ? ' (colour)' : ''}'),
        if (t['slaDueAt'] != null) _row('SLA due', t['slaDueAt'] as String),
        if (t['slaMet'] != null) _row('SLA met', t['slaMet'] == true ? 'Yes' : 'No'),
        if (t['description'] != null) _row('Notes', t['description'] as String),
        const Divider(height: 32),
        Text('Meter readings (${meters.length})', style: const TextStyle(fontWeight: FontWeight.bold)),
        ...meters.map((m) => ListTile(
              dense: true,
              title: Text('B/W ${m['readingBw']}${m['readingColour'] != null ? ' · Colour ${m['readingColour']}' : ''}'),
              subtitle: Text('Δ ${m['deltaBw'] ?? '—'}${m['needsApproval'] == true ? '  ⚠ needs approval' : ''}'),
            )),
        const SizedBox(height: 12),
        Text('Parts used (${parts.length})', style: const TextStyle(fontWeight: FontWeight.bold)),
        ...parts.map((p) => ListTile(dense: true, title: Text('${p['name']} × ${p['quantity']}'))),
      ],
    );
  }

  Widget _row(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 110, child: Text(label, style: const TextStyle(color: Colors.grey))),
          Expanded(child: Text(value)),
        ]),
      );

  /// Status-driven action bar.
  Widget _buildActions() {
    final buttons = <Widget>[];
    void add(String label, IconData icon, VoidCallback onTap) =>
        buttons.add(FilledButton.icon(onPressed: onTap, icon: Icon(icon, size: 18), label: Text(label)));

    switch (_status) {
      case 'ASSIGNED':
        add('En route', Icons.directions_car, () => _action('transit', {}));
        break;
      case 'IN_TRANSIT':
        add('Check in (GPS)', Icons.location_on, _checkIn);
        break;
      case 'ON_SITE':
        add('Start work', Icons.play_arrow, () => _action('start', {}));
        break;
      case 'IN_PROGRESS':
        add('Meter', Icons.speed, () async {
          final printer = _ticket['printer'] as Map<String, dynamic>?;
          if (printer == null) return;
          final saved = await Navigator.push<bool>(context,
              MaterialPageRoute(builder: (_) => MeterScreen(ticketId: widget.ticketId, isColour: printer['isColour'] == true)));
          if (saved == true) _load();
        });
        add('Parts', Icons.build, _addParts);
        add('Close', Icons.check_circle, () async {
          final saved = await Navigator.push<bool>(context,
              MaterialPageRoute(builder: (_) => CloseScreen(ticketId: widget.ticketId)));
          if (saved == true) _load();
        });
        break;
    }

    // Escalation is available throughout the active lifecycle.
    if (['ASSIGNED', 'IN_TRANSIT', 'ON_SITE', 'IN_PROGRESS'].contains(_status)) {
      add('Escalate', Icons.arrow_upward, _escalate);
    }

    if (buttons.isEmpty) {
      return const Padding(padding: EdgeInsets.all(16), child: Text('No actions for this status.'));
    }
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Wrap(spacing: 8, runSpacing: 8, children: buttons),
      ),
    );
  }
}
