import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Admin Control Center read models (spec §36/§37/§38).
 *
 * These are deliberately read-only projections. Every mutation an admin can
 * perform goes through CorrectionsService so it is reasoned about, permission
 * checked and audited in one place (§7).
 */
@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Live floor overview: workers, stations, sessions, exceptions (§36). */
  async overview() {
    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const [
      stations,
      activeSessions,
      todaySessions,
      openDiscrepancies,
      expectedArrivals,
      cartonsToday,
      pendingCorrections,
    ] = await Promise.all([
      this.prisma.station.findMany({
        orderBy: [{ department: 'asc' }, { code: 'asc' }],
        include: { assignedWorker: { select: { id: true, name: true, employeeCode: true } } },
      }),
      this.prisma.receivingSession.findMany({
        where: { status: { in: ['RECEIVING', 'PAUSED'] } },
        orderBy: { startedAt: 'desc' },
        include: {
          expectedArrival: { select: { id: true, code: true, customerName: true, storeName: true } },
          _count: { select: { cartons: true, discrepancies: true } },
        },
      }),
      this.prisma.receivingSession.count({ where: { startedAt: { gte: since } } }),
      this.prisma.receivingDiscrepancy.count({ where: { status: 'OPEN' } }),
      this.prisma.expectedArrival.count({ where: { status: { in: ['EXPECTED', 'RECEIVING', 'PAUSED'] } } }),
      this.prisma.receivingCarton.count({ where: { createdAt: { gte: since }, status: 'RECEIVED' } }),
      this.prisma.operationCorrection.count({ where: { createdAt: { gte: since } } }),
    ]);

    // Resolve worker identities for the active sessions in one query rather
    // than N lookups (the floor view refreshes often).
    const workerIds = [...new Set(activeSessions.map((s) => s.startedBy).filter(Boolean))] as string[];
    const workers = workerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: workerIds } },
          select: { id: true, name: true, employeeCode: true },
        })
      : [];
    const workerById = new Map(workers.map((w) => [w.id, w]));

    return {
      generatedAt: new Date().toISOString(),
      counters: {
        activeSessions: activeSessions.length,
        todaySessions,
        openExceptions: openDiscrepancies,
        expectedArrivals,
        cartonsReceivedToday: cartonsToday,
        correctionsToday: pendingCorrections,
        activeStations: stations.filter((s) => s.status === 'ACTIVE').length,
        stations: stations.length,
      },
      stations: stations.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        department: s.department,
        status: s.status,
        capabilities: s.capabilities,
        worker: s.assignedWorker,
      })),
      activeSessions: activeSessions.map((s) => ({
        id: s.id,
        code: s.code,
        status: s.status,
        startedAt: s.startedAt,
        arrival: s.expectedArrival,
        worker: s.startedBy ? (workerById.get(s.startedBy) ?? { id: s.startedBy }) : null,
        cartonEvents: s._count.cartons,
        discrepancies: s._count.discrepancies,
      })),
    };
  }

  /** Workers with their operational footprint (§37). */
  async workers() {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        status: true,
        roles: { select: { role: { select: { name: true } } } },
        stationsAssigned: { select: { id: true, code: true, name: true, department: true } },
      },
    });

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    // Session counts per worker for today, in one grouped query.
    const grouped = await this.prisma.receivingSession.groupBy({
      by: ['startedBy'],
      where: { startedAt: { gte: since } },
      _count: { _all: true },
    });
    const countByWorker = new Map(grouped.map((g) => [g.startedBy, g._count._all]));

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      employeeCode: u.employeeCode,
      status: u.status,
      roles: u.roles.map((r) => r.role.name),
      station: u.stationsAssigned[0] ?? null,
      sessionsToday: countByWorker.get(u.id) ?? 0,
    }));
  }

  /** Drill-down: one worker and their sessions (§37). */
  async worker(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        employeeCode: true,
        status: true,
        roles: { select: { role: { select: { name: true } } } },
        stationsAssigned: { select: { id: true, code: true, name: true, department: true } },
      },
    });
    if (!user) throw new NotFoundException('Worker not found.');

    const sessions = await this.prisma.receivingSession.findMany({
      where: { startedBy: id },
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: {
        expectedArrival: { select: { id: true, code: true, customerName: true } },
        _count: { select: { cartons: true, products: true, discrepancies: true } },
      },
    });

    return {
      worker: {
        id: user.id,
        name: user.name,
        employeeCode: user.employeeCode,
        status: user.status,
        roles: user.roles.map((r) => r.role.name),
        station: user.stationsAssigned[0] ?? null,
      },
      sessions: sessions.map((s) => ({
        id: s.id,
        code: s.code,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        arrival: s.expectedArrival,
        counts: s._count,
      })),
    };
  }

  /**
   * Full operational timeline of one session (§37).
   * Every carton event, product line, discrepancy and correction, merged into
   * a single chronological list so an admin can reconstruct what happened.
   */
  async session(id: string) {
    const session = await this.prisma.receivingSession.findFirst({
      where: { OR: [{ id }, { code: id.toUpperCase() }] },
      include: {
        expectedArrival: true,
        shipment: true,
        station: { select: { id: true, code: true, name: true, department: true } },
        cartons: { include: { carton: true }, orderBy: { createdAt: 'asc' } },
        products: { orderBy: { createdAt: 'asc' } },
        discrepancies: { orderBy: { createdAt: 'asc' } },
        corrections: {
          orderBy: { createdAt: 'asc' },
          include: { admin: { select: { id: true, name: true, employeeCode: true } } },
        },
      },
    });
    if (!session) throw new NotFoundException('Session not found.');

    const worker = session.startedBy
      ? await this.prisma.user.findUnique({
          where: { id: session.startedBy },
          select: { id: true, name: true, employeeCode: true },
        })
      : null;

    type Event = {
      at: Date;
      kind: string;
      label: string;
      detail: Record<string, unknown>;
    };
    const timeline: Event[] = [];

    timeline.push({
      at: session.startedAt,
      kind: 'SESSION_START',
      label: `Session ${session.code} started`,
      detail: {
        arrival: session.expectedArrival?.code,
        device: session.deviceType,
        station: session.station?.code ?? null,
      },
    });

    for (const c of session.cartons) {
      timeline.push({
        at: c.receivedAt ?? c.createdAt,
        kind: c.status === 'REVERSED' ? 'CARTON_REVERSED' : 'CARTON',
        label: `${c.scannedCode} ${c.status}`,
        detail: { code: c.scannedCode, status: c.status, source: c.source, scanType: c.scanType },
      });
    }
    for (const p of session.products) {
      timeline.push({
        at: p.updatedAt,
        kind: 'PRODUCT',
        label: `${p.sku ?? p.reference ?? 'unknown'} ${p.receivedQuantity}/${p.expectedQuantity}`,
        detail: { sku: p.sku, received: p.receivedQuantity, expected: p.expectedQuantity, status: p.status },
      });
    }
    for (const d of session.discrepancies) {
      timeline.push({
        at: d.createdAt,
        kind: 'EXCEPTION',
        label: `${d.type} (${d.status})`,
        detail: { id: d.id, type: d.type, status: d.status, reason: d.reason },
      });
    }
    for (const c of session.corrections) {
      timeline.push({
        at: c.createdAt,
        kind: 'CORRECTION',
        label: `${c.code} ${c.action}`,
        detail: { code: c.code, action: c.action, reason: c.reason, admin: c.admin?.name },
      });
    }
    if (session.completedAt) {
      timeline.push({
        at: session.completedAt,
        kind: 'SESSION_END',
        label: `Session ${session.code} completed`,
        detail: {},
      });
    }

    timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return {
      session: {
        id: session.id,
        code: session.code,
        status: session.status,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        deviceType: session.deviceType,
        arrival: session.expectedArrival,
        shipment: session.shipment,
        station: session.station,
        worker,
      },
      cartons: session.cartons,
      products: session.products,
      discrepancies: session.discrepancies,
      corrections: session.corrections,
      timeline,
    };
  }

  /** Exception Center feed (§38). */
  async exceptions(status: 'OPEN' | 'RESOLVED' | 'REJECTED' | 'ALL' = 'OPEN') {
    const rows = await this.prisma.receivingDiscrepancy.findMany({
      where: status === 'ALL' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        session: {
          select: {
            id: true,
            code: true,
            startedBy: true,
            expectedArrival: { select: { code: true, customerName: true } },
          },
        },
      },
    });

    const workerIds = [...new Set(rows.map((r) => r.session?.startedBy).filter(Boolean))] as string[];
    const workers = workerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: workerIds } },
          select: { id: true, name: true, employeeCode: true },
        })
      : [];
    const byId = new Map(workers.map((w) => [w.id, w]));

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      reason: r.reason,
      expectedQuantity: r.expectedQuantity,
      actualQuantity: r.actualQuantity,
      difference: r.difference,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      resolution: r.resolution,
      session: r.session ? { id: r.session.id, code: r.session.code, arrival: r.session.expectedArrival } : null,
      worker: r.session?.startedBy ? (byId.get(r.session.startedBy) ?? null) : null,
    }));
  }
}
