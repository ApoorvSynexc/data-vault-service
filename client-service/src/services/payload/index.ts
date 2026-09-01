import { EMRServerlessClient, StartJobRunCommand, StartJobRunCommandOutput } from '@aws-sdk/client-emr-serverless';
import { getBackupConfigById } from '../backup-config';
import { getCrmById } from '../crm';
import { getDestinationById, getDecryptedDestinationConfig } from '../destination';
import { getBackupJobsByConfig, getBackupJobsByConfigAndStatuses } from '../backup-job';
import { getRestoreById } from '../restore';
import { AWS_ACCESS_KEY_ID, AWS_REGION, AWS_EMR_APPLICATION_ID, ENCRYPTION_KEY, AWS_EMR_EXECUTION_ROLE_ARN, AWS_SECRET_ACCESS_KEY, BACKUP_STATUS, COMPRESSION_STATUS, JOB_STATUS, NODE_ENV, AWS_EMR_S3_FILE_PATH, NODE_ENV_URL } from '../../constant';
import { logger } from '../../middlewares';
import { IAwsCredentials, IBackupConfig, IBackupJob, IObject, IObjectRelationshipNode, IRestoreScope, IRestoreSource } from '../../models';
import { flattenBackupObjects } from '../../utils/helper';
import { encrypt } from '../../utils/encryption';
import { getRestoreJobById } from '../restore-job';


const awsCredentials: IAwsCredentials = {
  region: AWS_REGION
}

if (NODE_ENV === 'dev' && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
  awsCredentials.credentials = {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  }
}

// EMR runs in the same AWS account and region as the rest of the service.
const client = new EMRServerlessClient(awsCredentials);

// ─── Process object operations from backup jobs ────────────────────────────────
function processArchivalObjectOperations(jobs: IBackupJob[]): Record<string, string[]> {
    const objectOperations: Record<string, string[]> = {};

    for (const job of jobs) {
        const jobObjects = flattenBackupObjects(job.object ?? []) ?? [];

        if (job.jobType === "BULK") {
            for (const obj of jobObjects) {
                if (!objectOperations[obj.name]) {
                    objectOperations[obj.name] = [];
                }

                const operations = objectOperations[obj.name];
                const allOpsFound = ['inserts'].every((op) =>
                    operations.includes(op)
                );
                if (allOpsFound) {
                    continue;
                }

                if (obj.completedRecordCount && obj.completedRecordCount > 0 && !operations.includes('inserts')) {
                    operations.push('inserts');
                }
            }
        }
    }

    return objectOperations;
}

// ─── Process object operations from backup jobs ────────────────────────────────
function processObjectOperations(jobs: IBackupJob[]): Record<string, string[]> {
    const objectOperations: Record<string, string[]> = {};

    for (const job of jobs) {
        const jobObjects = job.object ?? [];

        if (job.jobType === "BULK") {
            for (const obj of jobObjects) {
                if (!objectOperations[obj.name]) {
                    objectOperations[obj.name] = [];
                }

                const operations = objectOperations[obj.name];
                const allOpsFound = ['inserts', 'updates', 'deletes', 'undeletes'].every((op) =>
                    operations.includes(op)
                );
                if (allOpsFound) {
                    continue;
                }

                if (obj.insertCount && obj.insertCount > 0 && !operations.includes('inserts')) {
                    operations.push('inserts');
                }
                if (obj.updateCount && obj.updateCount > 0 && !operations.includes('updates')) {
                    operations.push('updates');
                }
                if (obj.deleteCount && obj.deleteCount > 0 && !operations.includes('deletes')) {
                    operations.push('deletes');
                }
            }
        } else if (job.jobType === "REALTIME" && job.objectApiName) {
            if (!objectOperations[job.objectApiName]) {
                objectOperations[job.objectApiName] = [];
            }

            const operations = objectOperations[job.objectApiName];
            const allOpsFound = ['inserts', 'updates', 'deletes', 'undeletes'].every((op) =>
                operations.includes(op)
            );
            if (allOpsFound) {
                continue;
            }

            if (job.operation === 'INSERT' && !operations.includes('inserts')) {
                operations.push('inserts');
            }
            if (job.operation === 'UPDATE' && !operations.includes('updates')) {
                operations.push('updates');
            }
            if (job.operation === 'DELETE' && !operations.includes('deletes')) {
                operations.push('deletes');
            }
            if (job.operation === 'UNDELETE' && !operations.includes('undeletes')) {
                operations.push('undeletes');
            }
        }
    }

    return objectOperations;
}

