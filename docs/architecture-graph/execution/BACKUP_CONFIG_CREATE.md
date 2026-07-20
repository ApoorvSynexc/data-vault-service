# Execution Flow: Backup Config Creation

Step-by-step trace for creating a backup configuration.

## POST /v1/backup-config

### Middleware chain
```
authenticate → aclGateway → backupConfigValidation joi → createBackupConfigHandler
```

### Step 1: Validation

```typescript
// joi validation (backup-config joi middleware):
// - objectNames: string[] required
// - schedule: REALTIME | SCHEDULE required
// - type: NORMAL | ARCHIVAL required
// - destinationId: required
// - scheduleConfig: conditional (required if schedule=SCHEDULE)
// - objects: optional (IObject[] with children)
```

### Step 2: Ownership checks

```typescript
const destination = await getDestinationById(body.destinationId);
if (!isOwner(destination, user.userId)) return 403 forbidden;

const crm = await getCrmById(user.crmId);
if (!crm) return 400 crm_not_found;
```

### Step 3: Slug generation

```typescript
const slugCount = await incrementTableCounter(BACKUP_CONFIG_TABLE, `slug:${toSlug(name)}`);
const slug = buildSlug(name, slugCount);
// atomic counter ensures unique suffixes under concurrent creation
```

### Step 4: Create config record

```typescript
const config = await createBackupConfig({
  backupConfigId: uuid(),
  userId: user.userId,
  crmId: user.crmId,
  destinationId,
  slug,
  name, description,
  type,                    // NORMAL | ARCHIVAL
  schedule,                // REALTIME | SCHEDULE
  scheduleConfig,          // if SCHEDULE
  objectNames,
  objects,                 // IObject[] with children
  status: STATUS.active,
  backupStatus: BACKUP_STATUS.pending,
  createdAt, updatedAt,
});
```

### Step 5: Immediate trigger (if ONE_TIME, no start date/time)

```typescript
const { immediateObjects, scheduledObjects } = filtereObjects(objects);
// immediateObjects: scheduleConfig.type=ONE_TIME, frequency=ONCE, no startDate, no startTime

if (immediateObjects.length > 0) {
  // Trigger job immediately for immediateObjects
  await httpRequest({
    url: `${BACKUP_SERVICE}/api/v1/backup-job`,
    method: 'POST',
    body: JSON.stringify({ backupConfigId, userId, objects: immediateObjects, ... }),
  });
}
// scheduledObjects will be triggered by cron when their time comes
```

### Step 6: REALTIME — create Apex triggers

```typescript
if (schedule === SCHEDULE_MODE.realtime) {
  // createApexSecret: POST Apex REST to store backupConfigId as webhook secret in org
  // createTriggers(instanceUrl, tokens, objectNames):
  //   - ensureHandlerClass (checks SYX_DVV package installed)
  //   - For each objectName:
  //       fetch existing trigger by name
  //       if exists and Active → status = EXIST
  //       if not exists → Metadata API deploy of triggers/*.trigger + *.trigger-meta.xml
  //                       (changed 2026-07-17: Tooling API POST /sobjects/ApexTrigger is
  //                        rejected with ENTITY_IS_LOCKED in active production orgs)
  //                       testLevel=RunLocalTests → runs the org's local tests, slow
  //                       poll /metadata/deployRequest/{id} every 2s until done (no timeout)
  //                       status = CREATED
  //   - setupPermissionSet:
  //       upsertPermissionSet (create DataVaultRealTimeTriggerAccess if not exists)
  //       grantApexClassAccess (handler class)
  //       grantExternalCredentialPrincipalAccess (Metadata API deploy)
  //       grantApexClassAccess (each created trigger's class)
  
  const triggerResults = await realTimeTriggerManagement('create', config);
  // Stored on config: triggerResults[]
  await updateBackupConfig(backupConfigId, { triggerResults });
}
```

### Response

```typescript
return 201 { backupConfig }
```

## Pause / Resume / Delete lifecycle

### POST /v1/backup-config/:id/pause

```typescript
// If REALTIME: realTimeTriggerManagement('inactivate', config)
//   → patchTriggerStatus each trigger to 'Inactive' via Tooling API
await updateBackupConfig(id, { status: 'PAUSED' });
```

### POST /v1/backup-config/:id/resume

```typescript
// If REALTIME: realTimeTriggerManagement('activate', config)
//   → create missing triggers, set Inactive → Active
await updateBackupConfig(id, { status: 'RESUMED' });
// 'RESUMED' makes it visible to getScheduledIncrementalBackupConfigs()
```

### DELETE /v1/backup-config/:id

```typescript
// If REALTIME: realTimeTriggerManagement('delete', config)
//   → deleteTriggers: DELETE Tooling API /sobjects/ApexTrigger/{id} for each trigger
//   → deletePermissionSet: Metadata API destructive deploy
await updateBackupConfig(id, { status: STATUS.deleted });
```
