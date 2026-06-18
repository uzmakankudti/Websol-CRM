import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import '../app_state.dart';

/// Capture a meter reading with an optional photo.
/// Enforced server-side: BR-004 (>= previous), BR-005 (3x allowance → approval),
/// BR-006 (colour printers need both values). We surface those errors inline.
class MeterScreen extends StatefulWidget {
  const MeterScreen({super.key, required this.ticketId, required this.isColour});
  final int ticketId;
  final bool isColour;

  @override
  State<MeterScreen> createState() => _MeterScreenState();
}

class _MeterScreenState extends State<MeterScreen> {
  final _bw = TextEditingController();
  final _colour = TextEditingController();
  String? _photoBase64;
  String? _photoName;
  bool _busy = false;
  String? _error;

  Future<void> _takePhoto() async {
    final picker = ImagePicker();
    final file = await picker.pickImage(source: ImageSource.camera, maxWidth: 1280, imageQuality: 70);
    if (file == null) return;
    final bytes = await File(file.path).readAsBytes();
    setState(() {
      _photoBase64 = 'data:image/jpeg;base64,${base64Encode(bytes)}';
      _photoName = file.name;
    });
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final bw = int.tryParse(_bw.text.trim());
    if (bw == null) {
      setState(() {
        _error = 'Enter a valid B/W reading';
        _busy = false;
      });
      return;
    }
    final payload = <String, dynamic>{'readingBw': bw};
    if (widget.isColour) {
      final c = int.tryParse(_colour.text.trim());
      if (c == null) {
        setState(() {
          _error = 'Colour printers require a colour reading (BR-006)';
          _busy = false;
        });
        return;
      }
      payload['readingColour'] = c;
    }
    if (_photoBase64 != null) payload['photoImage'] = _photoBase64;

    final state = context.read<AppState>();
    try {
      final applied = await state.api.doAction(type: 'meter', ticketId: widget.ticketId, payload: payload);
      await state.refreshPending();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(applied ? 'Reading saved' : 'Saved offline — will sync later'),
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
      appBar: AppBar(title: const Text('Meter Reading')),
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
          TextField(
            controller: _bw,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'B/W meter reading', border: OutlineInputBorder()),
          ),
          if (widget.isColour) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _colour,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Colour meter reading', border: OutlineInputBorder()),
            ),
          ],
          const SizedBox(height: 16),
          OutlinedButton.icon(
            onPressed: _takePhoto,
            icon: const Icon(Icons.camera_alt),
            label: Text(_photoName == null ? 'Add photo of meter' : 'Photo: $_photoName'),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: _busy
                  ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Save reading'),
            ),
          ),
        ],
      ),
    );
  }
}