// Schema chnage detection
function archivalSchemaChangeDetection(backupConfig: IBackupConfig, objectOperations: Record<string, string[]>): Record<string, string[]> {
    const objects = flattenBackupObjects((backupConfig.objects as any) ?? []) ?? [];
    const objectOperationsKeys = Object.keys(objectOperations);

    for (const obj of objects) {
        if (obj.schemaChange && objectOperationsKeys.includes(obj.name) && !objectOperations[obj.name].includes("schema-change")) {
            console.log("Schema chnage detect: ", { name: obj.name });
            objectOperations[obj.name].push("schema-change");
        }
    }

    return objectOperations;
}

// Schema chnage detection
function schemaChangeDetection(backupConfig: IBackupConfig, objectOperations: Record<string, string[]>): Record<string, string[]> {
    const objects = backupConfig.objects ?? [];
    const objectOperationsKeys = Object.keys(objectOperations);

    for (const obj of objects) {
        if (obj.schemaChange && objectOperationsKeys.includes(obj.name) && !objectOperations[obj.name].includes("schema-change")) {
            console.log("Schema chnage detect: ", { name: obj.name });
            objectOperations[obj.name].push("schema-change");
        }
    }

    return objectOperations;
}

// ─── Fetch all backup jobs with pagination ────────────────────────────────────
async function fetchAllBackupJobs(backupConfigId: string) {
    const allJobs = [];
    let cursor: string | undefined;

    do {
        const result = await getBackupJobsByConfig(backupConfigId, { limit: 100, cursor });
        allJobs.push(...result.items);
        cursor = result.nextCursor;
    } while (cursor);

    return allJobs;
}

// Backups that finished (fully or partially) and aren't already mid-compression or
// done. Includes SUCCESS, PARTIAL_FAILURE (some objects failed, the rest still ships),
// and COMPRESSION_JOB_FAILED (retry — Spark gets another attempt). Excludes COMPRESSED
// (done), COMPRESSION_JOB_IN_PROGRESS (Spark already has it), and PENDING/RUNNING/FAILED
// backups.
// ponytail: COMPRESSION_JOB_FAILED retries every time this runs, with no backoff or
// retry cap — a job that deterministically fails compression will loop forever. Add a
// retry count/cap if that shows up in practice.
//
// Single source of truth for both the DB-level filter (getBackupJobsByConfigAndStatuses,
// via fetchCompressibleBackupJobs) and the in-memory predicate (isCompressible, kept for
// payload.check.ts and any caller that already has a job in hand).
const COMPRESSIBLE_STATUSES: string[] = [
    JOB_STATUS.success,
    BACKUP_STATUS.partialFailure,
    COMPRESSION_STATUS.failed,
];
const isCompressible = (job: IBackupJob): boolean => COMPRESSIBLE_STATUSES.includes(job.status);

// ─── Fetch only compression-eligible backup jobs, filtered at the query layer ──
// Payload-only counterpart to fetchAllBackupJobs above: buildPayload is the sole
// caller, so filtering happens here rather than on fetchAllBackupJobs itself, which
// initalizePayloadTransform also uses (unfiltered) just to confirm the config has run
// at all.
async function fetchCompressibleBackupJobs(backupConfigId: string) {
    const allJobs = [];
    let cursor: string | undefined;

    do {
        const result = await getBackupJobsByConfigAndStatuses(backupConfigId, COMPRESSIBLE_STATUSES, { limit: 100, cursor });
        allJobs.push(...result.items);
        cursor = result.nextCursor;
    } while (cursor);

    return allJobs;
}

// Same id/name shape as an IObjectRelationshipNode, minus its own children —
// used as the entry recorded per parent below. fieldName is the join field on
// the child that points at this specific parent (a child can use a different
// field per parent, e.g. Task.WhoId under Contact vs Task.WhatId elsewhere),
// so it's optional here since it's absent for the root parent ref.
interface IObjectRelationshipRef {
    id: string;
    name: string;
    fieldName?: string;
}

