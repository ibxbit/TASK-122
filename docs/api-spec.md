# API Specification — LeaseHub Operations Console

## Overview
All APIs are local (no network), exposed via IPC or direct function calls. Data is persisted in SQLite. The API surface is designed for modularity, testability, and strict offline operation.

## Core Entities
- Tenant
- OrgUnit
- User
- Role
- Permission
- DataScope
- Order
- Seat/Room
- OccupancySnapshot
- Review
- ReviewAsset
- ContractTemplate
- ContractInstance
- AuditEvent
- RouteDataset

## API Endpoints (IPC/Module)

### Tenant Management
- `tenant.create(data)` → Tenant
- `tenant.list()` → Tenant[]
- `tenant.update(id, data)` → Tenant
- `tenant.delete(id)`

### User & Role Management
- `user.create(data)` → User
- `user.list(filter)` → User[]
- `user.update(id, data)` → User
- `user.delete(id)`
- `role.assign(userId, roleId)`
- `role.list()` → Role[]
- `permission.list()` → Permission[]
- `datascope.set(userId, scope)`

### Order & Occupancy
- `order.create(data)` → Order
- `order.list(filter)` → Order[]
- `order.update(id, data)` → Order
- `order.cancel(id)`
- `occupancy.snapshot(date, storeId)` → OccupancySnapshot
- `occupancy.analytics(params)` → AnalyticsSummary

### Review & Moderation
- `review.create(data)` → Review
- `review.list(filter)` → Review[]
- `review.reply(reviewId, text)`
- `review.moderate(reviewId, action)`
- `review.asset.upload(reviewId, file)`
- `review.asset.delete(assetId)`

### Contract Management
- `contract.template.create(data)` → ContractTemplate
- `contract.template.list()` → ContractTemplate[]
- `contract.template.update(id, data)`
- `contract.template.publish(id)`
- `contract.instance.create(data)` → ContractInstance
- `contract.instance.sign(id, signerId, password)`
- `contract.instance.archive(id)`

### Audit & Compliance
- `audit.append(event)`
- `audit.list(filter)` → AuditEvent[]
- `audit.verify(tenantId)` → HashChainStatus
- `audit.export(filter)` → ZIP (CSV/PDF + manifest)

### Route Planning
- `route.importDataset(file)`
- `route.optimize(params)` → RoutePlan
- `route.rollback(version)`

### System & Tray
- `system.tray.minimize()`
- `system.tray.restore()`
- `system.tray.status()`
- `system.notification.send(message)`
- `system.update.import(file)`
- `system.update.rollback()`

## Notes
- All APIs enforce RBAC/ABAC and tenant isolation.
- All write operations are append-only where required (audit, contracts).
- All file operations are local; no network or cloud APIs.
- All time-based operations use local system time.
