/// Plain data models mirroring the backend's public JSON shapes
/// (see backend/src/functions/field-service.ts `toTicketPublic`).

class SiteRef {
  final int id;
  final String? name;
  final String? address;
  final String? city;
  final double? lat;
  final double? lng;
  SiteRef({required this.id, this.name, this.address, this.city, this.lat, this.lng});
  factory SiteRef.fromJson(Map<String, dynamic> j) => SiteRef(
        id: j['id'] as int,
        name: j['name'] as String?,
        address: j['address'] as String?,
        city: j['city'] as String?,
        lat: (j['lat'] as num?)?.toDouble(),
        lng: (j['lng'] as num?)?.toDouble(),
      );
}

class PrinterRef {
  final int id;
  final String? serialNo;
  final String? model;
  final bool isColour;
  PrinterRef({required this.id, this.serialNo, this.model, required this.isColour});
  factory PrinterRef.fromJson(Map<String, dynamic> j) => PrinterRef(
        id: j['id'] as int,
        serialNo: j['serialNo'] as String?,
        model: j['model'] as String?,
        isColour: j['isColour'] == true,
      );
}

class Ticket {
  final int id;
  final String ticketNo;
  final String visitType;
  final String priority;
  final String status;
  final String customerName;
  final String? customerPhone;
  final SiteRef? site;
  final PrinterRef? printer;
  final String? description;
  final String? scheduledDate;
  final String? slaDueAt;
  final bool? slaMet;

  Ticket({
    required this.id,
    required this.ticketNo,
    required this.visitType,
    required this.priority,
    required this.status,
    required this.customerName,
    this.customerPhone,
    this.site,
    this.printer,
    this.description,
    this.scheduledDate,
    this.slaDueAt,
    this.slaMet,
  });

  factory Ticket.fromJson(Map<String, dynamic> j) {
    final cust = (j['customer'] as Map<String, dynamic>?) ?? const {};
    return Ticket(
      id: j['id'] as int,
      ticketNo: j['ticketNo'] as String,
      visitType: j['visitType'] as String,
      priority: j['priority'] as String,
      status: j['status'] as String,
      customerName: cust['name'] as String? ?? '—',
      customerPhone: cust['phone'] as String?,
      site: j['site'] == null ? null : SiteRef.fromJson(j['site'] as Map<String, dynamic>),
      printer: j['printer'] == null ? null : PrinterRef.fromJson(j['printer'] as Map<String, dynamic>),
      description: j['description'] as String?,
      scheduledDate: j['scheduledDate'] as String?,
      slaDueAt: j['slaDueAt'] as String?,
      slaMet: j['slaMet'] as bool?,
    );
  }

  /// Priority sort rank (CRITICAL first). The backend already sorts, but the
  /// app re-sorts locally too so cached/offline lists stay ordered.
  int get priorityRank => const {
        'CRITICAL': 0,
        'HIGH': 1,
        'MEDIUM': 2,
        'LOW': 3,
      }[priority] ?? 9;
}

/// One action the technician performed in the field. When offline these are
/// persisted and replayed later via the idempotent /service-tickets/sync API.
class QueuedAction {
  final String clientActionId; // unique → makes replay idempotent server-side
  final String type;           // transit | checkin | start | meter | parts | close | escalate | cancel
  final int ticketId;
  final Map<String, dynamic> payload;
  final String occurredAt;     // when it actually happened in the field

  QueuedAction({
    required this.clientActionId,
    required this.type,
    required this.ticketId,
    required this.payload,
    required this.occurredAt,
  });

  Map<String, dynamic> toJson() => {
        'clientActionId': clientActionId,
        'type': type,
        'ticketId': ticketId,
        // carry the field timestamp so the server records when it happened,
        // not when it was synced.
        'payload': {...payload, 'occurredAt': occurredAt},
      };

  factory QueuedAction.fromJson(Map<String, dynamic> j) => QueuedAction(
        clientActionId: j['clientActionId'] as String,
        type: j['type'] as String,
        ticketId: j['ticketId'] as int,
        payload: Map<String, dynamic>.from(j['payload'] as Map),
        occurredAt: (j['payload']?['occurredAt'] as String?) ?? '',
      );
}