// Mirrors parentToChild's own node shape (id, name, children: []), just with
// `parent` in place of `children` — one entry per object appearing anywhere
// in a selected root's relationship tree, listing every distinct parent it
// was found under (an object can have more than one, e.g. Task appears
// under both Account and Contact).
interface IObjectParents {
    id: string;
    name: string;
    parent: IObjectRelationshipRef[];
}

// Walks one root's relationship tree recording each node's direct parent
// into parentsByChildId (keyed by child id, since names alone can collide
// with an unrelated object that reuses the same id-bearing entry elsewhere
// in the tree). The nesting only encodes the parent -> child direction, so
// this walk is the only way to get the reverse. visitedIds guards against a
// malformed/cyclic stored tree recursing forever.
function collectChildParents(
    nodes: IObjectRelationshipNode[] | undefined,
    parent: IObjectRelationshipRef,
    visitedIds: Set<string>,
    parentsByChildId: Map<string, { name: string; parents: Map<string, { name: string; fieldName?: string }> }>
): void {
    for (const node of nodes ?? []) {
        if (visitedIds.has(node.id)) continue;

        if (!parentsByChildId.has(node.id)) {
            parentsByChildId.set(node.id, { name: node.name, parents: new Map() });
        }
        parentsByChildId.get(node.id)!.parents.set(parent.id, { name: parent.name, fieldName: node.fieldName });

        collectChildParents(node.children, { id: node.id, name: node.name }, new Set(visitedIds).add(node.id), parentsByChildId);
    }
}

function buildChildToParent(selectedRoots: IObject[]): IObjectParents[] {
    const parentsByChildId = new Map<string, { name: string; parents: Map<string, { name: string; fieldName?: string }> }>();

    for (const root of selectedRoots) {
        collectChildParents(root.children, { id: root.id, name: root.name }, new Set([root.id]), parentsByChildId);
    }

    return Array.from(parentsByChildId.entries()).map(([id, { name, parents }]) => ({
        id,
        name,
        parent: Array.from(parents.entries()).map(([parentId, { name: parentName, fieldName }]) => ({ id: parentId, name: parentName, fieldName })),
    }));
}

// parentToChild is exactly the stored tree (IObjectRelationshipNode[]) off
// the user-selected root object(s) (isUserSelected: true) — no rebuilding.
function buildRelationshipTrees(backupConfig: IBackupConfig): {
    parentToChild: IObjectRelationshipNode[];
    childToParent: IObjectParents[];
} {
    const selectedRoots = (backupConfig.objects ?? []).filter((object) => object.isUserSelected);

    return {
        parentToChild: selectedRoots.flatMap((root) => root.children ?? []),
        childToParent: buildChildToParent(selectedRoots),
    };
}

