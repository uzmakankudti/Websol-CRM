import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:signature/signature.dart';
import '../app_state.dart';

/// Close a ticket with proof: a customer digital signature OR an OTP.
class CloseScreen extends StatefulWidget {
  const CloseScreen({super.key, required this.ticketId});
  final int ticketId;
  @override
  State<CloseScreen> createState() => _CloseScreenState();
}

class _CloseScreenState extends State<CloseScreen> {
  String _method = 'SIGNATURE';
  final _name = TextEditingController();
  final _otp = TextEditingController();
  final _notes = TextEditingController();
  final _sigController = SignatureController(penStrokeWidth: 2, penColor: Colors.black);
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _sigController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final payload = <String, dynamic>{
      'method': _method,
      'resolutionNotes': _notes.text.trim(),
    };

    if (_method == 'SIGNATURE') {
      if (_name.text.trim().isEmpty) {
        setState(() {
          _error = "Customer's name is required for a signature";
          _busy = false;
        });
        return;
      }
      payload['signatureName'] = _name.text.trim();
      if (_sigController.isNotEmpty) {
        final bytes = await _sigController.toPngBytes();
        if (bytes != null) payload['signatureImage'] = 'data:image/png;base64,${base64Encode(bytes)}';
      }
    } else {
      if (!RegExp(r'^\d{4,8}$').hasMatch(_otp.text.trim())) {
        setState(() {
          _error = 'Enter the 4–8 digit OTP sent to the customer';
          _busy = false;
        });
        return;
      }
      payload['otp'] = _otp.text.trim();
    }

    final state = context.read<AppState>();
    try {
      final applied = await state.api.doAction(type: 'close', ticketId: widget.ticketId, payload: payload);
      await state.refreshPending();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(applied ? 'Ticket closed' : 'Saved offline — will sync later'),
        backgroundColor: applied ? Colors.green : Colors.orange,
      ));
      Navigator.pop(context, true);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Close Ticket')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (_error != null)
            Container(
              padding: const EdgeInsets.all(12),
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(color: Colors.red.shade50, borderRadius: BorderRadius.circular(8)),
              child: Text(_error!, style: TextStyle(color: Colors.red.shade900)),
            ),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'SIGNATURE', label: Text('Signature'), icon: Icon(Icons.draw)),
              ButtonSegment(value: 'OTP', label: Text('OTP'), icon: Icon(Icons.pin)),
            ],
            selected: {_method},
            onSelectionChanged: (s) => setState(() => _method = s.first),
          ),
          const SizedBox(height: 16),
          if (_method == 'SIGNATURE') ...[
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'Customer name', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
            const Text('Customer signature'),
            const SizedBox(height: 4),
            Container(
              decoration: BoxDecoration(border: Border.all(color: Colors.grey), borderRadius: BorderRadius.circular(8)),
              child: Signature(controller: _sigController, height: 180, backgroundColor: Colors.grey.shade100),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: () => _sigController.clear(),
                icon: const Icon(Icons.clear, size: 16),
                label: const Text('Clear'),
              ),
            ),
          ] else ...[
            TextField(
              controller: _otp,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'OTP from customer',
                helperText: 'A one-time code is sent to the customer to confirm completion',
                border: OutlineInputBorder(),
              ),
            ),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: _notes,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'Resolution notes', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: _busy
                  ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Close ticket'),
            ),
          ),
        ],
      ),
    );
  }
}