// ─── Build EMR payload from a backupConfigId ──────────────────────────────────
// Pure builder: resolves config/crm/destination/jobs and shapes the payload Spark
// reads. objectOperations is keyed by backupJobId so Spark can compress each job's
// output independently; a job with no operations maps to {}.
//
// The job set is resolved here, not by the caller: fetchCompressibleBackupJobs pulls
// only jobs whose status is SUCCESS, PARTIAL_FAILURE, or COMPRESSION_JOB_FAILED —
// excludes FAILED backups and the remaining compression states, which overwrite `status`.
//
// Shape matches Spark's parser exactly (JsonUtils.java): everything but jobType and
// backupConfigId nests under `details`, creds under details.destinationConfigs.
// Destination creds are returned decrypted — this payload only ever leaves the
// process through /build-payload, whose body Spark reads as Base64(JSON) over TLS.
// Do not hand this to submitEMR — its trigger payload is intentionally id-only.
async function buildPayload(backupConfigId: string) {
    logger.info(`Building EMR payload for backupConfigId: ${backupConfigId}`);

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (!backupConfig) {
        throw new Error('backup_config_not_found');
    }

    const crm = await getCrmById(backupConfig.crmId);
    if (!crm) {
        throw new Error('crm_not_found');
    }

    const destination = await getDestinationById(backupConfig.destinationId);
    if (!destination) {
        throw new Error('destination_not_found');
    }

    const jobs = await fetchCompressibleBackupJobs(backupConfigId);
    if (!jobs.length) {
        throw new Error('No backup jobs found');
    }

    // processObjectOperations already takes a job array, so a single-job array gives that
    // job's operations with no change to the merge logic itself.
    const objectOperations: Record<string, Record<string, string[]>> = {};
    for (const job of jobs) {
        const jobOperations = backupConfig.type === 'NORMAL' ?
            processObjectOperations([job]) :
            processArchivalObjectOperations([job]);
        objectOperations[job.backupJobId] = backupConfig.type === 'NORMAL' ?
            schemaChangeDetection(backupConfig, jobOperations) :
            archivalSchemaChangeDetection(backupConfig, jobOperations);
    }

    logger.info(`Built EMR payload for backupConfigId: ${backupConfigId} jobs=${jobs.length}`);

    const payload = {
        jobType: backupConfig.type === 'NORMAL' ? 'BACKUP' : 'ARCHIVAL',
        backupConfigId: backupConfigId,
        details: {
            clientId: backupConfig.userId,
            backupType: backupConfig.schedule,
            sourceDetails: {
                sourceName: crm.crmName,
                orgId: crm.crmId,
            },
            objectOperations,
            destinationConfigs: {
                destinationName: destination.provider,
                destinationRequiredCreds: getDecryptedDestinationConfig(destination),
            },
        },
    };
    console.log("PAYLOAD ==> " + JSON.stringify(payload));
    return payload;
}

// ─── Conditionally map restore source fields by type ──────────────────────────
// A stored IRestoreSource can carry fields irrelevant to its type (e.g. a client
// posted backupJobIds alongside ENTIRE) — only forward what the type uses.
// No type on legacy records: forward as stored, unchanged.
function mapRestoreSource(source: IRestoreSource) {
    const { backupConfigId, configType, type, backupJobIds, startDate, endDate } = source;
    switch (type) {
        case 'ENTIRE':
            return { backupConfigId, configType, type };
        case 'PARTIAL':
            return { backupConfigId, configType, type, backupJobIds };
        case 'CHANGED_BETWEEN':
            return { backupConfigId, configType, type, startDate, endDate };
        case 'DELETED_BETWEEN':
            return { backupConfigId, configType, type, startDate, endDate };
        default:
            return source;
    }
}

// ─── Conditionally map restore scope fields by type ────────────────────────────
// Same rule as mapRestoreSource: only the selection field the scope type reads.
// Unrecognised type (legacy, e.g. INSERTS_ONLY): forward as stored.
function mapRestoreScope(restoreScope: IRestoreScope) {
    const { type, objects, records, fields, filters, changeSince, bulkCsvIds, deletedOnly, objectTree } = restoreScope;
    switch (type) {
        case 'ALL':
            return { type };
        case 'OBJECT':
            return { type, objects };
        case 'RECORD':
            return { type, records };
        case 'FIELD':
            return { type, fields };
        case 'FILTER':
            return { type, filters };
        case 'CHANGE_SINCE':
            return { type, changeSince };
        case 'BULK_CSV':
            return { type, bulkCsvIds };
        case 'DELETED_ONLY':
            return { type, deletedOnly: deletedOnly ?? true };
        // ARCHIVAL restore — the whole hierarchy (root filters/recordIds +
        // recursive children) passes through as-is. Note: interpreting this
        // tree during actual CSV generation is Spark-side (RestoreService.java)
        // work not yet wired up — this only ensures the shape reaches the
        // payload unchanged rather than being dropped by the default case.
        case 'OBJECT_TREE':
            return { type, objectTree };
        default:
            return restoreScope;
    }
}

// ─── Build EMR RESTORE payload from a restoreConfigId ─────────────────────────
// Restore mirrors buildPayload's resolve-then-shape contract, but reads a restore
// config instead of backup jobs. The stored restore already carries source,
// selection and conflict in the exact shape Spark expects, so those three pass
// through untouched; only these are resolved:
//   - sourceDetails: the CRM the backup came from.
//   - destinationConfigs: the S3 creds Spark reads the backup files with (the
//     source config's destination bucket). Shape matches Java DestinationConfigs:
//     `destinationName` drives resolveBaseUri(), bucketName lives inside the creds.
//
// restore.destination (SAME/DIFFERENT target org) is deliberately NOT sent — Spark
// writes restore.csv and never pushes to an org, so the target is a Node concern.
//
// Same credential rule as buildPayload: decrypted creds only ever leave through
// /build-payload, which encrypts the whole response. Never hand this to submitEMR.
async function buildRestorePayload(restoreConfigId: string) {
    logger.info(`Building EMR RESTORE payload for restoreConfigId: ${restoreConfigId}`);

    const restoreJob = await getRestoreJobById(restoreConfigId);
    if (!restoreJob) {
        throw new Error('restore_job_not_found');
    }

    const restore = await getRestoreById(restoreJob.restoreId);
    if (!restore) {
        throw new Error('restore_config_not_found');
    }

    const backupConfigId = restore.source?.backupConfigId;
    if (!backupConfigId) {
        throw new Error('restore_config_has_no_backup_config');
    }

    const backupConfig = await getBackupConfigById(backupConfigId);
    if (!backupConfig) {
        throw new Error('backup_config_not_found');
    }

    const crm = await getCrmById(backupConfig.crmId);
    if (!crm) {
        throw new Error('crm_not_found');
    }

    const destination = await getDestinationById(backupConfig.destinationId);
    if (!destination) {
        throw new Error('destination_not_found');
    }

    const { parentToChild, childToParent } = buildRelationshipTrees(backupConfig);

    logger.info(`Built EMR RESTORE payload for restoreConfigId: ${restoreConfigId} jobs=${restore.source.backupJobIds?.length ?? 0}`);

    return {
        jobType: 'RESTORE',
        restoreConfigId,
        configType: restore.source.configType,
        details: {
            clientId: restore.userId,
            restoreConfigName: restore.jobDetail?.name,
            backupType: backupConfig.schedule,
            sourceDetails: {
                sourceName: crm.crmName,
                orgId: crm.crmId,
            },
            'restore-configs': {
                source: mapRestoreSource(restore.source),
                selection: { restoreScope: mapRestoreScope(restore.selection.restoreScope) },
                // Already optional-in/optional-out as stored — undefined keys drop on JSON.stringify.
                conflict: restore.conflict,
            },
            hierarchy: {
                parentToChild,
                childToParent
            },
            destinationConfigs: {
                destinationName: destination.provider,
                destinationRequiredCreds: getDecryptedDestinationConfig(destination),
            },
        },
    };
}

type EmrPayload = Awaited<ReturnType<typeof buildPayload>>;

// What EMR receives as entryPointArguments. Deliberately carries no credentials —
// Spark calls /build-payload with this id for the rest, and that response is
// encrypted. Job resolution happens server-side in buildPayload (isCompressible),
// so the trigger is id-only for both backup and restore runs.
type EmrTriggerPayload =
    | { backupConfigId: string }
    | { restoreConfigId: string };

// ─── Submit a built payload to EMR Serverless ─────────────────────────────────
async function submitEMR(payload: EmrTriggerPayload): Promise<StartJobRunCommandOutput> {
    try {
        // Encrypted with ENCRYPTION_KEY (the same key Spark gets as ENCRYPTION_KEY),
        // framed the same way decryptFromTransport expects to unpack it: base64(JSON({ ciphertext, iv })).
        const payloadB64 = Buffer.from(
            JSON.stringify(encrypt(JSON.stringify(payload), ENCRYPTION_KEY))
        ).toString('base64');

        logger.info('Initializing EMR job...');
        console.log('──────────────────────────────────────────');
        console.log('  DataVault — EMR Serverless Job Submitter');
        console.log('──────────────────────────────────────────');
        console.log('executionRoleArn:', AWS_EMR_EXECUTION_ROLE_ARN);
        if ('restoreConfigId' in payload) {
            console.log('Restore Config ID:', payload.restoreConfigId);
        } else {
            console.log('Backup Config ID:', payload.backupConfigId);
        }
        console.log('──────────────────────────────────────────');

        // Spark submit parameters — tuned for 100 GB / 200 objects in 5 minutes.
        // Kept as an array + .join(' ') so each setting is reviewable in isolation;
        // EMR receives the joined single-line string at submit time.
        const sparkSubmitParameters = [
            '--class com.example.Main',
            '--conf spark.driver.userClassPathFirst=true',
            '--conf spark.executor.userClassPathFirst=true',

            // Driver
            '--conf spark.driver.cores=2',
            '--conf spark.driver.memory=8g',
            '--conf spark.driver.memoryOverhead=2g',
            '--conf spark.driver.maxResultSize=2g',
            '--conf spark.emr-serverless.driver.disk=20g',

            // Executors
            '--conf spark.executor.cores=4',
            '--conf spark.executor.memory=16g',
            '--conf spark.executor.memoryOverhead=3g',
            '--conf spark.emr-serverless.executor.disk=20g',

            // Dynamic Allocation
            // executor.instances must be set explicitly — EMR Serverless defaults it to 3,
            // which fails validation once it exceeds maxExecutors.
            // Starts at 1 executor and scales up to 6 only if the workload actually needs
            // it — most runs (a handful of cascade/delta records) never will. Previously
            // min=initial=executor.instances=6 held allocation static at the cap for no
            // ramp-up delay on large bulk loads, but that meant EVERY run — regardless of
            // size — requested the full 26vCPU (driver 2 + 6x4 executor) peak immediately,
            // which trips the account's EMR Serverless concurrent-vCPU service quota even
            // when nothing else is running. maxExecutors stays 6 so a genuinely large bulk
            // load (e.g. a first-run 1M+ record insert) can still scale up to it; it just
            // no longer starts there. NOTE: initial executor count is
            // min(maxExecutors, max(initialExecutors, minExecutors, executor.instances)) —
            // all three of the "floor" settings below must move together, or leaving any
            // one at 6 pins the floor back to 6 regardless of the other two.
            '--conf spark.executor.instances=1',
            '--conf spark.dynamicAllocation.enabled=true',
            '--conf spark.dynamicAllocation.minExecutors=1',
            '--conf spark.dynamicAllocation.initialExecutors=1',
            '--conf spark.dynamicAllocation.maxExecutors=6',
            '--conf spark.dynamicAllocation.executorIdleTimeout=60s',
            '--conf spark.dynamicAllocation.schedulerBacklogTimeout=1s',
            '--conf spark.dynamicAllocation.sustainedSchedulerBacklogTimeout=1s',
            '--conf spark.dynamicAllocation.shuffleTracking.enabled=true',

            // Memory
            '--conf spark.memory.fraction=0.7',
            '--conf spark.memory.storageFraction=0.3',

            // Serialization
            '--conf spark.serializer=org.apache.spark.serializer.KryoSerializer',
            '--conf spark.kryo.registrator=org.apache.spark.HoodieSparkKryoRegistrar',
            '--conf spark.kryoserializer.buffer.max=512m',

            // S3A
            '--conf spark.hadoop.fs.s3a.impl=org.apache.hadoop.fs.s3a.S3AFileSystem',
            '--conf spark.hadoop.fs.s3a.connection.maximum=200',
            '--conf spark.hadoop.fs.s3a.threads.max=64',
            '--conf spark.hadoop.fs.s3a.threads.keepalivetime=60',
            '--conf spark.hadoop.fs.s3a.connection.timeout=60000',
            '--conf spark.hadoop.fs.s3a.connection.establish.timeout=15000',
            '--conf spark.hadoop.fs.s3a.attempts.maximum=5',
            '--conf spark.hadoop.fs.s3a.retry.limit=5',
            '--conf spark.hadoop.fs.s3a.retry.throttle.limit=20',
            '--conf spark.hadoop.fs.s3a.paging.maximum=1000',

            '--conf spark.hadoop.fs.s3a.multipart.size=67108864',
            '--conf spark.hadoop.fs.s3a.block.size=67108864',
            '--conf spark.hadoop.fs.s3a.multipart.threshold=134217728',

            '--conf spark.hadoop.fs.s3a.fast.upload=true',
            '--conf spark.hadoop.fs.s3a.fast.upload.buffer=disk',
            '--conf spark.hadoop.fs.s3a.fast.upload.active.blocks=4',

            '--conf spark.hadoop.fs.s3a.readahead.range=4194304',

            // Network
            '--conf spark.network.timeout=600s',
            '--conf spark.executor.heartbeatInterval=60s',

            // Scheduler
            '--conf spark.scheduler.mode=FAIR',
            '--conf spark.task.cpus=1',
            '--conf spark.locality.wait=0s',
            '--conf spark.speculation=false',
        ].join(' ');

        console.log('NODE ENV:', NODE_ENV_URL);
        const command = new StartJobRunCommand({
            applicationId: AWS_EMR_APPLICATION_ID,
            executionRoleArn: AWS_EMR_EXECUTION_ROLE_ARN,
            jobDriver: {
                sparkSubmit: {
                    entryPoint: AWS_EMR_S3_FILE_PATH,
                    entryPointArguments: [payloadB64],
                    sparkSubmitParameters,
                },
            },
            configurationOverrides: {
                applicationConfiguration: [
                    {
                        classification: "spark-defaults",
                        properties: {
                            "spark.executorEnv.ENCRYPTION_KEY": ENCRYPTION_KEY,
                            "spark.emr-serverless.driverEnv.ENCRYPTION_KEY": ENCRYPTION_KEY,
                            "spark.driver.extraJavaOptions": `-DENCRYPTION_KEY=${ENCRYPTION_KEY} -DNODE_SERVER_URL=${NODE_ENV_URL}`,
                            "spark.executor.extraJavaOptions": `-DENCRYPTION_KEY=${ENCRYPTION_KEY} -DNODE_SERVER_URL=${NODE_ENV_URL}`,
                            "spark.executorEnv.NODE_SERVER_URL": NODE_ENV_URL,
                            "spark.emr-serverless.driverEnv.NODE_SERVER_URL": NODE_ENV_URL,
                        },
                    },
                ],
                monitoringConfiguration: {
                    managedPersistenceMonitoringConfiguration: {
                        enabled: true
                    },
                    s3MonitoringConfiguration: {
                        logUri: "s3://qa-data-vault-logs"
                    }
                },
            },
        });

        console.log('COMMAND ==> ' + JSON.stringify(command));
        const response = await client.send(command);
        console.log('RESPONSE ==> ' + JSON.stringify(response));
        logger.info('EMR job initialized.');
        return response;
    } catch (error) {
        logger.error('Error initializing EMR job:', error);
        throw error;
    }
}

// ─── Trigger a compression run (used by /payload and the config trigger) ──────
// Sends only the config id. Spark calls /build-payload with it to get the full
// payload; the eligible job set is resolved there. The fetch here is only a guard
// against spinning up EMR for a config with no jobs at all.
async function initalizePayloadTransform(
    backupConfigId: string,
    opts: { skipRealtimeSync?: boolean } = {}
): Promise<StartJobRunCommandOutput | void> {
    const backupJobs = await fetchAllBackupJobs(backupConfigId);
    if (!backupJobs.length) {
        throw new Error('No backup jobs found');
    }

    logger.info(`Triggering EMR for backupConfigId: ${backupConfigId}`);
    return submitEMR({ backupConfigId });
}

// ─── Trigger a restore run ────────────────────────────────────────────────────
// Sends only the restore config id. Spark calls /build-payload with it to get the
// full RESTORE payload (buildRestorePayload).
async function initalizeRestoreTransform(restoreConfigId: string): Promise<StartJobRunCommandOutput> {
    logger.info(`Triggering EMR RESTORE for restoreConfigId: ${restoreConfigId}`);
    return submitEMR({ restoreConfigId });
}

export {
    buildPayload,
    buildRestorePayload,
    submitEMR,
    initalizePayloadTransform,
    initalizeRestoreTransform,
    isCompressible,
    // exported for payload.check.ts — the per-job grouping contract with Spark
    processObjectOperations,
    processArchivalObjectOperations,
    mapRestoreSource,
    mapRestoreScope,
    EmrPayload,
    EmrTriggerPayload,
};
